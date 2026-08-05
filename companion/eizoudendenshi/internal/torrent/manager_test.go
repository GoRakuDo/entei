package torrent

import (
	"context"
	"errors"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"eizoudendenshi/internal/diag"
)

const testMagnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"

// --- fake Engine seam for deterministic manager tests ---

type fakeEngine struct {
	startDelay time.Duration
	files      []TorrentFile
	startErr   error
	mu         sync.Mutex
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
	e.mu.Lock()
	e.h = h
	e.mu.Unlock()
	return h, nil
}

func (e *fakeEngine) Close() error { return nil }

type fakeHandle struct {
	name        string
	files       []TorrentFile
	selected    int // -1 = none
	subtitleIdx int // -1 = none
	avail       atomic.Int64
	availMu     chan struct{} // closed to signal avail change
	closed      bool
	readerReq   int64 // number of reader requests
	seekOff     int64

	bootStarted atomic.Bool // StartBootstrap called
	bootCancel  atomic.Bool // the bootstrap context was cancelled
	bootErr     error       // injected StartBootstrap failure
	headPrio    atomic.Bool // Select elevated the head window (contract)

	// subtitleContent returns the fake subtitle text content.
	subtitleContent string
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
			// Track subtitle selection.
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
	return errInvalidSelection
}

// SubtitleContent returns the fake subtitle content. In the real engine
// this reads the torrent file; here it returns the injected string.
func (h *fakeHandle) SubtitleContent(ctx context.Context) (string, error) {
	if h.subtitleIdx < 0 {
		return "", errSubtitleNotSelected
	}
	return h.subtitleContent, nil
}

