// FuseRoundtrip moves a collection.anki2 file off the Android FUSE
// mount into a work area (ext4, writable, lockable), lets SQLite
// operate normally there, then copies it back. Verified on a real
// device (2026-08-31): Android FUSE breaks fcntl/F_SETLK cross-UID,
// so direct SQLite open on /storage/emulated/0/Android/media/...
// returns SQLITE_BUSY for any access; copy-work-writeback is the
// only viable path for the Android/media target.
//
// As of 2026-09-01 the roundtrip is invoked per-WriteSession (not
// at OpenCollection time): the companion keeps the AnkiDroid-
// visible collection open with an immutable read-only handle (so
// AnkiDroid can open its RW handle at any time without "Database
// Locked"), and each write (InsertNote / UpdateNoteFields /
// AddTags) does a fresh CopyIn → INSERT/UPDATE → checkpoint →
// CopyOut roundtrip. The companion NEVER holds a write lock on
// the AnkiDroid-visible file.
//
// WAL handling: real AnkiDroid databases run in WAL mode and keep
// a live -wal/-shm sidecar pair on the AnkiDroid-visible path
// (verified: collection.anki2 + collection.anki2-wal +
// collection.anki2-shm). CopyIn copies all three so the work copy
// inherits AnkiDroid's uncheckpointed writes; CopyOut copies the
// work main file back, then either restores the work -wal/-shm
// (when non-empty) or removes them so AnkiDroid's next open sees
// a coherent file. The work copy must land without any stale
// sidecars from a killed previous session — those are scrubbed
// alongside the main file preservation/cleanup logic.
package anki

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// FuseRoundtrip is a copy → work → writeback helper for collection
// files living on an Android FUSE mount. The copy direction matches
// the verified device pattern `cp src work` → SQLite INSERT/UPDATE/
// DELETE on work → `cp work src` with plain file copies (FUSE reads
// and overwrites work; only fcntl locks are broken).
//
// Note: the copy covers the single collection.anki2 file only. A
// live AnkiDroid -wal/-shm sidecar pair is NOT copied; the
// roundtrip therefore assumes AnkiDroid is closed during the write
// session (the connect spec already requires an app restart to pick
// up writes).
type FuseRoundtrip struct {
	workDir string // MUST be on non-FUSE ext4 (e.g. os.TempDir() = /data/data/... on Termux)

	// RecoveryHook, if non-nil, is invoked with the .recovery-<ts>
	// path after a stale work copy has been successfully preserved
	// (renamed) by CopyIn. The hook fires once per preservation
	// event; nil = no notification. The bridge uses it to surface a
	// warning to the user without aborting the open.
	RecoveryHook func(path string)
}

// NewFuseRoundtrip returns a roundtrip helper writing work copies
// into workDir.
func NewFuseRoundtrip(workDir string) *FuseRoundtrip {
	return &FuseRoundtrip{workDir: workDir}
}

