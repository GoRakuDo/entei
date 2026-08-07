package job

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
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
	mode   Mode   // quality (default) or speed — fixed for the job's lifetime
	dir    string // private temp dir, owned by the job
	cancel context.CancelFunc
	done   chan struct{}
	cmd    *exec.Cmd
	src    *JobSource

	stateMu  sync.Mutex
	state    State
	errMsg   string
	timedOut atomic.Bool

	bytes        atomicInt64 // current media bytes on disk (polled)
	quality      atomicInt64 // selected format height (0 = unknown, set once)
	subtitlePath string      // path to selected Japanese subtitle file (VTT)
	partMu       sync.Mutex
	partPath     string // growing .part file path (speed mode streaming), "" if none
}

func (j *job) setState(s State) { j.stateMu.Lock(); j.state = s; j.stateMu.Unlock() }
func (j *job) getState() State  { j.stateMu.Lock(); defer j.stateMu.Unlock(); return j.state }

// setError publishes the terminal error state together with its message
// under one stateMu acquisition, so snapshot never observes a torn
// (state, message) pair. errMsg is write-only under stateMu afterwards.
func (j *job) setError(msg string) {
	j.stateMu.Lock()
	j.errMsg = msg
	j.state = StateError
	j.stateMu.Unlock()
}

// setCompleted publishes the servable media source and the terminal
// complete state under one stateMu acquisition. snapshot and
// completedSource read both fields under stateMu, so an observer sees a
// consistent (src, state) pair — never StateComplete with a nil src.
func (j *job) setCompleted(src *JobSource, size int64) {
	j.stateMu.Lock()
	j.src = src
	j.state = StateComplete
	j.stateMu.Unlock()
	j.bytes.store(size)
}

// completedSource returns the servable media source when the job is
// complete, else nil. This is the second read path for j.src (besides
// snapshot); it takes stateMu because finalize assigns src under the same
// lock.
func (j *job) completedSource() media.GrowingSource {
	j.stateMu.Lock()
	defer j.stateMu.Unlock()
	if j.state != StateComplete {
		return nil
	}
	return j.src
}

// snapshot returns the redacted public view. The URL, paths, command line,
// and helper output are never included.
func (j *job) snapshot() Snapshot {
	j.stateMu.Lock()
	defer j.stateMu.Unlock()
	snap := Snapshot{ID: j.id, State: j.state, Mode: j.mode, Quality: int(j.quality.load())}
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

// Start validates the URL and begins a new job in the given download mode
// (default quality). Exactly one job may be active at a time: ErrConflict is
// returned while another exists. The returned snapshot is metadata-only.
func (m *Manager) Start(rawURL string, modes ...Mode) (Snapshot, error) {
	canonical, err := youtube.ValidateURL(rawURL)
	if err != nil {
		return Snapshot{}, err // generic; never echoes the URL
	}
	mode := ModeQuality
	if len(modes) > 0 && modes[0] != "" {
		mode = modes[0]
	}
	if !ValidMode(mode) {
		return Snapshot{}, ErrInvalidMode
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
		mode:  mode,
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

// ActiveMedia returns the current job's redacted snapshot and the servable
// media source, if any. Source selection:
//   - complete → the finished JobSource (fully available)
//   - speed mode + downloading → a PartSource over the growing .part file
//     (instant playback: bytes 0..available are servable while downloading)
//   - otherwise → nil (source not servable yet)
//
// It is used by the media/status bridge to surface the active session. A
// completed source stays servable until the session is cancelled or the
// manager closes.
func (m *Manager) ActiveMedia() (Snapshot, media.GrowingSource) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return Snapshot{}, nil
	}
	j := m.current
	snap := j.snapshot()
	switch snap.State {
	case StateComplete:
		return snap, j.completedSource()
	case StateDownloading, StateBuffering:
		if snap.Mode == ModeSpeed {
			j.partMu.Lock()
			path := j.partPath
			j.partMu.Unlock()
			if path != "" {
				return snap, NewPartSource(path)
			}
		}
	}
	return snap, nil
}

// PartPath returns the current growing .part file path for the active
// speed-mode job, or "" when none. Used by the HTTP layer to size/stream
// the partial file.
func (m *Manager) PartPath() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return ""
	}
	j := m.current
	j.partMu.Lock()
	defer j.partMu.Unlock()
	return j.partPath
}

