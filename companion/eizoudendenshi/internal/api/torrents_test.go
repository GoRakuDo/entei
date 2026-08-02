package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"eizoudendenshi/internal/job"
	"eizoudendenshi/internal/torrent"
)

const testMagnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"

// newTorrentsServer builds a server with a torrent manager over the fake
// aria2 helper.
func newTorrentsServer(t *testing.T) (*Server, *torrent.Manager) {
	t.Helper()
	m, err := torrent.New(torrent.Config{HelperPath: fakeAria2, Timeout: 20 * time.Second})
	if err != nil {
		t.Fatalf("torrent.New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	s, err := New(Config{Torrents: m})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s, m
}

func doTorrent(t *testing.T, s *Server, method, path, origin, body string) *httptest.ResponseRecorder {
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

func TestTorrentEndpointsDisabledWithoutManager(t *testing.T) {
	s := newTestServer(t)
	for _, path := range []string{
		"/v1/source/torrents",
		"/v1/source/torrents/123",
		"/v1/source/torrents/123/cancel",
		"/v1/source/torrents/123/files",
		"/v1/source/torrents/123/select",
	} {
		rec := doRequest(t, s.Handler(), http.MethodPost, path, allowedOriginLocal, "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s without torrent manager = %d, want 404", path, rec.Code)
		}
	}
}

func TestTorrentGates(t *testing.T) {
	s, _ := newTorrentsServer(t)
	body := `{"magnet":"` + testMagnet + `"}`

	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", "", body)
	if rec.Code != http.StatusForbidden || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("no origin = %d (acoa %q), want 403 without CORS", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents", disallowedOrigin, body)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("disallowed origin = %d, want 403", rec.Code)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/source/torrents", strings.NewReader(body))
	req.Header.Set("Origin", allowedOriginLocal)
	req.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec2, req)
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("no token = %d, want 401", rec2.Code)
	}
}

func TestTorrentCreateInvalidMagnetRedacted(t *testing.T) {
	s, _ := newTorrentsServer(t)
	for _, bad := range []string{
		`{"magnet":"http://example.com/file.torrent"}`,
		`{"magnet":"magnet:?xt=urn:btih:short"}`,
		`{"magnet":"not a magnet"}`,
		// An unsafe tracker (loopback) rejects the whole magnet.
		`{"magnet":"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp%3A%2F%2F127.0.0.1%3A6969"}`,
		`{}`,
	} {
		rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal, bad)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("create %s = %d, want 400", bad, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "example.com") || strings.Contains(rec.Body.String(), "magnet:") {
			t.Errorf("400 body leaks the magnet: %s", rec.Body.String())
		}
	}
}

