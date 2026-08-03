package torrent

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"eizoudendenshi/internal/media"
)

// State is the torrent job state machine.
type State string

const (
	StateQueued      State = "queued"
	StateDownloading State = "downloading"
	StateBuffering   State = "buffering"
	StateStreaming   State = "streaming"
	StateComplete    State = "complete"
	StateError       State = "error"
	StateCancelled   State = "cancelled"
)

// Media is the metadata-only availability view.
type Media struct {
	Available int64 `json:"available"`
	Total     int64 `json:"total"`
	HeadReady bool  `json:"headReady"`
}

// Snapshot is the redacted public view of a torrent job. ErrorCode is a
// stable identifier (e.g. "torrent_concurrency_limit") for frontend routing.
type Snapshot struct {
	ID                string `json:"id"`
	State             State  `json:"state"`
	Error             string `json:"error,omitempty"`
	ErrorCode         string `json:"errorCode,omitempty"`
	Media             Media  `json:"media"`
	HasEligibleVideo  bool   `json:"hasEligibleVideo"`
	SelectedVideoFile string `json:"selectedVideoFile,omitempty"`
}

// Config configures the torrent manager.
type Config struct {
	// EngineFactory creates a fresh Engine for each torrent session.
	// Required. Each session gets its own anacrolix Client to avoid
	// anacrolix v1.61 issue #1048 (stale tracker weakref when the same
	// Client re-adds the same infohash after Drop).
	EngineFactory func() (Engine, error)

	// EngineCloser, when set, is called to release an Engine after its
	// session ends. If nil, engine.Close() is called directly.
	EngineCloser func(Engine) error

	// Timeout bounds the metadata fetch. Zero selects defaultTimeout.
	Timeout time.Duration

	// EvictedTTL is how long an evicted session remains readable after
	// eviction. Zero selects EvictedTTLDefault (30s). Inject a short
	// value in tests to avoid real-time waits.
	EvictedTTL time.Duration

	// OnMetadataTimeout, when set, is called with the elapsed duration
	// when a metadata fetch times out. Must not block.
	OnMetadataTimeout func(elapsed time.Duration)
}

const (
	defaultTimeout = 2 * time.Minute
)

// torrentSession is a torrent job session with its own Engine.
type torrentSession struct {
	job     *torrentJob
	engine  Engine
	created time.Time
}

// evictedState holds a terminal snapshot of an evicted session.
type evictedState struct {
	snap    Snapshot
	expires time.Time
}

// Manager supervises up to MaxConcurrentTorrents concurrent torrent
// sessions. The oldest session is evicted (terminal error code) when
// the limit is reached.
type Manager struct {
	mu                sync.Mutex
	engineFactory     func() (Engine, error)
	engineCloser      func(Engine) error
	timeout           time.Duration
	evictedTTL        time.Duration
	onMetadataTimeout func(elapsed time.Duration)
	sessions          map[string]*torrentSession
	sessionOrder      []string
	evicted           map[string]*evictedState
	closed            bool
}

// New validates the configuration and builds a Manager.
func New(cfg Config) (*Manager, error) {
	if cfg.EngineFactory == nil {
		return nil, errors.New("engine factory required")
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = defaultTimeout
	}
	evictedTTL := cfg.EvictedTTL
	if evictedTTL <= 0 {
		evictedTTL = EvictedTTLDefault
	}
	return &Manager{
		engineFactory:     cfg.EngineFactory,
		engineCloser:      cfg.EngineCloser,
		timeout:           cfg.Timeout,
		evictedTTL:        evictedTTL,
		onMetadataTimeout: cfg.OnMetadataTimeout,
		sessions:          make(map[string]*torrentSession),
		evicted:           make(map[string]*evictedState),
	}, nil
}

type torrentJob struct {
	id       string
	magnet   string
	cancel   context.CancelFunc
	done     chan struct{}
	handle   TorrentHandle
	files    []TorrentFile
	selected chan struct{}

	stateMu sync.Mutex
	state   State
	errMsg  string
	errCode string
	videoV  *TorrentFile
	subV    *TorrentFile
}

func (j *torrentJob) setState(s State) { j.stateMu.Lock(); j.state = s; j.stateMu.Unlock() }
func (j *torrentJob) getState() State  { j.stateMu.Lock(); defer j.stateMu.Unlock(); return j.state }

func (j *torrentJob) setErrorWithCode(msg, code string) {
	j.stateMu.Lock()
	j.errMsg = msg
	j.errCode = code
	j.stateMu.Unlock()
}

