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
	return []byte{byte(0x10 | (size >> 24)), byte((size >> 16) & 0xFF), byte((size >> 8) & 0xFF), byte(size & 0xFF)}
}

func mkvElem(id uint64, payload []byte) []byte {
	var buf []byte
	buf = append(buf, mkvElemID(id)...)
	buf = append(buf, mkvSize(len(payload))...)
	buf = append(buf, payload...)
	return buf
}

func mkvUint8(val uint8) []byte { return []byte{val} }

func mkvString(s string) []byte { return []byte(s) }

const mkvDocType = 0x4282

func buildMKVHeader(trackEntries ...[]byte) []byte {
	docType := mkvElem(mkvDocType, mkvString("matroska"))
	ebmlHeader := mkvElem(mkvEBML, docType)
	var tracksPayload []byte
	for _, te := range trackEntries {
		tracksPayload = append(tracksPayload, te...)
	}
	tracksElem := mkvElem(mkvTracks, tracksPayload)
	segment := mkvElem(mkvSegment, tracksElem)
	return append(ebmlHeader, segment...)
}

func buildTrackEntry(children ...[]byte) []byte {
	var payload []byte
	for _, child := range children {
		payload = append(payload, child...)
	}
	return mkvElem(mkvTrackEntry, payload)
}

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
	jaTrack := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("jpn")), mkvElem(mkvDefault, mkvUint8(0x00)))
	enTrack := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("eng")), mkvElem(mkvDefault, mkvUint8(0x01)))
	header := buildMKVHeader(jaTrack, enTrack)
	reader := newTestReader(header)
	modified, ok, reason := rewriteMKVDefaultAudio(context.Background(), reader)
	if !ok {
		t.Fatalf("expected rewrite to succeed, got ok=false reason=%s", reason)
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

func TestRewriteMKVDefaultAudio_1Track(t *testing.T) {
	track := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("jpn")), mkvElem(mkvDefault, mkvUint8(0x01)))
	header := buildMKVHeader(track)
	reader := newTestReader(header)
	_, ok, _ := rewriteMKVDefaultAudio(context.Background(), reader)
	if ok {
		t.Fatal("expected ok=false for 1 audio track")
	}
}

func TestRewriteMKVDefaultAudio_3Tracks(t *testing.T) {
	t1 := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("jpn")), mkvElem(mkvDefault, mkvUint8(0x00)))
	t2 := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("eng")), mkvElem(mkvDefault, mkvUint8(0x01)))
	t3 := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("fre")), mkvElem(mkvDefault, mkvUint8(0x00)))
	header := buildMKVHeader(t1, t2, t3)
	reader := newTestReader(header)
	_, ok, _ := rewriteMKVDefaultAudio(context.Background(), reader)
	if ok {
		t.Fatal("expected ok=false for 3 audio tracks")
	}
}

func TestRewriteMKVDefaultAudio_2Tracks_NoJapanese(t *testing.T) {
	t1 := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("eng")), mkvElem(mkvDefault, mkvUint8(0x01)))
	t2 := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("fre")), mkvElem(mkvDefault, mkvUint8(0x00)))
	header := buildMKVHeader(t1, t2)
	reader := newTestReader(header)
	_, ok, _ := rewriteMKVDefaultAudio(context.Background(), reader)
	if ok {
		t.Fatal("expected ok=false when no Japanese track")
	}
}

func TestRewriteMKVDefaultAudio_Idempotent(t *testing.T) {
	jaTrack := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("jpn")), mkvElem(mkvDefault, mkvUint8(0x01)))
	enTrack := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("eng")), mkvElem(mkvDefault, mkvUint8(0x00)))
	header := buildMKVHeader(jaTrack, enTrack)
	reader := newTestReader(header)
	modified, ok, reason := rewriteMKVDefaultAudio(context.Background(), reader)
	if !ok {
		t.Fatalf("expected rewrite to succeed (idempotent), got ok=false reason=%s", reason)
	}
	if !bytes.Equal(modified, header) {
		t.Error("idempotent: modified should equal original")
	}
}

func TestRewriteMKVDefaultAudio_ShortJaLang(t *testing.T) {
	jaTrack := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("ja")), mkvElem(mkvDefault, mkvUint8(0x00)))
	enTrack := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("eng")), mkvElem(mkvDefault, mkvUint8(0x01)))
	header := buildMKVHeader(jaTrack, enTrack)
	reader := newTestReader(header)
	modified, ok, reason := rewriteMKVDefaultAudio(context.Background(), reader)
	if !ok {
		t.Fatalf("expected rewrite for ja lang, got ok=false reason=%s", reason)
	}
	jaDefault, _ := findDefaultFlags(t, modified, mkvTrackEntry)
	if jaDefault != 1 {
		t.Errorf("Japanese Default: got %d, want 1", jaDefault)
	}
}

