package job

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"eizoudendenshi/internal/media"
	"eizoudendenshi/internal/youtube"
)

// defaultTimeout is the per-job download timeout when Config.Timeout is zero.
const defaultTimeout = 30 * time.Minute

// pollInterval is how often the manager snapshots the job directory to
// observe media bytes on disk while the helper runs.
const pollInterval = 200 * time.Millisecond

// Config pins the download helper and the per-job timeout. HelperPath is
// required and is never derived from a request.
type Config struct {
	// HelperPath is the pinned path to the yt-dlp-compatible helper
	// executable. Required.
	HelperPath string
	// Timeout bounds the whole job (spawn → final media). Zero selects the
	// default (30 minutes).
	Timeout time.Duration
}

// Manager supervises the single active job (one-session policy).
type Manager struct {
	mu      sync.Mutex
	helper  string
	timeout time.Duration
	current *job
	closed  bool
}

// New validates the configuration and builds a Manager. It fails fast on a
// missing helper path (startup-time; the API never surfaces it).
func New(cfg Config) (*Manager, error) {
	if cfg.HelperPath == "" {
		return nil, errors.New("helper path required")
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = defaultTimeout
	}
	return &Manager{helper: cfg.HelperPath, timeout: cfg.Timeout}, nil
}

// job is the internal supervised job. Everything sensitive lives here and
// never leaves the package: the URL, the private temp dir, the command.
type job struct {
	id     string
	url    string // canonical URL; passed only as the final helper argv
	dir    string // private temp dir, owned by the job
	cancel context.CancelFunc
	done   chan struct{}
	cmd    *exec.Cmd
	src    *JobSource

	stateMu  sync.Mutex
	state    State
	errMsg   string
	timedOut atomic.Bool

	bytes atomicInt64 // current media bytes on disk (polled)
}

func (j *job) setState(s State) { j.stateMu.Lock(); j.state = s; j.stateMu.Unlock() }
func (j *job) getState() State  { j.stateMu.Lock(); defer j.stateMu.Unlock(); return j.state }

// snapshot returns the redacted public view. The URL, paths, command line,
// and helper output are never included.
func (j *job) snapshot() Snapshot {
	j.stateMu.Lock()
	defer j.stateMu.Unlock()
	snap := Snapshot{ID: j.id, State: j.state}
	if j.state == StateError {
		snap.Error = j.errMsg
	}
	if j.src != nil {
		total := j.src.Total()
		snap.Media = Media{Available: total, Total: total}
	} else {
		snap.Media = Media{Available: j.bytes.load(), Total: 0}
	}
	return snap
}

// Start validates the URL and begins a new job. Exactly one job may be
// active at a time: ErrConflict is returned while another exists. The
// returned snapshot is metadata-only.
func (m *Manager) Start(rawURL string) (Snapshot, error) {
	canonical, err := youtube.ValidateURL(rawURL)
	if err != nil {
		return Snapshot{}, err // generic; never echoes the URL
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Snapshot{}, errors.New("manager closed")
	}
	if m.current != nil {
		return Snapshot{}, ErrConflict
	}
	j := &job{
		id:    newJobID(),
		url:   canonical,
		done:  make(chan struct{}),
		state: StateQueued, // observable before the run loop transitions it
	}
	// The cancel context is created synchronously so Cancel/Close can
	// always interrupt the job, even before the run loop starts.
	ctx, cancel := context.WithCancel(context.Background())
	j.cancel = cancel
	m.current = j
	go m.run(j, ctx)
	return j.snapshot(), nil
}

// Current returns the snapshot of the active job, or nil when none exists.
func (m *Manager) Current() *Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return nil
	}
	snap := m.current.snapshot()
	return &snap
}

// Get returns the snapshot for id, or nil when no such job exists (cancelled
// jobs are gone).
func (m *Manager) Get(id string) *Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.current.id != id {
		return nil
	}
	snap := m.current.snapshot()
	return &snap
}

// ActiveMedia returns the current job's redacted snapshot and, when the job
// is complete, its servable media source. It is used by the media/status
// bridge to surface the active session. A completed source stays servable
// until the session is cancelled or the manager closes.
func (m *Manager) ActiveMedia() (Snapshot, media.GrowingSource) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return Snapshot{}, nil
	}
	snap := m.current.snapshot()
	var src media.GrowingSource
	if m.current.src != nil && m.current.getState() == StateComplete {
		src = m.current.src
	}
	return snap, src
}

// Cancel stops the job (killing the helper tree), removes its private temp
// directory, and frees the session. It returns a redacted cancelled
// snapshot. Cancelling a completed job also removes its served media.
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
	<-j.done // the run loop performs cleanup and closes done

	m.mu.Lock()
	if m.current == j {
		m.current = nil
	}
	m.mu.Unlock()
	if j.src != nil {
		_ = j.src.Close()
	}
	if j.dir != "" {
		_ = os.RemoveAll(j.dir)
	}
	return Snapshot{ID: id, State: StateCancelled}, nil
}

// Close cancels the active job (if any) and frees the session. It is
// idempotent.
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
		if j.src != nil {
			_ = j.src.Close()
		}
		if j.dir != "" {
			_ = os.RemoveAll(j.dir)
		}
	}
	return nil
}

// clear removes the current job reference (called by the run loop on
// terminal cleanup).
func (m *Manager) clear(j *job) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == j {
		m.current = nil
	}
}

