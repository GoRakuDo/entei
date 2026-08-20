package api

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/gravity-zero/mkvgo/ebml"
	"github.com/gravity-zero/mkvgo/mkv"
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
	ebmlHeader := mkvElem(uint64(ebml.IDEBMLHeader), docType)
	var tracksPayload []byte
	for _, te := range trackEntries {
		tracksPayload = append(tracksPayload, te...)
	}
	tracksElem := mkvElem(uint64(mkv.IDTracks), tracksPayload)
	segment := mkvElem(uint64(mkv.IDSegment), tracksElem)
	return append(ebmlHeader, segment...)
}

func buildTrackEntry(children ...[]byte) []byte {
	var payload []byte
	for _, child := range children {
		payload = append(payload, child...)
	}
	return mkvElem(uint64(mkv.IDTrackEntry), payload)
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
	jaTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("jpn")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x00)))
	enTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("eng")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x01)))
	header := buildMKVHeader(jaTrack, enTrack)
	reader := newTestReader(header)
	modified, ok, reason := rewriteMKVDefaultAudio(context.Background(), reader)
	if !ok {
		t.Fatalf("expected rewrite to succeed, got ok=false reason=%s", reason)
	}
	if len(modified) != len(header) {
		t.Fatalf("modified header length %d != original %d", len(modified), len(header))
	}
	jaDefault, enDefault := findDefaultFlags(t, modified)
	if jaDefault != 1 {
		t.Errorf("Japanese track Default: got %d, want 1", jaDefault)
	}
	if enDefault != 0 {
		t.Errorf("English track Default: got %d, want 0", enDefault)
	}
}

func TestRewriteMKVDefaultAudio_1Track(t *testing.T) {
	track := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("jpn")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x01)))
	header := buildMKVHeader(track)
	reader := newTestReader(header)
	_, ok, _ := rewriteMKVDefaultAudio(context.Background(), reader)
	if ok {
		t.Fatal("expected ok=false for 1 audio track")
	}
}

func TestRewriteMKVDefaultAudio_3Tracks(t *testing.T) {
	t1 := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("jpn")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x00)))
	t2 := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("eng")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x01)))
	t3 := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("fre")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x00)))
	header := buildMKVHeader(t1, t2, t3)
	reader := newTestReader(header)
	_, ok, _ := rewriteMKVDefaultAudio(context.Background(), reader)
	if ok {
		t.Fatal("expected ok=false for 3 audio tracks")
	}
}

func TestRewriteMKVDefaultAudio_2Tracks_NoJapanese(t *testing.T) {
	t1 := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("eng")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x01)))
	t2 := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("fre")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x00)))
	header := buildMKVHeader(t1, t2)
	reader := newTestReader(header)
	_, ok, _ := rewriteMKVDefaultAudio(context.Background(), reader)
	if ok {
		t.Fatal("expected ok=false when no Japanese track")
	}
}

func TestRewriteMKVDefaultAudio_Idempotent(t *testing.T) {
	jaTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("jpn")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x01)))
	enTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("eng")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x00)))
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
	jaTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("ja")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x00)))
	enTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("eng")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x01)))
	header := buildMKVHeader(jaTrack, enTrack)
	reader := newTestReader(header)
	modified, ok, reason := rewriteMKVDefaultAudio(context.Background(), reader)
	if !ok {
		t.Fatalf("expected rewrite for ja lang, got ok=false reason=%s", reason)
	}
	jaDefault, _ := findDefaultFlags(t, modified)
	if jaDefault != 1 {
		t.Errorf("Japanese Default: got %d, want 1", jaDefault)
	}
}

func TestRewriteMKVDefaultAudio_BCP47Language(t *testing.T) {
	// Build a track with only the BCP47 language element (0x22B59D) set to "ja",
	// no legacy ISO 639-2 Language element. ResolvedLanguage() should pick up BCP47.
	jaTrack := buildTrackEntry(
		mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)),
		mkvElem(uint64(mkv.IDLanguageBCP47), mkvString("ja")),
		mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x00)),
	)
	enTrack := buildTrackEntry(
		mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)),
		mkvElem(uint64(mkv.IDLanguage), mkvString("eng")),
		mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x01)),
	)
	header := buildMKVHeader(jaTrack, enTrack)
	reader := newTestReader(header)
	modified, ok, reason := rewriteMKVDefaultAudio(context.Background(), reader)
	if !ok {
		t.Fatalf("expected rewrite to succeed for BCP47-only ja, got ok=false reason=%s", reason)
	}
	jaDefault, enDefault := findDefaultFlags(t, modified)
	if jaDefault != 1 {
		t.Errorf("Japanese track Default: got %d, want 1", jaDefault)
	}
	if enDefault != 0 {
		t.Errorf("English track Default: got %d, want 0", enDefault)
	}
}

func TestRewriteMKVDefaultAudio_NoDefaultElement(t *testing.T) {
	t1 := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("jpn")))
	t2 := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("eng")))
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
	vTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x01)), mkvElem(uint64(mkv.IDCodecID), mkvString("V_MPEG4/ISO/AVC")))
	jaTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("jpn")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x00)))
	enTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("eng")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x01)))
	header := buildMKVHeader(vTrack, jaTrack, enTrack)
	reader := newTestReader(header)
	modified, ok, reason := rewriteMKVDefaultAudio(context.Background(), reader)
	if !ok {
		t.Fatalf("expected rewrite (1v+2a), got ok=false reason=%s", reason)
	}
	jaDefault, enDefault := findDefaultFlags(t, modified)
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
	jaTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("jpn")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x00)))
	enTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("eng")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x01)))

	// Build the tracks element properly first to get correct size
	tracksElem := mkvElem(uint64(mkv.IDTracks), append(jaTrack, enTrack...))

	// Manually construct Segment: ID (4 bytes) + size byte 0xFF (unknown) + tracks payload
	segID := mkvElemID(uint64(mkv.IDSegment))
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
	jaDefault, enDefault := findDefaultFlags(t, modified)
	if jaDefault != 1 {
		t.Errorf("Japanese track Default: got %d, want 1", jaDefault)
	}
	if enDefault != 0 {
		t.Errorf("English track Default: got %d, want 0", enDefault)
	}
}

