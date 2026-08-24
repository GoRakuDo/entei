package ops

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"

	"github.com/gravity-zero/mkvgo/ebml"
	"github.com/gravity-zero/mkvgo/mkv"
	"github.com/gravity-zero/mkvgo/mkv/reader"
	"github.com/gravity-zero/mkvgo/mkv/subtitle"
	"github.com/gravity-zero/mkvgo/mkv/writer"
)

const defaultSubDurationMs = 3000

func ExtractSubtitle(ctx context.Context, srcPath string, trackID uint64, outPath string, opts ...mkv.Options) (err error) {
	fs := mkv.FSFrom(opts)
	c, err := reader.OpenWithFS(ctx, srcPath, fs)
	if err != nil {
		return err
	}

	var found bool
	for _, t := range c.Tracks {
		if t.ID == trackID && t.Type == mkv.SubtitleTrack {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("subtitle track %d not found", trackID)
	}

	f, err := fs.DoOpen(srcPath)
	if err != nil {
		return err
	}
	defer f.Close()

	br, err := reader.NewBlockReader(f, c.Info.TimecodeScale)
	if err != nil {
		return err
	}

	out, err := fs.DoCreate(outPath)
	if err != nil {
		return err
	}
	defer closeWithErr(out, &err)

	seq := 1
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		blk, err := br.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if blk.TrackNumber != trackID {
			continue
		}

		text := trimNulls(blk.Data)
		if len(text) == 0 {
			continue
		}

		endMs := blk.Timecode + defaultSubDurationMs

		if _, err := fmt.Fprintf(out, "%d\n%s --> %s\n%s\n\n",
			seq,
			subtitle.FormatSRTTime(blk.Timecode),
			subtitle.FormatSRTTime(endMs),
			text,
		); err != nil {
			return fmt.Errorf("write subtitle entry: %w", err)
		}
		seq++
	}
	return nil
}

// ExtractSubtitleWebVTT extracts the subtitle track trackID from the Matroska
// file at srcPath and writes it as WebVTT to w - the head of the work an
// external subtitle-extraction fork does, in-process. Text codecs are decoded by
// kind: S_TEXT/UTF8 (srt) and S_TEXT/WEBVTT pass through, S_TEXT/ASS is flattened
// to plain text. Each cue's end is its BlockDuration, falling back to the next
// cue's start (then a default) when absent. Bitmap subtitles are not supported.
//
// When the file's Cues index references the track (the shape mainstream muxers
// produce), the blocks are read by seeking straight to each cue: a cluster
// whose entries carry a CueRelativePosition is served by direct block jumps
// (nothing before the block is read - not even the media that precedes it), and
// one without is scanned alone. A file whose index does not reference the track
// falls back to the sequential walk, which always yields every block.
// Approach derived from cryguy/mkv-subtitle-extractor (MIT): direct block jumps
// via CueRelativePosition + pure-seek discard of non-target payloads.
func ExtractSubtitleWebVTT(ctx context.Context, srcPath string, trackID uint64, w io.Writer, opts ...mkv.Options) error {
	fs := mkv.FSFrom(opts)
	c, err := reader.OpenWithFS(ctx, srcPath, fs)
	if err != nil {
		return err
	}

	var codec string
	found := false
	for _, t := range c.Tracks {
		if t.ID == trackID && t.Type == mkv.SubtitleTrack {
			codec, found = t.Codec, true
			break
		}
	}
	if !found {
		return fmt.Errorf("subtitle track %d not found", trackID)
	}
	if !isTextSubtitle(codec) {
		return fmt.Errorf("subtitle track %d codec %q is not text (cannot convert to WebVTT)", trackID, codec)
	}

	f, err := fs.DoOpen(srcPath)
	if err != nil {
		return err
	}
	defer f.Close()

	// Preferred path: seek straight to the clusters the Cues index names for
	// this track instead of walking every cluster of the file. Falls back to the
	// sequential walk only when the index does not reference the track at all -
	// a stale position is dropped, and the rest of the plan still drives the
	// seek path. The walk is always correct, the index just makes it cheap.
	if positions, ok := subtitleCuePlan(f, c, trackID); ok {
		return extractSubtitleWebVTTViaCues(ctx, f, c, codec, trackID, positions, w)
	}
	// subtitleCuePlan seeks f while validating positions; the walk starts at 0.
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	br, err := reader.NewBlockReader(f, c.Info.TimecodeScale)
	if err != nil {
		return err
	}
	br.KeepTracks(trackID)

	var cues []subtitle.Cue
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		blk, err := br.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if blk.TrackNumber != trackID {
			continue
		}
		if cue, ok := subtitleCueFromBlock(codec, blk); ok {
			cues = append(cues, cue)
		}
	}
	subtitle.ResolveCueEnds(cues, defaultSubDurationMs)
	return subtitle.WriteWebVTT(w, cues)
}