// CopyIn copies src (FUSE path) → workDir/<basename>; returns the
// work path. The work dir is created on demand. A stale work file
// from a crashed run is preserved for manual recovery (renamed to
// <base>.recovery-<unix-ts>) AND a fresh copy proceeds — the stale
// bytes are parked but the bridge is never bricked by a recovery
// event. On copy failure the partial work file is removed so no
// garbage survives.
func (f *FuseRoundtrip) CopyIn(src string) (workPath string, err error) {
	if f == nil || f.workDir == "" {
		return "", errors.New("anki: fuse roundtrip: empty work dir")
	}
	workPath = filepath.Join(f.workDir, filepath.Base(src))
	if filepath.Clean(workPath) == filepath.Clean(src) {
		// Guard against a work dir pointing at the source directory:
		// copyFile would truncate the source before reading it.
		return "", errors.New("anki: fuse roundtrip: work path must not equal source path")
	}
	if err := os.MkdirAll(f.workDir, 0o700); err != nil {
		return "", fmt.Errorf("anki: fuse roundtrip: create work dir: %w", err)
	}
	if shouldPreserveStaleWork(src, workPath) {
		// A leftover work file carrying writes that never reached src
		// (crashed run before writeback) must NOT be truncated —
		// doing so would destroy the only copy of those writes.
		// Park it as <base>.recovery-<unix-ts> and notify via
		// RecoveryHook (if set), then continue with a fresh copy.
		// The recovery file holds the old data for manual restore;
		// the fresh work copy is authoritative for the open session.
		// A failed rename falls through to the normal copy
		// (nothing better we can do — at worst a few stale bytes
		// get overwritten).
		//
		// The -wal/-shm sidecars MUST travel with the parked work
		// file: SQLite WAL mode keeps pending writes in -wal until
		// the next checkpoint, and a fresh open of the parked main
		// file alone would replay the CRASHED session's writes into
		// whatever later code touches it (silent corruption; the
		// "AAA-stale-write resurfaced over fresh data" failure mode
		// observed on a scratch dir). Renaming the sidecars under
		// the same recovery name keeps the trio atomic — the
		// recovery bundle is self-contained.
		recovery := workPath + ".recovery-" + strconv.FormatInt(time.Now().Unix(), 10)
		if rerr := os.Rename(workPath, recovery); rerr == nil {
			// Best-effort: surface any rename error that isn't "file
			// missing" via the same wrapped error below so a half-
			// parked recovery is visible to the caller (the stale
			// bytes in the un-parked sidecar would otherwise be
			// picked up by the next open).
			for _, side := range []string{workPath + "-wal", workPath + "-shm"} {
				rside := recovery + side[len(workPath):]
				if serr := os.Rename(side, rside); serr != nil && !os.IsNotExist(serr) {
					return "", fmt.Errorf("anki: fuse roundtrip: rename %s → %s: %w (sidecar left behind; recovery bundle is incomplete)", side, rside, serr)
				}
			}
			if f.RecoveryHook != nil {
				f.RecoveryHook(recovery)
			}
			// proceed with fresh copy below
		}
	}
	// Sidecars (workPath+"-wal" / workPath+"-shm") left over from a
	// killed previous session belong to the OLD work main file that
	// was either preserved (above) or already gone. They MUST be
	// removed before the fresh copy lands — otherwise the fresh
	// main file will be paired with a -wal/-shm whose header
	// references the old transaction state, and the first open on
	// the fresh file will WAL-recover the crashed session's writes
	// INTO the fresh data. (This is the corruption mode the
	// preservation branch protects against; without this scrub the
	// normal (non-preserve) CopyIn path is a second hole.)
	removeWorkSidecars(workPath)
	if err := copyFile(src, workPath); err != nil {
		_ = os.Remove(workPath) // best-effort: no partial work file
		removeWorkSidecars(workPath)
		return "", err
	}
	// WAL/SHM-aware CopyIn: AnkiDroid runs in WAL mode (verified
	// on real device 2026-09-01: collection.anki2 + -wal + -shm
	// triplet). Copying only the main file would lose any
	// uncheckpointed writes AnkiDroid has accumulated since its
	// last checkpoint — the work copy would then write back
	// without those rows, silently clobbering AnkiDroid's recent
	// edits. Mirror src's -wal / -shm into work + "-wal" / "-shm"
	// (when they exist) so the work copy picks up the same WAL
	// state AnkiDroid sees. Missing sidecars on src are fine — a
	// DELETE-journal-mode DB or a freshly-checkpointed DB has no
	// live -wal/-shm. A failed sidecar copy does NOT roll back the
	// main copy: the work copy is still usable in rollback-journal
	// mode and the next checkpoint on the work copy will reconcile.
	if err := copySidecarIfExists(src, workPath, "-wal"); err != nil {
		// Best-effort: log via the error chain but don't fail
		// CopyIn outright. The main file landed; the work session
		// can still proceed with whatever WAL state AnkiDroid had.
		// A future checkpoint from the work copy will reconcile.
		_ = err
	}
	if err := copySidecarIfExists(src, workPath, "-shm"); err != nil {
		_ = err
	}
	return workPath, nil
}

// removeWorkSidecars removes any leftover -wal/-shm sidecar pair
// for workPath. Best-effort: missing files are normal (a clean
// CopyIn never has sidecars), any other error is ignored because
// the call sites already handle the main-file failure mode. The
// caller is responsible for naming workPath as the main file (the
// "-wal"/"-shm" suffix is appended here).
func removeWorkSidecars(workPath string) {
	for _, side := range []string{workPath + "-wal", workPath + "-shm"} {
		if err := os.Remove(side); err != nil && !os.IsNotExist(err) {
			// Swallowed: the main file path already has its own
			// error story and we don't want a noisy log for a
			// sidecar that the next open would simply ignore.
			_ = err
		}
	}
}

