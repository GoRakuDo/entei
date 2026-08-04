package torrent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/dht/v2"
	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/types"

	"eizoudendenshi/internal/diag"
)

// engineAnacrolix implements Engine with anacrolix/torrent.
//
// Security posture:
//   - the BitTorrent peer transport binds ALL interfaces (no loopback
//     restriction): uTP sockets, DHT servers and TCP listeners share the
//     listen sockets and are also used for outgoing dials, so restricting
//     the listen host to loopback silently kills DHT queries, uTP peer
//     connections and udp tracker announces (the nyx magnet root cause).
//     The tradeoff is intentional and bounded: NoUpload stays true (we
//     never upload), only metadata is fetched until the user selects a
//     file, and only the selected files are downloaded (others priority
//     None). The HTTP API is a SEPARATE loopback-only listener
//     (127.0.0.1:4322, enforced by the command) and is never affected by
//     this setting.
//   - no seeding (cfg.Seed false; downloads are session-only),
//   - metadata is fetched from the magnet (no payload until selection),
//   - only the selected files are downloaded (others priority None),
//   - the selected video's head is prioritized on selection (a bounded
//     bootstrap window raised to High) AND by a dedicated bootstrap reader
//     that demands byte 0 immediately, so the verified prefix grows from
//     the first piece — the player's HTTP range reads never wait on a
//     mid-file piece; availability is reported piece-accurately from the
//     piece state runs, never from file size or zero probing.
type engineAnacrolix struct {
	// mu guards the client field: Close() nils it while the diagnostics
	// goroutine (diagLoop → diag) and Start() read it. Every access
	// captures the client into a local under the lock and uses it after
	// unlocking, so Close can never race a concurrent read into a nil
	// dereference. This is the ENGINE-level guard — distinct from
	// anacrolixHandle.mu, which guards the handle's per-torrent state.
	mu     sync.Mutex
	client *torrent.Client
	log    *diag.Logger // nil-safe; set via SetLogger before Start
}

// bootstrapWindowBytes is the bounded byte extent of the head bootstrap
// window: the pieces pre-elevated on selection and demanded by the
// bootstrap reader as readahead. It is a scheduling hint only — never a
// playability claim — sized to cover the first contiguous demand the
// player's HTTP range reads will make (byte 0 onward) and identical to the
// reader readahead used by the HTTP layer, so the priority window and the
// demand window are the same bounded region.
const bootstrapWindowBytes = 4 << 20 // 4 MiB

// clientConfig returns a torrent.NewDefaultClientConfig() with the standard
// EizouDendenshi settings applied AND an explicit private DataDir. Without
// a DataDir, anacrolix v1.61 opens its piece-completion DB at an undefined
// default location (observed on Windows as `couldn't open piece completion
// db in "\" : timeout`), which fails metadata fetch. The storage dir must
// be a non-empty ABSOLUTE directory path: empty, relative, or existing
// non-directory paths fail closed. The dir is created with user-private
// permissions when absent.
//
// The peer transport intentionally binds ALL interfaces (ListenHost left at
// the anacrolix default = empty = 0.0.0.0/::): anacrolix v1.61 runs the uTP
// socket and the DHT server on the same UDP socket it uses for OUTGOING
// dials, so a loopback bind (torrent.LoopbackListenHost) makes DHT queries,
// uTP peer connections and udp tracker announces never leave the host —
// only HTTP trackers and TCP peers survive, and metadata for udp-tracker
// magnets (e.g. nyaa) can never be fetched. ListenPort stays 0 (random
// ephemeral port, no fixed port to collide or be scanned on). The security
// boundary is preserved by NoUpload=true, metadata-only-before-selection
// and selected-files-only download; the HTTP API remains loopback-only on
// its own listener.
//
// Each torrent session creates its own Client from a fresh config to avoid
// anacrolix v1.61 issue #1048 (stale tracker weakref when the same Client
// re-adds the same infohash after Drop).
func clientConfig(storageDir string) (*torrent.ClientConfig, error) {
	if storageDir == "" {
		return nil, errors.New("anacrolix storage dir required")
	}
	if !filepath.IsAbs(storageDir) {
		return nil, fmt.Errorf("anacrolix storage dir must be absolute: %q", storageDir)
	}
	// Normalize (clean ".."/"." segments, drive-letter case on Windows)
	// after the IsAbs gate; the absolute check above is the actual
	// validation, Abs here only canonicalizes the path used for Stat/Mkdir
	// and DataDir.
	abs, err := filepath.Abs(storageDir)
	if err != nil {
		return nil, fmt.Errorf("anacrolix storage dir: %w", err)
	}
	info, err := os.Stat(abs)
	if err == nil {
		if !info.IsDir() {
			return nil, fmt.Errorf("anacrolix storage dir is not a directory: %q", abs)
		}
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("anacrolix storage dir: %w", err)
	} else if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, fmt.Errorf("anacrolix storage dir: %w", err)
	}
	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = abs
	// NOTE: ListenHost is deliberately NOT set — the anacrolix default
	// (empty = all interfaces) is required for the peer transport to work
	// (see the clientConfig doc comment above). The HTTP API is a separate
	// loopback-only listener and is never affected.
	cfg.ListenPort = 0 // random ephemeral port
	cfg.Seed = false   // no seeding
	cfg.NoUpload = true
	// The default client logger writes at Warning+ to stderr; a reader read
	// that is cancelled mid-wait (job cancel before the first piece
	// completes, or an HTTP ReadAt timeout) makes anacrolix log "initial
	// read failed" style errors. Those are expected lifecycle noise here —
	// the engine never surfaces them — so point the slogger at a discard
	// handler instead of polluting the companion's stderr. Raw anacrolix
	// log lines are also NOT written to the diagnostic file: they can
	// contain peer IPs and tracker hostnames, which the redaction contract
	// forbids. The file log only carries the engine's own sanitized
	// diagnostics (counts and short infohashes).
	cfg.Slogger = slog.New(slog.NewTextHandler(io.Discard, nil))
	return cfg, nil
}

