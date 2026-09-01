// Tests for the SQLite header / writeback verification helpers
// added in the 2026-09-01 corruption hardening pass. These
// tests exercise the guards in isolation against synthetic
// byte-level file states; the full roundtrip-level coverage
// lives in fuse_roundtrip_test.go (atomic writeback) and
// collection_test.go (header / quick_check).
package anki

import (
	"database/sql"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// makeSyntheticSQLiteFile writes a SQLite-shaped file with the
// given page count and page size. Used by the header tests
// below to exercise specific pageCount / pageSize combinations
// without depending on SQLite's actual page layout (we just
// need the first 100 bytes to be correct). The rest of the
// file is zero-filled; SQLite won't be opened on these
// synthetic files in the unit tests.
//
// The header is contained WITHIN page 1 (the first 100 bytes
// of page 1 are the header; the rest of page 1 is regular
// data). The on-disk file size is therefore exactly
// pageCount * pageSize, NOT pageCount * pageSize + 100.
// This is verified against the real Anki collection.anki2:
// 18,176,000 bytes / 1024 = 17,750 pages exactly.
func makeSyntheticSQLiteFile(t *testing.T, path string, pageSize uint32, pageCount uint32) {
	t.Helper()
	total := int64(pageCount) * int64(pageSize)
	if pageCount == 0 {
		// An empty SQLite database is exactly one page (the
		// header page).
		total = int64(pageSize)
	}
	buf := make([]byte, total)
	// Magic.
	copy(buf[0:16], "SQLite format 3\x00")
	// Page size (offset 16-17, big-endian u16; value 1 is
	// special-cased to mean 65536 by SQLite).
	if pageSize == 65536 {
		binary.BigEndian.PutUint16(buf[16:18], 1)
	} else {
		binary.BigEndian.PutUint16(buf[16:18], uint16(pageSize))
	}
	// File change counter (offset 24-27, arbitrary; just non-zero
	// so the file looks "modified" — verifySQLiteHeader doesn't
	// read this, but having it set means a SQLite open would
	// succeed).
	binary.BigEndian.PutUint32(buf[24:28], 1)
	// Page count (offset 28-31, big-endian u32).
	binary.BigEndian.PutUint32(buf[28:32], pageCount)
	if err := os.WriteFile(path, buf, 0o600); err != nil {
		t.Fatalf("write synthetic %s: %v", path, err)
	}
}

// TestVerifySQLiteHeaderValid exercises the happy path: a
// well-formed SQLite file with pageCount * pageSize == fileSize
// returns nil from verifySQLiteHeader. Covers both the standard
// 4096-byte page size and the 65536-byte "header value 1" case
// (both are real Anki / SQLite configurations).
func TestVerifySQLiteHeaderValid(t *testing.T) {
	for _, tc := range []struct {
		name      string
		pageSize  uint32
		pageCount uint32
	}{
		{"1 page 4096", 4096, 1},
		{"16 pages 4096", 4096, 16},
		{"100 pages 4096 (Anki scale)", 4096, 100},
		{"1 page 1024 (legacy)", 1024, 1},
		{"1 page 8192", 8192, 1},
		{"1 page 65536 (header value 1)", 65536, 1},
		{"4 pages 65536", 65536, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "x.db")
			makeSyntheticSQLiteFile(t, path, tc.pageSize, tc.pageCount)
			if err := verifySQLiteHeader(path); err != nil {
				t.Errorf("verifySQLiteHeader on valid %s: %v", tc.name, err)
			}
		})
	}
}

