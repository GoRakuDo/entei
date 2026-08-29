package job

import (
	"bytes"
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

	"eizoudendenshi/internal/diag"
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
		"--sub-langs", "ja,ja-orig,ja-JP,ja-Hrkt",
		"--sub-format", "vtt",
		"--extractor-args", "youtube:player_client=mweb,android,web",
		// Default mode is now speed (2026-08-08): progressive single-file
		// selector, no --no-part (the .part file grows for instant
		// streaming).
		"-f", speedFormat,
	}
	// After the fixed vector: three --print-to-file pairs (height, title,
	// total) each spanning 3 argv elements, then -o <file> (media.%(ext)s),
	// then the URL.
	if len(argv) != len(want)+12 {
		t.Fatalf("argv = %v, want fixed vector + 3 print pairs + -o pair + url", argv)
	}
	for i := range want {
		if argv[i] != want[i] {
			t.Errorf("argv[%d] = %q, want %q", i, argv[i], want[i])
		}
	}
	if argv[len(want)] != "--print-to-file" || argv[len(want)+1] != heightPrintTemplate {
		t.Errorf("height print pair = %q %q, want --print-to-file %q", argv[len(want)], argv[len(want)+1], heightPrintTemplate)
	}
	if !strings.HasSuffix(argv[len(want)+2], "height.txt") {
		t.Errorf("height output path %q must resolve inside the job dir", argv[len(want)+2])
	}
	if argv[len(want)+3] != "--print-to-file" || argv[len(want)+4] != titlePrintTemplate {
		t.Errorf("title print pair = %q %q, want --print-to-file %q", argv[len(want)+3], argv[len(want)+4], titlePrintTemplate)
	}
	if !strings.HasSuffix(argv[len(want)+5], "title.txt") {
		t.Errorf("title output path %q must resolve inside the job dir", argv[len(want)+5])
	}
	if argv[len(want)+6] != "--print-to-file" || argv[len(want)+7] != totalPrintTemplate {
		t.Errorf("total print pair = %q %q, want --print-to-file %q", argv[len(want)+6], argv[len(want)+7], totalPrintTemplate)
	}
	if !strings.HasSuffix(argv[len(want)+8], "total.txt") {
		t.Errorf("total output path %q must resolve inside the job dir", argv[len(want)+8])
	}
	if argv[len(want)+9] != "-o" {
		t.Errorf("argv[%d] = %q, want -o", len(want)+9, argv[len(want)+9])
	}
	if !strings.HasSuffix(argv[len(want)+10], "media.%(ext)s") {
		t.Errorf("-o value %q must resolve inside the job dir with the fixed template", argv[len(want)+10])
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

// TestSelectedSubtitleContentBeforeComplete validates the contract:
// subtitlePath gates the read, not state. The production flow sets
// subtitlePath in finalize() after the helper exits; this test sets it
// directly (while the job is still downloading) to isolate the contract —
// the file being served pre-completion is the point, mirroring the
// torrent-side interface where the selected file is served whenever it is
// set.
func TestSelectedSubtitleContentBeforeComplete(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "2048")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK", "512")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK_DELAY_MS", "1")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1") // job stays downloading
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk", ModeSpeed)
	if err != nil {
		t.Fatalf("Start speed: %v", err)
	}
	defer func() { _, _ = m.Cancel(snap.ID) }()

	// Wait until the job's private dir exists (the run loop creates it
	// before the helper starts) and the state is downloading. PartPath
	// is read under the manager/part locks, so it is race-free; the part
	// file sits directly in the job dir.
	deadline := time.Now().Add(5 * time.Second)
	var jobDir string
	var j *job
	for {
		m.mu.Lock()
		j = m.current
		m.mu.Unlock()
		part := m.PartPath()
		if j != nil && part != "" && j.getState() == StateDownloading {
			jobDir = filepath.Dir(part)
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("job dir/state never became ready")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Set subtitlePath directly to the file on disk, exactly as finalize
	// does on completion (production sets it after the helper exits; this
	// test injects it mid-download to isolate the contract).
	subPath := filepath.Join(jobDir, "media.ja.vtt")
	_ = os.WriteFile(subPath, []byte("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nこんにちは\n"), 0o600)
	j.stateMu.Lock()
	j.subtitlePath = subPath
	j.stateMu.Unlock()

	got, err := m.SelectedSubtitleContent(context.Background())
	if err != nil {
		t.Fatalf("SelectedSubtitleContent before complete: %v", err)
	}
	if !strings.Contains(got, "こんにちは") {
		t.Errorf("subtitle content = %q, want the written VTT text", got)
	}
	// The job itself must still be downloading — the content was served
	// pre-completion.
	s := m.Get(snap.ID)
	if s == nil || s.State != StateDownloading {
		t.Fatalf("job state = %v, want downloading (content was served before complete)", s)
	}
}

// TestHelperArgsSpeedUsesProgressive verifies that speed mode selects the
// progressive-first format selector with DASH fallback and DROPS `--no-part`,
// so yt-dlp writes a growing .part file for streaming.
func TestHelperArgsSpeedUsesProgressive(t *testing.T) {
	args := helperArgs("/tmp/job", "https://www.youtube.com/watch?v=abcdefghijk", ModeSpeed)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-f "+speedFormat) {
		t.Errorf("speed args missing format selector %q: %v", speedFormat, args)
	}
	if strings.Contains(joined, "--no-part") {
		t.Errorf("speed args must NOT contain --no-part (need .part growth): %v", args)
	}
	if !strings.HasPrefix(speedFormat, "b/") {
		t.Errorf("speed format must prioritize progressive `b/`: %v", speedFormat)
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

// TestPartMediaPathFragmentedSuffix verifies partMediaPath also detects
// yt-dlp's fragmented-download naming (media.<ext>.part-Frag<n>) — not
// just the classic media.<ext>.part. 2026-08-09 real-device speed job:
// bytes=37M with part=- (classic glob missed the Frag suffix), so the
// instant-playback source never materialized and the 206 only appeared
// after complete. This pins the widened glob.
func TestPartMediaPathFragmentedSuffix(t *testing.T) {
	dir := t.TempDir()
	// Fragmented naming: part file exists but NOT as media.<ext>.part.
	_ = os.WriteFile(filepath.Join(dir, "media.mp4.part-Frag0"), []byte("fragbytes"), 0o600)
	got := partMediaPath(dir)
	if got == "" || !strings.Contains(got, "part-Frag0") {
		t.Fatalf("partMediaPath = %q, want the .part-Frag<n> file", got)
	}
	// Classic naming still detected.
	dir2 := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir2, "media.webm.part"), []byte("x"), 0o600)
	if got := partMediaPath(dir2); got == "" || !strings.Contains(got, "media.webm.part") {
		t.Fatalf("partMediaPath classic = %q, want media.webm.part", got)
	}
}

