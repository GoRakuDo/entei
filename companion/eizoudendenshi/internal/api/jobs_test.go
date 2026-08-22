package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"eizoudendenshi/internal/job"
	"eizoudendenshi/internal/torrent"
)

// fakeHelper is the test-only yt-dlp stand-in, built once from
// internal/job/testdata/fakehelper (same helper the job tests use).
var fakeHelper string

func TestMain(m *testing.M) {
	_, thisFile, _, _ := runtime.Caller(0)
	pkgDir := filepath.Dir(thisFile)
	dir, err := os.MkdirTemp("", "entei-api-fake-helper-*")
	if err != nil {
		fmt.Fprintf(os.Stderr, "temp dir: %v\n", err)
		os.Exit(1)
	}
	exe := "fakehelper"
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	fakeHelper = filepath.Join(dir, exe)
	build := exec.Command("go", "build", "-o", fakeHelper, filepath.Join(pkgDir, "..", "job", "testdata", "fakehelper"))
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build fake helper: %v\n%s", err, out)
		os.RemoveAll(dir)
		os.Exit(1)
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// newJobsServer builds a server with a job manager over the fake helper.
func newJobsServer(t *testing.T) (*Server, *job.Manager) {
	t.Helper()
	m, err := job.New(job.Config{HelperPath: fakeHelper, Timeout: 20 * time.Second})
	if err != nil {
		t.Fatalf("job.New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	s, err := New(Config{Jobs: m})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s, m
}

// doJob issues a request with the Origin header and the capability token on
// the query string (matching how a browser would call the job API).
func doJob(t *testing.T, s *Server, method, path, origin, body string) *httptest.ResponseRecorder {
	t.Helper()
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	req := httptest.NewRequest(method, path+sep+"token="+s.token, strings.NewReader(body))
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func waitForState(t *testing.T, m *job.Manager, id string, want job.State, timeout time.Duration) job.Snapshot {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		snap := m.Get(id)
		if snap != nil && snap.State == want {
			return *snap
		}
		if snap != nil && (snap.State == job.StateError || snap.State == job.StateCancelled) {
			t.Fatalf("job reached %s, want %s (%v)", snap.State, want, snap.Error)
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s; last=%+v", want, snap)
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func TestJobEndpointsDisabledWithoutManager(t *testing.T) {
	s := newTestServer(t)
	for _, path := range []string{
		"/v1/source/jobs",
		"/v1/source/jobs/123",
		"/v1/source/jobs/123/cancel",
	} {
		rec := doRequest(t, s.Handler(), http.MethodPost, path, allowedOriginLocal, "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s without jobs manager = %d, want 404", path, rec.Code)
		}
	}
}

func TestJobCreateGates(t *testing.T) {
	s, _ := newJobsServer(t)
	body := `{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`

	// Missing origin → 403 without CORS headers.
	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", "", body)
	if rec.Code != http.StatusForbidden || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("no origin = %d (acoa %q), want 403 without CORS", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}
	// Disallowed origin → 403.
	rec = doJob(t, s, http.MethodPost, "/v1/source/jobs", disallowedOrigin, body)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("disallowed origin = %d, want 403", rec.Code)
	}
	// Missing token → 401.
	req := httptest.NewRequest(http.MethodPost, "/v1/source/jobs", strings.NewReader(body))
	req.Header.Set("Origin", allowedOriginLocal)
	req.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec2, req)
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("no token = %d, want 401", rec2.Code)
	}
	// Invalid token → 401.
	req = httptest.NewRequest(http.MethodPost, "/v1/source/jobs?token=deadbeef", strings.NewReader(body))
	req.Header.Set("Origin", allowedOriginLocal)
	req.Header.Set("Content-Type", "application/json")
	rec3 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec3, req)
	if rec3.Code != http.StatusUnauthorized {
		t.Fatalf("invalid token = %d, want 401", rec3.Code)
	}
}

func TestJobCreateReadCancelFlow(t *testing.T) {
	s, _ := newJobsServer(t)
	t.Setenv("EIZOU_FAKE_SIZE", "0")
	t.Setenv("EIZOU_FAKE_HOLD", "1")

	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201 (%s)", rec.Code, rec.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create body: %v", err)
	}
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatal("create body must carry an opaque id")
	}
	// The URL must never appear in the response.
	if strings.Contains(rec.Body.String(), "youtube.com") || strings.Contains(rec.Body.String(), "abcdefghijk") {
		t.Fatal("create response leaks the URL")
	}
	if _, ok := created["url"]; ok {
		t.Fatal("create response must not have a url field")
	}

	// Read.
	rec = doJob(t, s, http.MethodGet, "/v1/source/jobs/"+id, allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("read = %d, want 200", rec.Code)
	}
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["id"] != id {
		t.Fatalf("read id = %v, want %s", got["id"], id)
	}
	if strings.Contains(rec.Body.String(), "youtube.com") {
		t.Fatal("read response leaks the URL")
	}

	// Cancel.
	rec = doJob(t, s, http.MethodPost, "/v1/source/jobs/"+id+"/cancel", allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel = %d, want 200", rec.Code)
	}
	// Read after cancel → 404 (cancelled jobs no longer exist).
	rec = doJob(t, s, http.MethodGet, "/v1/source/jobs/"+id, allowedOriginLocal, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("read after cancel = %d, want 404", rec.Code)
	}
}

