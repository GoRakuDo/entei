package api

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/gravity-zero/mkvgo/ebml"
	"github.com/gravity-zero/mkvgo/mkv"
	"github.com/gravity-zero/mkvgo/mkv/reader"
)

// isMKVExtension reports whether the filename has an .mkv extension
// (case-insensitive).
func isMKVExtension(fileName string) bool {
	ext := ""
	for i := len(fileName) - 1; i >= 0; i-- {
		if fileName[i] == '.' {
			ext = fileName[i+1:]
			break
		}
	}
	return strings.EqualFold(ext, "mkv")
}

// rewriteMKVDefaultAudio reads the MKV header from r, detects audio tracks,
// and when exactly 2 audio tracks exist with a Japanese one, rewrites the
// Default flag so the Japanese track becomes the default playback track.
//
// It uses mkvgo's reader (which correctly handles all VINT sizes including
// 8-byte Segment sizes) for parsing, and ebml.ReadElementHeader for
// byte-level scanning to locate Default flag offsets in the original buffer.
//
// The function reads at most maxHeaderRead bytes (2 MB) to cover the MKV
// header without consuming the entire file. The modified header is a copy of
// the read buffer with only the Default flag bytes changed, preserving the
// exact byte count so combinedReader can seamlessly serve it.
//
// Returns:
//   - modified: the header bytes with the Default flags rewritten (same length
//     as bytes read from r), or nil if no rewriting was needed.
//   - ok: true when modified is a valid replacement header.
//   - reason: empty on success; a short identifier describing why the rewrite was skipped.
//
// After calling this function the caller must combine modified with the
// remaining unread stream (io.ReadSeeker at position 0, past the header).
func rewriteMKVDefaultAudio(ctx context.Context, r io.ReadSeeker) (modified []byte, ok bool, reason string) {
	const maxHeaderRead = 2 * 1024 * 1024

	buf := make([]byte, maxHeaderRead)
	n, readErr := r.Read(buf)
	if readErr != nil && readErr != io.EOF {
		r.Seek(0, io.SeekStart)
		return nil, false, "read_error"
	}
	buf = buf[:n]

	if _, seekErr := r.Seek(0, io.SeekStart); seekErr != nil {
		return nil, false, "seek_error"
	}

	if len(buf) < 12 {
		return nil, false, "header_too_short"
	}

	// Parse with mkvgo (handles all VINT widths including 8-byte Segment sizes).
	container, parseErr := reader.Read(ctx, bytes.NewReader(buf), "dummy.mkv")
	if parseErr != nil {
		return nil, false, fmt.Sprintf("parse_error: %v", parseErr)
	}

	// Collect audio track indices (matching TrackEntry order in the buffer).
	var audioIndices []int
	for i := range container.Tracks {
		if container.Tracks[i].Type == mkv.AudioTrack {
			audioIndices = append(audioIndices, i)
		}
	}

	if len(audioIndices) != 2 {
		return nil, false, "audio_tracks_not_2"
	}

	// Find Japanese track among the audio tracks.
	var jaIdx int = -1
	for _, idx := range audioIndices {
		lang := strings.ToLower(container.Tracks[idx].ResolvedLanguage())
		if lang == "jpn" || lang == "ja" {
			jaIdx = idx
			break
		}
	}
	if jaIdx < 0 {
		return nil, false, "no_japanese_track"
	}

	// Both audio tracks must have explicit Default elements in the file.
	for _, idx := range audioIndices {
		if !container.Tracks[idx].DefaultPresent {
			return nil, false, "default_element_missing"
		}
	}

	// Scan the buffer for Default flag byte offsets (one per TrackEntry, in order).
	defaultOffsets := findDefaultOffsets(buf)
	if len(defaultOffsets) != len(container.Tracks) {
		return nil, false, "default_offset_scan_mismatch"
	}

	for _, idx := range audioIndices {
		if defaultOffsets[idx] < 0 {
			return nil, false, "default_element_missing"
		}
	}

	// Make a modifiable copy of the header (same length as the original read).
	modified = make([]byte, len(buf))
	copy(modified, buf)

	// Determine the non-Japanese audio track index.
	otherIdx := audioIndices[0]
	if otherIdx == jaIdx {
		otherIdx = audioIndices[1]
	}

	// Set Japanese track Default = 1, other track Default = 0.
	modified[defaultOffsets[jaIdx]] = 1
	modified[defaultOffsets[otherIdx]] = 0

	return modified, true, ""
}

// ---------------------------------------------------------------------------
// EBML byte-offset scanner using mkvgo's ebml.ReadElementHeader
// ---------------------------------------------------------------------------