// SetLogger injects the diagnostic logger (nil-safe). The manager calls it
// on engines that implement LoggerSettable after construction and before
// Start; engines without a logger simply stay silent.
func (e *engineAnacrolix) SetLogger(l *diag.Logger) { e.log = l }

// NewAnacrolixEngine constructs the engine. The client binds a random
// ephemeral port on ALL interfaces (peer transport only — the HTTP API is
// loopback-only on its own listener), does not seed, and stores its
// piece-completion DB under the given session-private storageDir (an
// absolute path the caller owns).
func NewAnacrolixEngine(storageDir string) (Engine, error) {
	cfg, err := clientConfig(storageDir)
	if err != nil {
		return nil, err
	}
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("anacrolix client: %w", err)
	}
	return &engineAnacrolix{client: cl}, nil
}

func (e *engineAnacrolix) Close() error {
	// Capture under the lock, close after unlocking: a concurrent diag()
	// either sees the client (and finishes with the closed client, which
	// is safe) or sees nil and skips. client.Close() is not called while
	// holding the lock so the diagnostics goroutine can always make
	// progress.
	e.mu.Lock()
	cl := e.client
	e.client = nil
	e.mu.Unlock()
	if cl != nil {
		cl.Close()
	}
	return nil
}

func (e *engineAnacrolix) Start(ctx context.Context, magnet string) (TorrentHandle, error) {
	e.mu.Lock()
	cl := e.client
	e.mu.Unlock()
	if cl == nil {
		e.log.Warnf("torrent.engine", "metadata rejected engine closed")
		return nil, errInvalidMagnet
	}
	e.log.Infof("torrent.engine", "metadata begin infohash=%s", diag.ShortInfohash(magnet))
	t, err := cl.AddMagnet(magnet)
	if err != nil {
		e.log.Warnf("torrent.engine", "metadata rejected")
		return nil, errInvalidMagnet
	}
	select {
	case <-ctx.Done():
		t.Drop()
		e.log.Warnf("torrent.engine", "metadata cancelled")
		return nil, ctx.Err()
	case <-t.GotInfo():
	}
	e.log.Infof("torrent.engine", "metadata ok files=%d", len(t.Files()))
	go e.diagLoop(t)
	return newAnacrolixHandle(t), nil
}

// diagLoop periodically logs sanitized engine diagnostics while the
// torrent is alive: peer counts (Torrent.Stats), DHT node counts and
// announce query outcomes (Client.Stats + DhtServers). Counts only — never
// peer addresses, tracker URLs, or the infohash. The loop exits when the
// torrent is closed (job cancel/complete/eviction) or the client is closed.
func (e *engineAnacrolix) diagLoop(t *torrent.Torrent) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-t.Closed():
			return
		case <-ticker.C:
			e.diag(t)
		}
	}
}