// Height returns the selected format's height (0 = unknown/not yet known).
func (m *Manager) Height() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return 0
	}
	j := m.current
	return int(j.quality.load())
}

// SelectedSubtitleContent returns the text content of the selected Japanese
// subtitle file for the active job. Returns an error when no job is active,
// the job is not complete, or no subtitle was found.
func (m *Manager) SelectedSubtitleContent(ctx context.Context) (string, error) {
	_ = ctx // os.ReadFile is synchronous; ctx kept for interface symmetry with torrent.SelectedSubtitleContent
	m.mu.Lock()
	j := m.current
	m.mu.Unlock()
	if j == nil {
		return "", errors.New("no active job")
	}
	j.stateMu.Lock()
	state := j.state
	subPath := j.subtitlePath
	j.stateMu.Unlock()
	if state != StateComplete {
		return "", errors.New("job not complete")
	}
	if subPath == "" {
		return "", errors.New("subtitle not available")
	}
	data, err := os.ReadFile(subPath)
	if err != nil {
		return "", errors.New("subtitle not available")
	}
	return string(data), nil
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
		removeAllBestEffort(j.dir)
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
			removeAllBestEffort(j.dir)
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
		j.setError("internal error")
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

	cmd := exec.CommandContext(ctx, m.helper, helperArgs(dir, j.url, j.mode)...)
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
			removeAllBestEffort(dir)
			j.setState(StateCancelled)
			m.clear(j)
			return
		}
		// Cleanup BEFORE the terminal error state is published (the same
		// ordering as every other error path): an observer must never see
		// StateError while the private job dir still exists.
		removeAllBestEffort(dir)
		j.setError("download failed")
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
			removeAllBestEffort(dir)
			if j.timedOut.Load() {
				// A timeout is a failure: the redacted error job stays
				// current until explicitly cancelled (like other errors).
				j.setError("timed out")
			} else {
				j.setState(StateCancelled)
				m.clear(j) // user cancel: session freed (Cancel also clears)
			}
			return
		case err := <-waitCh:
			j.refreshDownloadState(dir)
			if ctx.Err() != nil {
				// The process finished at the same moment as a cancel/timeout;
				// the cancel path wins so no media survives a cancelled session.
				closeLog()
				removeAllBestEffort(dir)
				if j.timedOut.Load() {
					j.setError("timed out")
				} else {
					j.setState(StateCancelled)
					m.clear(j)
				}
				return
			}
			if err != nil {
				// Cleanup BEFORE the terminal error state is published:
				// close the stderr log (an open handle blocks RemoveAll on
				// Windows) and remove the private dir first, so an observer
				// never sees StateError while the dir still exists.
				closeLog()
				removeAllBestEffort(dir)
				j.setError("download failed")
				return // errored job stays current until cancelled
			}
			closeLog() // helper exited; no more stderr writes. Required before
			// any RemoveAll (open handles block directory removal on Windows).
			if !m.finalize(j, dir) {
				return // finalize already cleaned up and cleared
			}
			return
		case <-ticker.C:
			j.refreshDownloadState(dir)
		}
	}
}

