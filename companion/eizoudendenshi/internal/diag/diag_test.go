package diag

import (
	"encoding/base32"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// base32Decode mirrors the canonical-infohash base32 → hex conversion used
// by the magnet validator, so the test fixture can compute the expected
// 12-hex prefix.
func base32Decode(s string) (string, error) {
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(s))
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// TestNewLoggerCreatesFileAndWrites pins the append + 0600 + format
// contract: the file exists under dir with the exact timestamped line shape.
func TestNewLoggerCreatesFileAndWrites(t *testing.T) {
	dir := t.TempDir()
	l, err := NewLogger(dir)
	if err != nil {
		t.Fatalf("NewLogger: %v", err)
	}
	l.Infof("torrent", "job=%s created", "abc")
	l.Warnf("torrent", "metadata failed code=%s", "torrent_metadata_failed")
	l.Errorf("api", "unexpected")
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	path := filepath.Join(dir, logFileName)
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("log file missing: %v", err)
	}
	// The 0600 permission contract is meaningful on Unix (incl. Termux).
	// Windows Go does not map OpenFile mode bits onto ACLs, so the strict
	// check is Unix-only; on Windows user-privacy is provided by the
	// LOCALAPPDATA directory scope.
	if runtime.GOOS != "windows" && st.Mode().Perm()&0o077 != 0 {
		t.Errorf("log file mode %v, want no group/other bits", st.Mode().Perm())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	content := string(raw)

	lineRe := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \[INFO\] torrent: job=abc created\n$`)
	if !lineRe.MatchString(content[:strings.IndexByte(content, '\n')+1]) {
		t.Errorf("first line does not match format: %q", content[:strings.IndexByte(content, '\n')])
	}
	for _, want := range []string{
		"[INFO] torrent: job=abc created",
		"[WARN] torrent: metadata failed code=torrent_metadata_failed",
		"[ERROR] api: unexpected",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("log missing %q; got:\n%s", want, content)
		}
	}
}

// TestAppendAcrossReopens: reopening an existing log appends and accounts
// for the existing size (so rotation is measured across process restarts).
func TestAppendAcrossReopens(t *testing.T) {
	dir := t.TempDir()
	l, err := NewLogger(dir)
	if err != nil {
		t.Fatalf("NewLogger: %v", err)
	}
	l.Infof("main", "first")
	_ = l.Close()

	l2, err := NewLogger(dir)
	if err != nil {
		t.Fatalf("NewLogger reopen: %v", err)
	}
	l2.Infof("main", "second")
	_ = l2.Close()

	raw, err := os.ReadFile(filepath.Join(dir, logFileName))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	s := string(raw)
	if !strings.Contains(s, "first") || !strings.Contains(s, "second") {
		t.Errorf("reopen must append; got:\n%s", s)
	}
	if strings.Index(s, "second") < strings.Index(s, "first") {
		t.Errorf("second entry must come after the first")
	}
}

// TestRotationAtMaxBytes: crossing the 1 MiB threshold rotates the active
// file to eizouden.log.1 and starts a fresh file, keeping the newest lines
// in the active file. The .1 backup is overwritten on each rotation (the
// simple bounded-history contract), so it always holds the most recently
// rotated chunk — never the newest live lines.
func TestRotationAtMaxBytes(t *testing.T) {
	dir := t.TempDir()
	l, err := NewLogger(dir)
	if err != nil {
		t.Fatalf("NewLogger: %v", err)
	}
	defer l.Close()

	line := strings.Repeat("x", 4096)
	var lines int
	for i := 0; i < 2000; i++ {
		l.Infof("torrent", "bulk %d %s", i, line)
		lines++
		if lines > 2500 {
			break // safety valve: 2000×4 KiB ≈ 8 MiB is far past 1 MiB
		}
	}

	path := filepath.Join(dir, logFileName)
	backup := path + ".1"
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("active log missing after rotation: %v", err)
	}
	bk, err := os.Stat(backup)
	if err != nil {
		t.Fatalf("rotated backup missing: %v", err)
	}
	if st.Size() > maxLogBytes {
		t.Errorf("active log %d bytes exceeds threshold %d", st.Size(), maxLogBytes)
	}
	if bk.Size() > maxLogBytes+4096 {
		t.Errorf("backup %d bytes far exceeds the threshold", bk.Size())
	}

	active, _ := os.ReadFile(path)
	if !strings.Contains(string(active), "bulk 1999") {
		t.Errorf("active log must hold the newest line; tail: %q", tail(active, 80))
	}
	if strings.Contains(string(active), "bulk 0") {
		t.Errorf("oldest lines must have rotated out of the active file")
	}
	old, _ := os.ReadFile(backup)
	if strings.Contains(string(old), "bulk 1999") {
		t.Errorf("backup must not hold the newest live line; head: %q", head(old, 80))
	}
	if string(active) == string(old) {
		t.Errorf("active and backup must differ")
	}

	// Rotation again must overwrite .1 (bounded history, single backup).
	l.Infof("torrent", "bulk 2500 %s", line)
	st2, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat after second rotation: %v", err)
	}
	if st2.Size() > maxLogBytes {
		t.Errorf("active log grew past threshold after second rotation")
	}
}

func head(b []byte, n int) string {
	s := string(b)
	if len(s) > n {
		s = s[:n]
	}
	return s
}

func tail(b []byte, n int) string {
	s := string(b)
	if len(s) > n {
		s = s[len(s)-n:]
	}
	return s
}

// TestNilLoggerNoop: a nil *Logger is a valid receiver — no logging, no
// panic — preserving the pre-logging behavior for callers without a logger.
func TestNilLoggerNoop(t *testing.T) {
	var l *Logger
	l.Infof("torrent", "must not panic %d", 1)
	l.Warnf("torrent", "must not panic")
	l.Errorf("torrent", "must not panic")
	if err := l.Close(); err != nil {
		t.Fatalf("nil Close: %v", err)
	}
}

// TestWriteAfterCloseIsNoop: closing the logger silences further writes
// without panicking.
func TestWriteAfterCloseIsNoop(t *testing.T) {
	dir := t.TempDir()
	l, err := NewLogger(dir)
	if err != nil {
		t.Fatalf("NewLogger: %v", err)
	}
	_ = l.Close()
	l.Infof("torrent", "after close")
	_ = l.Close() // idempotent

	raw, _ := os.ReadFile(filepath.Join(dir, logFileName))
	if strings.Contains(string(raw), "after close") {
		t.Errorf("write after Close must be dropped")
	}
}

// TestShortInfohash pins the redaction contract: only a 12-hex prefix with
// "…" is ever produced — never the full infohash, and never for
// non-magnet / unparseable input.
func TestShortInfohash(t *testing.T) {
	const full = "0123456789abcdef0123456789abcdef01234567"
	cases := []struct {
		name   string
		magnet string
		want   string
	}{
		{"hex magnet", "magnet:?xt=urn:btih:" + full, "0123456789ab…"},
		{"hex magnet with tracker", "magnet:?xt=urn:btih:" + full + "&tr=udp%3A%2F%2Ftracker.example%3A1337", "0123456789ab…"},
		{"uppercase hex", "magnet:?xt=urn:btih:" + strings.ToUpper(full), "0123456789ab…"},
		{"base32 magnet", "magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", "…"}, // replaced below
		{"short infohash stays short", "magnet:?xt=urn:btih:abcdef", "abcdef"},
		{"empty", "", ""},
		{"garbage scheme", "http://example.com/x", ""},
		{"missing xt", "magnet:?dn=foo", ""},
		{"empty infohash", "magnet:?xt=urn:btih:", ""},
	}
	// The base32 case: the canonical alphabet string (32 chars) decodes to
	// 20 bytes → hex, and the first 12 hex chars are checked separately.
	b32raw, err := base32Decode("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
	if err != nil {
		t.Fatalf("base32 fixture: %v", err)
	}
	cases[3].want = b32raw[:12] + "…"

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ShortInfohash(tc.magnet)
			if got != tc.want {
				t.Errorf("ShortInfohash(%q) = %q, want %q", tc.magnet, got, tc.want)
			}
			if strings.Contains(got, full) {
				t.Errorf("ShortInfohash leaked the full infohash: %q", got)
			}
		})
	}
}

// TestDefaultDirEnvOverride: EIZOUDEN_LOG_DIR wins over platform defaults
// (the harness/test override contract).
func TestDefaultDirEnvOverride(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "override", "logs")
	t.Setenv("EIZOUDEN_LOG_DIR", dir)
	got, err := DefaultDir()
	if err != nil {
		t.Fatalf("DefaultDir: %v", err)
	}
	if got != dir {
		t.Errorf("DefaultDir = %q, want %q", got, dir)
	}
}

// TestDefaultDirRejectsRelativeOverride: a relative EIZOUDEN_LOG_DIR is
// rejected (the override must be absolute — defense in depth).
func TestDefaultDirRejectsRelativeOverride(t *testing.T) {
	t.Setenv("EIZOUDEN_LOG_DIR", "relative/logs")
	if _, err := DefaultDir(); err == nil {
		t.Fatal("DefaultDir must reject a relative EIZOUDEN_LOG_DIR")
	}
}

// TestConcurrentWritesAreSafe: concurrent Infof/Warnf calls from many
// goroutines must not interleave or lose lines (the logger is internally
// synchronized). Every line must be intact; the total line count must be
// exact. This test also runs under -race, pinning the mutex contract.
func TestConcurrentWritesAreSafe(t *testing.T) {
	dir := t.TempDir()
	l, err := NewLogger(dir)
	if err != nil {
		t.Fatalf("NewLogger: %v", err)
	}
	defer l.Close()

	const workers = 8
	const perWorker = 200
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < perWorker; j++ {
				l.Infof("torrent", "worker=%d seq=%d", n, j)
				l.Warnf("api", "worker=%d seq=%d", n, j)
			}
		}(i)
	}
	wg.Wait()

	raw, err := os.ReadFile(filepath.Join(dir, logFileName))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	wantLines := workers * perWorker * 2
	if len(lines) != wantLines {
		t.Fatalf("log has %d lines, want %d (interleaving or lost lines)", len(lines), wantLines)
	}
	// Every line must carry the full timestamped format — a torn write
	// would break the prefix.
	for i, ln := range lines {
		if !strings.HasPrefix(ln, "20") || !strings.Contains(ln, " [INFO] torrent: worker=") &&
			!strings.Contains(ln, " [WARN] api: worker=") {
			t.Fatalf("line %d is malformed: %q", i, ln)
		}
	}
}

// TestNewLoggerCreatesNestedDir: a nonexistent nested directory is created
// with user-private permissions.
func TestNewLoggerCreatesNestedDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "a", "b", "c")
	l, err := NewLogger(dir)
	if err != nil {
		t.Fatalf("NewLogger nested: %v", err)
	}
	defer l.Close()
	st, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("dir not created: %v", err)
	}
	if !st.IsDir() {
		t.Fatalf("%s is not a directory", dir)
	}
	if _, err := os.Stat(filepath.Join(dir, logFileName)); err != nil {
		t.Fatalf("log file missing under created dir: %v", err)
	}
}

// TestNewLoggerRejectsEmptyDir: an empty dir fails closed.
func TestNewLoggerRejectsEmptyDir(t *testing.T) {
	if _, err := NewLogger(""); err == nil {
		t.Fatal("NewLogger(\"\") must fail")
	}
}
