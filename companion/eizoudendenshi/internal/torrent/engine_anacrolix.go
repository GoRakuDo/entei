package torrent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/dht/v2"
	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"
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
	// storage is the explicit DefaultStorage closer the engine owns: anacrolix
	// v1.61 does not close an explicitly-provided DefaultStorage, and the bolt
	// Close is idempotent (a future double-close is safe). See Close.
	storage storage.ClientImplCloser
}

// bootstrapWindowBytes is the bounded byte extent of the head bootstrap
// window: the pieces pre-elevated on selection and demanded by the
// bootstrap reader as readahead. It is a scheduling hint only — never a
// playability claim — sized to cover the first contiguous demand the
// player's HTTP range reads will make (byte 0 onward) and identical to the
// reader readahead used by the HTTP layer, so the priority window and the
// demand window are the same bounded region.
const bootstrapWindowBytes = 4 << 20 // 4 MiB

// TailWindowBytes is the bounded byte extent at the END of a file whose
// pieces are pre-elevated on selection. MKV files store their Cues element
// (the seek / keyframe table) near the end of the file: without Cues the
// browser's video element cannot locate a keyframe for an arbitrary seek
// position, leaving seeking stuck (seeking=true, readyState=1, GPU 100%).
// Elevating the tail pieces ensures Cues are downloaded early alongside the
// head bootstrap window, so the player can seek as soon as both ends of the
// file are available.
const TailWindowBytes = 8 << 20 // 8 MiB

// httpReadaheadBytes is the readahead used by the HTTP-serving Reader
// created per Range request. It is deliberately larger than
// bootstrapWindowBytes so that a seek to a mid-file position requests
// enough forward pieces to keep the 206 response flowing without stalls.
// Sized to cover ~16 MiB of forward demand — enough for typical
// streaming read patterns (Chrome reads in ~256 KiB-1 MiB chunks) while
// bounded to avoid excessive piece-priority churn.
const httpReadaheadBytes = 16 << 20 // 16 MiB

// subtitleReadTimeout bounds how long SubtitleContent waits for the subtitle
// file's data. The embedded-subtitle reference is read with a responsive
// reader (no piece-verification wait), but a slow swarm must not hang the
// sync button forever — after this bound the read fails and the API surfaces
// it as 404 ("subtitle not available"). Var (not const) so tests can shorten
// it.
var subtitleReadTimeout = 30 * time.Second

// clientConfig returns a torrent.NewDefaultClientConfig() with the standard
// EizouDendenshi settings applied AND an explicit private DataDir +
// DefaultStorage. Without a DataDir, anacrolix v1.61 opens its
// piece-completion DB at an undefined default location (observed on Windows
// as `couldn't open piece completion db in "\" : timeout`), which fails
// metadata fetch. The storage dir must be a non-empty ABSOLUTE directory
// path: empty, relative, or existing non-directory paths fail closed. The
// dir is created with user-private permissions when absent.
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
func clientConfig(storageDir string) (*torrent.ClientConfig, storage.ClientImplCloser, error) {
	if storageDir == "" {
		return nil, nil, errors.New("anacrolix storage dir required")
	}
	if !filepath.IsAbs(storageDir) {
		return nil, nil, fmt.Errorf("anacrolix storage dir must be absolute: %q", storageDir)
	}
	// Normalize (clean ".."/"." segments, drive-letter case on Windows)
	// after the IsAbs gate; the absolute check above is the actual
	// validation, Abs here only canonicalizes the path used for Stat/Mkdir
	// and DataDir.
	abs, err := filepath.Abs(storageDir)
	if err != nil {
		return nil, nil, fmt.Errorf("anacrolix storage dir: %w", err)
	}
	info, err := os.Stat(abs)
	if err == nil {
		if !info.IsDir() {
			return nil, nil, fmt.Errorf("anacrolix storage dir is not a directory: %q", abs)
		}
	} else if !os.IsNotExist(err) {
		return nil, nil, fmt.Errorf("anacrolix storage dir: %w", err)
	} else if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, nil, fmt.Errorf("anacrolix storage dir: %w", err)
	}
	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = abs
	// stremio-server-go pattern: explicitly set DefaultStorage so NewClient
	// never falls back to the DataDir-only path. The fallback (storage.NewFile
	// under an OS temp dir on a Ramdisk) failed to open the bolt
	// piece-completion DB → Map pieceCompletion fallback →
	// storageCompletionOk false → download stall (head piece stuck at
	// effectivePriority None).
	stor := storage.NewFileByInfoHash(abs)
	cfg.DefaultStorage = stor
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
	return cfg, stor, nil
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
	cfg, stor, err := clientConfig(storageDir)
	if err != nil {
		return nil, err
	}
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		_ = stor.Close() // release the bolt piece-completion DB on failure too
		return nil, fmt.Errorf("anacrolix client: %w", err)
	}
	return &engineAnacrolix{client: cl, storage: stor}, nil
}

