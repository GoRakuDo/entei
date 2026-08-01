package job

import (
	"path/filepath"
)

// fixedFormat is the deterministic, fixed 1080p-cap format selection passed
// to the download helper. It is a code constant — never user-controlled,
// never configurable from a request. Semantics (yt-dlp format syntax):
// best video ≤1080p + best audio (merged), fallback best ≤1080p combined,
// fallback best.
const fixedFormat = "bv*[height<=1080]+ba/b[height<=1080]/b"

// helperArgs builds the fixed argument vector for the download helper.
// The validated URL is the final element and the only user-derived value;
// it is never interpolated into a flag. No shell is involved — the helper
// path and these args are passed directly to exec.Command.
//
// The -o template resolves inside the job's private temp directory, so a
// malicious URL can never make the helper write outside it.
func helperArgs(jobDir, url string) []string {
	return []string{
		"--no-playlist",        // deterministic single video
		"--no-part",            // write directly to the output file (progress observable)
		"--no-progress",        // keep helper output quiet
		"--no-write-info-json", // no sidecar files
		"--no-write-thumbnail", // media bytes only
		"-f", fixedFormat,      // fixed 1080p-cap deterministic selection
		"-o", filepath.Join(jobDir, "media.%(ext)s"),
		url, // only user-derived value; separate argv element
	}
}
