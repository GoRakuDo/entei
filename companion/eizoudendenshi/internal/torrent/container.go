package torrent

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
)

// Structural container analysis for the safe-early-playable predicate.
//
// The old sniff checked only that "ftyp"+some "moov" bytes exist. A partial
// moov (box declared size beyond the verified prefix) or a video codec the
// browser cannot decode (e.g. hvc1/hev1) would then falsely mark a source
// playable — the observed audio-plays/video-black class. This bounded
// parser instead requires, within the VERIFIED prefix:
//
//   - a complete ftyp box,
//   - a complete moov box (declared length fully covered, no truncation),
//   - a stsd video sample entry whose codec is conservatively browser-
//     decodeable (avc1/avc3/vp09/av01; hvc1/hev1 and unknown are rejected),
//   - the first chunk offset + first sample size fully within the prefix
//     (a verified decodable sample boundary).
//
// MKV (EBML) is eligible for progressive early playback only when the
// verified prefix contains complete EBML/Tracks/Cluster structure, a
// conservatively decodeable video track, and a video block for that track.
// A partial or unsupported MKV stays buffering; complete MKV continues to
// be served normally with video/x-matroska. This is not an admission rule.

// maxStructuralScan bounds the box walk (a moov larger than this cannot be
// structurally verified in the early prefix).
const maxStructuralScan = 8 * 1024 * 1024

// decodeableVideoCodecs are conservative stsd video sample entries the
// browser can decode from an early prefix.
var decodeableVideoCodecs = map[string]bool{
	"avc1": true, "avc3": true, // H.264
	"vp09": true, // VP9
	"av01": true, // AV1
}

// undecodeableVideoCodecs are known sample entries that require a decoder
// that is not reliably available in the browser for early streaming.
var undecodeableVideoCodecs = map[string]bool{
	"hvc1": true, "hev1": true, // HEVC/H.265
	"dvh1": true, "dvhe": true, // Dolby Vision (HEVC-based)
	"vp08": true, // VP8 (deprecated in MP4)
}

// box describes one ISO-BMFF box within the scanned prefix.
type box struct {
	typ      string
	start    int64
	size     int64 // declared size (box header included); 0 = to EOF (rejected)
	end      int64
	children []box
	payload  []byte // raw bytes after the box header (non-containers)
}

// walkBoxes parses the top-level boxes of the prefix. Bounded to
// maxStructuralScan bytes; truncated or oversized boxes fail.
func walkBoxes(data []byte) ([]box, error) {
	return walkBoxesMode(data, true)
}

// walkBoxesLenient parses top-level boxes and returns what was parsed
// before the first structural failure (trailing data after the moov, e.g.
// a growing mdat, is not required to be a valid box in a prefix).
func walkBoxesLenient(data []byte) []box {
	boxes, _ := walkBoxesMode(data, false)
	return boxes
}

func walkBoxesMode(data []byte, strict bool) ([]box, error) {
	var out []box
	off := 0
	for off+8 <= len(data) {
		size := int64(binary.BigEndian.Uint32(data[off : off+4]))
		typ := string(data[off+4 : off+8])
		header := int64(8)
		if size == 1 {
			if off+16 > len(data) {
				return nil, errTruncated
			}
			size = int64(binary.BigEndian.Uint64(data[off+8 : off+16]))
			header = 16
		}
		if size == 0 {
			if strict {
				return nil, errTruncated // box to EOF: not verifiable in a prefix
			}
			break
		}
		if off+int(size) > len(data) {
			if strict {
				return nil, fmt.Errorf("box %s size %d exceeds prefix (have %d)", typ, size, len(data))
			}
			break
		}
		if size < header {
			if strict {
				return nil, errTruncated
			}
			break
		}
		end := off + int(size)
		if end > len(data) {
			if strict {
				return nil, errTruncated // declared box extends beyond the prefix
			}
			break
		}
		b := box{typ: typ, start: int64(off), size: size, end: int64(end)}
		if !isContainer(typ) && size > header {
			b.payload = data[off+int(header) : end]
		}
		if isContainer(typ) && size > header {
			childStart := off + int(header)
			if typ == "stsd" {
				// stsd's children are preceded by version(4)+entry_count(4).
				childStart += 8
			}
			kids, err := walkBoxesMode(data[childStart:off+int(size)], strict)
			if err != nil {
				return nil, err
			}
			b.children = kids
		}
		out = append(out, b)
		off = end
		if off > maxStructuralScan {
			break
		}
	}
	return out, nil
}

func isContainer(t string) bool {
	switch t {
	case "moov", "trak", "mdia", "minf", "stbl", "stsd", "udta", "mvex":
		return true
	}
	return false
}

