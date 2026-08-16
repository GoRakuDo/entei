package ops

// subtitle_cues_test.go - the Cues-driven extraction path of
// ExtractSubtitleWebVTT: seek straight to the clusters the index names instead
// of walking every cluster, and fall back to the sequential walk when the index
// does not reference the track (or points at garbage).

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gravity-zero/mkvgo/mkv"
	"github.com/gravity-zero/mkvgo/mkv/writer"
)

// countingRSC counts the bytes a handle returns from the source, so a test can
// prove the Cues-driven extraction reads only the cued clusters. Each Open gets
// its own counter: the metadata read and the block extraction open separately.
type countingRSC struct {
	*os.File
	read int64
}

func (c *countingRSC) Read(p []byte) (int, error) {
	n, err := c.File.Read(p)
	c.read += int64(n)
	return n, err
}

// openCountingFS wraps path in an FS whose handles count the bytes each one
// returns. The returned closure reports the per-handle totals in open order.
func openCountingFS(t *testing.T, path string) (*mkv.FS, func() []int64) {
	t.Helper()
	var reads []*int64
	fs := &mkv.FS{
		Open: func(p string) (mkv.ReadSeekCloser, error) {
			f, err := os.Open(p)
			if err != nil {
				return nil, err
			}
			r := &countingRSC{File: f}
			reads = append(reads, &r.read)
			return r, nil
		},
	}
	return fs, func() []int64 {
		out := make([]int64, len(reads))
		for i, p := range reads {
			out[i] = *p
		}
		return out
	}
}