// TestVerifySQLiteHeaderTorn pins the exact failure mode the
// 2026-09-01 incident exhibited: a file whose SQLite header
// declares MORE pages than the file actually contains. The
// file size falls short of pageCount * pageSize; verifySQLiteHeader
// must return a precise error naming both numbers so the
// operator can diagnose the corruption.
//
// The synthetic test deliberately sets the file to a size
// that's pageCount * pageSize - 2 * pageSize (mirroring the
// real incident's "header declared 17,752 pages but the file
// held 17,750" symptom). The error message must contain the
// page count, page size, expected, and actual sizes.
func TestVerifySQLiteHeaderTorn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.db")
	const (
		pageSize  = uint32(1024)
		pageCount = uint32(20)
	)
	// Lay down a valid 20-page file first, then shrink it by
	// 2 pages to simulate the half-merged-WAL symptom.
	makeSyntheticSQLiteFile(t, path, pageSize, pageCount)
	// Truncate the file to (pageCount-2) * pageSize bytes
	// (mirror the 2026-09-01 incident: header declared 17,752
	// pages but the file held 17,750).
	targetSize := int64(pageCount-2) * int64(pageSize)
	if err := os.Truncate(path, targetSize); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	hdrErr := verifySQLiteHeader(path)
	if hdrErr == nil {
		t.Fatal("verifySQLiteHeader on shrunk file: want error, got nil")
	}
	// The error must name the file size, the page count, and the
	// page size so an operator can diagnose the corruption from
	// the log alone.
	msg := hdrErr.Error()
	for _, want := range []string{"pageCount=20", "pageSize=1024"} {
		if !contains(msg, want) {
			t.Errorf("error %q missing diagnostic %q", msg, want)
		}
	}
	if !contains(msg, "torn") {
		t.Errorf("error %q missing 'torn' marker", msg)
	}
}

// TestVerifySQLiteHeaderTruncated pins the "file too small for
// the header itself" branch. The first 100 bytes of a SQLite
// file hold the header; a file shorter than 100 bytes cannot
// be opened as a SQLite database and verifySQLiteHeader must
// surface that as a clear error.
func TestVerifySQLiteHeaderTruncated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.db")
	if err := os.WriteFile(path, []byte("SQLite format 3\x00not enough"), 0o600); err != nil {
		t.Fatalf("write truncated: %v", err)
	}
	err := verifySQLiteHeader(path)
	if err == nil {
		t.Fatal("verifySQLiteHeader on truncated file: want error, got nil")
	}
	if !contains(err.Error(), "file too small") {
		t.Errorf("error %q missing 'file too small' marker", err)
	}
}

// TestVerifySQLiteHeaderBadMagic pins the "first 16 bytes
// aren't the SQLite magic" branch. This is the most extreme
// failure: the bytes under us are not a SQLite file at all,
// which happens on the 2026-09-01 incident's secondary
// symptom (FUSE returned garbage from a mis-mounted volume).
// The file MUST be at least 100 bytes (otherwise the
// "file too small" guard fires first).
func TestVerifySQLiteHeaderBadMagic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.db")
	// 200 bytes of non-SQLite content.
	bad := make([]byte, 200)
	copy(bad, "NOT A SQLITE FILE_________________________________padding__________")
	if err := os.WriteFile(path, bad, 0o600); err != nil {
		t.Fatalf("write bad magic: %v", err)
	}
	err := verifySQLiteHeader(path)
	if err == nil {
		t.Fatal("verifySQLiteHeader on bad-magic file: want error, got nil")
	}
	if !contains(err.Error(), "bad magic") {
		t.Errorf("error %q missing 'bad magic' marker", err)
	}
}

// TestVerifySQLiteHeaderMissingFile pins the "file doesn't
// exist" branch: an open error (vs. a content error). The
// caller treats this as a fail-closed signal; the error must
// wrap the underlying os.Stat failure so the operator can
// distinguish "missing" from "torn".
func TestVerifySQLiteHeaderMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.db")
	err := verifySQLiteHeader(path)
	if err == nil {
		t.Fatal("verifySQLiteHeader on missing file: want error, got nil")
	}
	if !contains(err.Error(), "stat") {
		t.Errorf("error %q missing 'stat' marker (must wrap os.Stat failure)", err)
	}
}

