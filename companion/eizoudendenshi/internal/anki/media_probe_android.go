//go:build android || linux

package anki

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// AnkiDroid collection.media candidate paths (spec §5). The legacy path
// is preferred because:
//   - Android 8〜15 all support Termux direct writes there when the
//     user has granted storage permission.
//   - The /sdcard/ entry is the same physical location on every
//     Android version (a symlink to /storage/emulated/0), but in
//     practice symlink resolution can be blocked by scoped storage on
//     11+ when MANAGE_EXTERNAL_STORAGE is missing — the legacy spelling
//     survives when the symlink spelling does not.
//   - The caller override wins last; the user explicitly chose the
//     path in Entei settings (spec §2.4) and must take precedence.
var collectionMediaCandidates = []string{
	"/storage/emulated/0/AnkiDroid/collection.media",
	"/sdcard/AnkiDroid/collection.media",
}

// probeCollectionMediaDir probes each candidate directory for write
// access and returns the first one that accepts a temp file. The
// override, when non-empty, is tested last (the user knows better than
// the auto-detect order, but the auto-detect order should still run
// first — typical Android installs land on the legacy path and the
// override is for the rare custom-collection case).
//
// A write+delete probe (os.WriteFile + os.Remove) is the spec-defined
// "did the helper actually accept bytes" check. The directory may
// stat as writable (mode bits / owner) and still reject writes under
// Android 11+ scoped storage without MANAGE_EXTERNAL_STORAGE.
func probeCollectionMediaDir(override string) (string, error) {
	for _, candidate := range collectionMediaCandidates {
		dir, err := probeOneDir(candidate)
		if err == nil {
			return dir, nil
		}
	}
	if override != "" {
		dir, err := probeOneDir(override)
		if err == nil {
			return dir, nil
		}
	}
	return "", errors.New("anki: no writable AnkiDroid collection.media candidate (grant Termux storage access and ensure AnkiDroid uses the legacy /storage/emulated/0/AnkiDroid/ path)")
}

// probeOneDir probes a single candidate: stat → MkdirAll (so first-run
// Termux succeeds even before AnkiDroid's first launch) → write+delete
// a temp file. Returns the absolute resolved directory on success.
// Errors are deliberately swallowed by the caller (each candidate is
// tried in order; one failure does not mean the next will also fail).
func probeOneDir(candidate string) (string, error) {
	abs, err := filepath.Abs(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", candidate, err)
	}
	if err := os.MkdirAll(abs, 0o775); err != nil {
		return "", fmt.Errorf("mkdir %s: %w", redactPath(abs), err)
	}
	if !probeWritable(abs) {
		return "", fmt.Errorf("not writable: %s", redactPath(abs))
	}
	return abs, nil
}