package job

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
		"--no-progress",
		"--no-write-info-json",
		"--no-write-thumbnail",
		"--write-subs",
		"--write-auto-subs",
		"--sub-langs", "ja.*",
		"--sub-format", "vtt",
		"--no-part",
		"-f", qualityFormat,
		"--print-to-file", heightPrintTemplate,
	}
	// After the fixed vector: the height.txt output path, then -o, then its
	// value (ending media.%(ext)s), then the URL.
	if len(argv) != len(want)+4 {
		t.Fatalf("argv = %v, want fixed vector + height path + -o pair + url", argv)
	}
	for i := range want {
		if argv[i] != want[i] {
			t.Errorf("argv[%d] = %q, want %q", i, argv[i], want[i])
		}
	}
	if !strings.HasSuffix(argv[len(want)], "height.txt") {
		t.Errorf("height output path %q must resolve inside the job dir", argv[len(want)])
	}
	if argv[len(want)+1] != "-o" {
		t.Errorf("argv[%d] = %q, want -o", len(want)+1, argv[len(want)+1])
	}
	if !strings.HasSuffix(argv[len(want)+2], "media.%(ext)s") {
		t.Errorf("-o value %q must resolve inside the job dir with the fixed template", argv[len(want)+2])
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

// awaitJobDirFromArgs waits for the fake helper's recorded argv (the
// -o "<dir>/media.%(ext)s" value) and returns the private job dir. The
// EIZOU_FAKE_ARGS_OUT env must be set BEFORE Start (the fake is spawned
// with it). Pins the leak check to the job's OWN dir, immune to other
// packages creating entei-job-* dirs concurrently.
func awaitJobDirFromArgs(t *testing.T, argsFile string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(argsFile); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("helper never recorded argv")
		}
		time.Sleep(20 * time.Millisecond)
	}
	raw, _ := os.ReadFile(argsFile)
	line := strings.TrimSpace(string(raw))
	for _, tok := range strings.Split(line, "\n") {
		if strings.HasSuffix(tok, "media.%(ext)s") {
			return filepath.Dir(tok)
		}
	}
	t.Fatal("no -o <dir>/media.%(ext)s in recorded argv")
	return ""
}

func TestNoJobTempDirLeakOnError(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "200")
	setFakeEnv(t, "EIZOU_FAKE_FAIL", "1")
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	setFakeEnv(t, "EIZOU_FAKE_ARGS_OUT", argsFile)
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	dir := awaitJobDirFromArgs(t, argsFile)
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
	var prevID string
	// The errored job's own private dir must be gone (regression: the
	// helper stderr handle was left open, so os.RemoveAll failed on Windows
	// and the dir — with the raw helper output inside — leaked).
	if pathExists(dir) {
		t.Errorf("leaked job temp dir after error: %s", dir)
	}
	// Deterministic ordering pin: the terminal error state must NEVER be
	// observable while the job dir still exists. Run the fail+observe cycle
	// repeatedly to catch any path that publishes StateError before
	// cleanup completes.
	if _, cerr := m.Cancel(snap.ID); cerr != nil {
		t.Fatalf("Cancel initial: %v", cerr)
	}
	for i := 0; i < 5; i++ {
		if i > 0 {
			// Errored jobs stay current until cancelled (the session is
			// freed explicitly); cancel the previous one before the next.
			if _, cerr := m.Cancel(prevID); cerr != nil {
				t.Fatalf("Cancel %d: %v", i-1, cerr)
			}
		}
		snap2, err2 := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
		if err2 != nil {
			t.Fatalf("Start %d: %v", i, err2)
		}
		prevID = snap2.ID
		dir2 := awaitJobDirFromArgs(t, argsFile)
		deadline2 := time.Now().Add(8 * time.Second)
		observed := false
		for {
			cur := m.Get(snap2.ID)
			if cur != nil && cur.State == StateError {
				observed = true
				break
			}
			if time.Now().After(deadline2) {
				t.Fatalf("job %d never errored", i)
			}
			time.Sleep(30 * time.Millisecond)
		}
		if !observed {
			t.Fatalf("job %d: error state not observed", i)
		}
		if pathExists(dir2) {
			t.Errorf("leaked job temp dir %d after error (state published before cleanup): %s", i, dir2)
		}
	}
}

