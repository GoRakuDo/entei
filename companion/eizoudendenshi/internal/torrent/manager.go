package torrent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"eizoudendenshi/internal/diag"
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
	// Client re-adds the same infohash after Drop). The factory receives
	// the session's private storage directory (absolute, already created).
	EngineFactory EngineFactory

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

	// StorageRoot is the parent directory for per-session private storage
	// dirs. Empty selects the persistent data dir (defaultStorageRoot) —
	// never the OS temp dir (Ramdisk bbolt hazard). The root is never
	// removed; only per-session subdirectories are (plus stale session-*
	// dirs via CleanupStaleSessions).
	StorageRoot string

	// Logger, when set, receives sanitized job lifecycle diagnostics
	// (component "torrent"). Nil keeps the historical no-logging behavior.
	// The log content contract (see internal/diag): job ids, short
	// infohashes (first 12 hex chars), error codes and counts only — never
	// the magnet, tracker URLs, full infohashes, paths or credentials.
	Logger *diag.Logger
}

const (
	defaultTimeout = 2 * time.Minute
)

// torrentSession is a torrent job session with its own Engine.
type torrentSession struct {
	job     *torrentJob
	engine  Engine
	created time.Time
	// storageDir is the session-private storage directory (absolute,
	// created by the Manager at Start). Removed after the session ends.
	storageDir string
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
	engineFactory     EngineFactory
	engineCloser      func(Engine) error
	timeout           time.Duration
	evictedTTL        time.Duration
	onMetadataTimeout func(elapsed time.Duration)
	logger            *diag.Logger // nil-safe diagnostic sink
	sessions          map[string]*torrentSession
	sessionOrder      []string
	evicted           map[string]*evictedState
	closed            bool
	storageRoot       string
}