// cueSeek is one validated seek target of the Cues-driven subtitle extraction.
// clusterPos is Segment-relative (add Container.SegmentStart for the absolute
// offset); relPos is the block's offset from the cluster data start - the
// CueRelativePosition - or 0 when the index carries none; timeMs is the cue's
// timestamp in milliseconds. A direct jump never reads the cluster prefix, so
// the CueTime stands in for the block timecode it would have derived there.
type cueSeek struct {
	clusterPos int64
	relPos     int64
	timeMs     int64
}

// subtitleCuePlan resolves the seek plan for extracting trackID through the
// Cues index: the track's cue points in file order, de-duplicated by the block
// they name (cluster + relative position). ok is false when the index does not
// reference the track, or no named position is a real Cluster element - callers
// then fall back to the sequential walk, which is always correct. Validation is
// per-position: a stale entry (clusterAt failure) is dropped and the rest of
// the plan stays usable - one bad cue must not throw the extraction to a
// whole-file walk. Each CuePoint.ClusterPos is Segment-relative, so the
// absolute seek offset is c.SegmentStart + pos.
func subtitleCuePlan(f mkv.ReadSeekCloser, c *mkv.Container, trackID uint64) (plan []cueSeek, ok bool) {
	scale := c.Info.TimecodeScale
	if scale <= 0 {
		scale = 1_000_000 // malformed source; sane cue timestamps beat zeroed ones
	}
	seen := make(map[[2]int64]bool)
	for _, cue := range c.Cues {
		if cue.Track != trackID || cue.ClusterPos <= 0 {
			continue
		}
		key := [2]int64{cue.ClusterPos, cue.RelativePos}
		if seen[key] {
			continue
		}
		if !clusterAt(f, c.SegmentStart+cue.ClusterPos) {
			continue // stale entry: drop it, keep the rest
		}
		seen[key] = true
		plan = append(plan, cueSeek{
			clusterPos: cue.ClusterPos,
			relPos:     cue.RelativePos,
			timeMs:     cue.TimeMs * scale / 1_000_000,
		})
	}
	if len(plan) == 0 {
		return nil, false
	}
	sort.Slice(plan, func(i, j int) bool {
		if plan[i].clusterPos != plan[j].clusterPos {
			return plan[i].clusterPos < plan[j].clusterPos
		}
		return plan[i].relPos < plan[j].relPos
	})
	return plan, true
}

// clusterAt reports whether a Cluster element starts at the absolute file
// offset off. The Cues name cluster positions; a stale entry pointing elsewhere
// is caught here so the reader never parses a non-cluster element as a cluster.
func clusterAt(r io.ReadSeeker, off int64) bool {
	if _, err := r.Seek(off, io.SeekStart); err != nil {
		return false
	}
	h, _, err := ebml.ReadElementHeader(r)
	return err == nil && h.ID == mkv.IDCluster
}

// extractSubtitleWebVTTViaCues reads only the clusters the cue plan names. A
// cluster whose entries all carry a CueRelativePosition is served by direct
// block jumps (nothing before the block is read); one without is scanned alone,
// bounded to its own bytes - the uncued span to the next cued cluster is never
// walked, and every skipped payload inside a scanned cluster is seeked over,
// never read. A 13 GiB file therefore costs a few hundred ranged reads, not a
// walk of its media.
func extractSubtitleWebVTTViaCues(ctx context.Context, f mkv.ReadSeekCloser, c *mkv.Container, codec string, trackID uint64, plan []cueSeek, w io.Writer) error {
	var cues []subtitle.Cue
	for i := 0; i < len(plan); {
		// Group the entries that name the same cluster. The jump-vs-scan
		// decision is per cluster (cryguy's fallbackClusters rule): all direct
		// jumps or one scan, never a mix - a scan after jumps would deliver the
		// jumped blocks a second time.
		j := i + 1
		for j < len(plan) && plan[j].clusterPos == plan[i].clusterPos {
			j++
		}
		group := plan[i:j]
		if err := extractClusterCues(ctx, f, c, codec, trackID, group, c.SegmentStart+group[0].clusterPos, &cues); err != nil {
			return err
		}
		i = j
	}
	subtitle.ResolveCueEnds(cues, defaultSubDurationMs)
	return subtitle.WriteWebVTT(w, cues)
}

