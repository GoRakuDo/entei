// Package anki implements the EizouDendenshi ↔ AnkiDroid bridge.
//
// The companion writes media bytes directly into AnkiDroid's
// collection.media directory (probe-based Termux path detection, see
// media.go) AND, on the note side, opens AnkiDroid's collection.anki2
// SQLite database and performs the AnkiConnect-compatible note
// surface (deckNames / modelNames / modelFieldNames / addNote /
// updateNoteFields / addTags / findNotes / notesInfo / canAddNotes)
// directly against the schema. The companion itself becomes the
// AnkiConnect-compatible server; no external APK is required.
//
// Per docs/EIZOU_DENDENSHI_ANKIDROID_CONNECT.md v3.0 (2026-08-30):
// the prior design (2026-08-29 v2.0) forwarded note actions to
// AnkiconnectAndroid (:8080) over HTTP; the v3.0 design removes that
// dependency entirely so users no longer need to install a third-party
// APK to enable the bridge. The collection side runs through the same
// SQLite file AnkiDroid reads from, so any note the companion writes
// shows up on the next AnkiDroid collection scan (a restart of
// AnkiDroid is required to refresh the in-memory model; AnkiWeb sync
// picks up the change via usn=-1).
//
// The bridge auto-derives: probe collection.media, then wire the
// sibling collection.anki2 (spec v4.1, 2026-08-31). No flags needed
// on the primary launch path — the raw AnkiConnect listener on 127.0.0.1:8765
// becomes the only Anki surface when a collection is found.
// --anki-collection overrides the auto-derive for non-standard
// locations. The bridge is composed of two halves:
//
//   1. MediaWriter — Termux writes media bytes directly into the
//      AnkiDroid collection.media directory with a deterministic,
//      content-hash filename (re-exports of the same blob overwrite the
//      same file, no Anki collection bloat). Probe-based path detection
//      prefers /storage/emulated/0/AnkiDroid/collection.media, then
//      /sdcard/AnkiDroid/collection.media, then a caller-provided
//      override. The probe runs only on Android/Termux — Windows / dev
//      builds return a clear "not supported on this platform" error so
//      the rest of the bridge can still compile and route.
//
//   2. Collection — opens <mediaDir>/../collection.anki2 through
//      modernc.org/sqlite (pure-Go, no CGO; keeps android/arm64
//      cross-compile working) with busy_timeout=5000 and AnkiDroid's
//      existing journal_mode respected (never overwritten). The schema
//      is auto-detected at open time: Anki 2.1.28+ (schema18) stores
//      decks/models in dedicated tables, older schemas store them as
//      JSON inside the col.decks / col.models row. The collection
//      layer implements BOTH readers and dispatches at runtime so the
//      bridge works on every supported AnkiDroid version. The note-
//      level operations (addNote / updateNoteFields / addTags /
//      findNotes / notesInfo / canAddNotes) write through modernc's
//      transaction boundary with the SHA-1-field-checksum + base91
//      Anki guid scheme.
//
// Re-exports of identical blobs are deterministic via SHA-256 → first 10
// hex of the content; the caller-supplied "filename" becomes the prefix
// and the extension after sanitization ([^a-zA-Z0-9_-] → _).
package anki

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ErrUnsupportedPlatform is returned by MediaWriter.Write on platforms
// where the AnkiDroid collection.media probe cannot run (everywhere
// outside Android/Termux and Linux). The error is intentionally generic
// — it carries no path and no internal detail. The /v1/anki/media
// handler maps this to 503 with a clear "anki bridge not supported on
// this platform" message so the user can tell the difference between
// "bridge disabled" (--anki-proxy empty → 404) and "bridge running on
// the wrong host" (this error → 503).
var ErrUnsupportedPlatform = errors.New("anki: not supported on this platform")

// ErrEmptyMedia is returned by MediaWriter.Write when the data slice is
// empty. Writing a zero-byte file would create a permanent dead entry in
// Anki's collection.media (and a deterministic name collision risk on
// the next non-empty write). The error is mapped to 400 by the handler.
var ErrEmptyMedia = errors.New("anki: empty media data")

// ErrBadRequest marks a client-side mistake in the bridge input —
// malformed addNote params, a non-array media entry, non-base64
// media data, etc. The /v1/anki/action handler maps this to 400
// (with a short reason). Wrap via fmt.Errorf("%w: <context>", ErrBadRequest)
// so the unwrapped chain carries the human-friendly message; the
// handler unwraps with errors.Is and trims the chain.
var ErrBadRequest = errors.New("anki: bad request")

// hashPrefixLen is the number of leading hex characters of SHA-256 used
// for the deterministic filename (10 hex = 40 bits; collision-safe for
// the per-session scale AnkiDroid deals with, and short enough to keep
// filenames readable).
const hashPrefixLen = 10

