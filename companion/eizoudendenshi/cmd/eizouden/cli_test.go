package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"eizoudendenshi/internal/update"
)

// fakeHelperSrc is a tiny helper that answers version queries with a fixed
// version, so the service-status tests never touch real tools or the
// network.
const fakeHelperSrc = `package main

import "fmt"

func main() {
	fmt.Println("2026.07.04")
}
`

var fakeHelperPath string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "eizouden-cli-fake-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)
	src := filepath.Join(dir, "main.go")
	if err := os.WriteFile(src, []byte(fakeHelperSrc), 0o600); err != nil {
		panic(err)
	}
	exe := filepath.Join(dir, "fakehelper")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	out, err := exec.Command("go", "build", "-o", exe, src).CombinedOutput()
	if err != nil {
		panic("fake helper build failed: " + string(out))
	}
	fakeHelperPath = exe
	os.Exit(m.Run())
}

func runMenu(t *testing.T, opts cliOptions, input string, startErr error) string {
	t.Helper()
	var out bytes.Buffer
	startServer := func() error { return startErr }
	code := runCLI(opts, strings.NewReader(input), &out, startServer)
	if code != 0 {
		t.Fatalf("runCLI exit code = %d, want 0", code)
	}
	return out.String()
}

func TestMenuStructureAndPlainFallback(t *testing.T) {
	// Hermetic: the menu defaults to the REAL machine's channel.json when
	// storageRoot is empty, so a persisted "prerelease" on the dev box
	// would flip this test's expected header. Isolate via temp dir
	// (2026-08-29 — flaky since the channel-split feature landed).
	t.Setenv("EIZOUDEN_CREDENTIAL_DIR", t.TempDir())
	out := runMenu(t, cliOptions{version: "0.2.0-rc.7"}, "2\n", nil)
	if !strings.Contains(out, "EizouDendenshi v0.2.0-rc.7") {
		t.Errorf("missing version header: %q", out)
	}
	if !strings.Contains(out, "Update channel: stable") {
		t.Errorf("missing update channel header line: %q", out)
	}
	for _, want := range []string{
		"1. Get New Pairing Code",
		"2. Service Status",
		"3. Update EizouDendenshi",
		"4. Switch Update Channel",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("menu must show option %q: %q", want, out)
		}
	}
	if strings.Contains(out, "\x1b[") {
		t.Errorf("ANSI escapes must not appear for a non-terminal stdout: %q", out)
	}
	if strings.Contains(out, "5.") || strings.Contains(out, "Start") || strings.Contains(out, "Stop") {
		t.Errorf("menu must not contain extra options: %q", out)
	}
}

func TestStatusReportsHelpersRedacted(t *testing.T) {
	opts := cliOptions{
		version: "0.2.0-rc.7",
		ytdlp:   fakeHelperPath,
		ffmpeg:  fakeHelperPath,
	}
	out := runMenu(t, opts, "2\n", nil)
	for _, want := range []string{
		"core: installed (v0.2.0-rc.7)",
		"yt-dlp: installed (2026.07.04)",
		"ffmpeg: installed (2026.07.04)",
		"torrent: enabled (anacrolix engine, built-in)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("status missing %q: %q", want, out)
		}
	}
	// No paths, cookies, tokens, URLs, or job data may ever appear.
	if strings.Contains(out, fakeHelperPath) || strings.Contains(out, "token") ||
		strings.Contains(out, "http://") || strings.Contains(out, "cookie") {
		t.Errorf("status leaked sensitive detail: %q", out)
	}
}

func TestStatusMissingHelper(t *testing.T) {
	// Empty helper paths + an empty PATH: the fixed Termux commands cannot
	// be resolved → helpers report "missing".
	t.Setenv("PATH", "")
	out := runMenu(t, cliOptions{version: "0.2.0-rc.7"}, "2\n", nil)
	for _, name := range []string{"yt-dlp", "ffmpeg"} {
		if !strings.Contains(out, name+": missing") {
			t.Errorf("expected %s: missing, got %q", name, out)
		}
	}
	// Torrent is built-in, always reports enabled.
	if !strings.Contains(out, "torrent: enabled") {
		t.Errorf("torrent always enabled, got %q", out)
	}
}