// extractClusterCues delivers the subtitle cues of one cued cluster: direct
// block jumps when every entry carries a valid CueRelativePosition, otherwise
// a single scan of the cluster's own bytes.
func extractClusterCues(ctx context.Context, f mkv.ReadSeekCloser, c *mkv.Container, codec string, trackID uint64, group []cueSeek, clusterAbs int64, out *[]subtitle.Cue) error {
	if allRelPos(group) {
		if dataStart, dataEnd, ok := clusterDataBounds(f, clusterAbs); ok && blockTargetsValid(f, group, dataStart) {
			return extractCuesViaDirectJumps(ctx, f, c, codec, trackID, group, clusterAbs, dataStart, dataEnd, out)
		}
		// A stale relative position falls back to scanning the whole cluster
		// (cryguy's fallbackClusters): the blocks are still in there, the scan
		// is bounded to the cluster's own bytes, and the payloads are seeked.
	}
	return extractCuesViaClusterScan(ctx, f, c, codec, trackID, clusterAbs, out)
}

// allRelPos reports whether every group entry names its block by a
// CueRelativePosition. A cluster is jumped to block-by-block only when all of
// its entries do: a scan after any jump would deliver the jumped blocks twice.
func allRelPos(group []cueSeek) bool {
	for _, e := range group {
		if e.relPos <= 0 {
			return false
		}
	}
	return true
}

// clusterDataBounds reads the Cluster element header at the absolute file
// offset off and returns the start and end of its data - the end is -1 for an
// unknown-size cluster. ok is false when no Cluster starts at off.
func clusterDataBounds(r io.ReadSeeker, off int64) (dataStart, dataEnd int64, ok bool) {
	if _, err := r.Seek(off, io.SeekStart); err != nil {
		return 0, 0, false
	}
	h, n, err := ebml.ReadElementHeader(r)
	if err != nil || h.ID != mkv.IDCluster {
		return 0, 0, false
	}
	dataStart = off + int64(n) // ID + size field
	dataEnd = -1
	if h.Size >= 0 {
		dataEnd = dataStart + h.Size
	}
	return dataStart, dataEnd, true
}

// blockTargetsValid reports whether every group entry's CueRelativePosition
// names a real block element. A stale position pointing at arbitrary bytes
// would otherwise be parsed as an element of whatever size those bytes happen
// to encode - the scan fallback is just as cheap and never mis-parses.
func blockTargetsValid(f mkv.ReadSeekCloser, group []cueSeek, dataStart int64) bool {
	for _, e := range group {
		if !blockAt(f, dataStart+e.relPos) {
			return false
		}
	}
	return true
}

// blockAt reports whether a SimpleBlock or BlockGroup element starts at the
// absolute file offset off - the target of a CueRelativePosition direct jump.
func blockAt(r io.ReadSeeker, off int64) bool {
	if _, err := r.Seek(off, io.SeekStart); err != nil {
		return false
	}
	h, _, err := ebml.ReadElementHeader(r)
	return err == nil && (h.ID == mkv.IDSimpleBlock || h.ID == mkv.IDBlockGroup)
}

// extractCuesViaDirectJumps reads exactly the block each group entry's
// CueRelativePosition names - one element per cue, and nothing before it in the
// cluster: not the cluster Timestamp, not the media blocks that precede the
// subtitle block (cryguy's direct-jump path). The block's timestamp is the
// cue's CueTime - the block's own relative timecode is meaningless without the
// cluster Timestamp this path never reads. A BlockGroup's BlockDuration is
// still read: it carries the subtitle cue's on-screen end.
func extractCuesViaDirectJumps(ctx context.Context, f mkv.ReadSeekCloser, c *mkv.Container, codec string, trackID uint64, group []cueSeek, clusterAbs, dataStart, dataEnd int64, out *[]subtitle.Cue) error {
	for _, e := range group {
		if err := ctx.Err(); err != nil {
			return err
		}
		br, err := reader.NewBlockReaderFrom(f, c.Info.TimecodeScale, reader.BlockPos{
			Off:          dataStart + e.relPos,
			ClusterStart: clusterAbs,
			ClusterEnd:   dataEnd,
			ClusterTS:    0, // unused: the CueTime below replaces the derived timecode
		})
		if err != nil {
			return err
		}
		blk, err := br.Next()
		if errors.Is(err, io.EOF) {
			continue
		}
		if err != nil {
			return err
		}
		if blk.TrackNumber != trackID {
			// The index named a block of another track (stale entry): skip it.
			// The walk is not continued - the cluster's other cues name their
			// own blocks - so nothing past the jump position is read either.
			continue
		}
		blk.Timecode = e.timeMs
		blk.BlockTimecode = e.timeMs
		if cue, ok := subtitleCueFromBlock(codec, blk); ok {
			*out = append(*out, cue)
		}
	}
	return nil
}

