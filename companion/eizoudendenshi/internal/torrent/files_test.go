package torrent

import (
	"strings"
	"testing"
)

func TestTorrentFileInfoSplitsPath(t *testing.T) {
	cases := []struct {
		name string
		in   TorrentFile
		want FileInfo
	}{
		{
			"video mkv",
			TorrentFile{ID: "f0", Path: "Episode 01.mkv", Length: 2_000_000, Kind: KindVideo},
			FileInfo{ID: "f0", Basename: "Episode 01.mkv", Extension: "mkv", ByteSize: 2_000_000, Kind: KindVideo},
		},
		{
			"subtitle ass",
			TorrentFile{ID: "f1", Path: "Episode 01.ass", Length: 40_000, Kind: KindSubtitle},
			FileInfo{ID: "f1", Basename: "Episode 01.ass", Extension: "ass", ByteSize: 40_000, Kind: KindSubtitle},
		},
		{
			"no extension",
			TorrentFile{ID: "f2", Path: "README", Length: 100, Kind: KindOther},
			FileInfo{ID: "f2", Basename: "README", Extension: "", ByteSize: 100, Kind: KindOther},
		},
		{
			"uppercase ext lowercased",
			TorrentFile{ID: "f3", Path: "movie.MKV", Length: 500, Kind: KindVideo},
			FileInfo{ID: "f3", Basename: "movie.MKV", Extension: "mkv", ByteSize: 500, Kind: KindVideo},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := TorrentFileInfo(tc.in)
			if got != tc.want {
				t.Errorf("TorrentFileInfo(%+v) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

// --- safeRelativePath tests ---

func TestSafeRelativePath(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"simple file", "Episode 01.mkv", "Episode 01.mkv", false},
		{"nested path", "Subs/Episode 01.ass", "Subs/Episode 01.ass", false},
		{"deep nesting", "Videos/Season 1/Episode 01.mkv", "Videos/Season 1/Episode 01.mkv", false},
		{"backslash normalized", "Subs\\Episode 01.ass", "Subs/Episode 01.ass", false},
		{"leading slash rejected", "/etc/passwd", "", true},
		{"leading backslash rejected", "\\etc\\passwd", "", true},
		{"dot-dot traversal rejected", "Subs/../etc/passwd", "", true},
		{"dot-dot at start rejected", "../etc/passwd", "", true},
		{"empty segments cleaned", "Subs//Episode 01.mkv", "Subs/Episode 01.mkv", false},
		{"dot segments cleaned", "./Subs/./Episode 01.mkv", "Subs/Episode 01.mkv", false},
		{"empty path rejected", "", "", true},
		{"only dots rejected", "./..", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := safeRelativePath(tc.in)
			if (err != nil) != tc.wantErr {
				t.Errorf("safeRelativePath(%q) error = %v, wantErr %v", tc.in, err, tc.wantErr)
				return
			}
			if got != tc.want {
				t.Errorf("safeRelativePath(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// --- folderID determinism tests ---

func TestFolderIDDeterministic(t *testing.T) {
	id1 := folderID("Subs")
	id2 := folderID("Subs")
	if id1 != id2 {
		t.Errorf("folderID('Subs') = %q != %q", id1, id2)
	}
	if !strings.HasPrefix(id1, "d") {
		t.Errorf("folderID must start with 'd', got %q", id1)
	}
}

func TestFolderIDDifferentPaths(t *testing.T) {
	id1 := folderID("Subs")
	id2 := folderID("Videos")
	if id1 == id2 {
		t.Errorf("folderID('Subs') == folderID('Videos') = %q", id1)
	}
}

// --- SynthesizeEntries tests ---
// Fixtures follow the real engine contract:
//   Path = basename (no directory)
//   RelativePath = full safe relative path with directory

func TestSynthesizeEntriesFlatFiles(t *testing.T) {
	// Flat files at root: RelativePath matches Path (basename only).
	files := []TorrentFile{
		{ID: "f0", Path: "Episode 01.mkv", RelativePath: "Episode 01.mkv", Length: 2_000_000, Kind: KindVideo},
		{ID: "f1", Path: "Episode 01.ass", RelativePath: "Episode 01.ass", Length: 40_000, Kind: KindSubtitle},
		{ID: "f2", Path: "readme.txt", RelativePath: "readme.txt", Length: 100, Kind: KindOther},
	}
	entries, err := SynthesizeEntries(files, "")
	if err != nil {
		t.Fatalf("SynthesizeEntries: %v", err)
	}
	// All files are at root level — no folders.
	if len(entries) != 3 {
		t.Fatalf("got %d entries, want 3", len(entries))
	}
	for _, e := range entries {
		if e.Kind == KindFolder {
			t.Errorf("unexpected folder entry: %v", e)
		}
	}
}

func TestSynthesizeEntriesFlatFallbackToPath(t *testing.T) {
	// Flat files with empty RelativePath: falls back to f.Path (basename).
	files := []TorrentFile{
		{ID: "f0", Path: "Episode 01.mkv", Length: 2_000_000, Kind: KindVideo},
		{ID: "f1", Path: "Episode 01.ass", Length: 40_000, Kind: KindSubtitle},
	}
	entries, err := SynthesizeEntries(files, "")
	if err != nil {
		t.Fatalf("SynthesizeEntries: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(entries))
	}
	for _, e := range entries {
		if e.Kind == KindFolder {
			t.Errorf("unexpected folder entry in flat fallback: %v", e)
		}
	}
}

func TestSynthesizeEntriesNestedPaths(t *testing.T) {
	// Engine contract: Path=basename, RelativePath=full path.
	files := []TorrentFile{
		{ID: "f0", Path: "Episode 01.mkv", RelativePath: "Episode 01.mkv", Length: 2_000_000, Kind: KindVideo},
		{ID: "f1", Path: "Episode 01.ass", RelativePath: "Subs/Episode 01.ass", Length: 40_000, Kind: KindSubtitle},
		{ID: "f2", Path: "Episode 01.srt", RelativePath: "Subs/Episode 01.srt", Length: 30_000, Kind: KindSubtitle},
	}
	entries, err := SynthesizeEntries(files, "")
	if err != nil {
		t.Fatalf("SynthesizeEntries: %v", err)
	}
	// Root level: 1 file (Episode 01.mkv) + 1 folder (Subs).
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2: %+v", len(entries), entries)
	}
	var folderCount, fileCount int
	for _, e := range entries {
		if e.Kind == KindFolder {
			folderCount++
			if e.Basename != "Subs" {
				t.Errorf("folder basename = %q, want 'Subs'", e.Basename)
			}
			if e.RelativePath != "Subs" {
				t.Errorf("folder relativePath = %q, want 'Subs'", e.RelativePath)
			}
		} else {
			fileCount++
		}
	}
	if folderCount != 1 {
		t.Errorf("got %d folders, want 1", folderCount)
	}
	if fileCount != 1 {
		t.Errorf("got %d files, want 1", fileCount)
	}
}

func TestSynthesizeEntriesNavigateIntoFolder(t *testing.T) {
	files := []TorrentFile{
		{ID: "f0", Path: "Episode 01.mkv", RelativePath: "Episode 01.mkv", Length: 2_000_000, Kind: KindVideo},
		{ID: "f1", Path: "Episode 01.ass", RelativePath: "Subs/Episode 01.ass", Length: 40_000, Kind: KindSubtitle},
		{ID: "f2", Path: "Episode 01.srt", RelativePath: "Subs/Episode 01.srt", Length: 30_000, Kind: KindSubtitle},
	}
	entries, err := SynthesizeEntries(files, "Subs")
	if err != nil {
		t.Fatalf("SynthesizeEntries: %v", err)
	}
	// Inside Subs: 2 files, no folders.
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2: %+v", len(entries), entries)
	}
	for _, e := range entries {
		if e.Kind == KindFolder {
			t.Errorf("unexpected folder entry inside Subs: %v", e)
		}
	}
}

func TestSynthesizeEntriesNavigateParentBack(t *testing.T) {
	// Verify navigating back from Subs/ to root returns root-level entries.
	files := []TorrentFile{
		{ID: "f0", Path: "Episode 01.mkv", RelativePath: "Episode 01.mkv", Length: 2_000_000, Kind: KindVideo},
		{ID: "f1", Path: "Episode 01.ass", RelativePath: "Subs/Episode 01.ass", Length: 40_000, Kind: KindSubtitle},
	}
	// Navigate into Subs: 1 file (Episode 01.ass).
	entries, err := SynthesizeEntries(files, "Subs")
	if err != nil {
		t.Fatalf("SynthesizeEntries(Subs): %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("Subs got %d entries, want 1", len(entries))
	}
	// Navigate back to root: 1 file + 1 folder.
	entries, err = SynthesizeEntries(files, "")
	if err != nil {
		t.Fatalf("SynthesizeEntries(root): %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("root got %d entries, want 2: %+v", len(entries), entries)
	}
}

func TestSynthesizeEntriesFolderDeduplication(t *testing.T) {
	files := []TorrentFile{
		{ID: "f0", Path: "Episode 01.ass", RelativePath: "Subs/Episode 01.ass", Length: 40_000, Kind: KindSubtitle},
		{ID: "f1", Path: "Episode 01.srt", RelativePath: "Subs/Episode 01.srt", Length: 30_000, Kind: KindSubtitle},
		{ID: "f2", Path: "Episode 02.ass", RelativePath: "Subs/Episode 02.ass", Length: 40_000, Kind: KindSubtitle},
	}
	entries, err := SynthesizeEntries(files, "")
	if err != nil {
		t.Fatalf("SynthesizeEntries: %v", err)
	}
	// Only one "Subs" folder despite 3 files in it.
	folderCount := 0
	for _, e := range entries {
		if e.Kind == KindFolder {
			folderCount++
		}
	}
	if folderCount != 1 {
		t.Errorf("got %d folders, want 1 (deduplication failed)", folderCount)
	}
}

func TestSynthesizeEntriesFileIDsUnchanged(t *testing.T) {
	files := []TorrentFile{
		{ID: "f0", Path: "Episode 01.mkv", RelativePath: "Episode 01.mkv", Length: 2_000_000, Kind: KindVideo},
		{ID: "f1", Path: "Episode 01.ass", RelativePath: "Subs/Episode 01.ass", Length: 40_000, Kind: KindSubtitle},
	}
	entries, err := SynthesizeEntries(files, "")
	if err != nil {
		t.Fatalf("SynthesizeEntries: %v", err)
	}
	for _, e := range entries {
		if e.Kind != KindFolder && e.ID == "" {
			t.Errorf("file entry missing ID: %v", e)
		}
		if e.Kind == KindFolder && !strings.HasPrefix(e.ID, "d") {
			t.Errorf("folder ID must start with 'd', got %q", e.ID)
		}
	}
}

func TestSynthesizeEntriesInvalidParentPath(t *testing.T) {
	files := []TorrentFile{
		{ID: "f0", Path: "Episode 01.mkv", RelativePath: "Episode 01.mkv", Length: 2_000_000, Kind: KindVideo},
	}
	_, err := SynthesizeEntries(files, "../etc")
	if err == nil {
		t.Error("expected error for parentPath with traversal")
	}
}

func TestSynthesizeEntriesNestedFolders(t *testing.T) {
	files := []TorrentFile{
		{ID: "f0", Path: "Episode 01.mkv", RelativePath: "Videos/Season 1/Episode 01.mkv", Length: 2_000_000, Kind: KindVideo},
		{ID: "f1", Path: "Episode 01.ass", RelativePath: "Videos/Season 1/Subs/Episode 01.ass", Length: 40_000, Kind: KindSubtitle},
	}
	entries, err := SynthesizeEntries(files, "")
	if err != nil {
		t.Fatalf("SynthesizeEntries: %v", err)
	}
	// Root: 1 folder (Videos).
	if len(entries) != 1 {
		t.Fatalf("root got %d entries, want 1: %+v", len(entries), entries)
	}
	if entries[0].Kind != KindFolder || entries[0].Basename != "Videos" {
		t.Errorf("root entry = %+v, want Videos folder", entries[0])
	}

	// Navigate into Videos.
	entries, err = SynthesizeEntries(files, "Videos")
	if err != nil {
		t.Fatalf("SynthesizeEntries(Videos): %v", err)
	}
	// Videos: 1 folder (Season 1).
	if len(entries) != 1 {
		t.Fatalf("Videos got %d entries, want 1: %+v", len(entries), entries)
	}
	if entries[0].Kind != KindFolder || entries[0].Basename != "Season 1" {
		t.Errorf("Videos entry = %+v, want Season 1 folder", entries[0])
	}

	// Navigate into Videos/Season 1.
	entries, err = SynthesizeEntries(files, "Videos/Season 1")
	if err != nil {
		t.Fatalf("SynthesizeEntries(Videos/Season 1): %v", err)
	}
	// Season 1: 1 file + 1 folder (Subs).
	if len(entries) != 2 {
		t.Fatalf("Season 1 got %d entries, want 2: %+v", len(entries), entries)
	}
}

func TestSynthesizeEntriesBackslashPaths(t *testing.T) {
	// Engine contract: RelativePath uses forward slashes after normalization.
	// Path is always basename. Test that backslash in RelativePath is normalized.
	files := []TorrentFile{
		{ID: "f0", Path: "Episode 01.ass", RelativePath: "Subs\\Episode 01.ass", Length: 40_000, Kind: KindSubtitle},
	}
	entries, err := SynthesizeEntries(files, "")
	if err != nil {
		t.Fatalf("SynthesizeEntries: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	if entries[0].Kind != KindFolder || entries[0].Basename != "Subs" {
		t.Errorf("entry = %+v, want Subs folder", entries[0])
	}
}

// TestSynthesizeEntriesFailClosedOnUnsafePath verifies that SynthesizeEntries
// returns an error (fail-closed) when a file has an absolute or traversal path,
// rather than silently falling back to a raw path that could leak to the API.
func TestSynthesizeEntriesFailClosedOnUnsafePath(t *testing.T) {
	cases := []struct {
		name string
		path string
	}{
		{"absolute unix path", "/etc/passwd"},
		{"absolute windows path", "C:\\Windows\\System32\\file.mkv"},
		{"traversal path", "../../etc/passwd"},
		{"dot-dot in middle", "Subs/../../etc/passwd"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := []TorrentFile{
				{ID: "f0", Path: "file.mkv", RelativePath: tc.path, Length: 100, Kind: KindOther},
			}
			_, err := SynthesizeEntries(files, "")
			if err == nil {
				t.Errorf("SynthesizeEntries with path %q: expected error, got nil", tc.path)
			}
		})
	}
}