func (j *torrentJob) snapshot() Snapshot {
	j.stateMu.Lock()
	defer j.stateMu.Unlock()
	snap := Snapshot{ID: j.id, State: j.state}
	if j.state == StateError {
		snap.Error = j.errMsg
		snap.ErrorCode = j.errCode
	}
	if j.handle != nil {
		snap.Media = Media{
			Available: j.handle.AvailablePrefix(),
			Total:     j.handle.SelectedLength(),
		}
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

// Start validates the magnet and begins a new torrent job. If
// MaxConcurrentTorrents is reached, the oldest session is evicted.
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
	m.purgeEvicted()
	if len(m.sessions) >= MaxConcurrentTorrents {
		m.evictOldestLocked()
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
	sess := &torrentSession{job: j, created: time.Now()}
	m.sessions[j.id] = sess
	m.sessionOrder = append(m.sessionOrder, j.id)
	go m.run(j, ctx, sess)
	return j.snapshot(), nil
}

// evictOldestLocked moves the oldest session to evicted cache and cancels
// its context. For sessions where run has completed (handle+engine still
// alive), closes them here. For sessions where run is still active, the
// run goroutine notices ctx.Done and cleans up via cleanupRun.
func (m *Manager) evictOldestLocked() {
	if len(m.sessionOrder) == 0 {
		return
	}
	oldestID := m.sessionOrder[0]
	sess, ok := m.sessions[oldestID]
	if !ok {
		m.sessionOrder = m.sessionOrder[1:]
		return
	}
	sess.job.setErrorWithCode("evicted: concurrent torrent limit exceeded", ErrCodeConcurrencyLimit)
	sess.job.setState(StateError)
	m.evicted[oldestID] = &evictedState{
		snap:    sess.job.snapshot(),
		expires: time.Now().Add(m.evictedTTL),
	}
	delete(m.sessions, oldestID)
	m.sessionOrder = m.sessionOrder[1:]
	// Cancel context: if run is still active, it notices ctx.Done and
	// cleans up via cleanupRun. If run has already returned (complete),
	// close handle+engine here to prevent leaks.
	if sess.job.cancel != nil {
		sess.job.cancel()
	}
	// TOCTOU safety: the select below is a snapshot — either run has
	// already finished (done closed) or it is still running. In the
	// latter case, run observes ctx.Done (set above) and calls
	// cleanupSession which nils j.handle + sess.engine under stateMu.
	// The default branch only fires when run is still active; it does
	// nothing because cleanupSession will handle it. The done branch
	// fires when run already finished (complete or error); we read
	// refs under stateMu and close only if non-nil (idempotent with
	// Cancel/Close which use the same stateMu-guarded nil pattern).
	select {
	case <-sess.job.done:
		// Run already returned. Read refs, nil them under stateMu,
		// then close — prevents latent double-close with Cancel.
		sess.job.stateMu.Lock()
		h := sess.job.handle
		eng := sess.engine
		sess.job.handle = nil
		sess.engine = nil
		sess.job.stateMu.Unlock()
		if h != nil {
			_ = h.Close()
		}
		if eng != nil {
			if m.engineCloser != nil {
				_ = m.engineCloser(eng)
			} else {
				_ = eng.Close()
			}
		}
	default:
		// Run still active; it will clean up via ctx.Done → cleanupRun.
	}
}

func (m *Manager) purgeEvicted() {
	now := time.Now()
	for id, e := range m.evicted {
		if now.After(e.expires) {
			delete(m.evicted, id)
		}
	}
}

// Current returns the snapshot of the most recently started active session.
func (m *Manager) Current() *Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.purgeEvicted()
	if len(m.sessionOrder) == 0 {
		return nil
	}
	lastID := m.sessionOrder[len(m.sessionOrder)-1]
	if sess, ok := m.sessions[lastID]; ok {
		snap := sess.job.snapshot()
		return &snap
	}
	return nil
}

// Get returns the snapshot for a given job id (active or evicted within TTL).
func (m *Manager) Get(id string) *Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.purgeEvicted()
	if sess, ok := m.sessions[id]; ok {
		snap := sess.job.snapshot()
		return &snap
	}
	if e, ok := m.evicted[id]; ok {
		snap := e.snap
		return &snap
	}
	return nil
}

// ActiveCount returns the number of active torrent sessions.
func (m *Manager) ActiveCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

