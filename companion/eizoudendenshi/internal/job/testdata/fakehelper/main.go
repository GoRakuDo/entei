// Command fakehelper is a deterministic stand-in for the yt-dlp helper used
// by the ED-2F job tests. It never contacts the network.
//
// Behavior is controlled entirely by environment variables so the manager's
// fixed argument vector stays untouched:
//
//	EIZOU_FAKE_ARGS_OUT        — path to write the received argv (one per line)
//	EIZOU_FAKE_SIZE            — total bytes to write to the media file
//	EIZOU_FAKE_CHUNK           — bytes per write (default: size)
//	EIZOU_FAKE_CHUNK_DELAY_MS  — delay between chunks (simulates slow download)
//	EIZOU_FAKE_FAIL            — "1": exit 2 after writing (failed download)
//	EIZOU_FAKE_STDERR_TAIL     — optional custom stderr line printed before the
//	                             failure exit (defaults to a yt-dlp-style
//	                             "HTTP Error 403" line; the job diag log
//	                             surfaces the redacted tail of it)
//	EIZOU_FAKE_HOLD            — "1": after writing, hold forever (cancel/timeout tests)
//	EIZOU_FAKE_ALIVE_FILE      — path to append "alive-<n>" lines while holding
//	EIZOU_FAKE_PART_SUFFIX     — replace the default ".part" suffix with this
//	                             value (e.g. "-Frag0" mirrors yt-dlp's
//	                             fragmented-download naming, where the growing
//	                             file is NOT media.<ext>.part)
//
// It parses its own argv only to find the "-o <dir>/media.%(ext)s" argument
// (fixed by the manager) and writes <dir>/media.mp4 (+ suffix in speed
// mode). It also writes pid.txt into that directory so tests can observe
// the process.
package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func mustInt(name string) int {
	s := os.Getenv(name)
	if s == "" {
		return 0
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

func main() {
	args := os.Args[1:]
	if out := os.Getenv("EIZOU_FAKE_ARGS_OUT"); out != "" {
		_ = os.WriteFile(out, []byte(strings.Join(args, "\n")), 0o600)
	}

	var outPath string
	noPart := false
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "-o" {
			outPath = args[i+1]
		}
		if args[i] == "--no-part" {
			noPart = true
		}
	}
	if outPath == "" {
		os.Exit(3)
	}
	// Write sidecar print files when --print-to-file is present, so the
	// manager can read the selected format height and the video title.
	// --print-to-file <template> <path> — write a sample value per template.
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--print-to-file" && i+2 < len(args) {
			tmpl := args[i+1]
			out := args[i+2]
			switch tmpl {
			case "%(height)s":
				_ = os.WriteFile(out, []byte("720\n"), 0o600)
			case "%(title)s":
				_ = os.WriteFile(out, []byte("Sample YouTube Video Title\n"), 0o600)
			case "%(filesize_approx)s":
				// Estimated final total in bytes; EIZOU_FAKE_TOTAL
				// overrides the default, and "0" emits "NA" (unknown —
				// mirrors yt-dlp when the size cannot be estimated).
				total := os.Getenv("EIZOU_FAKE_TOTAL")
				if total == "" {
					total = "2097152"
				}
				if total == "0" {
					total = "NA"
				}
				_ = os.WriteFile(out, []byte(total+"\n"), 0o600)
			}
		}
	}
	// Speed mode (no --no-part) writes a .part file that grows and is
	// renamed on completion — mirroring yt-dlp for instant playback. The
	// suffix can be rerouted to a fragmented-download style name
	// (EIZOU_FAKE_PART_SUFFIX, e.g. "-Frag0"), which yt-dlp actually uses
	// for some formats; the classic naming is kept so existing tests
	// still mirror the common case.
	outPath = strings.Replace(outPath, "%(ext)s", "mp4", 1)
	if !noPart {
		suffix := os.Getenv("EIZOU_FAKE_PART_SUFFIX")
		if suffix == "" {
			suffix = ".part"
		}
		outPath += suffix
	}
	dir := filepath.Dir(outPath)
	_ = os.WriteFile(filepath.Join(dir, "pid.txt"), []byte(strconv.Itoa(os.Getpid())), 0o600)

	// On completion (no hold, no fail), rename the .part away — mirroring
	// yt-dlp's completion rename so largestMedia sees the final file.
	if !noPart && os.Getenv("EIZOU_FAKE_HOLD") != "1" && os.Getenv("EIZOU_FAKE_FAIL") != "1" {
		suffix := os.Getenv("EIZOU_FAKE_PART_SUFFIX")
		if suffix == "" {
			suffix = ".part"
		}
		defer func() {
			_ = os.Rename(outPath, strings.TrimSuffix(outPath, suffix))
		}()
	}

	size := mustInt("EIZOU_FAKE_SIZE")
	chunk := mustInt("EIZOU_FAKE_CHUNK")
	if chunk <= 0 {
		chunk = size
	}
	delay := mustInt("EIZOU_FAKE_CHUNK_DELAY_MS")
	fail := os.Getenv("EIZOU_FAKE_FAIL") == "1"
	hold := os.Getenv("EIZOU_FAKE_HOLD") == "1"
	aliveFile := os.Getenv("EIZOU_FAKE_ALIVE_FILE")

	// The media file is opened up front and, in hold mode, KEPT open while
	// holding — reproducing the Windows cancel race where a killed helper
	// still holds an open handle when the job dir is removed.
	f, err := os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		os.Exit(4)
	}
	defer f.Close()

	if size > 0 {
		data := bytes.Repeat([]byte{0x41}, chunk)
		written := 0
		for written < size {
			n := chunk
			if size-written < n {
				n = size - written
			}
			if _, err := f.Write(data[:n]); err != nil {
				os.Exit(5)
			}
			written += n
			if delay > 0 {
				time.Sleep(time.Duration(delay) * time.Millisecond)
			}
		}
	} else if hold {
		// Ensure an empty media file exists; the handle stays open while
		// holding (the file is closed only at process exit).
		_ = f
	}

	if fail {
		// Emit a realistic yt-dlp-style stderr line (the job diag log
		// surfaces the redacted tail of this on error) unless the test
		// pins a custom line via EIZOU_FAKE_STDERR_TAIL.
		line := os.Getenv("EIZOU_FAKE_STDERR_TAIL")
		if line == "" {
			line = "ERROR: [youtube] Extraction failed: HTTP Error 403: Forbidden"
		}
		_, _ = fmt.Fprintln(os.Stderr, line)
		os.Exit(2)
	}
	if hold {
		for i := 0; ; i++ {
			if aliveFile != "" {
				_ = os.WriteFile(aliveFile, []byte(fmt.Sprintf("alive-%d", i)), 0o600)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
}
