package torrent

import (
	"context"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testMagnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"

// --- fake Engine seam for deterministic manager tests ---

type fakeEngine struct {
	startDelay time.Duration
	files      []TorrentFile
	startErr   error
	h          *fakeHandle
}

func (e *fakeEngine) Start(ctx context.Context, magnet string) (TorrentHandle, error) {
	if e.startErr != nil {
		return nil, e.startErr
	}
	if e.startDelay > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(e.startDelay):
		}
	}
	h := &fakeHandle{
		name:  "test-torrent",
		files: e.files,
	}
	e.h = h
	return h, nil
}

func (e *fakeEngine) Close() error { return nil }

type fakeHandle struct {
	name      string
	files     []TorrentFile
	selected  int // -1 = none
	avail     atomic.Int64
	availMu   chan struct{} // closed to signal avail change
	closed    bool
	readerReq int64 // number of reader requests
	seekOff   int64

	bootStarted atomic.Bool // StartBootstrap called
	bootCancel  atomic.Bool // the bootstrap context was cancelled
	headPrio    atomic.Bool // Select elevated the head window (contract)
}

func newFakeHandle(files []TorrentFile) *fakeHandle {
	return &fakeHandle{
		name:     "test-torrent",
		files:    files,
		selected: -1,
	}
}

func (h *fakeHandle) Name() string         { return h.name }
func (h *fakeHandle) Files() []TorrentFile { return h.files }
func (h *fakeHandle) SelectedLength() int64 {
	if h.selected < 0 || h.selected >= len(h.files) {
		return 0
	}
	return h.files[h.selected].Length
}
func (h *fakeHandle) AvailablePrefix() int64 { return h.avail.Load() }
func (h *fakeHandle) Close() error           { h.closed = true; return nil }

func (h *fakeHandle) Select(videoFileID, subtitleFileID string) error {
	for i, f := range h.files {
		if f.ID == videoFileID {
			if f.Kind != KindVideo {
				return errInvalidSelection
			}
			h.selected = i
			// Contract: selection prioritizes the video's head window over
			// the rest of the file (the engine raises the first pieces to
			// High via Piece.SetPriority). Record the contract for the
			// manager-level tests.
			h.headPrio.Store(true)
			return nil
		}
	}
	return errInvalidSelection
}

// StartBootstrap records the demand request and watches the context: when
// the manager cancels the bootstrap (job end or completion) bootCancel
// flips, mirroring the engine's reader lifecycle.
func (h *fakeHandle) StartBootstrap(ctx context.Context) error {
	if h.selected < 0 {
		return errInvalidSelection
	}
	h.bootStarted.Store(true)
	go func() {
		<-ctx.Done()
		h.bootCancel.Store(true)
	}()
	return nil
}

func (h *fakeHandle) Reader(ctx context.Context) (io.ReadSeekCloser, error) {
	if h.selected < 0 {
		return nil, errInvalidSelection
	}
	h.readerReq++
	return &fakeReader{
		total: h.files[h.selected].Length,
		avail: &h.avail,
	}, nil
}

type fakeReader struct {
	total int64
	avail *atomic.Int64
	off   int64
}

func (r *fakeReader) Read(p []byte) (int, error) {
	end := r.off + int64(len(p))
	avail := r.avail.Load()
	if r.off >= r.total {
		return 0, io.EOF
	}
	if r.off >= avail {
		return 0, io.ErrNoProgress
	}
	if end > avail {
		end = avail
	}
	n := int(end - r.off)
	if n > len(p) {
		n = len(p)
	}
	// fill with deterministic content
	for i := 0; i < n; i++ {
		p[i] = byte((r.off + int64(i)) & 0xff)
	}
	r.off += int64(n)
	if r.off >= r.total {
		return n, io.EOF
	}
	return n, nil
}

func (r *fakeReader) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
		r.off = offset
	case io.SeekCurrent:
		r.off += offset
	case io.SeekEnd:
		r.off = r.total + offset
	default:
		return 0, errors.New("invalid whence")
	}
	if r.off < 0 {
		r.off = 0
		return 0, errors.New("negative position")
	}
	return r.off, nil
}

func (r *fakeReader) Close() error { return nil }