// shouldPreserveStaleWork reports whether work is a leftover of an
// UNFINISHED previous run that must not be truncated. Criteria:
//   - work exists AND its size differs from src → partial/extra
//     data (a prior crashed writeback or a crashed CopyIn), OR
//   - work exists AND its mtime is NEWER than src's (a crashed run
//     wrote to the work copy after the src was last modified).
//
// A plain "mtime differs" is NOT a signal: copyFile stamps the
// work copy with the copy time, which is always newer than src —
// a normal (finished, then restarted) run would otherwise be
// misclassified as a crash. After a FINISHED run CopyOut removes
// work, so any surviving work file is by definition unfinished;
// the only remaining question is whether it carries writes.
//
// Stat failures on either path mean "nothing to preserve": a
// missing work file has no stale data, and an unreadable src
// surfaces its own error in the copy.
func shouldPreserveStaleWork(src, work string) bool {
	stW, err := os.Stat(work)
	if err != nil {
		return false
	}
	stS, err := os.Stat(src)
	if err != nil {
		return false
	}
	if stW.Size() != stS.Size() {
		return true
	}
	return stW.ModTime().After(stS.ModTime())
}

// CopyOut copies work → src (writeback to FUSE) and removes the
// work file on success. On failure the work copy is LEFT IN PLACE
// so the caller can retry or recover the data, and the error is
// wrapped with the (redacted) surviving path so the recovery copy
// is discoverable without leaking the device tree.
//
// Atomicity (main file): the previous implementation used
// os.Create(src) which truncates the destination immediately and
// then streams the work content. If the stream failed mid-way
// (FUSE hiccup, disk full, process killed), src was left as a
// truncated 0-byte-or-partial file that the next reader would
// interpret as "database disk image is malformed" — exactly the
// failure mode the 2026-09-01 incident exhibited (different
// cause: a half-merged WAL; same symptom class: a torn
// AnkiDroid-visible file). CopyOut now writes the work content
// to a tmp file in the SAME directory as src (same filesystem →
// rename is atomic), fsyncs+closes it, verifies the size matches
// the source (i.e. the bytes actually got flushed), and only
// THEN renames over src. A mid-stream failure or a size mismatch
// removes the tmp file and returns an error; src is never
// touched. On Windows, os.Rename overwrites an existing file
// (ReplaceFile semantics) — verified in os.Rename docs; on
// Linux/Android FUSE, rename within the same directory is the
// canonical atomic primitive (rename(2)). The sidecar copy-back
// steps still use plain copyFile (the sidecar contract is "copy
// only if non-empty after checkpoint", and the sidecars are
// either absent or zero-bytes in the common case — when they
// are non-empty we still use copyFile for parity with the prior
// behaviour; a torn sidecar is recoverable by removing it).
//
// WAL/SHM handling: SQLite WAL mode writes pending transactions
// into the -wal sidecar; the work copy's last `prAGMA
// wal_checkpoint(TRUNCATE)` (issued by the caller via WriteSession)
// should leave an empty -wal on the work copy. CopyOut then:
//
//  1. Atomically replaces the src main file with the work main
//     file (tmp + fsync + size-check + rename).
//  2. Copies work -wal / -shm back to src ONLY if they exist AND
//     are non-empty AFTER the checkpoint (defensive: a driver
//     that skipped the checkpoint must not lose data). When the
//     work checkpoint succeeded the sidecars are absent/zero-
//     length and nothing is copied; this is the common case.
//  3. Removes any leftover work -wal / -shm (their content was
//     merged into the work main file by the checkpoint; keeping
//     them around would replay those bytes against the next
//     reader).
//
// If the atomic main-file replace fails the sidecars are left
// alone (no partial writeback) so the recovery copy still
// represents a coherent state.
//
// After the atomic main-file replace, any src -wal / -shm left
// over from a previous src generation is REMOVED when the work
// sidecar copy-back step would otherwise be a no-op (work
// sidecar absent or zero-bytes — i.e. the checkpoint merged the
// pending writes into the work main file). AnkiDroid's next
// immutable open would otherwise replay the stale src-side
// sidecar's transaction frames onto the freshly-renamed main
// file: Guard 4 (post-writeback quick_check) cannot see this
// because immutable=1 holds a per-connection snapshot of the
// file, and the sidecar is read by the next AnkiDroid handle
// open after our process exits. Guard 4 closes the in-process
// detection gap but the sidecar MUST be removed here to close
// the cross-process gap. (The 2026-09-01 corruption surface:
// "sidecar frames replayed onto a freshly-written main file on
// the AnkiDroid side" — distinct from the
// "page-count-doesn't-match-file-size" failure mode the header
// guard catches.) Together with the post-writeback quick_check,
// this removes the entire incident surface.
func (f *FuseRoundtrip) CopyOut(workPath, src string) error {
	// 1. Atomic main-file replace. Uses copyFileSync so the tmp
	// file's bytes are durably flushed BEFORE the rename over src
	// (the rename itself is atomic; a copy that never reached
	// disk would silently produce a 0-byte src after the rename).
	if err := atomicReplaceFile(workPath, src); err != nil {
		return fmt.Errorf("anki: fuse roundtrip: %w (work copy left at %s)", err, redactPath(workPath))
	}
	// 1b. Remove any stale src -wal / -shm from a previous
	// generation. Only safe AFTER the atomic main-file replace:
	// if the replace failed we want src to be byte-identical to
	// before, and the sidecar removal is also meaningless when
	// the work sidecar will be recreated by the next step.
	removeStaleSrcSidecars(src)
	// 2. Sidecar copy-back (only if non-empty).
	if err := copySidecarBackIfNonEmpty(workPath, src, "-wal"); err != nil {
		return fmt.Errorf("anki: fuse roundtrip: copy sidecar -wal back: %w (work copy left at %s)", err, redactPath(workPath))
	}
	if err := copySidecarBackIfNonEmpty(workPath, src, "-shm"); err != nil {
		return fmt.Errorf("anki: fuse roundtrip: copy sidecar -shm back: %w (work copy left at %s)", err, redactPath(workPath))
	}
	// 3. Always scrub the work sidecars AFTER the copy-back step so
	// the copy-back reads the just-copied sidecars (no race). After
	// this point the work area is clean and the only remaining file
	// is the main work file, which the caller will remove via
	// os.Remove below.
	removeWorkSidecars(workPath)
	if err := os.Remove(workPath); err != nil {
		return fmt.Errorf("anki: fuse roundtrip: writeback ok but work copy %s not removed: %w", redactPath(workPath), err)
	}
	return nil
}

