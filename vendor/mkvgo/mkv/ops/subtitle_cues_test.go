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

	"github.com/gravity-zero/mkvgo/ebml"
	"github.com/gravity-zero/mkvgo/mkv"
	"github.com/gravity-zero/mkvgo/mkv/reader"
	"github.com/gravity-zero/mkvgo/mkv/writer"
)

// readRange is a half-open byte interval [lo, hi) a handle returned from the
// source, so a test can prove the extraction never touches a given span - e.g.
// the media blocks a CueRelativePosition direct jump must skip.
type readRange struct{ lo, hi int64 }

// countingRSC counts the bytes a handle returns from the source - and where
// they came from - so a test can prove the Cues-driven extraction reads only
// the cued clusters. Each Open gets its own counter: the metadata read and the
// block extraction open separately.
type countingRSC struct {
	*os.File
	read int64
	pos  int64
	rngs []readRange
}

func (c *countingRSC) Read(p []byte) (int, error) {
	n, err := c.File.Read(p)
	if n > 0 {
		c.rngs = append(c.rngs, readRange{c.pos, c.pos + int64(n)})
		c.pos += int64(n)
		c.read += int64(n)
	}
	return n, err
}

func (c *countingRSC) Seek(offset int64, whence int) (int64, error) {
	pos, err := c.File.Seek(offset, whence)
	c.pos = pos
	return pos, err
}

// openCountingFS wraps path in an FS whose handles count the bytes each one
// returns and where they came from. The returned closures report the per-handle
// totals and read ranges in open order.
func openCountingFS(t *testing.T, path string) (*mkv.FS, func() []int64, func() [][]readRange) {
	t.Helper()
	var reads []*int64
	var rngs []*[]readRange
	fs := &mkv.FS{
		Open: func(p string) (mkv.ReadSeekCloser, error) {
			f, err := os.Open(p)
			if err != nil {
				return nil, err
			}
			r := &countingRSC{File: f}
			reads = append(reads, &r.read)
			rngs = append(rngs, &r.rngs)
			return r, nil
		},
	}
	return fs,
		func() []int64 {
			out := make([]int64, len(reads))
			for i, p := range reads {
				out[i] = *p
			}
			return out
		},
		func() [][]readRange {
			out := make([][]readRange, len(rngs))
			for i, p := range rngs {
				out[i] = append([]readRange(nil), (*p)...)
			}
			return out
		}
}

// readsIntersect reports whether any of the read ranges overlaps [lo, hi) - a
// test's way of proving the extraction never touched a given byte span.
func readsIntersect(rngs []readRange, lo, hi int64) bool {
	for _, r := range rngs {
		if r.lo < hi && lo < r.hi {
			return true
		}
	}
	return false
}

