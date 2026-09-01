package anki

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestFuseRoundtripWALCheckpoint pins the WAL merge contract end to
// end: a source DB in WAL mode keeps its journal_mode on the work
// copy (journal_mode is persistent in the DB file), a second insert
// lands in the work copy's -wal sidecar, the checkpoint on close
// merges it into the work main file, and CopyOut writes a fully
// merged collection back to src — both rows must be visible there
// via a fresh immutable (lock-free) read, the same way a
// FUSE-hosted collection must be read.
func TestFuseRoundtripWALCheckpoint(t *testing.T) {
	srcDir := t.TempDir()
	workDir := t.TempDir()
	srcPath := newTestCollectionFixtureAt(t, srcDir)
	pragmaDSN := "file:%s?_pragma=busy_timeout(5000)&_pragma=foreign_keys(0)"

	// 1. Source in WAL mode (modernc on a normal fs), then release
	// cleanly so the main file — not a -wal sidecar — carries the
	// row for CopyIn (the last-connection close auto-checkpoints).
	srcDB, err := sql.Open("sqlite", fmt.Sprintf(pragmaDSN, srcPath))
	if err != nil {
		t.Fatalf("open src: %v", err)
	}
	srcDB.SetMaxOpenConns(1)
	var mode string
	if err := srcDB.QueryRow("PRAGMA journal_mode=wal").Scan(&mode); err != nil {
		t.Fatalf("set journal_mode=wal: %v", err)
	}
	if mode != "wal" {
		t.Fatalf("src journal_mode = %q, want wal", mode)
	}
	if err := srcDB.Close(); err != nil {
		t.Fatalf("close src setup db: %v", err)
	}

	// 2. Row 1 in src through the normal collection layer.
	src, err := OpenCollection(srcPath)
	if err != nil {
		t.Fatalf("open src collection: %v", err)
	}
	noteID1, err := src.InsertNote(testDeckID, testModelID, []string{"wal-row-1", "!"}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote row 1: %v", err)
	}
	if err := src.Close(); err != nil {
		t.Fatalf("close src collection: %v", err)
	}

	// 3. CopyIn → the work copy must have inherited WAL mode.
	rt := NewFuseRoundtrip(workDir)
	workPath, err := rt.CopyIn(srcPath)
	if err != nil {
		t.Fatalf("CopyIn: %v", err)
	}
	workDB, err := sql.Open("sqlite", fmt.Sprintf(pragmaDSN, workPath))
	if err != nil {
		t.Fatalf("open work copy: %v", err)
	}
	workDB.SetMaxOpenConns(1)
	if err := workDB.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatalf("read work copy journal_mode: %v", err)
	}
	if mode != "wal" {
		t.Fatalf("work copy journal_mode = %q, want wal (journal_mode is persistent in the DB file)", mode)
	}
	if err := workDB.Close(); err != nil {
		t.Fatalf("close work copy probe db: %v", err)
	}

	// 4. Row 2 on the work copy — in WAL mode it lands in the -wal
	// sidecar first — then checkpoint + close exactly the way a
	// roundtrip Collection.Close() does before writeback.
	wc, err := OpenCollection(workPath)
	if err != nil {
		t.Fatalf("open work collection: %v", err)
	}
	noteID2, err := wc.InsertNote(testDeckID, testModelID, []string{"wal-row-2", "!"}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote row 2 on WAL work copy: %v", err)
	}
	if _, err := wc.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		t.Fatalf("checkpoint work copy: %v", err)
	}
	if err := wc.Close(); err != nil {
		t.Fatalf("close work collection: %v", err)
	}

	// 5. Writeback — the single-file copy must carry the merged WAL.
	if err := rt.CopyOut(workPath, srcPath); err != nil {
		t.Fatalf("CopyOut: %v", err)
	}
	if _, err := os.Stat(workPath); !os.IsNotExist(err) {
		t.Errorf("work copy still present after CopyOut: %v", err)
	}

	// 6. Fresh immutable open of src (no locking — mirrors the FUSE
	// read reality): BOTH rows must be present, proving the WAL
	// merge landed before the writeback copy.
	verify, err := sql.Open("sqlite", "file:"+srcPath+"?immutable=1")
	if err != nil {
		t.Fatalf("immutable open src: %v", err)
	}
	defer verify.Close()
	verify.SetMaxOpenConns(1)
	rows, err := verify.Query("SELECT id FROM notes")
	if err != nil {
		t.Fatalf("query notes: %v", err)
	}
	defer rows.Close()
	got := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan note id: %v", err)
		}
		got[id] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate notes: %v", err)
	}
	for _, id := range []int64{noteID1, noteID2} {
		if !got[id] {
			t.Errorf("note %d missing from src after WAL roundtrip (got %v)", id, got)
		}
	}
	if len(got) != 2 {
		t.Errorf("src notes = %v, want exactly 2 (WAL merge lost rows)", got)
	}
}