// TestSpeedModeStreamsFragmentedPartDuringDownload is the fragmented-
// naming twin of TestSpeedModeStreamsPartDuringDownload: with the fake
// helper writing media.mp4.part-Frag0 (yt-dlp fragmented naming), the
// manager must still surface a growing PartSource while downloading (the
// instant-playback contract), not only after complete.
func TestSpeedModeStreamsFragmentedPartDuringDownload(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "2048")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK", "512")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK_DELAY_MS", "5")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")                  // keep downloading
	setFakeEnv(t, "EIZOU_FAKE_PART_SUFFIX", ".part-Frag0") // fragmented naming (media.mp4.part-Frag0)
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk", ModeSpeed)
	if err != nil {
		t.Fatalf("Start speed: %v", err)
	}
	defer func() { _, _ = m.Cancel(snap.ID) }()

	deadline := time.Now().Add(5 * time.Second)
	var avail int64
	for {
		cur, part := m.ActiveMedia()
		if cur.State == StateError {
			t.Fatalf("job errored: %s", cur.Error)
		}
		if part != nil && part.Available() > 0 {
			avail = part.Available()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fragmented part source never became available within 5s")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if avail <= 0 {
		t.Fatal("fragmented part source never became available")
	}
	// The part path must be the fragmented file (label excludes the dir).
	if got := m.PartPath(); got == "" || !strings.Contains(got, "part-Frag0") {
		t.Fatalf("PartPath = %q, want the fragmented media.mp4.part-Frag0", got)
	}
	if s := m.Get(snap.ID); s == nil || s.State != StateDownloading {
		t.Fatalf("job state = %v, want downloading while streaming the fragmented part", s)
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
	if avail <= 0 {
		t.Fatal("part source never became available")
	}
	// The estimated total is pinned from the fake helper's total.txt
	// (2097152), so Total() is the fixed boundary while availability
	// tracks the growing prefix — the fixed-total contract that stops the
	// "loading → 1s play → loading" 416 loop.
	if total != 2097152 {
		t.Fatalf("part source total = %d, want the pinned estimate 2097152", total)
	}
	// Re-fetch the persistent source (the loop-local binding is gone) and
	// verify the pin state surfaced through TotalFixed. ActiveMedia
	// returns the media.GrowingSource interface, so the concrete
	// *PartSource needs the type assertion.
	_, src := m.ActiveMedia()
	ps, ok := src.(*PartSource)
	if !ok {
		t.Fatalf("speed mode source = %T, want *PartSource", src)
	}
	if !ps.TotalFixed() {
		t.Fatal("expected TotalFixed after the fake helper wrote total.txt")
	}
	if avail >= total {
		t.Fatalf("part avail/total = %d/%d, want growing avail below the pinned total", avail, total)
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

// TestPartSourceSetTotalPinsOnce verifies the fixed-total contract: Total()
// returns the pinned estimate once SetTotal ran (even as the file grows),
// the pin is one-shot (a second estimate is ignored), and an unpinned
// source reports its current size with TotalFixed() == false.
func TestPartSourceSetTotalPinsOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "media.mp4.part")
	if err := os.WriteFile(path, []byte("hello world"), 0o600); err != nil {
		t.Fatal(err)
	}
	src := NewPartSource(path)
	// Unpinned: Total follows Available (the growing contract).
	if src.Total() != 11 || src.Available() != 11 {
		t.Fatalf("unpinned total/avail = %d/%d, want 11/11", src.Total(), src.Available())
	}
	if src.TotalFixed() {
		t.Fatal("unpinned source must report TotalFixed() == false")
	}
	// One-shot pin: the estimate is kept while the file grows.
	src.SetTotal(100)
	if !src.TotalFixed() {
		t.Fatal("pinned source must report TotalFixed() == true")
	}
	if src.Total() != 100 || src.Available() != 11 {
		t.Fatalf("pinned total/avail = %d/%d, want 100/11", src.Total(), src.Available())
	}
	if err := os.WriteFile(path, []byte("hello world extension"), 0o600); err != nil {
		t.Fatal(err)
	}
	if src.Total() != 100 || src.Available() != 21 {
		t.Fatalf("pinned total after growth = %d/%d, want 100/21 (total must not move)", src.Total(), src.Available())
	}

	// Second pin (even a larger estimate) is ignored.
	src.SetTotal(500)
	if src.Total() != 100 {
		t.Fatalf("second SetTotal moved the pin: total = %d, want 100", src.Total())
	}

	// Non-positive pins are ignored before any pin (guarded callers).
	unpinned := NewPartSource(path)
	unpinned.SetTotal(0)
	unpinned.SetTotal(-1)
	if unpinned.TotalFixed() || unpinned.Total() != 21 {
		t.Fatalf("non-positive SetTotal must be ignored: total = %d, fixed = %v", unpinned.Total(), unpinned.TotalFixed())
	}
}

// TestPartSourceSetTotalRaisesBelowDisk verifies the guard against a stale
// estimate: pinning a total below the bytes already on disk raises the
// boundary to the current size (a servable prefix must never exceed it).
func TestPartSourceSetTotalRaisesBelowDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "media.mp4.part")
	if err := os.WriteFile(path, bytes.Repeat([]byte{0x41}, 100), 0o600); err != nil {
		t.Fatal(err)
	}
	src := NewPartSource(path)
	src.SetTotal(50) // stale/rough estimate below the on-disk 100 bytes
	if src.Total() != 100 || !src.TotalFixed() {
		t.Fatalf("total = %d (fixed %v), want raised to 100 (fixed)", src.Total(), src.TotalFixed())
	}
}