func TestInvalidInputReprompts(t *testing.T) {
	out := runMenu(t, cliOptions{version: "0.2.0-rc.7"}, "9\n2\n", nil)
	if !strings.Contains(out, "Invalid option; enter 1, 2, 3, or 4.") {
		t.Errorf("invalid input must re-prompt with a friendly message: %q", out)
	}
	if !strings.Contains(out, "core: installed") {
		t.Errorf("second valid input must be processed: %q", out)
	}
}

func TestEOFExitsSafely(t *testing.T) {
	out := runMenu(t, cliOptions{version: "0.2.0-rc.7"}, "", nil)
	if !strings.Contains(out, "Option:") {
		t.Errorf("menu must prompt before exiting on EOF: %q", out)
	}
}

func TestOptionOneStartsServer(t *testing.T) {
	var called bool
	var out bytes.Buffer
	wantErr := errors.New("stopped")
	code := runCLI(cliOptions{version: "0.2.0-rc.7"}, strings.NewReader("1\n"), &out, func() error {
		called = true
		return wantErr
	})
	if !called {
		t.Fatal("option 1 must start the server function")
	}
	if code != 1 {
		t.Errorf("server error must yield exit 1, got %d", code)
	}
	if !strings.Contains(out.String(), wantErr.Error()) {
		t.Errorf("server error must be surfaced: %q", out.String())
	}
}

func TestOptionThreeRunsUpdateCallback(t *testing.T) {
	var out bytes.Buffer
	var got bool
	opts := cliOptions{
		version: "0.2.0-rc.7",
		runUpdate: func(w io.Writer) bool {
			got = true
			fmt.Fprintln(w, "update: verified and restarting...")
			return true
		},
	}
	code := runCLI(opts, strings.NewReader("3\n"), &out, func() error { return nil })
	if !got {
		t.Fatal("option 3 must call the update callback")
	}
	if code != 0 {
		t.Errorf("restarting update must exit 0, got %d", code)
	}
	if !strings.Contains(out.String(), "update: verified and restarting...") {
		t.Errorf("update status must be printed: %q", out.String())
	}
}

func TestOptionThreeFailureStaysOnMenu(t *testing.T) {
	var out bytes.Buffer
	opts := cliOptions{
		version: "0.2.0-rc.7",
		runUpdate: func(w io.Writer) bool {
			fmt.Fprintln(w, "update: could not check for updates")
			return false
		},
	}
	// After a failed update the menu must still accept option 2.
	code := runCLI(opts, strings.NewReader("3\n2\n"), &out, func() error { return nil })
	if code != 0 {
		t.Errorf("failed update must stay in the menu, got exit %d", code)
	}
	if !strings.Contains(out.String(), "update: could not check for updates") {
		t.Errorf("update failure status must be printed: %q", out.String())
	}
	if !strings.Contains(out.String(), "core: installed") {
		t.Errorf("menu must continue after a failed update: %q", out.String())
	}
}

func TestOptionThreeUnavailableWithoutCallback(t *testing.T) {
	// A dev build (or a build without a pinned key) has no update
	// callback wired in tests: option 3 must report unavailability and
	// stay in the menu without panicking.
	var out bytes.Buffer
	code := runCLI(cliOptions{version: "0.2.0-rc.7"}, strings.NewReader("3\n2\n"), &out, func() error { return nil })
	if code != 0 {
		t.Errorf("unavailable updater must stay in the menu, got exit %d", code)
	}
	if !strings.Contains(out.String(), "update: updater unavailable") {
		t.Errorf("updater unavailable status must be printed: %q", out.String())
	}
	if !strings.Contains(out.String(), "core: installed") {
		t.Errorf("menu must continue after unavailable updater: %q", out.String())
	}
}

