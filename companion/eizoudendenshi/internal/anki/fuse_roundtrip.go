// FuseRoundtrip moves a collection.anki2 file off the Android FUSE
// mount into a work area (ext4, writable, lockable), lets SQLite
// operate normally there, then copies it back. Verified on a real
// device (2026-08-31): Android FUSE breaks fcntl/F_SETLK cross-UID,
// so direct SQLite open on /storage/emulated/0/Android/media/...
// returns SQLITE_BUSY for any access; copy-work-writeback is the
// only viable path for the Android/media target.
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
func (f *FuseRoundtrip) CopyOut(workPath, src string) error {
	if err := copyFile(workPath, src); err != nil {
		return fmt.Errorf("%w (work copy left at %s)", err, redactPath(workPath))
	}
	if err := os.Remove(workPath); err != nil {
		return fmt.Errorf("anki: fuse roundtrip: writeback ok but work copy %s not removed: %w", redactPath(workPath), err)
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
