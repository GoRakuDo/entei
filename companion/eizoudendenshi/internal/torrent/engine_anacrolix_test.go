package torrent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"
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

// TestIsV2Only pins the v2-only rejection predicate (BEP 52): only
// metainfo with MetaVersion 2 and no v1 component is rejected. Hybrid
// (v1+v2) and plain v1 torrents must pass through — the engine supports
// them through their v1 hash set.
func TestIsV2Only(t *testing.T) {
	cases := []struct {
		name string
		info *metainfo.Info
		want bool
	}{
		{
			name: "v2-only",
			info: &metainfo.Info{Name: "v2.mkv", MetaVersion: 2},
			want: true,
		},
		{
			name: "hybrid v1+v2",
			info: &metainfo.Info{
				Name:        "hybrid.mkv",
				MetaVersion: 2,
				Length:      1024,
				Pieces:      make([]byte, 20),
			},
			want: false,
		},
		{
			name: "v1 multi-file",
			info: &metainfo.Info{
				Name:   "v1.mkv",
				Files:  []metainfo.FileInfo{{Length: 1024, Path: []string{"a.mkv"}}},
				Pieces: make([]byte, 20),
			},
			want: false,
		},
		{
			name: "v1 single-file",
			info: &metainfo.Info{Name: "v1.mkv", Length: 1024, Pieces: make([]byte, 20)},
			want: false,
		},
		{
			name: "nil info",
			info: nil,
			want: false,
		},
	}
	for _, c := range cases {
		if got := isV2Only(c.info); got != c.want {
			t.Errorf("%s: isV2Only = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestSelectRefreshesHeadCompletionFromStorage pins the selection-time
// completion refresh: Select must call Piece.UpdateCompletion() for the
// bounded head window, so a piece whose completion is already recorded in
// storage (verified previously, initial hash delayed) becomes
// storageCompletionOk immediately — the head is never stuck at
// effectivePriority None. Pieces OUTSIDE the head window must not be
// touched (no per-piece boltDB views across the whole torrent).
func TestSelectRefreshesHeadCompletionFromStorage(t *testing.T) {
	dir := t.TempDir()
	pc, err := storage.NewBoltPieceCompletion(dir)
	if err != nil {
		t.Fatalf("bolt piece completion: %v", err)
	}
	ci := storage.NewFileWithCompletion(dir, pc)
	// Close order matters: the client must close before the shared
	// completion store (bolt) or its teardown writes hit a closed DB.
	t.Cleanup(func() { _ = ci.Close() })
	t.Cleanup(func() { _ = pc.Close() })

	// 300 pieces of 16 KiB: the 4 MiB head window covers pieces [0, 256),
	// pieces 256..299 are outside it.
	const (
		pieceLength   = 16384
		numPieces     = 300
		headPieceLast = 256 // first index outside the window
	)
	info := &metainfo.Info{
		Name:        "headfix.mkv",
		PieceLength: pieceLength,
		Length:      numPieces * pieceLength,
	}
	info.Pieces = make([]byte, numPieces*20)
	ib, err := bencode.Marshal(info)
	if err != nil {
		t.Fatalf("marshal info: %v", err)
	}

	cfg := torrent.NewDefaultClientConfig()
	cfg.DefaultStorage = ci
	cfg.DataDir = dir
	cfg.ListenHost = torrent.LoopbackListenHost
	cfg.ListenPort = 0
	cfg.Seed = false
	cfg.NoUpload = true
	cfg.NoDHT = true
	cfg.DisableUTP = true
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	t.Cleanup(func() { cl.Close() })
	// Model the delayed-initial-hash scenario the refresh defends against:
	// with the initial piece check disabled for this torrent, pieces whose
	// completion is recorded in storage stay storageCompletionOk=false in
	// memory until something re-reads the store (anacrolix's own tests use
	// the same option for deterministic piece state).
	mi := &metainfo.MetaInfo{InfoBytes: ib}
	tt, new := cl.AddTorrentOpt(torrent.AddTorrentOpts{
		InfoHash:                 mi.HashInfoBytes(),
		InfoBytes:                ib,
		DisableInitialPieceCheck: true,
	})
	if !new {
		t.Fatal("torrent must be new")
	}
	<-tt.GotInfo()
	h := newAnacrolixHandle(tt)

	// Fresh store: no piece is complete until the store says so.
	if st := tt.Piece(0).State(); st.Ok {
		t.Fatal("piece 0 must start incomplete (fresh storage)")
	}

	// The completion store is only trusted when the on-disk data
	// corroborates it (anacrolix checks file sizes when a piece is marked
	// complete): write the full file so marked pieces pass the size check.
	data := make([]byte, numPieces*pieceLength)
	if err := os.WriteFile(filepath.Join(dir, "headfix.mkv"), data, 0o600); err != nil {
		t.Fatalf("write data file: %v", err)
	}

	// Record pieces 0 and 255 (inside the head window) and piece 299
	// (outside) as complete in the completion store, then Select — the
	// refresh must pick up the head pieces only.
	ih := tt.InfoHash()
	for _, idx := range []int{0, headPieceLast - 1} {
		if err := pc.Set(metainfo.PieceKey{InfoHash: ih, Index: idx}, true); err != nil {
			t.Fatalf("set piece %d complete: %v", idx, err)
		}
	}
	if err := pc.Set(metainfo.PieceKey{InfoHash: ih, Index: numPieces - 1}, true); err != nil {
		t.Fatalf("set piece %d complete: %v", numPieces-1, err)
	}

	if err := h.Select("f0", ""); err != nil {
		t.Fatalf("Select: %v", err)
	}

	// The head piece is refreshed from storage: storageCompletionOk + the
	// completed bitmap both reflect the store now.
	if st := tt.Piece(0).State(); !st.Ok || !st.Complete {
		t.Errorf("head piece 0 after Select: state=%+v, want Ok+Complete (UpdateCompletion refresh)", st)
	}
	// A piece inside the window but marked complete in the store must be
	// refreshed too.
	if st := tt.Piece(255).State(); !st.Ok || !st.Complete {
		t.Errorf("head piece 255 after Select: state=%+v, want Ok+Complete (UpdateCompletion refresh)", st)
	}
	// The negative control: piece 299 is outside the head window and was
	// never refreshed — its in-memory state must stay incomplete even
	// though the store marks it complete.
	if st := tt.Piece(numPieces - 1).State(); st.Ok {
		t.Errorf("piece %d outside the head window must not be refreshed: state=%+v", numPieces-1, st)
	}
}
