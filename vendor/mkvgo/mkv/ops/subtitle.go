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
// produce), the blocks are read by seeking straight to each cued cluster - a few
// ranged reads, never a walk over the file's other (often multi-GB) clusters. A
// file whose index does not reference the track, or names a non-cluster
// position, falls back to the sequential walk, which always yields every block.
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
	// sequential walk when the index does not reference the track or a named
	// position is stale - the walk is always correct, the index just makes it
	// cheap.
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

// subtitleCuePlan resolves the seek plan for extracting trackID through the
// Cues index: the track's cue points in file order, de-duplicated. ok is false
// when the index does not reference the track, or any named position is stale
// (not a real Cluster element) - callers then fall back to a sequential walk,
// which is always correct. Each CuePoint.ClusterPos is Segment-relative, so the
// absolute seek offset is c.SegmentStart + pos.
func subtitleCuePlan(f mkv.ReadSeekCloser, c *mkv.Container, trackID uint64) (positions []int64, ok bool) {
	seen := make(map[int64]bool)
	for _, cue := range c.Cues {
		if cue.Track != trackID || cue.ClusterPos <= 0 || seen[cue.ClusterPos] {
			continue
		}
		seen[cue.ClusterPos] = true
		positions = append(positions, cue.ClusterPos)
	}
	if len(positions) == 0 {
		return nil, false
	}
	sort.Slice(positions, func(i, j int) bool { return positions[i] < positions[j] })
	for _, pos := range positions {
		if !clusterAt(f, c.SegmentStart+pos) {
			return nil, false
		}
	}
	return positions, true
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

// extractSubtitleWebVTTViaCues reads only the clusters the cue plan names. Each
// walk starts at a cued cluster and stops the moment it enters the NEXT cued
// cluster (compared by absolute offset), so the span of uncued clusters between
// two cues is walked header-only - KeepTracks skips every other track's payload
// and reads no media that is not the subtitle track's. The last walk runs to
// EOF, picking up any blocks after the final cue.
func extractSubtitleWebVTTViaCues(ctx context.Context, f mkv.ReadSeekCloser, c *mkv.Container, codec string, trackID uint64, positions []int64, w io.Writer) error {
	var cues []subtitle.Cue
	for i, pos := range positions {
		if err := ctx.Err(); err != nil {
			return err
		}
		start := c.SegmentStart + pos
		next := int64(-1)
		if i+1 < len(positions) {
			next = c.SegmentStart + positions[i+1]
		}
		br, err := reader.NewBlockReaderAt(f, c.Info.TimecodeScale, start)
		if err != nil {
			return err
		}
		br.KeepTracks(trackID)
		for {
			blk, err := br.Next()
			if errors.Is(err, io.EOF) {
				break // end of the file
			}
			if err != nil {
				return err
			}
			if next >= 0 && br.ClusterOffset() == next {
				break // entered the next cued cluster: its blocks come from the next seek
			}
			if cue, ok := subtitleCueFromBlock(codec, blk); ok {
				cues = append(cues, cue)
			}
		}
	}
	subtitle.ResolveCueEnds(cues, defaultSubDurationMs)
	return subtitle.WriteWebVTT(w, cues)
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