var errTruncated = errContainer("truncated container")

type errContainer string

func (e errContainer) Error() string { return string(e) }

// findBox returns the first box of typ in a box list.
func findBox(boxes []box, typ string) (box, bool) {
	for _, b := range boxes {
		if b.typ == typ {
			return b, true
		}
	}
	return box{}, false
}

// stsdVideoCodec extracts the first video sample entry format from a
// parsed moov. Returns "" when no video sample entry is found.
func stsdVideoCodec(boxes []box) string {
	moov, ok := findBox(boxes, "moov")
	if !ok {
		return ""
	}
	for _, trak := range moov.children {
		if trak.typ != "trak" {
			continue
		}
		mdia, ok := findBox(trak.children, "mdia")
		if !ok {
			continue
		}
		minf, ok := findBox(mdia.children, "minf")
		if !ok {
			continue
		}
		stbl, ok := findBox(minf.children, "stbl")
		if !ok {
			continue
		}
		stsd, ok := findBox(stbl.children, "stsd")
		if !ok || len(stsd.children) == 0 {
			continue
		}
		entry := stsd.children[0]
		if len(entry.typ) == 4 {
			return entry.typ
		}
	}
	return ""
}

// earliestSampleBoundary returns the smallest chunk offset + first sample
// size that must be within the prefix for decodable payload. Returns
// (offset, size, ok) from the first stco/co64 + stsz found.
func earliestSampleBoundary(boxes []box) (int64, int64, bool) {
	moov, ok := findBox(boxes, "moov")
	if !ok {
		return 0, 0, false
	}
	best := int64(-1)
	var bestSize int64
	for _, trak := range moov.children {
		if trak.typ != "trak" {
			continue
		}
		mdia, ok := findBox(trak.children, "mdia")
		if !ok {
			continue
		}
		minf, ok := findBox(mdia.children, "minf")
		if !ok {
			continue
		}
		stbl, ok := findBox(minf.children, "stbl")
		if !ok {
			continue
		}
		stco, ok1 := findBox(stbl.children, "stco")
		co64, ok2 := findBox(stbl.children, "co64")
		var offset int64
		if ok1 && len(stco.children) == 0 {
			// stco body: version(4) + entry_count(4) + uint32 offsets
			offset = readChunkOffset(stco, false)
		} else if ok2 && len(co64.children) == 0 {
			offset = readChunkOffset(co64, true)
		} else {
			continue
		}
		if offset < 0 {
			continue
		}
		if best < 0 || offset < best {
			best = offset
			bestSize = firstSampleSize(stbl)
		}
	}
	if best < 0 {
		return 0, 0, false
	}
	return best, bestSize, true
}

func readChunkOffset(b box, wide bool) int64 {
	data := b.payload
	if len(data) < 8 {
		return -1
	}
	count := int(binary.BigEndian.Uint32(data[4:8]))
	if count == 0 {
		return -1
	}
	if wide {
		if len(data) < 8+8 {
			return -1
		}
		return int64(binary.BigEndian.Uint64(data[8:16]))
	}
	if len(data) < 8+4 {
		return -1
	}
	return int64(binary.BigEndian.Uint32(data[8:12]))
}

func firstSampleSize(stbl box) int64 {
	stsz, ok := findBox(stbl.children, "stsz")
	if !ok {
		return 0
	}
	data := stsz.payload
	if len(data) < 12 {
		return 0
	}
	sampleSize := int64(binary.BigEndian.Uint32(data[4:8]))
	if sampleSize > 0 {
		return sampleSize
	}
	if len(data) < 16 {
		return 0
	}
	return int64(binary.BigEndian.Uint32(data[12:16]))
}