// ActiveMedia returns the most recently started job's snapshot and
// optionally a ReaderSource for media serving.
func (m *Manager) ActiveMedia() (Snapshot, media.GrowingSource) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.purgeEvicted()
	if len(m.sessionOrder) == 0 {
		return Snapshot{}, nil
	}
	lastID := m.sessionOrder[len(m.sessionOrder)-1]
	sess, ok := m.sessions[lastID]
	if !ok {
		return Snapshot{}, nil
	}
	j := sess.job
	snap := j.snapshot()
	st := j.getState()
	j.stateMu.Lock()
	h := j.handle
	selectedLen := int64(0)
	if h != nil {
		selectedLen = h.SelectedLength()
	}
	j.stateMu.Unlock()
	if (st == StateStreaming || st == StateComplete) && h != nil {
		return snap, &torrentReaderSource{handle: h, length: selectedLen}
	}
	return snap, nil
}

// Files returns the sanitized file listing once metadata is available.
func (m *Manager) Files(id string) ([]TorrentFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.purgeEvicted()
	sess, ok := m.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	j := sess.job
	j.stateMu.Lock()
	defer j.stateMu.Unlock()
	if j.state != StateBuffering {
		return nil, ErrNotListed
	}
	out := make([]TorrentFile, len(j.files))
	copy(out, j.files)
	return out, nil
}

// Select validates the one-video + optional-subtitle contract.
func (m *Manager) Select(id, videoFileID, subtitleFileID string) (Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.purgeEvicted()
	sess, ok := m.sessions[id]
	if !ok {
		return Snapshot{}, ErrNotFound
	}
	j := sess.job
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

// Cancel stops the job and frees the session. Cancel on an evicted job is
// idempotent. After <-j.done, refs are re-read under stateMu so that
// concurrent eviction (which nils them via cleanupSession) is safe —
// Cancel only closes what is still non-nil.
func (m *Manager) Cancel(id string) (Snapshot, error) {
	m.mu.Lock()
	sess, ok := m.sessions[id]
	if !ok {
		if e, isEvicted := m.evicted[id]; isEvicted {
			m.mu.Unlock()
			return e.snap, nil
		}
		m.mu.Unlock()
		return Snapshot{}, ErrNotFound
	}
	j := sess.job
	m.mu.Unlock()
	if j.cancel != nil {
		j.cancel()
	}
	<-j.done
	// Re-read refs AFTER run finished. cleanupSession nils them on
	// error/cancel paths; on the complete path they stay non-nil.
	j.stateMu.Lock()
	h := j.handle
	eng := sess.engine
	j.handle = nil
	sess.engine = nil
	j.stateMu.Unlock()
	if h != nil {
		_ = h.Close()
	}
	if eng != nil {
		if m.engineCloser != nil {
			_ = m.engineCloser(eng)
		} else {
			_ = eng.Close()
		}
	}
	// Remove from sessions map.
	m.mu.Lock()
	delete(m.sessions, id)
	for i, oid := range m.sessionOrder {
		if oid == id {
			m.sessionOrder = append(m.sessionOrder[:i], m.sessionOrder[i+1:]...)
			break
		}
	}
	m.mu.Unlock()
	return Snapshot{ID: id, State: StateCancelled}, nil
}

// Close cancels all active jobs and frees the session. Idempotent.
func (m *Manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	toCancel := make([]*torrentSession, 0, len(m.sessions))
	for _, sess := range m.sessions {
		toCancel = append(toCancel, sess)
	}
	m.mu.Unlock()
	for _, sess := range toCancel {
		j := sess.job
		if j.cancel != nil {
			j.cancel()
		}
		<-j.done
		// Re-read refs after run finished, close only if non-nil, then nil.
		j.stateMu.Lock()
		h := j.handle
		eng := sess.engine
		j.handle = nil
		sess.engine = nil
		j.stateMu.Unlock()
		if h != nil {
			_ = h.Close()
		}
		if eng != nil {
			if m.engineCloser != nil {
				_ = m.engineCloser(eng)
			} else {
				_ = eng.Close()
			}
		}
	}
	return nil
}

func (m *Manager) clear(j *torrentJob) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, j.id)
	for i, id := range m.sessionOrder {
		if id == j.id {
			m.sessionOrder = append(m.sessionOrder[:i], m.sessionOrder[i+1:]...)
			break
		}
	}
}

// cleanupRun closes the handle and engine. Called exactly once per error or
// cancel path. On the complete path, handle+engine stay alive for media
// serving and are closed by Cancel/Close/evict when the session ends.
func cleanupRun(handle TorrentHandle, engine Engine, engineCloser func(Engine) error) {
	if handle != nil {
		_ = handle.Close()
	}
	if engine != nil {
		if engineCloser != nil {
			_ = engineCloser(engine)
		} else {
			_ = engine.Close()
		}
	}
}

