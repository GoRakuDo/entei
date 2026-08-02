package torrent

import (
	"os"
	"path/filepath"
	"testing"
)

func u32t(n uint32) []byte {
	b := make([]byte, 4)
	b[0], b[1], b[2], b[3] = byte(n>>24), byte(n>>16), byte(n>>8), byte(n)
	return b
}

func boxt(typ string, payload []byte) []byte {
	out := make([]byte, 8+len(payload))
	out[0], out[1], out[2], out[3] = 0, 0, byte((8+len(payload))>>8), byte(8+len(payload))
	copy(out[4:8], typ)
	copy(out[8:], payload)
	return out
}

func concatT(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// buildMP4 builds a minimal faststart MP4 with the given stsd video codec.
func buildMP4(codec string, sampleOffset, sampleSize uint32) []byte {
	ftyp := boxt("ftyp", concatT([]byte("isom"), []byte{0, 0, 2, 0}, []byte("isomiso2")))
	mvhd := boxt("mvhd", concatT([]byte{0, 0, 0, 0}, make([]byte, 96)))
	hdlr := boxt("hdlr", concatT([]byte{0, 0, 0, 0, 0, 0, 0, 0}, []byte("vide"), make([]byte, 12)))
	avc1 := boxt(codec, concatT(make([]byte, 78)))
	stsd := boxt("stsd", concatT([]byte{0, 0, 0, 0, 0, 0, 0, 1}, avc1))
	stco := boxt("stco", concatT([]byte{0, 0, 0, 0, 0, 0, 0, 1}, u32t(sampleOffset)))
	stsz := boxt("stsz", concatT([]byte{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}, u32t(sampleSize)))
	stbl := boxt("stbl", concatT(stsd, stco, stsz))
	minf := boxt("minf", stbl)
	mdia := boxt("mdia", concatT(hdlr, minf))
	trak := boxt("trak", mdia)
	moov := boxt("moov", concatT(mvhd, trak))
	return concatT(ftyp, moov)
}

func writeFile(t *testing.T, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "media.mp4")
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestStructurallyPlayableFaststartAVC(t *testing.T) {
	// Complete header + first sample at 512..1536 → playable.
	data := buildMP4("avc1", 512, 1024)
	full := append(data, make([]byte, 4096)...)
	p := writeFile(t, full)
	if !structurallyPlayable(p, int64(len(full))) {
		t.Fatal("complete faststart avc1 header with sample must be playable")
	}
}

func TestStructurallyPlayableVP9AV1(t *testing.T) {
	for _, codec := range []string{"vp09", "av01"} {
		full := append(buildMP4(codec, 512, 1024), make([]byte, 4096)...)
		p := writeFile(t, full)
		if !structurallyPlayable(p, int64(len(full))) {
			t.Fatalf("codec %s must be playable", codec)
		}
	}
}

func TestStructurallyPlayableRejectsHEVC(t *testing.T) {
	full := append(buildMP4("hvc1", 512, 1024), make([]byte, 4096)...)
	p := writeFile(t, full)
	if structurallyPlayable(p, int64(len(full))) {
		t.Fatal("hvc1 must NOT be marked playable (no reliable local decoder)")
	}
}

func TestStructurallyPlayableRejectsTruncatedMoov(t *testing.T) {
	// The moov box declares more bytes than the prefix contains.
	data := buildMP4("avc1", 512, 1024)
	truncated := data[:len(data)-16] // cut mid-moov
	p := writeFile(t, truncated)
	if structurallyPlayable(p, int64(len(truncated))) {
		t.Fatal("truncated moov must NOT be playable")
	}
}

func TestStructurallyPlayableRejectsMissingSample(t *testing.T) {
	// The first sample boundary lies beyond the verified prefix.
	data := buildMP4("avc1", 5120, 1024) // sample starts far beyond the header
	full := append(data, make([]byte, 1024)...)
	p := writeFile(t, full)
	if structurallyPlayable(p, int64(len(full))) {
		t.Fatal("missing sample bytes must NOT be playable")
	}
}

func TestStructurallyPlayableRejectsEBML(t *testing.T) {
	// An incomplete EBML header is not enough for early MKV playback.
	data := append([]byte{0x1A, 0x45, 0xDF, 0xA3}, make([]byte, 1024)...)
	p := writeFile(t, data)
	if structurallyPlayable(p, int64(len(data))) {
		t.Fatal("EBML/MKV must NOT be marked progressively playable")
	}
}

func TestMimeForExt(t *testing.T) {
	cases := map[string]string{
		"mp4": "video/mp4", "m4v": "video/mp4", "webm": "video/webm",
		"ogv": "video/ogg", "ogg": "video/ogg", "mkv": "video/x-matroska",
		"avi": "video/x-msvideo",
	}
	for ext, want := range cases {
		if got := mimeForExt(ext); got != want {
			t.Errorf("mimeForExt(%q) = %q, want %q", ext, got, want)
		}
	}
	if mimeForExt("txt") != "" {
		t.Error("unknown extension must map to empty")
	}
}

func TestDebugWalk(t *testing.T) {
	data := buildMP4("avc1", 512, 1024)
	boxes, err := walkBoxes(data)
	t.Logf("walk err: %v", err)
	for _, b := range boxes {
		t.Logf("top box: %s size=%d children=%d", b.typ, b.size, len(b.children))
		if b.typ == "moov" {
			for _, c := range b.children {
				t.Logf("  moov child: %s size=%d", c.typ, c.size)
				if c.typ == "trak" {
					for _, d := range c.children {
						t.Logf("    trak child: %s size=%d kids=%d", d.typ, d.size, len(d.children))
						if d.typ == "mdia" {
							for _, e := range d.children {
								t.Logf("      mdia child: %s size=%d kids=%d", e.typ, e.size, len(e.children))
								if e.typ == "minf" {
									for _, g := range e.children {
										t.Logf("        minf child: %s size=%d kids=%d", g.typ, g.size, len(g.children))
										if g.typ == "stbl" {
											for _, h := range g.children {
												t.Logf("          stbl child: %s size=%d kids=%d payload=%d", h.typ, h.size, len(h.children), len(h.payload))
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}
	}
	for _, b := range boxes {
		if b.typ == "moov" {
			for _, c := range b.children {
				if c.typ == "trak" {
					for _, d := range c.children {
						if d.typ == "mdia" {
							for _, e := range d.children {
								if e.typ == "minf" {
									for _, g := range e.children {
										if g.typ == "stbl" {
											for _, h := range g.children {
												t.Logf("stbl child %s size=%d kids=%d", h.typ, h.size, len(h.children))
												if h.typ == "stsd" {
													for _, s := range h.children {
														t.Logf("  stsd child %s size=%d", s.typ, s.size)
													}
												}
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}
	}
	t.Logf("codec=%q", stsdVideoCodec(boxes))
	off, sz, ok := earliestSampleBoundary(boxes)
	t.Logf("sample boundary off=%d sz=%d ok=%v", off, sz, ok)
}

// --- Matroska (EBML) test builders ---

func mkvSizeV(n int) []byte {
	if n < 127 {
		return []byte{byte(0x80 | n)}
	}
	if n < 16383 {
		return []byte{byte(0x40 | (n >> 8)), byte(n)}
	}
	if n < 2097151 {
		return []byte{byte(0x20 | (n >> 16)), byte(n >> 8), byte(n)}
	}
	return []byte{byte(0x10 | (n >> 24)), byte(n >> 16), byte(n >> 8), byte(n)}
}

func mkvElemT(id []byte, payload []byte) []byte {
	out := append([]byte{}, id...)
	out = append(out, mkvSizeV(len(payload))...)
	return append(out, payload...)
}

func mkvTrackEntryT(trackType byte, codec string, num byte) []byte {
	tt := mkvElemT([]byte{0x83}, []byte{trackType})
	ci := mkvElemT([]byte{0x86}, []byte(codec))
	tn := mkvElemT([]byte{0xD7}, []byte{0x80 | num})
	return mkvElemT([]byte{0xAE}, append(append(append([]byte{}, tt...), ci...), tn...))
}

func mkvTracksT(entries ...[]byte) []byte {
	var p []byte
	for _, e := range entries {
		p = append(p, e...)
	}
	return mkvElemT([]byte{0x16, 0x54, 0xAE, 0x6B}, p)
}

// mkvClusterT builds a Cluster whose first SimpleBlock targets the video
// track (frame fully inside the element).
func mkvClusterT(trackNum byte, withBlock bool) []byte {
	ts := mkvElemT([]byte{0xE7}, []byte{0, 0, 0, 0, 0, 0, 0, 0})
	block := mkvElemT([]byte{0xA3}, append([]byte{0x80 | trackNum, 0, 0, 0x80}, make([]byte, 64)...))
	if !withBlock {
		return mkvElemT([]byte{0x1F, 0x43, 0xB6, 0x75}, ts)
	}
	return mkvElemT([]byte{0x1F, 0x43, 0xB6, 0x75}, append(ts, block...))
}

func mkvHeadT(codec string, trackType byte, withBlock bool) []byte {
	docType := mkvElemT([]byte{0x42, 0x82}, []byte("matroska"))
	ebml := mkvElemT([]byte{0x1A, 0x45, 0xDF, 0xA3}, docType)
	seg := mkvElemT([]byte{0x18, 0x53, 0x80, 0x67},
		append(mkvTracksT(mkvTrackEntryT(trackType, codec, 1)), mkvClusterT(1, withBlock)...))
	return append(ebml, seg...)
}

func TestMkvPlayableValidAVC(t *testing.T) {
	full := append(mkvHeadT("V_MPEG4/ISO/AVC", 1, true), make([]byte, 2048)...)
	p := writeFile(t, full)
	if !structurallyPlayable(p, int64(len(full))) {
		t.Fatal("valid MKV head + video block must be playable")
	}
}

func TestMkvPlayableVP9AV1(t *testing.T) {
	for _, codec := range []string{"V_VP9", "V_AV1"} {
		full := append(mkvHeadT(codec, 1, true), make([]byte, 2048)...)
		p := writeFile(t, full)
		if !structurallyPlayable(p, int64(len(full))) {
			t.Fatalf("MKV codec %s must be playable", codec)
		}
	}
}

func TestMkvRejectsHEVC(t *testing.T) {
	full := append(mkvHeadT("V_MPEGH/ISO/HEVC", 1, true), make([]byte, 2048)...)
	p := writeFile(t, full)
	if structurallyPlayable(p, int64(len(full))) {
		t.Fatal("HEVC MKV must NOT be marked playable")
	}
}

func TestMkvRejectsUnknownCodec(t *testing.T) {
	full := append(mkvHeadT("V_UNKNOWN_X", 1, true), make([]byte, 2048)...)
	p := writeFile(t, full)
	if structurallyPlayable(p, int64(len(full))) {
		t.Fatal("unknown-codec MKV must NOT be marked playable")
	}
}

func TestMkvRejectsAudioOnly(t *testing.T) {
	full := append(mkvHeadT("A_AAC", 2, true), make([]byte, 2048)...)
	p := writeFile(t, full)
	if structurallyPlayable(p, int64(len(full))) {
		t.Fatal("audio-only MKV must NOT be marked playable")
	}
}

func TestMkvRejectsNoVideoBlock(t *testing.T) {
	full := append(mkvHeadT("V_MPEG4/ISO/AVC", 1, false), make([]byte, 2048)...)
	p := writeFile(t, full)
	if structurallyPlayable(p, int64(len(full))) {
		t.Fatal("MKV without a video block must NOT be marked playable")
	}
}

func TestMkvRejectsPartialTracks(t *testing.T) {
	data := mkvHeadT("V_MPEG4/ISO/AVC", 1, true)
	// Cut mid-Tracks so the declared Tracks end exceeds the prefix.
	truncated := data[:len(data)-40]
	p := writeFile(t, truncated)
	if structurallyPlayable(p, int64(len(truncated))) {
		t.Fatal("partial Tracks must NOT be marked playable")
	}
}

func TestMkvRejectsMalformedVINT(t *testing.T) {
	// A size byte of 0x00 is an invalid VINT (no marker).
	data := append([]byte{0x1A, 0x45, 0xDF, 0xA3, 0x00}, make([]byte, 128)...)
	p := writeFile(t, data)
	if structurallyPlayable(p, int64(len(data))) {
		t.Fatal("malformed VINT must NOT be marked playable")
	}
}

func TestMkvDebug(t *testing.T) {
	data := mkvHeadT("V_MPEG4/ISO/AVC", 1, true)
	t.Logf("head len=%d", len(data))
	hdrSize, _, unknown, ok := readVINTSize(data, 4)
	t.Logf("hdrSize=%d unknown=%v ok=%v", hdrSize, unknown, ok)
	docOff := 4 + sizeHeaderLen(data, 4)
	t.Logf("docOff=%d docTypeOK=%v", docOff, docTypeMatroska(data, docOff, int(hdrSize)))
	seg, segBody, ok := readMKVElement(data, docOff+int(hdrSize))
	t.Logf("seg id=%x ok=%v unknown=%v body=%d", seg.id, ok, seg.unknown, segBody)
	off := segBody
	for off < len(data) {
		e, next, ok := readMKVElement(data, off)
		if !ok {
			t.Logf("walk fail at %d", off)
			break
		}
		t.Logf("elem id=%x start=%d end=%d", e.id, e.start, e.end)
		if e.id == mkvTracks {
			vt, ok := parseMKVTracks(data, e)
			t.Logf("tracks -> num=%d ok=%v", vt.num, ok)
		}
		if e.id == mkvCluster {
			t.Logf("cluster block=%v", clusterHasVideoBlock(data, e, 1))
		}
		off = next
	}
}