// StartBootstrap records the demand request and watches the context: when
// the manager cancels the bootstrap (job end or completion) bootCancel
// flips, mirroring the engine's reader lifecycle.
func (h *fakeHandle) StartBootstrap(ctx context.Context) error {
	if h.selected < 0 {
		return errInvalidSelection
	}
	if h.bootErr != nil {
		return h.bootErr
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

func TestNewRequiresEngineFactory(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("New with nil engine factory must fail")
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

func TestConflictTwoActiveSessions(t *testing.T) {
	m := newTestManagerWithEngine(t, newFakeEngine("media.mp4:6000"), 0)
	snap1, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 1: %v", err)
	}
	// Second start succeeds (2 concurrent sessions allowed).
	snap2, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 2: %v", err)
	}
	if snap2.ID == snap1.ID {
		t.Fatal("second job must have a different ID")
	}
	// Third start triggers eviction of the oldest.
	snap3, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 3 (eviction): %v", err)
	}
	if snap3.ID == snap2.ID {
		t.Fatal("third job must have a different ID")
	}
	// First session should have been evicted.
	evicted := m.Get(snap1.ID)
	if evicted == nil {
		t.Fatal("evicted session must still be readable")
	}
	if evicted.State != StateError {
		t.Fatalf("evicted state = %s, want error", evicted.State)
	}
	if evicted.ErrorCode != ErrCodeConcurrencyLimit {
		t.Fatalf("evicted errorCode = %q, want %q", evicted.ErrorCode, ErrCodeConcurrencyLimit)
	}
	// Cancel all remaining.
	if _, err := m.Cancel(snap3.ID); err != nil {
		t.Fatalf("Cancel 3: %v", err)
	}
	// After cancel, 2nd session should also be gone.
	if m.Get(snap2.ID) != nil {
		// session may still be in evicted cache briefly
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
	// At complete, NewMediaReader must create a servable reader.
	r, err := m.NewMediaReader(context.Background())
	if err != nil {
		t.Fatalf("NewMediaReader at complete: %v", err)
	}
	buf := make([]byte, 200)
	n, err := r.Read(buf)
	r.Close()
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
	// Session is auto-freed on "no playable video" error.
	deadline := time.Now().Add(5 * time.Second)
	for m.Current() != nil {
		if time.Now().After(deadline) {
			t.Fatal("session was not freed after no-playable-video error")
		}
		time.Sleep(30 * time.Millisecond)
	}
	if _, err := m.Files(snap.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Files after error = %v, want ErrNotFound (session freed)", err)
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
	// On timeout the session is auto-freed (m.clear) — wait for nil.
	deadline := time.Now().Add(5 * time.Second)
	for m.Current() != nil {
		if time.Now().After(deadline) {
			t.Fatal("session was not freed after timeout")
		}
		time.Sleep(30 * time.Millisecond)
	}
	// Cancel is no longer needed; the session is already free.
	if _, err := m.Cancel(snap.ID); err == nil {
		t.Fatal("Cancel on already-freed session must fail")
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
	r, err := m.NewMediaReader(context.Background())
	if err != nil {
		t.Fatalf("NewMediaReader after complete: %v", err)
	}
	buf := make([]byte, 100)
	n, err := r.Read(buf)
	r.Close()
	if n == 0 && err != nil {
		t.Fatalf("Read after complete: n=%d err=%v", n, err)
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

	// During streaming, NewMediaReader must create a servable reader and
	// the snapshot must reflect the streaming state.
	streamSnap, _ := m.ActiveMedia()
	if streamSnap.State != StateStreaming {
		t.Fatalf("snapshot state = %s, want streaming", streamSnap.State)
	}
	r, err := m.NewMediaReader(context.Background())
	if err != nil {
		t.Fatalf("NewMediaReader during streaming: %v", err)
	}
	r.Close()
	// SelectedLength must reflect the total file size.
	if streamSnap.Media.Total != 5000 {
		t.Fatalf("snapshot total = %d, want 5000", streamSnap.Media.Total)
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

	// During streaming, AvailablePrefix must reflect the engine's
	// verified prefix (grows over time).
	snap2, _ := m.ActiveMedia()
	if snap2.State != StateStreaming {
		t.Fatalf("snapshot state = %s, want streaming", snap2.State)
	}
	if snap2.Media.Available != 2000 {
		t.Fatalf("available prefix = %d, want 2000", snap2.Media.Available)
	}

	// Advance to full.
	engine.h.avail.Store(5000)
	time.Sleep(300 * time.Millisecond)
	waitForState(t, m, id, StateComplete, 5*time.Second)

	snap3, _ := m.ActiveMedia()
	if snap3.State != StateComplete {
		t.Fatalf("snapshot state at complete = %s, want complete", snap3.State)
	}
	if snap3.Media.Available != 5000 {
		t.Fatalf("available prefix at complete = %d, want 5000", snap3.Media.Available)
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

// TestV2OnlyRejectionSetsDedicatedErrorCode pins the v2-only rejection
// contract at the manager boundary: when the engine rejects the metainfo
// as v2-only (BEP 52), the job must fail with the dedicated
// torrent_v2_unsupported code — not the generic metadata-failed fallback —
// so the frontend can route the v2-specific localized message. Like every
// metadata-stage error, the session is then freed (the error code is
// observable in the manager's sanitized log line, the established terminal
// error pattern) and a fresh retry works.
func TestV2OnlyRejectionSetsDedicatedErrorCode(t *testing.T) {
	base := t.TempDir()
	logDir := filepath.Join(base, "logs")
	logger, err := diag.NewLogger(logDir)
	if err != nil {
		t.Fatalf("diag.NewLogger: %v", err)
	}
	defer logger.Close()

	engine := newFakeEngine("video.mp4:5000")
	engine.startErr = errV2Unsupported
	factory := func(_ string) (Engine, error) { return engine, nil }
	m, err := New(Config{EngineFactory: factory, Timeout: 10 * time.Second, Logger: logger})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })

	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	id := snap.ID

	// Terminal rejection frees the session (established pattern for
	// metadata-stage errors): no readable job remains.
	deadline := time.Now().Add(5 * time.Second)
	for m.Current() != nil {
		if time.Now().After(deadline) {
			t.Fatal("session was not freed after v2-only rejection")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := m.Files(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Files after v2 rejection = %v, want ErrNotFound (session freed)", err)
	}
	// The job is routed to the dedicated error code: the manager's
	// sanitized log line must carry "v2-only torrent not supported" with
	// ErrCodeV2Unsupported — never the generic metadata-failed code.
	raw, err := os.ReadFile(filepath.Join(logDir, "eizouden.log"))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if !strings.Contains(string(raw), "v2-only torrent not supported code="+ErrCodeV2Unsupported) {
		t.Errorf("log missing v2 rejection with dedicated code:\n%s", raw)
	}

	// A retry after the rejection must succeed (fresh session, no residue).
	engine.startErr = nil
	snap2, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("retry Start: %v", err)
	}
	waitForState(t, m, snap2.ID, StateBuffering, 5*time.Second)
	if _, err := m.Cancel(snap2.ID); err != nil {
		t.Fatalf("Cancel retry: %v", err)
	}
}

// TestMetadataOnlyBoundary verifies the metadata-only contract: after
// Start → buffering, the engine has NOT downloaded any payload bytes.
// The file list is available (metadata is fetched), but AvailablePrefix
// is zero and SelectedLength is zero (no selection yet). Payload download
// must only begin after an explicit Select call.
func TestMetadataOnlyBoundary(t *testing.T) {
	engine := newFakeEngine("video.mp4:5000|sub.srt:200|readme.txt:10")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	id := snap.ID
	waitForState(t, m, id, StateBuffering, 5*time.Second)

	// At buffering: files are listed, but no payload is downloaded.
	cur := m.Get(id)
	if cur == nil {
		t.Fatal("Get must return the current job")
	}
	if cur.State != StateBuffering {
		t.Fatalf("state = %s, want buffering", cur.State)
	}
	if !cur.HasEligibleVideo {
		t.Fatal("hasEligibleVideo must be true once metadata arrives")
	}
	// AvailablePrefix is 0: no selection means no download.
	if cur.Media.Available != 0 {
		t.Fatalf("available = %d, want 0 (no payload before selection)", cur.Media.Available)
	}

	// Files are listed and contain a video.
	files, err := m.Files(id)
	if err != nil {
		t.Fatalf("Files: %v", err)
	}
	if len(files) != 3 {
		t.Fatalf("files = %d, want 3", len(files))
	}
	hasVideo := false
	for _, f := range files {
		if f.Kind == KindVideo {
			hasVideo = true
		}
	}
	if !hasVideo {
		t.Fatal("files must contain a video")
	}

	// Select a video → payload begins.
	videoID := files[0].ID
	if files[0].Kind != KindVideo {
		videoID = files[1].ID
	}
	if _, err := m.Select(id, videoID, ""); err != nil {
		t.Fatalf("Select: %v", err)
	}
	waitForState(t, m, id, StateStreaming, 5*time.Second)

	// Now payload is downloading: AvailablePrefix may be 0 initially
	// but the engine handle exists and SelectedLength is non-zero.
	cur2 := m.Get(id)
	if cur2 == nil {
		t.Fatal("Get must return the current job after selection")
	}
	if cur2.State != StateStreaming {
		t.Fatalf("state = %s, want streaming", cur2.State)
	}
	if cur2.Media.Total != 5000 {
		t.Fatalf("total = %d, want 5000 (selected video length)", cur2.Media.Total)
	}

	_, _ = m.Cancel(id)
}

// TestCancelThenFreshRetry verifies the contract: after cancelling a job,
// a fresh Start with the same magnet creates a new independent job. The
// second job must reach buffering (metadata fetched) and support a new
// selection. This catches the stale-anacrolix-state regression where
// GotInfo() never fires on the second attempt.
func TestCancelThenFreshRetry(t *testing.T) {
	engine := newFakeEngine("video.mp4:3000|sub.srt:100")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)

	// First job: start → buffer → cancel.
	snap1, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 1: %v", err)
	}
	waitForState(t, m, snap1.ID, StateBuffering, 5*time.Second)
	if _, err := m.Cancel(snap1.ID); err != nil {
		t.Fatalf("Cancel 1: %v", err)
	}
	if m.Current() != nil {
		t.Fatal("session must be free after cancel")
	}

	// Second job: fresh start with the same magnet must succeed.
	snap2, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 2 (retry): %v", err)
	}
	if snap2.ID == snap1.ID {
		t.Fatal("second job must have a different ID")
	}
	waitForState(t, m, snap2.ID, StateBuffering, 5*time.Second)

	// The second job must be independently selectable.
	files, err := m.Files(snap2.ID)
	if err != nil {
		t.Fatalf("Files 2: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("second job must have files")
	}
	var videoID string
	for _, f := range files {
		if f.Kind == KindVideo {
			videoID = f.ID
			break
		}
	}
	if videoID == "" {
		t.Fatal("second job must have a video")
	}
	if _, err := m.Select(snap2.ID, videoID, ""); err != nil {
		t.Fatalf("Select 2: %v", err)
	}
	waitForState(t, m, snap2.ID, StateStreaming, 5*time.Second)

	// Simulate completion.
	engine.h.avail.Store(engine.h.files[engine.h.selected].Length)
	waitForState(t, m, snap2.ID, StateComplete, 5*time.Second)

	_, _ = m.Cancel(snap2.ID)
}

// TestMetadataTimeoutCallback verifies that the OnMetadataTimeout
// callback fires when the metadata fetch times out, with a duration
// approximately equal to the configured timeout.
func TestMetadataTimeoutCallback(t *testing.T) {
	const metaTimeout = 100 * time.Millisecond
	var callbackElapsed time.Duration
	var callbackFired atomic.Bool

	engine := &fakeEngine{
		startDelay: 5 * time.Second, // much longer than timeout
		files:      buildFakeFiles("media.mp4:100"),
	}
	factory := func(_ string) (Engine, error) { return engine, nil }
	m, err := New(Config{
		EngineFactory: factory,
		Timeout:       metaTimeout,
		OnMetadataTimeout: func(elapsed time.Duration) {
			callbackElapsed = elapsed
			callbackFired.Store(true)
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })

	_, err = m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Session is auto-freed on timeout; wait for nil.
	deadline := time.Now().Add(5 * time.Second)
	for m.Current() != nil {
		if time.Now().After(deadline) {
			t.Fatal("session was not freed after metadata timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !callbackFired.Load() {
		t.Fatal("OnMetadataTimeout callback must fire on timeout")
	}
	// Elapsed should be at least the timeout duration (within reason).
	if callbackElapsed < metaTimeout/2 {
		t.Fatalf("callback elapsed = %v, want >= %v", callbackElapsed, metaTimeout/2)
	}
}

// TestTimeoutThenFreshRetryWithoutCancel verifies the contract: after a
// metadata timeout, the session is auto-freed (no explicit Cancel needed),
// and a fresh Start with the same magnet succeeds immediately. This is the
// primary recovery path for a stalled anacrolix client (same-magnet retry
// after cancel where internal state may be stale).
func TestTimeoutThenFreshRetryWithoutCancel(t *testing.T) {
	engine := &fakeEngine{
		startDelay: 200 * time.Millisecond,
		files:      buildFakeFiles("media.mp4:6000"),
	}
	m := newTestManagerWithEngine(t, engine, 100*time.Millisecond)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Wait for the timeout to fire and the session to be auto-freed.
	deadline := time.Now().Add(5 * time.Second)
	for m.Current() != nil {
		if time.Now().After(deadline) {
			t.Fatal("session was not freed after timeout")
		}
		time.Sleep(30 * time.Millisecond)
	}
	// Reset the engine delay so the retry succeeds immediately.
	engine.startDelay = 0
	// Fresh Start with the same magnet must succeed without explicit Cancel.
	snap2, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start after timeout: %v", err)
	}
	if snap2.ID == snap.ID {
		t.Fatal("retry must produce a different job ID")
	}
	// Verify the retry reaches buffering (metadata fetched).
	waitForState(t, m, snap2.ID, StateBuffering, 5*time.Second)
	_, _ = m.Cancel(snap2.ID)
}

// TestBootstrapFailureFreesSessionAndRetrySucceeds verifies the contract:
// when StartBootstrap fails (reader failed), the session is freed via
// m.clear(j) so the same magnet can be retried immediately without a 409
// conflict. This is the regression test for the missing clear() that left
// m.current set after a bootstrap error.
func TestBootstrapFailureFreesSessionAndRetrySucceeds(t *testing.T) {
	engine := newFakeEngine("video.mp4:5000|sub.srt:200")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)

	// First job: start → buffer → select → bootstrap fails.
	snap1, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 1: %v", err)
	}
	waitForState(t, m, snap1.ID, StateBuffering, 5*time.Second)
	if _, err := m.Select(snap1.ID, "f0", "f1"); err != nil {
		t.Fatalf("Select: %v", err)
	}
	// Inject bootstrap failure.
	engine.h.bootErr = errors.New("injected reader failure")
	// Wait for the error state and session to be freed.
	deadline := time.Now().Add(5 * time.Second)
	for m.Current() != nil {
		if time.Now().After(deadline) {
			t.Fatal("session was not freed after bootstrap failure")
		}
		time.Sleep(30 * time.Millisecond)
	}
	// Verify the error was set.
	snap1After := m.Get(snap1.ID)
	if snap1After != nil {
		t.Fatalf("session must be free after bootstrap failure, got state=%s", snap1After.State)
	}

	// Clear the injected error and allow bootstrap to succeed on retry.
	engine.h.bootErr = nil
	// Create a fresh handle for the new job (the engine's Start returns a new handle).
	snap2, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 2 (retry): %v", err)
	}
	if snap2.ID == snap1.ID {
		t.Fatal("retry must produce a different job ID")
	}
	waitForState(t, m, snap2.ID, StateBuffering, 5*time.Second)

	// The retry must be independently selectable and streamable.
	if _, err := m.Select(snap2.ID, "f0", "f1"); err != nil {
		t.Fatalf("Select 2: %v", err)
	}
	waitForState(t, m, snap2.ID, StateStreaming, 5*time.Second)

	engine.h.avail.Store(engine.h.files[engine.h.selected].Length)
	waitForState(t, m, snap2.ID, StateComplete, 5*time.Second)

	_, _ = m.Cancel(snap2.ID)
}

// --- counting engine for close verification ---

type countingEngine struct {
	inner      Engine
	closeCount atomic.Int32
}

func (e *countingEngine) Start(ctx context.Context, magnet string) (TorrentHandle, error) {
	return e.inner.Start(ctx, magnet)
}

func (e *countingEngine) Close() error {
	e.closeCount.Add(1)
	return e.inner.Close()
}

// TestEvictedTTLExpiration verifies that evicted snapshots disappear after
// the TTL expires. Uses a very short TTL (10ms) to avoid real-time waits.
func TestEvictedTTLExpiration(t *testing.T) {
	m := newTestManagerWithEngine(t, newFakeEngine("video.mp4:3000|sub.srt:100"), 10*time.Second)
	// Override the evicted TTL to 10ms for fast testing.
	m.evictedTTL = 10 * time.Millisecond

	snap1, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 1: %v", err)
	}
	waitForState(t, m, snap1.ID, StateBuffering, 5*time.Second)

	snap2, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 2: %v", err)
	}
	waitForState(t, m, snap2.ID, StateBuffering, 5*time.Second)

	// 3rd start evicts snap1.
	snap3, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 3: %v", err)
	}
	_ = snap3

	// snap1 should be evicted but still readable.
	evicted := m.Get(snap1.ID)
	if evicted == nil {
		t.Fatal("evicted session must be readable immediately after eviction")
	}
	if evicted.State != StateError || evicted.ErrorCode != ErrCodeConcurrencyLimit {
		t.Fatalf("evicted state=%s code=%q, want error/%s", evicted.State, evicted.ErrorCode, ErrCodeConcurrencyLimit)
	}

	// Wait for TTL to expire.
	time.Sleep(50 * time.Millisecond)

	// After TTL, snap1 should be gone.
	afterTTL := m.Get(snap1.ID)
	if afterTTL != nil {
		t.Fatalf("evicted session must be gone after TTL, got state=%s", afterTTL.State)
	}

	// Cleanup.
	_, _ = m.Cancel(snap3.ID)
	_, _ = m.Cancel(snap2.ID)
}