// findDefaultOffsets scans buf for Default flag (0x88) value byte offsets
// within each TrackEntry element, in TrackEntry order. Returns a slice where
// the i-th element is the byte offset of the Default value for TrackEntry i,
// or -1 if no Default element was found in that TrackEntry.
//
// Uses ebml.ReadElementHeader which correctly handles all VINT sizes
// (including 8-byte sizes for large Segment elements).
func findDefaultOffsets(buf []byte) []int {
	br := bytes.NewReader(buf)

	// Skip EBML header
	ebmlHdr, _, err := ebml.ReadElementHeader(br)
	if err != nil {
		return nil
	}
	if ebmlHdr.ID != ebml.IDEBMLHeader {
		return nil
	}
	if _, err := br.Seek(ebmlHdr.Size, io.SeekCurrent); err != nil {
		return nil
	}

	// Read Segment header
	segHdr, _, err := ebml.ReadElementHeader(br)
	if err != nil {
		return nil
	}
	if segHdr.ID != mkv.IDSegment {
		return nil
	}

	segBodyStart, _ := br.Seek(0, io.SeekCurrent)
	var segEnd int64 = -1
	if segHdr.Size >= 0 {
		segEnd = segBodyStart + segHdr.Size
	}

	// Scan Segment children for Tracks
	for {
		pos, _ := br.Seek(0, io.SeekCurrent)
		if segEnd >= 0 && pos >= segEnd {
			break
		}
		if pos >= int64(len(buf)) {
			break
		}

		childHdr, _, err := ebml.ReadElementHeader(br)
		if err != nil {
			break
		}
		if childHdr.Size < 0 {
			break // unknown-size child: cannot navigate
		}

		if childHdr.ID == mkv.IDTracks {
			return scanTracksForDefaults(buf, br, childHdr.Size)
		}

		if _, err := br.Seek(childHdr.Size, io.SeekCurrent); err != nil {
			break
		}
	}

	return nil
}

// scanTracksForDefaults walks a Tracks element's children and returns
// Default flag value-byte offsets for each TrackEntry, in order.
func scanTracksForDefaults(buf []byte, br *bytes.Reader, tracksSize int64) []int {
	tracksBodyStart, _ := br.Seek(0, io.SeekCurrent)
	tracksEnd := tracksBodyStart + tracksSize

	var offsets []int

	for {
		tePos, _ := br.Seek(0, io.SeekCurrent)
		if tePos >= tracksEnd || tePos >= int64(len(buf)) {
			break
		}

		teHdr, _, err := ebml.ReadElementHeader(br)
		if err != nil {
			break
		}
		if teHdr.Size < 0 {
			break
		}

		if teHdr.ID == mkv.IDTrackEntry {
			teBodyStart, _ := br.Seek(0, io.SeekCurrent)
			teBodyEnd := teBodyStart + teHdr.Size
			defOff := -1

			for {
				chPos, _ := br.Seek(0, io.SeekCurrent)
				if chPos >= teBodyEnd || chPos >= int64(len(buf)) {
					break
				}

				chHdr, _, err := ebml.ReadElementHeader(br)
				if err != nil {
					break
				}
				if chHdr.Size < 0 {
					break
				}

				if chHdr.ID == mkv.IDFlagDefault && chHdr.Size == 1 {
					vPos, _ := br.Seek(0, io.SeekCurrent)
					if vPos < int64(len(buf)) {
						defOff = int(vPos)
					}
				}

				if _, err := br.Seek(chHdr.Size, io.SeekCurrent); err != nil {
					break
				}
			}

			offsets = append(offsets, defOff)
			// Position is already at teBodyEnd after children scan; no skip needed.
		} else {
			// Non-TrackEntry element: skip its body.
			if _, err := br.Seek(teHdr.Size, io.SeekCurrent); err != nil {
				break
			}
		}
	}

	return offsets
}

// ---------------------------------------------------------------------------
// combinedReader: ModifiedMKVHeader + OriginalStream, seekable.
// ---------------------------------------------------------------------------
// http.ServeContent needs io.ReadSeeker to honor Range requests correctly.
// combinedReader presents a modified MKV header followed by the original
// stream as one seekable stream. The stream represents the full original
// file at position 0; the modified header replaces bytes [0, headerLen)
// in-memory. Virtual position p maps directly to stream position p.

type combinedReader struct {
	header    *bytes.Reader // modified MKV header bytes
	headerLen int64         // original header length (does not change)
	stream    io.ReadSeeker // original stream at position 0 (full file)
	pos       int64         // virtual file position
}

func (c *combinedReader) Read(p []byte) (int, error) {
	// Within the header region: read from the in-memory header.
	if c.pos < c.headerLen {
		n, err := c.header.Read(p)
		c.pos += int64(n)
		// If the header is exhausted but the caller's buffer is not full,
		// transparently continue into the stream.
		if n < len(p) && c.header.Len() == 0 {
			// Stream is the full file at position 0; virtual pos = stream pos.
			if _, seekErr := c.stream.Seek(c.pos, io.SeekStart); seekErr != nil {
				return n, seekErr
			}
			n2, err2 := c.stream.Read(p[n:])
			c.pos += int64(n2)
			return n + n2, err2
		}
		return n, err
	}

	// Beyond the header: read from the original stream.
	// Stream is the full file at position 0; virtual pos = stream pos.
	streamOff := c.pos
	if _, err := c.stream.Seek(streamOff, io.SeekStart); err != nil {
		return 0, err
	}
	n, err := c.stream.Read(p)
	c.pos += int64(n)
	return n, err
}

func (c *combinedReader) Seek(offset int64, whence int) (int64, error) {
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = c.pos + offset
	case io.SeekEnd:
		// Total = stream size (header is replaced in-place, not appended).
		streamEnd, err := c.stream.Seek(0, io.SeekEnd)
		if err != nil {
			return 0, err
		}
		abs = streamEnd + offset
	default:
		return 0, io.ErrNoProgress
	}
	if abs < 0 {
		return 0, io.ErrNoProgress
	}
	c.pos = abs
	// Synchronize the header reader so subsequent Read picks up correctly.
	if abs < c.headerLen {
		c.header.Seek(abs, io.SeekStart)
	}
	return abs, nil
}