// TestFuseRoundtripCopyInPreservesStaleWork pins the crash-recovery
// contract of CopyIn: a work file left by a crashed run that differs
// from src is NOT truncated — it is renamed to
// <base>.recovery-<unix-ts>, RecoveryHook receives the path, AND
// CopyIn continues with a fresh copy (the bridge must NOT be
// bricked by a recovery event). The recovery file holds the old
// bytes; the fresh work copy carries the current src content.
func TestFuseRoundtripCopyInPreservesStaleWork(t *testing.T) {
	srcDir := t.TempDir()
	workDir := t.TempDir()
	srcPath := newTestCollectionFixtureAt(t, srcDir)

	rt := NewFuseRoundtrip(workDir)
	workPath, err := rt.CopyIn(srcPath)
	if err != nil {
		t.Fatalf("seed CopyIn: %v", err)
	}
	// Capture the original src content (bytes + size) so we can
	// assert the fresh copy matches it after preservation.
	srcBytes, err := os.ReadFile(srcPath)
	if err != nil {
		t.Fatalf("read src for baseline: %v", err)
	}

	// Simulate a crashed run: leftover work content that differs from
	// src (size differs; a real stale copy would carry writes that
	// never reached src).
	if err := os.WriteFile(workPath, []byte("stale work copy from a crashed run"), 0o600); err != nil {
		t.Fatalf("write stale work content: %v", err)
	}
	base := filepath.Base(srcPath)

	// RecoveryHook must fire exactly once with the recovery path.
	var hookCalls int
	var hookPath string
	rt.RecoveryHook = func(p string) {
		hookCalls++
		hookPath = p
	}

	gotWork, err := rt.CopyIn(srcPath)
	if err != nil {
		t.Fatalf("CopyIn with stale differing work file: want success (recovery + fresh copy), got error %v", err)
	}
	if gotWork != workPath {
		t.Errorf("CopyIn workPath = %q, want %q", gotWork, workPath)
	}
	if hookCalls != 1 {
		t.Errorf("RecoveryHook called %d times, want 1", hookCalls)
	}
	if !strings.HasPrefix(filepath.Base(hookPath), base+".recovery-") {
		t.Errorf("RecoveryHook path = %q, want prefix %s.recovery-", hookPath, base)
	}
	if hookPath != "" && filepath.Dir(hookPath) != workDir {
		t.Errorf("RecoveryHook path dir = %q, want %q", filepath.Dir(hookPath), workDir)
	}

	// The stale bytes must exist under the recovery name and the
	// fresh work path must carry the current src content (not the
	// stale bytes — the recovery path was renamed away, then the
	// fresh copy filled the work path).
	recoveryPath := hookPath
	data, err := os.ReadFile(recoveryPath)
	if err != nil {
		t.Fatalf("read recovery file: %v", err)
	}
	if string(data) != "stale work copy from a crashed run" {
		t.Errorf("recovery file content = %q, want the stale bytes preserved unmodified", data)
	}
	fresh, err := os.ReadFile(workPath)
	if err != nil {
		t.Fatalf("read fresh work copy: %v", err)
	}
	if !bytes.Equal(fresh, srcBytes) {
		t.Errorf("fresh work copy differs from src (len got=%d want=%d)", len(fresh), len(srcBytes))
	}

	// A subsequent CopyIn (no stale work; fresh work is now
	// identical to src content but its mtime may still differ by
	// virtue of being a fresh copy) must NOT misclassify the
	// freshly-copied work as stale: this is the critical regression
	// guard. Force the work mtime to be strictly older than src
	// (mimics a restart where the src was touched after the copy)
	// and confirm CopyIn succeeds without preservation.
	if err := os.Chtimes(workPath, time.Unix(1, 0), time.Unix(1, 0)); err != nil {
		t.Fatalf("chtimes work: %v", err)
	}
	beforeHookCalls := hookCalls
	if _, err := rt.CopyIn(srcPath); err != nil {
		t.Fatalf("CopyIn after normal-finished work: want success (work mtime older than src, NOT stale), got %v", err)
	}
	if hookCalls != beforeHookCalls {
		t.Errorf("RecoveryHook called on normal copy (work mtime older than src): calls %d→%d, want unchanged", beforeHookCalls, hookCalls)
	}
	if _, err := os.Stat(recoveryPath); err != nil {
		t.Errorf("recovery file missing after normal retry: %v", err)
	}
}