func buildFakeFiles(spec string) []TorrentFile {
	// spec: "name.mp4:2000|other.srt:300"
	var files []TorrentFile
	for i, part := range strings.Split(spec, "|") {
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
		files = append(files, TorrentFile{
			ID:     "f" + strconv.Itoa(i),
			Path:   name,
			Length: size,
			Kind:   classify(ext),
		})
	}
	return files
}

func newFakeEngine(filesSpec string) *fakeEngine {
	return &fakeEngine{files: buildFakeFiles(filesSpec)}
}

// --- tests ---

func TestNewRequiresEngine(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("New with nil engine must fail")
	}
}

func TestStartValidatesMagnet(t *testing.T) {
	m := newTestManager(t, 0)
	for _, bad := range []string{
		"http://example.com/file.torrent",
		"magnet:?xt=urn:btih:short",
		"not a magnet",
		"",
	} {
		if _, err := m.Start(bad); err == nil {
			t.Errorf("Start(%q) should fail validation", bad)
		}
	}
	if m.Current() != nil {
		t.Fatal("no job should exist after rejected starts")
	}
}

func TestConflictOneActiveJob(t *testing.T) {
	m := newTestManagerWithEngine(t, newFakeEngine("media.mp4:6000"), 0)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := m.Start(testMagnet); !errors.Is(err, ErrConflict) {
		t.Fatalf("second Start err = %v, want ErrConflict", err)
	}
	if _, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if _, err := m.Start(testMagnet); err != nil {
		t.Fatalf("Start after cancel: %v", err)
	}
}

func TestDownloadThenListingAndSelection(t *testing.T) {
	engine := newFakeEngine("Episode 01.mkv:200|Episode 01.ass:40|readme.txt:10")
	m := newTestManagerWithEngine(t, engine, 0)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := m.Files(snap.ID); err != nil && !errors.Is(err, ErrNotListed) {
		t.Fatalf("Files before listing = %v", err)
	}
	waitForState(t, m, snap.ID, StateBuffering, 5*time.Second)
	files, err := m.Files(snap.ID)
	if err != nil {
		t.Fatalf("Files: %v", err)
	}
	if len(files) != 3 {
		t.Fatalf("listing = %d files, want 3: %+v", len(files), files)
	}
	var videoID, subID string
	for _, f := range files {
		if f.Kind == KindVideo {
			videoID = f.ID
		}
		if f.Kind == KindSubtitle {
			subID = f.ID
		}
	}
	if videoID == "" || subID == "" {
		t.Fatalf("expected one video and one subtitle: %+v", files)
	}
	if _, err := m.Select(snap.ID, subID, ""); !errors.Is(err, ErrInvalidSelection) {
		t.Fatalf("selecting a subtitle as video err = %v, want ErrInvalidSelection", err)
	}
	if _, err := m.Select(snap.ID, "f99", ""); !errors.Is(err, ErrInvalidSelection) {
		t.Fatalf("unknown id err = %v, want ErrInvalidSelection", err)
	}
	sel, err := m.Select(snap.ID, videoID, subID)
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	if sel.SelectedVideoFile != videoID || !sel.HasEligibleVideo {
		t.Fatalf("selection snapshot wrong: %+v", sel)
	}
	// Simulate download completion.
	engine.h.avail.Store(engine.h.files[engine.h.selected].Length)
	waitForState(t, m, snap.ID, StateComplete, 5*time.Second)
	_, src := m.ActiveMedia()
	if src == nil {
		t.Fatal("selected media must be servable at complete")
	}
	buf := make([]byte, 200)
	n, err := src.ReadAt(buf, 0)
	if n != 200 {
		t.Fatalf("read selected media = %d bytes, want 200 (err=%v)", n, err)
	}
	// io.EOF is expected when reading to the exact end of the file.
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("read selected media unexpected error: %v", err)
	}
	_, _ = m.Cancel(snap.ID)
}

func TestNoEligibleVideoIsTerminalError(t *testing.T) {
	engine := newFakeEngine("readme.txt:10|song.mp3:50")
	m := newTestManagerWithEngine(t, engine, 0)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		cur := m.Get(snap.ID)
		if cur != nil && cur.State == StateError {
			if cur.Error != "no playable video" {
				t.Fatalf("error = %q, want 'no playable video'", cur.Error)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never errored; last=%+v", cur)
		}
		time.Sleep(30 * time.Millisecond)
	}
	if _, err := m.Files(snap.ID); !errors.Is(err, ErrNotListed) && !errors.Is(err, ErrNotFound) {
		t.Fatalf("Files after error = %v", err)
	}
}

