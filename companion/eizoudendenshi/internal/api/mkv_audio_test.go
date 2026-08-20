package api

import (
	"bytes"
	"context"
	"io"
	"testing"
)

// ---------------------------------------------------------------------------
// MKV binary builder helpers (minimal valid EBML)
// ---------------------------------------------------------------------------

// mkvElemID builds an EBML element ID as bytes.
// EBML element IDs use a different encoding from VINT sizes:
// - 1-byte IDs: 0x01..0x7F (high bit clear)
// - 2-byte IDs: 0x4000..0x7FFF (top 2 bits: 01)
// - 3-byte IDs: 0x200000..0x3FFFFF (top 3 bits: 001)
// - 4-byte IDs: 0x10000000..0x1FFFFFFF (top 4 bits: 0001)
func mkvElemID(id uint64) []byte {
	switch {
	case id <= 0xFF:
		return []byte{byte(id)}
	case id <= 0x7FFF:
		return []byte{byte(0x40 | (id >> 8)), byte(id & 0xFF)}
	case id <= 0x3FFFFF:
		return []byte{byte(0x20 | (id >> 16)), byte((id >> 8) & 0xFF), byte(id & 0xFF)}
	default:
		return []byte{byte(0x10 | (id >> 24)), byte((id >> 16) & 0xFF), byte((id >> 8) & 0xFF), byte(id & 0xFF)}
	}
}

// mkvSize builds an EBML size field (VINT with marker bit excluded).
func mkvSize(size int) []byte {
	if size <= 0x7F {
		return []byte{byte(0x80 | size)}
	}
	if size <= 0x3FFF {
		return []byte{byte(0x40 | (size >> 8)), byte(size & 0xFF)}
	}
	if size <= 0x1FFFFF {
		return []byte{byte(0x20 | (size >> 16)), byte((size >> 8) & 0xFF), byte(size & 0xFF)}
	}
	// 4-byte size (uncommon for our test sizes, but correct)
	return []byte{byte(0x10 | (size >> 24)), byte((size >> 16) & 0xFF), byte((size >> 8) & 0xFF), byte(size & 0xFF)}
}

// mkvElem builds a complete EBML element: ID + size + payload.
func mkvElem(id uint64, payload []byte) []byte {
	var buf []byte
	buf = append(buf, mkvElemID(id)...)
	buf = append(buf, mkvSize(len(payload))...)
	buf = append(buf, payload...)
	return buf
}

// mkvUint8 builds a 1-byte unsigned integer payload.
func mkvUint8(val uint8) []byte { return []byte{val} }

// mkvString builds a UTF-8 string payload.
func mkvString(s string) []byte { return []byte(s) }

// buildMKVHeader builds a minimal valid MKV header with the given track
// entries inside the Tracks element. Returns the complete header bytes.
func buildMKVHeader(trackEntries ...[]byte) []byte {
	// EBML Header (DocType = "matroska").
	docType := mkvElem(mkvDocType, mkvString("matroska"))
	ebmlHeader := mkvElem(mkvEBML, docType)

	// Tracks element containing the provided track entries.
	var tracksPayload []byte
	for _, te := range trackEntries {
		tracksPayload = append(tracksPayload, te...)
	}
	tracksElem := mkvElem(mkvTracks, tracksPayload)

	// Segment containing Tracks. Unknown size is fine for header rewriting.
	segment := mkvElem(mkvSegment, tracksElem)

	return append(ebmlHeader, segment...)
}

// mkvDocType constant used in buildMKVHeader.
const mkvDocType = 0x4282

// buildTrackEntry builds a complete TrackEntry element from the given
// child elements.
func buildTrackEntry(children ...[]byte) []byte {
	var payload []byte
	for _, child := range children {
		payload = append(payload, child...)
	}
	return mkvElem(mkvTrackEntry, payload)
}

// ---------------------------------------------------------------------------
// Test helpers: minimal seekable reader for testing
// ---------------------------------------------------------------------------

type nopCloserReadSeeker struct {
	io.ReadSeeker
}

