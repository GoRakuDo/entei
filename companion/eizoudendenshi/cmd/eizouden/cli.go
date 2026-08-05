// Common three-option CLI for the EizouDendenshi companion (Windows + Termux).
//
// The menu is the entry point after bootstrap on both platforms:
//
//		EizouDendenshi vX.Y.Z
//
//		1. Get New Pairing Code
//		2. Service Status
//		3. Update EizouDendenshi
//
//		Option:
//
//	  - Option 1 starts the foreground loopback companion (a fresh pairing
//	    code is printed and never saved; ordinary Ctrl+C stops it).
//	  - Option 2 prints service status only: core / yt-dlp / ffmpeg
//	    installed, version, and executable readiness. It never prints paths,
//	    cookies, tokens, URLs, or job data.
//	  - Option 3 updates the verified core/helpers from the signed release
//	    feed. It prints only safe status text and never resets the pairing:
//	    the persisted credential (credential.bin / DPAPI store) and the
//	    browser's opaque token are untouched, so the Web does not need to
//	    re-pair. When an update is verified the process exits so the
//	    internal --apply-update child can replace the running core; the
//	    child then prints an update-complete message and the user runs
//	    `grkd-edds` manually (the new core is never auto-launched — an
//	    auto-started CLI does not own a usable console stdin; see
//	    internal/update).
//
// The header uses ANSI color ONLY when stdout is a terminal; otherwise the
// plain text is printed (piped/redirected output stays clean). Invalid
// input re-prompts; EOF exits safely. The menu deliberately has no
// Start/Stop entries beyond the three options.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// cliOptions carries everything the menu needs. Helper paths are the exact
// private paths the launcher passes on Windows; on Termux the fixed package
// commands are resolved when a path is empty.
type cliOptions struct {
	version string
	ytdlp   string
	ffmpeg  string
	// logStatus is the safe diagnostic-log status text ("enabled" /
	// "disabled"); never the log path.
	logStatus string
	// runUpdate runs option 3 (Update EizouDendenshi). It prints only
	// safe status text to the given writer and returns true when the
	// caller must exit so the spawned child can replace the running
	// core. nil means the updater is unavailable (dev builds).
	runUpdate func(stdout io.Writer) bool
}

// fixedTermuxCommands maps each helper to the command its official Termux
// package installs (the compiled-in map; never manifest-derived).
var fixedTermuxCommands = map[string]string{
	"yt-dlp": "yt-dlp",
	"ffmpeg": "ffmpeg",
}

// versionFlags are the bounded version-query arguments per helper.
var helperVersionFlag = map[string]string{
	"yt-dlp": "--version",
	"ffmpeg": "-version",
}

// runCLI renders the menu and dispatches. stdin/stdout are injectable for
// tests; startServer is injected so tests never bind a real listener.
func runCLI(opts cliOptions, stdin io.Reader, stdout io.Writer, startServer func() error) int {
	header := fmt.Sprintf("EizouDendenshi v%s", opts.version)
	if isTerminalWriter(stdout) {
		header = "\x1b[1;36m" + header + "\x1b[0m"
	}
	fmt.Fprintln(stdout, header)
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "1. Get New Pairing Code")
	fmt.Fprintln(stdout, "2. Service Status")
	fmt.Fprintln(stdout, "3. Update EizouDendenshi")

	reader := bufio.NewReader(stdin)
	for {
		fmt.Fprint(stdout, "\nOption: ")
		line, err := reader.ReadString('\n')
		if strings.TrimSpace(line) != "" {
			switch strings.TrimSpace(line) {
			case "1":
				if err := startServer(); err != nil {
					fmt.Fprintf(stdout, "companion stopped with an error: %v\n", err)
					return 1
				}
				return 0
			case "2":
				printServiceStatus(opts, stdout)
			case "3":
				if opts.runUpdate == nil {
					fmt.Fprintln(stdout, "update: updater unavailable")
					break
				}
				if opts.runUpdate(stdout) {
					// The updater verified a newer release and spawned the
					// --apply-update child: the parent must exit so the
					// child can replace the running core. The child prints
					// an update-complete message afterwards; the user then
					// starts the new CLI by running `grkd-edds` manually.
					return 0
				}
			default:
				fmt.Fprintln(stdout, "Invalid option; enter 1, 2, or 3.")
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				fmt.Fprintln(stdout)
				return 0
			}
			return 1
		}
	}
}

// printServiceStatus reports helper readiness without ever revealing paths,
// cookies, tokens, URLs, or job data.
func printServiceStatus(opts cliOptions, stdout io.Writer) {
	fmt.Fprintf(stdout, "core: installed (v%s)\n", opts.version)
	for _, name := range []string{"yt-dlp", "ffmpeg"} {
		fmt.Fprintf(stdout, "%s: %s\n", name, helperStatusLine(name, opts))
	}
	fmt.Fprintln(stdout, "torrent: enabled (anacrolix engine, built-in)")
	logStatus := opts.logStatus
	if logStatus == "" {
		logStatus = "disabled"
	}
	fmt.Fprintf(stdout, "log: %s\n", logStatus)
}

// helperStatusLine resolves the helper (explicit path or the fixed Termux
// command), checks existence/executability, and runs a bounded version
// query. Only the status text is returned — never a path.
func helperStatusLine(name string, opts cliOptions) string {
	var path string
	switch name {
	case "yt-dlp":
		path = opts.ytdlp
	case "ffmpeg":
		path = opts.ffmpeg
	}
	resolved := path
	if resolved == "" {
		p, err := exec.LookPath(fixedTermuxCommands[name])
		if err != nil {
			return "missing"
		}
		resolved = p
	}
	st, err := os.Stat(resolved)
	if err != nil || st.IsDir() || st.Size() == 0 {
		return "missing"
	}
	if st.Mode()&0111 == 0 && !isWindows() {
		return "not executable"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, resolved, helperVersionFlag[name]).CombinedOutput()
	if err != nil {
		return "installed (version check failed)"
	}
	first := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	first = truncate(first, 64)
	if first == "" {
		return "installed (version check failed)"
	}
	return fmt.Sprintf("installed (%s)", first)
}

// truncate caps a displayed string at n runes (status output only).
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// isTerminalWriter reports whether w is a character device (a real
// terminal). Buffers and files are not terminals: output stays plain.
func isTerminalWriter(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	st, err := f.Stat()
	if err != nil {
		return false
	}
	return st.Mode()&os.ModeCharDevice != 0
}

func isWindows() bool {
	return filepath.Separator == '\\'
}
