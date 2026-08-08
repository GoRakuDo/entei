package main

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestReadNameservers exercises the resolv.conf-style parser on a real
// temporary file so the test is platform-independent (the parser lives in
// the build-tag-free dns_common.go and is used by the Android resolver).
func TestReadNameservers(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "resolv.conf")

	content := strings.Join([]string{
		"# comment line",
		"; also a comment",
		"",
		"   ",
		"nameserver 192.168.100.1",
		"nameserver 1.1.1.1",
		"nameserver fd00::1",
		"  nameserver 8.8.8.8  # trailing comment is ignored by Fields",
		"search lan.example",
		"options timeout:2",
		"malformed nameserver",
		"nameserver",
	}, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	got := readNameservers(path)
	if len(got) != 4 {
		t.Fatalf("readNameservers = %d entries, want 4 (%v)", len(got), got)
	}
	wantAddr := []string{
		"192.168.100.1:53",
		"1.1.1.1:53",
		"[fd00::1]:53",
		"8.8.8.8:53",
	}
	for i, want := range wantAddr {
		if got[i].addr != want {
			t.Errorf("nameserver[%d].addr = %q, want %q", i, got[i].addr, want)
		}
		// Every parsed nameserver must be a real net address (JoinHostPort
		// shape) — the dialer depends on it.
		if _, _, err := net.SplitHostPort(got[i].addr); err != nil {
			t.Errorf("nameserver[%d].addr %q is not a dialable host:port: %v", i, got[i].addr, err)
		}
	}
}

// TestReadNameserversMissingFile pins the fail-safe: a missing/unreadable
// file yields nil (the caller falls back to 1.1.1.1).
func TestReadNameserversMissingFile(t *testing.T) {
	if got := readNameservers(filepath.Join(t.TempDir(), "nope")); got != nil {
		t.Fatalf("missing file: readNameservers = %v, want nil", got)
	}
}

// TestReadNameserversEmptyFile pins the empty-file case (no nameservers).
func TestReadNameserversEmptyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.conf")
	if err := os.WriteFile(path, []byte("# only comments\n; nothing\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := readNameservers(path); len(got) != 0 {
		t.Fatalf("empty file: readNameservers = %v, want 0 entries", got)
	}
}

// TestReadNameserversIPv6NoBrackets pins IPv6 without pre-bracketing:
// JoinHostPort adds them, so the parse result stays dialable.
func TestReadNameserversIPv6NoBrackets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v6resolv.conf")
	// Raw IPv6 with no brackets is the standard resolv.conf form.
	if err := os.WriteFile(path, []byte("nameserver 2001:4860:4860::8888\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := readNameservers(path)
	if len(got) != 1 || !strings.Contains(got[0].addr, "[2001:4860:4860::8888]") {
		t.Fatalf("ipv6 parse: got %v, want [2001:4860:4860::8888]:53", got)
	}
}