// diag logs one sanitized diagnostics line. Peer counts come from the
// torrent's instantaneous gauges; DHT node and announce counts come from
// the client's DHT servers (dht.ServerStats). Whole-torrent piece
// completion (independent of the selected file) comes from the piece state
// runs plus the total bytes received. All values are plain integers — no
// addresses, URLs, or identifiers. The client is captured under the engine
// lock (Close() may nil it concurrently); a closed engine simply skips the
// line.
func (e *engineAnacrolix) diag(t *torrent.Torrent) {
	e.mu.Lock()
	cl := e.client
	e.mu.Unlock()
	if cl == nil {
		return
	}
	ts := t.Stats()
	cs := cl.Stats()
	var nodes, goodNodes int
	var announceOK, announceTried int64
	for _, ds := range cl.DhtServers() {
		if ss, ok := ds.Stats().(dht.ServerStats); ok {
			nodes += ss.Nodes
			goodNodes += ss.GoodNodes
			announceOK += ss.SuccessfulOutboundAnnouncePeerQueries
			announceTried += ss.OutboundQueriesAttempted
		}
	}
	// Whole-torrent piece completion, independent of the selected file:
	// complete pieces over total pieces (t.Info().NumPieces), plus the
	// bytes received on the wire (ConnStats.BytesRead). PieceStateRuns
	// groups consecutive pieces with the same state into runs, so a
	// mostly-incomplete torrent costs a handful of iterations instead of
	// one per piece — safe on the 10s diag cadence even for thousands of
	// pieces. Counts only: no piece data, no peer identifiers.
	var completePieces, totalPieces int
	if info := t.Info(); info != nil {
		totalPieces = info.NumPieces()
		for _, run := range t.PieceStateRuns() {
			if run.PieceState.Complete {
				completePieces += run.Length
			}
		}
	}
	e.log.Infof("torrent.engine", "diag peers=%d active=%d seeders=%d halfopen=%d dht_nodes=%d dht_good=%d announce_ok=%d announce_tried=%d complete=%d/%d bytes_read=%d",
		ts.TotalPeers, ts.ActivePeers, ts.ConnectedSeeders, cs.ActiveHalfOpenAttempts, nodes, goodNodes, announceOK, announceTried, completePieces, totalPieces, ts.ConnStats.BytesRead)
}

type anacrolixHandle struct {
	t        *torrent.Torrent
	files    []TorrentFile
	selected *torrent.File
	mu       sync.Mutex
}

func newAnacrolixHandle(t *torrent.Torrent) *anacrolixHandle {
	h := &anacrolixHandle{t: t}
	for i, f := range t.Files() {
		displayPath := f.DisplayPath()
		base := filepath.Base(displayPath)
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(base), "."))
		// Normalize the display path to a safe relative path with "/" separators.
		relPath := strings.ReplaceAll(displayPath, "\\", "/")
		relPath = strings.TrimLeft(relPath, "/")
		h.files = append(h.files, TorrentFile{
			ID:           fmt.Sprintf("f%d", i),
			Path:         base,
			RelativePath: relPath,
			Length:       f.Length(),
			Kind:         classify(ext),
		})
	}
	return h
}

func (h *anacrolixHandle) Name() string { return h.t.Info().BestName() }

func (h *anacrolixHandle) Files() []TorrentFile { return h.files }

// Select restricts downloads to the selected video (+ optional subtitle)
// and raises the video's bounded head window above the rest of the file so
// the verified prefix grows from byte 0 (the player's HTTP range reads
// start there).
func (h *anacrolixHandle) Select(videoFileID string, subtitleFileID string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	var videoIdx, subIdx int = -1, -1
	for i, f := range h.files {
		if f.ID == videoFileID {
			videoIdx = i
		}
		if subtitleFileID != "" && f.ID == subtitleFileID {
			subIdx = i
		}
	}
	if videoIdx < 0 {
		return errInvalidSelection
	}
	if h.files[videoIdx].Kind != KindVideo {
		return errInvalidSelection
	}
	if subIdx >= 0 && h.files[subIdx].Kind != KindSubtitle {
		return errInvalidSelection
	}
	anacrolixFiles := h.t.Files()
	for i, f := range anacrolixFiles {
		prio := types.PiecePriorityNone
		if i == videoIdx || i == subIdx {
			prio = types.PiecePriorityNormal
		}
		f.SetPriority(prio)
	}
	// Elevate the selected video's bounded head window above the file's
	// Normal priority. Piece.SetPriority is the official per-piece priority
	// API (v1.61); High means "wanted a lot" and outranks the file-level
	// Normal, so the head pieces are requested before the rest of the file
	// even before the bootstrap reader starts. The window is derived from
	// the file's first piece index and the torrent's piece length — never
	// an arbitrary raw byte count — and is clamped to the file, so pieces
	// of unselected files are never elevated (a boundary piece shared with
	// a neighbour inherits the video's priority by piece granularity, as it
	// already does at Normal).
	videoFile := anacrolixFiles[videoIdx]
	begin, end := headWindowPieces(videoFile)
	for i := begin; i < end; i++ {
		h.t.Piece(i).SetPriority(types.PiecePriorityHigh)
	}
	h.selected = anacrolixFiles[videoIdx]
	return nil
}