// TestReadTotalFile verifies the estimated-total sidecar parsing: a plain
// byte count parses (including large values), "NA" / empty / malformed /
// non-positive inputs are rejected (total stays unpinned).
func TestReadTotalFile(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if body == "" {
			return p // do not create
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	cases := []struct {
		name string
		body string
		want int64
		ok   bool
	}{
		{"plain", "2097152\n", 2097152, true},
		{"whitespace", "  1048576  \n", 1048576, true},
		{"large", "2147483648\n", 2147483648, true}, // > 2 GiB
		{"na", "NA\n", 0, false},
		{"na lower", "na", 0, false},
		{"zero", "0\n", 0, false},
		{"negative", "-5\n", 0, false},
		{"garbage", "lots of bytes\n", 0, false},
		{"empty file", "", 0, false}, // body "" => missing file path
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := write(tc.name+".txt", tc.body)
			got, err := readTotalFile(p)
			if tc.ok {
				if err != nil || got != tc.want {
					t.Fatalf("readTotalFile = %d, %v; want %d, nil", got, err, tc.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("readTotalFile(%q) = %d, nil; want error", tc.body, got)
			}
		})
	}
}

// TestYouTubeTitleCaptured verifies the completed job's snapshot exposes the
// YouTube video title written by the fake helper (title.txt via
// --print-to-file "%(title)s"), and that it never contains the URL or a
// local path.
func TestYouTubeTitleCaptured(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "2048")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK", "2048")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk", ModeQuality)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	var got *Snapshot
	for {
		s := m.Get(snap.ID)
		if s != nil && s.State == StateComplete {
			got = s
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("timeout waiting for complete")
		}
		time.Sleep(50 * time.Millisecond)
	}
	defer func() { _, _ = m.Cancel(snap.ID) }()

	if got.Title != "Sample YouTube Video Title" {
		t.Fatalf("title = %q, want the fake helper's title.txt content", got.Title)
	}
	// The URL must never leak into the title.
	if strings.Contains(got.Title, "youtube.com") || strings.Contains(got.Title, "abcdefghijk") {
		t.Fatalf("title leaks the URL: %q", got.Title)
	}
}