// TestShouldPreserveStaleWork pins the four decision cases of
// shouldPreserveStaleWork end to end (real os.Stat + real files):
//   (a) work missing              → false (nothing to preserve)
//   (b) same size, work mtime OLDER than src → false  (the
//       critical regression guard: a finished copy whose work mtime
//       is older than a freshly-touched src must NOT be parked as a
//       recovery file — that's the bug that bricked the bridge)
//   (c) same size, work mtime NEWER than src → true  (a crashed
//       run wrote to the work copy after src was last modified)
//   (d) different size            → true (partial/extra data)
func TestShouldPreserveStaleWork(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	work := filepath.Join(dir, "work.bin")
	if err := os.WriteFile(src, []byte("0123456789"), 0o600); err != nil {
		t.Fatalf("write src: %v", err)
	}

	// (a) work missing → false.
	if shouldPreserveStaleWork(src, work) {
		t.Errorf("(a) work missing: shouldPreserveStaleWork = true, want false")
	}

	// Helper to (re-)create work with explicit mtime and size.
	writeWork := func(content []byte, mtime time.Time) {
		t.Helper()
		if err := os.WriteFile(work, content, 0o600); err != nil {
			t.Fatalf("write work: %v", err)
		}
		if err := os.Chtimes(work, mtime, mtime); err != nil {
			t.Fatalf("chtimes work: %v", err)
		}
	}

	srcMtime := time.Unix(1_700_000_000, 0)
	if err := os.Chtimes(src, srcMtime, srcMtime); err != nil {
		t.Fatalf("chtimes src: %v", err)
	}

	// (b) same size, work mtime OLDER than src → false (regression).
	writeWork([]byte("ABCDEFGHIJ"), srcMtime.Add(-time.Hour))
	if shouldPreserveStaleWork(src, work) {
		t.Errorf("(b) same size + work.mtime < src.mtime: shouldPreserveStaleWork = true, want false (must not misclassify a finished copy)")
	}

	// (c) same size, work mtime NEWER than src → true.
	writeWork([]byte("ABCDEFGHIJ"), srcMtime.Add(time.Hour))
	if !shouldPreserveStaleWork(src, work) {
		t.Errorf("(c) same size + work.mtime > src.mtime: shouldPreserveStaleWork = false, want true (writes after src modtime = crashed run)")
	}

	// (d) different size → true regardless of mtime direction.
	writeWork([]byte("SHORT"), srcMtime.Add(time.Hour)) // smaller, newer
	if !shouldPreserveStaleWork(src, work) {
		t.Errorf("(d) smaller + work.mtime > src.mtime: shouldPreserveStaleWork = false, want true")
	}
	writeWork([]byte("LARGER-CONTENT-PAYLOAD"), srcMtime.Add(-time.Hour)) // larger, older
	if !shouldPreserveStaleWork(src, work) {
		t.Errorf("(d) larger + work.mtime < src.mtime: shouldPreserveStaleWork = false, want true")
	}
}

