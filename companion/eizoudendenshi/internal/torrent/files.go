package torrent

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
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

// scanTorrentFiles walks the private job dir recursively and returns a
// sanitized, deterministically-ordered file listing. The internal helper
// stderr log is never part of the torrent's files.
func scanTorrentFiles(dir string) ([]FileInfo, error) {
	var rel []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries; never fail the listing on one
		}
		if d.IsDir() {
			return nil
		}
		if d.Name() == "helper.stderr.log" {
			return nil
		}
		rel = append(rel, p)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(rel, func(i, j int) bool { return rel[i] < rel[j] })
	out := make([]FileInfo, 0, len(rel))
	for i, p := range rel {
		base := filepath.Base(p)
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(base), "."))
		st, err := fileInfoSize(p)
		if err != nil {
			continue
		}
		out = append(out, FileInfo{
			ID:        "f" + itoa(i),
			Basename:  base,
			Extension: ext,
			ByteSize:  st,
			Kind:      classify(ext),
		})
	}
	return out, nil
}

func itoa(n int) string { return strconv.Itoa(n) }

func fileInfoSize(p string) (int64, error) {
	st, err := os.Stat(p)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

// totalBytes sums the sizes of all torrent files in the listing.
func totalBytes(files []FileInfo) int64 {
	var total int64
	for _, f := range files {
		total += f.ByteSize
	}
	return total
}
