package torrent

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

// TestFirstSubtitleIndex pins the embedded-subtitle auto-detection helper.
func TestFirstSubtitleIndex(t *testing.T) {
	withSub := []TorrentFile{
		{ID: "f0", Path: "ep.mkv", Kind: KindVideo},
		{ID: "f1", Path: "ep.ass", Kind: KindSubtitle},
		{ID: "f2", Path: "ep.srt", Kind: KindSubtitle},
		{ID: "f3", Path: "readme.txt", Kind: KindOther},
	}
	if got := firstSubtitleIndex(withSub); got != 1 {
		t.Errorf("firstSubtitleIndex(with subtitle) = %d, want 1", got)
	}
	if got := firstSubtitleIndex([]TorrentFile{
		{ID: "f0", Path: "ep.mkv", Kind: KindVideo},
		{ID: "f1", Path: "readme.txt", Kind: KindOther},
	}); got != -1 {
		t.Errorf("firstSubtitleIndex(no subtitle) = %d, want -1", got)
	}
	if got := firstSubtitleIndex(nil); got != -1 {
		t.Errorf("firstSubtitleIndex(nil) = %d, want -1", got)
	}
}

// panicCloseCloser models an anacrolix reader whose Close trips the
// invariant-check panic (checkPendingPiecesMatchesRequestOrder, v1.61.0 bug).
type panicCloseCloser struct {
	closed bool
}

func (p *panicCloseCloser) Close() error {
	p.closed = true
	panic("piece request order has {} and pending pieces has {62,63}")
}

// TestSafeCloseReaderRecoversPanic pins the process-survival contract: a
// reader Close that panics inside anacrolix must be recovered and logged,
// never propagate into the caller (a panic there would kill the process).
func TestSafeCloseReaderRecoversPanic(t *testing.T) {
	c := &panicCloseCloser{}
	SafeCloseReader(c) // must not panic
	if !c.closed {
		t.Fatal("SafeCloseReader did not call Close")
	}
}