func TestCancelFreesSession(t *testing.T) {
	engine := newFakeEngine("media.mp4:6000")
	m := newTestManagerWithEngine(t, engine, 0)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	got, err := m.Cancel(snap.ID)
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if got.State != StateCancelled {
		t.Fatalf("cancel state = %s, want cancelled", got.State)
	}
	if m.Current() != nil {
		t.Fatal("session must be free after cancel")
	}
	if !engine.h.closed {
		t.Fatal("handle must be closed after cancel")
	}
}

func TestTimeoutProducesErrorAndFreesSession(t *testing.T) {
	engine := &fakeEngine{
		startDelay: 200 * time.Millisecond,
		files:      buildFakeFiles("media.mp4:6000"),
	}
	m := newTestManagerWithEngine(t, engine, 100*time.Millisecond)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		cur := m.Get(snap.ID)
		if cur != nil && cur.State == StateError {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never errored; last=%+v", cur)
		}
		time.Sleep(30 * time.Millisecond)
	}
	if _, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel after timeout: %v", err)
	}
	if m.Current() != nil {
		t.Fatal("session must be free after cancel")
	}
}

func TestMagnetValidationPreservesTrackers(t *testing.T) {
	withTracker := testMagnet + "&tr=udp%3A%2F%2Ftracker.example%3A1337&tr=udp%3A%2F%2Fa.example%2Fannounce"
	m := newTestManagerWithEngine(t, newFakeEngine("media.mp4:100"), 0)
	snap, err := m.Start(withTracker)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if snap.State != StateQueued && snap.State != StateDownloading {
		t.Fatalf("unexpected initial state: %s", snap.State)
	}
	_, _ = m.Cancel(snap.ID)
}

func TestGetReturnsNilForUnknownID(t *testing.T) {
	m := newTestManagerWithEngine(t, newFakeEngine("media.mp4:100"), 0)
	if m.Get("nonexistent") != nil {
		t.Fatal("Get unknown ID should return nil")
	}
}

// TestRaceConcurrentSnapshotAndRun verifies that concurrent calls to
// Get/Current/ActiveMedia/SelectedMediaType do not race with the run()
// goroutine's state transitions and handle writes. This test must pass
// with `go test -race`.
func TestRaceConcurrentSnapshotAndRun(t *testing.T) {
	engine := newFakeEngine("video.mp4:5000|sub.srt:200")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	id := snap.ID

	// Wait for metadata to arrive so run() has written j.handle.
	waitForState(t, m, id, StateBuffering, 5*time.Second)

	// Select a video so the job transitions to streaming.
	if _, err := m.Select(id, "f0", "f1"); err != nil {
		t.Fatalf("Select: %v", err)
	}

	// Hammer all read paths from multiple goroutines while run() is
	// polling availability and may transition to complete.
	var wg sync.WaitGroup
	done := make(chan struct{})
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-done:
					return
				default:
				}
				_ = m.Get(id)
				_ = m.Current()
				_, _ = m.ActiveMedia()
				_ = m.SelectedMediaType()
				time.Sleep(time.Millisecond)
			}
		}()
	}

	// Simulate download completion.
	engine.h.avail.Store(engine.h.files[engine.h.selected].Length)
	waitForState(t, m, id, StateComplete, 5*time.Second)

	// Continue hammering for a bit after completion.
	time.Sleep(50 * time.Millisecond)
	close(done)
	wg.Wait()

	// Final read after completion.
	_, src := m.ActiveMedia()
	if src == nil {
		t.Fatal("ActiveMedia should return source after complete")
	}
	buf := make([]byte, 100)
	n, err := src.ReadAt(buf, 0)
	if n == 0 && err != nil {
		t.Fatalf("ReadAt after complete: n=%d err=%v", n, err)
	}

	_, _ = m.Cancel(id)
}

func TestFilesReturnsErrNotFoundForUnknownID(t *testing.T) {
	m := newTestManagerWithEngine(t, newFakeEngine("media.mp4:100"), 0)
	if _, err := m.Files("nonexistent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Files unknown ID = %v, want ErrNotFound", err)
	}
}

func TestSelectReturnsErrNotFoundForUnknownID(t *testing.T) {
	m := newTestManagerWithEngine(t, newFakeEngine("media.mp4:100"), 0)
	if _, err := m.Select("nonexistent", "f0", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Select unknown ID = %v, want ErrNotFound", err)
	}
}

