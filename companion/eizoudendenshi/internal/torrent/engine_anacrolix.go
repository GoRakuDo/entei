package torrent

import (
	"context"
	"errors"
	"fmt"
	"io"
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
//   - the selected video's reader drives piece priority: the pieces needed
//     for a seek become the highest priority, with bounded forward
//     readahead — availability is reported piece-accurately from the piece
//     state runs, never from file size or zero probing.
type engineAnacrolix struct {
	client *torrent.Client
}

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
// and prioritizes the head with in-order readahead.
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
	h.selected = anacrolixFiles[videoIdx]
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
	r.SetReadahead(4 << 20) // bounded forward readahead
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