// extractCuesViaClusterScan walks exactly the cued cluster, delivering every
// kept block. Other tracks' payloads are seeked over - never read - so the
// walk's cost is the cluster's block-header count, not a byte of media.
// StopAtClusterEnd keeps the walk inside the cluster: the uncued span to the
// next cued cluster is never walked at all.
func extractCuesViaClusterScan(ctx context.Context, f mkv.ReadSeekCloser, c *mkv.Container, codec string, trackID uint64, clusterAbs int64, out *[]subtitle.Cue) error {
	br, err := reader.NewBlockReaderAt(f, c.Info.TimecodeScale, clusterAbs)
	if err != nil {
		return err
	}
	br.KeepTracks(trackID)
	br.SetDiscardAlwaysSeek(true)
	br.StopAtClusterEnd()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		blk, err := br.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if cue, ok := subtitleCueFromBlock(codec, blk); ok {
			*out = append(*out, cue)
		}
	}
}

// subtitleCueFromBlock turns one subtitle block into a WebVTT cue by codec,
// ok=false for empty/gap-filler blocks.
func subtitleCueFromBlock(codec string, blk mkv.Block) (subtitle.Cue, bool) {
	text := decodeSubtitleCue(codec, blk.Data)
	if text == "" {
		return subtitle.Cue{}, false
	}
	end := int64(0)
	if blk.Duration > 0 {
		end = blk.Timecode + blk.Duration
	}
	return subtitle.Cue{StartMs: blk.Timecode, EndMs: end, Text: text}, true
}

// isTextSubtitle reports whether a Matroska subtitle codec short name is a text
// format convertible to WebVTT.
func isTextSubtitle(codec string) bool {
	switch codec {
	case "srt", "ass", "ssa", "webvtt":
		return true
	}
	return false
}

// decodeSubtitleCue turns one subtitle block into WebVTT cue text by codec.
func decodeSubtitleCue(codec string, data []byte) string {
	switch codec {
	case "ass", "ssa":
		return subtitle.FlattenASSBlock(data)
	default: // srt (S_TEXT/UTF8), webvtt (S_TEXT/WEBVTT)
		return trimNulls(data)
	}
}

func MergeSubtitle(ctx context.Context, srcPath, srtPath, dstPath string, lang, name string, opts ...mkv.Options) (err error) {
	entries, err := subtitle.ParseSRT(srtPath)
	if err != nil {
		return fmt.Errorf("parse SRT: %w", err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("SRT file is empty")
	}

	fs := mkv.FSFrom(opts)
	c, err := reader.OpenWithFS(ctx, srcPath, fs)
	if err != nil {
		return err
	}

	newID := uint64(len(c.Tracks) + 1)
	subTrack := mkv.Track{
		ID:       newID,
		Type:     mkv.SubtitleTrack,
		Codec:    "srt",
		Language: lang,
		Name:     name,
	}
	tracks := append(c.Tracks, subTrack)

	subBlocks := make([]mkv.Block, len(entries))
	for i, e := range entries {
		// The cue's end time rides as the BlockDuration (BlockGroup); without it
		// the SRT end times are lost and readers fall back to guessed durations.
		var dur int64
		if e.EndMs > e.StartMs {
			dur = e.EndMs - e.StartMs
		}
		subBlocks[i] = mkv.Block{
			TrackNumber: newID,
			Timecode:    e.StartMs,
			Duration:    dur,
			Data:        []byte(e.Text),
		}
	}

	out, err := fs.DoCreate(dstPath)
	if err != nil {
		return err
	}
	defer closeWithErr(out, &err)

	mw := writer.NewMKVWriter(out)
	if err := mw.WriteStart(); err != nil {
		return err
	}
	// A file with a subtitle track added is not the file it came from: it gets
	// its own derived identity instead of the source's (see derivedSegmentUID).
	// And a cue that outlasts the source is still injected, so the output runs
	// to its end and must say so, exactly as AddTrack does for a longer track -
	// the copied Info.Duration is authoritative, so it has to be cleared.
	meta, durationMs := metaForMergedSubs(c, subBlocks)
	meta.Info.SegmentUID = derivedSegmentUID(&c.Info, srcPath, "merge-subtitle")
	if err := mw.WriteMetadata(&meta, tracks, durationMs); err != nil {
		return err
	}

	if err := streamToWriter(ctx, mw, srcPath, c.Info.TimecodeScale, fs, streamOpts{
		remap: identityRemap(c.Tracks), extraSubs: subBlocks,
		progress: mkv.ProgressFrom(opts),
	}); err != nil {
		return err
	}
	return mw.Finalize()
}

func trimNulls(data []byte) string {
	for len(data) > 0 && data[len(data)-1] == 0 {
		data = data[:len(data)-1]
	}
	return string(data)
}
