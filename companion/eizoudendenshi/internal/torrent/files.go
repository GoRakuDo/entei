package torrent

import (
	"strconv"
	"strings"
)

// File kinds used by the sanitized listing and the one-video + one-subtitle
// selection contract. Kind is derived from the file extension only.
const (
	KindVideo    = "video"
	KindAudio    = "audio"
	KindSubtitle = "subtitle"
	KindOther    = "other"
)

// The exact extension allowlists mirror the Entei Player's native admission
// (apps/web/src/features/player/media-url.ts): video / audio exactly as the
// Player accepts them; subtitle candidates srt/vtt/ass only (no PGS/XML).
var videoExts = map[string]bool{
	"mp4": true, "webm": true, "ogv": true, "ogg": true,
	"mkv": true, "m4v": true, "avi": true,
}

var audioExts = map[string]bool{
	"mp3": true, "wav": true, "flac": true, "aac": true,
	"m4a": true, "opus": true, "m4b": true,
}

var subtitleExts = map[string]bool{
	"srt": true, "vtt": true, "ass": true,
}

// FileInfo is the sanitized, metadata-only view of one torrent file. It
// carries an opaque id and safe display fields — never an absolute path,
// the magnet, or tracker data.
type FileInfo struct {
	ID        string `json:"id"`        // opaque, stable ("f0", "f1", …)
	Basename  string `json:"basename"`  // sanitized basename only
	Extension string `json:"extension"` // lowercase, no dot
	ByteSize  int64  `json:"byteSize"`
	Kind      string `json:"kind"` // video | audio | subtitle | other
}

// classify returns the kind for an extension (lowercase, no dot).
func classify(ext string) string {
	if videoExts[ext] {
		return KindVideo
	}
	if audioExts[ext] {
		return KindAudio
	}
	if subtitleExts[ext] {
		return KindSubtitle
	}
	return KindOther
}

// torrentFileInfo converts a TorrentFile (engine interface) to an API
// FileInfo by splitting the path into basename and extension.
func torrentFileInfo(tf TorrentFile) FileInfo {
	ext := ""
	base := tf.Path
	if idx := strings.LastIndexByte(base, '.'); idx >= 0 {
		ext = strings.ToLower(base[idx+1:])
	}
	return FileInfo{
		ID:        tf.ID,
		Basename:  base,
		Extension: ext,
		ByteSize:  tf.Length,
		Kind:      tf.Kind,
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

// totalBytes sums the sizes of all torrent files in the listing.
func totalBytes(files []FileInfo) int64 {
	var total int64
	for _, f := range files {
		total += f.ByteSize
	}
	return total
}

// mimeForExt maps a torrent file extension to its conservative HTTP media
// type (the streaming and complete serves must never hardcode video/mp4).
var mimeByExt = map[string]string{
	"mp4":  "video/mp4",
	"m4v":  "video/mp4",
	"webm": "video/webm",
	"ogv":  "video/ogg",
	"ogg":  "video/ogg",
	"mkv":  "video/x-matroska",
	"avi":  "video/x-msvideo",
}

func mimeForExt(ext string) string {
	if m, ok := mimeByExt[ext]; ok {
		return m
	}
	return ""
}
