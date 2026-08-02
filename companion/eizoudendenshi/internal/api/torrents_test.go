package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"eizoudendenshi/internal/job"
	"eizoudendenshi/internal/torrent"
)

const testMagnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"

// --- fake Engine for API tests ---

type apiFakeEngine struct {
	files []torrent.TorrentFile
	h     *apiFakeHandle
}

func newAPIFakeEngine(filesSpec string) *apiFakeEngine {
	var files []torrent.TorrentFile
	for i, part := range strings.Split(filesSpec, "|") {
		parts := strings.SplitN(part, ":", 2)
		if len(parts) != 2 {
			continue
		}
		name := parts[0]
		size, _ := strconv.ParseInt(parts[1], 10, 64)
		ext := ""
		if idx := strings.LastIndexByte(name, '.'); idx >= 0 {
			ext = name[idx+1:]
		}
		kind := torrent.KindOther
		switch {
		case ext == "mkv" || ext == "mp4" || ext == "webm" || ext == "avi":
			kind = torrent.KindVideo
		case ext == "srt" || ext == "ass" || ext == "vtt":
			kind = torrent.KindSubtitle
		case ext == "mp3" || ext == "flac" || ext == "aac":
			kind = torrent.KindAudio
		}
		files = append(files, torrent.TorrentFile{
			ID:     "f" + strconv.Itoa(i),
			Path:   name,
			Length: size,
			Kind:   kind,
		})
	}
	return &apiFakeEngine{files: files}
}

func (e *apiFakeEngine) Start(_ context.Context, _ string) (torrent.TorrentHandle, error) {
	h := &apiFakeHandle{files: e.files}
	e.h = h
	return h, nil
}

func (e *apiFakeEngine) Close() error { return nil }

type apiFakeHandle struct {
	files    []torrent.TorrentFile
	selected int
	avail    atomic.Int64
}

func (h *apiFakeHandle) Name() string                 { return "test-torrent" }
func (h *apiFakeHandle) Files() []torrent.TorrentFile { return h.files }
func (h *apiFakeHandle) AvailablePrefix() int64       { return h.avail.Load() }
func (h *apiFakeHandle) Close() error                 { return nil }

func (h *apiFakeHandle) SelectedLength() int64 {
	if h.selected < 0 || h.selected >= len(h.files) {
		return 0
	}
	return h.files[h.selected].Length
}

func (h *apiFakeHandle) Select(videoFileID, _ string) error {
	for i, f := range h.files {
		if f.ID == videoFileID {
			if f.Kind != torrent.KindVideo {
				return errors.New("not a video")
			}
			h.selected = i
			return nil
		}
	}
	return errors.New("invalid selection")
}

func (h *apiFakeHandle) Reader(_ context.Context) (io.ReadSeekCloser, error) {
	if h.selected < 0 {
		return nil, errors.New("no selection")
	}
	h.avail.Store(h.files[h.selected].Length) // simulate complete
	return &apiFakeReader{
		data: []byte(strings.Repeat("x", int(h.files[h.selected].Length))),
	}, nil
}

type apiFakeReader struct {
	data []byte
	off  int64
}

func (r *apiFakeReader) Read(p []byte) (int, error) {
	if r.off >= int64(len(r.data)) {
		return 0, io.EOF
	}
	n := copy(p, r.data[r.off:])
	r.off += int64(n)
	if r.off >= int64(len(r.data)) {
		return n, io.EOF
	}
	return n, nil
}

func (r *apiFakeReader) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
		r.off = offset
	case io.SeekCurrent:
		r.off += offset
	case io.SeekEnd:
		r.off = int64(len(r.data)) + offset
	}
	if r.off < 0 {
		r.off = 0
		return 0, errors.New("negative position")
	}
	return r.off, nil
}

func (r *apiFakeReader) Close() error { return nil }