// TestStreamingReturnsSource verifies that ActiveMedia returns a servable
// source during the streaming state (not only at complete). This is the
// foundation for progressive playback.
func TestStreamingReturnsSource(t *testing.T) {
	engine := newFakeEngine("media.mp4:5000|sub.srt:200")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	id := snap.ID
	waitForState(t, m, id, StateBuffering, 5*time.Second)

	// Select the video to transition to streaming.
	if _, err := m.Select(id, "f0", "f1"); err != nil {
		t.Fatalf("Select: %v", err)
	}
	waitForState(t, m, id, StateStreaming, 5*time.Second)

	// During streaming, ActiveMedia must return a non-nil source.
	streamSnap, src := m.ActiveMedia()
	if src == nil {
		t.Fatal("ActiveMedia must return a source during streaming")
	}
	if streamSnap.State != StateStreaming {
		t.Fatalf("snapshot state = %s, want streaming", streamSnap.State)
	}
	// Source must report correct total.
	if src.Total() != 5000 {
		t.Fatalf("source.Total() = %d, want 5000", src.Total())
	}

	_, _ = m.Cancel(id)
}

// TestStreamingSourceReportsAvailablePrefix verifies the streaming source's
// Available() reflects the engine's AvailablePrefix (grows over time).
func TestStreamingSourceReportsAvailablePrefix(t *testing.T) {
	engine := newFakeEngine("media.mp4:5000")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	id := snap.ID
	waitForState(t, m, id, StateBuffering, 5*time.Second)

	if _, err := m.Select(id, "f0", ""); err != nil {
		t.Fatalf("Select: %v", err)
	}
	waitForState(t, m, id, StateStreaming, 5*time.Second)

	// Simulate some prefix being available.
	engine.h.avail.Store(2000)
	time.Sleep(300 * time.Millisecond) // let the poll goroutine tick

	_, src := m.ActiveMedia()
	if src == nil {
		t.Fatal("source must exist during streaming")
	}
	avail := src.Available()
	if avail != 2000 {
		t.Fatalf("source.Available() = %d, want 2000", avail)
	}

	// Advance to full.
	engine.h.avail.Store(5000)
	time.Sleep(300 * time.Millisecond)
	waitForState(t, m, id, StateComplete, 5*time.Second)

	_, src2 := m.ActiveMedia()
	if src2 == nil {
		t.Fatal("source must exist at complete")
	}
	if src2.Available() != 5000 {
		t.Fatalf("source.Available() at complete = %d, want 5000", src2.Available())
	}

	_, _ = m.Cancel(id)
}

// TestManagerAvailablePrefix exposes the new AvailablePrefix method.
func TestManagerAvailablePrefix(t *testing.T) {
	engine := newFakeEngine("media.mp4:5000")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)
	if got := m.AvailablePrefix(); got != 0 {
		t.Fatalf("AvailablePrefix before start = %d, want 0", got)
	}
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitForState(t, m, snap.ID, StateBuffering, 5*time.Second)
	if _, err := m.Select(snap.ID, "f0", ""); err != nil {
		t.Fatalf("Select: %v", err)
	}
	waitForState(t, m, snap.ID, StateStreaming, 5*time.Second)

	engine.h.avail.Store(3000)
	time.Sleep(300 * time.Millisecond)
	if got := m.AvailablePrefix(); got != 3000 {
		t.Fatalf("AvailablePrefix = %d, want 3000", got)
	}

	_, _ = m.Cancel(snap.ID)
}

// TestBootstrapPieceCount verifies the pure head-window derivation: the
// bounded piece count covering the bootstrap window, rounded up, clamped to
// the file's pieces — never an arbitrary raw byte threshold.
func TestBootstrapPieceCount(t *testing.T) {
	cases := []struct {
		window, piece int64
		available     int
		want          int
	}{
		{4 << 20, 1 << 20, 10, 4}, // exactly four pieces
		{4 << 20, 1 << 20, 3, 3},  // clamped to the file
		{1, 1 << 20, 10, 1},       // rounds up
		{4 << 20, 2 << 20, 10, 2}, // half the window per piece
		{0, 1 << 20, 10, 0},       // degenerate window
		{4 << 20, 0, 10, 0},       // degenerate piece length
		{4 << 20, 1 << 20, 0, 0},  // empty file
		{4 << 20, 3 << 20, 2, 2},  // 4MiB window over 3MiB pieces → 2
	}
	for _, c := range cases {
		if got := bootstrapPieceCount(c.window, c.piece, c.available); got != c.want {
			t.Errorf("bootstrapPieceCount(%d, %d, %d) = %d, want %d",
				c.window, c.piece, c.available, got, c.want)
		}
	}
}