func newTestReader(data []byte) *nopCloserReadSeeker {
	return &nopCloserReadSeeker{ReadSeeker: bytes.NewReader(data)}
}

// ---------------------------------------------------------------------------
// Tests for rewriteMKVDefaultAudio
// ---------------------------------------------------------------------------

func TestRewriteMKVDefaultAudio_2Tracks_JapaneseAndEnglish(t *testing.T) {
	jaTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)), // audio
		mkvElem(mkvLanguage, mkvString("jpn")),
		mkvElem(mkvDefault, mkvUint8(0x00)),
	)
	enTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)), // audio
		mkvElem(mkvLanguage, mkvString("eng")),
		mkvElem(mkvDefault, mkvUint8(0x01)),
	)
	header := buildMKVHeader(jaTrack, enTrack)
	reader := newTestReader(header)

	modified, ok, err := rewriteMKVDefaultAudio(context.Background(), reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected rewrite to succeed, got ok=false")
	}
	if len(modified) != len(header) {
		t.Fatalf("modified header length %d != original %d", len(modified), len(header))
	}

	// Verify the Default flags were swapped: Japanese=1, English=0.
	// We need to find the Default element offsets in both tracks.
	// The Japanese track's Default should be 1 and English track's Default should be 0.
	// Parse the modified header to verify.
	jaDefault, enDefault := findDefaultFlags(t, modified, mkvTrackEntry)
	if jaDefault != 1 {
		t.Errorf("Japanese track Default: got %d, want 1", jaDefault)
	}
	if enDefault != 0 {
		t.Errorf("English track Default: got %d, want 0", enDefault)
	}
}

func TestRewriteMKVDefaultAudio_1Track(t *testing.T) {
	track := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)), // audio
		mkvElem(mkvLanguage, mkvString("jpn")),
		mkvElem(mkvDefault, mkvUint8(0x01)),
	)
	header := buildMKVHeader(track)
	reader := newTestReader(header)

	modified, ok, err := rewriteMKVDefaultAudio(context.Background(), reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Error("expected no rewrite for 1 audio track, got ok=true")
	}
	if modified != nil {
		t.Error("expected nil modified bytes for no-rewrite case")
	}
}

func TestRewriteMKVDefaultAudio_3Tracks(t *testing.T) {
	track1 := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("jpn")),
		mkvElem(mkvDefault, mkvUint8(0x00)),
	)
	track2 := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("eng")),
		mkvElem(mkvDefault, mkvUint8(0x01)),
	)
	track3 := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("ger")),
		mkvElem(mkvDefault, mkvUint8(0x00)),
	)
	header := buildMKVHeader(track1, track2, track3)
	reader := newTestReader(header)

	modified, ok, err := rewriteMKVDefaultAudio(context.Background(), reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Error("expected no rewrite for 3 audio tracks, got ok=true")
	}
	if modified != nil {
		t.Error("expected nil modified bytes for no-rewrite case")
	}
}

func TestRewriteMKVDefaultAudio_2Tracks_NoJapanese(t *testing.T) {
	enTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("eng")),
		mkvElem(mkvDefault, mkvUint8(0x01)),
	)
	geTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("ger")),
		mkvElem(mkvDefault, mkvUint8(0x00)),
	)
	header := buildMKVHeader(enTrack, geTrack)
	reader := newTestReader(header)

	modified, ok, err := rewriteMKVDefaultAudio(context.Background(), reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Error("expected no rewrite when no Japanese track, got ok=true")
	}
	if modified != nil {
		t.Error("expected nil modified bytes for no-rewrite case")
	}
}

func TestRewriteMKVDefaultAudio_Idempotent(t *testing.T) {
	// Japanese track already has Default=1, English has Default=0.
	// Function should detect this and still succeed (idempotent).
	jaTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("jpn")),
		mkvElem(mkvDefault, mkvUint8(0x01)),
	)
	enTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("eng")),
		mkvElem(mkvDefault, mkvUint8(0x00)),
	)
	header := buildMKVHeader(jaTrack, enTrack)
	reader := newTestReader(header)

	modified, ok, err := rewriteMKVDefaultAudio(context.Background(), reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected rewrite to succeed (idempotent), got ok=false")
	}
	if !bytes.Equal(modified, header) {
		t.Error("idempotent case: modified header should be identical to original")
	}
}