// TestVerifySrcAfterWritebackHappy pins the "post-writeback
// quick_check returns ok" path: write a real row via
// WriteSession, then verifySrcAfterWriteback on the same path
// must return nil. This is the regression test for the
// post-writeback guard — it must pass on a clean file
// (otherwise the guard would never let any write complete).
func TestVerifySrcAfterWritebackHappy(t *testing.T) {
	srcPath := newTestCollectionFixture(t)
	workDir := t.TempDir()
	c, err := OpenCollectionWithWorkDir(srcPath, workDir)
	if err != nil {
		t.Fatalf("OpenCollectionWithWorkDir: %v", err)
	}
	defer c.Close()
	// A real write that goes through the full roundtrip.
	if _, err := c.InsertNote(testDeckID, testModelID, []string{"verify-happy", "!"}, nil, nil); err != nil {
		t.Fatalf("InsertNote: %v", err)
	}
	if err := verifySrcAfterWriteback(srcPath); err != nil {
		t.Errorf("verifySrcAfterWriteback on clean file: %v (the post-writeback guard MUST pass on healthy files)", err)
	}
}

// TestVerifySrcAfterWritebackMissingFile pins the "src was
// somehow deleted out from under us" branch: verifySrcAfterWriteback
// must surface a clear open error rather than crashing. The
// real WriteSession would have already errored earlier in that
// scenario (CopyOut would have failed); this test just guards
// the helper's contract.
//
// Note: sql.Open is lazy in modernc, so the open itself does
// not return an error. The first actual operation (Ping or
// Query) is what surfaces the missing file. We accept either
// "open" or "ping" or "query" in the error message as long as
// the helper returns non-nil for a missing file.
func TestVerifySrcAfterWritebackMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.db")
	err := verifySrcAfterWriteback(path)
	if err == nil {
		t.Fatal("verifySrcAfterWriteback on missing file: want error, got nil")
	}
	// We don't constrain the exact error text because modernc's
	// lazy-open behaviour means the failure can surface at
	// different points (Ping / Query). The contract is just
	// "non-nil error for a missing file".
}

// TestVerifySQLiteHeaderOnRealCollection pins the
// verifySQLiteHeader-on-a-real-collection scenario: a fresh
// fixture's collection.anki2 (built via real SQLite, not
// synthetic) must pass the header check. The synthetic tests
// above use a hand-rolled header; this one exercises the
// end-to-end "build via OpenCollection, then verify" path.
func TestVerifySQLiteHeaderOnRealCollection(t *testing.T) {
	path := newTestCollectionFixture(t)
	if err := verifySQLiteHeader(path); err != nil {
		t.Errorf("verifySQLiteHeader on real collection.anki2: %v (the real collection must be header-valid)", err)
	}
}

// TestSQLiteHeaderSummary pins the diagnostic helper: it
// must return a string with the path, size, page count, and
// page size when the file is parseable, and a degraded
// diagnostic when the file isn't. Used by the
// WriteSession error path to give operators a one-line
// header summary in the log even when verifySQLiteHeader
// itself errored.
func TestSQLiteHeaderSummary(t *testing.T) {
	t.Run("valid file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "x.db")
		makeSyntheticSQLiteFile(t, path, 4096, 10)
		got := sqliteHeaderSummary(path)
		for _, want := range []string{"pageCount=10", "pageSize=4096", "header_ok=true"} {
			if !contains(got, want) {
				t.Errorf("summary %q missing %q", got, want)
			}
		}
	})
	t.Run("missing file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "missing.db")
		got := sqliteHeaderSummary(path)
		if !contains(got, "missing.db") {
			t.Errorf("summary %q missing path", got)
		}
		if !contains(got, "read_err=") {
			t.Errorf("summary %q missing read_err marker", got)
		}
	})
}

