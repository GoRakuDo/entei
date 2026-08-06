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
	"sync"
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
	mu    sync.Mutex
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
	e.mu.Lock()
	e.h = h
	e.mu.Unlock()
	return h, nil
}

func (e *apiFakeEngine) Close() error { return nil }

type apiFakeHandle struct {
	files       []torrent.TorrentFile
	selected    int
	subtitleIdx int
	avail       atomic.Int64
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

func (h *apiFakeHandle) Select(videoFileID, subtitleFileID string) error {
	for i, f := range h.files {
		if f.ID == videoFileID {
			if f.Kind != torrent.KindVideo {
				return errors.New("not a video")
			}
			h.selected = i
			h.subtitleIdx = -1
			if subtitleFileID != "" {
				for j, sf := range h.files {
					if sf.ID == subtitleFileID {
						h.subtitleIdx = j
						break
					}
				}
			}
			return nil
		}
	}
	return errors.New("invalid selection")
}

// SubtitleContent returns the subtitle file content as text.
func (h *apiFakeHandle) SubtitleContent(_ context.Context) (string, error) {
	if h.subtitleIdx < 0 || h.subtitleIdx >= len(h.files) {
		return "", errors.New("subtitle not selected")
	}
	// Return deterministic content based on the file's extension.
	ext := ""
	base := h.files[h.subtitleIdx].Path
	if idx := strings.LastIndexByte(base, '.'); idx >= 0 {
		ext = base[idx+1:]
	}
	switch ext {
	case "srt":
		return "1\n00:00:01,000 --> 00:00:02,000\nHello world\n\n", nil
	case "vtt":
		return "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello world\n", nil
	case "ass":
		return "[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:01.000,0:00:02.000,,Hello world\n", nil
	default:
		return "subtitle content", nil
	}
}

func (h *apiFakeHandle) Reader(_ context.Context) (io.ReadSeekCloser, error) {
	if h.selected < 0 {
		return nil, errors.New("no selection")
	}
	return &apiFakeReader{
		data:  []byte(strings.Repeat("x", int(h.files[h.selected].Length))),
		avail: &h.avail,
	}, nil
}

func (h *apiFakeHandle) HTTPReader(ctx context.Context) (io.ReadSeekCloser, error) {
	return h.Reader(ctx)
}

func (h *apiFakeHandle) StartBootstrap(_ context.Context) error {
	if h.selected < 0 {
		return errors.New("no selection")
	}
	return nil
}

type apiFakeReader struct {
	data  []byte
	avail *atomic.Int64
	off   int64
}

func (r *apiFakeReader) Read(p []byte) (int, error) {
	if r.off >= int64(len(r.data)) {
		return 0, io.EOF
	}
	// Enforce availability: cannot read beyond the verified prefix.
	avail := r.avail.Load()
	if r.off >= avail {
		return 0, io.ErrNoProgress
	}
	end := r.off + int64(len(p))
	if end > avail {
		end = avail
	}
	n := copy(p, r.data[r.off:end])
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

// trackedEngines records each engine created by the factory, so tests can
// control per-session availability (avail.Store()) for eviction tests.
type trackedEngines struct {
	mu      sync.Mutex
	engines []*apiFakeEngine
}

func (t *trackedEngines) factory(spec string) func(_ string) (torrent.Engine, error) {
	return func(_ string) (torrent.Engine, error) {
		eng := newAPIFakeEngine(spec)
		t.mu.Lock()
		t.engines = append(t.engines, eng)
		t.mu.Unlock()
		return eng, nil
	}
}

func (t *trackedEngines) last() *apiFakeEngine {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.engines) == 0 {
		return nil
	}
	return t.engines[len(t.engines)-1]
}

func (t *trackedEngines) byIndex(i int) *apiFakeEngine {
	t.mu.Lock()
	defer t.mu.Unlock()
	if i < 0 || i >= len(t.engines) {
		return nil
	}
	return t.engines[i]
}

func newTorrentsServer(t *testing.T) (*Server, *torrent.Manager, *trackedEngines) {
	t.Helper()
	tracked := &trackedEngines{}
	m, err := torrent.New(torrent.Config{
		EngineFactory: tracked.factory("Episode 01.mkv:200|Episode 01.ass:40|readme.txt:10"),
		Timeout:       20 * time.Second,
	})
	if err != nil {
		t.Fatalf("torrent.New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	s, err := New(Config{Torrents: m})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s, m, tracked
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
	s, _, _ := newTorrentsServer(t)
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
	s, _, _ := newTorrentsServer(t)
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
	s, _, _ := newTorrentsServer(t)
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
	s, _, tracked := newTorrentsServer(t)

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

	// Simulate download completion (the fake engine no longer auto-sets
	// avail in Reader; tests that need completion must set it explicitly).
	tracked.last().h.avail.Store(tracked.last().files[tracked.last().h.selected].Length)

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

// TestCancelThenRecreateSameMagnet is the backend half of the MagnetInput
// re-open sequence (file picker → "Kembali"/close → same-magnet retry): once
// the companion has acknowledged a cancel, the session is fully released, so
// a NEW POST with the SAME magnet creates a FRESH job (201, different id)
// that re-fetches metadata (buffering + files) instead of returning 409.
func TestCancelThenRecreateSameMagnet(t *testing.T) {
	s, _, _ := newTorrentsServer(t)
	create := func() string {
		t.Helper()
		rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
			`{"magnet":"`+testMagnet+`"}`)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create = %d, want 201 (%s)", rec.Code, rec.Body.String())
		}
		var created struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &created)
		if created.ID == "" {
			t.Fatal("create body must carry an opaque id")
		}
		return created.ID
	}
	waitBuffering := func(id string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			rec := doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+id, allowedOriginLocal, "")
			if rec.Code != http.StatusOK {
				t.Fatalf("read %s = %d, want 200", id, rec.Code)
			}
			var snap struct {
				State string `json:"state"`
			}
			_ = json.Unmarshal(rec.Body.Bytes(), &snap)
			if snap.State == "buffering" {
				return
			}
			if snap.State == "error" {
				t.Fatalf("job %s errored: %s", id, rec.Body.String())
			}
			if time.Now().After(deadline) {
				t.Fatalf("job %s never reached buffering (last=%s)", id, snap.State)
			}
			time.Sleep(30 * time.Millisecond)
		}
	}

	first := create()
	waitBuffering(first)

	// The frontend's "Kembali" / top-right close waits for the cancel
	// settlement: the companion frees the session before any retry POST.
	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+first+"/cancel", allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	// After the cancel response the session is released: a fresh create with
	// the SAME magnet must be a NEW job (201, different id) — never a 409.
	second := create()
	if second == first {
		t.Fatalf("recreate returned the same id %q; want a fresh job", second)
	}
	// The fresh job re-fetches metadata (file-picker state again).
	waitBuffering(second)
	rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+second+"/files", allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("files after recreate = %d, want 200", rec.Code)
	}
	doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+second+"/cancel", allowedOriginLocal, "")
}