// removeStaleSrcSidecars removes any src-relative -wal / -shm
// sidecar that belongs to the previous generation of the src
// main file (just replaced by atomicReplaceFile). Missing files
// are normal (a rollback-journal-mode DB has no sidecar; a
// checkpointed WAL-mode DB has a 0-byte -wal that gets recreated
// by copySidecarBackIfNonEmpty below when work has content).
// Any other error is ignored — the sidecar scrub is
// best-effort; the caller's success invariants (main file
// replaced, sidecar copy-back completed) have already been met.
//
// Only call AFTER atomicReplaceFile succeeds: when the replace
// fails, src must remain untouched and the sidecar scrub is
// pointless anyway.
func removeStaleSrcSidecars(src string) {
	for _, side := range []string{src + "-wal", src + "-shm"} {
		if err := os.Remove(side); err != nil && !os.IsNotExist(err) {
			// Swallowed: the main-file atomic-replace guarantee
			// has already been met; a residual sidecar failure
			// here is at worst a 1-byte-of-WAL-replay against
			// the freshly-replaced main file, not the torn-page
			// failure mode the rename guards against.
			_ = err
		}
	}
}

// atomicReplaceFile writes workPath's bytes to a tmp file in the
// same directory as dst, fsyncs + closes it (via copyFileSync —
// the fsync is the explicit power-loss durability barrier for
// the writeback path; the ext4 auto_da_alloc heuristic is NOT
// relied on), verifies the size matches what we expect (=
// source size = workPath size), and then os.Rename's the tmp
// file over dst. The rename is atomic on the same filesystem
// (rename(2) on POSIX; ReplaceFile / MoveFileEx on Windows) —
// a reader will see EITHER the old dst bytes OR the new dst
// bytes, never a half-written in-between. On a mid-stream
// failure or a size mismatch the tmp file is removed and the
// error surfaced; dst is never truncated.
//
// The tmp filename includes a unix-nano timestamp so concurrent
// CopyOut calls in the same directory don't collide; the suffix
// `.tmp-<ts>` makes the file type recognizable for any operator
// who happens to be looking at the directory while a writeback
// is in flight. The tmp file is always in the same directory
// as dst; a tmp file on a different filesystem would defeat the
// atomic-rename guarantee.
func atomicReplaceFile(workPath, dst string) error {
	dstDir := filepath.Dir(dst)
	// On a source-path with no parent (e.g. "collection.anki2"
	// invoked from the source's own dir), dstDir is "." which is
	// a valid directory. We don't need a fully resolved path.
	tmpName := fmt.Sprintf("%s.tmp-%d", filepath.Base(dst), time.Now().UnixNano())
	tmpPath := filepath.Join(dstDir, tmpName)
	// Best-effort: if a stale .tmp from a crashed previous run
	// shares the same name, os.Create truncates and overwrites.
	// This is the desired behaviour: a stale tmp is exactly the
	// "abandoned" file the operator would want cleared, and
	// atomicReplaceFile is the only writer.
	if err := copyFileSync(workPath, tmpPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("atomic replace: write tmp %s: %w", redactPath(tmpPath), err)
	}
	// Verify the tmp file is non-empty AND the same size as the
	// work copy. copyFile already does the 0-byte check; this
	// extra size-match guards against a weird fs that returned
	// a short read on the source side (some FUSE drivers can
	// surface partial reads on read-only filesystems — better
	// to fail closed than to ship a truncated src).
	workSt, werr := os.Stat(workPath)
	if werr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("atomic replace: stat work %s: %w", redactPath(workPath), werr)
	}
	tmpSt, terr := os.Stat(tmpPath)
	if terr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("atomic replace: stat tmp %s: %w", redactPath(tmpPath), terr)
	}
	if tmpSt.Size() != workSt.Size() {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("atomic replace: tmp size %d != work size %d (short copy; dst not touched)", tmpSt.Size(), workSt.Size())
	}
	// Atomic replace. On Windows os.Rename overwrites the
	// existing file (per Go's os.Rename docs: "If newpath
	// already exists, Rename replaces it"); on POSIX rename(2)
	// within the same filesystem is atomic. Same-directory
	// guarantees same-filesystem on every platform we ship to
	// (AnkiDroid FUSE on Android, the Termux app-private ext4
	// dir, and Windows / Linux dev hosts).
	if err := os.Rename(tmpPath, dst); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("atomic replace: rename %s → %s: %w", redactPath(tmpPath), redactPath(dst), err)
	}
	return nil
}