func TestOptionOneShowsPairingCodeWhenAutoStarted(t *testing.T) {
	var out bytes.Buffer
	var startServerCalled bool
	opts := cliOptions{
		version: "0.2.0-rc.7",
		autoStart: func() (string, <-chan error, error) {
			return "123456", nil, nil
		},
	}
	code := runCLI(opts, strings.NewReader("1\n"), &out, func() error {
		startServerCalled = true
		return nil
	})
	if startServerCalled {
		t.Fatal("option 1 must not call startServer when auto-started")
	}
	if code != 0 {
		t.Errorf("option 1 with auto-start must exit 0, got %d", code)
	}
	if !strings.Contains(out.String(), "Pairing code: 123456") {
		t.Errorf("option 1 must show pairing code: %q", out.String())
	}
}

func TestAutoStartFailureFallsBackToStartServer(t *testing.T) {
	var out bytes.Buffer
	var startServerCalled bool
	autoStartErr := errors.New("port in use")
	opts := cliOptions{
		version: "0.2.0-rc.7",
		autoStart: func() (string, <-chan error, error) {
			return "", nil, autoStartErr
		},
	}
	code := runCLI(opts, strings.NewReader("1\n"), &out, func() error {
		startServerCalled = true
		return nil
	})
	if !startServerCalled {
		t.Fatal("option 1 must fall back to startServer when auto-start fails")
	}
	if code != 0 {
		t.Errorf("fallback startServer must exit 0, got %d", code)
	}
	if !strings.Contains(out.String(), "auto-start failed: "+autoStartErr.Error()) {
		t.Errorf("auto-start error must be printed: %q", out.String())
	}
}

func TestMenuCleanNoBannerOrPairingCode(t *testing.T) {
	var out bytes.Buffer
	opts := cliOptions{
		version: "0.2.0-rc.7",
		autoStart: func() (string, <-chan error, error) {
			return "999999", nil, nil
		},
	}
	// Select option 2 (service status) — pairing code must NOT appear.
	runCLI(opts, strings.NewReader("2\n"), &out, func() error { return nil })
	outStr := out.String()
	if !strings.Contains(outStr, "EizouDendenshi v0.2.0-rc.7") {
		t.Errorf("missing version header: %q", outStr)
	}
	if !strings.Contains(outStr, "1. Get New Pairing Code") {
		t.Errorf("missing menu option 1: %q", outStr)
	}
	// Pairing code must NOT appear before option 1 is selected.
	if strings.Contains(outStr, "999999") {
		t.Errorf("pairing code must not appear before option 1: %q", outStr)
	}
	// Banner/status lines must NOT appear in the clean menu.
	if strings.Contains(outStr, "listening on") {
		t.Errorf("banner must not appear in clean menu: %q", outStr)
	}
	if strings.Contains(outStr, "Media fixture:") {
		t.Errorf("media status must not appear in clean menu: %q", outStr)
	}
	if strings.Contains(outStr, "Source jobs:") {
		t.Errorf("jobs status must not appear in clean menu: %q", outStr)
	}
	if strings.Contains(outStr, "Torrent jobs:") {
		t.Errorf("torrent status must not appear in clean menu: %q", outStr)
	}
}

func TestPairingCodeShownOnlyOnOptionOne(t *testing.T) {
	var out bytes.Buffer
	opts := cliOptions{
		version: "0.2.0-rc.7",
		autoStart: func() (string, <-chan error, error) {
			return "999999", nil, nil
		},
	}
	// Select option 1 — pairing code SHOULD appear.
	code := runCLI(opts, strings.NewReader("1\n"), &out, func() error { return nil })
	if code != 0 {
		t.Errorf("option 1 must exit 0, got %d", code)
	}
	if !strings.Contains(out.String(), "Pairing code: 999999") {
		t.Errorf("option 1 must show pairing code: %q", out.String())
	}
}

