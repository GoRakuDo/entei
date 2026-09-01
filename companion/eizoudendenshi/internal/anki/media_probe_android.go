//go:build android || linux

package anki

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// AnkiDroid collection.media candidate paths (spec §5, v4.2 —
// 2026-08-31, Android/media path verified writable on a real device
// after termux-setup-storage + AnkiDroid permission grant). Order
// matters: probeCollectionMediaDir first prefers the candidate whose
// sibling collection.anki2 exists (pass 1), then falls back to the
// first candidate that accepts a write+delete probe (pass 2), so the
// preferred path MUST be the first entry. As of 2026-08-31 the
// preferred path is the Android/media equivalent, NOT the legacy
// /storage/emulated/0/AnkiDroid/ location.
//
// Why Android/media is preferred over legacy on Android 11+:
//   - On Android 11+ scoped storage blocks Termux writes to
//     /storage/emulated/0/AnkiDroid/ unless MANAGE_EXTERNAL_STORAGE
//     is granted via the "All files access" settings page.
//     /storage/emulated/0/Android/media/com.ichi2.anki/files/...
//     is the shared-media equivalent and IS reachable from Termux
//     with only termux-setup-storage + AnkiDroid's media permission
//     grant (verified on a real device).
//   - AnkiDroid's "AnkiDroid directory" setting (Settings →
//     Advanced → AnkiDroid directory) targets this Android/media
//     path on a clean install; setting it there keeps the collection
//     accessible to the companion without MANAGE_EXTERNAL_STORAGE.
//   - The /sdcard/ entry is the same physical location on every
//     Android version (a symlink to /storage/emulated/0), but in
//     practice symlink resolution can be blocked by scoped storage on
//     11+ when MANAGE_EXTERNAL_STORAGE is missing — the legacy
//     spelling survives when the symlink spelling does not.
//   - The caller override wins last; the user explicitly chose the
//     path in Entei settings (spec §2.4) and must take precedence.
var collectionMediaCandidates = []string{
	"/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/collection.media",
	"/storage/emulated/0/AnkiDroid/collection.media",
	"/sdcard/AnkiDroid/collection.media",
}

// probeCollectionMediaDir resolves the AnkiDroid collection.media
// directory with a two-pass probe:
//
//   - Pass 1: prefer the candidate that already has a collection.anki2
//     sibling — this correctly selects the active AnkiDroid directory
//     when multiple candidates are writable (e.g. Android 8-10 or
//     MANAGE_EXTERNAL_STORAGE granted). Two-pass avoids a fresh
//     install (no collection.anki2 yet) being missed by pass 1.
//   - Pass 2: fall back to the first writable candidate (fresh install:
//     collection.anki2 doesn't exist yet until AnkiDroid is configured).
//
// The override, when non-empty, is tested last (the user knows better
// than the auto-detect order, but the auto-detect order should still
// run first — Android 11+ installs land on the Android/media path and
// the override is for the rare custom-collection case).
//
// A write+delete probe (os.WriteFile + os.Remove) is the spec-defined
// "did the helper actually accept bytes" check. The directory may
// stat as writable (mode bits / owner) and still reject writes under
// Android 11+ scoped storage without MANAGE_EXTERNAL_STORAGE.
func probeCollectionMediaDir(override string) (string, error) {
	// Pass 1: prefer the candidate that already has a collection.anki2
	// sibling — this correctly selects the active AnkiDroid directory
	// when multiple candidates are writable (e.g. Android 8-10 or
	// MANAGE_EXTERNAL_STORAGE granted). Two-pass avoids a fresh install
	// (no collection.anki2 yet) being missed by pass 1.
	for _, candidate := range collectionMediaCandidates {
		dir, err := probeOneDir(candidate)
		if err == nil {
			sibling := filepath.Join(filepath.Dir(dir), "collection.anki2")
			if _, statErr := os.Stat(sibling); statErr == nil {
				return dir, nil
			}
		}
	}
	// Pass 2: fall back to first writable candidate (fresh install:
	// collection.anki2 doesn't exist yet until AnkiDroid is configured).
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
	return "", errors.New("anki: no writable AnkiDroid collection.media candidate (grant Termux storage access and set AnkiDroid directory to /storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid in AnkiDroid Settings)")
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