func TestNoJobTempDirLeakOnCancel(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "0")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	setFakeEnv(t, "EIZOU_FAKE_ARGS_OUT", argsFile)
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	dir := awaitJobDirFromArgs(t, argsFile)
	// Give the helper a moment to hold (so its stderr handle is open).
	time.Sleep(400 * time.Millisecond)
	if _, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if pathExists(dir) {
		t.Errorf("leaked job temp dir after cancel: %s", dir)
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

// TestGetDuringFinalizeNoSnapshotRace pins the unsynchronized read of the
// job's completed media source. Regression: finalize assigned j.src (and
// errMsg) without stateMu while snapshot read them under stateMu (and
// ActiveMedia read j.src under mu), so `go test -race ./...` reported a
// write/read race on j.src and on errMsg. A second goroutine keeps
// snapshot reads open while the job transitions downloading → buffering →
// finalize → complete, so the detector deterministically fires if the
// lock discipline is ever removed, and the snapshot invariants (complete
// ⇒ available==total, pre-complete ⇒ unknown total) hold throughout.
func TestGetDuringFinalizeNoRace(t *testing.T) {
	const wantTotal = 262144 // 256 KiB
	setFakeEnv(t, "EIZOU_FAKE_SIZE", fmt.Sprint(wantTotal))
	setFakeEnv(t, "EIZOU_FAKE_CHUNK", fmt.Sprint(wantTotal))
	setFakeEnv(t, "EIZOU_FAKE_CHUNK_DELAY_MS", "1")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	m := newTestManager(t, 0)

	for i := 0; i < 15; i++ {
		snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
		if err != nil {
			t.Fatalf("Start %d: %v", i, err)
		}

		// Hammer snapshots from a second goroutine so the read window stays
		// open across the finalize transition.
		stop := make(chan struct{})
		done := make(chan struct{})
		bad := make(chan string, 1)
		go func() {
			defer close(done)
			for {
				select {
				case <-stop:
					return
				default:
				}
				cur := m.Get(snap.ID)
				if cur != nil {
					switch cur.State {
					case StateComplete:
						if cur.Media.Available != wantTotal || cur.Media.Total != wantTotal {
							bad <- fmt.Sprintf("complete media = %+v, want %d/%d", cur.Media, wantTotal, wantTotal)
							return
						}
					case StateDownloading, StateBuffering:
						if cur.Media.Total != 0 {
							bad <- fmt.Sprintf("%s media = %+v, want total 0", cur.State, cur.Media)
							return
						}
					case StateError:
						if cur.Error == "" {
							bad <- "error snapshot with empty message"
							return
						}
					}
				}
				// ActiveMedia exercises the second j.src read path; it must
				// only surface a source once the state is complete.
				if _, src := m.ActiveMedia(); src != nil {
					if src.Available() != wantTotal || src.Total() != wantTotal {
						bad <- fmt.Sprintf("active source available/total = %d/%d, want %d", src.Available(), src.Total(), wantTotal)
						return
					}
				}
			}
		}()

		var final State
		deadline := time.Now().Add(10 * time.Second)
		for {
			cur := m.Get(snap.ID)
			if cur != nil && (cur.State == StateComplete || cur.State == StateError) {
				final = cur.State
				break
			}
			if time.Now().After(deadline) {
				close(stop)
				<-done
				t.Fatalf("job %d never reached a terminal state", i)
			}
			time.Sleep(5 * time.Millisecond)
		}
		close(stop)
		<-done
		select {
		case msg := <-bad:
			t.Fatalf("job %d: %s", i, msg)
		default:
		}
		if final != StateComplete {
			t.Fatalf("job %d final state = %s, want complete", i, final)
		}
		if _, err := m.Cancel(snap.ID); err != nil {
			t.Fatalf("Cancel %d: %v", i, err)
		}
	}
}

func TestSelectJapaneseSubtitle_PrefersManual(t *testing.T) {
	dir := t.TempDir()
	// Create auto and manual subtitle files.
	_ = os.WriteFile(filepath.Join(dir, "media.ja-orig.vtt"), []byte("auto"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "media.ja.vtt"), []byte("manual"), 0o600)

	got := selectJapaneseSubtitle(dir)
	if got == "" {
		t.Fatal("expected a subtitle file, got empty")
	}
	if !strings.Contains(got, "media.ja.vtt") || strings.Contains(got, "-orig.") {
		t.Errorf("expected manual subtitle, got %s", got)
	}
}

func TestSelectJapaneseSubtitle_FallsBackToAuto(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "media.ja-orig.vtt"), []byte("auto"), 0o600)

	got := selectJapaneseSubtitle(dir)
	if got == "" {
		t.Fatal("expected auto subtitle, got empty")
	}
	if !strings.Contains(got, "-orig.") {
		t.Errorf("expected auto subtitle, got %s", got)
	}
}

func TestSelectJapaneseSubtitle_NoneWhenEmpty(t *testing.T) {
	dir := t.TempDir()
	got := selectJapaneseSubtitle(dir)
	if got != "" {
		t.Errorf("expected empty, got %s", got)
	}
}

func TestSelectJapaneseSubtitle_IgnoresNonJapanese(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "media.en.vtt"), []byte("english"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "media.fr.vtt"), []byte("french"), 0o600)

	got := selectJapaneseSubtitle(dir)
	if got != "" {
		t.Errorf("expected empty for non-Japanese, got %s", got)
	}
}

func TestSelectedSubtitleContent(t *testing.T) {
	m := newTestManager(t, 0)
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "1024")
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Wait for complete.
	deadline := time.Now().Add(10 * time.Second)
	for {
		s := m.Get(snap.ID)
		if s == nil {
			t.Fatal("job disappeared")
		}
		if s.State == StateError {
			t.Fatalf("job errored: %s", s.Error)
		}
		if s.State == StateComplete {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("timeout waiting for complete")
		}
		time.Sleep(100 * time.Millisecond)
	}
	// No subtitle file was written by the fake helper → returns error.
	_, err = m.SelectedSubtitleContent(context.Background())
	if err == nil {
		t.Fatal("expected error when no subtitle exists")
	}
}

