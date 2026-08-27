package update

import (
	"testing"
)

func TestSelectReleaseChannelFiltering(t *testing.T) {
	// Feed contains:
	// - 0.2.0-rc.22 (newest, published 2026-08-03)
	// - 0.2.0-rc.21 (published 2026-08-02)
	// - 0.2.0 (formal release, published 2026-08-01)
	// - 0.1.0 (older formal release, published 2026-07-01)
	rt := &feedRT{apiBody: feedBody(
		releaseEntry{
			tag:     "eizoudendenshi-v0.2.0-rc.22",
			pubTime: "2026-08-03T22:46:29Z",
			assets:  map[string]string{"a": releaseAssetURL("0.2.0-rc.22", "a")},
		},
		releaseEntry{
			tag:     "eizoudendenshi-v0.2.0-rc.21",
			pubTime: "2026-08-02T16:12:43Z",
			assets:  map[string]string{"a": releaseAssetURL("0.2.0-rc.21", "a")},
		},
		releaseEntry{
			tag:     "eizoudendenshi-v0.2.0",
			pubTime: "2026-08-01T12:00:00Z",
			assets:  map[string]string{"a": releaseAssetURL("0.2.0", "a")},
		},
		releaseEntry{
			tag:     "eizoudendenshi-v0.1.0",
			pubTime: "2026-07-01T12:00:00Z",
			assets:  map[string]string{"a": releaseAssetURL("0.1.0", "a")},
		},
	)}

	t.Run("prerelease channel picks newest rc", func(t *testing.T) {
		rel, err := selectRelease(rt.client(), ChannelPrerelease)
		if err != nil {
			t.Fatalf("selectRelease: %v", err)
		}
		if rel.Tag != "eizoudendenshi-v0.2.0-rc.22" {
			t.Fatalf("chosen tag = %q, want newest prerelease", rel.Tag)
		}
		if rel.Version != "0.2.0-rc.22" {
			t.Fatalf("version = %q, want 0.2.0-rc.22", rel.Version)
		}
	})

	t.Run("stable channel skips rc and falls back to newest formal release", func(t *testing.T) {
		rel, err := selectRelease(rt.client(), ChannelStable)
		if err != nil {
			t.Fatalf("selectRelease: %v", err)
		}
		if rel.Tag != "eizoudendenshi-v0.2.0" {
			t.Fatalf("chosen tag = %q, want formal release 0.2.0", rel.Tag)
		}
		if rel.Version != "0.2.0" {
			t.Fatalf("version = %q, want 0.2.0", rel.Version)
		}
	})

	t.Run("empty or unknown channel fails closed to stable behavior", func(t *testing.T) {
		for _, ch := range []Channel{"", "unknown", "beta"} {
			rel, err := selectRelease(rt.client(), ch)
			if err != nil {
				t.Fatalf("selectRelease(%q): %v", ch, err)
			}
			if rel.Tag != "eizoudendenshi-v0.2.0" {
				t.Fatalf("selectRelease(%q) tag = %q, want formal release 0.2.0", ch, rel.Tag)
			}
		}
	})
}

func TestSelectReleaseStableAllPrereleaseFailsClosed(t *testing.T) {
	// When feed contains only rc / prerelease candidates:
	// - ChannelPrerelease succeeds (picks newest rc)
	// - ChannelStable fails closed with "no matching release found"
	rt := &feedRT{apiBody: feedBody(
		releaseEntry{
			tag:     "eizoudendenshi-v0.2.0-rc.22",
			pubTime: "2026-08-03T22:46:29Z",
			assets:  map[string]string{"a": releaseAssetURL("0.2.0-rc.22", "a")},
		},
		releaseEntry{
			tag:     "eizoudendenshi-v0.2.0-rc.21",
			pubTime: "2026-08-02T16:12:43Z",
			assets:  map[string]string{"a": releaseAssetURL("0.2.0-rc.21", "a")},
		},
	)}

	if _, err := selectRelease(rt.client(), ChannelStable); err == nil {
		t.Fatal("selectRelease on stable channel must fail closed when all candidates are prerelease")
	}

	rel, err := selectRelease(rt.client(), ChannelPrerelease)
	if err != nil {
		t.Fatalf("selectRelease on prerelease channel failed: %v", err)
	}
	if rel.Tag != "eizoudendenshi-v0.2.0-rc.22" {
		t.Fatalf("chosen tag = %q, want eizoudendenshi-v0.2.0-rc.22", rel.Tag)
	}
}