// TestStartEmptyModeDefaultsToSpeed pins the 2026-08-08 default change:
// a job started without an explicit mode runs in speed (instant-playback)
// mode, matching the web DEFAULT_YT_MODE.
func TestStartEmptyModeDefaultsToSpeed(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "1024")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _, _ = m.Cancel(snap.ID) }()
	if snap.Mode != ModeSpeed {
		t.Fatalf("empty-mode Start = %q, want ModeSpeed (default)", snap.Mode)
	}
}

// TestJobDiagErrorLineFormatAndRedaction pins the sanitized helper-error
// diagnostic emitted on download failure: the line carries the short job
// id, mode, state=error, the last refreshed bytes and .part label, and the
// safe helper exit status — and NEVER leaks the URL, the full job id, the
// helper path, a job temp dir, or the log dir.
func TestJobDiagErrorLineFormatAndRedaction(t *testing.T) {
	logDir := t.TempDir()
	l, err := diag.NewLogger(logDir)
	if err != nil {
		t.Fatalf("NewLogger: %v", err)
	}
	defer l.Close()
	m, err := New(Config{HelperPath: fakeHelper, Timeout: 10 * time.Second, Logger: l})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = m.Close() }()
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "200")
	setFakeEnv(t, "EIZOU_FAKE_FAIL", "1")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	const url = "https://www.youtube.com/watch?v=abcdefghijk"
	snap, err := m.Start(url)
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
			t.Fatal("job never errored")
		}
		time.Sleep(30 * time.Millisecond)
	}
	raw, err := os.ReadFile(filepath.Join(logDir, "eizouden.log"))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	line := string(raw)
	// The fake helper wrote 200 bytes to media.mp4.part before exiting 2,
	// so the failure line must show the detected .part (speed mode) and the
	// safe exit status.
	for _, field := range []string{
		"job=" + shortJobID(snap.ID),
		"mode=speed",
		"state=error",
		"bytes=200",
		"part=media.mp4.part",
		"err=exit status 2",
	} {
		if !strings.Contains(line, field) {
			t.Errorf("log line missing %q:\n%s", field, line)
		}
	}
	// Redaction: no URL, full job id, helper path, job temp dir, or log
	// dir may reach the diagnostic line.
	for _, s := range []string{"youtube.com", "abcdefghijk", snap.ID, fakeHelper, "entei-job-", logDir} {
		if strings.Contains(line, s) {
			t.Errorf("redaction leak: log line contains %q:\n%s", s, line)
		}
	}
}