// sanitizeComponent replaces every character outside [a-zA-Z0-9_-] with
// '_'. Empty inputs collapse to "_" so the resulting filename is never
// ambiguous. Used for both prefix and extension parts.
//
// We reject "/" and "\" explicitly before the regex pass because path
// separators MUST be sanitized to '_' regardless of position, and the
// regex already covers them — but the comment pins the contract:
// callers never see a sanitized value that could be re-parsed as a path
// component.
func sanitizeComponent(s string) string {
	if s == "" {
		return "_"
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	out := b.String()
	if out == "" {
		return "_"
	}
	return out
}

// splitStemExt splits a caller-provided filename into its stem and
// extension. The split is on the LAST '.'; filenames with no '.' get
// ("<full>", ""). Leading dots are NOT a hidden-file shortcut: ".bashrc"
// → (".bashrc", ""). The contract is "use whatever the caller gave,
// sanitized" — AnkiDroid stores media by name, not by extension, so the
// extension here is purely cosmetic / informational. Both pieces are
// sanitized separately before being assembled into the deterministic
// filename.
func splitStemExt(name string) (stem, ext string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", ""
	}
	idx := strings.LastIndex(name, ".")
	if idx <= 0 {
		// No dot, or only a leading dot (.bashrc): no extension to extract.
		return name, ""
	}
	return name[:idx], name[idx+1:]
}

// GenerateFilename assembles the deterministic content-hash filename
// for the given prefix and extension. data is the media bytes; the same
// bytes always produce the same filename, so re-exports overwrite the
// same file and AnkiDroid never accumulates duplicates. prefix and ext
// are sanitized before assembly. Default prefix "media" and ext "bin"
// are used when the caller passes empty strings (e.g. an AnkiConnect
// audio entry with no filename field).
//
// Format: <prefix>_<10 hex chars of sha256(data)>.<ext>
// Example: entei_audio_a1b2c3d4e5.webm
//
// The web-side generateMediaFilename (apps/web/src/features/anki/...)
// computes the same hash + prefix layout, so the server-side write here
// always lands on the filename the client expects to reference.
func GenerateFilename(prefix, ext string, data []byte) string {
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	if hashPrefixLen < len(hash) {
		hash = hash[:hashPrefixLen]
	}
	if prefix == "" {
		prefix = "media"
	}
	if ext == "" {
		ext = "bin"
	}
	return sanitizeComponent(prefix) + "_" + hash + "." + sanitizeComponent(ext)
}

// GenerateFilenameFromProvided parses a caller-provided "filename" into
// stem/extension, sanitizes each, and assembles the deterministic name
// over the data hash. When provided is empty the same default
// ("media_<hash>.bin") is used. Always sanitize first, then hash — the
// filename in the response carries the sanitized form so AnkiDroid
// indexes it the same way it would any user-supplied name.
//
// "If filename is absent but data present, generate the name; if both
// present, use the given name's sanitized form + hash" — spec §2.3, §3.
// This helper makes the rewrite uniform on both branches.
func GenerateFilenameFromProvided(provided string, data []byte) string {
	stem, ext := splitStemExt(provided)
	return GenerateFilename(stem, ext, data)
}

// detectCollectionMediaDir probes the candidates in order
// (1. legacy AnkiDroid path, 2. /sdcard symlink path, 3. caller
// override) and returns the first directory that accepts a write+delete
// probe. Implementation lives in the build-tagged probe files:
//
//   - media_probe_android.go  (//go:build android || linux): real probe.
//   - media_probe_other.go    (//go:build !android && !linux):
//     ErrUnsupportedPlatform.
//
// detectCollectionMediaDir resolves the AnkiDroid collection.media
// directory (spec v4.x). The override, when non-empty, is the
// --anki-collection flag's sibling resolution; an empty override
// means "use the auto-detect candidates".
func detectCollectionMediaDir(override string) (string, error) {
	return probeCollectionMediaDir(override)
}

// MediaWriter writes media bytes into the detected AnkiDroid
// collection.media directory. Construction probes for a writable dir;
// Write then assembles a deterministic content-hash filename and writes
// the file (create-or-overwrite, mode 0644). Errors are returned
// verbatim — callers (the API layer) translate them to HTTP status codes
// without disclosing local paths.
type MediaWriter struct {
	dir string // resolved collection.media directory (absolute, writable)
}

// NewMediaWriter probes the collection.media directory candidates and
// returns a MediaWriter bound to the first writable candidate, or an
// error (ErrUnsupportedPlatform on Windows / dev builds; probe failures
// on Android/Linux are surfaced as-is so the caller can guide the user).
// The resolved directory is created if missing (mode 0775) before the
// final probe write, so first-run Termux without an existing AnkiDroid
// collection still succeeds.
func NewMediaWriter(override string) (*MediaWriter, error) {
	dir, err := detectCollectionMediaDir(override)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o775); err != nil {
		return nil, fmt.Errorf("anki: mkdir collection.media: %w", err)
	}
	if !probeWritable(dir) {
		return nil, fmt.Errorf("anki: collection.media %s is not writable", redactPath(dir))
	}
	return &MediaWriter{dir: dir}, nil
}