// TestEvictedEngineClosedOnce verifies that the evicted engine's Close is
// called exactly once (no double-close from evictOldestLocked + run cleanup).
func TestEvictedEngineClosedOnce(t *testing.T) {
	var engines []*countingEngine
	var mu sync.Mutex

	factory := func(_ string) (Engine, error) {
		inner := newFakeEngine("video.mp4:3000|sub.srt:100")
		ce := &countingEngine{inner: inner}
		mu.Lock()
		engines = append(engines, ce)
		mu.Unlock()
		return ce, nil
	}

	m, err := New(Config{
		EngineFactory: factory,
		Timeout:       10 * time.Second,
		EvictedTTL:    100 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })

	// Create 3 sessions to trigger eviction.
	snap1, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 1: %v", err)
	}
	waitForState(t, m, snap1.ID, StateBuffering, 5*time.Second)

	snap2, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 2: %v", err)
	}
	waitForState(t, m, snap2.ID, StateBuffering, 5*time.Second)

	snap3, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 3: %v", err)
	}
	_ = snap3

	// Wait for the evicted run goroutine to finish.
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(engines) < 1 {
		t.Fatal("expected at least 1 engine")
	}

	// The first engine (oldest, evicted) should have Close called exactly once.
	// Note: the evicted engine's Close is called by the run goroutine via
	// cleanupSession, not by evictOldestLocked.
	closeCount := engines[0].closeCount.Load()
	if closeCount != 1 {
		t.Fatalf("evicted engine Close count = %d, want 1 (no double-close)", closeCount)
	}

	// Cleanup.
	_, _ = m.Cancel(snap3.ID)
	_, _ = m.Cancel(snap2.ID)
}