// TestCopyFileEmptySrc pins the 0-byte-copy guard: when src is 0
// bytes (e.g. FUSE quirk), copyFile must NOT leave a 0-byte dst on
// disk — it must remove dst and return an error naming the problem.
// A 0-byte work file at the FUSE recovery path is exactly the
// "collection not open" symptom from the device.
func TestCopyFileEmptySrc(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	dst := filepath.Join(dir, "dst.bin")
	if err := os.WriteFile(src, nil, 0o600); err != nil {
		t.Fatalf("write empty src: %v", err)
	}
	err := copyFile(src, dst)
	if err == nil {
		t.Fatal("copyFile(empty src): want error, got nil")
	}
	if !strings.Contains(err.Error(), "copied 0 bytes") {
		t.Errorf("copyFile(empty src) error = %v, want substring 'copied 0 bytes'", err)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Errorf("dst %s still present after empty-src copy (want removed): %v", dst, err)
	}

	// Sanity: a non-empty copy still works and produces the right
	// bytes; this guards against a regression where the new 0-byte
	// guard breaks the normal happy path.
	if err := os.WriteFile(src, []byte("hello world"), 0o600); err != nil {
		t.Fatalf("rewrite src: %v", err)
	}
	if err := copyFile(src, dst); err != nil {
		t.Fatalf("copyFile(non-empty src): unexpected error: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read dst: %v", err)
	}
	if string(got) != "hello world" {
		t.Errorf("dst content = %q, want %q", got, "hello world")
	}
}

// TestFuseRoundtripCopyInWriteCopyOut pins the verified device
// pattern (copy → work → writeback) end to end on a normal fs:
// CopyIn off the "FUSE" source dir into the work dir, real SQLite
// INSERT on the work copy, CopyOut back, then the source file must
// contain the inserted note and the work file must be gone.
func TestFuseRoundtripCopyInWriteCopyOut(t *testing.T) {
	srcDir := t.TempDir()
	workDir := t.TempDir()
	srcPath := newTestCollectionFixtureAt(t, srcDir)

	rt := NewFuseRoundtrip(workDir)
	workPath, err := rt.CopyIn(srcPath)
	if err != nil {
		t.Fatalf("CopyIn: %v", err)
	}
	wantWork := filepath.Join(workDir, filepath.Base(srcPath))
	if workPath != wantWork {
		t.Errorf("workPath = %q, want %q", workPath, wantWork)
	}
	if _, err := os.Stat(workPath); err != nil {
		t.Fatalf("work copy missing after CopyIn: %v", err)
	}

	// Real SQLite against the work copy (ext4; full locking works).
	c, err := OpenCollection(workPath)
	if err != nil {
		t.Fatalf("open work copy: %v", err)
	}
	noteID, err := c.InsertNote(testDeckID, testModelID, []string{"roundtrip", "!"}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote on work copy: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("close work copy: %v", err)
	}

	// Writeback to the source path.
	if err := rt.CopyOut(workPath, srcPath); err != nil {
		t.Fatalf("CopyOut: %v", err)
	}
	// Work file removed on success.
	if _, err := os.Stat(workPath); !os.IsNotExist(err) {
		t.Errorf("work copy still present after CopyOut: %v", err)
	}
	// Source now carries the note.
	verify := openTestCollection(t, srcPath)
	ids, err := verify.FindNotes("added:1")
	if err != nil {
		t.Fatalf("FindNotes on src after writeback: %v", err)
	}
	if len(ids) != 1 || ids[0] != noteID {
		t.Errorf("src notes = %v, want [%d]", ids, noteID)
	}
	infos, err := verify.NotesInfo(ids)
	if err != nil {
		t.Fatalf("NotesInfo after writeback: %v", err)
	}
	if len(infos) != 1 || infos[0].Fields["Front"] != "roundtrip" {
		t.Errorf("src note fields = %+v, want Front=roundtrip", infos)
	}
}