func TestTorrentStatusBufferingBeforeSelection(t *testing.T) {
	s, _, _ := newTorrentsServer(t)
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

	// Start a torrent job.
	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("torrent create = %d, want 201", rec.Code)
	}
	// Second torrent create succeeds (2 concurrent allowed).
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("second torrent create = %d, want 201", rec.Code)
	}
	// YouTube create while torrents are active → 409.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("youtube create during torrent = %d, want 409", rec.Code)
	}
	// Third torrent create triggers eviction but still succeeds (201).
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("third torrent create = %d, want 201 (eviction)", rec.Code)
	}
	// Cancel all remaining sessions.
	sessions := mTor.Current()
	if sessions != nil {
		rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+sessions.ID+"/cancel", allowedOriginLocal, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("torrent cancel = %d, want 200", rec.Code)
		}
	}
	sessions = mTor.Current()
	if sessions != nil {
		rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+sessions.ID+"/cancel", allowedOriginLocal, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("torrent cancel = %d, want 200", rec.Code)
		}
	}
	sessions = mTor.Current()
	if sessions != nil {
		rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+sessions.ID+"/cancel", allowedOriginLocal, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("torrent cancel = %d, want 200", rec.Code)
		}
	}
	// YouTube create after all torrents cancelled succeeds.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/jobs", allowedOriginLocal,
		`{"url":"https://www.youtube.com/watch?v=abcdefghijk"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("youtube create after torrent cancel = %d, want 201", rec.Code)
	}
	// Clean up the YouTube job.
	jobs := mJob.Current()
	if jobs != nil {
		rec = doTorrent(t, s, http.MethodPost, "/v1/source/jobs/"+jobs.ID+"/cancel", allowedOriginLocal, "")
		_ = rec
	}
}

func TestTorrentPreflight(t *testing.T) {
	s, _, _ := newTorrentsServer(t)
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
	factory := func(_ string) (torrent.Engine, error) { return engine, nil }
	m, err := torrent.New(torrent.Config{EngineFactory: factory, Timeout: 20 * time.Second})
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

	// Simulate download completion.
	engine.h.avail.Store(engine.h.files[engine.h.selected].Length)

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

// TestTorrentFilesReturnsFileInfo verifies the /files endpoint returns
// FileInfo (basename/extension/byteSize) not raw TorrentFile (path/length).
// This is the fix for the "video · 0 B" rendering in the MagnetInput dialog.
func TestTorrentFilesReturnsFileInfo(t *testing.T) {
	s, _, _ := newTorrentsServer(t)

	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
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
			ID        string `json:"id"`
			Basename  string `json:"basename"`
			Extension string `json:"extension"`
			ByteSize  int64  `json:"byteSize"`
			Kind      string `json:"kind"`
		} `json:"files"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &listing)
	if len(listing.Files) != 3 {
		t.Fatalf("listing = %d files, want 3", len(listing.Files))
	}

	// Verify the first file (Episode 01.mkv) has correct FileInfo fields.
	f := listing.Files[0]
	if f.Basename != "Episode 01.mkv" {
		t.Errorf("basename = %q, want 'Episode 01.mkv'", f.Basename)
	}
	if f.Extension != "mkv" {
		t.Errorf("extension = %q, want 'mkv'", f.Extension)
	}
	if f.ByteSize != 200 {
		t.Errorf("byteSize = %d, want 200", f.ByteSize)
	}
	if f.Kind != "video" {
		t.Errorf("kind = %q, want 'video'", f.Kind)
	}

	// Verify raw path/length fields are NOT present.
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(rec.Body.Bytes(), &raw)
	if filesRaw, ok := raw["files"]; ok {
		var filesArr []map[string]json.RawMessage
		_ = json.Unmarshal(filesRaw, &filesArr)
		if len(filesArr) > 0 {
			if _, hasPath := filesArr[0]["path"]; hasPath {
				t.Error("response must not contain raw 'path' field")
			}
			if _, hasLength := filesArr[0]["length"]; hasLength {
				t.Error("response must not contain raw 'length' field")
			}
		}
	}

	doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/cancel", allowedOriginLocal, "")
}

