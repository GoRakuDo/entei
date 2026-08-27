package update

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestChannelRoundTrip(t *testing.T) {
	root := t.TempDir()

	// Initial load when channel.json is absent: defaults to ChannelStable, nil error.
	ch, err := LoadChannel(root)
	if err != nil {
		t.Fatalf("LoadChannel missing file: %v", err)
	}
	if ch != ChannelStable {
		t.Fatalf("initial channel = %q, want %q", ch, ChannelStable)
	}

	// Save prerelease and load back.
	if err := SaveChannel(root, ChannelPrerelease); err != nil {
		t.Fatalf("SaveChannel(prerelease): %v", err)
	}
	ch, err = LoadChannel(root)
	if err != nil {
		t.Fatalf("LoadChannel(prerelease): %v", err)
	}
	if ch != ChannelPrerelease {
		t.Fatalf("loaded channel = %q, want %q", ch, ChannelPrerelease)
	}

	// Save stable and load back.
	if err := SaveChannel(root, ChannelStable); err != nil {
		t.Fatalf("SaveChannel(stable): %v", err)
	}
	ch, err = LoadChannel(root)
	if err != nil {
		t.Fatalf("LoadChannel(stable): %v", err)
	}
	if ch != ChannelStable {
		t.Fatalf("loaded channel = %q, want %q", ch, ChannelStable)
	}
}

func TestChannelMissingFileDefaultsToStable(t *testing.T) {
	root := t.TempDir()
	ch, err := LoadChannel(root)
	if err != nil {
		t.Fatalf("expected nil error on missing file, got %v", err)
	}
	if ch != ChannelStable {
		t.Fatalf("expected ChannelStable on missing file, got %q", ch)
	}
}

func TestChannelCorruptOrInvalidFailsClosedToStable(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "channel.json")

	tests := []struct {
		name    string
		content []byte
	}{
		{"empty file", []byte("")},
		{"corrupt JSON", []byte("not-json")},
		{"unsupported version", []byte(`{"version":2,"channel":"stable"}`)},
		{"unknown channel string", []byte(`{"version":1,"channel":"nightly"}`)},
		{"empty channel string", []byte(`{"version":1,"channel":""}`)},
		{"trailing data", []byte(`{"version":1,"channel":"stable"} extra`)},
		{"oversized file", bytes.Repeat([]byte(" "), maxChannelBytes+1)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := os.WriteFile(path, tt.content, 0o600); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}
			ch, err := LoadChannel(root)
			if err == nil {
				t.Fatalf("LoadChannel must return an error on %s", tt.name)
			}
			if ch != ChannelStable {
				t.Fatalf("LoadChannel must fail closed to ChannelStable, got %q", ch)
			}
		})
	}
}

func TestChannelSaveInvalidRejected(t *testing.T) {
	root := t.TempDir()
	for _, invalid := range []Channel{"", "nightly", "beta", "STABLE"} {
		if err := SaveChannel(root, invalid); err == nil {
			t.Fatalf("SaveChannel(%q) must fail for invalid channel", invalid)
		}
	}
}

func TestChannelAtomicWriteNoTempResidue(t *testing.T) {
	root := t.TempDir()

	for i := 0; i < 5; i++ {
		target := ChannelStable
		if i%2 != 0 {
			target = ChannelPrerelease
		}
		if err := SaveChannel(root, target); err != nil {
			t.Fatalf("SaveChannel iteration %d: %v", i, err)
		}
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}

	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".channel-") {
			t.Errorf("found leftover temp file: %s", e.Name())
		}
	}

	raw, err := os.ReadFile(filepath.Join(root, "channel.json"))
	if err != nil {
		t.Fatalf("ReadFile channel.json: %v", err)
	}
	var env channelEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if env.Version != 1 || env.Channel != ChannelStable {
		t.Fatalf("unexpected envelope content: %+v", env)
	}
}

func TestChannelDefaultStorageDirOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EIZOUDEN_CREDENTIAL_DIR", dir)

	if got, want := DefaultStorageDir(), dir; got != want {
		t.Fatalf("DefaultStorageDir() = %q, want %q", got, want)
	}

	// LoadChannel("") and SaveChannel("", ...) must target the overridden dir
	if err := SaveChannel("", ChannelPrerelease); err != nil {
		t.Fatalf("SaveChannel default root: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, "channel.json")); err != nil {
		t.Fatalf("channel.json not written to overridden root: %v", err)
	}

	ch, err := LoadChannel("")
	if err != nil {
		t.Fatalf("LoadChannel default root: %v", err)
	}
	if ch != ChannelPrerelease {
		t.Fatalf("LoadChannel = %q, want %q", ch, ChannelPrerelease)
	}
}
