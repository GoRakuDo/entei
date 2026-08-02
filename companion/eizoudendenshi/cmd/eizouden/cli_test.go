package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
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
	out := runMenu(t, cliOptions{version: "0.2.0-rc.7"}, "2\n", nil)
	if !strings.Contains(out, "EizouDendenshi v0.2.0-rc.7") {
		t.Errorf("missing version header: %q", out)
	}
	if !strings.Contains(out, "1. Get New Pairing Code") ||
		!strings.Contains(out, "2. Service Status") {
		t.Errorf("menu must show exactly the two options: %q", out)
	}
	if strings.Contains(out, "\x1b[") {
		t.Errorf("ANSI escapes must not appear for a non-terminal stdout: %q", out)
	}
	if strings.Contains(out, "3.") || strings.Contains(out, "Start") || strings.Contains(out, "Stop") {
		t.Errorf("menu must not contain extra options: %q", out)
	}
}

func TestStatusReportsHelpersRedacted(t *testing.T) {
	opts := cliOptions{
		version: "0.2.0-rc.7",
		ytdlp:   fakeHelperPath,
		aria2:   fakeHelperPath,
		ffmpeg:  fakeHelperPath,
	}
	out := runMenu(t, opts, "2\n", nil)
	for _, want := range []string{
		"core: installed (v0.2.0-rc.7)",
		"yt-dlp: installed (2026.07.04)",
		"aria2: installed (2026.07.04)",
		"ffmpeg: installed (2026.07.04)",
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
	for _, name := range []string{"yt-dlp", "aria2", "ffmpeg"} {
		if !strings.Contains(out, name+": missing") {
			t.Errorf("expected %s: missing, got %q", name, out)
		}
	}
}

func TestInvalidInputReprompts(t *testing.T) {
	out := runMenu(t, cliOptions{version: "0.2.0-rc.7"}, "9\n2\n", nil)
	if !strings.Contains(out, "Invalid option; enter 1 or 2.") {
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