// refreshDownloadState snapshots the growing download state during the run:
//   - bytes: current media bytes on disk (media.<ext> or media.<ext>.part)
//   - partPath: the growing .part file (speed mode instant playback)
//   - quality: the selected format height from height.txt, read once
func (j *job) refreshDownloadState(dir string) {
	j.bytes.store(mediaBytes(dir))
	j.partMu.Lock()
	j.partPath = partMediaPath(dir)
	j.partMu.Unlock()
	if j.quality.load() == 0 {
		if h, err := readHeightFile(filepath.Join(dir, "height.txt")); err == nil && h > 0 {
			j.quality.store(int64(h))
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
		// Cleanup BEFORE the terminal error state is published (the same
		// ordering as every run() error path): observers must never see
		// StateError while the private job dir still exists.
		removeAllBestEffort(dir)
		j.setError("no media produced")
		return false // errored job stays current until cancelled
	}
	src, err := NewJobSource(path, size)
	if err != nil {
		removeAllBestEffort(dir)
		j.setError("media unavailable")
		return false // errored job stays current until cancelled
	}
	// Select the best Japanese subtitle file (manual preferred over auto).
	j.subtitlePath = selectJapaneseSubtitle(dir)
	j.refreshDownloadState(dir) // capture part path + height for the toast
	j.setCompleted(src, size)
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

// partMediaPath returns the largest growing `.part` file in dir, or "".
// yt-dlp writes `media.<ext>.part` and renames it to `media.<ext>` on
// completion (speed mode streams the `.part` while it grows).
func partMediaPath(dir string) string {
	matches, err := filepath.Glob(filepath.Join(dir, "media.*.part"))
	if err != nil {
		return ""
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
	return best
}

// readHeightFile parses the selected format height written by yt-dlp's
// `--print-to-file "%(height)s"`. Returns (0, error) when absent/malformed.
func readHeightFile(path string) (int, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || n <= 0 {
		return 0, errors.New("invalid height")
	}
	return n, nil
}

// selectJapaneseSubtitle finds the best Japanese subtitle file in dir.
// Preference order: manual (*.ja.vtt) > auto (*.ja-orig.vtt).
// yt-dlp writes subtitles as media.ja.vtt (manual) and media.ja-orig.vtt
// (auto-generated original language). The --sub-langs "ja.*" regex avoids
// false matches on future codes like "jam" because it requires ".ja." or
// ".ja-" before the extension.
func selectJapaneseSubtitle(dir string) string {
	matches, err := filepath.Glob(filepath.Join(dir, "*.vtt"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	// Collect Japanese subtitle files: manual has ".ja." (but not
	// ".ja-orig."), auto-generated has ".ja-orig.".
	var jaManual, jaAuto []string
	for _, p := range matches {
		base := filepath.Base(p)
		if strings.Contains(base, ".ja-orig.") {
			jaAuto = append(jaAuto, p)
		} else if strings.Contains(base, ".ja.") {
			jaManual = append(jaManual, p)
		}
	}
	// Prefer manual over auto.
	if len(jaManual) > 0 {
		return jaManual[0]
	}
	if len(jaAuto) > 0 {
		return jaAuto[0]
	}
	return ""
}

// removeAllBestEffort removes the private job dir, retrying briefly.
//
// After a cancel the killed helper tree (python/ffmpeg children of the
// wrapper) may still hold open media-file handles for a few hundred
// milliseconds, and on Windows os.RemoveAll fails while any file inside
// the directory is open. The retry absorbs that termination tail so the
// private job dir (with raw helper output inside) does not leak. All job
// material is manager-owned; user files are never touched.
func removeAllBestEffort(dir string) {
	// Killed helper children (python/ffmpeg) can hold open media-file
	// handles for a few seconds while they terminate; give the removal a
	// generous margin (5s) before giving up.
	const attempts = 25
	for i := 0; i < attempts; i++ {
		if err := os.RemoveAll(dir); err == nil || !pathExists(dir) {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// atomicInt64 is a tiny atomic int64 wrapper (sync/atomic has typed
// primitives; this keeps call sites clean).
type atomicInt64 struct{ v atomic.Int64 }

func (a *atomicInt64) store(n int64) { a.v.Store(n) }
func (a *atomicInt64) load() int64   { return a.v.Load() }