// subtitleCuedFile writes three subtitle cues in three clusters, with a large
// uncued other-track cluster between the first two - the span the Cues-driven
// path must not read. cueFn receives the three cluster positions and returns
// the cues to write; nil uses the default three-track cue set.
func subtitleCuedFile(t *testing.T, dir, name string, cueFn func(c1, c2, c3 int64) []mkv.CuePoint) string {
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

	if cueFn == nil {
		cueFn = func(c1, c2, c3 int64) []mkv.CuePoint {
			return []mkv.CuePoint{
				{TimeMs: 0, Track: 1, ClusterPos: c1},
				{TimeMs: 2000, Track: 1, ClusterPos: c2},
				{TimeMs: 4000, Track: 1, ClusterPos: c3},
			}
		}
	}
	mw.Cues = cueFn(c1, c2, c3)
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
	fs, reads, _ := openCountingFS(t, path)

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
	fs, reads, _ := openCountingFS(t, path)

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
	path := subtitleCuedFile(t, dir, "stale.mkv", func(c1, c2, c3 int64) []mkv.CuePoint {
		return []mkv.CuePoint{{TimeMs: 0, Track: 1, ClusterPos: 5}}
	})
	fs, _, _ := openCountingFS(t, path)

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

// cuedClusterSpec describes one cluster written by writeRelCuedCluster: an
// other-track block (video) followed by the subtitle block. The timecode scale
// is 1e6 in these tests, so millisecond values are also raw timecode units.
type cuedClusterSpec struct {
	ts       int64  // cluster Timestamp
	video    []byte // other-track payload, nil for none
	sub      []byte // subtitle payload, nil for none
	subDur   int64  // subtitle BlockDuration, 0 = SimpleBlock
	subRelTC int64  // subtitle block's relative timecode
}

// writeRelCuedCluster writes one cluster to f: a Timestamp, an optional video
// block, the subtitle block, then a padding Void so a read-ahead from the
// subtitle block can never reach the next cluster's media (the byte ranges a
// test asserts below stay meaningful). It returns the cluster's Segment-relative
// position, the subtitle block's offset from the cluster data start - the
// CueRelativePosition - and the video block's Segment-relative byte range.
func writeRelCuedCluster(t *testing.T, mw *writer.MKVWriter, f *os.File, spec cuedClusterSpec) (clusterPos, subRelPos int64, videoRange readRange) {
	t.Helper()
	clusterPos = mw.RelPos()
	var body bytes.Buffer
	tsWidth := ebml.UintLen(uint64(spec.ts))
	if _, err := ebml.WriteElementHeader(&body, mkv.IDTimestamp, int64(tsWidth)); err != nil {
		t.Fatal(err)
	}
	if _, err := ebml.WriteUint(&body, uint64(spec.ts), tsWidth); err != nil {
		t.Fatal(err)
	}
	if spec.video != nil {
		videoRange.lo = int64(body.Len())
		if err := writer.WriteSimpleBlock(&body, 2, 0, true, spec.video); err != nil {
			t.Fatal(err)
		}
		videoRange.hi = int64(body.Len())
	}
	if spec.sub != nil {
		subRelPos = int64(body.Len())
		if spec.subDur > 0 {
			if err := writer.WriteBlockGroup(&body, 1, int16(spec.subRelTC), spec.sub, uint64(spec.subDur)); err != nil {
				t.Fatal(err)
			}
		} else if err := writer.WriteSimpleBlock(&body, 1, int16(spec.subRelTC), true, spec.sub); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.WriteBytesElement(&body, mkv.IDVoid, bytes.Repeat([]byte{0}, 24<<10)); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteMasterElement(f, mkv.IDCluster, body.Bytes()); err != nil {
		t.Fatal(err)
	}
	if spec.video != nil {
		headerLen := int64(ebml.ElementHeaderLen(mkv.IDCluster, int64(body.Len())))
		videoRange.lo += clusterPos + headerLen
		videoRange.hi += clusterPos + headerLen
	}
	return clusterPos, subRelPos, videoRange
}

// relCuedFile writes a file whose subtitle blocks all carry a
// CueRelativePosition, each preceded in its cluster by a video block the direct
// jump must skip entirely - header included. Returns the path and the video
// blocks' absolute byte ranges (the extraction must never read them) plus the
// Segment start that absolute-izes them.
func relCuedFile(t *testing.T, dir, name string) (path string, segStart int64, videoRanges []readRange) {
	t.Helper()
	path = filepath.Join(dir, name)
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
	if err := mw.WriteMetadata(c, []mkv.Track{videoTrack(2), subtitleTrack(1, "srt")}, 6000); err != nil {
		t.Fatal(err)
	}

	specs := []cuedClusterSpec{
		{ts: 0, video: bytes.Repeat([]byte{'v'}, 32<<10), sub: []byte("First"), subDur: 1000},
		{ts: 2000, video: bytes.Repeat([]byte{'v'}, 32<<10), sub: []byte("Middle"), subDur: 1000},
		{ts: 4000, video: bytes.Repeat([]byte{'v'}, 32<<10), sub: []byte("Last"), subDur: 1000},
	}
	var cues []mkv.CuePoint
	for _, spec := range specs {
		cp, rp, vr := writeRelCuedCluster(t, mw, f, spec)
		videoRanges = append(videoRanges, vr)
		cues = append(cues, mkv.CuePoint{TimeMs: spec.ts, Track: 1, ClusterPos: cp, RelativePos: rp})
	}
	mw.Cues = cues
	if err := mw.Finalize(); err != nil {
		t.Fatal(err)
	}

	meta, err := reader.OpenWithFS(context.Background(), path, nil)
	if err != nil {
		t.Fatalf("read metadata: %v", err)
	}
	return path, meta.SegmentStart, videoRanges
}

// TestExtractSubtitleWebVTT_CueRelativePositionDirectJump: when the index
// carries CueRelativePosition the extraction jumps straight to each subtitle
// block - the video block before it in the same cluster (header included) is
// never read. A cluster scan would have to read that video block's header, so
// the byte-range assertion below discriminates the two paths.
func TestExtractSubtitleWebVTT_CueRelativePositionDirectJump(t *testing.T) {
	dir := t.TempDir()
	path, segStart, videoRanges := relCuedFile(t, dir, "relpos.mkv")
	fs, reads, rangeFS := openCountingFS(t, path)

	var b strings.Builder
	if err := ExtractSubtitleWebVTT(context.Background(), path, 1, &b, mkv.Options{FS: fs}); err != nil {
		t.Fatalf("ExtractSubtitleWebVTT: %v", err)
	}
	got := b.String()
	for _, want := range []string{
		"00:00:00.000 --> 00:00:01.000\nFirst",
		"00:00:02.000 --> 00:00:03.000\nMiddle",
		"00:00:04.000 --> 00:00:05.000\nLast",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "v") {
		t.Errorf("video payload leaked into the output:\n%s", got)
	}

	all := reads()
	if len(all) < 2 {
		t.Fatalf("expected at least 2 opens, got %d: %v", len(all), all)
	}
	allRanges := rangeFS()
	blockRanges := allRanges[len(allRanges)-1]
	for _, vr := range videoRanges {
		lo, hi := segStart+vr.lo, segStart+vr.hi
		if readsIntersect(blockRanges, lo, hi) {
			t.Errorf("a read touched the video block at [%d,%d); the CueRelativePosition path must jump straight to the subtitle block", lo, hi)
		}
	}
	if blockRead := all[len(all)-1]; blockRead > 64<<10 {
		t.Errorf("block extraction read %d bytes; direct jumps should stay a few dozen KiB", blockRead)
	}
}

// smallPayloadUncuedFile writes three cued subtitle clusters and uncued other-
// track clusters between them, each holding one payload smaller than seekSkipMin
// (64 KiB) - the frame-interleaved shape that used to make the Cues path read
// every such payload through (the old single 1 MiB test cluster was large enough
// to seek over, so it never exposed the read-through).
func smallPayloadUncuedFile(t *testing.T, dir, name string, uncued int) string {
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
	if err := mw.WriteMetadata(c, []mkv.Track{videoTrack(2), subtitleTrack(1, "srt")}, int64(4000+100*uncued)); err != nil {
		t.Fatal(err)
	}

	var cues []mkv.CuePoint
	ts := int64(0)
	uncuedCluster := func() {
		if err := writer.WriteCluster(f, ts, 1_000_000, []mkv.Block{
			{TrackNumber: 2, Timecode: ts, Keyframe: true, Data: bytes.Repeat([]byte{'u'}, 16<<10)},
		}); err != nil {
			t.Fatal(err)
		}
		ts += 100
	}
	cuedCluster := func(text string) {
		clusterPos := mw.RelPos()
		if err := writer.WriteCluster(f, ts, 1_000_000, []mkv.Block{
			{TrackNumber: 1, Timecode: ts, Duration: 1000, Data: []byte(text)},
		}); err != nil {
			t.Fatal(err)
		}
		cues = append(cues, mkv.CuePoint{TimeMs: ts, Track: 1, ClusterPos: clusterPos})
		ts += 100
	}

	cuedCluster("First")
	for i := 0; i < 100; i++ {
		uncuedCluster()
	}
	cuedCluster("Middle")
	for i := 0; i < 100; i++ {
		uncuedCluster()
	}
	cuedCluster("Last")
	for i := 0; i < uncued-200; i++ {
		uncuedCluster()
	}

	mw.Cues = cues
	if err := mw.Finalize(); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestExtractSubtitleWebVTT_ManySmallUncuedPayloadsBoundedReads: a file with
// hundreds of uncued clusters each holding a payload smaller than seekSkipMin
// must not make the extraction read through them - every payload under 64 KiB
// used to be read in full, a 4.8 MB drain for 300 clusters (the 27,000
// JS↔Go-boundary hang). The Cues path reads only the cued clusters.
func TestExtractSubtitleWebVTT_ManySmallUncuedPayloadsBoundedReads(t *testing.T) {
	dir := t.TempDir()
	path := smallPayloadUncuedFile(t, dir, "small.mkv", 300)
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	fs, reads, _ := openCountingFS(t, path)

	var b strings.Builder
	if err := ExtractSubtitleWebVTT(context.Background(), path, 1, &b, mkv.Options{FS: fs}); err != nil {
		t.Fatalf("ExtractSubtitleWebVTT: %v", err)
	}
	got := b.String()
	for _, want := range []string{"First", "Middle", "Last"} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "u") {
		t.Errorf("uncued payload leaked into the output:\n%s", got)
	}

	all := reads()
	if len(all) < 2 {
		t.Fatalf("expected at least 2 opens, got %d: %v", len(all), all)
	}
	blockRead := all[len(all)-1]
	// 300 × 16 KiB of payloads would previously be read through in full; the
	// cued clusters alone must cost a few dozen KiB.
	if blockRead > 256<<10 {
		t.Errorf("block extraction read %d bytes of a %d-byte file; the uncued clusters' small payloads must never be read", blockRead, fi.Size())
	}
}

// TestExtractSubtitleWebVTT_PerPositionPlanDrop: validation is per cue - one
// stale entry is dropped, the surviving entries still drive the seek path (the
// old all-or-nothing plan rejected everything and fell back to a whole-file
// walk, reading the 1 MiB uncued cluster). Bounded reads prove the seek path
// was used despite the stale cue.
func TestExtractSubtitleWebVTT_PerPositionPlanDrop(t *testing.T) {
	dir := t.TempDir()
	path := subtitleCuedFile(t, dir, "partial.mkv", func(c1, c2, c3 int64) []mkv.CuePoint {
		return []mkv.CuePoint{
			{TimeMs: 0, Track: 1, ClusterPos: 5}, // stale: points into the head, not a cluster
			{TimeMs: 0, Track: 1, ClusterPos: c1},
			{TimeMs: 2000, Track: 1, ClusterPos: c2},
			{TimeMs: 4000, Track: 1, ClusterPos: c3},
		}
	})
	fs, reads, _ := openCountingFS(t, path)

	var b strings.Builder
	if err := ExtractSubtitleWebVTT(context.Background(), path, 1, &b, mkv.Options{FS: fs}); err != nil {
		t.Fatalf("ExtractSubtitleWebVTT: %v", err)
	}
	got := b.String()
	for _, want := range []string{"First", "Middle", "Last"} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q (stale cue must be dropped, the rest of the plan used):\n%s", want, got)
		}
	}

	all := reads()
	if len(all) < 2 {
		t.Fatalf("expected at least 2 opens, got %d: %v", len(all), all)
	}
	// The old plan validation rejected the whole index on the one stale cue and
	// walked the file - reading the 1 MiB uncued cluster. Dropping only the
	// stale entry keeps the seek path, which reads a few dozen KiB.
	if blockRead := all[len(all)-1]; blockRead > 64<<10 {
		t.Errorf("block extraction read %d bytes; the stale cue must be dropped, not the whole plan", blockRead)
	}
}