func TestRewriteMKVDefaultAudio_ShortJaLang(t *testing.T) {
	// Language "ja" (2 bytes) should also be recognized as Japanese.
	jaTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("ja")),
		mkvElem(mkvDefault, mkvUint8(0x00)),
	)
	enTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("eng")),
		mkvElem(mkvDefault, mkvUint8(0x01)),
	)
	header := buildMKVHeader(jaTrack, enTrack)
	reader := newTestReader(header)

	modified, ok, err := rewriteMKVDefaultAudio(context.Background(), reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected rewrite to succeed for 'ja' language, got ok=false")
	}
	if len(modified) != len(header) {
		t.Fatalf("modified header length %d != original %d", len(modified), len(header))
	}
	jaDefault, enDefault := findDefaultFlags(t, modified, mkvTrackEntry)
	if jaDefault != 1 {
		t.Errorf("Japanese track Default: got %d, want 1", jaDefault)
	}
	if enDefault != 0 {
		t.Errorf("English track Default: got %d, want 0", enDefault)
	}
}

func TestRewriteMKVDefaultAudio_NoDefaultElement(t *testing.T) {
	// TrackEntry without a Default element — should skip gracefully.
	jaTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("jpn")),
		// No Default element.
	)
	enTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("eng")),
		mkvElem(mkvDefault, mkvUint8(0x01)),
	)
	header := buildMKVHeader(jaTrack, enTrack)
	reader := newTestReader(header)

	modified, ok, err := rewriteMKVDefaultAudio(context.Background(), reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Error("expected no rewrite when Default element is missing from one track, got ok=true")
	}
	if modified != nil {
		t.Error("expected nil modified bytes for no-rewrite case")
	}
}

func TestRewriteMKVDefaultAudio_MalformedHeader(t *testing.T) {
	// Not a valid MKV — no EBML magic.
	data := []byte{0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	reader := newTestReader(data)

	modified, ok, err := rewriteMKVDefaultAudio(context.Background(), reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Error("expected no rewrite for malformed header, got ok=true")
	}
	if modified != nil {
		t.Error("expected nil modified bytes for malformed header")
	}
}

func TestRewriteMKVDefaultAudio_TruncatedHeader(t *testing.T) {
	// Valid EBML magic but truncated — should fail gracefully.
	jaTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)),
		mkvElem(mkvLanguage, mkvString("jpn")),
		mkvElem(mkvDefault, mkvUint8(0x00)),
	)
	header := buildMKVHeader(jaTrack)
	// Truncate to half.
	truncated := header[:len(header)/2]
	reader := newTestReader(truncated)

	modified, ok, err := rewriteMKVDefaultAudio(context.Background(), reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Error("expected no rewrite for truncated header, got ok=true")
	}
	if modified != nil {
		t.Error("expected nil modified bytes for truncated header")
	}
}

func TestRewriteMKVDefaultAudio_VideoAndAudioTracks(t *testing.T) {
	// MKV with 1 video + 2 audio tracks. Only audio tracks are counted.
	videoTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x01)), // video
		mkvElem(mkvLanguage, mkvString("und")),
	)
	jaTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)), // audio
		mkvElem(mkvLanguage, mkvString("jpn")),
		mkvElem(mkvDefault, mkvUint8(0x00)),
	)
	enTrack := buildTrackEntry(
		mkvElem(mkvTrackType, mkvUint8(0x02)), // audio
		mkvElem(mkvLanguage, mkvString("eng")),
		mkvElem(mkvDefault, mkvUint8(0x01)),
	)
	header := buildMKVHeader(videoTrack, jaTrack, enTrack)
	reader := newTestReader(header)

	modified, ok, err := rewriteMKVDefaultAudio(context.Background(), reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected rewrite to succeed (1 video + 2 audio = 2 audio tracks), got ok=false")
	}
	jaDefault, enDefault := findDefaultFlags(t, modified, mkvTrackEntry)
	if jaDefault != 1 {
		t.Errorf("Japanese track Default: got %d, want 1", jaDefault)
	}
	if enDefault != 0 {
		t.Errorf("English track Default: got %d, want 0", enDefault)
	}
}