// cleanupSession releases handle+engine and nils the refs under stateMu
// so Cancel/Close/evict never double-close. Called on error/cancel paths.
// On the complete path, handle+engine stay alive for media serving and
// are cleaned up when Cancel/Close/evict closes the session.
func (m *Manager) cleanupSession(j *torrentJob, sess *torrentSession, handle TorrentHandle, engine Engine) {
	cleanupRun(handle, engine, m.engineCloser)
	j.stateMu.Lock()
	j.handle = nil
	sess.engine = nil
	j.stateMu.Unlock()
}

func (m *Manager) run(j *torrentJob, ctx context.Context, sess *torrentSession) {
	defer close(j.done)

	// Create a fresh Engine for this session.
	engine, err := m.engineFactory()
	if err != nil {
		j.setErrorWithCode("engine creation failed", ErrCodeEngineFailed)
		j.setState(StateError)
		m.clear(j)
		return
	}
	j.stateMu.Lock()
	sess.engine = engine
	j.stateMu.Unlock()

	j.setState(StateDownloading)
	metaStart := time.Now()
	metaCtx, metaCancel := context.WithTimeout(ctx, m.timeout)
	defer metaCancel()

	handle, err := engine.Start(metaCtx, j.magnet)
	if err != nil {
		if metaCtx.Err() != nil && ctx.Err() == nil {
			if m.onMetadataTimeout != nil {
				m.onMetadataTimeout(time.Since(metaStart))
			}
			j.setErrorWithCode("metadata timed out", ErrCodeMetadataTimeout)
			j.setState(StateError)
			m.clear(j)
		} else if ctx.Err() != nil {
			j.setState(StateCancelled)
			m.clear(j)
		} else {
			j.setErrorWithCode("metadata failed", ErrCodeMetadataFailed)
			j.setState(StateError)
			m.clear(j)
		}
		m.cleanupSession(j, sess, nil, engine)
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
		j.setErrorWithCode("no playable video", ErrCodeNoPlayableVideo)
		j.setState(StateError)
		m.clear(j)
		m.cleanupSession(j, sess, handle, engine)
		return
	}

	j.stateMu.Lock()
	j.files = files
	j.stateMu.Unlock()
	j.setState(StateBuffering)

	select {
	case <-j.selected:
	case <-ctx.Done():
		j.setState(StateCancelled)
		m.clear(j)
		m.cleanupSession(j, sess, handle, engine)
		return
	}

	j.setState(StateStreaming)
	bootCtx, bootCancel := context.WithCancel(ctx)
	defer bootCancel()
	if err := handle.StartBootstrap(bootCtx); err != nil {
		j.setErrorWithCode("reader failed", ErrCodeReaderFailed)
		j.setState(StateError)
		m.clear(j)
		m.cleanupSession(j, sess, handle, engine)
		return
	}

	poll := time.NewTicker(200 * time.Millisecond)
	defer poll.Stop()
	for {
		select {
		case <-ctx.Done():
			j.setState(StateCancelled)
			m.clear(j)
			m.cleanupSession(j, sess, handle, engine)
			return
		case <-poll.C:
			avail := handle.AvailablePrefix()
			total := handle.SelectedLength()
			if avail >= total && total > 0 {
				bootCancel()
				j.setState(StateComplete)
				// Handle and engine stay alive for media serving.
				// They will be closed when Cancel/Close/evict runs.
				return
			}
		}
	}
}

// SelectedMediaType returns the conservative HTTP media type.
func (m *Manager) SelectedMediaType() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sessionOrder) == 0 {
		return ""
	}
	lastID := m.sessionOrder[len(m.sessionOrder)-1]
	sess, ok := m.sessions[lastID]
	if !ok {
		return ""
	}
	j := sess.job
	j.stateMu.Lock()
	vv := j.videoV
	j.stateMu.Unlock()
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

// AvailablePrefix returns the verified contiguous prefix length.
func (m *Manager) AvailablePrefix() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sessionOrder) == 0 {
		return 0
	}
	lastID := m.sessionOrder[len(m.sessionOrder)-1]
	sess, ok := m.sessions[lastID]
	if !ok {
		return 0
	}
	j := sess.job
	j.stateMu.Lock()
	h := j.handle
	j.stateMu.Unlock()
	if h == nil {
		return 0
	}
	return h.AvailablePrefix()
}

// torrentReaderSource wraps the engine's torrent reader as a GrowingSource.
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