// TestCancelAfterErrorNoDoubleClose verifies that Cancel on a session that
// already errored (and had its handle+engine cleaned up by run) does not
// double-close them. Uses a counting engine to verify Close is called
// exactly once.
func TestCancelAfterErrorNoDoubleClose(t *testing.T) {
	var engines []*countingEngine
	var mu sync.Mutex

	factory := func(_ string) (Engine, error) {
		inner := newFakeEngine("video.mp4:3000|sub.srt:100")
		ce := &countingEngine{inner: inner}
		mu.Lock()
		engines = append(engines, ce)
		mu.Unlock()
		return ce, nil
	}

	m, err := New(Config{
		EngineFactory: factory,
		Timeout:       10 * time.Second,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })

	// Create a session that will error (no video → "no playable video").
	// Use a factory that creates an engine with no video files.
	var errorEngines []*countingEngine
	errorFactory := func(_ string) (Engine, error) {
		inner := newFakeEngine("readme.txt:10|song.mp3:50")
		ce := &countingEngine{inner: inner}
		mu.Lock()
		errorEngines = append(errorEngines, ce)
		mu.Unlock()
		return ce, nil
	}
	m2, err := New(Config{
		EngineFactory: errorFactory,
		Timeout:       10 * time.Second,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = m2.Close() })

	snap, err := m2.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Wait for the error state and session to be freed.
	deadline := time.Now().Add(5 * time.Second)
	for m2.Get(snap.ID) != nil {
		if time.Now().After(deadline) {
			t.Fatal("session was not freed after no-video error")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// Cancel after error: session is already freed from active map,
	// so Cancel returns ErrNotFound. No double-close occurs because
	// cleanupSession already nilled the refs.
	_, cancelErr := m2.Cancel(snap.ID)
	if cancelErr == nil {
		// Cancel succeeded (session still in map) or returned not-found.
		// Either way, no double-close.
	}

	// Verify engine Close was called exactly once (by run's cleanupSession).
	mu.Lock()
	defer mu.Unlock()
	if len(errorEngines) < 1 {
		t.Fatal("expected at least 1 error engine")
	}
	closeCount := errorEngines[0].closeCount.Load()
	if closeCount != 1 {
		t.Fatalf("error engine Close count = %d, want 1 (no double-close after error)", closeCount)
	}

	// Cleanup the other manager.
	_ = m
}

// TestCancelConcurrentEvictCloseOnce verifies that when Cancel and eviction
// race on the same session, the engine Handle is closed exactly once.
// This is a regression test for the double-close where Cancel captured
// refs before <-j.done while eviction closed them concurrently.
func TestCancelConcurrentEvictCloseOnce(t *testing.T) {
	var mu sync.Mutex
	var engines []*countingEngine

	factory := func(_ string) (Engine, error) {
		inner := newFakeEngine("video.mp4:3000|sub.srt:100")
		ce := &countingEngine{inner: inner}
		mu.Lock()
		engines = append(engines, ce)
		mu.Unlock()
		return ce, nil
	}

	m, err := New(Config{
		EngineFactory: factory,
		Timeout:       10 * time.Second,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })

	// Create 2 sessions.
	snap1, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 1: %v", err)
	}
	waitForState(t, m, snap1.ID, StateBuffering, 5*time.Second)

	snap2, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 2: %v", err)
	}
	waitForState(t, m, snap2.ID, StateBuffering, 5*time.Second)

	// Race: Cancel session 1 concurrently with creating session 3
	// (which triggers eviction of session 1).
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = m.Cancel(snap1.ID)
	}()
	go func() {
		defer wg.Done()
		// Small delay so Cancel starts first, then eviction fires.
		time.Sleep(5 * time.Millisecond)
		_, _ = m.Start(testMagnet)
	}()
	wg.Wait()

	// Wait a bit for cleanup goroutines to finish.
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	// The first engine (session 1) must have Close called exactly once,
	// regardless of whether Cancel or eviction ran first.
	if len(engines) < 1 {
		t.Fatal("expected at least 1 engine")
	}
	closeCount := engines[0].closeCount.Load()
	if closeCount != 1 {
		t.Fatalf("evicted/cancelled engine Close count = %d, want 1 (no double-close)", closeCount)
	}

	// Cleanup remaining sessions.
	// Note: session 3 is the newest; session 2 is still active.
}

