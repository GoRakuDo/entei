package api

import (
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
)

// fakeHelper is the test-only yt-dlp stand-in, built once from
// internal/job/testdata/fakehelper (same helper the job tests use).
var fakeHelper string

// fakeAria2 is the test-only aria2 stand-in, built once from
// internal/torrent/testdata/fakearia2.
var fakeAria2 string

func TestMain(m *testing.M) {
	_, thisFile, _, _ := runtime.Caller(0)
	pkgDir := filepath.Dir(thisFile)
	dir, err := os.MkdirTemp("", "entei-api-fake-helper-*")
	if err != nil {
		fmt.Fprintf(os.Stderr, "temp dir: %v\n", err)
		os.Exit(1)
	}
	exe := "fakehelper"
	exeAria := "fakearia2"
	if runtime.GOOS == "windows" {
		exe += ".exe"
		exeAria += ".exe"
	}
	fakeHelper = filepath.Join(dir, exe)
	build := exec.Command("go", "build", "-o", fakeHelper, filepath.Join(pkgDir, "..", "job", "testdata", "fakehelper"))
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build fake helper: %v\n%s", err, out)
		os.RemoveAll(dir)
		os.Exit(1)
	}
	fakeAria2 = filepath.Join(dir, exeAria)
	buildAria := exec.Command("go", "build", "-o", fakeAria2, filepath.Join(pkgDir, "..", "torrent", "testdata", "fakearia2"))
	if out, err := buildAria.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build fake aria2: %v\n%s", err, out)
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

func TestJobConflictOneActive(t *testing.T) {
	s, _ := newJobsServer(t)
	t.Setenv("EIZOU_FAKE_SIZE", "0")
	t.Setenv("EIZOU_FAKE_HOLD", "1")
	body := `{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`
	if rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal, body); rec.Code != http.StatusCreated {
		t.Fatalf("first create = %d, want 201", rec.Code)
	}
	rec := doJob(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal, body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second create = %d, want 409 conflict", rec.Code)
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

func TestStatusMappingGrowingThenComplete(t *testing.T) {
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
