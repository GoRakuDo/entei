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

type nopCloserReadSeeker struct {
	*bytes.Reader
}

func (r *nopCloserReadSeeker) Close() error { return nil }

// TestMkvFSAdapterStat pins the adapter's Stat: it must report the source's
// byte length as a file size (mkvgo's mp4 path reads it) and behave like a
// plain file.
func TestMkvFSAdapterStat(t *testing.T) {
	src := &fakeMkvSource{data: []byte("0123456789")}
	fs := mkvFSFor(context.Background(), src)
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
	fs := mkvFSFor(context.Background(), src)
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
	fs := mkvFSFor(ctx, src)

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

	if _, err := firstTextSubtitleTrack(ctx, mkvFSFor(ctx, noSubs)); !errors.Is(err, errNoEmbeddedSubtitle) {
		t.Errorf("video-only: err = %v, want errNoEmbeddedSubtitle", err)
	}
	if _, err := firstTextSubtitleTrack(ctx, mkvFSFor(ctx, bitmapOnly)); !errors.Is(err, errNoEmbeddedSubtitle) {
		t.Errorf("bitmap-only: err = %v, want errNoEmbeddedSubtitle", err)
	}
	id, err := firstTextSubtitleTrack(ctx, mkvFSFor(ctx, bitmapThenText))
	if err != nil {
		t.Fatalf("bitmap+text: %v", err)
	}
	if id != 3 {
		t.Errorf("bitmap+text track ID = %d, want 3 (first TEXT track)", id)
	}
	// Not a container at all: the probe error is NOT the sentinel, so the
	// caller can distinguish "no track" from "cannot read".
	notMKV := &fakeMkvSource{data: []byte("this is not a matroska file")}
	if _, err := firstTextSubtitleTrack(ctx, mkvFSFor(ctx, notMKV)); err == nil || errors.Is(err, errNoEmbeddedSubtitle) {
		t.Errorf("non-MKV: err = %v, want a probe error (not the sentinel)", err)
	}
}