// TestSpeedNotPlayableBelowThreshold pins the playable gate: a
// downloading Speed job whose .part is smaller than speedMinPlayableBytes
// reports "buffering" (NOT "playable"), so the bridge keeps the media URL
// hidden. Exposing at the first byte caused a 503 → error-code-4 →
// re-expose loop and audio-only starts (2026-08-09). If the gate is ever
// relaxed back to `> 0` this test fails.
func TestSpeedNotPlayableBelowThreshold(t *testing.T) {
	s, _ := newJobsServer(t)
	// 1 MiB < speedMinPlayableBytes: the .part exists but is too small to
	// start playback.
	t.Setenv("EIZOU_FAKE_SIZE", "1048576")
	t.Setenv("EIZOU_FAKE_CHUNK", "262144")
	t.Setenv("EIZOU_FAKE_CHUNK_DELAY_MS", "5")
	t.Setenv("EIZOU_FAKE_HOLD", "1")

	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk","mode":"speed"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201 (%s)", rec.Code, rec.Body.String())
	}

	// Let the fake helper write its 1 MiB, then confirm the status stays
	// buffering while the job downloads (never playable below the gate).
	deadline := time.Now().Add(5 * time.Second)
	sawBytes := false
	for {
		status := getStatus(t, s)
		if status.State == statusPlayable {
			t.Fatalf("speed status = playable with %d bytes (< %d gate); want buffering",
				status.Available, speedMinPlayableBytes)
		}
		if status.Available > 0 {
			sawBytes = true
		}
		if status.Available >= 1048576 {
			break // helper finished writing; still buffering
		}
		if time.Now().After(deadline) {
			t.Fatalf("timeout; last status=%+v", status)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !sawBytes {
		t.Fatal("fake helper never produced bytes")
	}
}

// TestSpeedPlayableThresholdPinned guards the constant itself: exactly
// 2 MiB (2 << 20). The gate compares Available >= this value, so both the
// below/at boundary semantics depend on it staying 2 MiB.
func TestSpeedPlayableThresholdPinned(t *testing.T) {
	if speedMinPlayableBytes != 2<<20 {
		t.Fatalf("speedMinPlayableBytes = %d, want %d (2 MiB)", speedMinPlayableBytes, 2<<20)
	}
}

// TestSpeedPlayableAtExactThreshold pins the boundary: a downloading Speed
// job whose .part has grown to EXACTLY speedMinPlayableBytes (2 MiB)
// reports "playable". Together with the below-threshold test this fixes
// the `<` vs `>=` boundary — relaxing the gate to `> speedMinPlayableBytes`
// would leave the exact 2 MiB point unexposed (this test then fails).
func TestSpeedPlayableAtExactThreshold(t *testing.T) {
	s, _ := newJobsServer(t)
	// Exactly 2 MiB — the boundary value itself (8 × 256 KiB chunks, so the
	// helper lands on the threshold exactly and then holds).
	t.Setenv("EIZOU_FAKE_SIZE", "2097152") // 2 MiB == speedMinPlayableBytes
	t.Setenv("EIZOU_FAKE_CHUNK", "262144")
	t.Setenv("EIZOU_FAKE_CHUNK_DELAY_MS", "5")
	t.Setenv("EIZOU_FAKE_HOLD", "1")

	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk","mode":"speed"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201 (%s)", rec.Code, rec.Body.String())
	}

	// The helper writes 8 × 256 KiB chunks and then holds: the moment the
	// available prefix reaches exactly 2 MiB, status must flip to playable
	// (never before).
	deadline := time.Now().Add(5 * time.Second)
	for {
		status := getStatus(t, s)
		if status.State == statusPlayable {
			if status.Available != speedMinPlayableBytes {
				t.Fatalf("playable at available=%d, want the exact threshold %d",
					status.Available, speedMinPlayableBytes)
			}
			return // boundary exposed exactly at 2 MiB
		}
		if time.Now().After(deadline) {
			t.Fatalf("timeout; last status=%+v (want playable at exactly %d)",
				status, speedMinPlayableBytes)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestJobCreateModeSpeed streams while downloading: the status reports
// "playable" once the .part has grown past speedMinPlayableBytes (2 MiB),
// and the media endpoint serves a Range (206) rather than a 503.
func TestJobCreateModeSpeedStreamsWhileDownloading(t *testing.T) {
	s, _ := newJobsServer(t)
	// Fake media must exceed the playable threshold — a "playable" at a
	// few bytes would hand the browser a URL that cannot start playback
	// (503/error-code-4 loop, audio-only start).
	t.Setenv("EIZOU_FAKE_SIZE", "3145728") // 3 MiB > speedMinPlayableBytes
	t.Setenv("EIZOU_FAKE_CHUNK", "262144")
	t.Setenv("EIZOU_FAKE_CHUNK_DELAY_MS", "5")
	t.Setenv("EIZOU_FAKE_HOLD", "1")

	// Create in speed mode.
	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk","mode":"speed"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201 (%s)", rec.Code, rec.Body.String())
	}
	var created struct {
		ID   string `json:"id"`
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.Mode != "speed" {
		t.Fatalf("mode = %q, want speed", created.Mode)
	}

	// Poll until the .part is streamable (status playable).
	deadline := time.Now().Add(5 * time.Second)
	for {
		status := doJob(t, s, http.MethodGet, "/v1/media/status", allowedOriginLocal, "")
		if status.Code == http.StatusOK {
			var b statusBody
			_ = json.Unmarshal(status.Body.Bytes(), &b)
			if b.State == statusPlayable && b.Available > 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("speed job never became playable while downloading")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Media endpoint serves 206 while downloading (not a 503 buffering).
	req := httptest.NewRequest(http.MethodGet, "/v1/media/fixture?token="+s.token, nil)
	req.Header.Set("Origin", allowedOriginLocal)
	req.Header.Set("Range", "bytes=0-1023")
	mrec := httptest.NewRecorder()
	s.Handler().ServeHTTP(mrec, req)
	if mrec.Code != http.StatusPartialContent {
		t.Fatalf("speed media while downloading = %d, want 206", mrec.Code)
	}
	if cr := mrec.Header().Get("Content-Range"); cr == "" {
		t.Fatal("speed 206 must carry Content-Range")
	}

	// Clean up the speed job so the invalid-mode probe below is unambiguous.
	doJob(t, s, http.MethodPost, "/v1/source/jobs/"+created.ID+"/cancel", allowedOriginLocal, "")

	// Unknown mode → 400.
	rec = doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk","mode":"turbo"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid mode create = %d, want 400", rec.Code)
	}
}

func TestJobCreateInvalidURLAndRedaction(t *testing.T) {
	s, _ := newJobsServer(t)
	cases := []string{
		`{"url":"http://www.youtube.com/watch?v=abcdefghijk"}`,
		`{"url":"https://google.com/watch?v=abcdefghijk"}`,
		`{"url":"not a url"}`,
		`{"url":""}`,
		`{}`,
	}
	for _, body := range cases {
		rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal, body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("create %s = %d, want 400", body, rec.Code)
		}
		// The error must be generic and never echo the offending URL.
		if strings.Contains(rec.Body.String(), "google.com") || strings.Contains(rec.Body.String(), "youtube.com") {
			t.Errorf("400 body leaks URL content: %s", rec.Body.String())
		}
	}
}