// TestJobDiagErrorIncludesStderrTail pins the error-detail surfacing:
// on helper failure the diag line carries the last meaningful stderr
// line (redacted + bounded) after the exit status, and a URL embedded in
// that stderr line is squashed to <redacted> — the cause becomes visible
// (HTTP 403 etc.) without leaking anything unsafe.
func TestJobDiagErrorIncludesStderrTail(t *testing.T) {
	logDir := t.TempDir()
	l, err := diag.NewLogger(logDir)
	if err != nil {
		t.Fatalf("NewLogger: %v", err)
	}
	defer l.Close()
	m, err := New(Config{HelperPath: fakeHelper, Timeout: 10 * time.Second, Logger: l})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = m.Close() }()
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "200")
	setFakeEnv(t, "EIZOU_FAKE_FAIL", "1")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	// The helper prints a cause line with an embedded URL: after the
	// tail is squashed the URL must not reach the log.
	setFakeEnv(t, "EIZOU_FAKE_STDERR_TAIL",
		"ERROR: blocked by https://youtube.com/watch?v=abcdefghijk")
	const url = "https://www.youtube.com/watch?v=abcdefghijk"
	snap, err := m.Start(url)
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
			t.Fatal("job never errored")
		}
		time.Sleep(30 * time.Millisecond)
	}
	raw, err := os.ReadFile(filepath.Join(logDir, "eizouden.log"))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	line := string(raw)
	// The tail survives (visible cause) but with the URL squashed.
	for _, want := range []string{"err=exit status 2", "stderr=ERROR: blocked by <redacted>"} {
		if !strings.Contains(line, want) {
			t.Errorf("log line missing %q:\n%s", want, line)
		}
	}
	// No URL or full job id may reach the line.
	for _, s := range []string{"youtube.com", "abcdefghijk", snap.ID} {
		if strings.Contains(line, s) {
			t.Errorf("redaction leak: log line contains %q:\n%s", s, line)
		}
	}
}