// bootstrapPieceCount returns how many pieces are needed to cover
// windowBytes starting at the beginning of a file, rounded up, bounded by
// the file's available pieces. Zero when the inputs are degenerate.
func bootstrapPieceCount(windowBytes, pieceLength int64, availablePieces int) int {
	if windowBytes <= 0 || pieceLength <= 0 || availablePieces <= 0 {
		return 0
	}
	n := (windowBytes + pieceLength - 1) / pieceLength
	if n > int64(availablePieces) {
		n = int64(availablePieces)
	}
	return int(n)
}

// headWindowPieces returns the bounded piece window [begin, end) of f to
// pre-elevate on selection: the pieces covering the first
// bootstrapWindowBytes of the file, derived from the file's first piece
// index and the torrent's piece length. Degenerate inputs yield an empty
// window (no elevation).
func headWindowPieces(f *torrent.File) (begin, end int) {
	begin = f.BeginPieceIndex()
	end = f.EndPieceIndex()
	info := f.Torrent().Info()
	if info == nil || info.PieceLength <= 0 {
		return begin, begin
	}
	n := bootstrapPieceCount(bootstrapWindowBytes, info.PieceLength, end-begin)
	return begin, begin + n
}

// StartBootstrap registers an anacrolix Reader demand for the selected
// video's head. A dedicated reader seeks to byte 0 and issues one bounded
// read: anacrolix's Reader scheduling then marks the first demanded piece
// "Now" (highest urgency) and the readahead window "Readahead" — the head
// pieces are requested immediately, without waiting for the player's first
// HTTP range request. The read blocks until the first verified piece
// arrives or ctx ends; the demand persists while the reader lives, so the
// goroutine parks on ctx.Done and closes the reader on job end. Reads pull
// from shared piece storage, so no data is consumed that the HTTP readers
// need, and the manager's state machine is never blocked.
func (h *anacrolixHandle) StartBootstrap(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.selected == nil {
		return errInvalidSelection
	}
	r := h.selected.NewReader()
	r.SetContext(ctx)
	r.SetReadahead(bootstrapWindowBytes)
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		_ = r.Close()
		return err
	}
	go func() {
		defer r.Close()
		// A single read registers the demand (Seek alone does not: the
		// reader's piece range is empty until the first Read) and parks
		// until the head piece completes or the job context ends.
		buf := make([]byte, 1)
		if _, err := r.Read(buf); err != nil {
			return // ctx done or torrent closed; demand moot
		}
		<-ctx.Done()
	}()
	return nil
}

func (h *anacrolixHandle) Reader(ctx context.Context) (io.ReadSeekCloser, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.selected == nil {
		return nil, errInvalidSelection
	}
	r := h.selected.NewReader()
	r.SetContext(ctx)
	r.SetReadahead(bootstrapWindowBytes) // bounded forward readahead
	return r, nil
}

// AvailablePrefix returns the verified contiguous prefix of the selected
// file: the longest leading run of fully-downloaded pieces, piece-accurate.
func (h *anacrolixHandle) AvailablePrefix() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.selected == nil {
		return 0
	}
	total := h.selected.Length()
	if total == 0 {
		return 0
	}
	// Walk the file's pieces from the start; the first non-complete
	// piece ends the verified contiguous prefix.
	var prefix int64
	for _, fps := range h.selected.State() {
		if !fps.Ok || !fps.Complete {
			break
		}
		prefix += fps.Bytes
		if prefix >= total {
			return total
		}
	}
	return prefix
}

func (h *anacrolixHandle) SelectedLength() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.selected == nil {
		return 0
	}
	return h.selected.Length()
}

func (h *anacrolixHandle) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.t.Drop()
	return nil
}

var (
	errInvalidMagnet    = errors.New("invalid magnet")
	errInvalidSelection = errors.New("invalid selection")
)