// TestJobCreateAutoCancelsFailedState pins (c): a job that ended in an
// ERROR state still occupies `current` (it stays current redacted until
// cancelled); the create handler must auto-cancel it too so the next URL
// is accepted.
func TestJobCreateAutoCancelsFailedState(t *testing.T) {
	s, m := newJobsServer(t)
	t.Setenv("EIZOU_FAKE_SIZE", "200")
	t.Setenv("EIZOU_FAKE_FAIL", "1")
	t.Setenv("EIZOU_FAKE_HOLD", "")

	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	// Wait for the error state (fake fails immediately; the job stays
	// current redacted).
	deadline := time.Now().Add(10 * time.Second)
	for {
		if snap := m.Get(created.ID); snap == nil || snap.State == job.StateError {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never errored")
		}
		time.Sleep(30 * time.Millisecond)
	}
	if st := getStatus(t, s); st.State != "error" {
		t.Fatalf("status after failed job = %+v, want error", st)
	}

	// A new URL must be accepted (201) even though the errored job is
	// still current — the handler auto-cancels it first.
	rec = doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=hgfedcbaijk"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create after error job = %d, want 201 (auto-cancel failed)", rec.Code)
	}
}

// TestJobCreateAutoCancelsDownloading verifies the 2026-08-09 fix: a
// previous YouTube job in ANY state (even complete, which stays current
// to serve its media) is auto-cancelled by the create handler, so a new
// URL is always accepted with 201. Previously the leftover completed job
// blocked every new URL with 409 (on-device "Satu unduhan sudah
// berjalan"). The web-side auto-cancel only targets downloading/
// buffering, so the server covers complete (and error) states.
func TestJobCreateAutoCancelsDownloading(t *testing.T) {
	s, _ := newJobsServer(t)
	t.Setenv("EIZOU_FAKE_SIZE", "0")
	t.Setenv("EIZOU_FAKE_HOLD", "1")
	body := `{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`
	if rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal, body); rec.Code != http.StatusCreated {
		t.Fatalf("first create = %d, want 201", rec.Code)
	}

	// Second create for a NEW URL: the previous (held, downloading) job is
	// auto-cancelled and the new one accepted.
	body2 := `{"url":"https://www.youtube.com/watch?v=zyxwvutsrqp"}`
	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal, body2)
	if rec.Code != http.StatusCreated {
		t.Fatalf("second create = %d, want 201 (auto-cancel)", rec.Code)
	}
}

