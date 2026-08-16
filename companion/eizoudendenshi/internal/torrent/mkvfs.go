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
	"io"
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

// clampedReadSeekCloser wraps a torrent-backed reader and presents the file
// truncated at max bytes: reads at or past max return EOF immediately (the
// anacrolix reader is never touched, so a not-yet-downloaded range can never
// block) and reads crossing max return only the in-range part. Seeks are
// forwarded unchanged and SeekEnd reports the REAL source end — mkvgo's tail
// scan and payload skips compute offsets against the true length, and a
// clamped end would turn those skips into errors instead of graceful
// EOF-stops at the DL'd boundary. The wrapper stays position-synchronized
// with the underlying reader at all times (both advance on Read and are set
// on Seek), so a Read never issues against a stale underlying offset.
type clampedReadSeekCloser struct {
	r   io.ReadSeekCloser
	max int64
	pos int64
}

func (c *clampedReadSeekCloser) Read(p []byte) (int, error) {
	if c.pos >= c.max {
		return 0, io.EOF
	}
	if int64(len(p)) > c.max-c.pos {
		p = p[:c.max-c.pos]
	}
	n, err := c.r.Read(p)
	c.pos += int64(n)
	return n, err
}

func (c *clampedReadSeekCloser) Seek(offset int64, whence int) (int64, error) {
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = c.pos + offset
	case io.SeekEnd:
		n, err := c.r.Seek(offset, io.SeekEnd)
		if err == nil {
			c.pos = n
		}
		return n, err
	default:
		return 0, errors.New("clampedReadSeekCloser: invalid whence")
	}
	if abs < 0 {
		return 0, errors.New("clampedReadSeekCloser: negative position")
	}
	n, err := c.r.Seek(abs, io.SeekStart)
	if err == nil {
		c.pos = n
	}
	return n, err
}

func (c *clampedReadSeekCloser) Close() error { return c.r.Close() }

// mkvFSFor adapts a torrent file source to mkvgo's mkv.FS. Open and Stat are
// wired; every other field stays nil so mkvgo falls back to the real OS (the
// probe/extract paths never touch those operations). The ctx is captured once
// and bound to every reader the FS opens — the caller wraps it with the
// subtitle read timeout so a blocking anacrolix read cannot hang.
//
// maxOffset is the byte extent the FS presents: every reader Open yields is
// clamped to [0, maxOffset), so reads past the DL'd verified prefix return
// EOF instead of blocking on missing pieces, and Stat reports the clamped
// size. mkvgo then sees a prefix-truncated MKV: the container head parses,
// the block walk stops at the boundary, and Cues-driven jumps beyond it
// validate as stale and are dropped — the extraction returns exactly the
// subtitle cues the downloaded prefix holds.
func mkvFSFor(ctx context.Context, src torrentFileSource, maxOffset int64) *mkv.FS {
	return &mkv.FS{
		Open: func(_ string) (mkv.ReadSeekCloser, error) {
			r, err := src.openFile(ctx)
			if err != nil {
				return nil, err
			}
			return &clampedReadSeekCloser{r: r, max: maxOffset}, nil
		},
		Stat: func(_ string) (os.FileInfo, error) {
			size := src.fileLength()
			if maxOffset >= 0 && maxOffset < size {
				size = maxOffset
			}
			return &mkvFileInfo{size: size}, nil
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
	if id := firstTextSubtitleTrackID(c.Tracks); id != 0 {
		return id, nil
	}
	return 0, errNoEmbeddedSubtitle
}

// firstTextSubtitleTrackID returns the ID of the first TEXT subtitle track
// (srt/ass/ssa/webvtt) in a parsed container's track list, or 0 when there is
// none. Shared by the probe (firstTextSubtitleTrack) and the subtitle cue
// pump, which works from an already-parsed container.
func firstTextSubtitleTrackID(tracks []mkv.Track) uint64 {
	for _, t := range tracks {
		if t.Type == matroska.SubtitleTrack && isTextSubtitleCodec(t.Codec) {
			return t.ID
		}
	}
	return 0
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
// extraction needs hash-verified bytes (the LazySync prefix path clamps reads
// to verified pieces, and the completed-file path reads fully verified data),
// so reads never block on piece verification. The close is mkvgo's own (it
// closes every reader it opens).
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
// downloaded and verified. It remains the gate for operations that must read
// arbitrary byte ranges across the whole file (container head, Cues, subtitle
// blocks); the LazySync embedded-subtitle path no longer requires it — that
// extraction runs on the DL'd verified prefix (see embeddedSubtitleContent and
// the maxOffset clamping in mkvFSFor) — but the subtitle cue pump uses it to
// know when there is nothing left to prioritize.
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