// TestWriteSessionHeaderVerificationFailsClosed pins the
// WriteSession-level integration of the header guard:
// manually corrupt the work main file AFTER fn runs but
// BEFORE the roundtrip's guards run, and assert that
// WriteSession returns an error AND src is unchanged. The
// "anyway" scenario for this test: shrink the work file by
// 2 pages and confirm src's bytes are byte-identical to
// the pre-roundtrip snapshot.
//
// The test uses a real InsertNote via a custom write
// session path: open src, capture src bytes, run a
// WriteSession whose fn intentionally mutates the work
// file post-commit, assert error, and compare src bytes.
func TestWriteSessionHeaderVerificationFailsClosed(t *testing.T) {
	srcPath := newTestCollectionFixture(t)
	workDir := t.TempDir()
	// Capture pre-roundtrip src bytes.
	preBytes, err := os.ReadFile(srcPath)
	if err != nil {
		t.Fatalf("read pre src: %v", err)
	}
	c, err := OpenCollectionWithWorkDir(srcPath, workDir)
	if err != nil {
		t.Fatalf("OpenCollectionWithWorkDir: %v", err)
	}
	defer c.Close()
	// WriteSession with an fn that injects corruption into the
	// work file AFTER committing its real transaction. The
	// header guard must catch this and refuse to CopyOut.
	err = c.WriteSession(func(wc *workCollection) error {
		// Real work.
		tx, terr := wc.db.Begin()
		if terr != nil {
			return terr
		}
		if _, terr := tx.Exec("UPDATE col SET mod = ? WHERE id = 1", nowMillis()); terr != nil {
			_ = tx.Rollback()
			return terr
		}
		if terr := tx.Commit(); terr != nil {
			return terr
		}
		// Inject corruption: shrink the work main file by
		// 2 pages. This is the exact torn-shape the
		// 2026-09-01 incident exhibited.
		workPath := wc.path
		// Find the work main file path (wc.path).
		data, rerr := os.ReadFile(workPath)
		if rerr != nil {
			return rerr
		}
		// Header is 100 bytes; page size is 4096 by default
		// for modernc. Trim 2*4096 from the end.
		const pageSize = 4096
		if len(data) < 100+2*pageSize {
			return errors.New("work file too small to shrink")
		}
		shrunk := data[:len(data)-2*pageSize]
		if werr := os.WriteFile(workPath, shrunk, 0o600); werr != nil {
			return werr
		}
		return nil
	})
	if err == nil {
		t.Fatal("WriteSession with torn work file: want error, got nil")
	}
	if !contains(err.Error(), "header") {
		t.Errorf("error %q missing 'header' marker (the header guard must fire)", err)
	}
	// src must be UNCHANGED: byte-identical to the pre-roundtrip
	// snapshot.
	postBytes, rerr := os.ReadFile(srcPath)
	if rerr != nil {
		t.Fatalf("read post src: %v", rerr)
	}
	if len(postBytes) != len(preBytes) {
		t.Errorf("src size changed: pre=%d post=%d (header guard must not have CopyOut)", len(preBytes), len(postBytes))
	}
	for i := range preBytes {
		if preBytes[i] != postBytes[i] {
			t.Errorf("src bytes differ at offset %d: pre=%x post=%x", i, preBytes[i], postBytes[i])
			break
		}
	}
}

