package api

import (
	"bytes"
	"context"
	"io"
	"log"
	"strings"
)

// EBML element IDs used for MKV audio track detection and Default flag rewriting.
// These are defined locally (not imported from torrent/container.go) per the
// constraint that container.go is not modified.
// Note: EBML element IDs use a different encoding from VINT sizes — the first
// byte's high bits indicate byte length without a marker bit. 1-byte IDs have
// the top bit clear (0x01..0x7F), 2-byte IDs have top 2 bits = 01 (0x4000..0x7FFF), etc.
const (
	mkvEBML       = 0x1A45DFA3 // EBML header element (4 bytes: 0x1A, 0x45, 0xDF, 0xA3)
	mkvSegment    = 0x18538067 // Segment element
	mkvTracks     = 0x1654AE6B // Tracks element
	mkvTrackEntry = 0xAE       // TrackEntry element (1 byte)
	mkvTrackType  = 0x83       // TrackEntry child: TrackType (uint8, 1 byte)
	mkvLanguage   = 0x22B59C   // TrackEntry child: Language (UTF-8 string)
	mkvDefault    = 0x88       // TrackEntry child: Default (uint8, 0 or 1)
	mkvCodecID    = 0x86       // TrackEntry child: CodecID (string)

	audioTrackTypeValue = 0x02 // TrackType element value for audio
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
// The function reads at most maxHeaderRead bytes (2 MB) to cover the MKV
// header without consuming the entire file. It then parses EBML elements
// to locate Segment → Tracks → TrackEntry elements, inspects TrackType,
// Language, and Default children of each TrackEntry, and modifies the
// Default flags in the already-read header buffer.
//
// Returns:
//   - modified: the header bytes with the Default flags rewritten (or nil if
//     no rewriting was needed or the header was too small/malformed).
//   - ok: true when modified is a valid replacement header.
//   - reason: empty on success; a short identifier describing why the rewrite was skipped.
//
// After calling this function the caller must combine modified with the
// remaining unread stream (io.ReadSeeker at position 0, past the header).
func rewriteMKVDefaultAudio(_ context.Context, r io.ReadSeeker) (modified []byte, ok bool, reason string) {
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

	if buf[0] != 0x1A || buf[1] != 0x45 || buf[2] != 0xDF || buf[3] != 0xA3 {
		return nil, false, "not_ebml"
	}

	ebmlBody, ebmlBodyLen := skipEBMLHeader(buf)
	if ebmlBody < 0 || ebmlBody+ebmlBodyLen > len(buf) {
		return nil, false, "ebml_header_parse_fail"
	}
	segStart := ebmlBody + ebmlBodyLen
	if segStart >= len(buf) {
		return nil, false, "no_segment"
	}

	// Diagnostic: log bytes around Segment start for debugging.
	if segStart+4 <= len(buf) {
		hex := make([]byte, 0, 12)
		for i := segStart; i < segStart+12 && i < len(buf); i++ {
			hex = append(hex, buf[i])
		}
		log.Printf("mkv audio debug: buf=%d ebmlBody=%d ebmlBodyLen=%d segStart=%d bytes=%x", len(buf), ebmlBody, ebmlBodyLen, segStart, hex)
	}

	seg, segBody, segOK := parseEBMLElement(buf, segStart)
	if !segOK {
		log.Printf("mkv audio debug: parseEBMLElement failed at segStart=%d", segStart)
		return nil, false, "segment_not_found"
	}
	if seg.ID != mkvSegment {
		log.Printf("mkv audio debug: element at segStart=%d has ID=0x%X, want 0x%X", segStart, seg.ID, mkvSegment)
		return nil, false, "segment_not_found"
	}
	segEnd := seg.BodyEnd

	var tracksElem *ebmlElem
	off := segBody
	for off < segEnd && off < len(buf) {
		e, body, eOK := parseEBMLElement(buf, off)
		if !eOK {
			break
		}
		if e.ID == mkvTracks {
			tracksElem = &ebmlElem{ID: e.ID, BodyOff: body, BodyEnd: e.BodyEnd}
			break
		}
		off = e.BodyEnd
	}
	if tracksElem == nil {
		return nil, false, "tracks_not_found"
	}

	trackEntries, err := parseTrackEntries(buf, tracksElem.BodyOff, tracksElem.BodyEnd)
	if err != nil || len(trackEntries) == 0 {
		return nil, false, "no_track_entries"
	}

	// Collect audio tracks: (trackEntryBodyStart, trackEntryBodyEnd, isJapanese, defaultOffset).
	type audioTrack struct {
		bodyStart     int
		bodyEnd       int
		isJapanese    bool
		defaultOffset int // offset of the Default value byte in buf, -1 if not found
	}
	var audioTracks []audioTrack

	for _, te := range trackEntries {
		tt, lang, defOff, teErr := parseTrackEntryChildren(buf, te.bodyStart, te.bodyEnd)
		if teErr != nil {
			continue
		}
		if tt != audioTrackTypeValue {
			continue
		}
		langLow := bytes.ToLower(lang)
		isJA := bytes.Equal(langLow, []byte("jpn")) || bytes.Equal(langLow, []byte("ja"))
		audioTracks = append(audioTracks, audioTrack{
			bodyStart:     te.bodyStart,
			bodyEnd:       te.bodyEnd,
			isJapanese:    isJA,
			defaultOffset: defOff,
		})
	}

	// Only handle exactly 2 audio tracks.
	if len(audioTracks) != 2 {
		return nil, false, "audio_tracks_not_2"
	}

	var jaIdx int = -1
	for i, at := range audioTracks {
		if at.isJapanese {
			jaIdx = i
			break
		}
	}
	if jaIdx < 0 {
		return nil, false, "no_japanese_track"
	}

	for _, at := range audioTracks {
		if at.defaultOffset < 0 {
			return nil, false, "default_element_missing"
		}
	}

	// Make a modifiable copy of the header.
	modified = make([]byte, len(buf))
	copy(modified, buf)

	// Set Japanese track Default = 1, other track Default = 0.
	modified[audioTracks[jaIdx].defaultOffset] = 1
	otherIdx := 1 - jaIdx
	modified[audioTracks[otherIdx].defaultOffset] = 0

	return modified, true, ""
}

// ---------------------------------------------------------------------------
// EBML parsing helpers (self-contained, does not touch torrent/container.go)
// ---------------------------------------------------------------------------

// ebmlElem describes a parsed EBML element within a byte slice.
type ebmlElem struct {
	ID      uint64
	BodyOff int // first byte after the element header (start of payload / children)
	BodyEnd int // one past the last byte of the element payload
}

// ebmlSize returns the EBML variable-length size at buf[off], excluding the
// marker bit. Returns (value, headerLen, ok).
func ebmlSize(buf []byte, off int) (uint64, int, bool) {
	if off >= len(buf) {
		return 0, 0, false
	}
	b := buf[off]
	mask := byte(0x80)
	hdrLen := 1
	for hdrLen <= 8 && b&mask == 0 {
		mask >>= 1
		hdrLen++
	}
	if hdrLen > 8 || off+hdrLen > len(buf) {
		return 0, 0, false
	}
	val := uint64(b & (mask - 1))
	for i := 1; i < hdrLen; i++ {
		val = val<<8 | uint64(buf[off+i])
	}
	return val, hdrLen, true
}

// ebmlID returns the EBML element ID at buf[off].
// EBML element IDs use a different encoding from VINT sizes: the first byte's
// high bits indicate byte length without a marker bit. 1-byte IDs: 0x01..0x7F,
// 2-byte IDs: 0x4000..0x7FFF, 3-byte IDs: 0x200000..0x3FFFFF, 4-byte IDs:
// 0x10000000..0x1FFFFFFF.
func ebmlID(buf []byte, off int) (uint64, int, bool) {
	if off >= len(buf) {
		return 0, 0, false
	}
	b := buf[off]
	var hdrLen int
	switch {
	case b&0x80 != 0:
		hdrLen = 1 // 1-byte ID: top bit set (0x01..0x7F)
	case b&0xC0 == 0x40:
		hdrLen = 2 // 2-byte ID: top 2 bits = 01 (0x40..0x7F)
	case b&0xE0 == 0x20:
		hdrLen = 3 // 3-byte ID: top 3 bits = 001 (0x20..0x3F)
	case b&0xF0 == 0x10:
		hdrLen = 4 // 4-byte ID: top 4 bits = 0001 (0x10..0x1F)
	default:
		return 0, 0, false
	}
	if off+hdrLen > len(buf) {
		return 0, 0, false
	}
	val := uint64(b)
	for i := 1; i < hdrLen; i++ {
		val = val<<8 | uint64(buf[off+i])
	}
	return val, hdrLen, true
}

// parseEBMLElement parses a single EBML element header and returns its ID,
// body start offset, and body end offset. ok is false on malformed input.
func parseEBMLElement(buf []byte, off int) (ebmlElem, int, bool) {
	id, idLen, idOK := ebmlID(buf, off)
	if !idOK {
		return ebmlElem{}, 0, false
	}
	size, sizeLen, sizeOK := ebmlSize(buf, off+idLen)
	if !sizeOK {
		return ebmlElem{}, 0, false
	}
	bodyOff := off + idLen + sizeLen
	bodyEnd := bodyOff + int(size)
	if bodyEnd > len(buf) {
		return ebmlElem{}, 0, false
	}
	return ebmlElem{ID: id, BodyOff: bodyOff, BodyEnd: bodyEnd}, bodyOff, true
}

// skipEBMLHeader returns the offset and length of the EBML header payload
// (after the header element's own size field), so the caller can find the
// Segment element that follows. Returns (payloadOffset, payloadLength, ok).
func skipEBMLHeader(buf []byte) (int, int) {
	// EBML element header: ID (0x1A45DFA3, 4 bytes) + size.
	id, idLen, ok := ebmlID(buf, 0)
	if !ok || id != mkvEBML {
		return -1, 0
	}
	size, sizeLen, sizeOK := ebmlSize(buf, idLen)
	if !sizeOK {
		return -1, 0
	}
	bodyOff := idLen + sizeLen
	bodyEnd := bodyOff + int(size)
	if bodyEnd > len(buf) {
		return -1, 0
	}
	return bodyOff, int(size)
}

// trackEntryInfo is a parsed TrackEntry within the Tracks element.
type trackEntryInfo struct {
	bodyStart int // first payload byte of this TrackEntry
	bodyEnd   int // one past the last payload byte
}

// parseTrackEntries walks a Tracks element and returns each TrackEntry's
// body range. Only complete TrackEntry elements fully within the buffer are
// returned.
func parseTrackEntries(buf []byte, tracksBodyOff, tracksBodyEnd int) ([]trackEntryInfo, error) {
	var entries []trackEntryInfo
	off := tracksBodyOff
	for off < tracksBodyEnd && off < len(buf) {
		id, idLen, idOK := ebmlID(buf, off)
		if !idOK {
			break
		}
		size, sizeLen, sizeOK := ebmlSize(buf, off+idLen)
		if !sizeOK {
			break
		}
		bodyOff := off + idLen + sizeLen
		bodyEnd := bodyOff + int(size)
		if bodyEnd > tracksBodyEnd || bodyEnd > len(buf) {
			break // truncated or exceeds Tracks boundary
		}
		if id == mkvTrackEntry {
			entries = append(entries, trackEntryInfo{bodyStart: bodyOff, bodyEnd: bodyEnd})
		}
		off = bodyEnd
	}
	return entries, nil
}

// parseTrackEntryChildren scans a TrackEntry's payload for three children:
//   - TrackType (0x83): 1-byte uint8 value
//   - Language  (0x22B59C): UTF-8 string value
//   - Default   (0x88): 1-byte uint8 value; defaultOffset is the byte index
//     in buf where the Default value byte lives (-1 if not found).
//
// A non-zero error means the TrackEntry is malformed.
func parseTrackEntryChildren(buf []byte, bodyStart, bodyEnd int) (
	trackType uint8,
	language []byte,
	defaultOffset int,
	err error,
) {
	defaultOffset = -1
	off := bodyStart
	for off < bodyEnd && off < len(buf) {
		id, idLen, idOK := ebmlID(buf, off)
		if !idOK {
			break
		}
		size, sizeLen, sizeOK := ebmlSize(buf, off+idLen)
		if !sizeOK {
			break
		}
		payloadOff := off + idLen + sizeLen
		payloadEnd := payloadOff + int(size)
		if payloadEnd > bodyEnd || payloadEnd > len(buf) {
			break
		}
		switch id {
		case mkvTrackType:
			if size == 1 && payloadOff < len(buf) {
				trackType = buf[payloadOff]
			}
		case mkvLanguage:
			if payloadOff < payloadEnd && payloadOff <= len(buf) {
				end := payloadEnd
				if end > len(buf) {
					end = len(buf)
				}
				language = make([]byte, end-payloadOff)
				copy(language, buf[payloadOff:end])
			}
		case mkvDefault:
			if size == 1 && payloadOff < len(buf) {
				defaultOffset = payloadOff
			}
		}
		off = payloadEnd
	}
	return
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
	header     *bytes.Reader // modified MKV header bytes
	headerLen  int64         // original header length (does not change)
	stream     io.ReadSeeker // original stream at position 0 (full file)
	pos        int64         // virtual file position
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