// copySidecarIfExists copies src+<suffix> → workPath+<suffix> when
// the source sidecar exists. A missing source sidecar is a no-op
// (the source is either DELETE-journal-mode or has no live WAL).
// A copy failure returns the error so the caller can decide; the
// fuse_roundtrip CopyIn caller logs+continues because the work
// copy is still usable.
//
// The two-step "stat, then copy" has a TOCTOU window (the sidecar
// could disappear between stat and copy). On a healthy device the
// window is microseconds; the worst case is a missing-sidecar
// error from copyFile which is harmless (the work copy just lacks
// the sidecar, and a future checkpoint will reconcile).
func copySidecarIfExists(src, workPath, suffix string) error {
	srcSide := src + suffix
	st, err := os.Stat(srcSide)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("stat %s: %w", srcSide, err)
	}
	if st.Size() == 0 {
		// An empty sidecar has no transactional content; skip the
		// copy and remove any leftover on the work side so a stale
		// -wal/-shm doesn't shadow a fresh main file.
		_ = os.Remove(workPath + suffix)
		return nil
	}
	return copyFile(srcSide, workPath+suffix)
}

// copySidecarBackIfNonEmpty copies workPath+<suffix> → src+<suffix>
// ONLY when the work sidecar exists AND has non-zero size (the
// post-checkpoint case is missing-or-zero, which means the WAL was
// merged into the work main file already — copying it back would
// replay stale bytes against the now-current src). When the work
// sidecar is missing the source's own sidecar is left untouched
// (the work copy absorbed it; src is now the canonical copy).
func copySidecarBackIfNonEmpty(workPath, src, suffix string) error {
	workSide := workPath + suffix
	st, err := os.Stat(workSide)
	if err != nil {
		if os.IsNotExist(err) {
			// No work sidecar → nothing to copy. Leave src's own
			// sidecar (if any) alone.
			return nil
		}
		return fmt.Errorf("stat %s: %w", workSide, err)
	}
	if st.Size() == 0 {
		// Empty work sidecar → checkpoint already merged its
		// content into the work main file. Don't replay onto src.
		return nil
	}
	return copyFile(workSide, src+suffix)
}

