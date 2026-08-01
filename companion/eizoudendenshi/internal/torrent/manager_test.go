package torrent

import (
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

var fakeHelper string

func TestMain(m *testing.M) {
	_, thisFile, _, _ := runtime.Caller(0)
	pkgDir := filepath.Dir(thisFile)
	dir, err := os.MkdirTemp("", "entei-fake-aria2-*")
	if err != nil {
		fmt.Fprintf(os.Stderr, "temp dir: %v\n", err)
		os.Exit(1)
	}
	exe := "fakearia2"
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	fakeHelper = filepath.Join(dir, exe)
	build := exec.Command("go", "build", "-o", fakeHelper, "./testdata/fakearia2")
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

func setFakeEnv(t *testing.T, k, v string) {
	t.Helper()
	t.Setenv(k, v)
}

const testMagnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"

func TestNewRequiresHelperPath(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("New with empty helper path must fail")
	}
}

func TestStartValidatesMagnet(t *testing.T) {
	m := newTestManager(t, 0)
	for _, bad := range []string{
		"http://example.com/file.torrent",
		"magnet:?xt=urn:btih:short",
		"not a magnet",
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

func TestFixedArgsNoInjection(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	setFakeEnv(t, "EIZOU_FAKE_ARGS_OUT", argsFile)
	setFakeEnv(t, "EIZOU_FAKE_FILES", "media.mp4:100")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	m := newTestManager(t, 0)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
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
	argv := strings.Split(strings.TrimSpace(string(raw)), "\n")

	if argv[len(argv)-1] != testMagnet {
		t.Errorf("final argv element = %q, want the canonical magnet", argv[len(argv)-1])
	}
	for i, a := range argv {
		if strings.Contains(a, ";") || strings.Contains(a, "&&") || strings.Contains(a, "|") {
			t.Errorf("argv[%d] %q contains shell metacharacters", i, a)
		}
	}
	// Fixed flags present.
	joined := strings.Join(argv, " ")
	for _, want := range []string{"--seed-time=0", "--enable-rpc=false", "--check-integrity=true", "--dir=", "--dht-file-path="} {
		if !strings.Contains(joined, want) {
			t.Errorf("argv missing fixed flag %q: %v", want, argv)
		}
	}
	_, _ = m.Cancel(snap.ID)
}

// TestFixedArgsTrackerMagnetPinsOneFinalElement: a tracker-bearing magnet is
// canonicalized (safe trackers preserved) and still passed as ONE final argv
// element — the recorded argv never echoes the tracker anywhere else.
func TestFixedArgsTrackerMagnetPinsOneFinalElement(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "0")
	setFakeEnv(t, "EIZOU_FAKE_ARGS_OUT", argsFile)
	m := newTestManager(t, 0)
	withTracker := testMagnet + "&tr=udp%3A%2F%2FTracker.Example%3A1337&tr=udp%3A%2F%2Fa.example%2Fannounce"
	snap, err := m.Start(withTracker)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
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
	argv := strings.Split(strings.TrimSpace(string(raw)), "\n")
	last := argv[len(argv)-1]
	// The canonical magnet keeps the xt + the deduplicated sorted trackers.
	if !strings.HasPrefix(last, testMagnet+"&tr=") {
		t.Errorf("final argv element must carry the canonical tracker params, got %q", last)
	}
	if !strings.Contains(last, "tr=udp%3A%2F%2Fa.example%2Fannounce") ||
		!strings.Contains(last, "tr=udp%3A%2F%2Ftracker.example%3A1337") {
		t.Errorf("canonical trackers missing from the final argv element: %q", last)
	}
	// The tracker must NOT appear anywhere else in the argv.
	for i, a := range argv {
		if i != len(argv)-1 && strings.Contains(a, "tracker.example") {
			t.Errorf("tracker leaked into argv[%d]: %q", i, a)
		}
	}
	_, _ = m.Cancel(snap.ID)
}

func TestConflictOneActiveJob(t *testing.T) {
	m := newTestManager(t, 0)
	setFakeEnv(t, "EIZOU_FAKE_FILES", "")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := m.Start(testMagnet); !errors.Is(err, ErrConflict) {
		t.Fatalf("second Start err = %v, want ErrConflict", err)
	}
	if _, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if _, err := m.Start(testMagnet); err != nil {
		t.Fatalf("Start after cancel: %v", err)
	}
}

func waitForState(t *testing.T, m *Manager, id string, want State, timeout time.Duration) Snapshot {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		snap := m.Get(id)
		if snap != nil && snap.State == want {
			return *snap
		}
		if snap != nil && (snap.State == StateError || snap.State == StateCancelled) {
			t.Fatalf("job reached %s, want %s (%v)", snap.State, want, snap.Error)
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s; last=%+v", want, snap)
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func TestDownloadThenListingAndSelection(t *testing.T) {
	// One video (in a subdirectory to exercise sanitization) + one subtitle
	// + one junk file.
	setFakeEnv(t, "EIZOU_FAKE_FILES", "sub/Episode 01.mkv:200|sub/Episode 01.ass:40|readme.txt:10")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	m := newTestManager(t, 0)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Buffering (download complete, awaiting selection). Before the listing
	// is ready, Files returns ErrNotListed.
	if _, err := m.Files(snap.ID); err != nil && !errors.Is(err, ErrNotListed) {
		t.Fatalf("Files before listing = %v", err)
	}
	waitForState(t, m, snap.ID, StateBuffering, 10*time.Second)

	files, err := m.Files(snap.ID)
	if err != nil {
		t.Fatalf("Files: %v", err)
	}
	if len(files) != 3 {
		t.Fatalf("listing = %d files, want 3: %+v", len(files), files)
	}
	// Sanitized: basenames only (no subdir), correct kinds, opaque ids.
	var videoID, subID string
	seen := map[string]string{}
	for _, f := range files {
		if strings.Contains(f.Basename, "/") || strings.Contains(f.Basename, `\`) {
			t.Errorf("basename leaks a path: %q", f.Basename)
		}
		seen[f.ID] = f.Kind
		if f.Kind == KindVideo {
			videoID = f.ID
			if f.Basename != "Episode 01.mkv" || f.Extension != "mkv" || f.ByteSize != 200 {
				t.Errorf("video metadata wrong: %+v", f)
			}
		}
		if f.Kind == KindSubtitle {
			subID = f.ID
			if f.Basename != "Episode 01.ass" || f.Extension != "ass" {
				t.Errorf("subtitle metadata wrong: %+v", f)
			}
		}
		if f.Kind == KindOther && f.Basename != "readme.txt" {
			t.Errorf("other file wrong: %+v", f)
		}
	}
	if videoID == "" || subID == "" {
		t.Fatalf("expected one video and one subtitle: %v", seen)
	}

	// Selection: two videos rejected; non-video rejected; unknown id rejected.
	if _, err := m.Select(snap.ID, subID, ""); !errors.Is(err, ErrInvalidSelection) {
		t.Fatalf("selecting a subtitle as video err = %v, want ErrInvalidSelection", err)
	}
	if _, err := m.Select(snap.ID, "f99", ""); !errors.Is(err, ErrInvalidSelection) {
		t.Fatalf("unknown id err = %v, want ErrInvalidSelection", err)
	}
	// Valid selection: one video + one subtitle.
	sel, err := m.Select(snap.ID, videoID, subID)
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	if sel.State != StateComplete || sel.SelectedVideoFile != videoID || !sel.HasEligibleVideo {
		t.Fatalf("selection snapshot wrong: %+v", sel)
	}
	if sel.Media.Available != 200 || sel.Media.Total != 200 {
		t.Fatalf("selected media = %+v, want 200/200", sel.Media)
	}

	// ActiveMedia is servable only after selection.
	_, src := m.ActiveMedia()
	if src == nil {
		t.Fatal("selected media must be servable")
	}
	buf := make([]byte, 200)
	if n, err := src.ReadAt(buf, 0); err != nil || n != 200 {
		t.Fatalf("ReadAt = %d, %v; want 200, nil", n, err)
	}
	for _, b := range buf {
		if b != 0x42 {
			t.Fatal("served bytes are not the torrent's original bytes")
		}
	}
}

func TestNoEligibleVideoIsTerminalError(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_FILES", "readme.txt:10|song.mp3:50")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	m := newTestManager(t, 0)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		cur := m.Get(snap.ID)
		if cur != nil && cur.State == StateError {
			if cur.Error != "no playable video" {
				t.Fatalf("error = %q, want 'no playable video'", cur.Error)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never errored; last=%+v", cur)
		}
		time.Sleep(30 * time.Millisecond)
	}
	// The failed job's dir is cleaned; the error is generic.
	if _, err := m.Files(snap.ID); !errors.Is(err, ErrNotListed) && !errors.Is(err, ErrNotFound) {
		t.Fatalf("Files after error = %v", err)
	}
}

func TestCancelKillsProcessAndFreesSession(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_FILES", "")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	m := newTestManager(t, 0)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	time.Sleep(400 * time.Millisecond)
	if got, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	} else if got.State != StateCancelled {
		t.Fatalf("cancel state = %s, want cancelled", got.State)
	}
	if m.Current() != nil {
		t.Fatal("session must be free after cancel")
	}
}

func TestTimeoutProducesErrorAndFreesSession(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_FILES", "")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	m := newTestManager(t, 300*time.Millisecond)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		cur := m.Get(snap.ID)
		if cur != nil && cur.State == StateError {
			if cur.Error != "timed out" {
				t.Fatalf("error = %q, want 'timed out'", cur.Error)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never errored; last=%+v", cur)
		}
		time.Sleep(30 * time.Millisecond)
	}
	if _, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel after timeout: %v", err)
	}
	if m.Current() != nil {
		t.Fatal("session must be free after cancel")
	}
}

func TestFailedHelperProducesRedactedError(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_FILES", "media.mp4:100")
	setFakeEnv(t, "EIZOU_FAKE_FAIL", "1")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	m := newTestManager(t, 0)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		cur := m.Get(snap.ID)
		if cur != nil && cur.State == StateError {
			if cur.Error != "download failed" {
				t.Fatalf("error = %q, want generic 'download failed'", cur.Error)
			}
			// Redaction: never the magnet, helper path, or stderr.
			sensitive := []string{"0123456789abcdef", fakeHelper, "stderr", "pid.txt"}
			blob := cur.Error + "|" + cur.ID
			for _, s := range sensitive {
				if strings.Contains(blob, s) {
					t.Errorf("redaction leak: %q contains %q", blob, s)
				}
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never errored; last=%+v", cur)
		}
		time.Sleep(30 * time.Millisecond)
	}
	_, _ = m.Cancel(snap.ID)
}

// awaitAria2DirFromArgs waits for the fake aria2's recorded argv (the
// "--dir=<dir>" value) and returns the private job dir. The
// EIZOU_FAKE_ARGS_OUT env must be set BEFORE Start. Pins the leak check to
// the job's OWN dir, immune to other packages creating entei-torrent-*
// dirs concurrently.
func awaitAria2DirFromArgs(t *testing.T, argsFile string) string {
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
	for _, tok := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if strings.HasPrefix(tok, "--dir=") {
			return strings.TrimPrefix(tok, "--dir=")
		}
	}
	t.Fatal("no --dir= in recorded argv")
	return ""
}

func TestNoTempDirLeakOnErrorAndCancel(t *testing.T) {
	// Error path.
	setFakeEnv(t, "EIZOU_FAKE_FILES", "media.mp4:100")
	setFakeEnv(t, "EIZOU_FAKE_FAIL", "1")
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	setFakeEnv(t, "EIZOU_FAKE_ARGS_OUT", argsFile)
	m := newTestManager(t, 0)
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	dir := awaitAria2DirFromArgs(t, argsFile)
	deadline := time.Now().Add(10 * time.Second)
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
	if pathExists(dir) {
		t.Errorf("leaked torrent temp dir after error: %s", dir)
	}
	_, _ = m.Cancel(snap.ID)

	// Cancel path (helper holds with an open media handle).
	setFakeEnv(t, "EIZOU_FAKE_FAIL", "")
	setFakeEnv(t, "EIZOU_FAKE_FILES", "media.mp4:500")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "1")
	argsFile2 := filepath.Join(t.TempDir(), "args2.txt")
	setFakeEnv(t, "EIZOU_FAKE_ARGS_OUT", argsFile2)
	m2 := newTestManager(t, 0)
	snap2, err := m2.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	dir2 := awaitAria2DirFromArgs(t, argsFile2)
	time.Sleep(400 * time.Millisecond)
	if _, err := m2.Cancel(snap2.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if pathExists(dir2) {
		t.Errorf("leaked torrent temp dir after cancel: %s", dir2)
	}
}
