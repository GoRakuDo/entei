package torrent

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"eizoudendenshi/internal/media"
)

// State is the torrent job state machine. Values map onto the existing
// growing-media/status contract: queued/downloading/buffering →
// status "buffering" (media not servable); complete → "complete" (a valid
// selection exists and the media is fully downloaded); error → "error";
// cancelled → no active source.
type State string

const (
	StateQueued      State = "queued"
	StateDownloading State = "downloading" // metadata fetch in progress
	StateBuffering   State = "buffering"   // metadata listed, awaiting selection
	StateStreaming   State = "streaming"   // selected; payload downloading
	StateComplete    State = "complete"
	StateError       State = "error"
	StateCancelled   State = "cancelled"
)

// Media is the metadata-only availability view (available/total bytes).
type Media struct {
	Available int64 `json:"available"`
	Total     int64 `json:"total"`
	HeadReady bool  `json:"headReady"`
}

// Snapshot is the redacted public view of a torrent job. It never contains
// the magnet, local paths, or helper output.
type Snapshot struct {
	ID                string `json:"id"`
	State             State  `json:"state"`
	Error             string `json:"error,omitempty"`
	Media             Media  `json:"media"`
	HasEligibleVideo  bool   `json:"hasEligibleVideo"`
	SelectedVideoFile string `json:"selectedVideoFile,omitempty"`
}

// Config configures the torrent manager. The Engine is required.
type Config struct {
	// Engine is the torrent engine abstraction. Required.
	Engine Engine
	// Timeout bounds the metadata fetch. Zero selects the default
	// (30 minutes).
	Timeout time.Duration
}

const defaultTimeout = 30 * time.Minute

// Manager supervises the single active torrent job (one-session policy).
type Manager struct {
	mu      sync.Mutex
	engine  Engine
	timeout time.Duration
	current *torrentJob
	closed  bool
}

// New validates the configuration and builds a Manager.
func New(cfg Config) (*Manager, error) {
	if cfg.Engine == nil {
		return nil, errors.New("engine required")
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = defaultTimeout
	}
	return &Manager{engine: cfg.Engine, timeout: cfg.Timeout}, nil
}

type torrentJob struct {
	id       string
	magnet   string
	cancel   context.CancelFunc
	done     chan struct{}
	handle   TorrentHandle
	files    []TorrentFile
	selected chan struct{}

	stateMu        sync.Mutex
	state          State
	errMsg         string
	videoV         *TorrentFile
	subV           *TorrentFile
	selectedReader io.ReadSeekCloser
}

func (j *torrentJob) setState(s State) { j.stateMu.Lock(); j.state = s; j.stateMu.Unlock() }
func (j *torrentJob) getState() State  { j.stateMu.Lock(); defer j.stateMu.Unlock(); return j.state }

func (j *torrentJob) setError(msg string) {
	j.stateMu.Lock()
	j.errMsg = msg
	j.stateMu.Unlock()
}

func (j *torrentJob) snapshot() Snapshot {
	j.stateMu.Lock()
	defer j.stateMu.Unlock()
	snap := Snapshot{ID: j.id, State: j.state}
	if j.state == StateError {
		snap.Error = j.errMsg
	}
	if j.handle != nil {
		avail := j.handle.AvailablePrefix()
		total := j.handle.SelectedLength()
		snap.Media = Media{Available: avail, Total: total}
	} else if j.files != nil {
		snap.Media = Media{Available: totalBytesFromTorrent(j.files), Total: totalBytesFromTorrent(j.files)}
	}
	if j.files != nil {
		for _, f := range j.files {
			if f.Kind == KindVideo {
				snap.HasEligibleVideo = true
				break
			}
		}
	}
	if j.videoV != nil {
		snap.SelectedVideoFile = j.videoV.ID
	}
	return snap
}

func totalBytesFromTorrent(files []TorrentFile) int64 {
	var total int64
	for _, f := range files {
		total += f.Length
	}
	return total
}

// Start validates the magnet and begins a new torrent job.
func (m *Manager) Start(rawMagnet string) (Snapshot, error) {
	canonical, err := ValidateMagnet(rawMagnet)
	if err != nil {
		return Snapshot{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Snapshot{}, errors.New("manager closed")
	}
	if m.current != nil {
		return Snapshot{}, ErrConflict
	}
	j := &torrentJob{
		id:       newJobID(),
		magnet:   canonical,
		selected: make(chan struct{}),
		done:     make(chan struct{}),
		state:    StateQueued,
	}
	ctx, cancel := context.WithCancel(context.Background())
	j.cancel = cancel
	m.current = j
	go m.run(j, ctx)
	return j.snapshot(), nil
}

func (m *Manager) Current() *Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return nil
	}
	snap := m.current.snapshot()
	return &snap
}

