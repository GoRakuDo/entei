package anki

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestSanitizeComponent pins the character class allowed in deterministic
// filenames: any rune outside [a-zA-Z0-9_-] is replaced with '_', and an
// empty input collapses to "_". The replacement is character-wise so
// multi-byte UTF-8 inputs become one underscore per rune (safe — UTF-8
// boundary is preserved and no rune is dropped).
func TestSanitizeComponent(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", "_"},
		{"hello", "hello"},
		{"hello-world_42", "hello-world_42"},
		{"a/b\\c", "a_b_c"},
		{"with spaces", "with_spaces"},
		// ; and the two spaces are non-alphanumeric → '_'; '-' is kept.
		// "weird" + ';'→_ + 'rm' + ' '→_ + '-' + 'rf' + ' '→_ + 'rf'
		// = "weird_rm_-rf"
		{"weird;rm -rf", "weird_rm_-rf"},
		// 3 runes (日, 本, 語) → 3 underscores; UTF-8 boundary preserved.
		{"日本語", "___"},
		{".", "_"},
		{"_", "_"},
		{"-", "-"},
	}
	for _, c := range cases {
		if got := sanitizeComponent(c.in); got != c.want {
			t.Errorf("sanitizeComponent(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestSplitStemExt pins the basename / extension split: the LAST dot
// is the separator (so "audio.v2.webm" → "audio.v2" + "webm"), leading
// dots are NOT a hidden-file shortcut, empty / whitespace input is a
// ("" , "") pair so callers can short-circuit on missing filename.
func TestSplitStemExt(t *testing.T) {
	cases := []struct {
		in, stem, ext string
	}{
		{"audio.webm", "audio", "webm"},
		{"entei_audio_a1b2c3d4e5.webm", "entei_audio_a1b2c3d4e5", "webm"},
		{"noext", "noext", ""},
		{".hidden", ".hidden", ""},     // leading dot: no extension
		{"weird.tar.gz", "weird.tar", "gz"},
		{"", "", ""},
		{"   ", "", ""},
		{"trailing.", "trailing", ""},   // trailing dot: empty extension
	}
	for _, c := range cases {
		s, e := splitStemExt(c.in)
		if s != c.stem || e != c.ext {
			t.Errorf("splitStemExt(%q) = (%q, %q), want (%q, %q)", c.in, s, e, c.stem, c.ext)
		}
	}
}

// TestGenerateFilenameDeterminism pins the deterministic-naming contract:
// same bytes → same filename, different bytes → different filename. The
// web-side generateMediaFilename (apps/web/src/features/anki/...) uses
// the same shape (SHA-256 prefix + sanitized prefix + sanitized ext);
// both sides must produce identical strings for identical inputs, or
// the server-side write would land on a different file than the
// client-side reference.
func TestGenerateFilenameDeterminism(t *testing.T) {
	data := []byte("opaque media bytes — sample")
	got1 := GenerateFilename("entei_audio", "webm", data)
	got2 := GenerateFilename("entei_audio", "webm", data)
	if got1 != got2 {
		t.Fatalf("same bytes produced different names: %q vs %q", got1, got2)
	}
	if !strings.HasPrefix(got1, "entei_audio_") {
		t.Errorf("filename %q missing prefix", got1)
	}
	if !strings.HasSuffix(got1, ".webm") {
		t.Errorf("filename %q missing .webm extension", got1)
	}

	// Different bytes → different filename (the hash component changes).
	other := []byte("opaque media bytes — sample 2")
	if got := GenerateFilename("entei_audio", "webm", other); got == got1 {
		t.Fatalf("different bytes produced the same name %q (hash collision on 40-bit prefix — try more bytes)", got)
	}

	// The hash portion must be the first 10 hex chars of SHA-256 over
	// the input bytes. This pins the format so future refactors cannot
	// silently change the layout (the client-side import depends on it).
	sum := sha256.Sum256(data)
	wantHash := hex.EncodeToString(sum[:])[:hashPrefixLen]
	if !strings.Contains(got1, wantHash) {
		t.Errorf("filename %q missing expected hash %q", got1, wantHash)
	}
}

// TestGenerateFilenameDefaultPrefixExt pins the fallback for a missing
// filename: default prefix "media" and default extension "bin", still
// deterministic and still sanitized. The caller-supplied "filename" can
// be absent on AnkiConnect audio entries that reference a
// previously-stored file by URL/path.
func TestGenerateFilenameDefaultPrefixExt(t *testing.T) {
	data := []byte("bytes")
	got := GenerateFilename("", "", data)
	if !strings.HasPrefix(got, "media_") {
		t.Errorf("default prefix: %q missing 'media_'", got)
	}
	if !strings.HasSuffix(got, ".bin") {
		t.Errorf("default ext: %q missing '.bin'", got)
	}
}

// TestGenerateFilenameFromProvided pins the "sanitize first, then hash"
// contract used by the addNote rewrite: when the caller supplies a
// filename, the stem + extension are derived from the sanitized form,
// then the hash is appended. Two callers supplying the SAME input
// filename for the SAME bytes always hit the same file (the re-export
// guarantee); two callers supplying DIFFERENT filenames land on
// DIFFERENT files (each per-name slot has its own deterministic slot —
// that's by design, the caller picks the slot).
//
// The sanitization step guarantees the stored name never contains a
// path separator regardless of caller input.
func TestGenerateFilenameFromProvided(t *testing.T) {
	data := []byte("the bytes")

	// Same filename twice → same stored name.
	a1 := GenerateFilenameFromProvided("audio.webm", data)
	a2 := GenerateFilenameFromProvided("audio.webm", data)
	if a1 != a2 {
		t.Fatalf("same filename + same bytes should give same name: %q vs %q", a1, a2)
	}

	// Dirty filename is sanitized: no path separator, no "..".
	dirty := GenerateFilenameFromProvided("a/b\\c.weird", data)
	if strings.ContainsAny(dirty, "/\\") || strings.Contains(dirty, "..") {
		t.Errorf("dirty input not sanitized: %q", dirty)
	}
	// Both forms must be deterministic for the same bytes.
	if !strings.Contains(dirty, "_") || !strings.HasSuffix(dirty, ".weird") {
		t.Errorf("sanitized shape wrong: %q", dirty)
	}

	// No filename → defaults.
	defaultName := GenerateFilenameFromProvided("", data)
	if defaultName == a1 {
		t.Errorf("no-filename default collided with caller-supplied name: %q", defaultName)
	}
	if !strings.HasPrefix(defaultName, "media_") || !strings.HasSuffix(defaultName, ".bin") {
		t.Errorf("no-filename default shape wrong: %q", defaultName)
	}
}

// TestMediaWriterWriteDeterministicOverwrite pins the re-export
// contract: writing the same bytes twice produces the same stored
// filename, the second write truncates the first, and the on-disk
// bytes match the input. Test is platform-agnostic: it bypasses the
// probe by constructing the writer directly against t.TempDir().
func TestMediaWriterWriteDeterministicOverwrite(t *testing.T) {
	dir := t.TempDir()
	w := &MediaWriter{dir: dir}

	first := []byte("first version of the bytes")
	stored1, err := w.Write("audio.webm", first)
	if err != nil {
		t.Fatalf("first Write: %v", err)
	}

	// Sanity: the stored name format and the file exists.
	if stored1 == "" {
		t.Fatal("stored name is empty")
	}
	if !strings.HasSuffix(stored1, ".webm") {
		t.Errorf("stored = %q, missing .webm", stored1)
	}
	path := filepath.Join(dir, stored1)
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !bytes.Equal(got, first) {
		t.Errorf("file bytes = %q, want %q", got, first)
	}

	// Second write with the SAME bytes → same stored name → overwrite.
	second := []byte("first version of the bytes") // identical content
	stored2, err := w.Write("audio.webm", second)
	if err != nil {
		t.Fatalf("second Write: %v", err)
	}
	if stored2 != stored1 {
		t.Errorf("deterministic name changed: %q → %q", stored1, stored2)
	}
	got, err = os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back after overwrite: %v", err)
	}
	if !bytes.Equal(got, first) {
		t.Errorf("file bytes after overwrite = %q, want %q", got, first)
	}

	// Third write with DIFFERENT bytes → different stored name → two files.
	third := []byte("different bytes entirely")
	stored3, err := w.Write("audio.webm", third)
	if err != nil {
		t.Fatalf("third Write: %v", err)
	}
	if stored3 == stored1 {
		t.Errorf("different bytes produced the same stored name %q", stored1)
	}
	if _, err := os.Stat(filepath.Join(dir, stored3)); err != nil {
		t.Errorf("third file missing: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("first file vanished: %v", err)
	}
}

// TestMediaWriterWriteEmptyData pins the empty-data guard: writing a
// zero-byte file would create a permanent dead entry in Anki's
// collection.media (and a deterministic name collision risk). The writer
// returns ErrEmptyMedia so the handler maps it to 400.
func TestMediaWriterWriteEmptyData(t *testing.T) {
	dir := t.TempDir()
	w := &MediaWriter{dir: dir}
	_, err := w.Write("audio.webm", nil)
	if !errors.Is(err, ErrEmptyMedia) {
		t.Errorf("nil data: err = %v, want ErrEmptyMedia", err)
	}
	_, err = w.Write("audio.webm", []byte{})
	if !errors.Is(err, ErrEmptyMedia) {
		t.Errorf("empty data: err = %v, want ErrEmptyMedia", err)
	}
}

// TestMediaWriterWriteDirMissing pins the on-demand directory creation:
// when the configured collection.media dir was removed between
// construction and write, Write must recreate it (MkdirAll under
// MediaWriter's chosen directory). On Windows os.MkdirAll is a no-op
// for mode bits but still creates the directory.
func TestMediaWriterWriteDirMissing(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "collection.media")
	w := &MediaWriter{dir: target}
	if err := os.RemoveAll(target); err != nil {
		t.Fatalf("remove target: %v", err)
	}
	stored, err := w.Write("audio.webm", []byte("bytes"))
	if err != nil {
		t.Fatalf("Write after dir removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, stored)); err != nil {
		t.Errorf("stored file missing: %v", err)
	}
}

// TestMediaWriterUnsupportedPlatform pins the platform split: on every
// host outside android + linux the probe returns ErrUnsupportedPlatform
// so the API layer can map /v1/anki/media to 503. NewMediaWriter is the
// public entry point — it must surface the same error verbatim.
func TestMediaWriterUnsupportedPlatform(t *testing.T) {
	if runtime.GOOS == "android" || runtime.GOOS == "linux" {
		t.Skip("supported platform: /storage/emulated/0 probe runs and may succeed or fail based on environment, not what this test pins")
	}
	_, err := NewMediaWriter("")
	if !errors.Is(err, ErrUnsupportedPlatform) {
		t.Errorf("NewMediaWriter on %s: err = %v, want ErrUnsupportedPlatform", runtime.GOOS, err)
	}
}

// TestProbeWritable pins the probe: write a temp file in the directory
// and confirm it is removed (no leak across calls). The probe is what
// gates both construction and the /v1/anki/status "mediaDirWritable"
// field — a leak would accumulate dead files in the user's
// collection.media.
func TestProbeWritable(t *testing.T) {
	dir := t.TempDir()
	if !probeWritable(dir) {
		t.Fatal("probe rejected a writable temp dir")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".anki-probe") {
			t.Errorf("probe leaked %s in dir", e.Name())
		}
	}

	// A non-existent path: probe must NOT panic and must return false
	// (the candidate then falls through to the next on the probe list).
	if probeWritable(filepath.Join(dir, "does-not-exist")) {
		t.Fatal("probe returned true for a non-existent directory")
	}
}

// TestRedactPath pins the diagnostic-redaction contract: the trailing
// path component (the filename itself) is preserved; everything before
// it collapses to ".../" so the error line never echoes the full
// /storage/emulated/0 tree.
func TestRedactPath(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"audio.webm", "audio.webm"}, // bare filename: no dir to redact
		{"/storage/emulated/0/AnkiDroid/collection.media/audio.webm", ".../audio.webm"},
		{"/tmp/dir/x", ".../x"},
		{filepath.Join("a", "b", "c", "d.bin"), ".../d.bin"},
	}
	for _, c := range cases {
		if got := redactPath(c.in); got != c.want {
			t.Errorf("redactPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestProbeWritablePublicShim pins the contract of the exported
// ProbeWritable helper: it is the same write+delete probe used by
// NewMediaWriter, exposed so /v1/anki/status can re-check writability
// on each poll. Re-exporting the internal probe keeps the api layer
// free of platform-conditional imports.
func TestProbeWritablePublicShim(t *testing.T) {
	dir := t.TempDir()
	if !ProbeWritable(dir) {
		t.Fatal("ProbeWritable rejected a writable temp dir")
	}
	if ProbeWritable(filepath.Join(dir, "missing")) {
		t.Fatal("ProbeWritable returned true for a missing dir")
	}
}

// TestMediaWriterWriteFilenameSanitized pins the sanitization contract
// for caller-provided filenames: a malicious / separator never produces
// a path-traversal file. The stored name is sanitized stem + hash +
// sanitized ext, period.
func TestMediaWriterWriteFilenameSanitized(t *testing.T) {
	dir := t.TempDir()
	w := &MediaWriter{dir: dir}
	stored, err := w.Write("../../etc/passwd", []byte("data"))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if strings.Contains(stored, "/") || strings.Contains(stored, "\\") {
		t.Errorf("stored name %q contains a path separator", stored)
	}
	if strings.Contains(stored, "..") {
		t.Errorf("stored name %q contains '..'", stored)
	}
	// And the file landed in the configured dir, nowhere else.
	path := filepath.Join(dir, stored)
	if _, err := os.Stat(path); err != nil {
		t.Errorf("stored file missing in dir: %v", err)
	}
}