// run supervises one job end to end. On exit the job's done channel is
// closed after all cleanup. ctx is the job's cancel context, created
// synchronously by Start so cancellation never races the goroutine start.
func (m *Manager) run(j *job, ctx context.Context) {
	defer close(j.done)

	dir, err := os.MkdirTemp("", "entei-job-*")
	if err != nil {
		j.errMsg = "internal error"
		j.setState(StateError)
		return // errored job stays current (redacted) until cancelled
	}
	_ = os.Chmod(dir, 0o700)
	j.dir = dir

	// Per-job timeout: on expiry mark the job as timed out and cancel,
	// which drives the run loop's cancel path.
	var timer *time.Timer
	if m.timeout > 0 {
		timer = time.AfterFunc(m.timeout, func() {
			j.timedOut.Store(true)
			j.cancel()
		})
		defer timer.Stop()
	}

	cmd := exec.CommandContext(ctx, m.helper, helperArgs(dir, j.url)...)
	cmd.Dir = dir
	cmd.SysProcAttr = newSysProcAttr()
	// Helper output is captured only to the private job dir; it is never
	// surfaced by the API. The log handle must be closed BEFORE any
	// os.RemoveAll: on Windows a directory containing an open handle cannot
	// be removed, and leaving it open would leak the job dir (with the raw
	// helper output inside it) on every error/cancel path.
	closeLog := func() {}
	if logf, err := os.Create(filepath.Join(dir, "helper.stderr.log")); err == nil {
		cmd.Stderr = logf
		closeLog = func() { _ = logf.Close() }
	}
	j.cmd = cmd

	j.setState(StateDownloading)
	if err := cmd.Start(); err != nil {
		closeLog()
		if ctx.Err() != nil {
			// Cancelled before the helper launched (CommandContext Start
			// returns the context error in that race): treat as cancelled.
			_ = os.RemoveAll(dir)
			j.setState(StateCancelled)
			m.clear(j)
			return
		}
		j.errMsg = "download failed"
		j.setState(StateError)
		_ = os.RemoveAll(dir)
		// The errored job stays current (redacted) until explicitly
		// cancelled, so the status endpoint can surface the failure.
		return
	}

	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// Cancelled (or timed out). Kill the tree, reap, clean up.
			killTree(cmd)
			<-waitCh
			closeLog()
			_ = os.RemoveAll(dir)
			if j.timedOut.Load() {
				// A timeout is a failure: the redacted error job stays
				// current until explicitly cancelled (like other errors).
				j.errMsg = "timed out"
				j.setState(StateError)
			} else {
				j.setState(StateCancelled)
				m.clear(j) // user cancel: session freed (Cancel also clears)
			}
			return
		case err := <-waitCh:
			j.bytes.store(mediaBytes(dir))
			if ctx.Err() != nil {
				// The process finished at the same moment as a cancel/timeout;
				// the cancel path wins so no media survives a cancelled session.
				closeLog()
				_ = os.RemoveAll(dir)
				if j.timedOut.Load() {
					j.errMsg = "timed out"
					j.setState(StateError)
				} else {
					j.setState(StateCancelled)
					m.clear(j)
				}
				return
			}
			if err != nil {
				j.errMsg = "download failed"
				j.setState(StateError)
				closeLog()
				_ = os.RemoveAll(dir)
				return // errored job stays current until cancelled
			}
			closeLog() // helper exited; no more stderr writes. Required before
			// any RemoveAll (open handles block directory removal on Windows).
			if !m.finalize(j, dir) {
				return // finalize already cleaned up and cleared
			}
			return
		case <-ticker.C:
			j.bytes.store(mediaBytes(dir))
		}
	}
}

// finalize resolves the produced media file after a successful helper run.
// It returns false when finalization failed (the job was already cleaned
// up and cleared).
func (m *Manager) finalize(j *job, dir string) bool {
	j.setState(StateBuffering)
	path, size, ok := largestMedia(dir)
	if !ok || size <= 0 {
		j.errMsg = "no media produced"
		j.setState(StateError)
		_ = os.RemoveAll(dir)
		return false // errored job stays current until cancelled
	}
	src, err := NewJobSource(path, size)
	if err != nil {
		j.errMsg = "media unavailable"
		j.setState(StateError)
		_ = os.RemoveAll(dir)
		return false // errored job stays current until cancelled
	}
	j.src = src
	j.bytes.store(size)
	j.setState(StateComplete)
	return true
}

// largestMedia returns the largest media.* regular file in dir and its
// size. The job dir contains only job-owned files; user files are never
// scanned.
func largestMedia(dir string) (string, int64, bool) {
	matches, err := filepath.Glob(filepath.Join(dir, "media.*"))
	if err != nil {
		return "", 0, false
	}
	var best string
	var bestSize int64
	for _, p := range matches {
		st, err := os.Stat(p)
		if err != nil || st.IsDir() {
			continue
		}
		if st.Size() > bestSize {
			best, bestSize = p, st.Size()
		}
	}
	if best == "" {
		return "", 0, false
	}
	return best, bestSize, true
}

// mediaBytes reports the current bytes on disk for the job's media file(s).
func mediaBytes(dir string) int64 {
	_, size, ok := largestMedia(dir)
	if !ok {
		return 0
	}
	return size
}

// atomicInt64 is a tiny atomic int64 wrapper (sync/atomic has typed
// primitives; this keeps call sites clean).
type atomicInt64 struct{ v atomic.Int64 }

func (a *atomicInt64) store(n int64) { a.v.Store(n) }
func (a *atomicInt64) load() int64   { return a.v.Load() }