// ---------------------------------------------------------------------------

    // ---------------------------------------------------------------------------
    // Tests for combinedReader
    // ---------------------------------------------------------------------------

    func TestCombinedReader_Read(t *testing.T) {
        // Stream represents the FULL original file (header + payload).
        // combinedReader replaces bytes [0, headerLen) in-memory.
        fullFile := []byte("ORIGINALHDRPAYLOAD") // 18 bytes
        payloadPart := fullFile[10:] // "PAYLOAD" (8 bytes)
        sr := newTestReader(fullFile)

        cr := &combinedReader{
            header:    bytes.NewReader([]byte("MOD_HEADER")),
            headerLen: 10,
            stream:    sr,
        }

        // Read all 10 header bytes (from modified header, not stream).
        buf := make([]byte, 10)
        n, err := cr.Read(buf)
        if err != nil {
            t.Fatalf("read header: %v", err)
        }
        if n != 10 || string(buf) != "MOD_HEADER" {
            t.Fatalf("header: got %q, want MOD_HEADER", buf[:n])
        }

        // Read payload — should be original bytes 10..end ("PAYLOAD").
        buf2 := make([]byte, len(payloadPart))
        n2, err2 := cr.Read(buf2)
        if err2 != nil {
            t.Fatalf("read payload: %v", err2)
        }
        if n2 != len(payloadPart) || !bytes.Equal(buf2[:n2], payloadPart) {
            t.Errorf("payload: got %q, want %q", buf2[:n2], payloadPart)
        }

        // Read past end — should get EOF.
        buf3 := make([]byte, 1)
        _, err3 := cr.Read(buf3)
        if err3 != io.EOF {
            t.Errorf("read past end: got err=%v, want io.EOF", err3)
        }
    }

    func TestCombinedReader_Seek(t *testing.T) {
        fullFile := []byte("ORIGHEADERSTREAM") // 16 bytes
        sr := newTestReader(fullFile)

        cr := &combinedReader{
            header:    bytes.NewReader([]byte("MOD_HEADER")),
            headerLen: 10,
            stream:    sr,
        }

        pos, err := cr.Seek(0, io.SeekStart)
        if err != nil {
            t.Fatalf("seek start: %v", err)
        }
        if pos != 0 {
            t.Errorf("seek start: got pos %d, want 0", pos)
        }

        pos, err = cr.Seek(3, io.SeekStart)
        if err != nil {
            t.Fatalf("seek within header: %v", err)
        }
        if pos != 3 {
            t.Errorf("seek within header: got pos %d, want 3", pos)
        }

        buf := make([]byte, 2)
        n, err := cr.Read(buf)
        if err != nil {
            t.Fatalf("read after seek: %v", err)
        }
        if n != 2 || string(buf) != "_H" {
            t.Errorf("read after seek: got %q, want _H", buf)
        }

        pos, err = cr.Seek(10, io.SeekStart)
        if err != nil {
            t.Fatalf("seek to stream: %v", err)
        }
        if pos != 10 {
            t.Errorf("seek to stream: got pos %d, want 10", pos)
        }

        buf2 := make([]byte, 6)
        n2, err2 := cr.Read(buf2)
        if err2 != nil {
            t.Fatalf("read from stream: %v", err2)
        }
        if n2 != 6 || string(buf2) != "STREAM" {
            t.Errorf("read from stream: got %q, want STREAM", buf2)
        }

        pos, err = cr.Seek(0, io.SeekEnd)
        if err != nil {
            t.Fatalf("seek end: %v", err)
        }
        if pos != 16 {
            t.Errorf("seek end: got %d, want 16", pos)
        }
    }

    func TestCombinedReader_SeekCurrent(t *testing.T) {
        header := []byte("HEADER")
        stream := []byte("STREAM")
        sr := newTestReader(stream)

        cr := &combinedReader{
            header:    bytes.NewReader(header),
            headerLen: int64(len(header)),
            stream: sr,
        }

        pos, err := cr.Seek(3, io.SeekCurrent)
        if err != nil {
            t.Fatalf("seek current: %v", err)
        }
        if pos != 3 {
            t.Errorf("seek current: got pos %d, want 3", pos)
        }

        buf := make([]byte, 1)
        cr.Read(buf)

        pos, err = cr.Seek(2, io.SeekCurrent)
        if err != nil {
            t.Fatalf("seek current after read: %v", err)
        }
        if pos != 6 {
            t.Errorf("seek current after read: got pos %d, want 6", pos)
        }
    }

    func TestCombinedReader_ReadSmallChunks(t *testing.T) {
        fullFile := []byte("ABCDEFGHIJ0123456789") // 20 bytes
        sr := newTestReader(fullFile)

        cr := &combinedReader{
            header:    bytes.NewReader([]byte("ABCDEFGHIJ")),
            headerLen: 10,
            stream:    sr,
        }

        tests := []struct {
            want string
        }{
            {"ABC"}, // bytes 0-2 from header
            {"DEF"}, // bytes 3-5 from header
            {"GHI"}, // bytes 6-8 from header
            {"J01"}, // byte 9 from header + bytes 10-11 from stream
            {"234"}, // bytes 12-14 from stream
        }

        buf := make([]byte, 3)
        for i, tt := range tests {
            n, _ := cr.Read(buf)
            if n != 3 || string(buf[:n]) != tt.want {
                t.Errorf("chunk %d: got %q, want %q", i+1, buf[:n], tt.want)
            }
        }
}

