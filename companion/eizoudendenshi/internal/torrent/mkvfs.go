package torrent

// This file adapts the selected anacrolix torrent file to mkvgo's mkv.FS
// abstraction (vendor/mkvgo), so the embedded subtitle tracks of a video
// (MKV SRT/ASS/VTT tracks) can be read directly from the torrent without a
// disk copy. Only the read side is wired: mkvgo's probe/extract paths never
// create, write or remove through the FS.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/gravity-zero/mkvgo/matroska"
	"github.com/gravity-zero/mkvgo/mkv"
)

// torrentFileSource is the minimal access to the selected torrent file the
// mkv.FS adapter needs: opening fresh seekable readers and reporting the byte
// length. anacrolixHandle implements it over the selected video.
type torrentFileSource interface {
	// openFile returns a NEW independent seekable reader positioned at
	// offset 0. mkvgo opens the source more than once in a single operation
	// (a metadata probe, then the block reader), so each call must yield a
	// fresh reader; reads block until data is available or ctx ends.
	openFile(ctx context.Context) (mkv.ReadSeekCloser, error)
	// fileLength is the source's total byte length.
	fileLength() int64
}

// mkvFileInfo is the os.FileInfo the adapter's Stat reports. Only Size is
// meaningful to mkvgo's read paths; the rest are zero values.
type mkvFileInfo struct {
	size int64
}

func (i *mkvFileInfo) Name() string       { return "in" }
func (i *mkvFileInfo) Size() int64        { return i.size }
func (i *mkvFileInfo) Mode() os.FileMode  { return 0 }
func (i *mkvFileInfo) ModTime() time.Time { return time.Time{} }
func (i *mkvFileInfo) IsDir() bool        { return false }
func (i *mkvFileInfo) Sys() any           { return nil }

// mkvFSFor adapts a torrent file source to mkvgo's mkv.FS. Open and Stat are
// wired; every other field stays nil so mkvgo falls back to the real OS (the
// probe/extract paths never touch those operations). The ctx is captured once
// and bound to every reader the FS opens — the caller wraps it with the
// subtitle read timeout so a blocking anacrolix read cannot hang.
func mkvFSFor(ctx context.Context, src torrentFileSource) *mkv.FS {
	return &mkv.FS{
		Open: func(_ string) (mkv.ReadSeekCloser, error) {
			return src.openFile(ctx)
		},
		Stat: func(_ string) (os.FileInfo, error) {
			return &mkvFileInfo{size: src.fileLength()}, nil
		},
	}
}

// errNoEmbeddedSubtitle is returned when the selected video carries no text
// subtitle track mkvgo can extract.
var errNoEmbeddedSubtitle = errors.New("no embedded text subtitle track")

// firstTextSubtitleTrack probes the container at src through fs and returns
// the ID of the FIRST text subtitle track (srt/ass/ssa/webvtt), language
// agnostic — matching the web player's "first subtitle track" pick. Bitmap
// subtitle tracks (pgs, dvdsub, …) are skipped: mkvgo's WebVTT extraction
// only converts text codecs, so a bitmap-first file would otherwise fail even
// when a usable text track follows.
func firstTextSubtitleTrack(ctx context.Context, fs *mkv.FS) (uint64, error) {
	c, err := matroska.OpenMetaWithFS(ctx, "in", fs)
	if err != nil {
		return 0, fmt.Errorf("probe container: %w", err)
	}
	for _, t := range c.Tracks {
		if t.Type == matroska.SubtitleTrack && isTextSubtitleCodec(t.Codec) {
			return t.ID, nil
		}
	}
	return 0, errNoEmbeddedSubtitle
}

// isTextSubtitleCodec reports whether an mkvgo codec short name is a text
// format convertible to WebVTT (mirrors mkvgo's ops.isTextSubtitle).
func isTextSubtitleCodec(codec string) bool {
	switch codec {
	case "srt", "ass", "ssa", "webvtt":
		return true
	}
	return false
}

// --- anacrolixHandle as torrentFileSource ---

// openFile implements torrentFileSource for anacrolixHandle: a fresh
// non-responsive reader over the selected video with the given context. The
// responsive HTTP reader is deliberately NOT used here — embedded-subtitle
// extraction needs hash-verified bytes, and the caller only runs it once the
// file is complete, so reads never block on piece verification. The close is
// mkvgo's own (it closes every reader it opens); on a completed file no pieces
// are pending, so the anacrolix v1.61 invariant-check close panic cannot fire.
func (h *anacrolixHandle) openFile(ctx context.Context) (mkv.ReadSeekCloser, error) {
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

func (h *anacrolixHandle) fileLength() int64 {
	return h.SelectedLength()
}

// SelectedComplete reports whether every piece of the selected file has been
// downloaded and verified. Embedded-subtitle extraction reads arbitrary byte
// ranges across the whole file (container head, Cues, subtitle blocks), which
// blocks on missing or unverified pieces — callers must gate on this and only
// extract once the file is complete.
func (h *anacrolixHandle) SelectedComplete() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.selected == nil {
		return false
	}
	for _, fps := range h.selected.State() {
		if !fps.Ok || !fps.Complete {
			return false
		}
	}
	return true
}
