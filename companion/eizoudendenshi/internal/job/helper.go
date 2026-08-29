package job

import (
	"path/filepath"
)

// Format selection constants (docs/EIZOU_DENDENSHI.md "YouTube 再生モード設定"):
//
// qualityFormat — DASH 1080p cap, plays after mux completes. This is the
// historical fixed selector: best video ≤1080p + best audio (merged),
// fallback best ≤1080p combined, fallback best.
const qualityFormat = "bv*[height<=1080]+ba/b[height<=1080]/b"

// speedFormat — progressive-first with DASH fallback. `b` is yt-dlp's
// "best format that contains BOTH video and audio" selector (e.g. YouTube
// 22/18/37) that can be streamed from byte 0 while still downloading.
// When YouTube offers no progressive format (modern 1080p/4K-only uploads
// where only separate video+audio exist), falls back to DASH-1080p+audio
// so the video downloads and plays rather than failing with "Requested format is not available".
const speedFormat = "b/bv*[height<=1080]+ba/b[height<=1080]/b"

// heightPrintTemplate writes the selected format's height (e.g. "720") to a
// sidecar file so the companion can report the actual resolution for the
// quality toast (docs: "選択された画質とモード"). `--print-to-file` runs
// after format selection, before download begins.
const heightPrintTemplate = "%(height)s"

// titlePrintTemplate writes the video title to a sidecar file so the
// companion can surface the YouTube video title as the media display name
// (docs/EIZOU_DENDENSHI.md — tracker shows the file name for torrents and
// the video title for YouTube). Written early (per-video) before download.
const titlePrintTemplate = "%(title)s"

// totalPrintTemplate writes the estimated final media size (bytes) to a
// sidecar file so the companion can pin the .part stream's total at
// download start (speed mode instant playback): a fixed total makes the
// HTTP layer answer 416 only for ranges that are permanently beyond the
// file, while a merely-not-yet-downloaded prefix keeps long-polling.
// yt-dlp prints "NA" when the size cannot be estimated; the manager treats
// that (and unparseable input) as unpinned.
const totalPrintTemplate = "%(filesize_approx)s"

// helperArgs builds the fixed argument vector for the download helper.
// The validated URL is the final element and the only user-derived value;
// it is never interpolated into a flag. No shell is involved — the helper
// path and these args are passed directly to exec.Command.
//
// Mode differences:
//   - quality: DASH selector + --no-part (final file written directly;
//     completion = full file present).
//   - speed: progressive selector, NO --no-part → yt-dlp writes
//     media.<ext>.part and renames it on completion; the .part file is
//     served while it grows (instant playback).
//
// Both modes write the selected height to height.txt for the toast.
//
// The -o template resolves inside the job's private temp directory, so a
// malicious URL can never make the helper write outside it.
func helperArgs(jobDir, url string, mode Mode) []string {
	format := qualityFormat
	noPart := "--no-part"
	if mode == ModeSpeed {
		format = speedFormat
		noPart = "" // keep .part so the growing file can be streamed
	}
	args := []string{
		"--no-playlist",                              // deterministic single video
		"--no-progress",                              // keep helper output quiet
		"--no-write-info-json",                       // no sidecar files
		"--no-write-thumbnail",                       // media bytes only
		"--write-subs",                               // download subtitles (manual preferred)
		"--write-auto-subs",                          // download auto-generated subtitles (fallback)
		"--sub-langs", "ja,ja-orig,ja-JP,ja-Hrkt",    // Japanese subtitles only (avoids ja-en/ja-es auto-translation 429 errors)
		"--sub-format", "vtt",                        // deterministic format
		"--extractor-args", "youtube:player_client=mweb,android,web", // robust clients to bypass 403 Forbidden
	}
	if noPart != "" {
		args = append(args, noPart)
	}
	args = append(args,
		"-f", format,
		"--print-to-file", heightPrintTemplate, filepath.Join(jobDir, "height.txt"),
		"--print-to-file", titlePrintTemplate, filepath.Join(jobDir, "title.txt"),
		"--print-to-file", totalPrintTemplate, filepath.Join(jobDir, "total.txt"),
		"-o", filepath.Join(jobDir, "media.%(ext)s"),
		url,
	)
	return args
}