func TestRewriteMKVDefaultAudio_NoDefaultElement(t *testing.T) {
	t1 := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("jpn")))
	t2 := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("eng")))
	header := buildMKVHeader(t1, t2)
	reader := newTestReader(header)
	_, ok, _ := rewriteMKVDefaultAudio(context.Background(), reader)
	if ok {
		t.Fatal("expected ok=false when Default element missing")
	}
}

func TestRewriteMKVDefaultAudio_MalformedHeader(t *testing.T) {
	reader := newTestReader([]byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05})
	_, ok, _ := rewriteMKVDefaultAudio(context.Background(), reader)
	if ok {
		t.Fatal("expected ok=false for malformed header")
	}
}

func TestRewriteMKVDefaultAudio_TruncatedHeader(t *testing.T) {
	reader := newTestReader([]byte{0x1A, 0x45, 0xDF, 0xA3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00})
	_, ok, _ := rewriteMKVDefaultAudio(context.Background(), reader)
	if ok {
		t.Fatal("expected ok=false for truncated header")
	}
}

func TestRewriteMKVDefaultAudio_VideoAndAudioTracks(t *testing.T) {
	vTrack := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x01)), mkvElem(mkvCodecID, mkvString("V_MPEG4/ISO/AVC")))
	jaTrack := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("jpn")), mkvElem(mkvDefault, mkvUint8(0x00)))
	enTrack := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("eng")), mkvElem(mkvDefault, mkvUint8(0x01)))
	header := buildMKVHeader(vTrack, jaTrack, enTrack)
	reader := newTestReader(header)
	modified, ok, reason := rewriteMKVDefaultAudio(context.Background(), reader)
	if !ok {
		t.Fatalf("expected rewrite (1v+2a), got ok=false reason=%s", reason)
	}
	jaDefault, enDefault := findDefaultFlags(t, modified, mkvTrackEntry)
	if jaDefault != 1 {
		t.Errorf("Japanese Default: got %d, want 1", jaDefault)
	}
	if enDefault != 0 {
		t.Errorf("English Default: got %d, want 0", enDefault)
	}
}