// findDefaultFlags parses a modified MKV header and returns
// the Default values of the first two audio TrackEntry elements found.
func findDefaultFlags(t *testing.T, data []byte, trackEntryID uint64) (default1, default2 uint8) {
	t.Helper()

	// Skip EBML header.
	if len(data) < 12 || data[0] != 0x1A || data[1] != 0x45 || data[2] != 0xDF || data[3] != 0xA3 {
		t.Fatal("not an MKV file")
	}
	ebmlBody, ebmlBodyLen := skipEBMLHeader(data)
	if ebmlBody < 0 {
		t.Fatal("cannot parse EBML header")
	}

	segStart := ebmlBody + ebmlBodyLen

	// Find Segment.
	seg, segBody, segOK := parseEBMLElement(data, segStart)
	if !segOK || seg.ID != mkvSegment {
		t.Fatal("segment not found")
	}
	segEnd := seg.BodyEnd

	// Find Tracks.
	off := segBody
	for off < segEnd && off <= len(data)-8 {
		e, body, eOK := parseEBMLElement(data, off)
		if !eOK {
			t.Fatalf("parseEBMLElement failed at offset %d", off)
		}
		if e.ID == mkvTracks {
			// Walk TrackEntry children.
			audioCount := 0
			teOff := body
			for teOff < e.BodyEnd && teOff <= len(data)-8 {
				te, teBody, teOK := parseEBMLElement(data, teOff)
				if !teOK {
					break
				}
				if te.ID == mkvTrackEntry {
					// Walk TrackEntry children looking for TrackType and Default.
					ttOff := teBody
					var trackType uint8
					var defaultVal uint8
					var hasDefault bool
					for ttOff < te.BodyEnd && ttOff <= len(data)-8 {
						child, _, childOK := parseEBMLElement(data, ttOff)
						if !childOK {
							break
						}
						if child.ID == mkvTrackType && child.BodyEnd <= len(data) {
							trackType = data[child.BodyOff]
						}
						if child.ID == mkvDefault && child.BodyEnd <= len(data) {
							defaultVal = data[child.BodyOff]
							hasDefault = true
						}
						ttOff = child.BodyEnd
					}
					if trackType == 0x02 && hasDefault {
						audioCount++
						if audioCount == 1 {
							default1 = defaultVal
						} else if audioCount == 2 {
							default2 = defaultVal
						}
					}
				}
				teOff = te.BodyEnd
			}
			break
		}
		off = e.BodyEnd
	}
	return
}