// defaultStorageRoot resolves the persistent per-session storage root,
// mirroring diag.DefaultDir's platform pattern:
//
//   - Windows: %LOCALAPPDATA%\GoRakuDo\EizouDendenshi\torrent-sessions;
//   - Android/Termux ($PREFIX set): $PREFIX/var/lib/eizouden/torrent-sessions;
//   - other platforms: os.UserCacheDir()/GoRakuDo/EizouDendenshi/torrent-sessions.
//
// The OS temp dir must be avoided for bbolt: it mmaps the piece-completion
// DB, and a Ramdisk temp (e.g. A:\Temp) fails to open the bolt DB → anacrolix
// falls back to an in-memory Map pieceCompletion → storageCompletionOk stays
// false → every piece's effectivePriority is None → the download stalls.
// There is therefore NO os.TempDir() fallback: when the user cache dir is
// unavailable, the caller must supply StorageRoot explicitly instead of
// silently re-introducing the Ramdisk hazard.
func defaultStorageRoot() (string, error) {
	var base string
	switch {
	case runtime.GOOS == "windows":
		b := os.Getenv("LOCALAPPDATA")
		if b == "" {
			return "", errors.New("torrent: LOCALAPPDATA not set")
		}
		base = filepath.Join(b, "GoRakuDo", "EizouDendenshi")
	case os.Getenv("PREFIX") != "":
		base = filepath.Join(os.Getenv("PREFIX"), "var", "lib", "eizouden")
	default:
		if base, err := os.UserCacheDir(); err == nil && base != "" {
			return filepath.Join(base, "GoRakuDo", "EizouDendenshi", "torrent-sessions"), nil
		}
		return "", errors.New("torrent: user cache dir unavailable; set StorageRoot explicitly")
	}
	return filepath.Join(base, "torrent-sessions"), nil
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
	storageRoot := cfg.StorageRoot
	if storageRoot == "" {
		dir, err := defaultStorageRoot()
		if err != nil {
			return nil, fmt.Errorf("torrent storage root: %w", err)
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("torrent storage root: %w", err)
		}
		storageRoot = dir
	} else {
		// A caller-provided root is validated but never removed.
		abs, err := filepath.Abs(storageRoot)
		if err != nil {
			return nil, fmt.Errorf("torrent storage root: %w", err)
		}
		if err := os.MkdirAll(abs, 0o700); err != nil {
			return nil, fmt.Errorf("torrent storage root: %w", err)
		}
		storageRoot = abs
	}
	return &Manager{
		engineFactory:     cfg.EngineFactory,
		engineCloser:      cfg.EngineCloser,
		timeout:           cfg.Timeout,
		evictedTTL:        evictedTTL,
		onMetadataTimeout: cfg.OnMetadataTimeout,
		logger:            cfg.Logger,
		sessions:          make(map[string]*torrentSession),
		evicted:           make(map[string]*evictedState),
		storageRoot:       storageRoot,
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
	// Each session gets its own private storage directory (absolute, under
	// the manager's storage root). Session storage is never shared, so
	// concurrent sessions cannot collide on anacrolix state and the
	// piece-completion DB is opened at an explicit path.
	storageDir, err := os.MkdirTemp(m.storageRoot, "session-")
	if err != nil {
		cancel()
		return Snapshot{}, fmt.Errorf("torrent session storage: %w", err)
	}
	sess := &torrentSession{job: j, created: time.Now(), storageDir: storageDir}
	m.sessions[j.id] = sess
	m.sessionOrder = append(m.sessionOrder, j.id)
	// Sanitized creation line: job id + shortened infohash (first 12 hex
	// chars) only — never the magnet or tracker data.
	m.logger.Infof("torrent", "job=%s infohash=%s created", j.id, diag.ShortInfohash(canonical))
	go m.run(j, ctx, sess)
	return j.snapshot(), nil
}

// evictOldestLocked moves the oldest session to evicted cache and cancels
// its context. For sessions where run has completed (handle+engine still
// alive), closes them here. For sessions where run is still active, the
// run goroutine notices ctx.Done and cleans up via cleanupSession.
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
	m.logger.Warnf("torrent", "job=%s evicted code=%s", oldestID, ErrCodeConcurrencyLimit)
	sess.job.setErrorWithCode("evicted: concurrent torrent limit exceeded", ErrCodeConcurrencyLimit)
	sess.job.setState(StateError)
	m.evicted[oldestID] = &evictedState{
		snap:    sess.job.snapshot(),
		expires: time.Now().Add(m.evictedTTL),
	}
	delete(m.sessions, oldestID)
	m.sessionOrder = m.sessionOrder[1:]
	// Cancel context: if run is still active, it notices ctx.Done and
	// cleans up via cleanupSession. If run has already returned (complete),
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
		m.releaseSession(h, eng, sess.storageDir)
	default:
		// Run still active; it will clean up via ctx.Done → cleanupSession.
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
// optionally a GrowingSource for media serving. The GrowingSource is now
// always nil for torrent — the torrent media path uses http.ServeContent
// with a direct Reader (NewMediaReader) instead.
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
	// Return nil — activeTorrentStatus uses the snapshot state only,
	// and serveTorrentMedia uses NewMediaReader + SelectedFileName.
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
	// File ids only — no paths, no sizes, no magnet data.
	m.logger.Infof("torrent", "job=%s select video=%s subtitle=%t", id, videoFileID, sub != nil)
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
	m.releaseSession(h, eng, sess.storageDir)
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
		m.releaseSession(h, eng, sess.storageDir)
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

// removeStorageDir removes a session storage directory the Manager created
// (always absolute). Only absolute paths are removed, so a misconfigured
// relative path can never delete something unintended; the storage root
// itself is never passed here. Removal is best-effort and idempotent.
func removeStorageDir(dir string) {
	if dir == "" || !filepath.IsAbs(dir) {
		return
	}
	_ = os.RemoveAll(dir)
}

// sessionDirEntry pairs a session-* directory name with its modification time
// for sorting during stale-session cleanup.
type sessionDirEntry struct {
	name    string
	modTime time.Time
}

// CleanupStaleSessions removes leftover session-* directories from a
// previous (possibly crashed) companion run. It lists all "session-"
// subdirectories under m.storageRoot, sorts them oldest-first by ModTime,
// and removes every entry except the newest one. Returns the number of
// directories removed. The storage root is immutable after construction,
// so no lock is needed.
//
// This method is intended to be called once at startup in a background
// goroutine so it never blocks the companion's startup path.
func (m *Manager) CleanupStaleSessions() int {
	root := m.storageRoot
	if root == "" {
		return 0
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0
	}

	// Collect session-* directories with their mod times.
	var sessions []sessionDirEntry
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "session-") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue // skip unreadable entries
		}
		sessions = append(sessions, sessionDirEntry{
			name:    e.Name(),
			modTime: info.ModTime(),
		})
	}

	// Need at least 2 to have anything to clean.
	if len(sessions) < 2 {
		return 0
	}

	// Sort oldest first so the newest (last) is preserved.
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].modTime.Before(sessions[j].modTime)
	})

	// Remove all but the last (newest) entry.
	removed := 0
	for _, s := range sessions[:len(sessions)-1] {
		removeStorageDir(filepath.Join(root, s.name))
		removed++
	}
	return removed
}

// releaseSession closes handle+engine and then removes the session's
// private storage dir. Order matters: the engine must be closed before its
// data dir is removed. Safe with nil refs; idempotent per call.
func (m *Manager) releaseSession(h TorrentHandle, eng Engine, storageDir string) {
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
	removeStorageDir(storageDir)
}