func TestRewriteMKVDefaultAudio_SegmentUnknownSize(t *testing.T) {
	// Build an MKV header where the Segment element has VINT size = 0xFF
	// (unknown size / all value bits set). This is common in real MKV files.
	jaTrack := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("jpn")), mkvElem(mkvDefault, mkvUint8(0x00)))
	enTrack := buildTrackEntry(mkvElem(mkvTrackType, mkvUint8(0x02)), mkvElem(mkvLanguage, mkvString("eng")), mkvElem(mkvDefault, mkvUint8(0x01)))
	tracksPayload := append(mkvElem(mkvTracks, nil), jaTrack...)
	tracksPayload = append(tracksPayload, enTrack...)

	// Build the tracks element properly first to get correct size
	tracksElem := mkvElem(mkvTracks, append(jaTrack, enTrack...))

	// Manually construct Segment: ID (4 bytes) + size byte 0xFF (unknown) + tracks payload
	segID := mkvElemID(mkvSegment)
	segHeader := append(segID, 0xFF) // 0xFF = unknown size
	header := append(buildEBMLHeaderForTest(), segHeader...)
	header = append(header, tracksElem...)

	reader := newTestReader(header)
	modified, ok, reason := rewriteMKVDefaultAudio(context.Background(), reader)
	if !ok {
		t.Fatalf("expected rewrite to succeed with unknown-size Segment, got ok=false reason=%s", reason)
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

func buildEBMLHeaderForTest() []byte {
	docType := mkvElem(mkvDocType, mkvString("matroska"))
	return mkvElem(mkvEBML, docType)
}

// ---------------------------------------------------------------------------
// Tests for combinedReader
// ---------------------------------------------------------------------------

func TestCombinedReader_Read(t *testing.T) {
	fullFile := []byte("ORIGINALHDRPAYLOAD")
	payloadPart := fullFile[10:]
	sr := newTestReader(fullFile)
	cr := &combinedReader{header: bytes.NewReader([]byte("MOD_HEADER")), headerLen: 10, stream: sr}

	buf := make([]byte, 10)
	n, err := cr.Read(buf)
	if err != nil {
		t.Fatalf("read header: %v", err)
	}
	if n != 10 || string(buf) != "MOD_HEADER" {
		t.Fatalf("header: got %q, want MOD_HEADER", buf[:n])
	}

	buf2 := make([]byte, len(payloadPart))
	n2, err2 := cr.Read(buf2)
	if err2 != nil {
		t.Fatalf("read payload: %v", err2)
	}
	if n2 != len(payloadPart) || !bytes.Equal(buf2[:n2], payloadPart) {
		t.Errorf("payload: got %q, want %q", buf2[:n2], payloadPart)
	}

	buf3 := make([]byte, 1)
	_, err3 := cr.Read(buf3)
	if err3 != io.EOF {
		t.Errorf("read past end: got err=%v, want io.EOF", err3)
	}
}

func TestCombinedReader_Seek(t *testing.T) {
	fullFile := []byte("ORIGHEADERSTREAM")
	sr := newTestReader(fullFile)
	cr := &combinedReader{header: bytes.NewReader([]byte("MOD_HEADER")), headerLen: 10, stream: sr}

	pos, err := cr.Seek(0, io.SeekStart)
	if err != nil {
		t.Fatal(err)
	}
	if pos != 0 {
		t.Errorf("seek start: got %d, want 0", pos)
	}

	pos, err = cr.Seek(3, io.SeekStart)
	if err != nil {
		t.Fatal(err)
	}
	if pos != 3 {
		t.Errorf("seek header: got %d, want 3", pos)
	}

	buf := make([]byte, 2)
	n, _ := cr.Read(buf)
	if n != 2 || string(buf) != "_H" {
		t.Errorf("read after seek: got %q, want _H", buf)
	}

	pos, err = cr.Seek(10, io.SeekStart)
	if err != nil {
		t.Fatal(err)
	}
	if pos != 10 {
		t.Errorf("seek stream: got %d, want 10", pos)
	}

	buf2 := make([]byte, 6)
	n2, _ := cr.Read(buf2)
	if n2 != 6 || string(buf2) != "STREAM" {
		t.Errorf("read stream: got %q, want STREAM", buf2)
	}

	pos, err = cr.Seek(0, io.SeekEnd)
	if err != nil {
		t.Fatal(err)
	}
	if pos != 16 {
		t.Errorf("seek end: got %d, want 16", pos)
	}
}

func TestCombinedReader_SeekCurrent(t *testing.T) {
	header := []byte("HEADER")
	stream := []byte("STREAM")
	sr := newTestReader(stream)
	cr := &combinedReader{header: bytes.NewReader(header), headerLen: int64(len(header)), stream: sr}

	pos, err := cr.Seek(3, io.SeekCurrent)
	if err != nil {
		t.Fatal(err)
	}
	if pos != 3 {
		t.Errorf("seek current: got %d, want 3", pos)
	}

	buf := make([]byte, 1)
	cr.Read(buf)

	pos, err = cr.Seek(2, io.SeekCurrent)
	if err != nil {
		t.Fatal(err)
	}
	if pos != 6 {
		t.Errorf("seek current after read: got %d, want 6", pos)
	}
}

func TestCombinedReader_ReadSmallChunks(t *testing.T) {
	fullFile := []byte("ABCDEFGHIJ0123456789")
	sr := newTestReader(fullFile)
	cr := &combinedReader{header: bytes.NewReader([]byte("ABCDEFGHIJ")), headerLen: 10, stream: sr}

	tests := []struct {
		want string
	}{
		{"ABC"}, {"DEF"}, {"GHI"}, {"J01"}, {"234"},
	}
	buf := make([]byte, 3)
	for i, tt := range tests {
		n, _ := cr.Read(buf)
		if n != 3 || string(buf[:n]) != tt.want {
			t.Errorf("chunk %d: got %q, want %q", i+1, buf[:n], tt.want)
		}
	}
}

// ---------------------------------------------------------------------------
// Test helper: findDefaultFlags
// ---------------------------------------------------------------------------

func findDefaultFlags(t *testing.T, data []byte, trackEntryID uint64) (default1, default2 uint8) {
	t.Helper()
	if len(data) < 12 || data[0] != 0x1A || data[1] != 0x45 || data[2] != 0xDF || data[3] != 0xA3 {
		t.Fatal("not MKV")
	}
	ebmlBody, ebmlBodyLen := skipEBMLHeader(data)
	if ebmlBody < 0 {
		t.Fatal("bad EBML header")
	}
	segStart := ebmlBody + ebmlBodyLen
	seg, segBody, segOK := parseEBMLElement(data, segStart)
	if !segOK || seg.ID != mkvSegment {
		t.Fatal("no segment")
	}
	segEnd := seg.BodyEnd
	off := segBody
	for off < segEnd && off <= len(data)-8 {
		e, body, eOK := parseEBMLElement(data, off)
		if !eOK {
			t.Fatalf("parseEBML at %d", off)
		}
		if e.ID == mkvTracks {
			audioCount := 0
			teOff := body
			for teOff < e.BodyEnd && teOff <= len(data)-8 {
				te, teBody, teOK := parseEBMLElement(data, teOff)
				if !teOK {
					break
				}
				if te.ID == mkvTrackEntry {
					ttOff := teBody
					var tt uint8
					var dv uint8
					var hd bool
					for ttOff < te.BodyEnd && ttOff <= len(data)-8 {
						child, _, childOK := parseEBMLElement(data, ttOff)
						if !childOK {
							break
						}
						if child.ID == mkvTrackType && child.BodyEnd <= len(data) {
							tt = data[child.BodyOff]
						}
						if child.ID == mkvDefault && child.BodyEnd <= len(data) {
							dv = data[child.BodyOff]
							hd = true
						}
						ttOff = child.BodyEnd
					}
					if tt == 0x02 && hd {
						audioCount++
						if audioCount == 1 {
							default1 = dv
						} else if audioCount == 2 {
							default2 = dv
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