// TestOpenCollectionWithWorkDirDirectOpenWins pins the first fallback
// step: on a NORMAL fs the direct open succeeds and no roundtrip is
// engaged (workDir is present but unused — the FUSE-only machinery
// must not change non-FUSE behavior).
func TestOpenCollectionWithWorkDirDirectOpenWins(t *testing.T) {
	srcPath := newTestCollectionFixture(t)
	workDir := t.TempDir()
	c, err := OpenCollectionWithWorkDir(srcPath, workDir)
	if err != nil {
		t.Fatalf("OpenCollectionWithWorkDir: %v", err)
	}
	defer c.Close()
	if c.roundtrip != nil {
		t.Errorf("roundtrip = %+v, want nil (direct open on non-FUSE fs succeeds first)", c.roundtrip)
	}
	if c.Path() != srcPath {
		t.Errorf("Path() = %q, want %q", c.Path(), srcPath)
	}
	if _, err := c.InsertNote(testDeckID, testModelID, []string{"direct", "x"}, nil, nil); err != nil {
		t.Fatalf("InsertNote via direct open: %v", err)
	}
}

// TestOpenCollectionWithWorkDirEmptyWorkDirPassthrough pins the
// passthrough contract: with workDir "" (or a non-busy failure) the
// direct-open error is returned UNCHANGED and no fallback copy is
// made.
func TestOpenCollectionWithWorkDirEmptyWorkDirPassthrough(t *testing.T) {
	badPath := filepath.Join(t.TempDir(), "missing", "collection.anki2")
	_, directErr := OpenCollection(badPath)
	if directErr == nil {
		t.Fatal("OpenCollection on missing path: want error, got nil")
	}
	if isBusyLockError(directErr) {
		t.Fatalf("missing-path error classified as busy: %v", directErr)
	}
	// workDir == "": original error, verbatim.
	_, err := OpenCollectionWithWorkDir(badPath, "")
	if err == nil {
		t.Fatal("OpenCollectionWithWorkDir(missing, \"\"): want error, got nil")
	}
	if err.Error() != directErr.Error() {
		t.Errorf("workDir=\"\" error = %v, want direct-open error %v", err, directErr)
	}
	// Non-busy failure with a workDir: still no fallback.
	workDir := t.TempDir()
	_, err = OpenCollectionWithWorkDir(badPath, workDir)
	if err == nil {
		t.Fatal("OpenCollectionWithWorkDir(missing, dir): want error, got nil")
	}
	if err.Error() != directErr.Error() {
		t.Errorf("non-busy error = %v, want direct-open error %v", err, directErr)
	}
	if entries, _ := os.ReadDir(workDir); len(entries) != 0 {
		t.Errorf("work dir must stay empty when no fallback runs; got %d entries", len(entries))
	}
}