func TestRewriteMKVDefaultAudio_8ByteVINTSegmentSize(t *testing.T) {
	// Build an MKV header where the Segment element has a large declared size
	// encoded in 8-byte VINT (sizeByte=0x01). This is the case that broke
	// the old hand-rolled EBML parser (sizeByte=0x01 → 8-byte VINT width).
	jaTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("jpn")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x00)))
	enTrack := buildTrackEntry(mkvElem(uint64(mkv.IDTrackType), mkvUint8(0x02)), mkvElem(uint64(mkv.IDLanguage), mkvString("eng")), mkvElem(uint64(mkv.IDFlagDefault), mkvUint8(0x01)))
	tracksElem := mkvElem(uint64(mkv.IDTracks), append(jaTrack, enTrack...))

	// Manually construct Segment: ID (4 bytes) + 8-byte VINT size (0x01 prefix)
	// encoding a very large size. 0x01 = 00000001 → first set bit at position 0
	// → VINT width = 8 - 0 = 8 bytes. The size value is enormous (~72 PB).
	segID := mkvElemID(uint64(mkv.IDSegment))
	segHeader := append(segID, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF)
	header := append(buildEBMLHeaderForTest(), segHeader...)
	header = append(header, tracksElem...)

	reader := newTestReader(header)
	modified, ok, reason := rewriteMKVDefaultAudio(context.Background(), reader)
	if !ok {
		t.Fatalf("expected rewrite to succeed with 8-byte VINT Segment size, got ok=false reason=%s", reason)
	}
	jaDefault, enDefault := findDefaultFlags(t, modified)
	if jaDefault != 1 {
		t.Errorf("Japanese track Default: got %d, want 1", jaDefault)
	}
	if enDefault != 0 {
		t.Errorf("English track Default: got %d, want 0", enDefault)
	}
}

func buildEBMLHeaderForTest() []byte {
	docType := mkvElem(mkvDocType, mkvString("matroska"))
	return mkvElem(uint64(ebml.IDEBMLHeader), docType)
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

// findDefaultFlags parses data as an MKV header and returns the Default flag
// values for the first two audio TrackEntry elements found. Uses mkvgo's
// ebml.ReadElementHeader for robust VINT handling.
func findDefaultFlags(t *testing.T, data []byte) (default1, default2 uint8) {
	t.Helper()
	if len(data) < 12 || data[0] != 0x1A || data[1] != 0x45 || data[2] != 0xDF || data[3] != 0xA3 {
		t.Fatal("not MKV")
	}

	br := bytes.NewReader(data)

	// Skip EBML header
	ebmlHdr, _, err := ebml.ReadElementHeader(br)
	if err != nil || ebmlHdr.ID != ebml.IDEBMLHeader {
		t.Fatal("bad EBML header")
	}
	if _, err := br.Seek(ebmlHdr.Size, io.SeekCurrent); err != nil {
		t.Fatal(err)
	}

	// Read Segment header
	segHdr, _, err := ebml.ReadElementHeader(br)
	if err != nil || segHdr.ID != mkv.IDSegment {
		t.Fatal("no segment")
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
		if pos >= int64(len(data)) {
			break
		}

		childHdr, _, err := ebml.ReadElementHeader(br)
		if err != nil {
			t.Fatalf("parse segment child at %d", pos)
		}
		if childHdr.Size < 0 {
			break
		}

		if childHdr.ID == mkv.IDTracks {
			tracksBodyStart, _ := br.Seek(0, io.SeekCurrent)
			tracksEnd := tracksBodyStart + childHdr.Size
			audioCount := 0

			for {
				tePos, _ := br.Seek(0, io.SeekCurrent)
				if tePos >= tracksEnd || tePos >= int64(len(data)) {
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
					var tt uint8
					var dv uint8
					var hd bool

					for {
						chPos, _ := br.Seek(0, io.SeekCurrent)
						if chPos >= teBodyEnd || chPos >= int64(len(data)) {
							break
						}

						chHdr, _, err := ebml.ReadElementHeader(br)
						if err != nil {
							break
						}
						if chHdr.Size < 0 {
							break
						}

						if chHdr.ID == mkv.IDTrackType && chHdr.Size == 1 {
							vPos, _ := br.Seek(0, io.SeekCurrent)
							if vPos < int64(len(data)) {
								tt = data[vPos]
							}
						}
						if chHdr.ID == mkv.IDFlagDefault && chHdr.Size == 1 {
							vPos, _ := br.Seek(0, io.SeekCurrent)
							if vPos < int64(len(data)) {
								dv = data[vPos]
								hd = true
							}
						}

						if _, err := br.Seek(chHdr.Size, io.SeekCurrent); err != nil {
							break
						}
					}

					if tt == 0x02 && hd {
						audioCount++
						if audioCount == 1 {
							default1 = dv
						} else if audioCount == 2 {
							default2 = dv
						}
					}
					// Position is already at teBodyEnd after children scan; no skip needed.
				} else {
					// Non-TrackEntry element: skip its body.
					if _, err := br.Seek(teHdr.Size, io.SeekCurrent); err != nil {
						break
					}
				}
			}
			break
		}

		if _, err := br.Seek(childHdr.Size, io.SeekCurrent); err != nil {
			break
		}
	}
	return
}