// TestSelectionPrioritizesHeadWindowAndStartsBootstrap verifies the
// selection contract end to end: Select elevates the video's head window
// and the streaming state starts the dedicated bootstrap reader so the
// first piece is demand-prioritized before any HTTP range request.
func TestSelectionPrioritizesHeadWindowAndStartsBootstrap(t *testing.T) {
	engine := newFakeEngine("video.mp4:5000|sub.srt:200")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	id := snap.ID
	waitForState(t, m, id, StateBuffering, 5*time.Second)

	if _, err := m.Select(id, "f0", "f1"); err != nil {
		t.Fatalf("Select: %v", err)
	}
	waitForState(t, m, id, StateStreaming, 5*time.Second)

	if !engine.h.headPrio.Load() {
		t.Fatal("Select must prioritize the selected video's head window")
	}
	if !engine.h.bootStarted.Load() {
		t.Fatal("streaming must start the head bootstrap reader")
	}

	_, _ = m.Cancel(id)
}

// TestCancelCancelsBootstrapAndClosesHandle verifies the bootstrap reader
// lifecycle: cancelling the job cancels the bootstrap context (the engine
// reader is closed) and drops the handle.
func TestCancelCancelsBootstrapAndClosesHandle(t *testing.T) {
	engine := newFakeEngine("video.mp4:5000")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	id := snap.ID
	waitForState(t, m, id, StateBuffering, 5*time.Second)
	if _, err := m.Select(id, "f0", ""); err != nil {
		t.Fatalf("Select: %v", err)
	}
	waitForState(t, m, id, StateStreaming, 5*time.Second)
	if !engine.h.bootStarted.Load() {
		t.Fatal("bootstrap must be started at streaming")
	}

	if _, err := m.Cancel(id); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !engine.h.bootCancel.Load() {
		if time.Now().After(deadline) {
			t.Fatal("bootstrap context must be cancelled on job cancel")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !engine.h.closed {
		t.Fatal("handle must be closed after cancel")
	}
}

// TestCompleteCancelsBootstrap verifies the bootstrap reader ends when the
// download completes (head demand is moot; no reader leak).
func TestCompleteCancelsBootstrap(t *testing.T) {
	engine := newFakeEngine("video.mp4:5000")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	id := snap.ID
	waitForState(t, m, id, StateBuffering, 5*time.Second)
	if _, err := m.Select(id, "f0", ""); err != nil {
		t.Fatalf("Select: %v", err)
	}
	waitForState(t, m, id, StateStreaming, 5*time.Second)

	engine.h.avail.Store(5000)
	waitForState(t, m, id, StateComplete, 5*time.Second)

	deadline := time.Now().Add(5 * time.Second)
	for !engine.h.bootCancel.Load() {
		if time.Now().After(deadline) {
			t.Fatal("bootstrap must be cancelled when the download completes")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if engine.h.closed {
		t.Fatal("handle must stay open at complete (media remains servable)")
	}

	_, _ = m.Cancel(id)
}

// --- helpers ---

func newTestManagerWithEngine(t *testing.T, engine Engine, timeout time.Duration) *Manager {
	t.Helper()
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	m, err := New(Config{Engine: engine, Timeout: timeout})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m
}

func newTestManager(t *testing.T, timeout time.Duration) *Manager {
	t.Helper()
	return newTestManagerWithEngine(t, newFakeEngine("media.mp4:100"), timeout)
}

func waitForState(t *testing.T, m *Manager, id string, want State, timeout time.Duration) Snapshot {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		snap := m.Get(id)
		if snap != nil && snap.State == want {
			return *snap
		}
		if snap != nil && (snap.State == StateError || snap.State == StateCancelled) {
			t.Fatalf("job reached %s, want %s (%v)", snap.State, want, snap.Error)
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s; last=%+v", want, snap)
		}
		time.Sleep(30 * time.Millisecond)
	}
}
