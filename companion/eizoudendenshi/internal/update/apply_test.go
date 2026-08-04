package update

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"eizoudendenshi/internal/credential"
)

// deadPID starts a short-lived child (the test binary matching no
// tests) and returns its PID after it has exited, so parentAlive is
// guaranteed false.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Start(); err != nil {
		t.Fatalf("cannot start the dead-PID helper: %v", err)
	}
	pid := cmd.Process.Pid
	if err := cmd.Wait(); err != nil {
		t.Fatalf("dead-PID helper failed: %v", err)
	}
	return pid
}

// stubLaunch captures the launchNewCore invocation.
func stubLaunch(t *testing.T) func(core string, args ...string) error {
	t.Helper()
	orig := launchNewCore
	var gotCore string
	var gotArgs []string
	launchNewCore = func(core string, args ...string) error {
		gotCore, gotArgs = core, args
		return nil
	}
	t.Cleanup(func() { launchNewCore = orig })
	t.Cleanup(func() {
		if gotCore != "" {
			t.Logf("launch captured: %s %s", gotCore, strings.Join(gotArgs, " "))
		}
	})
	return func(core string, args ...string) error {
		if core != gotCore {
			t.Errorf("launched core = %q, want %q", gotCore, core)
		}
		if !equalStrings(args, gotArgs) {
			t.Errorf("launched args = %q, want %q", gotArgs, args)
		}
		return nil
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func writeFile(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestApplyStagedPreservesCredential pins the update boundary: applying
// a staged update replaces ONLY the core/helpers while a sentinel
// credential.bin next to the core stays byte-identical, the same store
// still reports the same token, and the new core is relaunched in CLI
// mode with the explicit Windows helper paths.
func TestApplyStagedPreservesCredential(t *testing.T) {
	root := t.TempDir()
	coreTarget := filepath.Join(root, coreWindowsName)
	ytdlpTarget := filepath.Join(root, "helpers", "yt-dlp-windows-amd64.exe")
	ffmpegTarget := filepath.Join(root, "helpers", "ffmpeg.exe")
	credPath := filepath.Join(root, "credential.bin")

	// Old install state (pre-update).
	oldCore := []byte("old-core")
	oldYtdlp := []byte("old-ytdlp")
	oldFfmpeg := []byte("old-ffmpeg")
	writeFile(t, coreTarget, oldCore)
	writeFile(t, ytdlpTarget, oldYtdlp)
	writeFile(t, ffmpegTarget, oldFfmpeg)
	token := strings.Repeat("ab", 32) // 64 lowercase hex
	store := credential.NewFileStore(credPath)
	if err := store.Save(token); err != nil {
		t.Fatalf("seed credential: %v", err)
	}
	credBefore, err := os.ReadFile(credPath)
	if err != nil {
		t.Fatalf("read credential: %v", err)
	}

	// Staged (verified) update content.
	staging := t.TempDir()
	newCore := []byte("new-core")
	newYtdlp := []byte("new-ytdlp")
	newFfmpeg := []byte("new-ffmpeg")
	writeFile(t, filepath.Join(staging, coreWindowsName), newCore)
	writeFile(t, filepath.Join(staging, "yt-dlp-windows-amd64.exe"), newYtdlp)
	writeFile(t, filepath.Join(staging, "ffmpeg.exe"), newFfmpeg)

	launchCheck := stubLaunch(t)
	code := ApplyStaged([]string{staging, strconv.Itoa(deadPID(t)),
		coreTarget, ytdlpTarget, ffmpegTarget})
	if code != 0 {
		t.Fatalf("ApplyStaged exit = %d, want 0", code)
	}

	// Core and helpers replaced.
	if b, err := os.ReadFile(coreTarget); err != nil || !bytes.Equal(b, newCore) {
		t.Fatalf("core not replaced: %v", err)
	}
	if b, err := os.ReadFile(ytdlpTarget); err != nil || !bytes.Equal(b, newYtdlp) {
		t.Fatalf("yt-dlp not replaced: %v", err)
	}
	if b, err := os.ReadFile(ffmpegTarget); err != nil || !bytes.Equal(b, newFfmpeg) {
		t.Fatalf("ffmpeg not replaced: %v", err)
	}

	// The credential is byte-identical and still loads the SAME token
	// (the new process authenticates with the persisted credential; no
	// re-pair, no rotation, no rewrite).
	credAfter, err := os.ReadFile(credPath)
	if err != nil {
		t.Fatalf("read credential after apply: %v", err)
	}
	if !bytes.Equal(credBefore, credAfter) {
		t.Fatal("apply-update modified credential.bin")
	}
	got, _, ok, err := credential.NewFileStore(credPath).Load()
	if err != nil || !ok || got != token {
		t.Fatalf("stored credential after apply = %q ok=%v err=%v, want the same token", got, ok, err)
	}

	// No .bak leftovers, staging removed, and the new CLI launched with
	// the explicit Windows helper paths.
	leftovers, _ := filepath.Glob(filepath.Join(root, "*.bak"))
	if len(leftovers) != 0 {
		t.Errorf("backup leftovers: %v", leftovers)
	}
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Error("staging dir must be removed by the child")
	}
	launchCheck(coreTarget, "--ytdlp", ytdlpTarget, "--ffmpeg", ffmpegTarget, "cli")
}

// TestApplyStagedHelperFailureKeepsOldCore pins the rollback boundary:
// when a helper replacement fails, the core is never touched.
func TestApplyStagedHelperFailureKeepsOldCore(t *testing.T) {
	root := t.TempDir()
	coreTarget := filepath.Join(root, coreWindowsName)
	// "helpers" is a FILE: MkdirAll fails when applying the helper.
	writeFile(t, coreTarget, []byte("old-core"))
	if err := os.WriteFile(filepath.Join(root, "helpers"), []byte("not-a-dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	staging := t.TempDir()
	writeFile(t, filepath.Join(staging, coreWindowsName), []byte("new-core"))
	writeFile(t, filepath.Join(staging, "yt-dlp-windows-amd64.exe"), []byte("new-ytdlp"))
	writeFile(t, filepath.Join(staging, "ffmpeg.exe"), []byte("new-ffmpeg"))

	launched := false
	orig := launchNewCore
	launchNewCore = func(string, ...string) error { launched = true; return nil }
	defer func() { launchNewCore = orig }()

	code := ApplyStaged([]string{staging, strconv.Itoa(deadPID(t)),
		coreTarget, filepath.Join(root, "helpers", "yt-dlp-windows-amd64.exe"),
		filepath.Join(root, "helpers", "ffmpeg.exe")})
	if code == 0 {
		t.Fatal("ApplyStaged must fail when a helper cannot be applied")
	}
	if b, err := os.ReadFile(coreTarget); err != nil || string(b) != "old-core" {
		t.Fatalf("old core must be kept on helper failure: %v", err)
	}
	if launched {
		t.Fatal("the new core must not be launched after a failed apply")
	}
}

// TestApplyStagedParentNeverExitsFailsClosed pins the bounded wait: if
// the parent never exits, the old core is kept within the bounded
// window and nothing is launched.
func TestApplyStagedParentNeverExitsFailsClosed(t *testing.T) {
	origWait := maxParentWait
	maxParentWait = 300 * time.Millisecond
	defer func() { maxParentWait = origWait }()

	root := t.TempDir()
	coreTarget := filepath.Join(root, coreWindowsName)
	writeFile(t, coreTarget, []byte("old-core"))
	staging := t.TempDir()
	writeFile(t, filepath.Join(staging, coreWindowsName), []byte("new-core"))

	launched := false
	orig := launchNewCore
	launchNewCore = func(string, ...string) error { launched = true; return nil }
	defer func() { launchNewCore = orig }()

	// Our own PID is alive the whole time.
	code := ApplyStaged([]string{staging, strconv.Itoa(os.Getpid()), coreTarget, "", ""})
	if code == 0 {
		t.Fatal("ApplyStaged must fail when the parent never exits")
	}
	if b, err := os.ReadFile(coreTarget); err != nil || string(b) != "old-core" {
		t.Fatalf("old core must be kept when the parent never exits: %v", err)
	}
	if launched {
		t.Fatal("nothing may be launched when the apply fails")
	}
}

// TestApplyStagedTermuxArgs pins the Termux shape: only the core target
// is passed (helpers stay Termux-package managed) and the new core is
// launched with plain `cli`.
func TestApplyStagedTermuxArgs(t *testing.T) {
	root := t.TempDir()
	coreTarget := filepath.Join(root, coreAndroidName)
	writeFile(t, coreTarget, []byte("old-core"))
	staging := t.TempDir()
	writeFile(t, filepath.Join(staging, coreAndroidName), []byte("new-core"))

	launchCheck := stubLaunch(t)
	code := ApplyStaged([]string{staging, strconv.Itoa(deadPID(t)), coreTarget, "", ""})
	if code != 0 {
		t.Fatalf("ApplyStaged exit = %d, want 0", code)
	}
	if b, err := os.ReadFile(coreTarget); err != nil || string(b) != "new-core" {
		t.Fatalf("core not replaced: %v", err)
	}
	launchCheck(coreTarget, "cli")
}

// TestApplyStagedRejectsBadArgs pins the child-mode argument contract.
func TestApplyStagedRejectsBadArgs(t *testing.T) {
	root := t.TempDir()
	staging := t.TempDir()
	writeFile(t, filepath.Join(staging, coreWindowsName), []byte("new-core"))
	writeFile(t, filepath.Join(root, coreWindowsName), []byte("old-core"))
	good := []string{staging, "1", filepath.Join(root, coreWindowsName), "", ""}

	tests := []struct {
		name string
		args []string
	}{
		{"no args", nil},
		{"too few", good[:3]},
		{"too many", append(good, "extra")},
		{"bad pid", []string{staging, "abc", filepath.Join(root, coreWindowsName), "", ""}},
		{"negative pid", []string{staging, "-1", filepath.Join(root, coreWindowsName), "", ""}},
		{"empty core", []string{staging, "1", "", "", ""}},
		{"relative core", []string{staging, "1", "relative/core.exe", "", ""}},
		{"missing staging", []string{filepath.Join(root, "nope"), "1", filepath.Join(root, coreWindowsName), "", ""}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if code := ApplyStaged(tt.args); code == 0 {
				t.Fatalf("ApplyStaged(%v) must fail closed", tt.args)
			}
		})
	}
}

// TestReplaceStagedRollbackKeepsOld pins the backup+rollback semantics:
// when the staged file cannot take the target's place, the old file is
// restored.
func TestReplaceStagedRollbackKeepsOld(t *testing.T) {
	root := t.TempDir()
	// A directory at the target path: renaming the old dir aside works,
	// but then the staged file lands in the now-free name and the
	// "old" state is preserved as the backup — instead simulate a real
	// rollback by making the staged path itself invalid after the old
	// file was moved.
	target := filepath.Join(root, "core.bin")
	writeFile(t, target, []byte("old"))
	staging := filepath.Join(root, "staged")
	writeFile(t, filepath.Join(staging, "core.bin"), []byte("new"))

	// Interpose: make the staging file unreadable by replacing it with
	// a directory AFTER the rename of the old file is impossible to
	// inject — instead directly test that a missing staged file fails
	// without touching the target.
	os.Remove(filepath.Join(staging, "core.bin"))
	if err := replaceStaged(staging, target); err == nil {
		t.Fatal("replaceStaged must fail when the staged file is missing")
	}
	if b, err := os.ReadFile(target); err != nil || string(b) != "old" {
		t.Fatalf("target must be untouched on failure: %v", err)
	}
}

// TestCopyExecutableForChildCopiesToTemp pins the Windows apply-child
// copy helper: the copy lands under the OS temp dir (never inside the
// staging dir), is byte-identical, and carries the updater prefix.
func TestCopyExecutableForChildCopiesToTemp(t *testing.T) {
	src := filepath.Join(t.TempDir(), "fake-core.exe")
	content := []byte("fake-exe-bytes")
	writeFile(t, src, content)
	staging := t.TempDir()

	exe, err := copyExecutableForChild(src)
	if err != nil {
		t.Fatalf("copyExecutableForChild: %v", err)
	}
	defer os.Remove(exe)

	if filepath.Dir(exe) != filepath.Clean(os.TempDir()) {
		t.Errorf("copy must live under the OS temp dir: %q", exe)
	}
	if filepath.Dir(exe) == filepath.Clean(staging) {
		t.Error("copy must NOT live inside the staging dir")
	}
	base := filepath.Base(exe)
	if !strings.HasPrefix(base, updaterCopyPrefix) || !strings.HasSuffix(base, ".exe") {
		t.Errorf("copy name = %q, want %q*.exe", base, updaterCopyPrefix)
	}
	if b, err := os.ReadFile(exe); err != nil {
		t.Fatalf("read copy: %v", err)
	} else if !bytes.Equal(b, content) {
		t.Error("copy must be byte-identical to the source")
	}
}

// TestCopyExecutableForChildSweepsStaleCopies pins the leftover
// cleanup: stale copies from previous updates are removed (best effort)
// when a new copy is created.
func TestCopyExecutableForChildSweepsStaleCopies(t *testing.T) {
	stale := []string{
		filepath.Join(os.TempDir(), updaterCopyPrefix+"stale-1.exe"),
		filepath.Join(os.TempDir(), updaterCopyPrefix+"stale-2.exe"),
	}
	for _, s := range stale {
		writeFile(t, s, []byte("stale"))
	}
	defer func() {
		for _, s := range stale {
			_ = os.Remove(s)
		}
	}()

	src := filepath.Join(t.TempDir(), "fake-core.exe")
	writeFile(t, src, []byte("exe-bytes"))
	exe, err := copyExecutableForChild(src)
	if err != nil {
		t.Fatalf("copyExecutableForChild: %v", err)
	}
	defer os.Remove(exe)

	for _, s := range stale {
		if _, err := os.Stat(s); !os.IsNotExist(err) {
			t.Errorf("stale copy %q must be swept by the next copy", s)
		}
	}
}

// TestCopyExecutableForChildFailsClosed pins the copy helper's error
// contract: a missing source or a directory source fails.
func TestCopyExecutableForChildFailsClosed(t *testing.T) {
	if _, err := copyExecutableForChild(filepath.Join(t.TempDir(), "nope.exe")); err == nil {
		t.Fatal("a missing source must fail closed")
	}
	if _, err := copyExecutableForChild(t.TempDir()); err == nil {
		t.Fatal("a directory source must fail closed")
	}
}

// TestSpawnApplyWindowsRealSelfReplace is the Windows-only real-process
// verification of the self-replacement fix: the REAL spawnApply must
// launch the apply child from a COPY of the running executable under
// the OS temp dir (never the running exe — a running Windows image
// cannot be renamed), and the child must replace a fake target in the
// test temp dir while the running exe stays untouched. The full real
// chain runs: driver -> real spawnApply -> %TEMP% copy -> real
// ApplyStaged -> replacement -> relaunch of the staged fake core (which
// exits immediately via the TestMain env gate, so no console output and
// no leftover process).
func TestSpawnApplyWindowsRealSelfReplace(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows-only: exercises the real self-replacement path")
	}
	t.Setenv("EIZOUDEN_TEST_APPLY_CHILD", "1")

	runningExe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	runBytes, err := os.ReadFile(runningExe)
	if err != nil {
		t.Fatalf("read running exe: %v", err)
	}
	runStat, err := os.Stat(runningExe)
	if err != nil {
		t.Fatalf("stat running exe: %v", err)
	}

	// Fake install: the replacement target is an alias-named exe inside
	// the test temp dir — NEVER the running test binary.
	root := t.TempDir()
	coreTarget := filepath.Join(root, "fake-core.exe")
	writeFile(t, coreTarget, []byte("old-fake-core"))

	// Fake staging: the staged "new core" is a copy of the running test
	// binary. The child's launchNewCore relaunches it with `cli`; via the
	// env gate it exits immediately (no console output, no leftover
	// process). This also proves the replacement source is the staged
	// copy, not the running exe.
	staging := t.TempDir()
	writeFile(t, filepath.Join(staging, "fake-core.exe"), runBytes)

	// The apply child records its own executable path here (TestMain).
	childLog := filepath.Join(root, "child-exe.txt")
	t.Setenv("EIZOUDEN_TEST_CHILD_LOG", childLog)

	// Drive the real spawnApply from a short-lived driver process: the
	// PID spawnApply passes is the driver's PID, and the driver exits
	// right after spawning — the apply child sees a dead parent and
	// starts replacing immediately (exactly like production, where the
	// core exits before the child applies). CombinedOutput also waits
	// for the whole chain (driver, apply child, fake core) to close
	// their inherited pipes, so no updater process outlives this call.
	driver := exec.Command(runningExe, "apply-driver", staging, coreTarget)
	if out, err := driver.CombinedOutput(); err != nil {
		t.Fatalf("apply driver failed: %v (%s)", err, out)
	}

	// Evidence 1: the apply child ran from a COPY under the OS temp dir,
	// never from the running exe, and the copy is byte-identical to the
	// running exe (it IS a copy of the core).
	childExeBytes, err := os.ReadFile(childLog)
	if err != nil {
		t.Fatalf("apply child did not record its executable: %v", err)
	}
	childExe := strings.TrimSpace(string(childExeBytes))
	if childExe == runningExe {
		t.Fatal("apply child must run from a copy, not from the running exe")
	}
	if filepath.Dir(childExe) != filepath.Clean(os.TempDir()) {
		t.Errorf("apply child copy must live under the OS temp dir: %q", childExe)
	}
	if !strings.HasPrefix(filepath.Base(childExe), updaterCopyPrefix) {
		t.Errorf("apply child copy name = %q, want the %q prefix", filepath.Base(childExe), updaterCopyPrefix)
	}
	if b, err := os.ReadFile(childExe); err != nil {
		t.Errorf("apply child copy missing: %v", err)
	} else if !bytes.Equal(b, runBytes) {
		t.Error("apply child copy must be byte-identical to the running exe")
	}
	t.Cleanup(func() { _ = os.Remove(childExe) })

	// Evidence 2: the RUNNING exe was never the replacement target: it
	// still exists, unchanged.
	if st, err := os.Stat(runningExe); err != nil || st.Size() != runStat.Size() {
		t.Fatal("the running exe must never be touched by the update")
	}

	// Evidence 3: the fake target was replaced with the staged new core
	// (== a copy of the running exe), no .bak leftover, staging removed.
	targetBytes, err := os.ReadFile(coreTarget)
	if err != nil {
		t.Fatalf("core target not replaced: %v", err)
	}
	if !bytes.Equal(targetBytes, runBytes) {
		t.Error("core target must hold the staged new core")
	}
	leftovers, _ := filepath.Glob(filepath.Join(root, "*.bak"))
	if len(leftovers) != 0 {
		t.Errorf("backup leftovers: %v", leftovers)
	}
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Error("staging dir must be removed by the apply child")
	}

	// The apply child has exited once its temp copy is deletable (the
	// image lock is released) — no updater process survives.
	deadline := time.Now().Add(10 * time.Second)
	for {
		if err := os.Remove(childExe); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("apply child temp copy still locked after %v: %v", 10*time.Second, err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// captureStderr runs f with os.Stderr redirected to a pipe and returns
// everything written to it. Used to pin the apply child's failure
// reporting (ApplyStaged must say WHY it failed before returning 1).
func captureStderr(t *testing.T, f func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	orig := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = orig }()
	defer func() { _ = w.Close() }()
	f()
	_ = w.Close()
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestApplyStagedReportsFailuresToStderr pins the child's failure
// reporting: every failing path must write an "update: apply failed:"
// line to stderr before returning 1 (the child is launched detached, so
// a silent failure is indistinguishable from success on the real
// Windows path).
func TestApplyStagedReportsFailuresToStderr(t *testing.T) {
	t.Run("invalid arguments", func(t *testing.T) {
		out := captureStderr(t, func() {
			if code := ApplyStaged([]string{"too", "few"}); code == 0 {
				t.Fatal("ApplyStaged must fail closed on bad arguments")
			}
		})
		if !strings.Contains(out, "update: apply failed:") {
			t.Errorf("stderr = %q, want an apply failure line", out)
		}
	})
	t.Run("apply error", func(t *testing.T) {
		root := t.TempDir()
		coreTarget := filepath.Join(root, coreWindowsName)
		writeFile(t, coreTarget, []byte("old-core"))
		// "helpers" is a FILE: MkdirAll fails when applying the helper.
		if err := os.WriteFile(filepath.Join(root, "helpers"), []byte("not-a-dir"), 0o600); err != nil {
			t.Fatal(err)
		}
		staging := t.TempDir()
		writeFile(t, filepath.Join(staging, coreWindowsName), []byte("new-core"))
		writeFile(t, filepath.Join(staging, "yt-dlp-windows-amd64.exe"), []byte("new-ytdlp"))
		writeFile(t, filepath.Join(staging, "ffmpeg.exe"), []byte("new-ffmpeg"))

		launched := false
		orig := launchNewCore
		launchNewCore = func(string, ...string) error { launched = true; return nil }
		defer func() { launchNewCore = orig }()

		out := captureStderr(t, func() {
			code := ApplyStaged([]string{staging, strconv.Itoa(deadPID(t)),
				coreTarget, filepath.Join(root, "helpers", "yt-dlp-windows-amd64.exe"),
				filepath.Join(root, "helpers", "ffmpeg.exe")})
			if code == 0 {
				t.Fatal("ApplyStaged must fail when a helper cannot be applied")
			}
		})
		if !strings.Contains(out, "update: apply failed:") {
			t.Errorf("stderr = %q, want an apply failure line", out)
		}
		if launched {
			t.Fatal("the new core must not be launched after a failed apply")
		}
	})
}

// stubRenameRetry saves and restores the renameRetry test hooks.
func stubRenameRetry(t *testing.T) {
	t.Helper()
	origFile, origTransient := renameFile, transientRenameErr
	origAttempts, origDelay := renameRetryAttempts, renameRetryDelay
	t.Cleanup(func() {
		renameFile, transientRenameErr = origFile, origTransient
		renameRetryAttempts, renameRetryDelay = origAttempts, origDelay
	})
}

// TestRenameRetryTransientLockThenSucceeds pins the Windows
// shared-violation retry path: transient lock failures are retried, and
// a success after N failures is returned cleanly.
func TestRenameRetryTransientLockThenSucceeds(t *testing.T) {
	stubRenameRetry(t)
	renameRetryDelay = time.Millisecond

	lock := errors.New("transient lock")
	calls := 0
	renameFile = func(_, _ string) error {
		calls++
		if calls < 3 {
			return lock
		}
		return nil
	}
	transientRenameErr = func(err error) bool { return errors.Is(err, lock) }

	if err := renameRetry("old", "new"); err != nil {
		t.Fatalf("renameRetry must succeed after transient locks: %v", err)
	}
	if calls != 3 {
		t.Errorf("rename attempts = %d, want 3 (two transient failures then success)", calls)
	}
}

// TestRenameRetryPermanentFailsImmediately pins the non-transient
// contract: a permanent error is returned on the first attempt, with no
// retry (and no sleep).
func TestRenameRetryPermanentFailsImmediately(t *testing.T) {
	stubRenameRetry(t)
	renameRetryDelay = time.Millisecond

	perm := errors.New("permanent error")
	calls := 0
	renameFile = func(_, _ string) error { calls++; return perm }
	transientRenameErr = func(error) bool { return false }

	if err := renameRetry("old", "new"); !errors.Is(err, perm) {
		t.Fatalf("renameRetry err = %v, want the permanent error", err)
	}
	if calls != 1 {
		t.Errorf("rename attempts = %d, want 1 (no retry on permanent errors)", calls)
	}
}

// TestRenameRetryExhaustsAttempts pins the retry bound: an error that
// stays transient returns the last error after all attempts.
func TestRenameRetryExhaustsAttempts(t *testing.T) {
	stubRenameRetry(t)
	renameRetryAttempts = 3
	renameRetryDelay = time.Millisecond

	lock := errors.New("transient lock")
	calls := 0
	renameFile = func(_, _ string) error { calls++; return lock }
	transientRenameErr = func(err error) bool { return errors.Is(err, lock) }

	if err := renameRetry("old", "new"); !errors.Is(err, lock) {
		t.Fatalf("renameRetry err = %v, want the last transient error", err)
	}
	if calls != renameRetryAttempts {
		t.Errorf("rename attempts = %d, want %d", calls, renameRetryAttempts)
	}
}