// TestJobCreateAutoCancelsCompleted pins the fix for a COMPLETED job:
// a finished job stays current (serving its media) and would previously
// have made every new URL 409. The create handler must auto-cancel it.
func TestJobCreateAutoCancelsCompleted(t *testing.T) {
	s, _ := newJobsServer(t)
	// Small fake media completes quickly (no hold).
	t.Setenv("EIZOU_FAKE_SIZE", "1024")
	t.Setenv("EIZOU_FAKE_CHUNK", "1024")
	t.Setenv("EIZOU_FAKE_CHUNK_DELAY_MS", "1")
	t.Setenv("EIZOU_FAKE_HOLD", "")

	body := `{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`
	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal, body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201", rec.Code)
	}
	// Wait for completion (the completed job stays current).
	deadline := time.Now().Add(5 * time.Second)
	for {
		if snap := s.jobs.Current(); snap != nil && snap.State == job.StateComplete {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fake job never completed")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// New URL while a completed job is current: must be 201 with the old
	// job released.
	rec = doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=hgfedcbaijk"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create after complete = %d, want 201 (auto-cancel completed)", rec.Code)
	}
}

// TestJobReplacesTorrent verifies that a YouTube create cancels all active
// torrent sessions (fire-and-forget cross-kind replace) and succeeds with
// 201. Kinds never mix — the old kind just yields (2026-08-21).
func TestJobReplacesTorrent(t *testing.T) {
	torEngine := newAPIFakeEngine("media.mp4:200")
	torFactory := func(_ string) (torrent.Engine, error) { return torEngine, nil }
	mTor, err := torrent.New(torrent.Config{EngineFactory: torFactory, Timeout: 20 * time.Second})
	if err != nil {
		t.Fatalf("torrent.New: %v", err)
	}
	t.Cleanup(func() { _ = mTor.Close() })
	mJob, err := job.New(job.Config{HelperPath: fakeHelper, Timeout: 20 * time.Second})
	if err != nil {
		t.Fatalf("job.New: %v", err)
	}
	t.Cleanup(func() { _ = mJob.Close() })
	s, err := New(Config{Jobs: mJob, Torrents: mTor})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Torrent session active.
	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("torrent create = %d, want 201", rec.Code)
	}
	if mTor.ActiveCount() != 1 {
		t.Fatalf("active torrents = %d, want 1", mTor.ActiveCount())
	}
	// YouTube create with a torrent active: cancels the torrent (201).
	rec = doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("youtube create during torrent = %d, want 201", rec.Code)
	}
	if mTor.ActiveCount() != 0 {
		t.Fatalf("torrents after youtube create = %d, want 0 (cancelled)", mTor.ActiveCount())
	}
	if s.jobs.Current() == nil {
		t.Fatal("youtube job should be current after replace")
	}
	// Clean up the YouTube job.
	jobs := mJob.Current()
	if jobs != nil {
		rec = doJob(t, s, http.MethodPost, "/v1/source/jobs/"+jobs.ID+"/cancel", allowedOriginLocal, "")
		_ = rec
	}
}