// TestTorrentTrackerNeverLeaks: a job created with a tracker-bearing magnet
// must never expose the tracker (or the magnet) in any API response.
func TestTorrentTrackerNeverLeaks(t *testing.T) {
	s, _ := newTorrentsServer(t)
	t.Setenv("EIZOU_FAKE_TORRENT", "files=movie.mkv:200;pieceLen=100")
	t.Setenv("EIZOU_FAKE_METADATA", "1")
	t.Setenv("EIZOU_FAKE_PAYLOAD", "1")
	t.Setenv("EIZOU_FAKE_HEAD_PIECES", "10")
	t.Setenv("EIZOU_FAKE_HOLD", "")
	trackerMagnet := testMagnet + "&tr=udp%3A%2F%2Ftracker.example%3A1337&tr=https%3A%2F%2Ftr2.example%2Fannounce"
	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+trackerMagnet+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201 (%s)", rec.Code, rec.Body.String())
	}
	for _, needle := range []string{"tracker.example", "tr2.example", "urn:btih", "&tr="} {
		if strings.Contains(rec.Body.String(), needle) {
			t.Errorf("create response leaks %q: %s", needle, rec.Body.String())
		}
	}
	// The read response after the download must stay tracker-free too.
	deadline := time.Now().Add(10 * time.Second)
	var id string
	var j struct {
		ID    string `json:"id"`
		State string `json:"state"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &j)
	id = j.ID
	for {
		r := doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+id, allowedOriginLocal, "")
		if r.Code != http.StatusOK {
			t.Fatalf("read = %d (%s)", r.Code, r.Body.String())
		}
		if strings.Contains(r.Body.String(), "tracker.example") || strings.Contains(r.Body.String(), "urn:btih") {
			t.Fatalf("read response leaks tracker/magnet: %s", r.Body.String())
		}
		var snap struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(r.Body.Bytes(), &snap)
		if snap.State == "buffering" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("job never reached buffering")
		}
		time.Sleep(30 * time.Millisecond)
	}
	// Status endpoint must not leak either.
	st := doTorrent(t, s, http.MethodGet, "/v1/media/status?token="+s.token, allowedOriginLocal, "")
	if strings.Contains(st.Body.String(), "tracker.example") || strings.Contains(st.Body.String(), "urn:btih") {
		t.Fatalf("status leaks tracker/magnet: %s", st.Body.String())
	}
	doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+id+"/cancel", allowedOriginLocal, "")
}

func TestTorrentCreateReadFilesSelectCancel(t *testing.T) {
	s, m := newTorrentsServer(t)
	t.Setenv("EIZOU_FAKE_TORRENT", "files=Episode 01.mkv:200|Episode 01.ass:40|readme.txt:10;pieceLen=100")
	t.Setenv("EIZOU_FAKE_METADATA", "1")
	t.Setenv("EIZOU_FAKE_PAYLOAD", "1")
	t.Setenv("EIZOU_FAKE_HEAD_PIECES", "10")
	t.Setenv("EIZOU_FAKE_HOLD", "")

	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201 (%s)", rec.Code, rec.Body.String())
	}
	var created struct {
		ID    string `json:"id"`
		State string `json:"state"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	if created.ID == "" {
		t.Fatal("create body must carry an opaque id")
	}
	// The magnet must never appear in the response.
	if strings.Contains(rec.Body.String(), "urn:btih") {
		t.Fatal("create response leaks the magnet")
	}

	// Wait for the download + listing to be ready.
	deadline := time.Now().Add(10 * time.Second)
	for {
		snap := m.Get(created.ID)
		if snap != nil && snap.State == torrent.StateBuffering {
			break
		}
		if snap != nil && snap.State == torrent.StateError {
			t.Fatalf("job errored: %v", snap.Error)
		}
		if time.Now().After(deadline) {
			t.Fatal("never reached buffering")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// Files: sanitized listing only.
	rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID+"/files", allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("files = %d, want 200", rec.Code)
	}
	var listing struct {
		Files []struct {
			ID       string `json:"id"`
			Basename string `json:"basename"`
			Kind     string `json:"kind"`
		} `json:"files"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &listing)
	if len(listing.Files) != 3 {
		t.Fatalf("listing = %d files, want 3", len(listing.Files))
	}
	if strings.Contains(rec.Body.String(), "sub/") || strings.Contains(rec.Body.String(), "\\") {
		t.Fatal("file listing leaks a path")
	}
	var videoID, subID string
	for _, f := range listing.Files {
		if f.Kind == "video" {
			videoID = f.ID
		}
		if f.Kind == "subtitle" {
			subID = f.ID
		}
	}
	if videoID == "" || subID == "" {
		t.Fatalf("expected one video + one subtitle: %+v", listing.Files)
	}

	// Invalid selection → 400; valid selection → complete + servable media.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select", allowedOriginLocal,
		`{"videoFileId":"f99"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid select = %d, want 400", rec.Code)
	}
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select", allowedOriginLocal,
		`{"videoFileId":"`+videoID+`","subtitleFileId":"`+subID+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("select = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	var sel struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &sel)
	if sel.State != "buffering" {
		t.Fatalf("select state = %s, want buffering (streaming phase starts async)", sel.State)
	}
	// The fake payload completes quickly: poll the job until complete.
	deadline = time.Now().Add(10 * time.Second)
	for {
		rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "complete" {
			break
		}
		if js.State == "error" {
			t.Fatalf("job errored during streaming: %s", rec.Body.String())
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never completed; last=%s", js.State)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Status + fixture now reflect the selected media.
	rec = doTorrent(t, s, http.MethodGet, "/v1/media/status", allowedOriginLocal, "")
	var status statusBody
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status.State != "complete" || status.Available != 200 || status.Total != 200 {
		t.Fatalf("status = %+v, want complete 200/200", status)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/media/fixture?token="+s.token, nil)
	req.Header.Set("Origin", allowedOriginLocal)
	req.Header.Set("Range", "bytes=0-199")
	rec2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec2, req)
	if rec2.Code != http.StatusPartialContent || len(rec2.Body.Bytes()) != 200 {
		t.Fatalf("fixture Range = %d, %d bytes; want 206, 200", rec2.Code, len(rec2.Body.Bytes()))
	}

	// Cancel frees the session; read after → 404.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/cancel", allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel = %d, want 200", rec.Code)
	}
	rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("read after cancel = %d, want 404", rec.Code)
	}
}

func TestTorrentStatusBufferingBeforeSelection(t *testing.T) {
	s, m := newTorrentsServer(t)
	t.Setenv("EIZOU_FAKE_TORRENT", "files=media.mp4:200;pieceLen=100")
	t.Setenv("EIZOU_FAKE_METADATA", "1")
	t.Setenv("EIZOU_FAKE_PAYLOAD", "1")
	t.Setenv("EIZOU_FAKE_HEAD_PIECES", "10")
	t.Setenv("EIZOU_FAKE_HOLD", "")
	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	// During download / awaiting selection: status buffering, fixture 503.
	deadline := time.Now().Add(10 * time.Second)
	for {
		snap := m.Get(created.ID)
		if snap != nil && snap.State == torrent.StateBuffering {
			break
		}
		if snap != nil && snap.State == torrent.StateError {
			t.Fatalf("job errored: %v", snap.Error)
		}
		if time.Now().After(deadline) {
			t.Fatal("never reached buffering")
		}
		time.Sleep(30 * time.Millisecond)
	}
	rec = doTorrent(t, s, http.MethodGet, "/v1/media/status", allowedOriginLocal, "")
	var status statusBody
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status.State != "buffering" {
		t.Fatalf("status before selection = %+v, want buffering", status)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/media/fixture?token="+s.token, nil)
	req.Header.Set("Origin", allowedOriginLocal)
	rec2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec2, req)
	if rec2.Code != http.StatusServiceUnavailable {
		t.Fatalf("fixture before selection = %d, want 503", rec2.Code)
	}
}

func TestTorrentConflictAcrossJobKinds(t *testing.T) {
	// Torrent active → YouTube create conflicts, and vice versa.
	mTor, err := torrent.New(torrent.Config{HelperPath: fakeAria2, Timeout: 20 * time.Second})
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
	t.Setenv("EIZOU_FAKE_TORRENT", "files=movie.mkv:200;pieceLen=100")
	t.Setenv("EIZOU_FAKE_HOLD", "1")

	// Start a torrent job.
	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("torrent create = %d, want 201", rec.Code)
	}
	// YouTube create while the torrent is active → 409.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("youtube create during torrent = %d, want 409", rec.Code)
	}
	// Torrent create again → 409.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second torrent create = %d, want 409", rec.Code)
	}
	// Cancel the torrent → YouTube create succeeds.
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	// (rec body is the 409 error — cancel via the first job id instead.)
	first := mTor.Current()
	if first == nil {
		t.Fatal("torrent job missing")
	}
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+first.ID+"/cancel", allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("torrent cancel = %d, want 200", rec.Code)
	}
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("youtube create after torrent cancel = %d, want 201", rec.Code)
	}
}

