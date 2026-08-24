package torrent

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/gravity-zero/mkvgo/matroska"
	"github.com/gravity-zero/mkvgo/mkv"
	"github.com/gravity-zero/mkvgo/mkv/writer"
)

// seekBuffer is a bytes.Buffer-like writer that implements io.WriteSeeker —
// writer.NewMKVWriter (vendor/mkvgo) requires one to backpatch the SeekHead
// and Segment size on Finalize. Mirrors the fixture in
// vendor/mkvgo/mkv/writer/writer_test.go.
type seekBuffer struct {
	buf []byte
	pos int
}

func (s *seekBuffer) Write(p []byte) (int, error) {
	end := s.pos + len(p)
	if end > len(s.buf) {
		s.buf = append(s.buf, make([]byte, end-len(s.buf))...)
	}
	copy(s.buf[s.pos:], p)
	s.pos = end
	return len(p), nil
}

func (s *seekBuffer) Seek(offset int64, whence int) (int64, error) {
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = int64(s.pos) + offset
	case io.SeekEnd:
		abs = int64(len(s.buf)) + offset
	default:
		return 0, errors.New("seekBuffer: invalid whence")
	}
	if abs < 0 {
		return 0, errors.New("seekBuffer: negative position")
	}
	s.pos = int(abs)
	return abs, nil
}

// buildTestMKVWithSubtitle muxes the given tracks and blocks into a real,
// seekable MKV (with Cues) using mkvgo's writer — the "fake with embedded
// subtitle track" fixture the extraction tests run against.
func buildTestMKVWithSubtitle(t *testing.T, tracks []mkv.Track, blocks []mkv.Block, durationMs int64) []byte {
	t.Helper()
	var buf seekBuffer
	mw := writer.NewMKVWriter(&buf)
	if err := mw.WriteStart(); err != nil {
		t.Fatalf("WriteStart: %v", err)
	}
	c := &mkv.Container{
		Info: mkv.SegmentInfo{TimecodeScale: 1_000_000, MuxingApp: "test", WritingApp: "test"},
	}
	if err := mw.WriteMetadata(c, tracks, durationMs); err != nil {
		t.Fatalf("WriteMetadata: %v", err)
	}
	if len(blocks) > 0 {
		if err := mw.WriteClusterWithCues(0, 1_000_000, blocks); err != nil {
			t.Fatalf("WriteClusterWithCues: %v", err)
		}
	}
	if err := mw.Finalize(); err != nil {
		t.Fatalf("Finalize: %v", err)
	}
	return buf.buf
}

// fakeMkvSource serves the bytes of a real MKV through the
// torrentFileSource interface (a fresh independent reader per open), standing
// in for the selected anacrolix file in the adapter tests.
type fakeMkvSource struct {
	data []byte
}

func (s *fakeMkvSource) openFile(context.Context) (mkv.ReadSeekCloser, error) {
	return &nopCloserReadSeeker{Reader: bytes.NewReader(s.data)}, nil
}

func (s *fakeMkvSource) fileLength() int64 { return int64(len(s.data)) }

// fullMKVFS adapts a fake source with an unbounded maxOffset — the pre-LazySync
// behavior, used by tests that read the whole file.
func fullMKVFS(ctx context.Context, src *fakeMkvSource) *mkv.FS {
	return mkvFSFor(ctx, src, src.fileLength())
}

type nopCloserReadSeeker struct {
	*bytes.Reader
}

func (r *nopCloserReadSeeker) Close() error { return nil }

// TestMkvFSAdapterStat pins the adapter's Stat: it must report the source's
// byte length as a file size (mkvgo's mp4 path reads it) and behave like a
// plain file.
func TestMkvFSAdapterStat(t *testing.T) {
	src := &fakeMkvSource{data: []byte("0123456789")}
	fs := fullMKVFS(context.Background(), src)
	fi, err := fs.DoStat("in")
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if fi.Size() != 10 {
		t.Errorf("Stat.Size() = %d, want 10", fi.Size())
	}
	if fi.IsDir() {
		t.Error("Stat.IsDir() = true, want false")
	}
	if fi.Name() != "in" {
		t.Errorf("Stat.Name() = %q, want in", fi.Name())
	}
}

