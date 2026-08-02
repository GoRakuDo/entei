package torrent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
	StateDownloading State = "downloading" // stage 1: metadata-only fetch
	StateBuffering   State = "buffering"   // listed (files available) or streaming, prefix < threshold
	StateStreaming   State = "streaming"   // selected; payload downloading (verified prefix grows)
	StatePlayable    State = "playable"    // verified prefix >= playable threshold
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

	// Streaming (progressive) state. meta is the parsed metadata from the
	// stage-1 .torrent; verifier tracks the verified contiguous prefix.
	meta      *TorrentMetadata
	span      SelectedSpan
	verifier  *PrefixVerifier
	selected  chan struct{} // closed when the user selects a file
	selIndex  int           // 1-based selected file index
	selSubIdx int           // optional 1-based subtitle index (0 = none)

	stateMu   sync.Mutex
	state     State
	errMsg    string
	timedOut  atomic.Bool
	files     []FileInfo
	selectedV *FileInfo
	selectedS *FileInfo
	vPath     string // full path of the selected video (never exposed)
	sPath     string // full path of the selected subtitle (never exposed)

	bytes atomicInt64 // current verified bytes of the selected file (polled)
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
	} else if j.verifier != nil {
		// Streaming: availability is the VERIFIED contiguous prefix only —
		// never the file's allocated size.
		avail := j.verifier.Available()
		snap.Media = Media{Available: avail, Total: j.span.Length}
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
		id:       newJobID(),
		selected: make(chan struct{}),
		magnet:   canonical,
		done:     make(chan struct{}),
		state:    StateQueued,
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
	st := m.current.getState()
	if st == StateComplete && m.current.src != nil {
		src = m.current.src
	}
	if (st == StateStreaming || st == StatePlayable) && m.current.verifier != nil {
		// The streaming source serves ONLY hash-verified contiguous bytes.
		src = m.current.verifier
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
	if j.meta == nil {
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
	span, err := spanFor(j.meta, video.Index)
	if err != nil {
		return Snapshot{}, ErrInvalidSelection
	}

	// Commit the selection; the run loop's phase 2 (streaming payload
	// download) starts when j.selected is closed.
	j.stateMu.Lock()
	j.selectedV = video
	j.selIndex = video.Index
	j.selSubIdx = 0
	if sub != nil {
		j.selectedS = sub
		j.selSubIdx = sub.Index
	}
	j.span = span
	j.stateMu.Unlock()
	close(j.selected)
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
	stopTimer := func() {
		if timer != nil {
			timer.Stop()
			timer = nil
		}
	}
	armTimer := func() {
		stopTimer()
		if m.timeout > 0 {
			timer = time.AfterFunc(m.timeout, func() {
				j.timedOut.Store(true)
				j.cancel()
			})
		}
	}
	defer stopTimer()

	// ---- Phase 1: metadata-only fetch (fixed argv, no RPC) ----
	armTimer()
	j.setState(StateDownloading)
	done1, ok := m.spawnAndWait(j, ctx, dir, metadataHelperArgs(dir, j.magnet))
	if !ok {
		return // the spawn/wait paths already published the terminal state
	}
	if !done1 {
		return
	}
	// aria2 exited cleanly: parse the saved .torrent → file list.
	meta, perr := loadSavedTorrent(dir)
	if perr != nil {
		removeAllBestEffort(dir)
		j.setError("no metadata produced")
		j.setState(StateError)
		return
	}
	j.meta = meta
	files := metadataFiles(meta)
	hasVideo := false
	for _, f := range files {
		if f.Kind == KindVideo {
			hasVideo = true
			break
		}
	}
	j.stateMu.Lock()
	j.files = files
	j.stateMu.Unlock()
	if !hasVideo {
		removeAllBestEffort(dir)
		j.setError("no playable video")
		j.setState(StateError)
		return
	}
	// Metadata listed, awaiting selection (no payload downloaded yet).
	j.setState(StateBuffering)
	stopTimer() // the selection wait is user-driven; not bounded by the job timeout

	select {
	case <-j.selected:
		// Selection committed by Select(); proceed to phase 2.
	case <-ctx.Done():
		if j.timedOut.Load() {
			j.setError("timed out")
			j.setState(StateError)
		} else {
			j.setState(StateCancelled)
		}
		removeAllBestEffort(dir)
		if !j.timedOut.Load() {
			m.clear(j)
		}
		return
	}

	// ---- Phase 2: selected-file payload download (verified prefix) ----
	armTimer()
	j.setState(StateStreaming)
	tf := j.meta.Files[j.selIndex-1]
	j.vPath = selectedFilePath(dir, tf)
	args := payloadHelperArgs(dir, j.magnet, j.selIndex)
	if ok := m.spawnPayload(j, ctx, dir, args); !ok {
		return
	}
}

// spawnAndWait starts one aria2 invocation and waits for it, handling the
// terminal state transitions + cleanup (the same ordering as before:
// cleanup BEFORE the error state is published). Returns (exitedCleanly,
// ok). ok=false means the state is already terminal.
func (m *Manager) spawnAndWait(j *torrentJob, ctx context.Context, dir string, args []string) (bool, bool) {
	cmd := exec.CommandContext(ctx, m.helper, args...)
	cmd.Dir = dir
	cmd.SysProcAttr = newSysProcAttr()
	closeLog := func() {}
	if logf, err := os.Create(filepath.Join(dir, "helper.stderr.log")); err == nil {
		cmd.Stderr = logf
		closeLog = func() { _ = logf.Close() }
	}
	j.cmd = cmd
	if err := cmd.Start(); err != nil {
		closeLog()
		if ctx.Err() != nil {
			removeAllBestEffort(dir)
			j.setState(StateCancelled)
			m.clear(j)
			return false, false
		}
		removeAllBestEffort(dir)
		j.setError("download failed")
		j.setState(StateError)
		return false, false
	}
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()
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
		return false, false
	case err := <-waitCh:
		closeLog()
		if ctx.Err() != nil {
			removeAllBestEffort(dir)
			if j.timedOut.Load() {
				j.setError("timed out")
				j.setState(StateError)
			} else {
				j.setState(StateCancelled)
				m.clear(j)
			}
			return false, false
		}
		if err != nil {
			removeAllBestEffort(dir)
			j.setError("download failed")
			j.setState(StateError)
			return false, false
		}
		return true, true
	}
}

// spawnPayload starts the selected-file download and polls the SHA-1
// verified prefix until playable/complete/cancelled/timeout/error.
func (m *Manager) spawnPayload(j *torrentJob, ctx context.Context, dir string, args []string) bool {
	cmd := exec.CommandContext(ctx, m.helper, args...)
	cmd.Dir = dir
	cmd.SysProcAttr = newSysProcAttr()
	closeLog := func() {}
	if logf, err := os.Create(filepath.Join(dir, "helper.stderr.log")); err == nil {
		cmd.Stderr = logf
		closeLog = func() { _ = logf.Close() }
	}
	j.cmd = cmd
	if err := cmd.Start(); err != nil {
		closeLog()
		if ctx.Err() != nil {
			removeAllBestEffort(dir)
			j.setState(StateCancelled)
			m.clear(j)
			return false
		}
		removeAllBestEffort(dir)
		j.setError("download failed")
		j.setState(StateError)
		return false
	}
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	j.stateMu.Lock()
	j.verifier = newPrefixVerifier(j.meta, j.span, j.vPath)
	j.stateMu.Unlock()

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
			return false
		case err := <-waitCh:
			closeLog()
			if ctx.Err() != nil {
				removeAllBestEffort(dir)
				if j.timedOut.Load() {
					j.setError("timed out")
					j.setState(StateError)
				} else {
					j.setState(StateCancelled)
					m.clear(j)
				}
				return false
			}
			if err != nil {
				removeAllBestEffort(dir)
				j.setError("download failed")
				j.setState(StateError)
				return false
			}
			// aria2 exited cleanly: final bounded verify pass, then complete.
			// Stop when no progress is made (an unverified piece will never
			// verify once the helper has exited).
			for {
				before := j.verifier.verifiedPieces
				done, _ := j.verifier.Poll()
				if done || j.verifier.verifiedPieces == before {
					break
				}
			}
			j.bytes.store(j.verifier.Available())
			src, serr := job.NewJobSource(j.vPath, j.span.Length)
			if serr != nil {
				removeAllBestEffort(dir)
				j.setError("media unavailable")
				j.setState(StateError)
				return false
			}
			j.stateMu.Lock()
			j.src = src
			j.stateMu.Unlock()
			j.setState(StateComplete)
			return true
		case <-ticker.C:
			done, _ := j.verifier.Poll()
			avail := j.verifier.Available()
			j.bytes.store(avail)
			if j.playable() && j.getState() != StatePlayable {
				j.setState(StatePlayable)
			}
			if done {
				// whole file verified but the process may still be
				// finalizing; keep polling until the waitCh fires.
			}
		}
	}
}