// Dir returns the resolved collection.media directory. Safe to expose
// in the companion status line (the path is not sensitive per spec §9).
func (w *MediaWriter) Dir() string {
	if w == nil {
		return ""
	}
	return w.dir
}

// NewMediaWriterForTest returns a MediaWriter bound to the given
// directory WITHOUT running the platform-conditional probe. Test-only
// helper: the probe is meaningful only on Android/Termux where the
// legacy /storage/emulated/0 path resolves. Tests in this package
// point the writer at t.TempDir() and exercise Write / ProbeWritable
// directly; the production entry point remains NewMediaWriter.
//
// The probe is NOT run by this constructor. Callers that want to
// assert writability at construction time must invoke ProbeWritable
// explicitly. The test suite does not rely on that contract — Write
// itself runs MkdirAll before each write, so a missing dir is
// recovered at request time.
func NewMediaWriterForTest(dir string) *MediaWriter {
	return &MediaWriter{dir: dir}
}

// probeWritable writes and deletes a temp file in dir to confirm a
// usable write surface (the directory may exist and be stat-able but
// still reject writes because of SELinux / scoped-storage policy on
// Android 11+ without MANAGE_EXTERNAL_STORAGE). On Android the
// probe runs in the collection.media directory itself; the temp name
// is anchored under a hidden prefix so a parallel AnkiDroid media scan
// never picks it up.
func probeWritable(dir string) bool {
	name := filepath.Join(dir, ".anki-probe")
	if err := os.WriteFile(name, []byte("probe"), 0o644); err != nil {
		return false
	}
	_ = os.Remove(name)
	return true
}

// Write writes data to the collection.media directory under a
// deterministic content-hash filename and returns the stored name. The
// data MUST be non-empty (the handler validates this). The directory
// is created on demand (Termux bootstrap never creates the legacy
// path until first AnkiDroid launch, but the bootstrap may install the
// app before that).
//
// "Overwrite-if-exists" is the spec's intent: re-exports of the same
// media bytes must hit the same file. os.WriteFile truncates and
// rewrites — no rename dance, no .tmp file left behind. The single
// failure mode the handler maps specifically is ErrUnsupportedPlatform
// (503 / disabled); everything else is 500 with a generic message.
func (w *MediaWriter) Write(filename string, data []byte) (string, error) {
	if w == nil {
		return "", ErrUnsupportedPlatform
	}
	if len(data) == 0 {
		return "", ErrEmptyMedia
	}
	// Ensure the configured directory exists on every write: AnkiDroid
	// may have been uninstalled, the user may have revoked storage
	// permission, or the auto-detected legacy path may have been
	// recreated on demand. os.MkdirAll is a no-op when the dir already
	// exists, so the cost on the happy path is one stat() syscall.
	if err := os.MkdirAll(w.dir, 0o775); err != nil {
		return "", fmt.Errorf("anki: mkdir %s: %w", redactPath(w.dir), err)
	}
	stored := GenerateFilenameFromProvided(filename, data)
	// Non-atomic overwrite (intentional): the deterministic name means
	// re-exports of the same bytes ALWAYS hit the same path, so the
	// only thing that can be visible to a concurrent reader mid-write
	// is a half-written file with the SAME final bytes. If the write
	// fails partway (crash / disk full / ENOSPC), AnkiDroid's media
	// scan simply won't index this filename until the next export
	// re-writes it — there is no other writer. The handler is the
	// single producer, so we skip the tmp+rename dance.
	if err := os.WriteFile(filepath.Join(w.dir, stored), data, 0o644); err != nil {
		return "", fmt.Errorf("anki: write %s: %w", redactPath(stored), err)
	}
	return stored, nil
}

// ProbeWritable is the same write+delete probe used internally by
// NewMediaWriter, exposed for the companion status line to
// re-check writability (AnkiDroid may have been uninstalled, the
// user may have revoked storage permission, or the directory may
// have been moved by the device). It is intentionally cheap (one
// tiny file write + remove) and never logs anything.
//
// Returning false on a non-Android/non-Linux build (probe is
// platform-conditional internally) is the right answer — the bridge
// can't write there, so the status line reports "not writable" and
// the developer sees the same shape as the device.
func ProbeWritable(dir string) bool {
	return probeWritable(dir)
}

// redactPath replaces every non-trailing path segment with "..." so a
// diagnostic line never echoes the full AnkiDroid directory layout. The
// filename itself is preserved (it is the value returned to the
// client). Spec §9: paths in error messages must not leak the device
// tree.
func redactPath(name string) string {
	if name == "" {
		return ""
	}
	dir, file := filepath.Split(name)
	if dir == "" {
		return file
	}
	return ".../" + file
}