// TestMkvFSAdapterOpenFreshReader pins the adapter's Open contract: every
// call returns a NEW independent reader positioned at offset 0 (mkvgo opens
// the source twice in one extraction — a metadata probe, then the block
// reader). The first reader's position must not leak into the second.
func TestMkvFSAdapterOpenFreshReader(t *testing.T) {
	src := &fakeMkvSource{data: buildTestMKVWithSubtitle(t,
		[]mkv.Track{{ID: 2, Type: mkv.SubtitleTrack, Codec: "srt", Language: "jpn"}},
		[]mkv.Block{{TrackNumber: 2, Timecode: 1000, Duration: 1000, Data: []byte("Hello")}},
		5000)}
	fs := fullMKVFS(context.Background(), src)
	r1, err := fs.DoOpen("in")
	if err != nil {
		t.Fatalf("Open #1: %v", err)
	}
	defer r1.Close()
	if _, err := r1.Seek(10, 0); err != nil {
		t.Fatalf("seek r1: %v", err)
	}
	r2, err := fs.DoOpen("in")
	if err != nil {
		t.Fatalf("Open #2: %v", err)
	}
	defer r2.Close()
	// r2 must start at offset 0 regardless of r1's position.
	pos, err := r2.Seek(0, 1)
	if err != nil {
		t.Fatalf("tell r2: %v", err)
	}
	if pos != 0 {
		t.Errorf("fresh Open position = %d, want 0", pos)
	}
}

// TestMkvFSAdapterExtractsEmbeddedSubtitle runs the whole mkvgo pipeline
// through the adapter: probe the container for the first text subtitle track,
// then extract it as WebVTT. This is exactly the embedded-subtitle reference
// SubtitleContent serves for a video-only torrent.
func TestMkvFSAdapterExtractsEmbeddedSubtitle(t *testing.T) {
	src := &fakeMkvSource{data: buildTestMKVWithSubtitle(t,
		[]mkv.Track{
			{ID: 1, Type: mkv.VideoTrack, Codec: "h264", Language: "eng"},
			{ID: 2, Type: mkv.SubtitleTrack, Codec: "srt", Language: "jpn"},
		},
		[]mkv.Block{
			{TrackNumber: 1, Timecode: 0, Keyframe: true, Data: []byte("video0")},
			{TrackNumber: 2, Timecode: 1000, Duration: 1000, Data: []byte("Hello")},
			{TrackNumber: 2, Timecode: 3000, Duration: 2000, Data: []byte("World")},
		},
		5000)}
	ctx := context.Background()
	fs := fullMKVFS(ctx, src)

	trackID, err := firstTextSubtitleTrack(ctx, fs)
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if trackID != 2 {
		t.Errorf("probed track ID = %d, want 2 (first subtitle track)", trackID)
	}

	var out strings.Builder
	if err := matroska.ExtractSubtitleWebVTT(ctx, "in", trackID, &out, matroska.Options{FS: fs}); err != nil {
		t.Fatalf("ExtractSubtitleWebVTT: %v", err)
	}
	got := out.String()
	for _, want := range []string{
		"WEBVTT",
		"00:00:01.000 --> 00:00:02.000\nHello",
		"00:00:03.000 --> 00:00:05.000\nWorld",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q:\n%s", want, got)
		}
	}
}

