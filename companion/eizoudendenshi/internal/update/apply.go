package update

import (
	"errors"
	"fmt"
	"io"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// parentPollInterval is how often the --apply-update child re-checks
// whether the parent has exited.
const parentPollInterval = 200 * time.Millisecond

// ApplyStaged implements the internal --apply-update child mode:
//
//	apply-update <staging> <parentPID> <coreTarget> <ytdlpTarget> <ffmpegTarget>
//
// It waits (bounded) for the parent to exit, replaces the staged
// core/helpers with backup+rollback (helpers first; the core LAST, and
// the old core is kept on any failure), then exits silently on success.
// The parent (CLI) prints the update-complete message before exiting;
// the apply-child is silent on success and only writes to stderr on
// failure. The new core is deliberately NOT auto-launched from here: a
// process started by this child does not own a usable console stdin on
// Windows (console-handle inheritance), so an auto-started CLI could not
// read its "Option:" prompt — the user runs `grkd-edds` manually from
// their own terminal, where stdin works. The pairing credential is
// never read, written, or replaced.
//
// Every failure path writes a reason to stderr before returning 1: the
// child is launched detached (stdout/stderr inherited from the CLI), so
// without this a failed apply is indistinguishable from a success. Only
// error classes and local paths are printed — nothing sensitive (no
// credentials, no network identifiers).
func ApplyStaged(args []string) int {
	if len(args) != 5 {
		fmt.Fprintln(os.Stderr, "update: apply failed: invalid arguments")
		return 1
	}
	staging := args[0]
	pid, err := strconv.Atoi(args[1])
	if err != nil || pid <= 0 {
		fmt.Fprintln(os.Stderr, "update: apply failed: invalid parent pid")
		return 1
	}
	coreTarget := args[2]
	ytdlpTarget := args[3]
	ffmpegTarget := args[4]
	for _, t := range []string{coreTarget, ytdlpTarget, ffmpegTarget} {
		if t != "" && !filepath.IsAbs(t) {
			fmt.Fprintln(os.Stderr, "update: apply failed: target paths must be absolute")
			return 1
		}
	}
	if coreTarget == "" {
		fmt.Fprintln(os.Stderr, "update: apply failed: core target missing")
		return 1
	}
	st, err := os.Stat(staging)
	if err != nil || !st.IsDir() {
		fmt.Fprintln(os.Stderr, "update: apply failed: staging directory missing or invalid")
		return 1
	}
	// The staging dir is owned by this child from here on.
	defer os.RemoveAll(staging)

	// Bounded parent-exit wait: the parent must exit before the running
	// core can be replaced (on Windows the running exe is locked until
	// then; everywhere the spec demands parent-first replacement).
	deadline := time.Now().Add(maxParentWait)
	for parentAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(parentPollInterval)
	}
	if parentAlive(pid) {
		fmt.Fprintln(os.Stderr, "update: apply failed: parent did not exit within the wait window")
		return 1 // parent never exited: keep the old core
	}

	// Helpers first (any failure aborts BEFORE the core is touched);
	// the core last, with backup+rollback inside replaceStaged.
	applyOrder := []string{ytdlpTarget, ffmpegTarget, coreTarget}
	for _, target := range applyOrder {
		if target == "" {
			continue
		}
		if err := replaceStaged(staging, target); err != nil {
			fmt.Fprintf(os.Stderr, "update: apply failed: %v\n", err)
			return 1
		}
	}

	// The replaced core is not launched from here (see the doc comment):
	// the parent (CLI) prints the update-complete message before exiting.
	// The apply-child is silent on success; only failures write to stderr.
	return 0
}