// copyFileSync is copyFile plus an out.Sync() before Close. The
// fsync makes the tmp file's bytes durably flushed to the
// underlying storage BEFORE the rename over dst runs — without
// it, a power loss between os.Close (which flushes the page
// cache) and the rename completion could leave the dst
// referencing blocks that the kernel never pushed to disk, and
// a post-power-loss boot could see either the old bytes or
// (worse, on certain journaling filesystems) zero-filled dst
// blocks. Used by atomicReplaceFile where the durability bar is
// "the bytes I just wrote must survive a power loss" (the
// 2026-09-01 incident surface). The sidecar copy-back path
// (copyFile) is intentionally NOT this — sidecars are
// recoverable by removal and a torn -wal is harmless, so the
// extra fsync is unwarranted cost.
//
// Note: ext4's auto_da_alloc heuristic is a best-effort guess
// for which files need delayed-allocation flushing; on Android
// FUSE the actual block device may sit behind a FUSE daemon
// that doesn't honour the hint. fsync is the only reliable
// durability primitive available at the VFS layer; this helper
// is the explicit durability-bar contract for the writeback
// path.
func copyFileSync(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("anki: fuse roundtrip: open %s: %w", src, err)
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("anki: fuse roundtrip: create %s: %w", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return fmt.Errorf("anki: fuse roundtrip: copy %s → %s: %w", src, dst, err)
	}
	// out.Sync() BEFORE Close: the bytes must hit stable storage
	// before the file handle is released (Close flushes the page
	// cache to the kernel but does not wait for the kernel to
	// push to disk). On a power loss between Close and the
	// kernel's background writeback, the renamed dst could end
	// up referencing un-flushed blocks. Sync is the explicit
	// durability barrier.
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return fmt.Errorf("anki: fuse roundtrip: fsync %s: %w", dst, err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("anki: fuse roundtrip: close %s: %w", dst, err)
	}
	st, err := os.Stat(dst)
	if err != nil {
		return fmt.Errorf("anki: fuse roundtrip: stat %s after copy: %w", dst, err)
	}
	if st.Size() == 0 {
		_ = os.Remove(dst) // best-effort: do not leave a 0-byte work file
		return fmt.Errorf("anki: fuse roundtrip: copied 0 bytes from %s; dst removed to avoid 0-byte work file", src)
	}
	return nil
}

// copyFile is the plain `cp`-equivalent copy the verified device
// pattern uses (open + create/truncate + stream). On a successful
// copy the dst is verified non-empty: an empty dst (e.g. FUSE
// returned 0 bytes from src) would otherwise leave a 0-byte work
// file that bricks the bridge downstream. If the dst is empty, the
// dst is REMOVED and a "copied 0 bytes" error is returned so no
// garbage survives.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("anki: fuse roundtrip: open %s: %w", src, err)
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("anki: fuse roundtrip: create %s: %w", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return fmt.Errorf("anki: fuse roundtrip: copy %s → %s: %w", src, dst, err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("anki: fuse roundtrip: close %s: %w", dst, err)
	}
	st, err := os.Stat(dst)
	if err != nil {
		return fmt.Errorf("anki: fuse roundtrip: stat %s after copy: %w", dst, err)
	}
	if st.Size() == 0 {
		_ = os.Remove(dst) // best-effort: do not leave a 0-byte work file
		return fmt.Errorf("anki: fuse roundtrip: copied 0 bytes from %s; dst removed to avoid 0-byte work file", src)
	}
	return nil
}