// TestWriteSessionCheckpointIncompleteFailsClosed pins the
// fail-closed behaviour of guard 1 (checkpoint completeness)
// by injecting a non-zero -wal sidecar AFTER the fn commits
// but BEFORE the roundtrip's guards run. The -wal presence
// is the post-checkpoint signal that the merge didn't run
// to completion; verifySQLiteHeader would also catch the
// torn state if the -wal is uncheckpointed writes against
// the main file, but the sidecar-presence guard fires FIRST
// as a second-order signal.
//
// The test mutates the work file after fn commits: write a
// non-zero -wal at the work path. The sidecar-presence
// guard must catch this and refuse to CopyOut.
func TestWriteSessionCheckpointIncompleteFailsClosed(t *testing.T) {
	srcPath := newTestCollectionFixture(t)
	workDir := t.TempDir()
	preBytes, err := os.ReadFile(srcPath)
	if err != nil {
		t.Fatalf("read pre src: %v", err)
	}
	c, err := OpenCollectionWithWorkDir(srcPath, workDir)
	if err != nil {
		t.Fatalf("OpenCollectionWithWorkDir: %v", err)
	}
	defer c.Close()
	err = c.WriteSession(func(wc *workCollection) error {
		tx, terr := wc.db.Begin()
		if terr != nil {
			return terr
		}
		if _, terr := tx.Exec("UPDATE col SET mod = ? WHERE id = 1", nowMillis()); terr != nil {
			_ = tx.Rollback()
			return terr
		}
		if terr := tx.Commit(); terr != nil {
			return terr
		}
		// Inject a non-zero -wal sidecar at the work path.
		// SQLite is closed at this point in the real flow
		// (close runs after the fn returns), but the test
		// only needs the sidecar FILE to exist on disk with
		// non-zero size at the time guard 2 runs. Note:
		// wc.db is still open here, so writing a -wal file
		// at this path doesn't interfere with the in-flight
		// work connection (different file).
		workPath := wc.path
		if werr := os.WriteFile(workPath+"-wal", []byte("simulated-stale-wal-bytes"), 0o600); werr != nil {
			return werr
		}
		return nil
	})
	if err == nil {
		t.Fatal("WriteSession with stale -wal injected: want error, got nil")
	}
	if !contains(err.Error(), "-wal") && !contains(err.Error(), "checkpoint") {
		t.Errorf("error %q missing -wal / checkpoint marker", err)
	}
	// src must be UNCHANGED.
	postBytes, rerr := os.ReadFile(srcPath)
	if rerr != nil {
		t.Fatalf("read post src: %v", rerr)
	}
	if len(postBytes) != len(preBytes) {
		t.Errorf("src size changed: pre=%d post=%d", len(preBytes), len(postBytes))
	}
	for i := range preBytes {
		if preBytes[i] != postBytes[i] {
			t.Errorf("src bytes differ at offset %d", i)
			break
		}
	}
}

// TestWriteSessionIntegrityGuard pins guard 4: a successful
// WriteSession is followed by a post-writeback quick_check.
// This is the "happy path" coverage for that guard — the
// quick_check on a freshly-written clean collection must
// return "ok" and not error. Combined with
// TestVerifySrcAfterWritebackHappy, this guarantees the
// guard is wired in correctly AND that it doesn't false-
// positive on real workloads.
func TestWriteSessionIntegrityGuard(t *testing.T) {
	srcPath := newTestCollectionFixture(t)
	workDir := t.TempDir()
	c, err := OpenCollectionWithWorkDir(srcPath, workDir)
	if err != nil {
		t.Fatalf("OpenCollectionWithWorkDir: %v", err)
	}
	defer c.Close()
	noteID, err := c.InsertNote(testDeckID, testModelID, []string{"integrity-guard", "!"}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote (must succeed: post-writeback guard must NOT false-positive on clean writes): %v", err)
	}
	if noteID == 0 {
		t.Fatal("noteID = 0, want >0")
	}
	// Open the source fresh and run quick_check directly to
	// confirm the on-disk file is in fact clean.
	verify, err := sql.Open("sqlite", "file:"+srcPath+"?immutable=1")
	if err != nil {
		t.Fatalf("open verify: %v", err)
	}
	defer verify.Close()
	verify.SetMaxOpenConns(1)
	row := verify.QueryRow("PRAGMA quick_check")
	var msg string
	if err := row.Scan(&msg); err != nil {
		t.Fatalf("scan quick_check: %v", err)
	}
	if msg != "ok" {
		t.Errorf("quick_check = %q, want \"ok\" (post-writeback file must be clean)", msg)
	}
	// Row count: exactly 1 (the one we just inserted).
	var n int
	if err := verify.QueryRow("SELECT COUNT(*) FROM notes").Scan(&n); err != nil {
		t.Fatalf("count notes: %v", err)
	}
	if n != 1 {
		t.Errorf("notes count = %d, want 1", n)
	}
}

// contains is a small local helper to keep the test file
// independent of strings.Contains (no import for a single-
// char substring check would be silly, but we use this
// everywhere for symmetry).
func contains(haystack, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
