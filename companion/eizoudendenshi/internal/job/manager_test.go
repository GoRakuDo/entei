package job

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// fakeHelper is the compiled test-only helper binary; built once in
// TestMain from testdata/fakehelper.
var fakeHelper string

func TestMain(m *testing.M) {
	_, thisFile, _, _ := runtime.Caller(0)
	pkgDir := filepath.Dir(thisFile)
	dir, err := os.MkdirTemp("", "entei-fake-helper-*")
	if err != nil {
		fmt.Fprintf(os.Stderr, "temp dir: %v\n", err)
		os.Exit(1)
	}
	exe := "fakehelper"
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	fakeHelper = filepath.Join(dir, exe)
	build := exec.Command("go", "build", "-o", fakeHelper, "./testdata/fakehelper")
	build.Dir = pkgDir
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build fake helper: %v\n%s", err, out)
		os.RemoveAll(dir)
		os.Exit(1)
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// newTestManager builds a manager over the fake helper with a short default
// timeout.
func newTestManager(t *testing.T, timeout time.Duration) *Manager {
	t.Helper()
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	m, err := New(Config{HelperPath: fakeHelper, Timeout: timeout})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m
}

// setFakeEnv sets helper-controlling environment variables for the
// (inherited) child processes of this test's manager.
func setFakeEnv(t *testing.T, k, v string) {
	t.Helper()
	if v == "" {
		t.Setenv(k, "")
		return
	}
	t.Setenv(k, v)
}

func TestNewRequiresHelperPath(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("New with empty helper path must fail")
	}
}

func TestStartValidatesURL(t *testing.T) {
	m := newTestManager(t, 0)
	for _, bad := range []string{
		"http://www.youtube.com/watch?v=abcdefghijk",
		"https://google.com/watch?v=abcdefghijk",
		"https://www.youtube.com/watch?v=short",
		"not a url",
		"",
	} {
		if _, err := m.Start(bad); err == nil {
			t.Errorf("Start(%q) should fail validation", bad)
		}
	}
	if m.Current() != nil {
		t.Fatal("no job should exist after rejected starts")
	}
}

func TestConflictOneActiveJob(t *testing.T) {
	m := newTestManager(t, 0)
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "0")
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if snap.State != StateQueued && snap.State != StateDownloading {
		t.Fatalf("state = %s, want queued/downloading", snap.State)
	}
	if _, err := m.Start("https://youtu.be/abcdefghijk"); !errors.Is(err, ErrConflict) {
		t.Fatalf("second Start err = %v, want ErrConflict", err)
	}
	if _, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	// Session freed: a new job is accepted again.
	snap2, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start after cancel: %v", err)
	}
	if snap2.ID == snap.ID {
		t.Fatal("job ids must be distinct")
	}
	_, _ = m.Cancel(snap2.ID)
}

func TestFixedArgsNoInjection(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	setFakeEnv(t, "EIZOU_FAKE_ARGS_OUT", argsFile)
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "0")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	m := newTestManager(t, 0)
	url := "https://www.youtube.com/watch?v=abcdefghijk"
	snap, err := m.Start(url)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _, _ = m.Cancel(snap.ID) }()

	// Wait for the helper to record its argv.
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(argsFile); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("helper never recorded argv")
		}
		time.Sleep(20 * time.Millisecond)
	}
	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read args: %v", err)
	}
	argv := strings.Split(strings.TrimSpace(string(raw)), "\n")

	want := []string{
		"--no-playlist",
		"--no-part",
		"--no-progress",
		"--no-write-info-json",
		"--no-write-thumbnail",
		"-f", fixedFormat,
		"-o",
	}
	if len(argv) != len(want)+2 { // -o value + url
		t.Fatalf("argv = %v, want fixed vector + url", argv)
	}
	for i := range want {
		if argv[i] != want[i] {
			t.Errorf("argv[%d] = %q, want %q", i, argv[i], want[i])
		}
	}
	if !strings.HasSuffix(argv[len(want)], "media.%(ext)s") {
		t.Errorf("-o value %q must resolve inside the job dir with the fixed template", argv[len(want)])
	}
	if argv[len(argv)-1] != url {
		t.Errorf("final argv element = %q, want the canonical url %q", argv[len(argv)-1], url)
	}
	// No user value may appear anywhere except the final URL element.
	for i, a := range argv {
		if strings.Contains(a, ";") || strings.Contains(a, "&&") {
			t.Errorf("argv[%d] %q contains shell metacharacters", i, a)
		}
	}
}