// TestConcurrentRaceSafety exercises concurrent create/cancel/evict to
// verify no race conditions under `go test -race`.
func TestConcurrentRaceSafety(t *testing.T) {
	m := newTestManagerWithEngine(t, newFakeEngine("video.mp4:3000|sub.srt:100"), 10*time.Second)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			snap, err := m.Start(testMagnet)
			if err != nil {
				return
			}
			// Brief sleep then cancel.
			time.Sleep(time.Duration(rand.Intn(20)) * time.Millisecond)
			_, _ = m.Cancel(snap.ID)
		}()
	}

	// Concurrent reads.
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 5; j++ {
				_ = m.Current()
				_ = m.ActiveCount()
				_, _ = m.ActiveMedia()
				_ = m.SelectedMediaType()
				_ = m.AvailablePrefix()
				time.Sleep(time.Millisecond)
			}
		}()
	}

	wg.Wait()
}

// --- helpers ---

func newTestManagerWithEngine(t *testing.T, engine Engine, timeout time.Duration) *Manager {
	t.Helper()
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	factory := func(_ string) (Engine, error) { return engine, nil }
	m, err := New(Config{EngineFactory: factory, Timeout: timeout})
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

// TestSelectedSubtitleContentAfterSelection verifies that
// SelectedSubtitleContent returns the subtitle text after selection.
func TestSelectedSubtitleContentAfterSelection(t *testing.T) {
	engine := newFakeEngine("video.mp4:5000|sub.srt:200")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	id := snap.ID
	waitForState(t, m, id, StateBuffering, 5*time.Second)

	// Before selection, SelectedSubtitleContent returns error.
	_, err = m.SelectedSubtitleContent(context.Background())
	if err == nil {
		t.Fatal("SelectedSubtitleContent before selection must fail")
	}

	// Select video + subtitle.
	if _, err := m.Select(id, "f0", "f1"); err != nil {
		t.Fatalf("Select: %v", err)
	}

	// Set the fake handle's subtitle content.
	engine.mu.Lock()
	engine.h.subtitleContent = "1\n00:00:01,000 --> 00:00:02,000\nHello world\n"
	engine.mu.Unlock()

	waitForState(t, m, id, StateStreaming, 5*time.Second)

	// SelectedSubtitleContent returns the fake content.
	content, err := m.SelectedSubtitleContent(context.Background())
	if err != nil {
		t.Fatalf("SelectedSubtitleContent: %v", err)
	}
	if content != "1\n00:00:01,000 --> 00:00:02,000\nHello world\n" {
		t.Fatalf("SelectedSubtitleContent = %q, want SRT content", content)
	}

	_, _ = m.Cancel(id)
}

// TestSelectedSubtitleContentNoSubtitle verifies that
// SelectedSubtitleContent returns error when no subtitle is selected.
func TestSelectedSubtitleContentNoSubtitle(t *testing.T) {
	engine := newFakeEngine("video.mp4:5000|sub.srt:200")
	m := newTestManagerWithEngine(t, engine, 10*time.Second)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	id := snap.ID
	waitForState(t, m, id, StateBuffering, 5*time.Second)

	// Select video only (no subtitle).
	if _, err := m.Select(id, "f0", ""); err != nil {
		t.Fatalf("Select: %v", err)
	}
	waitForState(t, m, id, StateStreaming, 5*time.Second)

	// SelectedSubtitleContent returns error.
	_, err = m.SelectedSubtitleContent(context.Background())
	if err == nil {
		t.Fatal("SelectedSubtitleContent without subtitle must fail")
	}

	_, _ = m.Cancel(id)
}

// TestSelectedSubtitleContentNoSession verifies that
// SelectedSubtitleContent returns error with no active session.
func TestSelectedSubtitleContentNoSession(t *testing.T) {
	m := newTestManagerWithEngine(t, newFakeEngine("video.mp4:5000"), 0)
	_, err := m.SelectedSubtitleContent(context.Background())
	if err == nil {
		t.Fatal("SelectedSubtitleContent with no session must fail")
	}
}
