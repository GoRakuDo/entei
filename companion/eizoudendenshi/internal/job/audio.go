package job

import (
	"path/filepath"
	"strings"
)

// audioMediaTypeForPath maps the original audio-container extension to the
// HTTP media type the browser uses for the completed passthrough file. The
// extension is produced by yt-dlp's %(ext)s output template; no sniffing or
// transcoding is performed.
func audioMediaTypeForPath(path string) string {
	switch strings.ToLower(strings.TrimPrefix(filepath.Ext(path), ".")) {
	case "m4a":
		return "audio/mp4"
	case "aac":
		return "audio/aac"
	case "opus":
		// YouTube's .opus audio-only files are Ogg Opus containers.
		return "audio/ogg"
	case "webm":
		return "audio/webm"
	case "mp3":
		return "audio/mpeg"
	case "ogg":
		return "audio/ogg"
	default:
		return ""
	}
}