func TestJobUnknownIDReadAndCancel(t *testing.T) {
	s, _ := newJobsServer(t)
	unknown := strings.Repeat("0", 32)
	if rec := doJob(t, s, http.MethodGet, "/v1/source/jobs/"+unknown, allowedOriginLocal, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown read = %d, want 404", rec.Code)
	}
	if rec := doJob(t, s, http.MethodPost, "/v1/source/jobs/"+unknown+"/cancel", allowedOriginLocal, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown cancel = %d, want 404", rec.Code)
	}
}

// TestServePartRange416OnlyWhenTotalPinned pins the fixed-total 416
// contract on the growing .part source: while the estimated total is NOT
// yet pinned, a range starting at/beyond the current size is long-polled
// (503 after the hold timeout — a permanent 416 would wrongly kill the
// player's "loading → 1s play → loading" loop); once pinned, the same
// range is the true 416.
func TestServePartRange416OnlyWhenTotalPinned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "media.mp4.part")
	if err := os.WriteFile(path, bytes.Repeat([]byte{0x41}, 100), 0o600); err != nil {
		t.Fatal(err)
	}
	s := newTestServer(t)

	// Unpinned .part (the real-device failure window): avail == total ==
	// 100, total not decided. bytes=100- (Chrome's next bytes) must be
	// HELD (availability long-poll) and end 503 after the short timeout —
	// never 416.
	withShortHold(t, func() {
		for _, rng := range []string{"bytes=100-", "bytes=150-"} {
			r := httptest.NewRequest(http.MethodGet, "/v1/media/fixture", nil)
			r.Header.Set("Range", rng)
			rec := httptest.NewRecorder()
			s.serveGrowingSource(job.NewPartSource(path), rec, r)
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("unpinned %s = %d, want 503 (held, NOT 416)", rng, rec.Code)
			}
		}
	})

	// Pinned total == current size: the same ranges are permanent 416s.
	pinned := job.NewPartSource(path)
	pinned.SetTotal(100)
	for _, rng := range []string{"bytes=100-", "bytes=200-", "bytes=100-20000"} {
		r := httptest.NewRequest(http.MethodGet, "/v1/media/fixture", nil)
		r.Header.Set("Range", rng)
		rec := httptest.NewRecorder()
		s.serveGrowingSource(pinned, rec, r)
		if rec.Code != http.StatusRequestedRangeNotSatisfiable {
			t.Errorf("pinned %s = %d, want 416", rng, rec.Code)
			continue
		}
		if cr := rec.Header().Get("Content-Range"); cr != "bytes */100" {
			t.Errorf("pinned %s Content-Range = %q, want bytes */100", rng, cr)
		}
	}
	// A servable range inside the pinned total stays 206.
	r := httptest.NewRequest(http.MethodGet, "/v1/media/fixture", nil)
	r.Header.Set("Range", "bytes=0-99")
	rec := httptest.NewRecorder()
	s.serveGrowingSource(pinned, rec, r)
	if rec.Code != http.StatusPartialContent || rec.Body.Len() != 100 {
		t.Fatalf("pinned bytes=0-99 = %d, %d bytes; want 206, 100 bytes", rec.Code, rec.Body.Len())
	}
}

