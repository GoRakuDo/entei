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

	"eizoudendenshi/internal/diag"
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
	// Logger, when set, receives sanitized job-lifecycle diagnostics
	// (redaction-safe: no URLs, paths, tokens, or titles).
	Logger *diag.Logger
}

// Manager supervises the single active job (one-session policy).
type Manager struct {
	mu      sync.Mutex
	helper  string
	timeout time.Duration
	logger  *diag.Logger // nil-safe diagnostic sink
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
	return &Manager{helper: cfg.HelperPath, timeout: cfg.Timeout, logger: cfg.Logger}, nil
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

	bytes        atomicInt64  // current media bytes on disk (polled)
	quality      atomicInt64  // selected format height (0 = unknown, set once)
	title        atomicString // YouTube video title (read once from title.txt)
	subtitlePath string       // path to the selected Japanese subtitle file (VTT)
	partMu       sync.Mutex
	partPath     string      // growing .part file path (speed mode streaming), "" if none
	partSrc      *PartSource // persistent stream source over partPath (total pinned once)
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
	snap := Snapshot{ID: j.id, State: j.state, Mode: j.mode, Quality: int(j.quality.load()), Title: j.title.load()}
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
// (default speed, changed 2026-08-08 — instant-playback priority unified
// with the web DEFAULT_YT_MODE; an explicit "quality" still opts into the
// DASH-1080p wait-for-mux path). Exactly one job may be active at a time:
// ErrConflict is returned while another exists. The returned snapshot is
// metadata-only.
func (m *Manager) Start(rawURL string, modes ...Mode) (Snapshot, error) {
	canonical, err := youtube.ValidateURL(rawURL)
	if err != nil {
		return Snapshot{}, err // generic; never echoes the URL
	}
	mode := ModeSpeed
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
			src := j.partSrc
			if j.partPath != "" && src == nil {
				// First detection: the source is created ONCE per job and
				// reused, so the pinned total (SetTotal) survives across
				// ActiveMedia calls and polls.
				src = NewPartSource(j.partPath)
				j.partSrc = src
			}
			j.partMu.Unlock()
			if src != nil {
				return snap, src
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
// subtitle file for the active job. Returns an error when no job is active
// or no subtitle was found.
//
// The service read is gated ONLY on the subtitle path being set — the job
// state does not gate it. subtitlePath is set in finalize() after the
// helper exits; the previous state check was removed to align with the
// torrent-side interface contract (torrent.SelectedSubtitleContent serves
// the selected file whenever it is set, not gated on engine state). The
// caller (subtitle endpoint) surfaces nothing until a file is actually
// there.
func (m *Manager) SelectedSubtitleContent(ctx context.Context) (string, error) {
	_ = ctx // os.ReadFile is synchronous; ctx kept for interface symmetry with torrent.SelectedSubtitleContent
	m.mu.Lock()
	j := m.current
	m.mu.Unlock()
	if j == nil {
		return "", errors.New("no active job")
	}
	j.stateMu.Lock()
	subPath := j.subtitlePath
	j.stateMu.Unlock()
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
	lastDiag := time.Now()

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
				// Surface a sanitized helper error (never the command line
				// or URL) before cleanup — this is what debugging "503
				// stuck at 0 bytes" needs.
				m.logJobDiag(j, err)
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
			// One sanitized download-state line every 10s: bytes written,
			// .part detection (speed mode), and the short job/mode — the
			// diagnostic that separates "DL stalled at 0 bytes" from
			// "streaming fine" on the real device.
			if time.Since(lastDiag) >= jobDiagInterval {
				lastDiag = time.Now()
				m.logDownloadState(j)
			}
		}
	}
}

// jobDiagInterval is how often the download-state diagnostic line is
// emitted (10s matches the engine diagnostics cadence elsewhere).
const jobDiagInterval = 10 * time.Second

// diagIDLen is how many characters of the opaque job id are logged. The
// id is 32 hex chars; a 12-char prefix is enough to correlate log lines
// and never carries URL/path information.
const diagIDLen = 12

// shortJobID returns the redaction-safe short job id used in log lines.
func shortJobID(id string) string {
	if len(id) > diagIDLen {
		return id[:diagIDLen]
	}
	return id
}

// safeHelperErr reduces a helper Wait() error to a short safe string.
// exec.ExitError messages are already safe ("exit status N"); the guard
// strips anything resembling a URL/path just in case and bounds length.
func safeHelperErr(err error) string {
	if err == nil {
		return "none"
	}
	msg := err.Error()
	msg = urlSquash(msg)
	if len(msg) > 120 {
		msg = msg[:120] + "..."
	}
	if strings.TrimSpace(msg) == "" {
		return "helper failed"
	}
	return msg
}

// urlSquash removes common URL/path starters from a message (defense in
// depth).
func urlSquash(s string) string {
	low := strings.ToLower(s)
	for _, tok := range []string{"http://", "https://", "/data/", "$prefix", "c:\\", "%userprofile%", "%prefix%"} {
		if i := strings.Index(low, tok); i >= 0 {
			return s[:i] + "<redacted>"
		}
	}
	return s
}

// logDownloadState emits one sanitized download-state diagnostic line
// (bytes / .part detection / state / mode). Never includes the URL, title,
// or any local path — the goal is to distinguish "DL stalled at 0 bytes"
// from "streaming fine" on the real device.
func (m *Manager) logDownloadState(j *job) {
	m.mu.Lock()
	l := m.logger
	m.mu.Unlock()
	if l == nil {
		return
	}
	l.Infof("job", "state job=%s mode=%s state=%s bytes=%d part=%s err=none",
		shortJobID(j.id), j.mode, j.getState(), j.bytes.load(), j.partLabel())
}

// logJobDiag emits the sanitized helper-error line on download failure.
// The error class (exit status / signal) is safe; the command line and
// URL are never included. bytes/part reflect the last refreshDownloadState
// before the helper exited, so "bytes=0 part=-" reads as "DL never
// started" while a nonzero bytes with part= shows the failure came after
// real progress.
func (m *Manager) logJobDiag(j *job, err error) {
	m.mu.Lock()
	l := m.logger
	m.mu.Unlock()
	if l == nil {
		return
	}
	l.Infof("job", "state job=%s mode=%s state=error bytes=%d part=%s err=%s",
		shortJobID(j.id), j.mode, j.bytes.load(), j.partLabel(), safeHelperErr(err))
}

// partLabel returns the redaction-safe label for the job's growing .part
// file: the file basename when detected by refreshDownloadState, else "-".
// The full local path never leaves the package (diag redaction contract).
func (j *job) partLabel() string {
	j.partMu.Lock()
	defer j.partMu.Unlock()
	if j.partPath == "" {
		return "-"
	}
	return filepath.Base(j.partPath)
}

// refreshDownloadState snapshots the growing download state during the run:
//   - bytes: current media bytes on disk (media.<ext> or media.<ext>.part)
//   - partPath: the growing .part file (speed mode instant playback)
//   - quality: the selected format height from height.txt, read once
func (j *job) refreshDownloadState(dir string) {
	j.bytes.store(mediaBytes(dir))
	j.partMu.Lock()
	j.partPath = partMediaPath(dir)
	if j.partSrc == nil && j.partPath != "" {
		j.partSrc = NewPartSource(j.partPath)
	}
	j.partMu.Unlock()
	// Pin the stream's total once the helper has reported the estimated
	// final size (total.txt = yt-dlp filesize_approx written at download
	// start). The pin is one-shot inside SetTotal, so repeated refreshes
	// and later/larger estimates never move the 416 boundary.
	if total, err := readTotalFile(filepath.Join(dir, "total.txt")); err == nil && total > 0 {
		j.partMu.Lock()
		if j.partSrc != nil {
			j.partSrc.SetTotal(total)
		}
		j.partMu.Unlock()
	}
	if j.quality.load() == 0 {
		if h, err := readHeightFile(filepath.Join(dir, "height.txt")); err == nil && h > 0 {
			j.quality.store(int64(h))
		}
	}
	if j.title.load() == "" {
		if t, err := readTitleFile(filepath.Join(dir, "title.txt")); err == nil && t != "" {
			j.title.store(t)
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

// readTotalFile parses the estimated final media size written by yt-dlp's
// `--print-to-file "%(filesize_approx)s"` (bytes). Returns (0, error) when
// absent, malformed, non-positive, or unknown ("NA" is printed when yt-dlp
// cannot estimate) — the caller treats that as "total not pinned yet".
func readTotalFile(path string) (int64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	s := strings.TrimSpace(string(b))
	if s == "" || strings.EqualFold(s, "NA") {
		return 0, errors.New("unknown total")
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, errors.New("invalid total")
	}
	return n, nil
}

// readTitleFile reads the YouTube video title written by yt-dlp's
// `--print-to-file "%(title)s"`. Only whitespace-trimmed lines are kept;
// empty/malformed files yield ("", error) so the job keeps an empty title
// (the web falls back to its existing display name).
func readTitleFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	t := strings.TrimSpace(string(b))
	if t == "" {
		return "", errors.New("empty title")
	}
	return t, nil
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

// atomicString is a tiny atomic string wrapper (sync/atomic.Value backed).
type atomicString struct{ v atomic.Value }

func (a *atomicString) store(s string) { a.v.Store(s) }
func (a *atomicString) load() string {
	v := a.v.Load()
	if v == nil {
		return ""
	}
	return v.(string)
}