// replaceStaged replaces target with the staged file of the same
// basename, backing up the current target and rolling back on failure
// (the old file is never lost). Staging must already contain a
// verified non-empty file named filepath.Base(target).
//
// Both renames go through renameRetry: on Windows the just-exited
// parent's image section may hold the core target for a few hundred ms
// past process exit, and a rename attempted inside that window fails
// with a sharing violation instead of replacing the file (the rc.25
// failure mode: staging deleted, core left behind). The retry covers
// that window; every other error still fails immediately.
func replaceStaged(staging, target string) error {
	staged := filepath.Join(staging, filepath.Base(target))
	fi, err := os.Stat(staged)
	if err != nil || fi.IsDir() || fi.Size() == 0 {
		return errors.New("update: staged file is invalid")
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	bak := target + ".bak"
	_ = removeRetry(bak) // stale backup from a crashed run
	if _, err := os.Lstat(target); err == nil {
		if err := renameRetry(target, bak); err != nil {
			return err
		}
	}
	if err := renameRetry(staged, target); err != nil {
		// Roll the backup back so the old file is kept.
		_ = os.Remove(target)
		if _, lerr := os.Lstat(bak); lerr == nil {
			_ = os.Rename(bak, target)
		}
		return err
	}
	// On Windows the just-exited parent's image section may still hold
	// the old core for a few hundred ms; retry briefly instead of
	// leaving a stale .bak behind. A final failure is harmless (the
	// backup is never executed or referenced).
	_ = removeRetry(bak)
	return nil
}

// removeRetry removes path, retrying briefly while the file is
// transiently locked (e.g. a just-exited process releasing its image
// section on Windows).
func removeRetry(path string) error {
	var err error
	for i := 0; i < 10; i++ {
		err = os.Remove(path)
		if err == nil || os.IsNotExist(err) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return err
}

// renameRetryAttempts and renameRetryDelay bound the transient-lock
// retry window of renameRetry. Vars so tests can shrink them.
var (
	renameRetryAttempts = 10
	renameRetryDelay    = 100 * time.Millisecond
)

// renameFile is os.Rename, a var so tests can inject transient failures
// without touching the filesystem.
var renameFile = os.Rename

// renameRetry renames oldpath to newpath, retrying briefly while the
// failure is a transient Windows lock (a just-exited parent may hold its
// image section — and thus the running core target — for a few hundred
// ms past process exit; the comment above the second replaceStaged
// rename is the same situation). Only transient errors (sharing/lock
// violations) are retried; a cross-device failure (EXDEV /
// ERROR_NOT_SAME_DEVICE) falls back to copy+remove immediately — it can
// never succeed, however often retried; any other error returns
// immediately, and on POSIX (including Termux) nothing is transient, so
// this is exactly one attempt.
func renameRetry(oldpath, newpath string) error {
	var err error
	for i := 0; i < renameRetryAttempts; i++ {
		err = renameFile(oldpath, newpath)
		if err == nil {
			return nil
		}
		if isCrossDeviceRenameErr(err) {
			return copyThenRemove(oldpath, newpath)
		}
		if !transientRenameErr(err) {
			return err
		}
		time.Sleep(renameRetryDelay)
	}
	return err
}

// copyThenRemove is the cross-device rename fallback: copies oldpath to
// newpath (created fresh, preserving oldpath's permission bits) and
// removes oldpath on success. os.Rename cannot move a file across
// devices (ERROR_NOT_SAME_DEVICE on Windows, EXDEV on POSIX) — e.g. a
// RAM-disk staging dir (A:) with the install target on C: — so the
// file is copied instead. A copy that fails mid-way removes the partial
// newpath before returning the error: an incomplete core/helper left at
// the install target would break the next launch.
func copyThenRemove(oldpath, newpath string) error {
	src, err := os.Open(oldpath)
	if err != nil {
		return err
	}
	fi, err := src.Stat()
	if err != nil {
		_ = src.Close()
		return err
	}
	dst, err := os.OpenFile(newpath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, fi.Mode().Perm())
	if err != nil {
		_ = src.Close()
		return err
	}
	_, copyErr := io.Copy(dst, src)
	closeErr := dst.Close()
	// src must be closed BEFORE os.Remove: Windows refuses to remove a
	// file that still has an open handle (no POSIX unlink semantics).
	_ = src.Close()
	if copyErr != nil || closeErr != nil {
		// Never leave a partial file at the install target.
		_ = os.Remove(newpath)
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	}
	return os.Remove(oldpath)
}

// spawnApply launches the --apply-update child with ONLY the staging
// path, the parent PID, and the target paths. On Windows the child is
// launched from a COPY of the running executable under the OS temp dir
// (see applyChildExe); on other platforms the running executable is
// used directly. A var so tests never spawn a real child.
var spawnApply = func(staging string, plan *applyPlan) error {
	exe, err := applyChildExe()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "apply-update",
		staging, strconv.Itoa(os.Getpid()),
		plan.Core, plan.Ytdlp, plan.Ffmpeg)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Start()
}

// updaterCopyPrefix is the file-name prefix of the Windows apply-child
// executable copy (kept under the OS temp dir, outside staging: the
// child removes the staging dir, which would delete its own image).
const updaterCopyPrefix = "eizouden-updater-"

// applyChildExe returns the path the --apply-update child is launched
// from. On Windows this is a copy of the running executable under the
// OS temp dir: the child must rename the core target, and a running
// Windows image is locked against rename/delete (POSIX rename semantics
// make the running image fine on Termux, so there the running
// executable is used directly). A copy failure fails the whole update
// (update.Run reports the generic failure).
func applyChildExe() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if runtime.GOOS != "windows" {
		return exe, nil
	}
	return copyExecutableForChild(exe)
}