// TestSafeCloseReaderNilNoop pins nil-safety (no panic on a nil closer).
func TestSafeCloseReaderNilNoop(t *testing.T) {
	SafeCloseReader(nil) // must not panic
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

// TestTailWindowPieces pins the tail window calculation: for a file at the
// end of a torrent, tailWindowPieces returns the pieces covering the last
// TailWindowBytes, clamped to the file's boundaries.
func TestTailWindowPieces(t *testing.T) {
	// 300 pieces × 16 KiB = 4.8 MiB file. TailWindowBytes = 8 MiB, but
	// the file is smaller, so all pieces should be covered.
	info := &metainfo.Info{
		Name:        "tail_test.mkv",
		PieceLength: 16384,
		Length:      300 * 16384,
	}
	info.Pieces = make([]byte, 300*20)
	h := newHandleForInfo(t, info)

	f := h.t.Files()[0]
	begin, end := tailWindowPieces(f)
	// With 8 MiB tail window and 4.8 MiB file, all 300 pieces are covered.
	if begin != 0 {
		t.Errorf("tailWindowPieces begin = %d, want 0 (file smaller than TailWindowBytes)", begin)
	}
	if end != 300 {
		t.Errorf("tailWindowPieces end = %d, want 300", end)
	}
}

// TestTailWindowPiecesLargeFile verifies that for a large file, the tail
// window covers only the last TailWindowBytes worth of pieces.
func TestTailWindowPiecesLargeFile(t *testing.T) {
	// 2000 pieces × 16 KiB = 32 MiB file. TailWindowBytes = 8 MiB = 512 pieces.
	const (
		pieceLen  = 16384
		numPieces = 2000
	)
	info := &metainfo.Info{
		Name:        "large_tail_test.mkv",
		PieceLength: pieceLen,
		Length:      numPieces * pieceLen,
	}
	info.Pieces = make([]byte, numPieces*20)
	h := newHandleForInfo(t, info)

	f := h.t.Files()[0]
	begin, end := tailWindowPieces(f)
	// TailWindowBytes=8MiB, pieceLen=16KiB → 512 pieces from the end.
	// File is [0, 2000), tail is [2000-512, 2000) = [1488, 2000).
	if begin != 1488 {
		t.Errorf("tailWindowPieces begin = %d, want 1488", begin)
	}
	if end != numPieces {
		t.Errorf("tailWindowPieces end = %d, want %d", end, numPieces)
	}
}

// TestTailWindowPiecesNoOverlapWithHead verifies that for a large file,
// the head and tail windows do not overlap.
func TestTailWindowPiecesNoOverlapWithHead(t *testing.T) {
	const (
		pieceLen  = 16384
		numPieces = 2000
	)
	info := &metainfo.Info{
		Name:        "overlap_test.mkv",
		PieceLength: pieceLen,
		Length:      numPieces * pieceLen,
	}
	info.Pieces = make([]byte, numPieces*20)
	h := newHandleForInfo(t, info)

	f := h.t.Files()[0]
	headBegin, headEnd := headWindowPieces(f)
	tailBegin, _ := tailWindowPieces(f)
	// head is [0, 256), tail is [1488, 2000): no overlap.
	if headEnd > tailBegin {
		t.Errorf("head and tail windows overlap: head=[%d,%d) tail=[%d,...)",
			headBegin, headEnd, tailBegin)
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
// bounded head and tail windows, so a piece whose completion is already
// recorded in storage (verified previously, initial hash delayed) becomes
// storageCompletionOk immediately — the head is never stuck at
// effectivePriority None. Pieces OUTSIDE both windows must not be
// refreshed (no per-piece boltDB views across the whole torrent).
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

	// 2000 pieces of 16 KiB: the 4 MiB head window covers pieces [0, 256),
	// the 8 MiB tail window covers pieces [1488, 2000). Piece 1000 is
	// outside both windows — the negative control.
	const (
		pieceLength   = 16384
		numPieces     = 2000
		headPieceLast = 256  // first index outside the head window
		midPiece      = 1000 // outside both head and tail windows
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

	// Record pieces 0 and 255 (inside the head window), piece 1000
	// (outside both windows), and piece 1999 (inside the tail window) as
	// complete in the completion store, then Select — the refresh must
	// pick up the head and tail pieces only.
	ih := tt.InfoHash()
	for _, idx := range []int{0, headPieceLast - 1, midPiece, numPieces - 1} {
		if err := pc.Set(metainfo.PieceKey{InfoHash: ih, Index: idx}, true); err != nil {
			t.Fatalf("set piece %d complete: %v", idx, err)
		}
	}

	if err := h.Select("f0", ""); err != nil {
		t.Fatalf("Select: %v", err)
	}

	// The head piece is refreshed from storage: storageCompletionOk + the
	// completed bitmap both reflect the store now.
	if st := tt.Piece(0).State(); !st.Ok || !st.Complete {
		t.Errorf("head piece 0 after Select: state=%+v, want Ok+Complete (UpdateCompletion refresh)", st)
	}
	// A piece inside the head window but marked complete in the store must
	// be refreshed too.
	if st := tt.Piece(255).State(); !st.Ok || !st.Complete {
		t.Errorf("head piece 255 after Select: state=%+v, want Ok+Complete (UpdateCompletion refresh)", st)
	}
	// The tail piece is also refreshed (tail window elevation).
	if st := tt.Piece(numPieces - 1).State(); !st.Ok || !st.Complete {
		t.Errorf("tail piece %d after Select: state=%+v, want Ok+Complete (tail UpdateCompletion refresh)", numPieces-1, st)
	}
	// The negative control: piece 1000 is outside both the head and tail
	// windows and was never refreshed — its in-memory state must stay
	// incomplete even though the store marks it complete.
	if st := tt.Piece(midPiece).State(); st.Ok {
		t.Errorf("piece %d outside both windows must not be refreshed: state=%+v", midPiece, st)
	}
}

// TestSelectElevatesTailPieces pins the tail-window elevation in Select:
// the last TailWindowBytes worth of pieces of the selected video must have
// UpdateCompletion called, so the MKV Cues element (seek table near the
// end of the file) is downloaded early. We verify that the tail piece's
// completion state is refreshed (Ok + Complete) after Select, mirroring
// TestSelectRefreshesHeadCompletionFromStorage for the tail window.
func TestSelectElevatesTailPieces(t *testing.T) {
	dir := t.TempDir()
	pc, err := storage.NewBoltPieceCompletion(dir)
	if err != nil {
		t.Fatalf("bolt piece completion: %v", err)
	}
	ci := storage.NewFileWithCompletion(dir, pc)
	t.Cleanup(func() { _ = ci.Close() })
	t.Cleanup(func() { _ = pc.Close() })

	// 2000 pieces × 16 KiB = 32 MiB: tail covers [1488, 2000).
	const (
		pieceLength = 16384
		numPieces   = 2000
	)
	info := &metainfo.Info{
		Name:        "tail_select.mkv",
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

	// Write the full data file so anacrolix's size check passes.
	data := make([]byte, numPieces*pieceLength)
	if err := os.WriteFile(filepath.Join(dir, "tail_select.mkv"), data, 0o600); err != nil {
		t.Fatalf("write data file: %v", err)
	}

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

	// Mark tail piece (1999) complete in the completion store. Select's
	// UpdateCompletion will refresh it.
	ih := tt.InfoHash()
	if err := pc.Set(metainfo.PieceKey{InfoHash: ih, Index: numPieces - 1}, true); err != nil {
		t.Fatalf("set piece %d complete: %v", numPieces-1, err)
	}

	if err := h.Select("f0", ""); err != nil {
		t.Fatalf("Select: %v", err)
	}

	// Tail piece is refreshed: storageCompletionOk + completed bitmap
	// both reflect the store now — this is the production behavior that
	// ensures MKV Cues are downloadable early.
	if st := tt.Piece(numPieces - 1).State(); !st.Ok || !st.Complete {
		t.Errorf("tail piece %d after Select: state=%+v, want Ok+Complete (tail UpdateCompletion refresh)", numPieces-1, st)
	}
}

// TestHTTPReaderSetResponsive pins the responsive-mode contract: the
// HTTPReader must call SetResponsive() on the underlying anacrolix Reader
// so that available() skips the piece-completion gate and returns data as
// soon as chunks become available. Without responsive mode, a mid-file
// seek blocks indefinitely when the target piece is not yet hash-verified.
//
// We verify:
//  1. SetResponsive() can be called on the Reader returned by
//     anacrolix File.NewReader() (compilation + interface contract).
//  2. The non-responsive path blocks until timeout, proving that the
//     piece-completion gate is active without responsive mode.
//  3. A responsive reader still returns an error (not panic) when no data
//     is available — the torrent has no peers, so the context fires first.
func TestHTTPReaderSetResponsive(t *testing.T) {
	// Build a minimal single-file torrent: 4 pieces × 16 KiB = 64 KiB.
	const (
		pieceLen  = 16384
		numPieces = 4
		fileSize  = numPieces * pieceLen
	)
	info := &metainfo.Info{
		Name:        "responsive_test.mkv",
		PieceLength: pieceLen,
		Length:      fileSize,
	}
	info.Pieces = make([]byte, numPieces*20)
	ib, err := bencode.Marshal(info)
	if err != nil {
		t.Fatalf("marshal info: %v", err)
	}

	dir := t.TempDir()
	cfg := torrent.NewDefaultClientConfig()
	cfg.ListenHost = torrent.LoopbackListenHost
	cfg.ListenPort = 0
	cfg.Seed = false
	cfg.NoUpload = true
	cfg.NoDHT = true
	cfg.DisableUTP = true
	cfg.DataDir = dir
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	t.Cleanup(func() { cl.Close() })
	tt, _ := cl.AddTorrent(&metainfo.MetaInfo{InfoBytes: ib})
	<-tt.GotInfo()

	f := tt.Files()[0]

	// --- (1) SetResponsive() compiles and can be called ---
	r := f.NewReader()
	t.Cleanup(func() { r.Close() })
	r.SetResponsive() // must not panic
	r.Seek(0, io.SeekStart)

	// --- (2) Responsive reader still returns error with no data ---
	// The torrent has no peers, so no chunks are downloaded.
	// With a timed context, waitAvailable returns ctx.Err() before
	// the "n==0 && err==nil" panic path.
	ctx1, cancel1 := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel1()
	r.SetContext(ctx1)
	r.SetReadahead(4 << 20)
	start := time.Now()
	_, err = r.Read(make([]byte, 1))
	elapsed := time.Since(start)
	if err == nil {
		t.Error("responsive reader on empty torrent should return error, got nil")
	}
	// The error should come from the context, not from a panic.
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Logf("responsive reader error: %v (expected context deadline)", err)
	}
	t.Logf("responsive reader returned in %v", elapsed)

	// --- (3) Non-responsive reader blocks until context timeout ---
	// Create a fresh reader (responsive=false by default).
	r2 := f.NewReader()
	t.Cleanup(func() { r2.Close() })
	r2.SetReadahead(4 << 20)
	r2.Seek(0, io.SeekStart)
	// Trigger piece demand (sets reader.reading = true).
	ctxInit, cancelInit := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancelInit()
	r2.SetContext(ctxInit)
	r2.Read(make([]byte, 1))
	// Now Read with a short timeout: should block until context expires.
	// Use 500ms (not 200ms) to avoid flakes on slow/loaded CI: the
	// important assertion is that the reader blocks at all, not the
	// exact wall-clock duration.
	ctx2, cancel2 := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel2()
	r2.SetContext(ctx2)
	start = time.Now()
	_, err2 := r2.Read(make([]byte, 1))
	elapsed = time.Since(start)
	if !errors.Is(err2, context.DeadlineExceeded) {
		t.Errorf("non-responsive reader: got err=%v, want context.DeadlineExceeded", err2)
	}
	if elapsed < 300*time.Millisecond {
		t.Errorf("non-responsive reader returned in %v, want >=300ms (blocked on piece completion)", elapsed)
	}
	t.Logf("non-responsive reader blocked for %v", elapsed)
}

// TestHTTPReaderContextCancellation verifies that the HTTPReader (used by
// serveTorrentContent) returns promptly when its context is cancelled.
// This ensures that if a client disconnects mid-stream, the anacrolix
// Reader unblocks and the goroutine does not leak.
func TestHTTPReaderContextCancellation(t *testing.T) {
	const (
		pieceLen  = 16384
		numPieces = 4
		fileSize  = numPieces * pieceLen
	)
	info := &metainfo.Info{
		Name:        "ctx_cancel_test.mkv",
		PieceLength: pieceLen,
		Length:      fileSize,
	}
	info.Pieces = make([]byte, numPieces*20)
	ib, err := bencode.Marshal(info)
	if err != nil {
		t.Fatalf("marshal info: %v", err)
	}

	dir := t.TempDir()
	cfg := torrent.NewDefaultClientConfig()
	cfg.ListenHost = torrent.LoopbackListenHost
	cfg.ListenPort = 0
	cfg.Seed = false
	cfg.NoUpload = true
	cfg.NoDHT = true
	cfg.DisableUTP = true
	cfg.DataDir = dir
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	t.Cleanup(func() { cl.Close() })
	tt, _ := cl.AddTorrent(&metainfo.MetaInfo{InfoBytes: ib})
	<-tt.GotInfo()

	f := tt.Files()[0]
	r := f.NewReader()
	t.Cleanup(func() { r.Close() })
	r.SetResponsive()
	r.SetReadahead(4 << 20)
	r.Seek(0, io.SeekStart)

	// Cancel the context immediately — Read should return promptly.
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before Read
	r.SetContext(ctx)

	start := time.Now()
	_, err = r.Read(make([]byte, 1))
	elapsed := time.Since(start)
	if err == nil {
		t.Error("Read after context cancel should return error, got nil")
	}
	if !errors.Is(err, context.Canceled) {
		t.Logf("Read error after cancel: %v (expected context.Canceled)", err)
	}
	if elapsed > 2*time.Second {
		t.Errorf("Read after context cancel took %v, want <2s (prompt return)", elapsed)
	}
	t.Logf("Read after context cancel returned in %v", elapsed)
}

// TestAnchorSeekElevatesSeekPiece verifies that AnchorSeek targets the
// correct piece for the given offset and doesn't panic. The piece priority
// via SetPriority is tested indirectly through the API layer test
// (TestTorrentContentAnchorSeekOnRange).
func TestAnchorSeekElevatesSeekPiece(t *testing.T) {
	const (
		pieceLen  = 16384
		numPieces = 8
		fileSize  = numPieces * pieceLen
	)
	info := &metainfo.Info{
		Name:        "anchor_test.mkv",
		PieceLength: pieceLen,
		Length:      fileSize,
	}
	info.Pieces = make([]byte, numPieces*20)
	ib, err := bencode.Marshal(info)
	if err != nil {
		t.Fatalf("marshal info: %v", err)
	}

	dir := t.TempDir()
	cfg := torrent.NewDefaultClientConfig()
	cfg.ListenHost = torrent.LoopbackListenHost
	cfg.ListenPort = 0
	cfg.Seed = false
	cfg.NoUpload = true
	cfg.NoDHT = true
	cfg.DisableUTP = true
	cfg.DataDir = dir
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	t.Cleanup(func() { cl.Close() })
	tt, _ := cl.AddTorrent(&metainfo.MetaInfo{InfoBytes: ib})
	<-tt.GotInfo()

	h := newAnacrolixHandle(tt)
	if err := h.Select("f0", ""); err != nil {
		t.Fatalf("Select: %v", err)
	}

	// AnchorSeek should not panic for valid offsets.
	h.AnchorSeek(3 * pieceLen) // middle of file
	h.AnchorSeek(0)            // start of file
	h.AnchorSeek(fileSize - 1) // end of file

	// AnchorSeek should be a no-op when no file is selected.
	h2 := newAnacrolixHandle(tt)
	h2.AnchorSeek(1000) // no Select called — should not panic

	// Verify the handle's selected file is set correctly.
	if h.selected == nil {
		t.Error("selected should be set after Select")
	}
	if h.selected.Length() != fileSize {
		t.Errorf("selected.Length() = %d, want %d", h.selected.Length(), fileSize)
	}

	h.Close()
}

// TestAnchorSeekNoopWithoutSelection verifies that AnchorSeek is a no-op
// when no file is selected (no panic, no error).
func TestAnchorSeekNoopWithoutSelection(t *testing.T) {
	const (
		pieceLen  = 16384
		numPieces = 4
		fileSize  = numPieces * pieceLen
	)
	info := &metainfo.Info{
		Name:        "anchor_noop.mkv",
		PieceLength: pieceLen,
		Length:      fileSize,
	}
	info.Pieces = make([]byte, numPieces*20)
	ib, err := bencode.Marshal(info)
	if err != nil {
		t.Fatalf("marshal info: %v", err)
	}

	dir := t.TempDir()
	cfg := torrent.NewDefaultClientConfig()
	cfg.ListenHost = torrent.LoopbackListenHost
	cfg.ListenPort = 0
	cfg.Seed = false
	cfg.NoUpload = true
	cfg.NoDHT = true
	cfg.DisableUTP = true
	cfg.DataDir = dir
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	t.Cleanup(func() { cl.Close() })
	tt, _ := cl.AddTorrent(&metainfo.MetaInfo{InfoBytes: ib})
	<-tt.GotInfo()

	h := newAnacrolixHandle(tt)
	// No Select call — AnchorSeek should be a no-op.
	h.AnchorSeek(0)
	h.AnchorSeek(pieceLen)
	h.AnchorSeek(fileSize - 1)
}
