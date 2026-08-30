//go:build !android && !linux

package anki

// probeCollectionMediaDir on non-Android, non-Linux platforms returns
// ErrUnsupportedPlatform. The AnkiDroid collection.media probe is
// meaningful only inside the Termux app on Android (where
// /storage/emulated/0/AnkiDroid resolves) and on a Linux dev box
// pointed at a real device over adb. Windows / macOS dev builds get
// the bridge routes registered but every Write / detect attempt fails
// with a clear "not supported on this platform" error so the developer
// can tell disabled-bridge (404) from wrong-host (503).
//
// The companion command checks --anki-proxy on its own: when the URL
// is empty no AnkiDroid routes register at all. The 503 only appears
// when the user explicitly opted in (the default) on a non-Android
// host — the spec's "bridge running on the wrong host" case.
func probeCollectionMediaDir(override string) (string, error) {
	_ = override
	return "", ErrUnsupportedPlatform
}