// smallPayloadInCuedClusterFile writes cued subtitle clusters that each begin
// with a single 48 KiB other-track payload (below seekSkipMin, so a plain
// discard would read it through) followed by the subtitle block. The scan path
// must seek over that payload - never read it - for the whole extraction to
// stay a few dozen KiB.
func smallPayloadInCuedClusterFile(t *testing.T, dir, name string) string {
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
	if err := mw.WriteMetadata(c, []mkv.Track{videoTrack(2), subtitleTrack(1, "srt")}, 4000); err != nil {
		t.Fatal(err)
	}

	var cues []mkv.CuePoint
	for _, spec := range []struct {
		ts   int64
		text string
	}{
		{0, "First"}, {2000, "Last"},
	} {
		clusterPos := mw.RelPos()
		if err := writer.WriteCluster(f, spec.ts, 1_000_000, []mkv.Block{
			{TrackNumber: 2, Timecode: spec.ts, Keyframe: true, Data: bytes.Repeat([]byte{'v'}, 48<<10)},
			{TrackNumber: 1, Timecode: spec.ts, Duration: 1000, Data: []byte(spec.text)},
		}); err != nil {
			t.Fatal(err)
		}
		cues = append(cues, mkv.CuePoint{TimeMs: spec.ts, Track: 1, ClusterPos: clusterPos})
	}
	mw.Cues = cues
	if err := mw.Finalize(); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestExtractSubtitleWebVTT_ScannedClusterSkipsSmallPayloads: a cued cluster
// that must be scanned (no CueRelativePosition) still never reads the other
// track's 48 KiB payload sitting before its subtitle block - the payload is
// seeked over (SetDiscardAlwaysSeek), so the extraction stays a few dozen KiB.
// A plain discard would read it through (48 KiB < seekSkipMin) and roughly
// double the reads per cluster.
func TestExtractSubtitleWebVTT_ScannedClusterSkipsSmallPayloads(t *testing.T) {
	dir := t.TempDir()
	path := smallPayloadInCuedClusterFile(t, dir, "inscan.mkv")
	fs, reads, _ := openCountingFS(t, path)

	var b strings.Builder
	if err := ExtractSubtitleWebVTT(context.Background(), path, 1, &b, mkv.Options{FS: fs}); err != nil {
		t.Fatalf("ExtractSubtitleWebVTT: %v", err)
	}
	got := b.String()
	for _, want := range []string{"First", "Last"} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "v") {
		t.Errorf("video payload leaked into the output:\n%s", got)
	}

	all := reads()
	if len(all) < 2 {
		t.Fatalf("expected at least 2 opens, got %d: %v", len(all), all)
	}
	// With the pure-seek skip each cluster costs ~32 KiB (two 16 KiB
	// read-aheads); reading the two 48 KiB payloads through would add ~96 KiB.
	if blockRead := all[len(all)-1]; blockRead > 96<<10 {
		t.Errorf("block extraction read %d bytes; the scanned cluster's 48 KiB payload must be seeked over, not read", blockRead)
	}
}