func TestStatusMappingGrowingThenComplete(t *testing.T) {
	s, m := newJobsServer(t)
	t.Setenv("EIZOU_FAKE_SIZE", "900")
	t.Setenv("EIZOU_FAKE_CHUNK", "300")
	t.Setenv("EIZOU_FAKE_CHUNK_DELAY_MS", "250")
	t.Setenv("EIZOU_FAKE_HOLD", "")

	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		// Explicit quality: the wait-for-mux path stays buffering while
		// downloading (the default mode is now speed, which goes playable
		// as soon as bytes exist).
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk","mode":"quality"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	// While downloading: status "buffering", available grows, total unknown.
	deadline := time.Now().Add(10 * time.Second)
	sawGrowing := false
	for {
		status := getStatus(t, s)
		if status.State == "buffering" {
			if status.Available > 0 && status.Total == 0 {
				sawGrowing = true
			}
		}
		if snap := m.Get(created.ID); snap != nil && snap.State == job.StateComplete {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never completed; last status=%+v", getStatus(t, s))
		}
		time.Sleep(40 * time.Millisecond)
	}
	if !sawGrowing {
		t.Fatal("expected status buffering with growing available (total 0) during download")
	}
	status := getStatus(t, s)
	if status.State != "complete" || status.Available != 900 || status.Total != 900 {
		t.Fatalf("complete status = %+v, want complete 900/900", status)
	}
}

func TestStatusMappingError(t *testing.T) {
	s, m := newJobsServer(t)
	t.Setenv("EIZOU_FAKE_SIZE", "200")
	t.Setenv("EIZOU_FAKE_FAIL", "1")
	t.Setenv("EIZOU_FAKE_HOLD", "")

	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	deadline := time.Now().Add(10 * time.Second)
	for {
		if snap := m.Get(created.ID); snap == nil || snap.State == job.StateError {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never errored")
		}
		time.Sleep(30 * time.Millisecond)
	}
	if st := getStatus(t, s); st.State != "error" {
		t.Fatalf("status after failed job = %+v, want error", st)
	}
}

func TestStatusMappingCancelledFallsThrough(t *testing.T) {
	s, _ := newJobsServer(t)
	t.Setenv("EIZOU_FAKE_SIZE", "0")
	t.Setenv("EIZOU_FAKE_HOLD", "1")
	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	if rec := doJob(t, s, http.MethodPost, "/v1/source/jobs/"+created.ID+"/cancel", allowedOriginLocal, ""); rec.Code != http.StatusOK {
		t.Fatalf("cancel = %d", rec.Code)
	}
	// With no configured source, a cancelled session falls back to disabled.
	if st := getStatus(t, s); st.State != "disabled" {
		t.Fatalf("status after cancel = %+v, want disabled (no configured source)", st)
	}
}

func TestFixtureMappingComplete(t *testing.T) {
	s, m := newJobsServer(t)
	t.Setenv("EIZOU_FAKE_SIZE", "900")
	t.Setenv("EIZOU_FAKE_CHUNK", "300")
	t.Setenv("EIZOU_FAKE_CHUNK_DELAY_MS", "250")
	t.Setenv("EIZOU_FAKE_HOLD", "")

	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	waitForState(t, m, created.ID, job.StateComplete, 10*time.Second)

	// Full GET.
	rec = doJob(t, s, http.MethodGet, "/v1/media/fixture", allowedOriginLocal, "")
	if rec.Code != http.StatusOK || len(rec.Body.Bytes()) != 900 {
		t.Fatalf("fixture GET = %d, %d bytes; want 200, 900 bytes", rec.Code, len(rec.Body.Bytes()))
	}
	for i, b := range rec.Body.Bytes() {
		if b != 0x41 {
			t.Fatalf("fixture byte %d = %#x, want 0x41", i, b)
		}
	}
	// Range.
	req := httptest.NewRequest(http.MethodGet, "/v1/media/fixture?token="+s.token, nil)
	req.Header.Set("Origin", allowedOriginLocal)
	req.Header.Set("Range", "bytes=100-199")
	rec2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec2, req)
	if rec2.Code != http.StatusPartialContent || len(rec2.Body.Bytes()) != 100 {
		t.Fatalf("fixture Range = %d, %d bytes; want 206, 100 bytes", rec2.Code, len(rec2.Body.Bytes()))
	}
}

