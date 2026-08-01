package torrent

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"eizoudendenshi/internal/job"
	"eizoudendenshi/internal/media"
)

// defaultTimeout is the per-job download timeout when Config.Timeout is zero.
const defaultTimeout = 30 * time.Minute

// pollInterval is how often the manager snapshots the job dir to observe
// downloaded bytes while aria2 runs.
const pollInterval = 200 * time.Millisecond

// State is the torrent job state machine. Values map onto the existing
// growing-media/status contract: queued/downloading/buffering →
// status "buffering" (media not servable); complete → "complete" (a valid
// selection exists and the media is fully downloaded); error → "error";
// cancelled → no active source. The "buffering" state also covers the
// "download complete, awaiting a valid selection" phase — the media is not
// served before selection.
type State string

const (
	StateQueued      State = "queued"
	StateDownloading State = "downloading"
	StateBuffering   State = "buffering"
	StateComplete    State = "complete"
	StateError       State = "error"
	StateCancelled   State = "cancelled"
)

// Media is the metadata-only availability view (available/total bytes on
// disk). Total is 0 until the download finishes and the file sizes are
// known.
type Media struct {
	Available int64 `json:"available"`
	Total     int64 `json:"total"`
	HeadReady bool  `json:"headReady"`
}

// Snapshot is the redacted public view of a torrent job. It never contains
// the magnet, local paths, the helper command line, or helper output.
// HasEligibleVideo and SelectedVideoFile are opaque/boolean metadata for
// the future selection UI.
type Snapshot struct {
	ID                string `json:"id"`
	State             State  `json:"state"`
	Error             string `json:"error,omitempty"`
	Media             Media  `json:"media"`
	HasEligibleVideo  bool   `json:"hasEligibleVideo"`
	SelectedVideoFile string `json:"selectedVideoFile,omitempty"`
}

// Config pins the aria2 helper and the per-job timeout. HelperPath is
// required and is never derived from a request.
type Config struct {
	// HelperPath is the pinned path to the aria2-compatible helper
	// executable. Required.
	HelperPath string
	// Timeout bounds the whole job (spawn → download → file listing).
	// Zero selects the default (30 minutes).
	Timeout time.Duration
}

// Manager supervises the single active torrent job (one-session policy).
type Manager struct {
	mu      sync.Mutex
	helper  string
	timeout time.Duration
	current *torrentJob
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

// torrentJob is the internal supervised job. Everything sensitive lives here
// and never leaves the package: the magnet, the private temp dir, the
// command, and the sanitized file listing.
type torrentJob struct {
	id     string
	magnet string // canonical; passed only as the final helper argv
	dir    string // private temp dir, owned by the job
	cancel context.CancelFunc
	done   chan struct{}
	cmd    *exec.Cmd
	src    *job.JobSource

	stateMu   sync.Mutex
	state     State
	errMsg    string
	timedOut  atomic.Bool
	files     []FileInfo
	selectedV *FileInfo
	selectedS *FileInfo
	vPath     string // full path of the selected video (never exposed)
	sPath     string // full path of the selected subtitle (never exposed)

	bytes atomicInt64 // current bytes on disk (polled)
}

func (j *torrentJob) setState(s State) { j.stateMu.Lock(); j.state = s; j.stateMu.Unlock() }
func (j *torrentJob) getState() State  { j.stateMu.Lock(); defer j.stateMu.Unlock(); return j.state }

// setError records the generic redacted error message under the state lock
// (snapshot() reads it under the same lock).
func (j *torrentJob) setError(msg string) {
	j.stateMu.Lock()
	j.errMsg = msg
	j.stateMu.Unlock()
}

// snapshot returns the redacted public view.
func (j *torrentJob) snapshot() Snapshot {
	j.stateMu.Lock()
	defer j.stateMu.Unlock()
	snap := Snapshot{ID: j.id, State: j.state}
	if j.state == StateError {
		snap.Error = j.errMsg
	}
	if j.src != nil {
		total := j.src.Total()
		snap.Media = Media{Available: total, Total: total}
	} else if j.files != nil {
		snap.Media = Media{Available: totalBytes(j.files), Total: totalBytes(j.files)}
	} else {
		snap.Media = Media{Available: j.bytes.load(), Total: 0}
	}
	if j.files != nil {
		for _, f := range j.files {
			if f.Kind == KindVideo {
				snap.HasEligibleVideo = true
				break
			}
		}
	}
	if j.selectedV != nil {
		snap.SelectedVideoFile = j.selectedV.ID
	}
	return snap
}

// Start validates the magnet and begins a new torrent job. Exactly one job
// may be active at a time across the whole companion (see ErrConflict).
func (m *Manager) Start(rawMagnet string) (Snapshot, error) {
	canonical, err := ValidateMagnet(rawMagnet)
	if err != nil {
		return Snapshot{}, err // generic; never echoes the magnet
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
		id:     newJobID(),
		magnet: canonical,
		done:   make(chan struct{}),
		state:  StateQueued,
	}
	ctx, cancel := context.WithCancel(context.Background())
	j.cancel = cancel
	m.current = j
	go m.run(j, ctx)
	return j.snapshot(), nil
}

// Current returns the snapshot of the active torrent job, or nil.
func (m *Manager) Current() *Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return nil
	}
	snap := m.current.snapshot()
	return &snap
}

