// Command fakearia2 is a deterministic stand-in for the aria2 helper used
// by the ED-2G torrent job tests. It never touches a swarm or the network.
//
// Behavior is controlled entirely by environment variables so the manager's
// fixed argument vector stays untouched:
//
//	EIZOU_FAKE_ARGS_OUT   — path to write the received argv (one per line)
//	EIZOU_FAKE_FILES      — "name1:size1|name2:size2" files to write under --dir
//	EIZOU_FAKE_CHUNK      — bytes per write while producing a file (default: size)
//	EIZOU_FAKE_DELAY_MS   — delay between chunks (simulates a slow download)
//	EIZOU_FAKE_FAIL       — "1": exit 2 after writing
//	EIZOU_FAKE_HOLD       — "1": after writing, hold forever (cancel/timeout)
//
// It parses its own argv only to find "--dir=<dir>" (fixed by the manager)
// and writes the declared files there (possibly into a subdirectory when a
// name contains "/"). It also writes pid.txt into that directory.
package main

import (
	"bytes"
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

	dir := ""
	for _, a := range args {
		if strings.HasPrefix(a, "--dir=") {
			dir = strings.TrimPrefix(a, "--dir=")
		}
	}
	if dir == "" {
		os.Exit(3)
	}
	// The pid marker lives in the system temp, NOT the job dir, so it never
	// appears in the torrent file listing.
	_ = os.WriteFile(
		filepath.Join(os.TempDir(), "fakearia2-pid-"+strconv.Itoa(os.Getpid())+".txt"),
		[]byte(strconv.Itoa(os.Getpid())), 0o600,
	)

	chunk := mustInt("EIZOU_FAKE_CHUNK")
	delay := mustInt("EIZOU_FAKE_DELAY_MS")
	fail := os.Getenv("EIZOU_FAKE_FAIL") == "1"
	hold := os.Getenv("EIZOU_FAKE_HOLD") == "1"

	for _, spec := range strings.Split(os.Getenv("EIZOU_FAKE_FILES"), "|") {
		if spec == "" {
			continue
		}
		parts := strings.SplitN(spec, ":", 2)
		if len(parts) != 2 {
			continue
		}
		name, sizeStr := parts[0], parts[1]
		size, err := strconv.Atoi(sizeStr)
		if err != nil || size < 0 {
			continue
		}
		// Names may include one subdirectory (torrent structure); always
		// stay under the private job dir.
		p := filepath.Join(dir, filepath.FromSlash(name))
		_ = os.MkdirAll(filepath.Dir(p), 0o700)
		c := chunk
		if c <= 0 {
			c = size
		}
		f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			continue
		}
		data := bytes.Repeat([]byte{0x42}, c)
		written := 0
		for written < size {
			n := c
			if size-written < n {
				n = size - written
			}
			_, _ = f.Write(data[:n])
			written += n
			if delay > 0 {
				time.Sleep(time.Duration(delay) * time.Millisecond)
			}
		}
		_ = f.Close()
	}

	if fail {
		os.Exit(2)
	}
	if hold {
		for {
			time.Sleep(100 * time.Millisecond)
		}
	}
}