// TestOpenCollectionWithWorkDirFallsBackOnBusyLocked exercises the
// REAL fallback branch: a second SQLite connection holds an
// EXCLUSIVE (rollback-journal) lock, the direct open busy-waits
// busy_timeout then fails with "database is locked (SQLITE_BUSY)",
// OpenCollectionWithWorkDir copies the file into the work dir and
// opens the copy, a note is written, the lock is released, and
// Close() writes the work copy back to the original path.
//
// Windows-only: on unix fcntl record locks are per-process, so a
// second fd in the same process never blocks (no SQLITE_BUSY can be
// forced in-process); Windows LockFileEx is per-handle, which
// reproduces the cross-UID FUSE behavior. The dev/QA box for this
// feature is Windows.
func TestOpenCollectionWithWorkDirFallsBackOnBusyLocked(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("in-process SQLite locking is per-process on unix fcntl; only Windows LockFileEx (per-handle) can force the cross-process-style SQLITE_BUSY this test needs")
	}
	srcPath := newTestCollectionFixture(t)
	workDir := t.TempDir()

	// Hold an EXCLUSIVE lock on the source file (rollback journal:
	// EXCLUSIVE blocks even new readers, unlike WAL).
	ctx := context.Background()
	lockDB, err := sql.Open("sqlite", "file:"+srcPath)
	if err != nil {
		t.Fatalf("open lock conn: %v", err)
	}
	lockDB.SetMaxOpenConns(1)
	lockConn, err := lockDB.Conn(ctx)
	if err != nil {
		t.Fatalf("pin lock conn: %v", err)
	}
	defer lockConn.Close()
	defer lockDB.Close()
	if _, err := lockConn.ExecContext(ctx, "BEGIN EXCLUSIVE"); err != nil {
		t.Fatalf("BEGIN EXCLUSIVE: %v", err)
	}

	t.Log("direct open busy-waits ~5s (busy_timeout=5000) then must fall back to the FUSE roundtrip")
	c, err := OpenCollectionWithWorkDir(srcPath, workDir)
	if err != nil {
		t.Fatalf("OpenCollectionWithWorkDir with busy lock: %v", err)
	}
	if c.roundtrip == nil {
		t.Fatal("roundtrip == nil: expected FUSE fallback (direct open = SQLITE_BUSY)")
	}
	if c.Path() != srcPath {
		t.Errorf("Path() = %q, want src %q (roundtrip keeps the original identity)", c.Path(), srcPath)
	}
	noteID, err := c.InsertNote(testDeckID, testModelID, []string{"busy-fallback", "x"}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote on work copy: %v", err)
	}
	// Release the lock BEFORE Close so the writeback can overwrite src.
	if _, err := lockConn.ExecContext(ctx, "ROLLBACK"); err != nil {
		t.Fatalf("ROLLBACK: %v", err)
	}
	if err := lockConn.Close(); err != nil {
		t.Fatalf("close lock conn: %v", err)
	}
	if err := lockDB.Close(); err != nil {
		t.Fatalf("close lock db: %v", err)
	}

	if err := c.Close(); err != nil {
		t.Fatalf("Close (roundtrip writeback): %v", err)
	}
	// Path() must keep reporting the ORIGINAL src path even after
	// Close clears the internal srcPath/workPath (Fix: displayPath
	// captures the identity at open time).
	if c.Path() != srcPath {
		t.Errorf("Path() after Close = %q, want src %q (identity must survive Close)", c.Path(), srcPath)
	}
	verify := openTestCollection(t, srcPath)
	ids, err := verify.FindNotes("added:1")
	if err != nil {
		t.Fatalf("FindNotes after writeback: %v", err)
	}
	if len(ids) != 1 || ids[0] != noteID {
		t.Errorf("src notes = %v, want [%d] (writeback lost the note)", ids, noteID)
	}
}