func TestInjectionShapedURLsAreRejected(t *testing.T) {
	m := newTestManager(t, 0)
	for _, nasty := range []string{
		"https://www.youtube.com/watch?v=abcdefghijk;rm%20-rf%20%2F",
		"https://www.youtube.com/watch?v=abcdefghijk && whoami",
		"https://youtu.be/abcdefghijk/../../../../etc",
	} {
		if _, err := m.Start(nasty); err == nil {
			t.Errorf("Start(%q) must be rejected", nasty)
		}
	}
}

func TestDownloadGrowingThenComplete(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "900")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK", "300")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK_DELAY_MS", "250")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Watch availability grow while downloading (total unknown = 0).
	seenGrowing := false
	deadline := time.Now().Add(8 * time.Second)
	var final Snapshot
	for {
		cur := m.Get(snap.ID)
		if cur == nil {
			t.Fatal("job vanished")
		}
		if cur.State == StateDownloading {
			if cur.Media.Available > 0 && cur.Media.Total == 0 {
				seenGrowing = true
			}
		}
		if cur.State == StateComplete {
			final = *cur
			break
		}
		if cur.State == StateError {
			t.Fatalf("unexpected error state: %v", cur.Error)
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never completed")
		}
		time.Sleep(30 * time.Millisecond)
	}
	if !seenGrowing {
		t.Fatal("expected to observe growing available bytes during download")
	}
	if final.Media.Available != 900 || final.Media.Total != 900 {
		t.Fatalf("complete media = %+v, want available=total=900", final.Media)
	}
}

func TestCancelKillsProcessAndCleansSession(t *testing.T) {
	alive := filepath.Join(t.TempDir(), "alive.txt")
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "0")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	setFakeEnv(t, "EIZOU_FAKE_ALIVE_FILE", alive)
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Wait for the helper to actually hold.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(alive); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("helper never started holding")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	} else if got.State != StateCancelled {
		t.Fatalf("cancel snapshot state = %s, want cancelled", got.State)
	}
	if m.Current() != nil {
		t.Fatal("session must be free after cancel")
	}
	if m.Get(snap.ID) != nil {
		t.Fatal("cancelled job must no longer exist")
	}
	// The alive counter must stop growing: the helper process is dead and
	// reaped (no zombie: cmd.Wait returned before done closed).
	a, _ := os.ReadFile(alive)
	time.Sleep(400 * time.Millisecond)
	b, _ := os.ReadFile(alive)
	if string(a) != string(b) {
		t.Fatalf("helper still writing after cancel: %q → %q", a, b)
	}
}

func TestTimeoutProducesErrorAndFreesSession(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "0")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	m := newTestManager(t, 300*time.Millisecond)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for {
		cur := m.Get(snap.ID)
		if cur != nil && cur.State == StateError {
			if cur.Error != "timed out" {
				t.Fatalf("error message = %q, want generic 'timed out'", cur.Error)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never errored")
		}
		time.Sleep(30 * time.Millisecond)
	}
	// The errored job stays current (observable) until explicitly cancelled.
	if m.Current() == nil {
		t.Fatal("errored job must stay current until cancelled")
	}
	if _, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if m.Current() != nil {
		t.Fatal("session must be free after cancelling the errored job")
	}
}