func (m *Manager) Get(id string) *Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.current.id != id {
		return nil
	}
	snap := m.current.snapshot()
	return &snap
}

// ActiveMedia returns the current job's snapshot and, when the selected
// video is readable, a ReaderSource that wraps the engine reader.
func (m *Manager) ActiveMedia() (Snapshot, media.GrowingSource) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return Snapshot{}, nil
	}
	snap := m.current.snapshot()
	st := m.current.getState()
	m.current.stateMu.Lock()
	h := m.current.handle
	selectedLen := int64(0)
	if h != nil {
		selectedLen = h.SelectedLength()
	}
	m.current.stateMu.Unlock()
	// Return a servable source for both streaming (progressive playback
	// from the verified prefix) and complete (full file available).
	if (st == StateStreaming || st == StateComplete) && h != nil {
		src := &torrentReaderSource{
			handle: h,
			length: selectedLen,
		}
		return snap, src
	}
	return snap, nil
}

// Files returns the sanitized file listing once metadata is available.
func (m *Manager) Files(id string) ([]TorrentFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.current.id != id {
		return nil, ErrNotFound
	}
	j := m.current
	j.stateMu.Lock()
	defer j.stateMu.Unlock()
	if j.state != StateBuffering {
		return nil, ErrNotListed
	}
	out := make([]TorrentFile, len(j.files))
	copy(out, j.files)
	return out, nil
}

// Select validates the one-video + optional-subtitle contract and starts
// the download of the selected files.
func (m *Manager) Select(id, videoFileID, subtitleFileID string) (Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.current.id != id {
		return Snapshot{}, ErrNotFound
	}
	j := m.current
	j.stateMu.Lock()
	ready := j.state == StateBuffering && j.handle != nil
	h := j.handle
	files := j.files
	j.stateMu.Unlock()
	if !ready {
		return Snapshot{}, ErrNotListed
	}
	var video *TorrentFile
	for i := range files {
		if files[i].ID == videoFileID {
			video = &files[i]
			break
		}
	}
	if video == nil || video.Kind != KindVideo {
		return Snapshot{}, ErrInvalidSelection
	}
	var sub *TorrentFile
	if subtitleFileID != "" {
		for i := range files {
			if files[i].ID == subtitleFileID {
				sub = &files[i]
				break
			}
		}
		if sub == nil || sub.Kind != KindSubtitle {
			return Snapshot{}, ErrInvalidSelection
		}
	}
	if err := h.Select(videoFileID, subtitleFileID); err != nil {
		return Snapshot{}, ErrInvalidSelection
	}
	j.stateMu.Lock()
	j.videoV = video
	j.subV = sub
	j.stateMu.Unlock()
	close(j.selected)
	return j.snapshot(), nil
}

// Cancel stops the job, drops the torrent, and frees the session.
func (m *Manager) Cancel(id string) (Snapshot, error) {
	m.mu.Lock()
	j := m.current
	if j == nil || j.id != id {
		m.mu.Unlock()
		return Snapshot{}, ErrNotFound
	}
	m.mu.Unlock()
	if j.cancel != nil {
		j.cancel()
	}
	<-j.done
	m.mu.Lock()
	if m.current == j {
		m.current = nil
	}
	m.mu.Unlock()
	j.stateMu.Lock()
	h := j.handle
	j.stateMu.Unlock()
	if h != nil {
		_ = h.Close()
	}
	return Snapshot{ID: id, State: StateCancelled}, nil
}

// Close cancels the active job (if any) and frees the session. Idempotent.
func (m *Manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	j := m.current
	m.mu.Unlock()
	if j != nil {
		if j.cancel != nil {
			j.cancel()
		}
		<-j.done
		j.stateMu.Lock()
		h := j.handle
		j.stateMu.Unlock()
		if h != nil {
			_ = h.Close()
		}
	}
	if m.engine != nil {
		_ = m.engine.Close()
	}
	return nil
}

func (m *Manager) clear(j *torrentJob) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == j {
		m.current = nil
	}
}