// structurallyPlayable implements the safe-early predicate over the
// verified prefix of the selected file. MP4/ISO-BMFF requires the complete
// ftyp+moov structure with a browser-decodeable video codec and a verified
// sample boundary. Matroska/MKV requires the EBML header + Segment with a
// complete Tracks element proving a browser-decodeable video TrackEntry
// (V_MPEG4/ISO/AVC, V_VP9, V_AV1; HEVC/unknown/audio-only rejected) and a
// complete first Cluster containing a video SimpleBlock/Block whose payload
// lies fully inside the verified prefix. Any partial/truncated required
// element keeps the job buffering honestly.
func structurallyPlayable(path string, avail int64) bool {
	if avail <= 0 {
		return false
	}
	limit := avail
	if limit > maxStructuralScan {
		limit = maxStructuralScan
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	data := make([]byte, limit)
	n, _ := f.Read(data)
	data = data[:n]
	if n < 16 {
		return false
	}
	// MP4: ftyp box at offset 0.
	if bytes.Equal(data[4:8], []byte("ftyp")) {
		return mp4StructurallyPlayable(data, avail)
	}
	// MKV: EBML magic.
	if bytes.Equal(data[:4], []byte{0x1A, 0x45, 0xDF, 0xA3}) {
		return mkvStructurallyPlayable(data, avail)
	}
	return false
}

func mp4StructurallyPlayable(data []byte, avail int64) bool {
	boxes := walkBoxesLenient(data)
	if len(boxes) == 0 {
		return false
	}
	moov, ok := findBox(boxes, "moov")
	if !ok {
		return false
	}
	// The moov must be fully within the verified prefix.
	if moov.end > avail {
		return false
	}
	codec := stsdVideoCodec(boxes)
	if codec == "" {
		return false
	}
	if undecodeableVideoCodecs[codec] {
		return false
	}
	if !decodeableVideoCodecs[codec] {
		return false
	}
	// A verified decodable sample boundary must exist within the prefix.
	off, size, ok := earliestSampleBoundary(boxes)
	if !ok {
		return false
	}
	return off+size <= avail
}

// ---------------------------------------------------------------------------
// Matroska (EBML) bounded parsing. All parsing operates only on the already
// verified prefix and is bounded by maxStructuralScan; VINT lengths are
// 1..8 bytes with overflow-safe math; unknown-size elements are handled
// explicitly; malformed input simply returns false (never panics).
// ---------------------------------------------------------------------------

// mkvElem is one EBML element within the verified prefix.
type mkvElem struct {
	id      uint64
	start   int64
	end     int64 // declared end (unknown-size: len(data))
	unknown bool
}

// readVINT parses an EBML variable-length integer with the marker bit
// included (element IDs). length is 1..8; returns ok=false on malformed
// input (leading zero byte, overflow, or out-of-bounds).
func readVINT(data []byte, off int) (val uint64, length int, ok bool) {
	if off >= len(data) {
		return 0, 0, false
	}
	first := data[off]
	var mask byte = 0x80
	length = 1
	for length <= 8 && first&mask == 0 {
		mask >>= 1
		length++
	}
	if length > 8 || length > len(data)-off {
		return 0, 0, false
	}
	// Marker included: the value keeps the marker bit.
	val = uint64(first)
	for i := 1; i < length; i++ {
		if val > (1<<56)-1 {
			return 0, 0, false
		}
		val = val<<8 | uint64(data[off+i])
	}
	return val, length, true
}

// readVINTSize parses an EBML size (marker bit excluded). An all-ones value
// means "unknown size".
func readVINTSize(data []byte, off int) (val uint64, length int, unknown bool, ok bool) {
	if off >= len(data) {
		return 0, 0, false, false
	}
	first := data[off]
	var mask byte = 0x80
	length = 1
	for length <= 8 && first&mask == 0 {
		mask >>= 1
		length++
	}
	if length > 8 || length > len(data)-off {
		return 0, 0, false, false
	}
	val = uint64(first & (mask - 1)) // marker excluded
	for i := 1; i < length; i++ {
		if val > (1<<56)-1 {
			return 0, 0, false, false
		}
		val = val<<8 | uint64(data[off+i])
	}
	// All size bits set = unknown size.
	if val == (1<<uint(7*length))-1 {
		return 0, length, true, true
	}
	return val, length, false, true
}

// readMKVElement parses one element at off. On malformed input ok=false.
func readMKVElement(data []byte, off int) (mkvElem, int, bool) {
	id, idLen, ok := readVINT(data, off)
	if !ok {
		return mkvElem{}, 0, false
	}
	size, sizeLen, unknown, ok2 := readVINTSize(data, off+idLen)
	if !ok2 {
		return mkvElem{}, 0, false
	}
	e := mkvElem{id: id, start: int64(off), unknown: unknown}
	if unknown {
		e.end = int64(len(data))
	} else {
		if size > uint64(len(data)) {
			return mkvElem{}, 0, false // cannot be fully within the prefix
		}
		e.end = int64(off) + int64(idLen) + int64(sizeLen) + int64(size)
		if e.end > int64(len(data)) {
			return mkvElem{}, 0, false
		}
	}
	return e, off + idLen + sizeLen, true
}

const (
	mkvEBML        = 0x1A45DFA3
	mkvSegment     = 0x18538067
	mkvDocType     = 0x4282
	mkvInfo        = 0x1549A966
	mkvTracks      = 0x1654AE6B
	mkvCluster     = 0x1F43B675
	mkvTrackEntry  = 0xAE
	mkvTrackType   = 0x83
	mkvCodecID     = 0x86
	mkvTrackNum    = 0xD7
	mkvSimpleBlock = 0xA3
	mkvBlockGroup  = 0xA0
	mkvBlock       = 0xA1
)

// mkvDecodeableCodecs are Matroska video codec IDs the browser can decode
// natively from an early verified prefix.
var mkvDecodeableCodecs = map[string]bool{
	"V_MPEG4/ISO/AVC": true, // H.264 (also covers /AVC/... profiles)
	"V_VP9":           true,
	"V_AV1":           true,
}

// mkvUndecodeableCodecs are known codec IDs requiring unavailable or
// nonstandard local decoders (rejected conservatively).
var mkvUndecodeableCodecs = map[string]bool{
	"V_MPEGH/ISO/HEVC": true, // HEVC/H.265
	"V_VP8":            true, // VP8 in Matroska
	"V_MPEG4/ISO/SP":   true,
	"V_MPEG4/ISO/ASP":  true,
}

// mkvVideoTrack describes a decodeable video track found in Tracks.
type mkvVideoTrack struct {
	num     uint64
	codecOK bool
}

// parseMKVTracks walks a complete Tracks element (fully inside the verified
// prefix) and returns the first video TrackEntry number when its codec is
// browser-decodeable. Audio-only, HEVC/unknown, or partial structures
// reject (codecOK=false).
func parseMKVTracks(data []byte, tr mkvElem) (mkvVideoTrack, bool) {
	var video mkvVideoTrack
	seenVideo := false
	off := int(tr.start) + elementHeaderLen(data, tr.start)
	end := int(tr.end)
	for off < end && off < len(data) {
		e, _, ok := readMKVElement(data, off)
		if !ok {
			break
		}
		if e.id == mkvTrackEntry {
			if e.end > tr.end || e.end > int64(len(data)) {
				return mkvVideoTrack{}, false // partial track entry
			}
			vt, ok := parseMKVTrackEntry(data, e)
			if !ok {
				return mkvVideoTrack{}, false
			}
			if vt.isVideo {
				seenVideo = true
				if vt.codecOK && video.num == 0 {
					video = mkvVideoTrack{num: vt.num, codecOK: true}
				} else if !vt.codecOK {
					// A video track with an undecodeable codec poisons the
					// whole file for early handoff.
					return mkvVideoTrack{}, false
				}
			}
		}
		off = int(e.end) // consume the element (its payload was parsed)
		if int64(off) > maxStructuralScan {
			break
		}
	}
	if !seenVideo || video.num == 0 {
		return mkvVideoTrack{}, false // no decodeable video track (audio-only or none)
	}
	return video, true
}

type mkvTrackInfo struct {
	num     uint64
	isVideo bool
	codecOK bool
}

func parseMKVTrackEntry(data []byte, e mkvElem) (mkvTrackInfo, bool) {
	var ti mkvTrackInfo
	off := int(e.start) + elementHeaderLen(data, e.start)
	end := int(e.end)
	for off < end && off < len(data) {
		child, next, ok := readMKVElement(data, off)
		if !ok {
			return mkvTrackInfo{}, false
		}
		payload := data[next:int(child.end)]
		switch child.id {
		case mkvTrackType:
			if len(payload) >= 1 {
				switch payload[0] {
				case 1:
					ti.isVideo = true
				case 2:
					// audio track: keep scanning for a video track later
				}
			}
		case mkvTrackNum:
			v, okv := readVINTValue(payload, 0)
			if okv {
				ti.num = v
			}
		case mkvCodecID:
			codec := string(payload)
			if mkvDecodeableCodecs[codec] || hasPrefix(codec, "V_MPEG4/ISO/AVC") {
				ti.codecOK = true
			} else if mkvUndecodeableCodecs[codec] {
				ti.codecOK = false
			} else {
				ti.codecOK = false
			}
		}
		off = int(child.end)
	}
	return ti, true
}

func hasPrefix(s, p string) bool {
	return len(s) >= len(p) && s[:len(p)] == p
}

// elementHeaderLen returns the byte length of an element's ID+size header.
func elementHeaderLen(data []byte, start int64) int {
	_, idLen, _ := readVINT(data, int(start))
	_, sizeLen, _, _ := readVINTSize(data, int(start)+idLen)
	return idLen + sizeLen
}

// clusterHasVideoBlock reports whether the first complete Cluster (fully
// inside the verified prefix) contains a SimpleBlock/BlockGroup+Block for
// the video track whose payload is fully inside the prefix (the cluster is
// fully verified, so any block inside it is verified too).
func clusterHasVideoBlock(data []byte, cl mkvElem, track uint64) bool {
	off := int(cl.start) + elementHeaderLen(data, cl.start)
	end := int(cl.end)
	for off < end && off < len(data) {
		e, next, ok := readMKVElement(data, off)
		if !ok {
			return false
		}
		if e.id == mkvSimpleBlock {
			if blockTrackNumber(data, next, int(e.end)) == track {
				return true
			}
		}
		if e.id == mkvBlockGroup {
			boff := int(e.start) + elementHeaderLen(data, e.start)
			for boff < int(e.end) && boff < len(data) {
				b, bnext, bok := readMKVElement(data, boff)
				if !bok {
					break
				}
				if b.id == mkvBlock && blockTrackNumber(data, bnext, int(b.end)) == track {
					return true
				}
				boff = bnext
			}
		}
		off = int(e.end) // consume the element
		if int64(off) > maxStructuralScan {
			break
		}
	}
	return false
}

// readVINTValue parses a VINT-encoded unsigned value with the marker bit
// excluded (track numbers, timestamps). Malformed input returns ok=false.
func readVINTValue(data []byte, off int) (uint64, bool) {
	first := byte(0)
	if off < len(data) {
		first = data[off]
	} else {
		return 0, false
	}
	var mask byte = 0x80
	length := 1
	for length <= 8 && first&mask == 0 {
		mask >>= 1
		length++
	}
	if length > 8 || length > len(data)-off {
		return 0, false
	}
	val := uint64(first & (mask - 1))
	for i := 1; i < length; i++ {
		if val > (1<<56)-1 {
			return 0, false
		}
		val = val<<8 | uint64(data[off+i])
	}
	return val, true
}

// blockTrackNumber parses the first VINT inside a SimpleBlock/Block payload
// (the track number). Malformed input returns 0.
func blockTrackNumber(data []byte, off, end int) uint64 {
	if off >= end || off >= len(data) {
		return 0
	}
	v, ok := readVINTValue(data[off:end], 0)
	if !ok {
		return 0
	}
	return v
}

// mkvStructurallyPlayable implements the strict Matroska early-handoff
// predicate over the verified prefix.
func mkvStructurallyPlayable(data []byte, avail int64) bool {
	if len(data) < 8 {
		return false
	}
	// EBML header: ID + size + DocType "matroska".
	hdrSize, _, unknown, ok := readVINTSize(data, 4)
	if !ok || unknown || hdrSize < 4 {
		return false
	}
	docOff := 4 + sizeHeaderLen(data, 4)
	if docOff+int(hdrSize) > len(data) {
		return false
	}
	if !docTypeMatroska(data, docOff, int(hdrSize)) {
		return false
	}
	// Segment.
	seg, segBody, ok := readMKVElement(data, docOff+int(hdrSize))
	if !ok || seg.id != mkvSegment {
		return false
	}
	end := int64(len(data))
	if !seg.unknown {
		end = seg.end
	}
	// Walk the top-level Segment elements: Tracks must prove a decodeable
	// video track; the FIRST complete Cluster must carry a verified video
	// block. Elements after the first cluster are irrelevant.
	off := segBody
	var videoTrack mkvVideoTrack
	tracksOK := false
	for off < int(end) && off < len(data) {
		if int64(off) > maxStructuralScan {
			return false
		}
		e, _, ok := readMKVElement(data, off)
		if !ok {
			return false
		}
		if e.end > avail {
			return false // a required element extends beyond the verified prefix
		}
		switch e.id {
		case mkvTracks:
			vt, ok := parseMKVTracks(data, e)
			if !ok {
				return false
			}
			videoTrack = vt
			tracksOK = true
		case mkvCluster:
			if !tracksOK {
				return false // no verified tracks before the first cluster
			}
			return clusterHasVideoBlock(data, e, videoTrack.num)
		}
		off = int(e.end) // consume the element (its payload was parsed or skipped)
	}
	return false
}

func sizeHeaderLen(data []byte, off int) int {
	_, l, _, _ := readVINTSize(data, off)
	return l
}

// docTypeMatroska checks the EBML DocType string within the header payload.
func docTypeMatroska(data []byte, off, hdrSize int) bool {
	pos := off
	end := off + hdrSize
	for pos < end-1 {
		e, next, ok := readMKVElement(data, pos)
		if !ok {
			return false
		}
		if e.id == mkvDocType {
			payload := data[next:int(e.end)]
			return len(payload) == 8 && string(payload) == "matroska"
		}
		pos = next
	}
	return false
}