// Close shuts down the anacrolix client and releases the session storage
// (the explicit DefaultStorage closer — see the engine's storage field).
// Double Close is safe: both the client and the bolt piece-completion DB
// close idempotently (the second bolt Close returns ErrDatabaseNotOpen,
// which is ignored here).
func (e *engineAnacrolix) Close() error {
	// Capture under the lock, close after unlocking: a concurrent diag()
	// either sees the client (and finishes with the closed client, which
	// is safe) or sees nil and skips. client.Close() is not called while
	// holding the lock so the diagnostics goroutine can always make
	// progress.
	e.mu.Lock()
	cl := e.client
	st := e.storage
	e.client = nil
	e.storage = nil
	e.mu.Unlock()
	if cl != nil {
		cl.Close()
	}
	if st != nil {
		_ = st.Close() // release the bolt piece-completion DB lock
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
	// Start the engine diagnostics DURING metadata fetch (GotInfo): on a
	// magnet that resolves slowly the 10s diag line is the only window
	// into peer/DHT/announce activity before the 2-minute metadata
	// timeout. diag() already tolerates t.Info() == nil (head="-",
	// piece counts empty) — counts still come from the wired peer state.
	go e.diagLoop(t)
	select {
	case <-ctx.Done():
		t.Drop()
		e.log.Warnf("torrent.engine", "metadata cancelled")
		return nil, ctx.Err()
	case <-t.GotInfo():
	}
	// Reject v2-only torrents (BEP 52) as soon as the metainfo arrives:
	// anacrolix v1.61 cannot download them — every piece's hash stays
	// unknown until the piece layer is fetched, queuePieceCheck refuses to
	// queue such pieces ("piece hash unknown"), storageCompletionOk never
	// becomes true, and the head piece is stuck at effectivePriority None
	// forever (the magnet "downloads nothing" stall). Hybrid v1+v2
	// torrents are fine (they carry the v1 hash set) and pass through
	// unchanged. The rejection is final: the torrent is dropped and the
	// job is routed to its dedicated error code by the manager.
	if isV2Only(t.Info()) {
		t.Drop()
		e.log.Warnf("torrent.engine", "metadata rejected v2-only torrent not supported")
		return nil, errV2Unsupported
	}
	e.log.Infof("torrent.engine", "metadata ok files=%d", len(t.Files()))
	h := newAnacrolixHandle(t)
	h.log = e.log
	return h, nil
}

// isV2Only reports whether the torrent is a v2-only torrent (BEP 52): the
// metainfo carries the v2 (MetaVersion 2) form with no v1 component. Only
// this case is rejected — hybrid v1+v2 torrents (HasV1() true) are
// supported through their v1 hash set. Nil info is never v2-only (the
// caller only runs this after GotInfo, but the guard keeps the helper
// total).
func isV2Only(info *metainfo.Info) bool {
	return info != nil && info.HasV2() && !info.HasV1()
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
// runs plus the total bytes received. The head field renders the state of
// the torrent's first headDiagPieces pieces — complete flag and effective
// priority — so a stalled head bootstrap (the head window not elevated or
// not completing first) is visible in the log. All values are plain
// integers — no addresses, URLs, or identifiers. The client is captured
// under the engine lock (Close() may nil it concurrently); a closed engine
// simply skips the line.
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
	// pieces. Counts only: no piece data, no peer identifiers. head is
	// "-" until metadata arrives (t.Info() nil).
	var completePieces, totalPieces int
	head := "-"
	// v2/v1 flag the torrent's metainfo versioning (BEP 52): "true"/"false"
	// once metadata is known, "-" before it. Plain bools only — the
	// redaction contract is unchanged.
	v2Flag, v1Flag := "-", "-"
	if info := t.Info(); info != nil {
		totalPieces = info.NumPieces()
		for _, run := range t.PieceStateRuns() {
			if run.PieceState.Complete {
				completePieces += run.Length
			}
		}
		v2Flag = strconv.FormatBool(info.HasV2())
		v1Flag = strconv.FormatBool(info.HasV1())
		head = headPieceDiag(t, totalPieces)
	}
	e.log.Infof("torrent.engine", "diag peers=%d active=%d seeders=%d halfopen=%d dht_nodes=%d dht_good=%d announce_ok=%d announce_tried=%d complete=%d/%d bytes_read=%d v2=%s v1=%s head=%s",
		ts.TotalPeers, ts.ActivePeers, ts.ConnectedSeeders, cs.ActiveHalfOpenAttempts, nodes, goodNodes, announceOK, announceTried, completePieces, totalPieces, ts.ConnStats.BytesRead, v2Flag, v1Flag, head)
}

// headDiagPieces is how many leading torrent pieces the diag line
// reports. On a typical single-video torrent these are exactly the
// pieces covering the selection-time head bootstrap window (bounded to
// 4 MiB at bootstrapWindowBytes).
const headDiagPieces = 4

// headPieceDiag renders the torrent's leading pieces as "i:cCpP"
// entries: piece index, complete (0/1), and effective priority
// (None=0, Normal=1, High=2, Now/Readahead=3+). The effective priority
// reflects both the selection-time High elevation and any live reader
// demand (the bootstrap reader), so a stalled head shows either a low
// priority or a missing complete flag. Numbers only, keeping the
// redaction contract; a torrent with fewer than headDiagPieces pieces
// yields fewer entries.
func headPieceDiag(t *torrent.Torrent, totalPieces int) string {
	n := totalPieces
	if n > headDiagPieces {
		n = headDiagPieces
	}
	parts := make([]string, 0, n)
	for i := 0; i < n; i++ {
		st := t.Piece(i).State()
		complete := 0
		if st.Complete {
			complete = 1
		}
		parts = append(parts, fmt.Sprintf("%d:c%dp%d", i, complete, int(st.Priority)))
	}
	return strings.Join(parts, ",")
}

type anacrolixHandle struct {
	t           *torrent.Torrent
	files       []TorrentFile
	selected    *torrent.File
	subtitleIdx int // index into h.t.Files(); -1 = none
	mu          sync.Mutex
	log         *diag.Logger // nil-safe; set by the engine for diagnostics
}

// firstSubtitleIndex returns the index of the first subtitle file in the
// sanitized listing, or -1 when the torrent has no subtitle file. Used for
// the embedded-subtitle auto-detection (sub-to-sub sync reference): a
// video-only selection still makes the first .srt/.vtt/.ass available
// without the user picking it in the magnet modal.
func firstSubtitleIndex(files []TorrentFile) int {
	for i, f := range files {
		if f.Kind == KindSubtitle {
			return i
		}
	}
	return -1
}

func newAnacrolixHandle(t *torrent.Torrent) *anacrolixHandle {
	// subtitleIdx must start at -1 (Go zero value 0 would point at the first
	// file — the video — and SubtitleContent would read the video as
	// subtitle before any Select).
	h := &anacrolixHandle{t: t, subtitleIdx: -1}
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
	// Auto-detect the embedded subtitle when none was picked: its pieces are
	// tiny but would otherwise sit at priority None and never download, so
	// the sub-to-sub sync reference (SubtitleContent) has nothing to read.
	// autoSubIdx is resolved once before the loop (not inside it) so the
	// elevated subtitle window is stable while the head/tail loops run.
	autoSubIdx := -1
	if subIdx < 0 {
		autoSubIdx = firstSubtitleIndex(h.files)
	}
	for i, f := range anacrolixFiles {
		prio := types.PiecePriorityNone
		if i == videoIdx || i == subIdx || i == autoSubIdx {
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
		// Refresh the piece's completion state from storage
		// (Piece.UpdateCompletion, v1.61: re-reads the piece-completion
		// store under the client lock and updates storageCompletionOk).
		// Insurance for the v1 path where the initial hash can be delayed:
		// a piece that was already verified in a previous session — or
		// whose completion is already recorded — is immediately marked
		// storageCompletionOk=true, so the head piece is never stuck at
		// effectivePriority None (ignoreForRequests) before the reader
		// demand arrives. Only the head window is refreshed (bounded, no
		// per-piece boltDB views across the whole torrent): once the head
		// piece is marked complete, anacrolix's normal verification path
		// carries the rest. v2-only torrents are rejected before Select,
		// so only v1/hybrid torrents reach this refresh.
		h.t.Piece(i).UpdateCompletion()
	}
	// Elevate the selected video's tail window (MKV Cues / seek table)
	// above Normal priority. The Cues element is typically near the end of
	// the file; without it the browser's video element cannot locate
	// keyframes for arbitrary seeks, leaving seeking stuck (seeking=true,
	// readyState=1). The tail window is independent of the head window —
	// both are elevated so playback can start from byte 0 AND seeks work
	// once the tail is available.
	tailBegin, tailEnd := tailWindowPieces(videoFile)
	for i := tailBegin; i < tailEnd; i++ {
		h.t.Piece(i).SetPriority(types.PiecePriorityHigh)
		h.t.Piece(i).UpdateCompletion()
	}
	// The embedded subtitle's head window gets High too: the file is small
	// (typically <1 MiB), so the head window covers essentially all of it —
	// its download starts immediately and SubtitleContent (responsive) can
	// read the reference while the video is still downloading.
	if autoSubIdx >= 0 {
		subFile := anacrolixFiles[autoSubIdx]
		subBegin, subEnd := headWindowPieces(subFile)
		for i := subBegin; i < subEnd; i++ {
			h.t.Piece(i).SetPriority(types.PiecePriorityHigh)
			h.t.Piece(i).UpdateCompletion()
		}
	}
	h.selected = anacrolixFiles[videoIdx]
	if subIdx >= 0 {
		h.subtitleIdx = subIdx
	} else {
		h.subtitleIdx = -1
	}
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

// tailWindowPieces returns the bounded piece window [begin, end) at the
// END of f to pre-elevate on selection: the pieces covering the last
// tailWindowBytes of the file, derived from the file's last piece index
// and the torrent's piece length. Degenerate inputs yield an empty
// window (no elevation). The window is clamped to the file's pieces and
// never overlaps with the head window.
func tailWindowPieces(f *torrent.File) (begin, end int) {
	fileBegin := f.BeginPieceIndex()
	fileEnd := f.EndPieceIndex()
	info := f.Torrent().Info()
	if info == nil || info.PieceLength <= 0 || fileEnd <= fileBegin {
		return fileBegin, fileBegin
	}
	availablePieces := fileEnd - fileBegin
	n := bootstrapPieceCount(TailWindowBytes, info.PieceLength, availablePieces)
	// The tail window starts n pieces before fileEnd.
	tailBegin := fileEnd - n
	if tailBegin < fileBegin {
		tailBegin = fileBegin
	}
	return tailBegin, fileEnd
}

// SafeCloseReader closes an anacrolix torrent reader, recovering the
// invariant-check panic (checkPendingPiecesMatchesRequestOrder — anacrolix
// v1.61.0 bug) that can fire when a reader closes while a large number of
// pieces are still pending (e.g. a job ends mid-download). The torrent
// state remains usable after the panic; we log it and keep the process
// alive. Use this instead of a plain Close for every torrent-backed reader.
//
// Logging note: this package-level helper is called from other packages
// (internal/api), so it logs via the default slog handler (stderr) rather
// than the diag.Logger file — the diag-path log for the bootstrap reader is
// emitted by StartBootstrap's goroutine recover. The asymmetry is
// intentional: the recover is what matters, and the stderr line still
// reaches the companion's captured output.
func SafeCloseReader(r io.Closer) {
	if r == nil {
		return
	}
	defer func() {
		if rec := recover(); rec != nil {
			slog.Error("recovered panic closing torrent reader", "panic", rec)
		}
	}()
	_ = r.Close()
}

// StartBootstrap registers an anacrolix Reader demand for the selected
// video's head. A dedicated reader seeks to byte 0 and issues one bounded
// read: anacrolix's Reader scheduling then marks the first demanded piece
// "Now" (highest urgency) and the readahead window "Readahead" — the head
// pieces are requested immediately, without waiting for the player's first
// HTTP range request. The read blocks until the first verified piece
// arrives or ctx ends; the demand persists while the reader lives, so the
// goroutine parks on ctx.Done and closes the reader on job end (the close
// is guarded by SafeCloseReader). Reads pull from shared piece storage, so
// no data is consumed that the HTTP readers need, and the manager's state
// machine is never blocked.
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
		SafeCloseReader(r)
		return err
	}
	go func() {
		// The goroutine-level recover catches panics from r.Read(); the
		// SafeCloseReader defer below catches panics from r.Close().
		// Both are needed — anacrolix v1.61.0 can panic in its invariant
		// check (checkPendingPiecesMatchesRequestOrder) from either path.
		// The torrent state is still usable; log and keep the process alive.
		defer func() {
			if rec := recover(); rec != nil {
				h.log.Errorf("torrent.engine", "recovered panic in StartBootstrap reader: %v", rec)
			}
		}()
		// Keep the bootstrap reader alive until the job context ends: its
		// readahead is what keeps requesting the head pieces. Closing it
		// after the first byte (6dbfe2e attempt) left no reader demanding
		// the head — effective priority dropped to None and DL stalled.
		// The close is guarded by SafeCloseReader (anacrolix v1.61.0
		// invariant-check panic); the process stays alive.
		defer SafeCloseReader(r)
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

// HTTPReader returns a seekable reader with a larger readahead window
// (httpReadaheadBytes) suitable for HTTP Range serving. The increased
// readahead ensures that after a seek to a mid-file position, enough
// forward pieces are requested to keep the 206 response flowing without
// stalls. Responsive mode is enabled so that the reader returns data as
// soon as the underlying chunks become available, without waiting for
// piece hash verification to complete — this prevents the post-seek
// stall where a mid-file piece is not yet verified and the reader
// blocks indefinitely. The bootstrap reader and the HTTP reader are
// independent — each drives its own piece demand.
func (h *anacrolixHandle) HTTPReader(ctx context.Context) (io.ReadSeekCloser, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.selected == nil {
		return nil, errInvalidSelection
	}
	r := h.selected.NewReader()
	r.SetContext(ctx)
	r.SetReadahead(httpReadaheadBytes) // larger readahead for HTTP serving
	r.SetResponsive()                  // read without waiting for piece hash verification
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

// SubtitleContent reads the subtitle reference text and returns it. When a
// subtitle was explicitly selected it reads that file; otherwise the first
// subtitle file in the torrent is auto-detected (embedded-subtitle
// reference for sub-to-sub sync — Select elevates its pieces so the data is
// downloaded). Blocks until data is available or ctx is done. Returns an
// error when the torrent has no subtitle file at all or the read fails.
func (h *anacrolixHandle) SubtitleContent(ctx context.Context) (string, error) {
	h.mu.Lock()
	idx := h.subtitleIdx
	files := h.files
	h.mu.Unlock()
	anacrolixFiles := h.t.Files()
	if idx < 0 || idx >= len(anacrolixFiles) {
		// No explicit subtitle — auto-detect the first subtitle file in the
		// torrent (the selection contract allows a video-only pick; the
		// torrent may still carry a .srt/.vtt/.ass next to the video).
		// files mirrors h.t.Files() indices 1:1 from construction time
		// (anacrolix treats the file list as immutable after metadata
		// resolves), so the index from firstSubtitleIndex(files) is valid
		// against anacrolixFiles below.
		idx = firstSubtitleIndex(files)
		if idx < 0 || idx >= len(anacrolixFiles) {
			return "", errSubtitleNotSelected
		}
	}
	f := anacrolixFiles[idx]
	r := f.NewReader()
	// Responsive mode: serve chunks as soon as they arrive instead of
	// waiting for piece verification, so the embedded-subtitle reference is
	// readable while the download is still in progress (not only after the
	// media completes). The read is bounded by subtitleReadTimeout so a slow
	// swarm fails cleanly instead of hanging the sync button.
	// Responsive mode returns chunks as they arrive, without waiting for
	// piece verification. For tiny subtitle files (<1 MiB) this trades
	// unverified-chunk risk for availability: pieces verify quickly and
	// the reference read is bounded by subtitleReadTimeout below.
	r.SetResponsive()
	readCtx, cancel := context.WithTimeout(ctx, subtitleReadTimeout)
	defer cancel()
	r.SetContext(readCtx)
	defer SafeCloseReader(r)
	// Read the entire subtitle file (typically small, <1 MB).
	var buf strings.Builder
	tmp := make([]byte, 32*1024)
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			buf.Write(tmp[:n])
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			if errors.Is(err, context.DeadlineExceeded) {
				return "", fmt.Errorf("subtitle read timed out: %w", err)
			}
			return "", err
		}
	}
	return buf.String(), nil
}

func (h *anacrolixHandle) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.t.Drop()
	return nil
}

// CreationDate returns the torrent's creation date as a Unix timestamp.
// Used as the modtime for http.ServeContent so Chrome's If-Range header
// works correctly (htorrent pattern: time.Unix(f.Torrent().Metainfo().CreationDate, 0)).
func (h *anacrolixHandle) CreationDate() int64 {
	return h.t.Metainfo().CreationDate
}

// AnchorSeek elevates the piece containing offset to PiecePriorityNow and
// surrounding pieces to PiecePriorityHigh (tiramisu pattern:
// cache.go:426-448). Called on HTTP Range requests so the seek position's
// data is fetched immediately, preventing the Chrome seek loop (GPU 100%).
func (h *anacrolixHandle) AnchorSeek(offset int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.selected == nil {
		return
	}
	info := h.t.Info()
	if info == nil || info.PieceLength <= 0 {
		return
	}
	fileBegin := h.selected.BeginPieceIndex()
	fileEnd := h.selected.EndPieceIndex()
	// Convert byte offset to piece index, clamped to the selected file's range.
	pieceIdx := int(offset / int64(info.PieceLength))
	if pieceIdx < fileBegin {
		pieceIdx = fileBegin
	}
	if pieceIdx >= fileEnd {
		pieceIdx = fileEnd - 1
	}
	// Anchor: the seek position's piece gets highest priority (Now).
	h.t.Piece(pieceIdx).SetPriority(types.PiecePriorityNow)
	h.t.Piece(pieceIdx).UpdateCompletion()
	// Surrounding pieces (±3) get High priority for readahead continuity
	// (tiramisu's Readahead/High window).
	const anchorRadius = 3
	for d := -anchorRadius; d <= anchorRadius; d++ {
		if d == 0 {
			continue // already set to Now
		}
		p := pieceIdx + d
		if p < fileBegin || p >= fileEnd {
			continue
		}
		h.t.Piece(p).SetPriority(types.PiecePriorityHigh)
		h.t.Piece(p).UpdateCompletion()
	}
}

var (
	errInvalidMagnet       = errors.New("invalid magnet")
	errInvalidSelection    = errors.New("invalid selection")
	errSubtitleNotSelected = errors.New("subtitle not selected")
	// errV2Unsupported is returned by Start when the fetched metainfo is a
	// v2-only torrent (BEP 52), which anacrolix v1.61 cannot download. The
	// manager maps it to ErrCodeV2Unsupported (StateError).
	errV2Unsupported = errors.New("v2-only torrent not supported")
)