// TestSafeHelperErrRedaction pins the error-field sanitizer: plain exit
// messages pass through, URL/path starters are cut at "<redacted>", long
// messages are bounded, and nil yields "none".
func TestSafeHelperErrRedaction(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"exit status", "exit status 2", "exit status 2"},
		{"url squashed", "ERROR: not a URL: https://www.youtube.com/watch?v=abcdefghijk", "ERROR: not a URL: <redacted>"},
		{"long bounded", strings.Repeat("x", 200), strings.Repeat("x", 120) + "..."},
		{"empty fallback", "   ", "helper failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := safeHelperErr(errors.New(tc.in)); got != tc.want {
				t.Errorf("safeHelperErr(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
	if got := safeHelperErr(nil); got != "none" {
		t.Errorf("safeHelperErr(nil) = %q, want none", got)
	}
	if got := shortJobID("0123456789abcdef"); got != "0123456789ab" {
		t.Errorf("shortJobID = %q, want the 12-char prefix", got)
	}
	if got := shortJobID("short"); got != "short" {
		t.Errorf("shortJobID(short) = %q, want unchanged", got)
	}
}

// TestJobDownloadDiagEmittedDuringHold verifies the steady download-state
// diagnostics while a download is in progress:
//
//   - the FIRST line is emitted immediately (first poll tick — a speed
//     job can complete in far under 10 s, so waiting for a 10 s mark used
//     to leave short jobs entirely silent)
//   - bytes=0 stalls still log (a zero-progress state must be visible,
//     otherwise "DL stuck at 0 bytes" looks identical to "no log")
//
// The fake helper holds the job in StateDownloading (EIZOU_FAKE_HOLD with
// a zero-byte media), and the log file must show "state=downloading
// bytes=0" within a few seconds.
func TestJobDownloadDiagEmitsImmediately(t *testing.T) {
	logDir := t.TempDir()
	l, err := diag.NewLogger(logDir)
	if err != nil {
		t.Fatalf("NewLogger: %v", err)
	}
	defer l.Close()
	m, err := New(Config{HelperPath: fakeHelper, Timeout: 30 * time.Second, Logger: l})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = m.Close() }()

	setFakeEnv(t, "EIZOU_FAKE_SIZE", "0") // no progress — empty media
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1") // stay downloading forever
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk", ModeSpeed)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	deadline := time.Now().Add(8 * time.Second)
	found := false
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(filepath.Join(logDir, "eizouden.log"))
		if err == nil && strings.Contains(string(raw), "state=downloading bytes=0") {
			found = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	_, _ = m.Cancel(snap.ID)
	if !found {
		t.Fatal("first download-state diag line (bytes=0) never appeared while the job held")
	}
}

// TestDiagnosticDownloadStateInterval verifies the 10 s cadence: while a
// download is held, the log emits a download-state line every interval —
// at least one line by the ~10 s mark and a second one after ~10 s more.
func TestDiagnosticDownloadInterval(t *testing.T) {
	logDir := t.TempDir()
	l, err := diag.NewLogger(logDir)
	if err != nil {
		t.Fatalf("NewLogger: %v", err)
	}
	defer l.Close()
	m, err := New(Config{HelperPath: fakeHelper, Timeout: 30 * time.Second, Logger: l})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = m.Close() }()

	setFakeEnv(t, "EIZOU_FAKE_SIZE", "4096")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK", "1024")
	setFakeEnv(t, "EIZOU_FAKE_CHUNK_DELAY_MS", "50")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk", ModeSpeed)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Count download-state lines over ~12.5 s: with a 10 s interval and an
	// immediate first line, we must see at least 2.
	deadline := time.Now().Add(12500 * time.Millisecond)
	lastCount := 0
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(filepath.Join(logDir, "eizouden.log"))
		if err == nil {
			n := strings.Count(string(raw), "state=downloading")
			if n > lastCount {
				lastCount = n
			}
			if lastCount >= 2 {
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	_, _ = m.Cancel(snap.ID)
	if lastCount < 2 {
		t.Fatalf("download-state diag lines = %d over 12.5s, want at least 2 (immediate + 10s cadence)", lastCount)
	}
}