// TestFuseRoundtripStaleSidecarsManaged pins the -wal/-shm
// sidecar management contract that closes the corruption hole:
// when the busy-locked direct open falls back to the roundtrip,
// ANY of these three states must leave the work area clean for
// the fresh session:
//
//	(preservation branch — CopyIn finds a stale work file)
//	  workPath + workPath-wal + workPath-shm all renamed to the
//	  recovery-<ts> triplet, then a fresh workPath is laid down
//	  WITHOUT -wal/-shm. The recovery bundle must be self-
//	  contained (main + sidecars) so the parked bytes can be
//	  replayed intact; the fresh work must NOT inherit stale
//	  sidecars whose headers would replay the crashed session's
//	  writes into the fresh main file on first read.
//
//	(normal-copy branch — CopyIn finds no stale work file, or a
//	 stale work file whose rename fell through)
//	  Any leftover workPath-wal / workPath-shm from a killed
//	  previous session must be removed BEFORE the fresh main
//	  copy lands, for the same WAL-replay-into-fresh-file reason.
//	  And if the fresh copy itself fails, the partial main +
//	  sidecars must all be cleaned up.
//
// The test asserts both branches in one fixture so the bundle-vs-
// scrub invariant is visible end-to-end: a CopyIn cycle that
// preserved a stale trio leaves a clean fresh work copy + a self-
// contained recovery bundle; a subsequent CopyIn on the clean
// work area (no preservation) leaves ZERO -wal/-shm residue.
func TestFuseRoundtripStaleSidecarsManaged(t *testing.T) {
	srcDir := t.TempDir()
	workDir := t.TempDir()
	srcPath := newTestCollectionFixtureAt(t, srcDir)

	rt := NewFuseRoundtrip(workDir)
	workPath := filepath.Join(workDir, filepath.Base(srcPath))

	// --- Branch 1: preservation. Plant main + -wal + -shm BEFORE
	// CopyIn to simulate a crashed previous session that left the
	// full WAL trio behind. CopyIn must rename all three to the
	// recovery triplet and lay down a fresh main with no sidecars.
	crashMain := []byte("AAA-stale-write-from-crashed-session")
	if err := os.WriteFile(workPath, crashMain, 0o600); err != nil {
		t.Fatalf("seed stale work main: %v", err)
	}
	if err := os.WriteFile(workPath+"-wal", []byte("stale-wal-bytes"), 0o600); err != nil {
		t.Fatalf("seed stale -wal: %v", err)
	}
	if err := os.WriteFile(workPath+"-shm", []byte("stale-shm-bytes"), 0o600); err != nil {
		t.Fatalf("seed stale -shm: %v", err)
	}

	// Capture recovery path via the hook so we can assert on the
	// full triplet.
	var hookCalls int
	var hookPath string
	rt.RecoveryHook = func(p string) {
		hookCalls++
		hookPath = p
	}

	gotWork, err := rt.CopyIn(srcPath)
	if err != nil {
		t.Fatalf("CopyIn (preservation branch with sidecars): %v", err)
	}
	if gotWork != workPath {
		t.Errorf("CopyIn workPath = %q, want %q", gotWork, workPath)
	}
	if hookCalls != 1 {
		t.Fatalf("RecoveryHook calls = %d, want 1", hookCalls)
	}
	if hookPath == "" {
		t.Fatal("RecoveryHook path = \"\", want the recovery-<ts> path")
	}
	recoveryMain := hookPath

	// Recovery bundle: main + -wal + -shm must ALL exist under the
	// recovery name with the original stale content intact.
	for _, tc := range []struct {
		path    string
		want    []byte
		descrip string
	}{
		{recoveryMain, crashMain, "recovery main"},
		{recoveryMain + "-wal", []byte("stale-wal-bytes"), "recovery -wal"},
		{recoveryMain + "-shm", []byte("stale-shm-bytes"), "recovery -shm"},
	} {
		got, rerr := os.ReadFile(tc.path)
		if rerr != nil {
			t.Errorf("%s missing after preservation: %v", tc.descrip, rerr)
			continue
		}
		if !bytes.Equal(got, tc.want) {
			t.Errorf("%s content = %q, want %q (preservation must keep the stale bytes unmodified)", tc.descrip, got, tc.want)
		}
	}
	// And the stale sidecars must NOT survive at their original
	// names (the fresh main at workPath is laid down by the
	// subsequent copyFile, so its presence here is expected and
	// asserted separately below).
	for _, side := range []string{workPath + "-wal", workPath + "-shm"} {
		if _, serr := os.Stat(side); !os.IsNotExist(serr) {
			t.Errorf("stale %s still present after preservation rename: stat err=%v", side, serr)
		}
	}

	// Fresh workPath: a copy of the current src, with NO -wal/-shm
	// residue from the killed session.
	srcBytes, rerr := os.ReadFile(srcPath)
	if rerr != nil {
		t.Fatalf("read src for baseline: %v", rerr)
	}
	fresh, rerr := os.ReadFile(workPath)
	if rerr != nil {
		t.Fatalf("read fresh work: %v", rerr)
	}
	if !bytes.Equal(fresh, srcBytes) {
		t.Errorf("fresh work copy differs from src (got len=%d, want len=%d)", len(fresh), len(srcBytes))
	}
	for _, side := range []string{workPath + "-wal", workPath + "-shm"} {
		if _, serr := os.Stat(side); !os.IsNotExist(serr) {
			t.Errorf("stale %s still present in fresh work area after CopyIn preservation branch: stat err=%v", side, serr)
		}
	}

	// The fresh work copy is openable and roundtrip-able to a
	// fresh src (no stale-sidecar corruption when SQLite opens it).
	verify, vErr := OpenCollection(workPath)
	if vErr != nil {
		t.Fatalf("open fresh work copy after preservation: %v", vErr)
	}
	if err := verify.Close(); vErr == nil && err != nil {
		t.Fatalf("close fresh work copy: %v", err)
	}
	// And CopyOut to a brand-new src path (simulating the FUSE
	// writeback to a path that never had any sidecars of its own)
	// must succeed and produce a clean read on the new src.
	freshSrc := filepath.Join(t.TempDir(), "collection.anki2")
	if err := rt.CopyOut(workPath, freshSrc); err != nil {
		t.Fatalf("CopyOut after preservation CopyIn: %v", err)
	}

	// --- Branch 2: normal-copy (no preservation). Plant ONLY the
	// sidecars (no stale work main) to simulate the "main file was
	// already gone but -wal/-shm survived" sub-case of a killed
	// session. CopyIn must remove the sidecars before laying down
	// the fresh main, and the fresh work area must have ZERO
	// residue.
	sidecarWal := []byte("orphan-wal-no-main")
	sidecarShm := []byte("orphan-shm-no-main")
	if err := os.WriteFile(workPath+"-wal", sidecarWal, 0o600); err != nil {
		t.Fatalf("seed orphan -wal: %v", err)
	}
	if err := os.WriteFile(workPath+"-shm", sidecarShm, 0o600); err != nil {
		t.Fatalf("seed orphan -shm: %v", err)
	}
	beforeHookCalls := hookCalls
	gotWork, err = rt.CopyIn(srcPath)
	if err != nil {
		t.Fatalf("CopyIn (normal branch with orphan sidecars): %v", err)
	}
	if gotWork != workPath {
		t.Errorf("CopyIn workPath = %q, want %q", gotWork, workPath)
	}
	if hookCalls != beforeHookCalls {
		t.Errorf("RecoveryHook fired on normal-copy branch (no stale main): calls %d→%d, want unchanged", beforeHookCalls, hookCalls)
	}
	for _, side := range []string{workPath + "-wal", workPath + "-shm"} {
		if _, serr := os.Stat(side); !os.IsNotExist(serr) {
			t.Errorf("orphan %s survived CopyIn normal branch (would corrupt fresh main via WAL replay): stat err=%v", side, serr)
		}
	}
	// Fresh main must still equal the src bytes (the orphan sidecar
	// scrub must not touch the main copy).
	fresh, rerr = os.ReadFile(workPath)
	if rerr != nil {
		t.Fatalf("read fresh work after normal branch: %v", rerr)
	}
	if !bytes.Equal(fresh, srcBytes) {
		t.Errorf("fresh work after normal branch differs from src (got len=%d, want len=%d)", len(fresh), len(srcBytes))
	}
}

// TestIsBusyLockError pins the busy/locked classification that gates
// the FUSE roundtrip fallback: "database is locked" / "SQLITE_BUSY"
// strings classify true; anything else (including CANTOPEN and nil)
// stays false.
func TestIsBusyLockError(t *testing.T) {
	cases := []struct {
		msg  string
		want bool
	}{
		{"database is locked (5) (SQLITE_BUSY)", true},
		{"sqlite: database is locked", true},
		{"SQLITE_BUSY", true},
		{"unable to open database file (14) (SQLITE_CANTOPEN)", false},
		{"anki: collection schema not supported", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := isBusyLockError(errors.New(tc.msg)); got != tc.want {
			t.Errorf("isBusyLockError(%q) = %v, want %v", tc.msg, got, tc.want)
		}
	}
	if isBusyLockError(nil) {
		t.Error("isBusyLockError(nil) = true, want false")
	}
}
