//go:build windows

package credential

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests run on the developer machine and exercise the real DPAPI
// round trip (current-user scope). They always use temp dirs — never the
// real user profile.

func TestWindowsStoreRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credential.bin")
	s := NewWindowsStore(path)

	if _, _, ok, err := s.Load(); err != nil || ok {
		t.Fatalf("initial Load = ok=%v err=%v, want ok=false err=nil", ok, err)
	}
	if err := s.Save(testToken); err != nil {
		t.Fatalf("Save: %v", err)
	}
	token, version, ok, err := s.Load()
	if err != nil || !ok {
		t.Fatalf("Load after Save = ok=%v err=%v", ok, err)
	}
	if token != testToken || version != CurrentVersion {
		t.Errorf("Load = %q v%d, want %q v%d", token, version, testToken, CurrentVersion)
	}

	// The persisted bytes MUST NOT contain the plaintext token or the
	// envelope JSON (DPAPI ciphertext only).
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if strings.Contains(string(raw), testToken) {
		t.Fatal("credential file contains the plaintext token")
	}
	if strings.Contains(string(raw), `"version"`) {
		t.Fatal("credential file contains the plaintext envelope JSON")
	}

	if err := s.Delete(); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, _, ok, err := s.Load(); err != nil || ok {
		t.Fatalf("Load after Delete = ok=%v err=%v", ok, err)
	}
}

func TestWindowsStoreFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credential.bin")

	t.Run("corrupt ciphertext rejected", func(t *testing.T) {
		if err := os.WriteFile(path, []byte("definitely not DPAPI"), 0o600); err != nil {
			t.Fatal(err)
		}
		s := NewWindowsStore(path)
		if token, _, ok, err := s.Load(); err == nil && ok {
			t.Fatalf("corrupt ciphertext must not yield a credential, got %q", token)
		}
		if _, _, _, err := s.Load(); err == nil {
			t.Fatal("expected fail-closed error for corrupt ciphertext")
		}
	})

	t.Run("plaintext JSON rejected", func(t *testing.T) {
		// A valid envelope stored WITHOUT DPAPI must not be accepted — the
		// stored form is DPAPI ciphertext, and unprotect of non-ciphertext
		// fails closed.
		plain, err := MarshalEnvelope(testToken)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, plain, 0o600); err != nil {
			t.Fatal(err)
		}
		s := NewWindowsStore(path)
		if _, _, ok, err := s.Load(); err == nil && ok {
			t.Fatal("plaintext envelope must not be accepted as a credential")
		}
	})

	t.Run("oversized ciphertext rejected", func(t *testing.T) {
		if err := os.WriteFile(path, []byte(strings.Repeat("x", MaxEnvelopeBytes+1)), 0o600); err != nil {
			t.Fatal(err)
		}
		s := NewWindowsStore(path)
		if _, _, _, err := s.Load(); err == nil {
			t.Fatal("expected error for oversized ciphertext")
		}
	})
}

func TestDefaultCredentialPathOverride(t *testing.T) {
	// The harness/test override must redirect the store away from the real
	// user profile — the whole point of EIZOUDEN_CREDENTIAL_DIR.
	dir := t.TempDir()
	t.Setenv("EIZOUDEN_CREDENTIAL_DIR", dir)
	got := DefaultCredentialPath()
	want := filepath.Join(dir, "credential.bin")
	if got != want {
		t.Fatalf("DefaultCredentialPath = %q, want %q", got, want)
	}

	s, err := NewDefaultStore()
	if err != nil {
		t.Fatalf("NewDefaultStore: %v", err)
	}
	if err := s.Save(testToken); err != nil {
		t.Fatalf("Save: %v", err)
	}
	token, _, ok, err := s.Load()
	if err != nil || !ok || token != testToken {
		t.Fatalf("Load = %q ok=%v err=%v", token, ok, err)
	}
	// Nothing may ever appear in the real profile root.
	if _, err := os.Stat(filepath.Join(os.Getenv("LOCALAPPDATA"), "GoRakuDo", "EizouDendenshi", "credential.bin")); !os.IsNotExist(err) {
		t.Fatalf("real profile credential file unexpectedly present (err=%v)", err)
	}
}