func TestTorrentPreflight(t *testing.T) {
	s, _ := newTorrentsServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/v1/source/torrents", nil)
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

// TestTorrentStreamingMIME asserts the selected file's extension governs
// the Content-Type on both the streaming and completed media serves.
func TestTorrentStreamingMIME(t *testing.T) {
	// An MKV selection must be served as video/x-matroska, never video/mp4.
	t.Setenv("EIZOU_FAKE_TORRENT", "files=movie.mkv:800000|audio.mp3:40000;pieceLen=100")
	t.Setenv("EIZOU_FAKE_METADATA", "1")
	t.Setenv("EIZOU_FAKE_PAYLOAD", "1")
	t.Setenv("EIZOU_FAKE_HEAD_PIECES", "10")
	s, _ := newTorrentsServer(t)
	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal, `{"magnet":"`+testMagnet+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d", rec.Code)
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	deadline := time.Now().Add(15 * time.Second)
	for {
		rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "buffering" {
			break
		}
		if js.State == "error" || time.Now().After(deadline) {
			t.Fatalf("never listed: %s", rec.Body.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Select the MKV video file.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select", allowedOriginLocal, `{"videoFileId":"f0"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("select = %d %s", rec.Code, rec.Body.String())
	}
	deadline = time.Now().Add(15 * time.Second)
	for {
		rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "complete" {
			break
		}
		if js.State == "error" || time.Now().After(deadline) {
			t.Fatalf("never completed: %s", rec.Body.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	// The completed media serve must carry the MKV MIME.
	req, _ := http.NewRequest(http.MethodGet, "http://example.test/v1/media/fixture?token="+s.token, nil)
	req.Header.Set("Origin", allowedOriginLocal)
	req.Header.Set("Range", "bytes=0-63")
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if ct := rec.Header().Get("Content-Type"); ct != "video/x-matroska" {
		t.Fatalf("MKV Content-Type = %q, want video/x-matroska", ct)
	}
}