// Get returns the snapshot for id, or nil.
func (m *Manager) Get(id string) *Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.current.id != id {
		return nil
	}
	snap := m.current.snapshot()
	return &snap
}

// ActiveMedia returns the current job's redacted snapshot and, only after a
// valid selection exists and the download is complete, the selected video
// as a servable source. Nothing is served before selection.
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

// Files returns the sanitized file listing once the download has completed.
// ErrNotListed until then (or after an error/cancel).
func (m *Manager) Files(id string) ([]FileInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.current.id != id {
		return nil, ErrNotFound
	}
	j := m.current
	j.stateMu.Lock()
	defer j.stateMu.Unlock()
	if j.state != StateBuffering && j.state != StateComplete {
		return nil, ErrNotListed
	}
	out := make([]FileInfo, len(j.files))
	copy(out, j.files)
	return out, nil
}

// Select validates the one-video + optional-subtitle contract and, on
// success, makes the selected video the servable media. Returns
// ErrInvalidSelection for anything else (two videos, non-video video id,
// non-subtitle subtitle id, unknown ids, or when no listing is ready).
func (m *Manager) Select(id, videoFileID, subtitleFileID string) (Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.current.id != id {
		return Snapshot{}, ErrNotFound
	}
	j := m.current

	j.stateMu.Lock()
	ready := j.state == StateBuffering
	j.stateMu.Unlock()
	if !ready {
		return Snapshot{}, ErrNotListed
	}

	var video *FileInfo
	for i := range j.files {
		if j.files[i].ID == videoFileID {
			video = &j.files[i]
			break
		}
	}
	if video == nil || video.Kind != KindVideo {
		return Snapshot{}, ErrInvalidSelection
	}
	var sub *FileInfo
	if subtitleFileID != "" {
		for i := range j.files {
			if j.files[i].ID == subtitleFileID {
				sub = &j.files[i]
				break
			}
		}
		if sub == nil || sub.Kind != KindSubtitle {
			return Snapshot{}, ErrInvalidSelection
		}
	}

	// The video may live in a torrent subdirectory; resolve it under the
	// private job dir only.
	vPath, err := resolveSelectedPath(j.dir, video.ID, j.files)
	if err != nil {
		return Snapshot{}, ErrInvalidSelection
	}
	src, err := job.NewJobSource(vPath, video.ByteSize)
	if err != nil {
		return Snapshot{}, ErrInvalidSelection
	}
	// Commit the selection under the state lock (snapshot() reads these
	// fields under the same lock). setState/snapshot are called after the
	// lock is released (they re-acquire it).
	j.stateMu.Lock()
	j.src = src
	j.selectedV = video
	if sub != nil {
		j.selectedS = sub
		if sp, ok := resolveSelectedPathSafe(j.dir, sub.ID, j.files); ok {
			j.sPath = sp
		}
	}
	j.state = StateComplete
	j.stateMu.Unlock()
	return j.snapshot(), nil
}