// TestFirstTextSubtitleTrack pins the probe's track picking: the first TEXT
// subtitle track wins (language agnostic), a bitmap-only file reports
// errNoEmbeddedSubtitle, and a file with no subtitle track at all reports the
// same sentinel (so SubtitleContent keeps its 404 contract).
func TestFirstTextSubtitleTrack(t *testing.T) {
	ctx := context.Background()
	noSubs := &fakeMkvSource{data: buildTestMKVWithSubtitle(t,
		[]mkv.Track{{ID: 1, Type: mkv.VideoTrack, Codec: "h264", Language: "eng"}},
		nil, 1000)}
	bitmapOnly := &fakeMkvSource{data: buildTestMKVWithSubtitle(t,
		[]mkv.Track{
			{ID: 1, Type: mkv.VideoTrack, Codec: "h264"},
			{ID: 2, Type: mkv.SubtitleTrack, Codec: "pgs"}, // bitmap: not text
		},
		nil, 1000)}
	bitmapThenText := &fakeMkvSource{data: buildTestMKVWithSubtitle(t,
		[]mkv.Track{
			{ID: 1, Type: mkv.VideoTrack, Codec: "h264"},
			{ID: 2, Type: mkv.SubtitleTrack, Codec: "pgs"}, // skipped
			{ID: 3, Type: mkv.SubtitleTrack, Codec: "ass", Language: "jpn"}, // wins
		},
		nil, 1000)}

	if _, err := firstTextSubtitleTrack(ctx, fullMKVFS(ctx, noSubs)); !errors.Is(err, errNoEmbeddedSubtitle) {
		t.Errorf("video-only: err = %v, want errNoEmbeddedSubtitle", err)
	}
	if _, err := firstTextSubtitleTrack(ctx, fullMKVFS(ctx, bitmapOnly)); !errors.Is(err, errNoEmbeddedSubtitle) {
		t.Errorf("bitmap-only: err = %v, want errNoEmbeddedSubtitle", err)
	}
	id, err := firstTextSubtitleTrack(ctx, fullMKVFS(ctx, bitmapThenText))
	if err != nil {
		t.Fatalf("bitmap+text: %v", err)
	}
	if id != 3 {
		t.Errorf("bitmap+text track ID = %d, want 3 (first TEXT track)", id)
	}
	// Not a container at all: the probe error is NOT the sentinel, so the
	// caller can distinguish "no track" from "cannot read".
	notMKV := &fakeMkvSource{data: []byte("this is not a matroska file")}
	if _, err := firstTextSubtitleTrack(ctx, fullMKVFS(ctx, notMKV)); err == nil || errors.Is(err, errNoEmbeddedSubtitle) {
		t.Errorf("non-MKV: err = %v, want a probe error (not the sentinel)", err)
	}
}

