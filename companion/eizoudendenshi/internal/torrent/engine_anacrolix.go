package torrent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/types"
)

// engineAnacrolix implements Engine with anacrolix/torrent.
//
// Security posture:
//   - loopback-only listen (no public bind, no RPC, no browser WebTorrent),
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
	client *torrent.Client
}

// bootstrapWindowBytes is the bounded byte extent of the head bootstrap
// window: the pieces pre-elevated on selection and demanded by the
// bootstrap reader as readahead. It is a scheduling hint only — never a
// playability claim — sized to cover the first contiguous demand the
// player's HTTP range reads will make (byte 0 onward) and identical to the
// reader readahead used by the HTTP layer, so the priority window and the
// demand window are the same bounded region.
const bootstrapWindowBytes = 4 << 20 // 4 MiB

// NewAnacrolixEngine constructs the engine. The client binds a random
// loopback port and does not seed.
func NewAnacrolixEngine() (Engine, error) {
	cfg := torrent.NewDefaultClientConfig()
	// LoopbackListenHost returns "127.0.0.1" for tcp4 and "::1" for tcp6.
	// Hardcoding "127.0.0.1" for all networks causes listen tcp6 failures
	// on hosts that enable IPv6.
	cfg.ListenHost = torrent.LoopbackListenHost
	cfg.ListenPort = 0 // random loopback port
	cfg.Seed = false   // no seeding
	cfg.NoUpload = true
	// The default client logger writes at Warning+ to stderr; a reader read
	// that is cancelled mid-wait (job cancel before the first piece
	// completes, or an HTTP ReadAt timeout) makes anacrolix log "initial
	// read failed" style errors. Those are expected lifecycle noise here —
	// the engine never surfaces them — so point the slogger at a discard
	// handler instead of polluting the companion's stderr.
	cfg.Slogger = slog.New(slog.NewTextHandler(io.Discard, nil))
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("anacrolix client: %w", err)
	}
	return &engineAnacrolix{client: cl}, nil
}

func (e *engineAnacrolix) Close() error {
	if e.client != nil {
		e.client.Close()
		e.client = nil
	}
	return nil
}

func (e *engineAnacrolix) Start(ctx context.Context, magnet string) (TorrentHandle, error) {
	t, err := e.client.AddMagnet(magnet)
	if err != nil {
		return nil, errInvalidMagnet
	}
	select {
	case <-ctx.Done():
		t.Drop()
		return nil, ctx.Err()
	case <-t.GotInfo():
	}
	return newAnacrolixHandle(t), nil
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
		h.files = append(h.files, TorrentFile{
			ID:     fmt.Sprintf("f%d", i),
			Path:   base,
			Length: f.Length(),
			Kind:   classify(ext),
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
