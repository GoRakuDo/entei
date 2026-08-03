package torrent

import (
	"strings"
	"testing"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"
)

// These tests pin the engine contract with the real anacrolix library, so a
// library upgrade can never silently regress the file-browser folder
// hierarchy. They use locally-built torrents only — no network, no magnet,
// no external data.
//
// Contract under test:
//   - multi-file torrent with nested directories → RelativePath keeps the
//     directory prefix ("S01P01/ep01.mkv") so SynthesizeEntries can emit
//     folder rows at the torrent root;
//   - single-file torrent → RelativePath is the plain filename (no folders);
//   - the engine uses DisplayPath(), not Path(): Path() prepends the torrent
//     name, which would synthesize a single "<torrent name>" folder at the
//     root instead of the real directories.

func buildNestedTestInfo(t *testing.T, name string, paths [][]string) *metainfo.Info {
	t.Helper()
	info := &metainfo.Info{
		Name:        name,
		PieceLength: 16384,
	}
	for _, p := range paths {
		info.Files = append(info.Files, metainfo.FileInfo{Length: 1024, Path: p})
	}
	info.Pieces = make([]byte, 20) // single dummy piece hash
	return info
}

func newHandleForInfo(t *testing.T, info *metainfo.Info) *anacrolixHandle {
	t.Helper()
	ib, err := bencode.Marshal(info)
	if err != nil {
		t.Fatalf("marshal info: %v", err)
	}
	cfg := torrent.NewDefaultClientConfig()
	cfg.ListenHost = torrent.LoopbackListenHost
	cfg.ListenPort = 0
	cfg.Seed = false
	cfg.NoUpload = true
	cfg.NoDHT = true
	cfg.DisableUTP = true
	cfg.DataDir = t.TempDir()
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	t.Cleanup(func() { cl.Close() })
	tt, err := cl.AddTorrent(&metainfo.MetaInfo{InfoBytes: ib})
	if err != nil {
		t.Fatalf("add torrent: %v", err)
	}
	<-tt.GotInfo()
	return newAnacrolixHandle(tt)
}

// TestAnacrolixHandleKeepsNestedDirectories: a multi-file torrent whose
// files live in nested directories must keep the directory prefix in
// RelativePath, and SynthesizeEntries must emit the root folder rows
// (S01P01, S01P02) — the exact hierarchy the UI file browser shows.
func TestAnacrolixHandleKeepsNestedDirectories(t *testing.T) {
	h := newHandleForInfo(t, buildNestedTestInfo(t, "NestedShow", [][]string{
		{"S01P01", "ep01.mkv"},
		{"S01P01", "ep02.mkv"},
		{"S01P02", "ep01.mkv"},
		{"readme.txt"},
	}))
	if len(h.Files()) != 4 {
		t.Fatalf("got %d files, want 4", len(h.Files()))
	}
	for _, f := range h.Files() {
		t.Logf("engine: ID=%s Path=%q RelativePath=%q Kind=%s", f.ID, f.Path, f.RelativePath, f.Kind)
	}
	byPath := map[string]string{}
	for _, f := range h.Files() {
		byPath[f.RelativePath] = f.Path
	}
	want := map[string]string{
		"S01P01/ep01.mkv": "ep01.mkv",
		"S01P01/ep02.mkv": "ep02.mkv",
		"S01P02/ep01.mkv": "ep01.mkv",
		"readme.txt":      "readme.txt",
	}
	if len(byPath) != len(want) {
		t.Fatalf("relative paths = %v, want %v", byPath, want)
	}
	for rel, base := range want {
		if byPath[rel] != base {
			t.Errorf("RelativePath %q → Path %q, want %q", rel, byPath[rel], base)
		}
	}

	// Root listing must synthesize S01P01 and S01P02 folder rows; the
	// episode files themselves must NOT appear at the root.
	entries, err := SynthesizeEntries(h.Files(), "")
	if err != nil {
		t.Fatalf("SynthesizeEntries: %v", err)
	}
	var folders []string
	for _, e := range entries {
		t.Logf("api: Kind=%s Basename=%q RelativePath=%q ID=%s", e.Kind, e.Basename, e.RelativePath, e.ID)
		if e.Kind == KindFolder {
			folders = append(folders, e.Basename)
		} else if e.Basename == "ep01.mkv" {
			t.Errorf("episode file leaked to root: %+v", e)
		}
	}
	joined := strings.Join(folders, ",")
	if !strings.Contains(joined, "S01P01") || !strings.Contains(joined, "S01P02") {
		t.Errorf("root folders = %v, want S01P01 and S01P02", folders)
	}
}

// TestAnacrolixHandleSingleFileStaysFlat: a single-file torrent keeps the
// plain filename and never synthesizes folder rows.
func TestAnacrolixHandleSingleFileStaysFlat(t *testing.T) {
	info := &metainfo.Info{
		Name:        "Movie.2026.mkv",
		PieceLength: 16384,
		Length:      1024,
	}
	info.Pieces = make([]byte, 20)
	h := newHandleForInfo(t, info)
	if len(h.Files()) != 1 {
		t.Fatalf("got %d files, want 1", len(h.Files()))
	}
	f := h.Files()[0]
	t.Logf("engine: ID=%s Path=%q RelativePath=%q Kind=%s", f.ID, f.Path, f.RelativePath, f.Kind)
	if f.Path != "Movie.2026.mkv" || f.RelativePath != "Movie.2026.mkv" {
		t.Errorf("single-file: Path=%q RelativePath=%q, want Movie.2026.mkv for both", f.Path, f.RelativePath)
	}
	entries, err := SynthesizeEntries(h.Files(), "")
	if err != nil {
		t.Fatalf("SynthesizeEntries: %v", err)
	}
	for _, e := range entries {
		if e.Kind == KindFolder {
			t.Errorf("single-file torrent must not synthesize folders, got %+v", e)
		}
	}
}

// TestAnacrolixHandlePathCarriesTorrentName documents why the engine uses
// DisplayPath() rather than Path(): Path() prepends the torrent name, which
// would synthesize a single "<torrent name>" folder at the root instead of
// the real directories. DisplayPath() is the multi-file relative path and
// the single-file name — exactly what SynthesizeEntries expects.
func TestAnacrolixHandlePathCarriesTorrentName(t *testing.T) {
	info := buildNestedTestInfo(t, "NestedShow", [][]string{
		{"S01P01", "ep01.mkv"},
	})
	ib, err := bencode.Marshal(info)
	if err != nil {
		t.Fatalf("marshal info: %v", err)
	}
	cfg := torrent.NewDefaultClientConfig()
	cfg.ListenHost = torrent.LoopbackListenHost
	cfg.ListenPort = 0
	cfg.Seed = false
	cfg.NoUpload = true
	cfg.NoDHT = true
	cfg.DisableUTP = true
	cfg.DataDir = t.TempDir()
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	t.Cleanup(func() { cl.Close() })
	tt, err := cl.AddTorrent(&metainfo.MetaInfo{InfoBytes: ib})
	if err != nil {
		t.Fatalf("add torrent: %v", err)
	}
	<-tt.GotInfo()

	for _, f := range tt.Files() {
		t.Logf("anacrolix Path()=%q DisplayPath()=%q", f.Path(), f.DisplayPath())
		if !strings.Contains(f.Path(), "NestedShow") {
			t.Errorf("Path() = %q, want it to carry the torrent name", f.Path())
		}
		if f.DisplayPath() != "S01P01/ep01.mkv" {
			t.Errorf("DisplayPath() = %q, want S01P01/ep01.mkv", f.DisplayPath())
		}
	}
}