// TestTorrentStatusStreamingPlayable verifies the /v1/media/status endpoint
// returns "playable" (not "buffering") when a torrent is in the streaming
// state with a verified prefix. This is the fix for the bridge stuck at
// "Menunggu file selesai…".
func TestTorrentStatusStreamingPlayable(t *testing.T) {
	engine := newAPIFakeEngine("movie.mp4:800000")
	factory := func(_ string) (torrent.Engine, error) { return engine, nil }
	m, err := torrent.New(torrent.Config{EngineFactory: factory, Timeout: 20 * time.Second})
	if err != nil {
		t.Fatalf("torrent.New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	s, err := New(Config{Torrents: m})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Create a torrent job.
	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
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
			t.Fatal("never reached buffering")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// Verify status is "buffering" before selection.
	rec = doStatus(t, s.Handler(), s.token, http.MethodGet)
	b := decodeStatus(t, rec, s)
	if b.State != "buffering" {
		t.Fatalf("status before selection = %q, want buffering", b.State)
	}

	// Select the video.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select", allowedOriginLocal,
		`{"videoFileId":"f0"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("select = %d %s", rec.Code, rec.Body.String())
	}

	// Wait for streaming state.
	deadline = time.Now().Add(5 * time.Second)
	for {
		rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "streaming" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("never reached streaming")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// Initially streaming with 0 prefix → status should be "buffering".
	rec = doStatus(t, s.Handler(), s.token, http.MethodGet)
	b = decodeStatus(t, rec, s)
	if b.State != "buffering" {
		t.Fatalf("status streaming with 0 prefix = %q, want buffering", b.State)
	}

	// Simulate prefix becoming available.
	engine.h.avail.Store(200_000)
	time.Sleep(300 * time.Millisecond) // let poll tick

	// Now status should be "playable".
	rec = doStatus(t, s.Handler(), s.token, http.MethodGet)
	b = decodeStatus(t, rec, s)
	if b.State != "playable" {
		t.Fatalf("status streaming with prefix = %q, want playable", b.State)
	}
	if b.Available != 200_000 {
		t.Errorf("available = %d, want 200000", b.Available)
	}
	if b.Total != 800_000 {
		t.Errorf("total = %d, want 800000", b.Total)
	}

	// Advance to complete.
	engine.h.avail.Store(800_000)
	time.Sleep(300 * time.Millisecond)
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
			t.Fatal("never reached complete")
		}
		time.Sleep(50 * time.Millisecond)
	}

	rec = doStatus(t, s.Handler(), s.token, http.MethodGet)
	b = decodeStatus(t, rec, s)
	if b.State != "complete" {
		t.Fatalf("status at complete = %q, want complete", b.State)
	}

	doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/cancel", allowedOriginLocal, "")
}

// TestTorrentMediaStreamingServesVerifiedPrefix verifies the media endpoint
// serves 206 for ranges whose start lies within the verified prefix during
// the streaming state, using the custom Range response (same contract as
// serveGrowingSource). The anacrolix Reader is used as an io.ReadSeeker:
// Seek(start) then io.CopyN. The fake test reader returns io.ErrNoProgress
// instead of blocking, so body length assertions reflect test-only behavior
// (the real Reader streams the full range).
func TestTorrentMediaStreamingServesVerifiedPrefix(t *testing.T) {
	engine := newAPIFakeEngine("movie.mp4:800000")
	factory := func(_ string) (torrent.Engine, error) { return engine, nil }
	m, err := torrent.New(torrent.Config{EngineFactory: factory, Timeout: 20 * time.Second})
	if err != nil {
		t.Fatalf("torrent.New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	s, err := New(Config{Torrents: m})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Create, wait for buffering, select.
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

	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select", allowedOriginLocal,
		`{"videoFileId":"f0"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("select = %d", rec.Code)
	}

	// Wait for streaming.
	deadline = time.Now().Add(5 * time.Second)
	for {
		rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "streaming" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("never reached streaming")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// Set prefix to 200_000.
	engine.h.avail.Store(200_000)
	time.Sleep(100 * time.Millisecond)

	// Range within prefix → 206 with correct Content-Type.
	req, _ := http.NewRequest(http.MethodGet, "http://example.test/v1/media/fixture?token="+s.token, nil)
	req.Header.Set("Origin", allowedOriginLocal)
	req.Header.Set("Range", "bytes=0-99999")
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("range within prefix = %d, want 206", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "video/mp4" {
		t.Errorf("Content-Type = %q, want video/mp4", ct)
	}

	// No Range while streaming with partial data → 503 buffering.
	// The streaming Range handler mirrors the growing source contract:
	// no Range + avail < total → 503 with Retry-After.
	req, _ = http.NewRequest(http.MethodGet, "http://example.test/v1/media/fixture?token="+s.token, nil)
	req.Header.Set("Origin", allowedOriginLocal)
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("no range, streaming = %d, want 503", rec.Code)
	}

	// HEAD mirrors status/headers without body — also 503 when no Range
	// and data is partial (same contract as GET).
	req, _ = http.NewRequest(http.MethodHead, "http://example.test/v1/media/fixture?token="+s.token, nil)
	req.Header.Set("Origin", allowedOriginLocal)
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("HEAD streaming = %d, want 503", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD streaming body = %d, want 0", rec.Body.Len())
	}

	doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/cancel", allowedOriginLocal, "")
}

// TestTorrentSubtitleContentAfterSelection verifies that GET
// /v1/source/torrents/{id}/subtitle returns the subtitle text content
// after a video+subtitle selection.
func TestTorrentSubtitleContentAfterSelection(t *testing.T) {
	s, _, tracked := newTorrentsServer(t)

	// Create a torrent job.
	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
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
			t.Fatal("never reached buffering")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// Before selection, subtitle endpoint returns 404.
	rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID+"/subtitle", allowedOriginLocal, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("subtitle before selection = %d, want 404", rec.Code)
	}

	// Select video + subtitle.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select", allowedOriginLocal,
		`{"videoFileId":"f0","subtitleFileId":"f1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("select = %d, want 200", rec.Code)
	}

	// Simulate download completion so the handle is available.
	tracked.last().h.avail.Store(tracked.last().files[tracked.last().h.selected].Length)

	// Wait for streaming or complete.
	deadline = time.Now().Add(5 * time.Second)
	for {
		rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "streaming" || js.State == "complete" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never reached streaming/complete; last=%s", js.State)
		}
		time.Sleep(30 * time.Millisecond)
	}

	// Subtitle endpoint returns the content.
	rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID+"/subtitle", allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("subtitle = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Errorf("Content-Type = %q, want text/plain; charset=utf-8", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	body := rec.Body.String()
	if len(body) == 0 {
		t.Fatal("subtitle body is empty")
	}
	// The fake returns format-specific content based on the file extension.
	if !strings.Contains(body, "Hello world") {
		t.Errorf("subtitle body = %q, want 'Hello world'", body)
	}

	// POST is not allowed.
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/subtitle", allowedOriginLocal, "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST subtitle = %d, want 405", rec.Code)
	}

	// Origin gate: no origin → 403.
	req := httptest.NewRequest(http.MethodGet,
		"/v1/source/torrents/"+created.ID+"/subtitle?token="+s.token, nil)
	rec2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec2, req)
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("no origin = %d, want 403", rec2.Code)
	}

	// Token gate: invalid token → 401.
	req = httptest.NewRequest(http.MethodGet,
		"/v1/source/torrents/"+created.ID+"/subtitle?token=deadbeef", nil)
	req.Header.Set("Origin", allowedOriginLocal)
	rec3 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec3, req)
	if rec3.Code != http.StatusUnauthorized {
		t.Fatalf("invalid token = %d, want 401", rec3.Code)
	}

	doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/cancel", allowedOriginLocal, "")
}

// TestTorrentSubtitleContentNotFoundWithoutSubtitle verifies that GET
// /v1/source/torrents/{id}/subtitle returns 404 when only a video is
// selected (no subtitle).
func TestTorrentSubtitleContentNotFoundWithoutSubtitle(t *testing.T) {
	s, _, tracked := newTorrentsServer(t)

	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
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
			t.Fatal("never reached buffering")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// Select video only (no subtitle).
	rec = doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select", allowedOriginLocal,
		`{"videoFileId":"f0"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("select = %d, want 200", rec.Code)
	}

	// Simulate download.
	tracked.last().h.avail.Store(tracked.last().files[tracked.last().h.selected].Length)
	deadline = time.Now().Add(5 * time.Second)
	for {
		rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "streaming" || js.State == "complete" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("never reached streaming/complete")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// Subtitle endpoint returns 404 when no subtitle is selected.
	rec = doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+created.ID+"/subtitle", allowedOriginLocal, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("subtitle without selection = %d, want 404", rec.Code)
	}

	doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/cancel", allowedOriginLocal, "")
}

// TestTorrentSubtitleNotFoundForUnknownID verifies that GET
// /v1/source/torrents/{id}/subtitle returns 404 for an unknown job id.
func TestTorrentSubtitleNotFoundForUnknownID(t *testing.T) {
	s, _, _ := newTorrentsServer(t)
	rec := doTorrent(t, s, http.MethodGet, "/v1/source/torrents/nonexistent/subtitle", allowedOriginLocal, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("subtitle unknown id = %d, want 404", rec.Code)
	}
}

// TestTorrentSubtitleWrongMethod verifies that non-GET methods on
// /v1/source/torrents/{id}/subtitle return 405.
func TestTorrentSubtitleWrongMethod(t *testing.T) {
	s, _, _ := newTorrentsServer(t)
	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents/x/subtitle", allowedOriginLocal, "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST subtitle = %d, want 405", rec.Code)
	}
}