// Cancel stops the job (killing the aria2 tree), removes its private temp
// dir, and frees the session.
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
	if j.src != nil {
		_ = j.src.Close()
	}
	if j.dir != "" {
		removeAllBestEffort(j.dir)
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
		if j.src != nil {
			_ = j.src.Close()
		}
		if j.dir != "" {
			removeAllBestEffort(j.dir)
		}
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

// run supervises one job end to end.
func (m *Manager) run(j *torrentJob, ctx context.Context) {
	defer close(j.done)

	dir, err := os.MkdirTemp("", "entei-torrent-*")
	if err != nil {
		j.setError("internal error")
		j.setState(StateError)
		return
	}
	_ = os.Chmod(dir, 0o700)
	j.dir = dir

	var timer *time.Timer
	if m.timeout > 0 {
		timer = time.AfterFunc(m.timeout, func() {
			j.timedOut.Store(true)
			j.cancel()
		})
		defer timer.Stop()
	}

	cmd := exec.CommandContext(ctx, m.helper, helperArgs(dir, j.magnet)...)
	cmd.Dir = dir
	cmd.SysProcAttr = newSysProcAttr()
	// aria2 output is captured only to the private job dir; never surfaced.
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
			removeAllBestEffort(dir)
			j.setState(StateCancelled)
			m.clear(j)
			return
		}
		// Clean up the private job dir BEFORE publishing the error so an
		// observer never sees the error state while cleanup is still in
		// flight (same ordering as the cancel path).
		removeAllBestEffort(dir)
		j.setError("download failed")
		j.setState(StateError)
		return
	}

	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			killTree(cmd)
			<-waitCh
			closeLog()
			removeAllBestEffort(dir)
			if j.timedOut.Load() {
				j.setError("timed out")
				j.setState(StateError)
			} else {
				j.setState(StateCancelled)
				m.clear(j)
			}
			return
		case err := <-waitCh:
			j.bytes.store(mediaBytes(dir))
			if ctx.Err() != nil {
				closeLog()
				removeAllBestEffort(dir)
				if j.timedOut.Load() {
					j.setError("timed out")
					j.setState(StateError)
				} else {
					j.setState(StateCancelled)
					m.clear(j)
				}
				return
			}
			if err != nil {
				closeLog()
				removeAllBestEffort(dir)
				j.setError("download failed")
				j.setState(StateError)
				return
			}
			// aria2 exited cleanly: list and classify the torrent files.
			closeLog()
			files, scanErr := scanTorrentFiles(dir)
			if scanErr != nil || len(files) == 0 {
				removeAllBestEffort(dir)
				j.setError("no files produced")
				j.setState(StateError)
				return
			}
			// Publish the listing under the state lock (snapshot() reads it
			// under the same lock).
			j.stateMu.Lock()
			j.files = files
			j.stateMu.Unlock()
			hasVideo := false
			for _, f := range files {
				if f.Kind == KindVideo {
					hasVideo = true
					break
				}
			}
			if !hasVideo {
				removeAllBestEffort(dir)
				j.setError("no playable video")
				j.setState(StateError)
				return
			}
			// Download complete, awaiting selection: media exists but is
			// not served yet (status "buffering" keeps the bridge waiting).
			j.setState(StateBuffering)
			return
		case <-ticker.C:
			j.bytes.store(mediaBytes(dir))
		}
	}
}

// helperArgs builds the fixed aria2 argument vector. The canonicalized
// magnet is the final element and the only user-derived value.
func helperArgs(jobDir, magnet string) []string {
	return []string{
		"--dir=" + jobDir, // all files under the private job dir
		"--dht-file-path=" + filepath.Join(jobDir, "dht.dat"), // DHT cache stays private (never the user's home)
		"--seed-time=0",              // download only; never seed
		"--enable-rpc=false",         // no RPC surface
		"--check-integrity=true",     // verify piece hashes (original bytes only)
		"--summary-interval=0",       // quiet
		"--console-log-level=error",  // stderr stays minimal (private)
		"--allow-overwrite=true",     // deterministic output within the job dir
		"--auto-file-renaming=false", // keep the torrent's own names
		"--content-disposition-default-utf8=true",
		magnet, // only user-derived value; separate argv element
	}
}

// resolveSelectedPath maps an opaque file id back to its on-disk path
// within the private job dir, using the listing's order.
func resolveSelectedPath(dir, id string, files []FileInfo) (string, error) {
	p, ok := resolveSelectedPathSafe(dir, id, files)
	if !ok {
		return "", errors.New("unknown file")
	}
	return p, nil
}

func resolveSelectedPathSafe(dir, id string, files []FileInfo) (string, bool) {
	for _, f := range files {
		if f.ID == id {
			// The file lives at most one subdirectory deep inside the
			// torrent structure; find it by basename match under dir.
			var found string
			_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() {
					return nil
				}
				if filepath.Base(p) == f.Basename {
					found = p
				}
				return nil
			})
			if found != "" {
				return found, true
			}
			return "", false
		}
	}
	return "", false
}

// mediaBytes reports the current bytes on disk for the torrent files.
func mediaBytes(dir string) int64 {
	var sum int64
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if d.Name() == "helper.stderr.log" {
			return nil
		}
		if st, err := d.Info(); err == nil {
			sum += st.Size()
		}
		return nil
	})
	return sum
}

// removeAllBestEffort removes the private job dir, retrying briefly for the
// Windows open-handle tail of killed aria2 children (same rationale as
// internal/job). All job material is manager-owned.
func removeAllBestEffort(dir string) {
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

// atomicInt64 is a tiny atomic int64 wrapper.
type atomicInt64 struct{ v atomic.Int64 }

func (a *atomicInt64) store(n int64) { a.v.Store(n) }
func (a *atomicInt64) load() int64   { return a.v.Load() }
