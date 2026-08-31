//go:build android || linux

package anki

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCollectionMediaCandidatesPinsAndroidMediaFirst pins the spec v4.2
// (2026-08-31) candidate order: the Android/media path is the FIRST
// candidate, ahead of the legacy /storage/emulated/0/AnkiDroid/ path
// and the /sdcard/ symlink. The order matters because
// probeCollectionMediaDir prefers the first candidate whose sibling
// collection.anki2 exists (pass 1), then falls back to the first
// candidate that accepts a write+delete probe (pass 2) — reordering
// this slice silently downgrades the preferred AnkiDroid path back to
// legacy and breaks the MANAGE_EXTERNAL_STORAGE-free install path
// verified on a real device.
func TestCollectionMediaCandidatesPinsAndroidMediaFirst(t *testing.T) {
	if len(collectionMediaCandidates) == 0 {
		t.Fatal("collectionMediaCandidates is empty")
	}
	want := "/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/collection.media"
	if got := collectionMediaCandidates[0]; got != want {
		t.Errorf("collectionMediaCandidates[0] = %q, want %q (Android/media must be preferred on Android 11+)", got, want)
	}
	// Legacy + /sdcard fallbacks must remain (some installs still
	// live there, especially pre-Android-11 devices or users who
	// never changed the AnkiDroid directory setting).
	wantLegacy := "/storage/emulated/0/AnkiDroid/collection.media"
	wantSdcard := "/sdcard/AnkiDroid/collection.media"
	foundLegacy, foundSdcard := false, false
	for _, c := range collectionMediaCandidates {
		if c == wantLegacy {
			foundLegacy = true
		}
		if c == wantSdcard {
			foundSdcard = true
		}
	}
	if !foundLegacy {
		t.Error("legacy /storage/emulated/0/AnkiDroid/collection.media candidate missing")
	}
	if !foundSdcard {
		t.Error("/sdcard/AnkiDroid/collection.media candidate missing")
	}
}

// TestProbeOneDirAndroidMediaPath pins the per-candidate probe with
// the Android/media path rewritten into a writable temp dir: when the
// resolved candidate directory accepts a write+delete probe,
// probeOneDir returns the absolute resolved path. The test does NOT
// touch the real /storage/emulated/0 tree — it substitutes a
// rewritten candidate to confirm the probe logic itself is path-shape
// agnostic (the slash layout matters for the override sanity check
// below, not for the probe mechanic).
func TestProbeOneDirAndroidMediaPath(t *testing.T) {
	root := t.TempDir()
	// Mirror the Android/media directory layout under t.TempDir() so
	// the absolute resolved path has the same trailing slash shape
	// AnkiDroid expects.
	target := filepath.Join(root, "Android", "media", "com.ichi2.anki", "files", "AnkiDroid", "collection.media")
	dir, err := probeOneDir(target)
	if err != nil {
		t.Fatalf("probeOneDir(%q): %v", target, err)
	}
	if dir != target {
		t.Errorf("probeOneDir returned %q, want %q", dir, target)
	}
	// The probe must have MkdirAll'd the intermediate directories
	// (first-run Termux without an existing AnkiDroid collection
	// must still succeed).
	if st, err := os.Stat(target); err != nil || !st.IsDir() {
		t.Errorf("probed dir missing or not a directory: %v", err)
	}
}

// TestProbeOneDirPathShape pins that probeOneDir uses the resolved
// absolute candidate literally (no canonicalization, no /sdcard/
// rewriting). The AnkiDroid collection.media directory MUST land on
// exactly the path the candidate specified — filepath.Dir of that
// path is what resolveAnkiBridge uses to derive the sibling
// collection.anki2, so any path-shape drift would silently send the
// bridge at the wrong location.
func TestProbeOneDirPathShape(t *testing.T) {
	root := t.TempDir()
	candidate := filepath.Join(root, "storage", "emulated", "0", "Android", "media", "com.ichi2.anki", "files", "AnkiDroid", "collection.media")
	dir, err := probeOneDir(candidate)
	if err != nil {
		t.Fatalf("probeOneDir: %v", err)
	}
	if dir != candidate {
		t.Errorf("probeOneDir = %q, want literal %q (no rewriting)", dir, candidate)
	}
	// And the sibling that resolveAnkiBridge would derive lands at
	// the expected shape — not at /storage/emulated/0/AnkiDroid/ or
	// some symlink-resolved equivalent.
	wantSibling := filepath.Join(root, "storage", "emulated", "0", "Android", "media", "com.ichi2.anki", "files", "AnkiDroid", "collection.anki2")
	if got := filepath.Join(filepath.Dir(dir), "collection.anki2"); got != wantSibling {
		t.Errorf("sibling = %q, want %q (resolveAnkiBridge would point at the wrong collection)", got, wantSibling)
	}
}

// TestProbeCollectionMediaDirNoWritableCandidate pins the two-pass
// fallback path: when no candidate (and no override) resolves, the
// function returns a non-nil error. The error message must point the
// user at the spec-correct recommended setup — the Android/media path
// — so the user doesn't have to dig through code to learn what
// path to grant access to.
func TestProbeCollectionMediaDirNoWritableCandidate(t *testing.T) {
	// probeCollectionMediaDir walks the real candidates; on a Linux
	// dev box /storage/emulated/0 will be absent. We don't assert
	// that — only that any returned error is non-nil and mentions
	// the recommended Android/media path (so the user knows exactly
	// what to grant access to).
	_, err := probeCollectionMediaDir("")
	if err == nil {
		t.Skip("a candidate unexpectedly resolved on this dev box; the no-writable-candidate path is unreachable here")
	}
	want := "/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid"
	if !strings.Contains(err.Error(), want) {
		t.Errorf("error %q does not mention the recommended Android/media path %q (user-facing message lost the recommended setup)", err, want)
	}
	if errors.Is(err, ErrUnsupportedPlatform) {
		t.Errorf("probe on android/linux build must NOT surface ErrUnsupportedPlatform, got %v", err)
	}
}

// TestProbeOneDirFailureSurfaces pins the swallow-one-candidate
// behavior implicit in probeCollectionMediaDir: a single candidate
// failure must NOT abort the probe early. We can't easily exercise
// that through probeCollectionMediaDir on a Linux dev box (the real
// candidates don't exist), so we drive probeOneDir directly and
// confirm a permission-style failure returns an error without
// panicking. The loop contract is the caller's job; we only pin that
// one failure here is recoverable.
func TestProbeOneDirFailureSurfaces(t *testing.T) {
	// A path under a file (not a directory) cannot have a sibling
	// MkdirAll'd — pass a file path that exists but is not a dir to
	// make MkdirAll fail.
	f := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	candidate := filepath.Join(f, "collection.media")
	_, err := probeOneDir(candidate)
	if err == nil {
		t.Fatal("probeOneDir succeeded for a candidate under a regular file, want error")
	}
	// The error message must be wrapped with the candidate context
	// so the caller can attribute the failure to a specific path.
	if !strings.Contains(err.Error(), "mkdir") {
		t.Errorf("error %q does not mention mkdir (caller cannot attribute failure to the candidate)", err)
	}
}
