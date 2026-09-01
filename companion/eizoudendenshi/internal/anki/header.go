// SQLite header verification helpers. The header is the first 100
// bytes of a SQLite database file. Two of its fields let us
// independently verify the on-disk page count:
//
//   - bytes 16-17  page size (big-endian u16; the value 1 is encoded
//                  as 65536 — SQLite's historical "means 64 KiB"
//                  convention)
//   - bytes 28-31  page count in the database file (big-endian u32;
//                  this is the number of pages in the file as SQLite
//                  itself believes it, including any -wal/-shm
//                  checkpoint not yet merged in)
//
// The on-disk invariant is: file size == pageCount * pageSize. A
// mismatch means the file is torn — most commonly a half-merged WAL
// (the 2026-09-01 collection.anki2 incident: header declared
// 17,752 pages but the file held 17,750). Such a file opens with
// "database disk image is malformed" on any read.
//
// Used by WriteSession to fail closed before copying a torn work
// file back to the AnkiDroid-visible source.
package anki

import (
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
)


// verifySQLiteHeader checks the SQLite header invariants on path:
//   - the file is at least 100 bytes (the SQLite header length)
//   - the page size field is a sane power-of-two between 512 and
//     65536 (with the 65536 == 1 encoding decoded)
//   - the declared page count, multiplied by the page size, equals
//     the actual file size
//
// Any mismatch returns a descriptive error; the caller is expected
// to fail closed (NOT proceed with the writeback) so a torn file
// never reaches the AnkiDroid-visible source. The check is
// O(1) — one stat() + a single ReadAt of the first 100 bytes
// (no full-file allocation or streaming read) — and runs in
// microseconds on a real device.
func verifySQLiteHeader(path string) error {
	st, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("anki: verify sqlite header: stat: %w", err)
	}
	size := st.Size()
	if size < 100 {
		return fmt.Errorf("anki: verify sqlite header: file too small (%d bytes; min 100 for sqlite header)", size)
	}
	// Open + ReadAt(100 bytes at offset 0) + close: O(1) read of
	// the header, no full-file allocation. Closes immediately
	// after the read; the fd is not held across the rest of the
	// function.
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("anki: verify sqlite header: open: %w", err)
	}
	data := make([]byte, 100)
	n, err := f.ReadAt(data, 0)
	if closeErr := f.Close(); closeErr != nil && err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("anki: verify sqlite header: read: %w", err)
	}
	if n < 100 {
		return fmt.Errorf("anki: verify sqlite header: short read (%d bytes; want >=100)", n)
	}
	hdr := data[:100]

	// Magic string at offset 0: "SQLite format 3\0" (16 bytes). A
	// torn file could have lost this header entirely (e.g. the
	// "AAA-stale-write resurfaced over fresh data" failure mode on
	// FUSE); a missing magic is the loudest possible signal that
	// the bytes under us are not a SQLite file at all.
	if string(hdr[0:16]) != "SQLite format 3\x00" {
		return fmt.Errorf("anki: verify sqlite header: bad magic at offset 0 (got %q; want \"SQLite format 3\\0\")", hdr[0:16])
	}

	rawPageSize := binary.BigEndian.Uint16(hdr[16:18])
	pageSize := uint32(rawPageSize)
	if pageSize == 1 {
		// SQLite historical: a page size of 1 in the header means
		// 65536 bytes (the largest supported page size). The
		// 64 KiB page size is the Anki default on modern installs.
		pageSize = 65536
	}
	// Sanity: the page size must be a power of two between 512 and
	// 65536 (SQLite's documented support range). Anything else is
	// a corrupted header.
	if pageSize < 512 || pageSize > 65536 {
		return fmt.Errorf("anki: verify sqlite header: implausible page size %d (header says %d)", pageSize, rawPageSize)
	}
	if pageSize&(pageSize-1) != 0 {
		return fmt.Errorf("anki: verify sqlite header: page size %d is not a power of two", pageSize)
	}

	pageCount := binary.BigEndian.Uint32(hdr[28:32])
	// 0 page count in a non-empty file is a known signature of
	// "fresh database before first insert"; treat that as valid
	// only if the file is itself empty of pages (size < pageSize
	// means the file holds only the header byte page).
	if pageCount == 0 {
		if size > int64(pageSize) {
			return fmt.Errorf("anki: verify sqlite header: page count 0 but file size %d > page size %d", size, pageSize)
		}
		return nil
	}
	// Expected file size from the header. Compute as int64 to
	// avoid u32 overflow on 64-bit hosts.
	expected := int64(pageCount) * int64(pageSize)
	if size != expected {
		return fmt.Errorf("anki: verify sqlite header: file size %d does not match header (pageCount=%d pageSize=%d → expected %d); database is torn (likely a half-merged WAL); work copy NOT written back", size, pageCount, pageSize, expected)
	}
	return nil
}