func TestFixtureMappingBufferingAndError(t *testing.T) {
	s, m := newJobsServer(t)

	// Downloading job → 503 buffering with current bytes.
	t.Setenv("EIZOU_FAKE_SIZE", "900")
	t.Setenv("EIZOU_FAKE_CHUNK", "300")
	t.Setenv("EIZOU_FAKE_CHUNK_DELAY_MS", "250")
	t.Setenv("EIZOU_FAKE_HOLD", "")
	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	// Wait until the job is clearly downloading, then probe the fixture.
	deadline := time.Now().Add(8 * time.Second)
	probed := false
	for {
		snap := m.Get(created.ID)
		if snap != nil && snap.State == job.StateDownloading {
			rec = doJob(t, s, http.MethodGet, "/v1/media/fixture", allowedOriginLocal, "")
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("fixture while downloading = %d, want 503", rec.Code)
			}
			var body map[string]any
			_ = json.Unmarshal(rec.Body.Bytes(), &body)
			if body["error"] != "buffering" {
				t.Fatalf("503 body = %s, want buffering metadata", rec.Body.String())
			}
			probed = true
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("never observed downloading")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !probed {
		t.Fatal("expected a 503 probe")
	}
	// Clean up this job before the error case (one-session policy).
	if rec := doJob(t, s, http.MethodPost, "/v1/source/jobs/"+created.ID+"/cancel", allowedOriginLocal, ""); rec.Code != http.StatusOK {
		t.Fatalf("cancel = %d", rec.Code)
	}

	// Failed job → generic 404 on the fixture.
	t.Setenv("EIZOU_FAKE_FAIL", "1")
	rec = doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	deadline = time.Now().Add(8 * time.Second)
	for {
		snap := m.Get(created.ID)
		if snap == nil || snap.State == job.StateError {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("job never errored")
		}
		time.Sleep(30 * time.Millisecond)
	}
	rec = doJob(t, s, http.MethodGet, "/v1/media/fixture", allowedOriginLocal, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("fixture after failed job = %d, want 404", rec.Code)
	}
}

func TestJobPreflight(t *testing.T) {
	s, _ := newJobsServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/v1/source/jobs", nil)
	req.Header.Set("Origin", allowedOriginLocal)
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, "POST") {
		t.Fatalf("preflight allow-methods = %q, want POST", got)
	}
}

// getStatus fetches /v1/media/status and decodes the body.
func getStatus(t *testing.T, s *Server) statusBody {
	t.Helper()
	rec := doJob(t, s, http.MethodGet, "/v1/media/status", allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body statusBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	return body
}

func TestJobSubtitleEndpoint(t *testing.T) {
	s, _ := newJobsServer(t)
	t.Setenv("EIZOU_FAKE_SIZE", "1024")

	// Create a job.
	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d", rec.Code)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Wait for complete.
	deadline := time.Now().Add(10 * time.Second)
	for {
		r := doJob(t, s, http.MethodGet, "/v1/source/jobs/"+created.ID, allowedOriginLocal, "")
		var snap struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(r.Body.Bytes(), &snap)
		if snap.State == "complete" {
			break
		}
		if snap.State == "error" {
			t.Fatalf("job errored: %s", r.Body.String())
		}
		if time.Now().After(deadline) {
			t.Fatal("timeout waiting for complete")
		}
		time.Sleep(100 * time.Millisecond)
	}

	// No subtitle file exists → 404.
	rec = doJob(t, s, http.MethodGet, "/v1/source/jobs/"+created.ID+"/subtitle", allowedOriginLocal, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("subtitle (no file) = %d, want 404", rec.Code)
	}

	// POST is not allowed.
	rec = doJob(t, s, http.MethodPost, "/v1/source/jobs/"+created.ID+"/subtitle", allowedOriginLocal, "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST subtitle = %d, want 405", rec.Code)
	}

	// Unknown job id → 404.
	rec = doJob(t, s, http.MethodGet, "/v1/source/jobs/nonexistent/subtitle", allowedOriginLocal, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("subtitle unknown = %d, want 404", rec.Code)
	}

	// Cancel the job.
	doJob(t, s, http.MethodPost, "/v1/source/jobs/"+created.ID+"/cancel", allowedOriginLocal, "")
}