// cleanupSession releases handle+engine, removes the session storage dir,
// and nils the refs under stateMu so Cancel/Close/evict never double-close.
// Called on error/cancel paths. On the complete path, handle+engine stay
// alive for media serving and are cleaned up when Cancel/Close/evict closes
// the session.
func (m *Manager) cleanupSession(j *torrentJob, sess *torrentSession, handle TorrentHandle, engine Engine) {
	m.releaseSession(handle, engine, sess.storageDir)
	j.stateMu.Lock()
	j.handle = nil
	sess.engine = nil
	j.stateMu.Unlock()
}

func (m *Manager) run(j *torrentJob, ctx context.Context, sess *torrentSession) {
	defer close(j.done)

	// Create a fresh Engine for this session with its private storage dir.
	engine, err := m.engineFactory(sess.storageDir)
	if err != nil {
		m.logger.Errorf("torrent", "job=%s engine failed code=%s", j.id, ErrCodeEngineFailed)
		j.setErrorWithCode("engine creation failed", ErrCodeEngineFailed)
		j.setState(StateError)
		m.clear(j)
		removeStorageDir(sess.storageDir) // engine never created
		return
	}
	// Inject the diagnostic logger when the engine supports it (anacrolix
	// does; fake engines may not — they simply stay silent).
	if ls, ok := engine.(LoggerSettable); ok {
		ls.SetLogger(m.logger)
	}
	j.stateMu.Lock()
	sess.engine = engine
	j.stateMu.Unlock()

	j.setState(StateDownloading)
	m.logger.Infof("torrent", "job=%s metadata wait", j.id)
	metaStart := time.Now()
	metaCtx, metaCancel := context.WithTimeout(ctx, m.timeout)
	defer metaCancel()

	handle, err := engine.Start(metaCtx, j.magnet)
	if err != nil {
		if metaCtx.Err() != nil && ctx.Err() == nil {
			if m.onMetadataTimeout != nil {
				m.onMetadataTimeout(time.Since(metaStart))
			}
			m.logger.Warnf("torrent", "job=%s metadata timed out code=%s elapsed=%s", j.id, ErrCodeMetadataTimeout, time.Since(metaStart))
			j.setErrorWithCode("metadata timed out", ErrCodeMetadataTimeout)
			j.setState(StateError)
			m.clear(j)
		} else if ctx.Err() != nil {
			m.logger.Warnf("torrent", "job=%s metadata cancelled", j.id)
			j.setState(StateCancelled)
			m.clear(j)
		} else if errors.Is(err, errV2Unsupported) {
			m.logger.Warnf("torrent", "job=%s v2-only torrent not supported code=%s", j.id, ErrCodeV2Unsupported)
			j.setErrorWithCode("v2-only torrent not supported", ErrCodeV2Unsupported)
			j.setState(StateError)
			m.clear(j)
		} else {
			m.logger.Warnf("torrent", "job=%s metadata failed code=%s", j.id, ErrCodeMetadataFailed)
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
	m.logger.Infof("torrent", "job=%s metadata ok files=%d video=%t", j.id, len(files), hasVideo)
	if !hasVideo {
		m.logger.Warnf("torrent", "job=%s no video code=%s", j.id, ErrCodeNoPlayableVideo)
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
		m.logger.Warnf("torrent", "job=%s cancelled while awaiting selection", j.id)
		j.setState(StateCancelled)
		m.clear(j)
		m.cleanupSession(j, sess, handle, engine)
		return
	}

	j.setState(StateStreaming)
	m.logger.Infof("torrent", "job=%s streaming started", j.id)
	bootCtx, bootCancel := context.WithCancel(ctx)
	defer bootCancel()
	if err := handle.StartBootstrap(bootCtx); err != nil {
		m.logger.Errorf("torrent", "job=%s reader failed code=%s", j.id, ErrCodeReaderFailed)
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
			m.logger.Warnf("torrent", "job=%s cancelled", j.id)
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
				m.logger.Infof("torrent", "job=%s complete", j.id)
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

// AnchorSeek elevates the piece containing offset to PiecePriorityNow and
// surrounding pieces to PiecePriorityHigh. Called on HTTP Range requests so
// the seek position's data is fetched immediately, preventing the Chrome
// seek loop. No-op when no session is active.
func (m *Manager) AnchorSeek(offset int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sessionOrder) == 0 {
		return
	}
	lastID := m.sessionOrder[len(m.sessionOrder)-1]
	sess, ok := m.sessions[lastID]
	if !ok {
		return
	}
	j := sess.job
	j.stateMu.Lock()
	h := j.handle
	j.stateMu.Unlock()
	if h == nil {
		return
	}
	h.AnchorSeek(offset)
}

// NewMediaReader creates a seekable reader over the active session's
// selected video file. Reads block until data is available (piece
// completion) or ctx is done. The reader drives piece demand — seeks
// promote the needed pieces. The caller must close the reader.
func (m *Manager) NewMediaReader(ctx context.Context) (io.ReadSeekCloser, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.purgeEvicted()
	if len(m.sessionOrder) == 0 {
		return nil, errors.New("no active session")
	}
	lastID := m.sessionOrder[len(m.sessionOrder)-1]
	sess, ok := m.sessions[lastID]
	if !ok {
		return nil, errors.New("no active session")
	}
	j := sess.job
	j.stateMu.Lock()
	h := j.handle
	j.stateMu.Unlock()
	if h == nil {
		return nil, errors.New("no handle")
	}
	return h.Reader(ctx)
}

// NewHTTPMediaReader creates a seekable reader with a larger readahead
// window suitable for HTTP Range serving. The increased readahead
// ensures that after a seek to a mid-file position, enough forward
// pieces are requested to keep the 206 response flowing without stalls.
// The caller must close the reader.
func (m *Manager) NewHTTPMediaReader(ctx context.Context) (io.ReadSeekCloser, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.purgeEvicted()
	if len(m.sessionOrder) == 0 {
		return nil, errors.New("no active session")
	}
	lastID := m.sessionOrder[len(m.sessionOrder)-1]
	sess, ok := m.sessions[lastID]
	if !ok {
		return nil, errors.New("no active session")
	}
	j := sess.job
	j.stateMu.Lock()
	h := j.handle
	j.stateMu.Unlock()
	if h == nil {
		return nil, errors.New("no handle")
	}
	return h.HTTPReader(ctx)
}

// SelectedFileName returns the basename of the active session's selected
// video file (e.g. "movie.mkv"). Empty when no file is selected.
func (m *Manager) SelectedFileName() string {
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
	return vv.Path
}

// SelectedDiskPath returns the absolute on-disk path of the active
// session's selected video file. The path is derived from the
// session-private storage directory and the anacrolix torrent-relative
// path (which includes the torrent name prefix). Returns an error when
// no session is active, no file is selected, or the file does not exist.
//
// Currently unused in production (serveTorrentComplete removal);
// retained for future use and tested in TestManagerSelectedDiskPath.
func (m *Manager) SelectedDiskPath() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.purgeEvicted()
	if len(m.sessionOrder) == 0 {
		return "", errors.New("no active session")
	}
	lastID := m.sessionOrder[len(m.sessionOrder)-1]
	sess, ok := m.sessions[lastID]
	if !ok {
		return "", errors.New("no active session")
	}
	j := sess.job
	j.stateMu.Lock()
	vv := j.videoV
	j.stateMu.Unlock()
	if vv == nil {
		return "", errors.New("no file selected")
	}
	// anacrolix stores files at <DataDir>/<torrent-name>/<file-path>.
	// vv.Path is the torrent-relative path including the torrent name
	// prefix (e.g. "MovieName/file.mkv"). Combine with the session's
	// private storage directory to get the absolute disk path.
	abs := filepath.Clean(filepath.Join(sess.storageDir, vv.Path))
	// Path traversal defense: the resulting path must be under the
	// storage directory. filepath.Clean normalizes ".." segments, so
	// a prefix check after cleaning is sufficient.
	if !strings.HasPrefix(abs, sess.storageDir+string(filepath.Separator)) {
		return "", errors.New("path traversal rejected")
	}
	if _, err := os.Stat(abs); err != nil {
		return "", fmt.Errorf("file not available: %w", err)
	}
	return abs, nil
}

// SelectedSubtitleContent reads the entire selected subtitle file from the
// active session and returns its text content. Blocks until data is
// available or ctx is done. Returns an error when no subtitle is selected,
// no active session exists, or the read fails.
func (m *Manager) SelectedSubtitleContent(ctx context.Context) (string, error) {
	m.mu.Lock()
	if len(m.sessionOrder) == 0 {
		m.mu.Unlock()
		return "", errors.New("no active session")
	}
	lastID := m.sessionOrder[len(m.sessionOrder)-1]
	sess, ok := m.sessions[lastID]
	if !ok {
		m.mu.Unlock()
		return "", errors.New("no active session")
	}
	j := sess.job
	j.stateMu.Lock()
	h := j.handle
	hasSub := j.subV != nil
	j.stateMu.Unlock()
	m.mu.Unlock()
	if !hasSub {
		return "", errors.New("subtitle not selected")
	}
	if h == nil {
		return "", errors.New("no handle")
	}
	return h.SubtitleContent(ctx)
}

// CreationDate returns the active session's torrent creation date as a Unix
// timestamp. Used as the modtime for http.ServeContent so Chrome's If-Range
// header works correctly. Returns 0 when no session is active.
func (m *Manager) CreationDate() int64 {
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
	return h.CreationDate()
}