func (m *Manager) run(j *torrentJob, ctx context.Context) {
	defer close(j.done)
	j.setState(StateDownloading)
	metaCtx, metaCancel := context.WithTimeout(ctx, m.timeout)
	defer metaCancel()
	handle, err := m.engine.Start(metaCtx, j.magnet)
	if err != nil {
		if metaCtx.Err() != nil && ctx.Err() == nil {
			j.setError("metadata timed out")
			j.setState(StateError)
		} else if ctx.Err() != nil {
			j.setState(StateCancelled)
			m.clear(j)
		} else {
			j.setError("metadata failed")
			j.setState(StateError)
		}
		return
	}
	j.stateMu.Lock()
	j.handle = handle
	j.stateMu.Unlock()
	files := handle.Files()
	hasVideo := false
	for _, f := range files {
		if f.Kind == KindVideo {
			hasVideo = true
			break
		}
	}
	if !hasVideo {
		_ = handle.Close()
		j.setError("no playable video")
		j.setState(StateError)
		return
	}
	j.stateMu.Lock()
	j.files = files
	j.stateMu.Unlock()
	j.setState(StateBuffering)
	select {
	case <-j.selected:
	case <-ctx.Done():
		_ = handle.Close()
		j.setState(StateCancelled)
		m.clear(j)
		return
	}
	j.setState(StateStreaming)
	r, err := handle.Reader(ctx)
	if err != nil {
		_ = handle.Close()
		j.setError("reader failed")
		j.setState(StateError)
		return
	}
	j.stateMu.Lock()
	j.selectedReader = r
	j.stateMu.Unlock()
	poll := time.NewTicker(200 * time.Millisecond)
	defer poll.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = r.Close()
			_ = handle.Close()
			j.setState(StateCancelled)
			m.clear(j)
			return
		case <-poll.C:
			avail := handle.AvailablePrefix()
			total := handle.SelectedLength()
			if avail >= total && total > 0 {
				_ = r.Close()
				j.setState(StateComplete)
				return
			}
		}
	}
}

// SelectedMediaType returns the conservative HTTP media type of the
// selected file, derived from its extension (never hardcoded to video/mp4).
func (m *Manager) SelectedMediaType() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return ""
	}
	m.current.stateMu.Lock()
	vv := m.current.videoV
	m.current.stateMu.Unlock()
	if vv == nil {
		return ""
	}
	ext := ""
	base := vv.Path
	for i := len(base) - 1; i >= 0; i-- {
		if base[i] == '.' {
			ext = base[i+1:]
			break
		}
	}
	return mimeForExt(ext)
}

// AvailablePrefix returns the verified contiguous prefix length of the
// currently selected video. Returns 0 when no handle exists.
func (m *Manager) AvailablePrefix() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return 0
	}
	m.current.stateMu.Lock()
	h := m.current.handle
	m.current.stateMu.Unlock()
	if h == nil {
		return 0
	}
	return h.AvailablePrefix()
}

// torrentReaderSource wraps the engine's torrent reader as a
// media.GrowingSource. It does not need Close — the engine manages
// the torrent lifecycle.
//
// ReadAt creates a fresh reader per call. This is intentional: the
// engine's Reader returns a stateful seekable reader (current position,
// readahead window), and concurrent HTTP Range requests from different
// browsers must not share a reader's position state. A per-ReadAt reader
// keeps each request isolated with its own Seek+Read pair under a fresh
// context timeout. The cost is one engine reader per ~32KB copy, but
// anacrolix/torrent readers are lightweight wrappers over piece buffers
// and the alternative (shared reader with mutex serialization) would
// block concurrent Range requests and complicate context cancellation.
// If profiling shows this matters, a per-HTTP-request pooled reader
// could be added behind a new TorrentHandle method; for now the
// simplicity and isolation of per-ReadAt readers is preferred.
type torrentReaderSource struct {
	handle TorrentHandle
	length int64
}

func (s *torrentReaderSource) Total() int64     { return s.length }
func (s *torrentReaderSource) Available() int64 { return s.handle.AvailablePrefix() }
func (s *torrentReaderSource) ReadAt(p []byte, off int64) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	r, err := s.handle.Reader(ctx)
	if err != nil {
		return 0, err
	}
	defer r.Close()
	_, err = r.Seek(off, io.SeekStart)
	if err != nil {
		return 0, err
	}
	return r.Read(p)
}