// subtitleCuedBlocks is the block set buildSubtitleCuedFile writes: three
// subtitle cues in three clusters, with a large uncued other-track cluster
// between the first two - the span the Cues-driven path must not read.
func subtitleCuedFile(t *testing.T, dir, name string, cues []mkv.CuePoint) string {
	t.Helper()
	path := filepath.Join(dir, name)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	mw := writer.NewMKVWriter(f)
	if err := mw.WriteStart(); err != nil {
		t.Fatal(err)
	}
	c := &mkv.Container{Info: mkv.SegmentInfo{TimecodeScale: 1_000_000, MuxingApp: "test", WritingApp: "test"}}
	if err := mw.WriteMetadata(c, []mkv.Track{subtitleTrack(1, "srt")}, 5000); err != nil {
		t.Fatal(err)
	}

	c1 := mw.RelPos()
	if err := writer.WriteCluster(f, 0, 1_000_000, []mkv.Block{
		{TrackNumber: 1, Timecode: 0, Duration: 1000, Data: []byte("First")},
	}); err != nil {
		t.Fatal(err)
	}
	// A large cluster on an undeclared track, timestamped between the first and
	// second subtitle clusters, with NO cue. The fast path must jump over it; a
	// full walk reads the whole megabyte.
	if err := writer.WriteCluster(f, 1000, 1_000_000, []mkv.Block{
		{TrackNumber: 2, Timecode: 1000, Keyframe: true, Data: bytes.Repeat([]byte{'j'}, 1<<20)},
	}); err != nil {
		t.Fatal(err)
	}
	c2 := mw.RelPos()
	if err := writer.WriteCluster(f, 2000, 1_000_000, []mkv.Block{
		{TrackNumber: 1, Timecode: 2000, Duration: 1000, Data: []byte("Middle")},
		{TrackNumber: 1, Timecode: 2500, Duration:1000, Data: []byte("Middle 2")},
	}); err != nil {
		t.Fatal(err)
	}
	c3 := mw.RelPos()
	if err := writer.WriteCluster(f, 4000, 1_000_000, []mkv.Block{
		{TrackNumber: 1, Timecode: 4000, Duration: 1000, Data: []byte("Last")},
	}); err != nil {
		t.Fatal(err)
	}

	if cues == nil {
		cues = []mkv.CuePoint{
			{TimeMs: 0, Track: 1, ClusterPos: c1},
			{TimeMs: 2000, Track: 1, ClusterPos: c2},
			{TimeMs: 4000, Track: 1, ClusterPos: c3},
		}
	}
	mw.Cues = cues
	if err := mw.Finalize(); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestExtractSubtitleWebVTT_SeekThroughCues: a file whose Cues reference the
// subtitle track extracts every cue, and the block-read handle fetches only the
// cued clusters - nowhere near the 1 MiB uncued cluster or the file size.
func TestExtractSubtitleWebVTT_SeekThroughCues(t *testing.T) {
	dir := t.TempDir()
	path := subtitleCuedFile(t, dir, "cued.mkv", nil)
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	fs, reads := openCountingFS(t, path)

	var b strings.Builder
	if err := ExtractSubtitleWebVTT(context.Background(), path, 1, &b, mkv.Options{FS: fs}); err != nil {
		t.Fatalf("ExtractSubtitleWebVTT: %v", err)
	}
	got := b.String()
	for _, want := range []string{
		"WEBVTT",
		"00:00:00.000 --> 00:00:01.000\nFirst",
		"00:00:02.000 --> 00:00:03.000\nMiddle",
		"00:00:02.500 --> 00:00:03.500\nMiddle 2",
		"00:00:04.000 --> 00:00:05.000\nLast",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "j") {
		t.Errorf("the uncued cluster's payload leaked into the output:\n%s", got)
	}

	all := reads()
	if len(all) < 2 {
		t.Fatalf("expected at least 2 opens (metadata + blocks), got %d: %v", len(all), all)
	}
	blockRead := all[len(all)-1]
	if blockRead > 64<<10 {
		t.Errorf("block extraction read %d bytes; the Cues-driven path should stay a few KB (file is %d bytes)", blockRead, fi.Size())
	}
}

// TestExtractSubtitleWebVTT_UncuedTrackFallsBackToWalk: a file whose index cues
// only the video track extracts its subtitle track through the sequential walk
// - correct output, and the walk really reads the whole payload.
func TestExtractSubtitleWebVTT_UncuedTrackFallsBackToWalk(t *testing.T) {
	dir := t.TempDir()
	tracks := []mkv.Track{videoTrack(1), subtitleTrack(2, "srt")}
	blocks := []mkv.Block{
		{TrackNumber: 1, Timecode: 0, Keyframe: true, Data: []byte("v0")},
		{TrackNumber: 2, Timecode: 500, Duration: 1000, Data: []byte("Caption")},
	}
	path := buildMinimalMKV(t, dir, "nocue.mkv", tracks, blocks, 2000)
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	fs, reads := openCountingFS(t, path)

	var b strings.Builder
	if err := ExtractSubtitleWebVTT(context.Background(), path, 2, &b, mkv.Options{FS: fs}); err != nil {
		t.Fatalf("ExtractSubtitleWebVTT: %v", err)
	}
	if !strings.Contains(b.String(), "Caption") {
		t.Errorf("fallback extraction missing the caption:\n%s", b.String())
	}
	if strings.Contains(b.String(), "v0") {
		t.Errorf("video payload leaked into subtitle output:\n%s", b.String())
	}

	all := reads()
	if len(all) < 2 {
		t.Fatalf("expected at least 2 opens, got %d: %v", len(all), all)
	}
	// The sequential walk reads every block payload: the extraction handle must
	// touch the bulk of the file, unlike the Cues-driven path.
	if blockRead := all[len(all)-1]; blockRead < fi.Size()/2 {
		t.Errorf("fallback extraction read %d bytes of a %d-byte file; the walk should read the whole payload", blockRead, fi.Size())
	}
}

// TestExtractSubtitleWebVTT_StaleCueFallsBackToWalk: a cue that points into the
// head (not at a Cluster) must not be parsed as a cluster; the extraction falls
// back to the sequential walk and still returns every cue.
func TestExtractSubtitleWebVTT_StaleCueFallsBackToWalk(t *testing.T) {
	dir := t.TempDir()
	// One cue naming an offset inside the head metadata - never a Cluster.
	path := subtitleCuedFile(t, dir, "stale.mkv", []mkv.CuePoint{{TimeMs: 0, Track: 1, ClusterPos: 5}})
	fs, _ := openCountingFS(t, path)

	var b strings.Builder
	if err := ExtractSubtitleWebVTT(context.Background(), path, 1, &b, mkv.Options{FS: fs}); err != nil {
		t.Fatalf("ExtractSubtitleWebVTT: %v", err)
	}
	got := b.String()
	for _, want := range []string{"First", "Middle", "Last"} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q (stale cue must fall back to the walk):\n%s", want, got)
		}
	}
}