func TestFailedHelperProducesRedactedError(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "200")
	setFakeEnv(t, "EIZOU_FAKE_FAIL", "1")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for {
		cur := m.Get(snap.ID)
		if cur == nil {
			break // cleared after cleanup
		}
		if cur.State == StateError {
			if cur.Error != "download failed" {
				t.Fatalf("error = %q, want generic 'download failed'", cur.Error)
			}
			// Redaction: the error and snapshot must never expose the URL,
			// helper path, or helper output.
			sensitive := []string{"youtube.com", "abcdefghijk", fakeHelper, "stderr", "pid.txt"}
			blob := cur.Error + "|" + cur.ID
			for _, s := range sensitive {
				if strings.Contains(blob, s) {
					t.Errorf("redaction leak: %q contains %q", blob, s)
				}
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never errored")
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func TestActiveMediaOnlyWhenComplete(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "500")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK", "250")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK_DELAY_MS", "250")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// First observe the downloading phase and assert the source is NOT
	// servable yet (total unknown while the helper writes).
	deadline := time.Now().Add(8 * time.Second)
	observedDownloading := false
	for {
		cur := m.Get(snap.ID)
		if cur != nil && cur.State == StateDownloading {
			observedDownloading = true
			break
		}
		if cur != nil && cur.State == StateError {
			t.Fatalf("unexpected error: %v", cur.Error)
		}
		if time.Now().After(deadline) {
			t.Fatalf("never observed downloading")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !observedDownloading {
		t.Fatal("expected downloading phase")
	}
	if _, src := m.ActiveMedia(); src != nil {
		t.Fatal("source must not be servable while downloading")
	}

	// Then wait for completion and assert the source is servable.
	deadline = time.Now().Add(8 * time.Second)
	for {
		cur := m.Get(snap.ID)
		if cur != nil && cur.State == StateComplete {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never completed")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// After completion the source is servable and reads the bytes.
	_, src := m.ActiveMedia()
	if src == nil {
		t.Fatal("completed job must expose a servable source")
	}
	if src.Total() != 500 || src.Available() != 500 {
		t.Fatalf("source total/available = %d/%d, want 500/500", src.Available(), src.Total())
	}
	buf := make([]byte, 500)
	if n, err := src.ReadAt(buf, 0); err != nil || n != 500 {
		t.Fatalf("ReadAt = %d, %v; want 500, nil", n, err)
	}
}

// jobTempDirs lists the private job temp dirs currently on disk.
func jobTempDirs() []string {
	entries, err := os.ReadDir(os.TempDir())
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "entei-job-") {
			out = append(out, e.Name())
		}
	}
	return out
}

func TestNoJobTempDirLeakOnError(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "200")
	setFakeEnv(t, "EIZOU_FAKE_FAIL", "1")
	m := newTestManager(t, 0)
	before := jobTempDirs()
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for {
		cur := m.Get(snap.ID)
		if cur != nil && cur.State == StateError {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never errored")
		}
		time.Sleep(30 * time.Millisecond)
	}
	// The errored job's private dir must be gone (regression: the helper
	// stderr handle was left open, so os.RemoveAll failed on Windows and
	// the dir — with the raw helper output inside — leaked).
	after := jobTempDirs()
	for _, d := range after {
		if !slices.Contains(before, d) {
			t.Errorf("leaked job temp dir after error: %s", d)
		}
	}
	_, _ = m.Cancel(snap.ID)
}

func TestNoJobTempDirLeakOnCancel(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "0")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	m := newTestManager(t, 0)
	before := jobTempDirs()
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Give the helper a moment to hold (so its stderr handle is open).
	time.Sleep(400 * time.Millisecond)
	if _, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	after := jobTempDirs()
	for _, d := range after {
		if !slices.Contains(before, d) {
			t.Errorf("leaked job temp dir after cancel: %s", d)
		}
	}
}

func TestCloseCancelsActiveJob(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "0")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if err := m.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	t.Logf("at Close: snap=%+v current=%v", m.Get(snap.ID), m.Current())
	if m.Current() != nil {
		t.Fatal("session must be free after Close")
	}
	if err := m.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}
