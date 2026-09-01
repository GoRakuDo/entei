//go:build !android && !linux

package anki

// probeCollectionMediaDir on non-Android, non-Linux platforms returns
// ErrUnsupportedPlatform. The AnkiDroid collection.media probe is
// meaningful only inside the Termux app on Android (where
// /storage/emulated/0/AnkiDroid resolves) and on a Linux dev box
// pointed at a real device over adb. Windows / macOS dev builds get
// the bridge routes registered but every Write / detect attempt fails
// with a clear "not supported on this platform" error so the developer
// can tell disabled-bridge (no collection found → no 8765 listener)
// from wrong-host (ErrUnsupportedPlatform surfaces per-action).
//
// Spec v4.1 (2026-08-31): the bridge auto-derives — probe
// collection.media, then wire the sibling collection.anki2. No flags
// needed on the primary launch path; --anki-collection overrides the
// auto-derive for non-standard locations. ErrUnsupportedPlatform is
// surfaced per-action on notes-only bridges.
func probeCollectionMediaDir(override string) (string, error) {
	_ = override
	return "", ErrUnsupportedPlatform
}