func TestOptionFourSwitchChannel(t *testing.T) {
	storageRoot := t.TempDir()
	opts := cliOptions{
		version:     "0.2.0-rc.7",
		storageRoot: storageRoot,
	}

	// 1. Initial state: absent channel.json defaults to stable in header.
	// Selecting 4 and entering 2 switches to prerelease.
	var out1 bytes.Buffer
	code1 := runCLI(opts, strings.NewReader("4\n2\n"), &out1, func() error { return nil })
	if code1 != 0 {
		t.Fatalf("runCLI option 4 -> 2 exit code = %d, want 0", code1)
	}
	outStr1 := out1.String()
	if !strings.Contains(outStr1, "Update channel: stable") {
		t.Errorf("initial header must show stable channel: %q", outStr1)
	}
	if !strings.Contains(outStr1, "Current update channel: stable") {
		t.Errorf("option 4 must show current channel: %q", outStr1)
	}
	if !strings.Contains(outStr1, "Update channel set to prerelease.") {
		t.Errorf("confirmation must confirm prerelease: %q", outStr1)
	}
	if !strings.Contains(outStr1, "The next Update (Option 3) will use this channel.") {
		t.Errorf("confirmation must note next Update uses this channel: %q", outStr1)
	}

	// Verify persistence
	ch, err := update.LoadChannel(storageRoot)
	if err != nil || ch != update.ChannelPrerelease {
		t.Fatalf("persisted channel = %q (err=%v), want prerelease", ch, err)
	}

	// 2. Next run on same storage root: header shows prerelease.
	// Selecting 4 and entering 1 switches back to stable.
	var out2 bytes.Buffer
	code2 := runCLI(opts, strings.NewReader("4\n1\n"), &out2, func() error { return nil })
	if code2 != 0 {
		t.Fatalf("runCLI option 4 -> 1 exit code = %d, want 0", code2)
	}
	outStr2 := out2.String()
	if !strings.Contains(outStr2, "Update channel: prerelease") {
		t.Errorf("header must reflect persisted prerelease channel: %q", outStr2)
	}
	if !strings.Contains(outStr2, "Current update channel: prerelease") {
		t.Errorf("option 4 must show current prerelease channel: %q", outStr2)
	}
	if !strings.Contains(outStr2, "Update channel set to stable.") {
		t.Errorf("confirmation must confirm stable: %q", outStr2)
	}

	ch, err = update.LoadChannel(storageRoot)
	if err != nil || ch != update.ChannelStable {
		t.Fatalf("persisted channel = %q (err=%v), want stable", ch, err)
	}
}

func TestOptionFourInvalidChoiceReprompts(t *testing.T) {
	storageRoot := t.TempDir()
	opts := cliOptions{
		version:     "0.2.0-rc.7",
		storageRoot: storageRoot,
	}
	// Option 4, invalid choice "9", then valid choice "2"
	var out bytes.Buffer
	code := runCLI(opts, strings.NewReader("4\n9\n2\n"), &out, func() error { return nil })
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	outStr := out.String()
	if !strings.Contains(outStr, "Invalid choice; enter 1 for stable or 2 for prerelease.") {
		t.Errorf("must reprompt on invalid channel choice: %q", outStr)
	}
	if !strings.Contains(outStr, "Update channel set to prerelease.") {
		t.Errorf("must process subsequent valid choice: %q", outStr)
	}
}

func TestOptionFourEOFExitsSafely(t *testing.T) {
	storageRoot := t.TempDir()
	opts := cliOptions{
		version:     "0.2.0-rc.7",
		storageRoot: storageRoot,
	}
	// Option 4 then EOF
	var out bytes.Buffer
	code := runCLI(opts, strings.NewReader("4\n"), &out, func() error { return nil })
	if code != 0 {
		t.Fatalf("EOF in option 4 must exit 0, got %d", code)
	}
}

func TestOptionFourAutoStartServerMode(t *testing.T) {
	storageRoot := t.TempDir()
	opts := cliOptions{
		version:     "0.2.0-rc.7",
		storageRoot: storageRoot,
		autoStart: func() (string, <-chan error, error) {
			return "123456", nil, nil
		},
	}
	var out bytes.Buffer
	code := runCLI(opts, strings.NewReader("4\n2\n1\n"), &out, func() error { return nil })
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	outStr := out.String()
	if !strings.Contains(outStr, "Update channel set to prerelease.") {
		t.Errorf("option 4 must work in autoStart mode: %q", outStr)
	}
	if !strings.Contains(outStr, "Pairing code: 123456") {
		t.Errorf("subsequent option 1 must still work: %q", outStr)
	}
}
