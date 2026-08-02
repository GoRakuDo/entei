package torrent

import (
	"path/filepath"
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
	Basename  string `json:"basename"`  // filepath.Base of the stored name
	Extension string `json:"extension"` // lowercase, no dot
	ByteSize  int64  `json:"byteSize"`
	Kind      string `json:"kind"` // video | audio | subtitle | other
	Index     int    `json:"-"`    // 1-based aria2 --select-file index
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

// metadataFiles builds the sanitized file listing from the parsed torrent
// METADATA (stage 1) — the file list is therefore available before any
// payload bytes are downloaded. Deterministic order (file index).
func metadataFiles(meta *TorrentMetadata) []FileInfo {
	out := make([]FileInfo, 0, len(meta.Files))
	for i, tf := range meta.Files {
		base := tf.Path
		if idx := strings.LastIndexByte(base, '/'); idx >= 0 {
			base = base[idx+1:]
		}
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(base), "."))
		out = append(out, FileInfo{
			ID:        "f" + itoa(i),
			Basename:  base,
			Extension: ext,
			ByteSize:  tf.Length,
			Kind:      classify(ext),
			Index:     tf.Index,
		})
	}
	return out
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