// TestClampedReadSeekCloser pins the clamp wrapper's contract — the piece the
// LazySync extraction relies on: reads past max return EOF without touching
// the underlying reader (so a not-yet-downloaded range can never block),
// reads crossing max return only the in-range part, SeekEnd reports the REAL
// source end (mkvgo's tail scans compute windows against the true length),
// and invalid seeks fail cleanly.
func TestClampedReadSeekCloser(t *testing.T) {
	c := &clampedReadSeekCloser{
		r:   &nopCloserReadSeeker{Reader: bytes.NewReader([]byte("0123456789"))},
		max: 5,
	}
	buf := make([]byte, 4)

	// Read fully within the limit.
	n, err := c.Read(buf)
	if n != 4 || err != nil || string(buf) != "0123" {
		t.Fatalf("first Read = %d, %v, %q; want 4, nil, \"0123\"", n, err, buf)
	}
	// Read crossing the limit returns only the in-range remainder.
	n, err = c.Read(buf)
	if n != 1 || err != nil || string(buf[:1]) != "4" {
		t.Fatalf("boundary Read = %d, %v, %q; want 1, nil, \"4\"", n, err, buf)
	}
	// Read at/after the limit: EOF immediately, no underlying read.
	if n, err := c.Read(buf); n != 0 || err != io.EOF {
		t.Fatalf("past-limit Read = %d, %v; want 0, io.EOF", n, err)
	}
	// Seek back inside the limit resumes reading there.
	if _, err := c.Seek(2, io.SeekStart); err != nil {
		t.Fatalf("seek 2: %v", err)
	}
	if n, err := c.Read(buf); n != 3 || string(buf[:3]) != "234" {
		t.Fatalf("read after re-seek = %d, %v, %q; want 3, nil, \"234\"", n, err, buf)
	}
	// Seek beyond the limit: reads still EOF (no panic, no underlying read).
	if _, err := c.Seek(9, io.SeekStart); err != nil {
		t.Fatalf("seek 9: %v", err)
	}
	if n, err := c.Read(buf); n != 0 || err != io.EOF {
		t.Fatalf("read at offset 9 = %d, %v; want 0, io.EOF", n, err)
	}
	// SeekEnd reports the REAL source end, not the clamp.
	if pos, err := c.Seek(0, io.SeekEnd); err != nil || pos != 10 {
		t.Fatalf("SeekEnd = %d, %v; want 10, nil", pos, err)
	}
	if pos, err := c.Seek(-3, io.SeekEnd); err != nil || pos != 7 {
		t.Fatalf("SeekEnd(-3) = %d, %v; want 7, nil", pos, err)
	}
	// Position 7 is past the clamp (5): reads EOF — the graceful stop mkvgo's
	// tail scan relies on. SeekEnd reports the real end so mkvgo's windows
	// are computed against the true length; the clamp lives in Read.
	if n, err := c.Read(buf); n != 0 || err != io.EOF {
		t.Fatalf("read after SeekEnd(-3) = %d, %v; want 0, io.EOF", n, err)
	}
	// SeekCurrent tracks the clamped position.
	if pos, err := c.Seek(-5, io.SeekCurrent); err != nil || pos != 2 {
		t.Fatalf("SeekCurrent(-5) = %d, %v; want 2, nil", pos, err)
	}
	if n, err := c.Read(buf); n != 3 || string(buf[:3]) != "234" {
		t.Fatalf("read after SeekCurrent(-5) = %d, %v, %q; want 3, nil, \"234\"", n, err, buf)
	}
	// Invalid seeks fail cleanly.
	if _, err := c.Seek(-1, io.SeekStart); err == nil {
		t.Error("negative SeekStart: want error")
	}
	if _, err := c.Seek(0, 99); err == nil {
		t.Error("invalid whence: want error")
	}
}