// copyExecutableForChild copies src to a fresh path under the OS temp
// dir (eizouden-updater-<pid>-<hex>.exe) so a child can be launched
// from a file that is not the running image. Stale copies from previous
// updates are swept first (best effort: a copy still locked by a
// running child is left for its owner, and the next update tries
// again). The copy uses io.Copy (streaming) to avoid reading the
// entire binary into memory at once.
func copyExecutableForChild(src string) (string, error) {
	if fi, err := os.Stat(src); err != nil || fi.IsDir() || fi.Size() == 0 {
		return "", errors.New("update: cannot copy the updater executable")
	}
	sweepUpdaterCopies()
	exe := filepath.Join(os.TempDir(), updaterCopyName(os.Getpid()))
	srcF, err := os.Open(src)
	if err != nil {
		return "", errors.New("update: cannot read the updater executable")
	}
	defer srcF.Close()
	fi, _ := srcF.Stat() // Stat on an open file: error discarded (extremely unlikely; would mean broken fs)
	dstF, err := os.OpenFile(exe, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o700)
	if err != nil {
		return "", errors.New("update: cannot copy the updater executable")
	}
	if _, err := io.Copy(dstF, srcF); err != nil {
		_ = dstF.Close()
		_ = os.Remove(exe)
		return "", errors.New("update: cannot copy the updater executable")
	}
	if err := dstF.Close(); err != nil {
		_ = os.Remove(exe)
		return "", errors.New("update: cannot copy the updater executable")
	}
	_ = fi // retain stat for future use if needed
	return exe, nil
}

// sweepUpdaterCopies removes leftover updater-executable copies from
// previous runs (best effort: failures — e.g. a copy still locked by a
// running child — are ignored).
func sweepUpdaterCopies() {
	matches, err := filepath.Glob(filepath.Join(os.TempDir(), updaterCopyPrefix+"*.exe"))
	if err != nil {
		return
	}
	for _, m := range matches {
		_ = os.Remove(m)
	}
}

// updaterCopyName builds the Windows apply-child copy file name. The
// pid + random suffix avoids collisions; a leftover from a crashed run
// is swept by the next update's copyExecutableForChild.
func updaterCopyName(pid int) string {
	return fmt.Sprintf("%s%d-%08x.exe", updaterCopyPrefix, pid, rand.Uint32())
}

// isTerminal reports whether f is a character device (a real terminal).
// Buffers, files, and pipes are not terminals: output stays plain.
func isTerminal(f *os.File) bool {
	st, err := f.Stat()
	if err != nil {
		return false
	}
	return st.Mode()&os.ModeCharDevice != 0
}