// playable reports the safe-early predicate: the verified prefix must be
// structurally playable (complete ftyp + moov, browser-decodeable stsd
// video codec, verified sample boundary) and start at file offset 0. There
// is no fixed byte threshold — the earliest verified prefix that meets the
// decoder-safe structure is eligible (which for a well-faststart MP4 is
// the first one or two verified pieces). MKV is deliberately NOT accepted
// for progressive early playback (an early EBML prefix cannot guarantee a
// browser demux/decode here); a complete MKV is served normally through
// the complete path with video/x-matroska — a progressive-streaming
// limitation, not an admission rejection.
func (j *torrentJob) playable() bool {
	if j.verifier == nil {
		return false
	}
	if j.span.HeadGap != 0 || j.verifier.VerifiedPieces() < 1 {
		return false
	}
	avail := j.verifier.Available()
	if avail <= 0 {
		return false
	}
	return structurallyPlayable(j.vPath, avail)
}

// helperArgs builds the fixed aria2 argument vector. The canonicalized
// magnet is the final element and the only user-derived value.
// baseHelperArgs are the shared fixed aria2 flags (privacy + deterministic output).
func baseHelperArgs(jobDir string) []string {
	return []string{
		"--dir=" + jobDir, // all files under the private job dir
		"--dht-file-path=" + filepath.Join(jobDir, "dht.dat"), // DHT cache stays private (never the user's home)
		"--seed-time=0",             // download only; never seed
		"--enable-rpc=false",        // no RPC surface
		"--check-integrity=true",    // verify piece hashes (original bytes only)
		"--summary-interval=0",      // quiet
		"--console-log-level=error", // stderr stays minimal (private)
		"--allow-overwrite=true",    // deterministic output within the job dir
		"--auto-file-renaming=false",
		"--content-disposition-default-utf8=true",
	}
}

// metadataHelperArgs: stage 1 — fetch ONLY the torrent metadata, save the
// .torrent, and exit (the file list becomes available before any payload).
func metadataHelperArgs(jobDir, magnet string) []string {
	return append(baseHelperArgs(jobDir),
		"--bt-metadata-only=true",
		"--bt-save-metadata=true",
		magnet, // only user-derived value; separate argv element
	)
}

// payloadHelperArgs: stage 2 — download ONLY the selected file, in-order,
// head-prioritized (fixed policy; the index is job-internal, never user).
func payloadHelperArgs(jobDir, magnet string, fileIndex int) []string {
	args := append(baseHelperArgs(jobDir),
		"--select-file="+strconv.Itoa(fileIndex),
		"--stream-piece-selector=inorder",
		"--bt-prioritize-piece=head",
		magnet,
	)
	return args
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

// SelectedMediaType returns the conservative HTTP media type of the
// selected file, derived from its extension (never hardcoded to video/mp4).
// An empty string means no selection yet. MKV maps to video/x-matroska.
func (m *Manager) SelectedMediaType() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return ""
	}
	j := m.current
	if j.selectedV == nil {
		return ""
	}
	return mimeForExt(j.selectedV.Extension)
}
