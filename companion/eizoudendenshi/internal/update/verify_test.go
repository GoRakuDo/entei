package update

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeMinisignDir plants a fake minisign executable named for the
// current platform into a temp dir and returns that dir.
func fakeMinisignDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	name := "minisign"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	b, err := os.ReadFile(fakeMinisignPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), b, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestResolveVerifierWindowsInstallRootPreferred(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows install-root verifier layout")
	}
	root := t.TempDir()
	installFakeVerifier(t, root)
	// PATH points elsewhere (nothing to find), the install-root
	// verifier must still be resolved.
	t.Setenv("PATH", t.TempDir())
	got, err := resolveVerifier(root)
	if err != nil {
		t.Fatalf("resolveVerifier: %v", err)
	}
	want := filepath.Join(root, "tools", "minisign.exe")
	if got != want {
		t.Fatalf("resolved verifier = %q, want %q", got, want)
	}
}

func TestResolveVerifierWindowsInstallRootWrongVersionFailsClosed(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows install-root verifier layout")
	}
	root := t.TempDir()
	installFakeVerifier(t, root)
	t.Setenv("FAKE_MINISIGN_VER", "0.9")
	// Even a good PATH verifier must NOT be used as a fallback when the
	// install-root verifier fails the version check (fail closed).
	t.Setenv("PATH", fakeMinisignDir(t))
	if _, err := resolveVerifier(root); err == nil {
		t.Fatal("an install-root verifier failing the version check must fail closed")
	}
}

func TestResolveVerifierPathFallback(t *testing.T) {
	root := t.TempDir() // no tools/minisign
	t.Setenv("PATH", fakeMinisignDir(t))
	got, err := resolveVerifier(root)
	if err != nil {
		t.Fatalf("resolveVerifier: %v", err)
	}
	if filepath.Base(got) != "minisign.exe" && filepath.Base(got) != "minisign" {
		t.Fatalf("resolved verifier = %q, want a PATH minisign", got)
	}
}

func TestResolveVerifierPathWrongVersionFailsClosed(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PATH", fakeMinisignDir(t))
	t.Setenv("FAKE_MINISIGN_VER", "0.11")
	if _, err := resolveVerifier(root); err == nil {
		t.Fatal("a PATH verifier failing the version check must fail closed")
	}
}

func TestResolveVerifierMissingFailsClosed(t *testing.T) {
	t.Setenv("PATH", "")
	if _, err := resolveVerifier(t.TempDir()); err == nil {
		t.Fatal("resolveVerifier must fail closed without any verifier")
	}
}

// TestVerifyMinisignFailClosed pins the fail-closed verification wiring:
// a failing verifier, a missing pinned key (placeholder), and a key
// that does not pass the shape check all fail closed; the key file is
// written only inside staging in the standard Minisign format.
func TestVerifyMinisignFailClosed(t *testing.T) {
	pinTestKey(t)
	root := t.TempDir()
	installFakeVerifier(t, root)
	verifier, err := resolveVerifier(root)
	if err != nil {
		t.Fatalf("resolveVerifier: %v", err)
	}
	staging := t.TempDir()
	file := filepath.Join(staging, "artifact.bin")
	if err := os.WriteFile(file, []byte("bytes"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Verifier fails (FAKE_MINISIGN_OK unset) -> fail closed.
	if err := verifyMinisign(verifier, file, staging); err == nil {
		t.Fatal("a failing verifier must fail closed")
	}
	// The pinned key file lives ONLY inside staging and is removed with
	// it (the staging dir is caller-owned); its format is the standard
	// Minisign key-file layout with the pinned key on the RW line.
	keyPath := filepath.Join(staging, ".pinned-pubkey")
	keyB, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("key file must be written to staging: %v", err)
	}
	if !strings.Contains(string(keyB), "untrusted comment: eizouden update public key\n"+PinnedPublicKey) {
		t.Fatalf("key file does not carry the pinned key in the standard format: %q", keyB)
	}

	// Success path with FAKE_MINISIGN_OK=1.
	t.Setenv("FAKE_MINISIGN_OK", "1")
	if err := verifyMinisign(verifier, file, staging); err != nil {
		t.Fatalf("verifyMinisign with an accepting verifier: %v", err)
	}
}

func TestKeyPinnedShape(t *testing.T) {
	orig := PinnedPublicKey
	defer func() { PinnedPublicKey = orig }()
	for _, tt := range []struct {
		key  string
		want bool
	}{
		{"REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY", false},
		{"", false},
		{"RWTQYXX35SPmSGxO2EUXXGCHfIV6EapS6rRRPvkVALs5zl9yE1qMMrWf", true},
		{"RWRQYXX35SPmSGxO2EUXXGCHfIV6EapS6rRRPvkVALs5zl9yE1qMMrWf", true},
		{"XWTQYXX35SPmSGxO2EUXXGCHfIV6EapS6rRRPvkVALs5zl9yE1qMMrWf", false},
		{"RW" + strings.Repeat("A", 10), false},                      // too short
		{"RW" + strings.Repeat("A", 120), false},                     // too long
		{"RWAAAAAAAAAAA!AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", false}, // bad chars
	} {
		PinnedPublicKey = tt.key
		if got := keyPinned(); got != tt.want {
			t.Errorf("keyPinned(%q) = %v, want %v", tt.key, got, tt.want)
		}
	}
}
