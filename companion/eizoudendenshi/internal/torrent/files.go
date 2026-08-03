package torrent

import (
	"crypto/sha256"
	"fmt"
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
	KindFolder   = "folder"
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

// TorrentFileInfo converts a TorrentFile (engine interface) to an API
// FileInfo by splitting the path into basename and extension.
func TorrentFileInfo(tf TorrentFile) FileInfo {
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

// FileEntry is a union type for the /files API response. It carries either
// a file (with selection metadata) or a folder (display-only, for navigation).
// The frontend discriminates on the Kind field.
type FileEntry struct {
	// File fields (present when Kind != "folder")
	ID        string `json:"id,omitempty"`
	Extension string `json:"extension,omitempty"`
	ByteSize  int64  `json:"byteSize,omitempty"`

	// Shared fields
	Basename     string `json:"basename"`
	Kind         string `json:"kind"`
	RelativePath string `json:"relativePath,omitempty"` // for files: the safe relative path; for folders: the folder path
}

// folderID computes a deterministic, opaque ID for a folder path. The ID is
// a truncated SHA-256 of the normalized relative path, prefixed with "d" to
// distinguish from file IDs ("f0", "f1", …).
func folderID(relPath string) string {
	h := sha256.Sum256([]byte(relPath))
	// 8 hex chars = 32 bits, plenty for dedup with near-zero collision at
	// typical torrent file counts (< 10K files).
	return fmt.Sprintf("d%x", h[:4])
}

// safeRelativePath normalizes a file's display path to a safe, relative,
// forward-slash-separated path. It rejects absolute paths, ".." traversal,
// and empty paths. The returned path uses "/" separators and is rooted at
// the torrent's top level (no leading "/").
func safeRelativePath(displayPath string) (string, error) {
	// Normalize backslashes to forward slashes.
	p := strings.ReplaceAll(displayPath, "\\", "/")

	// Reject absolute paths.
	if strings.HasPrefix(p, "/") || strings.HasPrefix(p, "\\") {
		return "", fmt.Errorf("absolute path rejected: %s", displayPath)
	}
	// Reject Windows drive-letter paths (e.g. "C:/..." or "C:\\...").
	if len(p) >= 2 && p[1] == ':' && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) {
		return "", fmt.Errorf("absolute path rejected: %s", displayPath)
	}

	// Split and validate each segment.
	segments := strings.Split(p, "/")
	cleaned := make([]string, 0, len(segments))
	for _, seg := range segments {
		if seg == "" || seg == "." {
			continue
		}
		if seg == ".." {
			return "", fmt.Errorf("path traversal rejected: %s", displayPath)
		}
		cleaned = append(cleaned, seg)
	}

	if len(cleaned) == 0 {
		return "", fmt.Errorf("empty path: %s", displayPath)
	}

	return strings.Join(cleaned, "/"), nil
}

// SynthesizeEntries takes the flat file listing from the engine and returns
// a mixed array of FileEntry values suitable for the /files API response —
// folders are FileEntry rows with Kind == KindFolder. Folder rows are
// synthesized deterministically from the file paths: each unique directory
// segment becomes a folder row. File IDs (f0, f1, …) remain unchanged —
// folder IDs use the "d" prefix.
//
// The parentPath parameter selects which directory level to display:
//   - "" (root): show files and folders in the torrent root
//   - "Subs": show files and folders inside "Subs/"
//
// Navigation is frontend-only: the parentPath is never sent to the backend;
// it only filters which entries to return.
func SynthesizeEntries(files []TorrentFile, parentPath string) ([]FileEntry, error) {
	// parentPath == "" is the torrent root: no validation or normalization
	// is needed. Any non-empty path goes through the full safety check
	// (absolute / drive-letter / ".." are rejected, fail closed) and is
	// normalized to "/" separators without a leading slash.
	if parentPath != "" {
		clean, err := safeRelativePath(parentPath)
		if err != nil {
			return nil, err
		}
		parentPath = clean
	}

	seenFolders := make(map[string]bool)
	var entries []FileEntry

	for _, f := range files {
		// Compute the full relative path for this file. Per engine contract:
		// f.RelativePath is the safe full relative path; f.Path is basename only.
		// Prefer RelativePath; fall back to f.Path when empty (flat files).
		// Fail closed: invalid/absolute/traversal paths must never appear in the API response.
		src := f.RelativePath
		if src == "" {
			src = f.Path
		}
		relPath, err := safeRelativePath(src)
		if err != nil {
			return nil, fmt.Errorf("unsafe file path %q: %w", src, err)
		}

		// Determine the file's position within the requested parentPath.
		relativeToParent := relPath
		if parentPath != "" {
			if !strings.HasPrefix(relativeToParent, parentPath+"/") {
				continue // file is not in this directory
			}
			relativeToParent = strings.TrimPrefix(relativeToParent, parentPath+"/")
		}

		// Check if the file is in a subdirectory of the current view.
		parts := strings.SplitN(relativeToParent, "/", 2)
		if len(parts) > 1 {
			// File is in a subdirectory — synthesize a folder entry if not already seen.
			folderRelPath := parts[0]
			fullFolderRelPath := folderRelPath
			if parentPath != "" {
				fullFolderRelPath = parentPath + "/" + folderRelPath
			}
			if !seenFolders[fullFolderRelPath] {
				seenFolders[fullFolderRelPath] = true
				entries = append(entries, FileEntry{
					ID:           folderID(fullFolderRelPath),
					Basename:     folderRelPath,
					RelativePath: fullFolderRelPath,
					Kind:         KindFolder,
				})
			}
			continue // file itself is not shown at this level
		}

		// File is at the current level — add it.
		// f.Path is the basename per engine contract; use it directly.
		ext := ""
		if idx := strings.LastIndexByte(f.Path, '.'); idx >= 0 {
			ext = strings.ToLower(f.Path[idx+1:])
		}
		entries = append(entries, FileEntry{
			ID:           f.ID,
			Basename:     f.Path,
			Extension:    ext,
			ByteSize:     f.Length,
			Kind:         f.Kind,
			RelativePath: relPath,
		})
	}

	return entries, nil
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
