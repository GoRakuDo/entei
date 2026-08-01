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
//	EIZOU_FAKE_HOLD            — "1": after writing, hold forever (cancel/timeout tests)
//	EIZOU_FAKE_ALIVE_FILE      — path to append "alive-<n>" lines while holding
//
// It parses its own argv only to find the "-o <dir>/media.%(ext)s" argument
// (fixed by the manager) and writes <dir>/media.mp4. It also writes
// pid.txt into that directory so tests can observe the process.
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
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "-o" {
			outPath = args[i+1]
			break
		}
	}
	if outPath == "" {
		os.Exit(3)
	}
	outPath = strings.Replace(outPath, "%(ext)s", "mp4", 1)
	dir := filepath.Dir(outPath)
	_ = os.WriteFile(filepath.Join(dir, "pid.txt"), []byte(strconv.Itoa(os.Getpid())), 0o600)

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
