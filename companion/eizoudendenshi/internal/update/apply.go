package update

import (
	"errors"
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
// the old core is kept on any failure), relaunches the new core in CLI
// mode (cli, preserving the explicit Windows helper paths), and exits.
// The pairing credential is never read, written, or replaced.
func ApplyStaged(args []string) int {
	if len(args) != 5 {
		return 1
	}
	staging := args[0]
	pid, err := strconv.Atoi(args[1])
	if err != nil || pid <= 0 {
		return 1
	}
	coreTarget := args[2]
	ytdlpTarget := args[3]
	ffmpegTarget := args[4]
	for _, t := range []string{coreTarget, ytdlpTarget, ffmpegTarget} {
		if t != "" && !filepath.IsAbs(t) {
			return 1
		}
	}
	if coreTarget == "" {
		return 1
	}
	st, err := os.Stat(staging)
	if err != nil || !st.IsDir() {
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
			return 1
		}
	}

	launch := make([]string, 0, 5)
	if runtime.GOOS == "windows" {
		if ytdlpTarget != "" {
			launch = append(launch, "--ytdlp", ytdlpTarget)
		}
		if ffmpegTarget != "" {
			launch = append(launch, "--ffmpeg", ffmpegTarget)
		}
	}
	launch = append(launch, "cli")
	if err := launchNewCore(coreTarget, launch...); err != nil {
		return 1
	}
	return 0
}

// replaceStaged replaces target with the staged file of the same
// basename, backing up the current target and rolling back on failure
// (the old file is never lost). Staging must already contain a
// verified non-empty file named filepath.Base(target).
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
		if err := os.Rename(target, bak); err != nil {
			return err
		}
	}
	if err := os.Rename(staged, target); err != nil {
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

// spawnApply launches the current executable in --apply-update child
// mode with ONLY the staging path, the parent PID, and the target
// paths. A var so tests never spawn a real child.
var spawnApply = func(staging string, plan *applyPlan) error {
	exe, err := os.Executable()
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

// launchNewCore starts the replaced core in CLI mode. A var so tests
// can stub the launch.
var launchNewCore = func(core string, args ...string) error {
	cmd := exec.Command(core, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Start()
}