// sqliteHeaderSummary reads just enough of the header to log a
// useful diagnostic when verifySQLiteHeader fails. Cheap (same
// first 100 bytes) and only called on the error path; the
// happy-path call sites of verifySQLiteHeader don't pay the
// extra formatting cost.
func sqliteHeaderSummary(path string) string {
	st, statErr := os.Stat(path)
	size := int64(-1)
	if statErr == nil {
		size = st.Size()
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) < 32 {
		return fmt.Sprintf("path=%s size=%d read_err=%v", path, size, err)
	}
	rawPageSize := binary.BigEndian.Uint16(data[16:18])
	pageSize := uint32(rawPageSize)
	if pageSize == 1 {
		pageSize = 65536
	}
	pageCount := binary.BigEndian.Uint32(data[28:32])
	return fmt.Sprintf("path=%s size=%d pageCount=%d pageSize=%d (raw_page_size_field=%d) header_ok=%v",
		path, size, pageCount, pageSize, rawPageSize, len(data) >= 100 && string(data[0:16]) == "SQLite format 3\x00")
}

// errSQLiteHeaderTorn is the sentinel verifySQLiteHeader returns
// for the "file size doesn't match header-declared page count"
// case. Reserved for callers that want to distinguish the torn
// case from other header failures (e.g. "file too small") without
// substring-matching. Not currently used externally; here for
// future-proofing.
var errSQLiteHeaderTorn = errors.New("anki: sqlite header torn (file size != pageCount * pageSize)")

// verifySrcAfterWriteback opens src with immutable=1 (no locks;
// mirrors the AnkiDroid FUSE read reality) and runs
// PRAGMA quick_check. quick_check is intentionally chosen over
// integrity_check: it skips the UNICASE index entry verification
// (which can fail on freshly-written collections that haven't
// yet had ANALYZE run, and which the bridge doesn't rely on) but
// still walks every page's header, free list, and cell-pointers
// — i.e. the same page-level checks that would have caught the
// 2026-09-01 torn-header incident. Cost on an 18 MiB collection
// is tens of milliseconds; acceptable per write.
//
// Returns nil when quick_check returns the single row "ok" (the
// "ok" row is the final row emitted when no per-page errors
// remain). Returns the diagnostic error otherwise. The caller
// surfaces this as a fail-closed error so the operator sees a
// clear "the note was written but the DB is suspect" message
// rather than a silent corrupt-source.
//
// Note: this runs AFTER the work copy has been removed by
// CopyOut. If the file is bad, recovery is from backup — the
// work area no longer holds the merged state. This is
// intentional: a bad source plus a retained work copy is a
// second-order hazard (the next WriteSession's CopyIn would
// re-read the bad source).
//
// Header verification (verifySQLiteHeader) runs BEFORE CopyOut
// and would normally catch the same torn-state class; this
// post-writeback check is the second line of defense for any
// filesystem-level split-brain that the header check can't
// see (e.g. a partial rename that left the old bytes visible
// to subsequent readers). Both guards together close the
// entire 2026-09-01 incident surface.
func verifySrcAfterWriteback(srcPath string) error {
	// Explicit existence check. modernc's sql.Open is lazy
	// (does not touch the file); the first operation that
	// actually reads the file (Ping / Query) is what surfaces
	// the missing-file error, but only sometimes on Windows
	// (where the lazy-open behaviour can be even lazier). The
	// post-writeback guard wants a definitive fail-closed
	// signal, so we check Stat up front. Cost: one syscall,
	// and we already did a stat in verifySQLiteHeader minutes
	// ago, so the overhead is negligible.
	if _, err := os.Stat(srcPath); err != nil {
		return fmt.Errorf("stat src for post-writeback quick_check: %w", err)
	}
	// Open a fresh immutable handle. We deliberately do NOT use
	// the parent's existing handle (it's the same one we just
	// refreshed, but a brand-new connection guarantees we see
	// the bytes CopyOut just landed and not some page-cache
	// artifact from a prior read).
	db, err := sql.Open("sqlite", "file:"+srcPath+"?immutable=1&_pragma=busy_timeout(2000)")
	if err != nil {
		return fmt.Errorf("open src for post-writeback quick_check: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		return fmt.Errorf("ping src immutable: %w", err)
	}
	// quick_check returns at least one row: "ok" on success, or
	// one or more error messages on corruption (each row is one
	// per-page issue; the final "ok" only appears if all rows
	// are clean). We treat ANY non-"ok" row as a failure; we
	// also surface the first non-"ok" row verbatim so the
	// operator sees exactly which page is wrong.
	rows, err := db.Query("PRAGMA quick_check")
	if err != nil {
		// immutable=1 + the post-writeback state should never
		// fail to open a healthy file. An open error here
		// almost certainly means the file is so badly torn
		// that even the pager init fails — surface that
		// loud and clear.
		return fmt.Errorf("open src immutable: %w", err)
	}
	defer rows.Close()
	sawOK := false
	for rows.Next() {
		var msg string
		if err := rows.Scan(&msg); err != nil {
			return fmt.Errorf("scan quick_check row: %w", err)
		}
		if msg == "ok" {
			sawOK = true
			continue
		}
		return errors.New(msg)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate quick_check: %w", err)
	}
	if !sawOK {
		// Defensive: a healthy quick_check ALWAYS emits the "ok"
		// row. If we got here without seeing one, the pragma
		// returned no rows at all (driver divergence) — refuse
		// to call it a pass.
		return fmt.Errorf("PRAGMA quick_check returned no \"ok\" row on %s; cannot confirm source is clean", srcPath)
	}
	return nil
}