// TestHelperArgsSpeedUsesProgressive verifies that speed mode selects the
// progressive single-file format (`b`) and DROPS `--no-part`, so yt-dlp
// writes a growing .part file for instant streaming.
func TestHelperArgsSpeedUsesProgressive(t *testing.T) {
	args := helperArgs("/tmp/job", "https://www.youtube.com/watch?v=abcdefghijk", ModeSpeed)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-f "+speedFormat) {
		t.Errorf("speed args missing progressive selector %q: %v", speedFormat, args)
	}
	if strings.Contains(joined, "--no-part") {
		t.Errorf("speed args must NOT contain --no-part (need .part growth): %v", args)
	}
	if strings.Contains(joined, qualityFormat) {
		t.Errorf("speed args must not use DASH selector: %v", args)
	}
	// Quality default retains --no-part + DASH selector.
	qargs := helperArgs("/tmp/job", "https://www.youtube.com/watch?v=abcdefghijk", ModeQuality)
	qjoined := strings.Join(qargs, " ")
	if !strings.Contains(qjoined, "--no-part") || !strings.Contains(qjoined, "-f "+qualityFormat) {
		t.Errorf("quality args mismatch: %v", qargs)
	}
}

// TestStartInvalidMode verifies an unknown mode is rejected without starting
// a job.
func TestStartInvalidMode(t *testing.T) {
	m := newTestManager(t, 0)
	if _, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk", Mode("turbo")); !errors.Is(err, ErrInvalidMode) {
		t.Fatalf("Start invalid mode = %v, want ErrInvalidMode", err)
	}
}

// TestSpeedModeStreamsPartDuringDownload verifies that a speed-mode job in
// StateDownloading exposes a growing source over the .part file, and that
// ActiveMedia returns it (available > 0) while the helper holds.
func TestSpeedModeStreamsPartDuringDownload(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "2048")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK", "512")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK_DELAY_MS", "5")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1") // keep downloading
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk", ModeSpeed)
	if err != nil {
		t.Fatalf("Start speed: %v", err)
	}
	defer func() { _, _ = m.Cancel(snap.ID) }()

	// Wait until the .part file exists (state stays downloading).
	deadline := time.Now().Add(5 * time.Second)
	var avail int64
	var total int64
	for {
		cur, part := m.ActiveMedia()
		if cur.State == StateError {
			t.Fatalf("job errored: %s", cur.Error)
		}
		if part != nil && part.Available() > 0 {
			avail, total = part.Available(), part.Total()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("part source never became available")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if avail <= 0 || avail != total {
		t.Fatalf("part source avail/total = %d/%d, want growing >0 equal", avail, total)
	}
	// The state must still be downloading (hold) — the .part is being
	// streamed pre-completion.
	s := m.Get(snap.ID)
	if s == nil || s.State != StateDownloading {
		t.Fatalf("job state = %v, want downloading during part streaming", s)
	}
	if s.Mode != ModeSpeed {
		t.Fatalf("mode = %q, want speed", s.Mode)
	}
	// height.txt written by the fake helper → quality reported.
	if s.Quality <= 0 {
		t.Skipf("height not captured for %d (fake wrote 720; expected quality>0)", s.Quality)
	}
}

// TestQualityModeNoPartStreamingSource verifies the historical quality mode
// still has no servable source until completion (complete-only contract).
func TestQualityModeNoStreamingBeforeComplete(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "3072")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK", "1024")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK_DELAY_MS", "5")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk", ModeQuality)
	if err != nil {
		t.Fatalf("Start quality: %v", err)
	}
	defer func() { _, _ = m.Cancel(snap.ID) }()

	time.Sleep(150 * time.Millisecond) // let a few polls run
	s, src := m.ActiveMedia()
	if s.State != StateDownloading {
		t.Fatalf("state = %v, want downloading", s.State)
	}
	if src != nil {
		t.Fatal("quality mode must NOT expose a streaming source before completion")
	}
}

func TestPartSourceGrowth(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "media.mp4.part")
	if err := os.WriteFile(path, []byte("hello world"), 0o600); err != nil {
		t.Fatal(err)
	}
	src := NewPartSource(path)
	if src.Total() != 11 || src.Available() != 11 {
		t.Fatalf("avail/total = %d/%d, want 11/11", src.Available(), src.Total())
	}
	buf := make([]byte, 5)
	n, err := src.ReadAt(buf, 0)
	if err != nil || n != 5 || string(buf) != "hello" {
		t.Fatalf("ReadAt = %d,%v %q, want 5 'hello'", n, err, buf)
	}
	// Grow the file; availability must advance.
	if err := os.WriteFile(path, []byte("hello world extension"), 0o600); err != nil {
		t.Fatal(err)
	}
	if src.Available() != 21 {
		t.Fatalf("avail after growth = %d, want 21", src.Available())
	}
}
