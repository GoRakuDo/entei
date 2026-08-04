// Package diag provides the EizouDendenshi file diagnostic logger.
//
// The logger is a stdlib-only, append-only file sink with a bounded size
// (1 MiB; when exceeded the current file is rotated to eizouden.log.1 and a
// fresh file is started). All methods are safe for concurrent use and are
// no-ops on a nil *Logger, so a nil logger means "no logging" exactly as if
// the feature were absent (existing callers and tests keep working).
//
// REDACTION CONTRACT (the most important property of this package):
//
//   - Logged messages must never contain a full magnet URI, a tracker URL,
//     a full infohash, a capability token, a pairing code, a cookie, a
//     local absolute path, an API URL, a helper path, or any credential.
//     ShortInfohash is the ONLY sanctioned way to reference an infohash:
//     the first 12 hex characters followed by "…".
//   - API request lines are method + path (query stripped) + status only,
//     so a token carried in the query string can never reach the log.
//
// The directory is resolved by DefaultDir: Windows uses
// %LOCALAPPDATA%\GoRakuDo\EizouDendenshi, Android/Termux uses
// $PREFIX/var/log, and EIZOUDEN_LOG_DIR overrides both for harnesses and
// tests (the override never applies in production, where the env var is
// absent).
package diag

import (
	"encoding/base32"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// logFileName is the active log file name; the rotated previous file is
// logFileName+".1" (overwritten on each rotation).
const logFileName = "eizouden.log"

// maxLogBytes is the rotation threshold: when appending would grow the
// active file beyond this, the file is rotated (current → eizouden.log.1,
// fresh file started).
const maxLogBytes = 1 << 20 // 1 MiB

// tsLayout renders RFC3339 with milliseconds, e.g.
// 2026-08-04T12:34:56.789+07:00.
const tsLayout = "2006-01-02T15:04:05.000Z07:00"

// Logger is a bounded, append-only file log sink. A nil *Logger is a valid
// receiver: every method is a no-op, preserving the pre-logging behavior.
type Logger struct {
	mu   sync.Mutex
	f    *os.File
	path string
	size int64
}

// DefaultDir resolves the platform log directory:
//
//   - EIZOUDEN_LOG_DIR, when set, wins (harness/test override only); it
//     must be an absolute path — a relative override is rejected so a
//     mis-set env var can never resolve against an unpredictable working
//     directory (defense in depth for a test-only escape hatch);
//   - Windows: %LOCALAPPDATA%\GoRakuDo\EizouDendenshi;
//   - Android/Termux: $PREFIX/var/log (Termux sets $PREFIX);
//   - other platforms: os.UserCacheDir()/GoRakuDo/EizouDendenshi, falling
//     back to the OS temp dir.
func DefaultDir() (string, error) {
	if d := os.Getenv("EIZOUDEN_LOG_DIR"); d != "" {
		if !filepath.IsAbs(d) {
			return "", errors.New("diag: EIZOUDEN_LOG_DIR must be an absolute path")
		}
		return d, nil
	}
	switch {
	case runtime.GOOS == "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			return "", errors.New("diag: LOCALAPPDATA not set")
		}
		return filepath.Join(base, "GoRakuDo", "EizouDendenshi"), nil
	case os.Getenv("PREFIX") != "":
		return filepath.Join(os.Getenv("PREFIX"), "var", "log"), nil
	default:
		if base, err := os.UserCacheDir(); err == nil && base != "" {
			return filepath.Join(base, "GoRakuDo", "EizouDendenshi"), nil
		}
		return os.TempDir(), nil
	}
}

// NewLogger opens (creating when absent) the log file under dir, appended
// with user-private permissions (0600). The directory is created when
// absent. An existing log file's size is accounted for, so rotation
// triggers at the same total size regardless of process restarts.
func NewLogger(dir string) (*Logger, error) {
	if dir == "" {
		return nil, errors.New("diag: log dir required")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("diag: log dir: %w", err)
	}
	path := filepath.Join(dir, logFileName)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("diag: open log: %w", err)
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("diag: stat log: %w", err)
	}
	return &Logger{f: f, path: path, size: st.Size()}, nil
}

// Infof logs an informational line: "<timestamp> [INFO] <component>: <msg>".
func (l *Logger) Infof(component, format string, args ...any) {
	l.logf("INFO", component, format, args...)
}

// Warnf logs a warning line.
func (l *Logger) Warnf(component, format string, args ...any) {
	l.logf("WARN", component, format, args...)
}

// Errorf logs an error line.
func (l *Logger) Errorf(component, format string, args ...any) {
	l.logf("ERROR", component, format, args...)
}

// Close closes the log file. Idempotent; nil-safe.
func (l *Logger) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

func (l *Logger) logf(level, component, format string, args ...any) {
	if l == nil {
		return
	}
	line := fmt.Sprintf("%s [%s] %s: %s\n",
		time.Now().Format(tsLayout), level, component, fmt.Sprintf(format, args...))
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return
	}
	if l.size+int64(len(line)) > maxLogBytes {
		l.rotateLocked()
		if l.f == nil {
			return // rotation failed and no fallback file is writable
		}
	}
	n, err := l.f.WriteString(line)
	if err != nil {
		return
	}
	l.size += int64(n)
}

// rotateLocked moves the active file to eizouden.log.1 (overwriting any
// previous backup — the simple bounded-history contract) and reopens a
// fresh active file. If the reopen fails, logging continues into the
// rotated backup file as a degraded fallback; if that also fails the
// logger goes silent until the next successful rotation attempt.
//
// When the rename did NOT move the file (it vanished, or the rename
// failed while the file still exists), the reopened file may still hold
// content: its real size is restored from Stat so the next write does not
// immediately re-rotate into a tight loop. Only a genuinely fresh file
// (rename succeeded) starts with size 0.
func (l *Logger) rotateLocked() {
	_ = l.f.Close()
	l.f = nil
	backup := l.path + ".1"
	_ = os.Remove(backup)
	rotated := os.Rename(l.path, backup) == nil
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		f, err = os.OpenFile(backup, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return // no writable file: drop logs until the next write
		}
		rotated = false // the reopened file is the backup: restore its size
	}
	l.f = f
	if rotated {
		l.size = 0 // fresh active file
		return
	}
	st, serr := f.Stat()
	if serr != nil {
		l.size = 0 // cannot measure; worst case one extra rotation attempt
		return
	}
	l.size = st.Size()
}

// ShortInfohash extracts the infohash from a magnet URI and returns a
// redacted reference: the first 12 hex characters followed by "…". This is
// the ONLY permitted infohash form in diagnostic logs — the full infohash
// never appears. A 32-char base32 infohash is decoded to hex first so the
// prefix is always 12 hex characters. Unparseable input yields "".
func ShortInfohash(magnet string) string {
	const prefix = "magnet:?xt=urn:btih:"
	s := strings.TrimSpace(magnet)
	if !strings.HasPrefix(s, prefix) {
		return ""
	}
	rest := s[len(prefix):]
	// The infohash ends at the first '&' or ';' (tracker/parameter list).
	if i := strings.IndexAny(rest, "&;"); i >= 0 {
		rest = rest[:i]
	}
	if rest == "" {
		return ""
	}
	// Base32 (32 chars) → hex, for a consistent 12-hex prefix.
	if len(rest) == 32 {
		if raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(rest)); err == nil && len(raw) == 20 {
			rest = hex.EncodeToString(raw)
		}
	}
	const prefixLen = 12
	if len(rest) <= prefixLen {
		return strings.ToLower(rest)
	}
	return strings.ToLower(rest[:prefixLen]) + "…"
}