func newTorrentsServer(t *testing.T) (*Server, *torrent.Manager) {
	t.Helper()
	engine := newAPIFakeEngine("Episode 01.mkv:200|Episode 01.ass:40|readme.txt:10")
	m, err := torrent.New(torrent.Config{Engine: engine, Timeout: 20 * time.Second})
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

func TestTorrentTrackerNeverLeaks(t *testing.T) {
	s, _ := newTorrentsServer(t)
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
	var j struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &j)
	deadline := time.Now().Add(5 * time.Second)
	for {
		r := doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+j.ID, allowedOriginLocal, "")
		if r.Code != http.StatusOK {
			t.Fatalf("read = %d (%s)", r.Code, r.Body.String())
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
	doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+j.ID+"/cancel", allowedOriginLocal, "")
}

func TestTorrentCreateReadFilesSelectCancel(t *testing.T) {
	s, _ := newTorrentsServer(t)

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
	if strings.Contains(rec.Body.String(), "urn:btih") {
		t.Fatal("create response leaks the magnet")
	}

	// Wait for metadata (buffering state).
	deadline := time.Now().Add(5 * time.Second)
	for {
		rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "buffering" {
			break
		}
		if js.State == "error" {
			t.Fatalf("job errored: %s", rec.Body.String())
		}
		if time.Now().After(deadline) {
			t.Fatal("never reached buffering")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// Files listing.
	rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID+"/files", allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("files = %d, want 200", rec.Code)
	}
	var listing struct {
		Files []struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
		} `json:"files"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &listing)
	if len(listing.Files) != 3 {
		t.Fatalf("listing = %d files, want 3", len(listing.Files))
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

	// Invalid selection.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select", allowedOriginLocal,
		`{"videoFileId":"f99"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid select = %d, want 400", rec.Code)
	}
	// Valid selection.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select", allowedOriginLocal,
		`{"videoFileId":"`+videoID+`","subtitleFileId":"`+subID+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("select = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	// Wait for complete.
	deadline = time.Now().Add(5 * time.Second)
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
			t.Fatalf("job errored: %s", rec.Body.String())
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never completed; last=%s", js.State)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Status reflects complete.
	rec = doTorrent(t, s, http.MethodGet, "/v1/media/status", allowedOriginLocal, "")
	var status statusBody
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status.State != "complete" {
		t.Fatalf("status = %+v, want complete", status)
	}

	// Cancel frees session.
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
	s, _ := newTorrentsServer(t)
	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	deadline := time.Now().Add(5 * time.Second)
	for {
		rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "buffering" {
			break
		}
		if js.State == "error" {
			t.Fatalf("job errored: %s", rec.Body.String())
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
}

func TestTorrentConflictAcrossJobKinds(t *testing.T) {
	engine := newAPIFakeEngine("media.mp4:200")
	mTor, err := torrent.New(torrent.Config{Engine: engine, Timeout: 20 * time.Second})
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
	// Cancel the torrent.
	first := mTor.Current()
	if first == nil {
		t.Fatal("torrent job missing")
	}
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+first.ID+"/cancel", allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("torrent cancel = %d, want 200", rec.Code)
	}
	// YouTube create after cancel succeeds.
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

func TestTorrentStreamingMIME(t *testing.T) {
	engine := newAPIFakeEngine("movie.mkv:800000|audio.mp3:40000")
	m, err := torrent.New(torrent.Config{Engine: engine, Timeout: 20 * time.Second})
	if err != nil {
		t.Fatalf("torrent.New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	s, err := New(Config{Torrents: m})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal, `{"magnet":"`+testMagnet+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d", rec.Code)
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	// Wait for buffering.
	deadline := time.Now().Add(5 * time.Second)
	for {
		rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "buffering" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("never listed")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// Select the MKV video.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select", allowedOriginLocal, `{"videoFileId":"f0"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("select = %d %s", rec.Code, rec.Body.String())
	}

	// Wait for complete.
	deadline = time.Now().Add(5 * time.Second)
	for {
		rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "complete" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("never completed")
		}
		time.Sleep(50 * time.Millisecond)
	}

	// MKV MIME type.
	req, _ := http.NewRequest(http.MethodGet, "http://example.test/v1/media/fixture?token="+s.token, nil)
	req.Header.Set("Origin", allowedOriginLocal)
	req.Header.Set("Range", "bytes=0-63")
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if ct := rec.Header().Get("Content-Type"); ct != "video/x-matroska" {
		t.Fatalf("MKV Content-Type = %q, want video/x-matroska", ct)
	}
}