// TestClampedReadSeekCloserReadsNoBlock verifies the clamp never forwards a
// read that would cross the limit to the underlying reader: a past-limit Read
// must return EOF synthesized by the clamp, leaving the underlying reader
// untouched (a real anacrolix reader would BLOCK on a request for
// not-yet-downloaded bytes).
func TestClampedReadSeekCloserReadsNoBlock(t *testing.T) {
	underlying := &nopCloserReadSeeker{Reader: bytes.NewReader([]byte("0123456789"))}
	c := &clampedReadSeekCloser{r: underlying, max: 4}
	buf := make([]byte, 10)
	if _, err := c.Read(buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if _, err := c.Read(buf); err != io.EOF {
		t.Fatalf("second read: %v, want io.EOF", err)
	}
	// Only the in-range 4 bytes were ever forwarded: 6 of 10 remain unread.
	if remaining := underlying.Len(); remaining != 6 {
		t.Errorf("underlying reader has %d bytes unread, want 6 (only 4 forwarded)", remaining)
	}
}

// TestMkvFSAdapterClampedPrefixExtraction pins the LazySync extraction
// contract at the FS level: with maxOffset cutting the file mid-cluster, the
// extraction returns exactly the subtitle cues whose bytes are inside the
// downloaded prefix — the cue before the boundary appears, the one after it
// does not, and the walk stops cleanly at the boundary instead of erroring or
// blocking.
func TestMkvFSAdapterClampedPrefixExtraction(t *testing.T) {
	// One cluster: subtitle "Hello" first (inside the prefix), then a 2 MiB
	// video block that pushes the cluster's tail (subtitle "World" and the
	// Cues) beyond the 64 KiB prefix.
	bigVideo := make([]byte, 2<<20)
	src := &fakeMkvSource{data: buildTestMKVWithSubtitle(t,
		[]mkv.Track{
			{ID: 1, Type: mkv.VideoTrack, Codec: "h264", Language: "eng"},
			{ID: 2, Type: mkv.SubtitleTrack, Codec: "srt", Language: "jpn"},
		},
		[]mkv.Block{
			{TrackNumber: 2, Timecode: 1000, Duration: 1000, Data: []byte("Hello")},
			{TrackNumber: 1, Timecode: 0, Keyframe: true, Data: bigVideo},
			{TrackNumber: 2, Timecode: 3000, Duration: 2000, Data: []byte("World")},
		},
		5000)}
	ctx := context.Background()
	fs := mkvFSFor(ctx, src, 64<<10)

	trackID, err := firstTextSubtitleTrack(ctx, fs)
	if err != nil {
		t.Fatalf("probe on clamped FS: %v", err)
	}
	var out strings.Builder
	if err := matroska.ExtractSubtitleWebVTT(ctx, "in", trackID, &out, matroska.Options{FS: fs}); err != nil {
		t.Fatalf("ExtractSubtitleWebVTT on clamped FS: %v", err)
	}
	got := out.String()
	if !strings.Contains(got, "Hello") {
		t.Errorf("prefix extraction missing in-prefix cue \"Hello\":\n%s", got)
	}
	if strings.Contains(got, "World") {
		t.Errorf("prefix extraction leaked beyond-prefix cue \"World\":\n%s", got)
	}
	if !strings.Contains(got, "-->") {
		t.Errorf("prefix extraction produced no cue at all:\n%s", got)
	}
}

// TestMkvFSAdapterClampedZeroCues pins the "DL'd prefix holds no subtitle cue"
// shape: a prefix that covers only the head and the cluster's leading video
// bytes yields an empty WebVTT body — the signal the engine turns into 404 so
// the web layer keeps waiting for more data.
func TestMkvFSAdapterClampedZeroCues(t *testing.T) {
	bigVideo := make([]byte, 2<<20)
	src := &fakeMkvSource{data: buildTestMKVWithSubtitle(t,
		[]mkv.Track{
			{ID: 1, Type: mkv.VideoTrack, Codec: "h264", Language: "eng"},
			{ID: 2, Type: mkv.SubtitleTrack, Codec: "srt", Language: "jpn"},
		},
		[]mkv.Block{
			{TrackNumber: 1, Timecode: 0, Keyframe: true, Data: bigVideo},
			{TrackNumber: 2, Timecode: 1000, Duration: 1000, Data: []byte("Hello")},
		},
		5000)}
	ctx := context.Background()
	fs := mkvFSFor(ctx, src, 64<<10)

	trackID, err := firstTextSubtitleTrack(ctx, fs)
	if err != nil {
		t.Fatalf("probe on clamped FS: %v", err)
	}
	var out strings.Builder
	if err := matroska.ExtractSubtitleWebVTT(ctx, "in", trackID, &out, matroska.Options{FS: fs}); err != nil {
		t.Fatalf("ExtractSubtitleWebVTT on clamped FS: %v", err)
	}
	got := out.String()
	if strings.Contains(got, "-->") {
		t.Errorf("zero-cue prefix produced a cue:\n%s", got)
	}
	if strings.Contains(got, "Hello") {
		t.Errorf("zero-cue prefix leaked \"Hello\":\n%s", got)
	}
	if !strings.HasPrefix(got, "WEBVTT") {
		t.Errorf("zero-cue prefix output lacks the WebVTT header:\n%s", got)
	}
}

// TestMkvFSAdapterClampedStat pins the clamped Stat: the FS reports the
// clamped extent as the file size, consistent with the truncated-file view
// reads present.
func TestMkvFSAdapterClampedStat(t *testing.T) {
	src := &fakeMkvSource{data: []byte("0123456789")}
	fs := mkvFSFor(context.Background(), src, 5)
	fi, err := fs.DoStat("in")
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if fi.Size() != 5 {
		t.Errorf("clamped Stat.Size() = %d, want 5", fi.Size())
	}
}
