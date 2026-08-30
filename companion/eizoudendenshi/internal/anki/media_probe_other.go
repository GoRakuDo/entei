//go:build !android && !linux

package anki

// probeCollectionMediaDir on non-Android, non-Linux platforms returns
// ErrUnsupportedPlatform. The AnkiDroid collection.media probe is
// meaningful only inside the Termux app on Android (where
// /storage/emulated/0/AnkiDroid resolves) and on a Linux dev box
// pointed at a real device over adb. Windows / macOS dev builds get
// the bridge routes registered but every Write / detect attempt fails
// with a clear "not supported on this platform" error so the developer
// can tell disabled-bridge (BOTH --anki-media-dir AND
// --anki-collection empty → 404) from wrong-host (this error → 503).
//
// Spec v3.0 (2026-08-30): the bridge is opt-in on TWO flags now
// (--anki-media-dir + --anki-collection). Either one alone enables
// the bridge; both empty disables it and the routes stay
// unregistered. The 503 only appears when the user explicitly opted
// in on a non-Android host — the spec's "bridge running on the wrong
// host" case.
func probeCollectionMediaDir(override string) (string, error) {
	_ = override
	return "", ErrUnsupportedPlatform
}