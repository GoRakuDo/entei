package credential

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestValidToken(t *testing.T) {
	for _, tc := range []struct {
		token string
		want  bool
	}{
		{testToken, true},
		{"", false},
		{"abc", false},
		{strings.ToUpper(testToken), false}, // lowercase hex only
		{testToken + "0", false},            // 65 chars
		{"g123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", false}, // non-hex
		{strings.Repeat("00", 32), true},
	} {
		if got := ValidToken(tc.token); got != tc.want {
			t.Errorf("ValidToken(%q) = %v, want %v", tc.token, got, tc.want)
		}
	}
}

func TestEnvelopeRoundTrip(t *testing.T) {
	b, err := MarshalEnvelope(testToken)
	if err != nil {
		t.Fatalf("MarshalEnvelope: %v", err)
	}
	env, err := UnmarshalEnvelope(b)
	if err != nil {
		t.Fatalf("UnmarshalEnvelope: %v", err)
	}
	if env.Version != CurrentVersion {
		t.Errorf("Version = %d, want %d", env.Version, CurrentVersion)
	}
	if env.Token != testToken {
		t.Errorf("Token = %q, want %q", env.Token, testToken)
	}
}

func TestEnvelopeFailsClosed(t *testing.T) {
	valid := `{"version":1,"token":"` + testToken + `"}`
	for _, tc := range []struct {
		name string
		in   []byte
	}{
		{"empty", nil},
		{"garbage", []byte("not json at all")},
		{"truncated json", []byte(`{"version":1,"tok`)},
		{"wrong version", []byte(`{"version":2,"token":"` + testToken + `"}`)},
		{"missing version", []byte(`{"token":"` + testToken + `"}`)},
		{"invalid token shape", []byte(`{"version":1,"token":"short"}`)},
		{"uppercase token", []byte(`{"version":1,"token":"` + strings.ToUpper(testToken) + `"}`)},
		{"empty token", []byte(`{"version":1,"token":""}`)},
		{"oversized", []byte(`{"version":1,"token":"` + testToken + `","pad":"` + strings.Repeat("x", 5000) + `"}`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := UnmarshalEnvelope(tc.in); err == nil {
				t.Fatalf("expected fail-closed error for %q", tc.name)
			}
		})
	}
	// A valid envelope with trailing garbage must also fail (single object).
	if _, err := UnmarshalEnvelope([]byte(valid + `{"extra":1}`)); err == nil {
		t.Fatal("expected error for trailing JSON")
	}
}

func TestFileStoreLifecycle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credential.bin")
	s := NewFileStore(path)

	// Never stored: ok=false, no error.
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

	// Saved bytes are the JSON envelope. Mode 0600 is asserted on
	// platforms that honor unix mode bits; on Windows the file's privacy
	// comes from the user-private directory ACL (LOCALAPPDATA) and DPAPI,
	// and os.Chmod only carries the read-only flag.
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatalf("Stat: %v", err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("credential file mode = %o, want 0600", fi.Mode().Perm())
		}
	}

	// Delete removes the file; subsequent Load reports never-stored.
	if err := s.Delete(); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, _, ok, err := s.Load(); err != nil || ok {
		t.Fatalf("Load after Delete = ok=%v err=%v", ok, err)
	}
	// Deleting an absent credential is not an error.
	if err := s.Delete(); err != nil {
		t.Fatalf("second Delete: %v", err)
	}
}

func TestFileStoreFailsClosed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credential.bin")
	s := NewFileStore(path)

	t.Run("corrupt content rejected", func(t *testing.T) {
		if err := os.WriteFile(path, []byte("garbage"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := s.Load(); err == nil {
			t.Fatal("expected error for corrupt content")
		}
		if token, _, ok, err := s.Load(); err == nil && ok {
			t.Fatalf("corrupt content must not yield a credential, got %q", token)
		}
	})

	t.Run("invalid token shape rejected", func(t *testing.T) {
		if err := os.WriteFile(path, []byte(`{"version":1,"token":"nope"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := s.Load(); err == nil {
			t.Fatal("expected error for invalid stored token")
		}
	})

	t.Run("symlink rejected on load", func(t *testing.T) {
		link := filepath.Join(dir, "link.bin")
		target := filepath.Join(dir, "target.bin")
		if err := os.WriteFile(target, []byte(`{"version":1,"token":"`+testToken+`"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, link); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		ls := NewFileStore(link)
		if _, _, _, err := ls.Load(); err == nil {
			t.Fatal("expected symlink rejection on Load")
		}
		if err := ls.Save(testToken); err == nil {
			t.Fatal("expected symlink rejection on Save")
		}
	})

	t.Run("oversized file rejected", func(t *testing.T) {
		if err := os.WriteFile(path, []byte(strings.Repeat("x", MaxEnvelopeBytes+1)), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := s.Load(); err == nil {
			t.Fatal("expected error for oversized file")
		}
	})

	t.Run("invalid save token rejected", func(t *testing.T) {
		if err := s.Save("bad"); err == nil {
			t.Fatal("expected error saving an invalid token")
		}
	})
}

func TestMemStore(t *testing.T) {
	m := NewMemStore()
	if _, _, ok, err := m.Load(); err != nil || ok {
		t.Fatalf("initial Load = ok=%v err=%v", ok, err)
	}
	if err := m.Save(testToken); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if token, _, ok, err := m.Load(); err != nil || !ok || token != testToken {
		t.Fatalf("Load = %q ok=%v err=%v", token, ok, err)
	}
	if err := m.Delete(); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, _, ok, err := m.Load(); err != nil || ok {
		t.Fatalf("Load after Delete = ok=%v err=%v", ok, err)
	}

	t.Run("save failure injectable", func(t *testing.T) {
		m := NewMemStore()
		m.SetSaveError(errors.New("disk full"))
		if err := m.Save(testToken); err == nil {
			t.Fatal("expected injected save error")
		}
		if _, _, ok, _ := m.Load(); ok {
			t.Fatal("failed save must not store anything")
		}
	})

	t.Run("load failure injectable", func(t *testing.T) {
		m := NewMemStore()
		m.SetLoadError(errors.New("corrupt"))
		if _, _, _, err := m.Load(); err == nil {
			t.Fatal("expected injected load error")
		}
	})

	t.Run("delete failure injectable", func(t *testing.T) {
		m := NewMemStore()
		m.SeedToken(testToken)
		m.SetDeleteError(errors.New("locked"))
		if err := m.Delete(); err == nil {
			t.Fatal("expected injected delete error")
		}
		if got := m.StoredToken(); got != testToken {
			t.Fatalf("StoredToken = %q, want %q (failed delete keeps it)", got, testToken)
		}
	})
}
