package main

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"eizoudendenshi/internal/anki"
	"eizoudendenshi/internal/api"
	"eizoudendenshi/internal/credential"
	"eizoudendenshi/internal/media"
)

func TestDefaultAddrIsPlayerContractPort(t *testing.T) {
	if defaultAddr != "127.0.0.1:4322" {
		t.Fatalf("defaultAddr = %q, want the Entei Player pairing contract 127.0.0.1:4322", defaultAddr)
	}
}

func TestResolveBindAddress(t *testing.T) {
	tests := []struct {
		name    string
		addr    string
		wantErr bool
	}{
		{"loopback ipv4 ephemeral", "127.0.0.1:0", false},
		{"loopback ipv4 fixed", "127.0.0.1:4321", false},
		{"loopback range ipv4", "127.0.0.2:9000", false},
		{"loopback range ipv4 upper", "127.255.255.254:80", false},
		{"loopback ipv6", "[::1]:0", false},
		{"empty addr", "", true},
		{"empty host binds all interfaces", ":4321", true},
		{"wildcard ipv4", "0.0.0.0:4321", true},
		{"unspecified ipv6", "[::]:8080", true},
		{"private lan ip", "192.168.1.5:4321", true},
		{"public ip", "8.8.8.8:4321", true},
		{"non-loopback hostname", "example.com:4321", true},
		{"localhost hostname rejected", "localhost:4321", true},
		{"localhost mixed case rejected", "LOCALHOST:4321", true},
		{"missing port", "127.0.0.1", true},
		{"missing port localhost", "localhost", true},
		{"non-numeric port", "127.0.0.1:http", true},
		{"port out of range", "127.0.0.1:65536", true},
		{"negative port", "127.0.0.1:-1", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveBindAddress(tt.addr)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("resolveBindAddress(%q) = %q, want error", tt.addr, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveBindAddress(%q) error: %v", tt.addr, err)
			}
			if got != tt.addr {
				t.Errorf("resolveBindAddress(%q) = %q, want input preserved", tt.addr, got)
			}
		})
	}
}

// TestParseAllowOrigins covers the ED-2C --allow-origin contract: nonempty
// values must parse as exact HTTP(S) origins (and are normalized), empty
// values are ignored, and any malformed value makes the whole flag set
// invalid. main calls parseAllowOrigins before net.Listen, so a malformed
// value is rejected before the server starts listening.
func TestParseAllowOrigins(t *testing.T) {
	tests := []struct {
		name    string
		in      []string
		want    []string
		wantErr bool
	}{
		{
			name: "empty list",
			in:   nil,
			want: nil,
		},
		{
			name: "empty values ignored",
			in:   []string{"", ""},
			want: nil,
		},
		{
			name:    "whitespace-only value rejected as malformed",
			in:      []string{"   "},
			wantErr: true,
		},
		{
			name: "single valid origin normalized",
			in:   []string{"HTTP://EXAMPLE.COM:80"},
			want: []string{"http://example.com"},
		},
		{
			name: "single valid origin with port",
			in:   []string{"http://192.0.2.10:4321"},
			want: []string{"http://192.0.2.10:4321"},
		},
		{
			name: "multiple origins preserved in order",
			in:   []string{"https://a.example", "http://b.example:8080"},
			want: []string{"https://a.example", "http://b.example:8080"},
		},
		{
			name: "duplicate values deduplicated by New, kept here",
			in:   []string{"http://a.example", "http://a.example"},
			want: []string{"http://a.example", "http://a.example"},
		},
		{
			name:    "malformed origin rejected",
			in:      []string{"http://example.com/path"},
			wantErr: true,
		},
		{
			name:    "malformed origin among valid rejected",
			in:      []string{"http://a.example", "ftp://b.example"},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseAllowOrigins(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseAllowOrigins(%v) = %v, want error", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseAllowOrigins(%v) error: %v", tt.in, err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseAllowOrigins(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

// TestBannerCarriesVersion pins the startup-line contract: the banner must
// carry the same api.Version that /v1/health reports, so a release build's
// startup line cannot diverge from the manifest version injected at link
// time (asserted end-to-end by scripts/test-release.ps1).
func TestBannerCarriesVersion(t *testing.T) {
	const addr = "127.0.0.1:4322"
	got := banner(addr)
	for _, want := range []string{
		"EizouDendenshi ED-2B (" + api.Version + ")",
		"listening on http://" + addr,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("banner = %q, missing %q", got, want)
		}
	}
}

// TestResolveGrowSource covers the ED-2C --grow-fixture/--grow-total pair:
// neither flag → nil source; a partial pair → error; a valid pair builds a
// file-backed growing source with the declared total, failing fast on a
// missing file, a directory, or a size beyond the declared total. main
// calls resolveGrowSource before net.Listen, so a malformed configuration
// is rejected before the server starts.
func TestResolveGrowSource(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "grow.mp4")
	payload := make([]byte, 100)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("neither flag", func(t *testing.T) {
		src, err := resolveGrowSource("", 0)
		if err != nil || src != nil {
			t.Fatalf("resolveGrowSource(\"\", 0) = %v, %v; want nil, nil", src, err)
		}
	})

	t.Run("total without fixture rejected", func(t *testing.T) {
		if _, err := resolveGrowSource("", 100); err == nil {
			t.Fatal("want error for --grow-total without --grow-fixture")
		}
	})

	t.Run("fixture without total rejected", func(t *testing.T) {
		if _, err := resolveGrowSource(path, 0); err == nil {
			t.Fatal("want error for --grow-fixture without --grow-total")
		}
	})

	t.Run("missing file rejected", func(t *testing.T) {
		if _, err := resolveGrowSource(filepath.Join(dir, "nope.mp4"), 100); err == nil {
			t.Fatal("want error for missing file")
		}
	})

	t.Run("size beyond total rejected", func(t *testing.T) {
		if _, err := resolveGrowSource(path, 50); err == nil {
			t.Fatal("want error when current size exceeds declared total")
		}
	})

	t.Run("valid pair builds growing source", func(t *testing.T) {
		src, err := resolveGrowSource(path, 300)
		if err != nil {
			t.Fatalf("resolveGrowSource: %v", err)
		}
		if src == nil {
			t.Fatal("want non-nil growing source")
		}
		if got := src.Total(); got != 300 {
			t.Errorf("Total = %d, want 300", got)
		}
		if got := src.Available(); got != 100 {
			t.Errorf("Available = %d, want 100", got)
		}
		src.(*media.FileSource).Close()
	})
}

func TestMediaStatusLine(t *testing.T) {
	grow := media.NewMemSource(make([]byte, 10), 4)
	tests := []struct {
		name    string
		fixture string
		grow    media.GrowingSource
		want    string
	}{
		{"disabled", "", nil, "Media fixture: disabled (--fixture not set)"},
		{"static", `C:\tmp\fixture.mp4`, nil, "Media fixture: enabled (fixture.mp4)"},
		{"growing", "", grow, "Media fixture: growing (total 10 bytes, available 4)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := mediaStatusLine(tt.fixture, tt.grow); got != tt.want {
				t.Errorf("mediaStatusLine = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestAnkiStatusLine pins the terminal-handoff shape for the AnkiDroid
// bridge: disabled / proxy-only / enabled-with-media-dir. The line
// must never echo a capability token or a pairing code (the only
// sensitive strings the command has access to); a non-empty writer
// path is OK because the spec marks the directory as non-sensitive.
func TestAnkiStatusLine(t *testing.T) {
	tests := []struct {
		name   string
		bridge *api.AnkiBridge
		want   string
	}{
		{
			"disabled",
			nil,
			"Anki bridge: disabled (--anki-proxy not set)",
		},
		{
			"proxy-only (writer failed)",
			&api.AnkiBridge{Writer: nil, ProxyConfigured: true},
			"Anki bridge: enabled (proxy-only; media dir not writable on this host)",
		},
		{
			"enabled with media dir",
			&api.AnkiBridge{Writer: anki.NewMediaWriterForTest("/storage/emulated/0/AnkiDroid/collection.media"), ProxyConfigured: true},
			"Anki bridge: enabled (proxy + media dir: /storage/emulated/0/AnkiDroid/collection.media)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ankiStatusLine(tt.bridge); got != tt.want {
				t.Errorf("ankiStatusLine = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestResolveAnkiBridge pins the wiring function: empty proxy → nil
// (bridge disabled), non-empty → non-nil bridge with Proxy always
// configured and Writer possibly nil when the platform probe fails.
// The non-sensitive URL is preserved verbatim in the returned bridge
// for the status endpoint to echo (never the URL-with-token —
// AnkiconnectAndroid takes no token, per spec §9).
func TestResolveAnkiBridge(t *testing.T) {
	if got := resolveAnkiBridge("", "", nil); got != nil {
		t.Errorf("empty proxy: bridge = %+v, want nil", got)
	}
	b := resolveAnkiBridge("http://127.0.0.1:8080", "", nil)
	if b == nil {
		t.Fatal("non-empty proxy: bridge = nil, want non-nil")
	}
	if b.Proxy == nil {
		t.Error("non-empty proxy: Proxy = nil")
	}
	if !b.ProxyConfigured {
		t.Error("non-empty proxy: ProxyConfigured = false")
	}
	// Writer may be nil on non-Android/non-Linux hosts; on this test
	// host it depends on the probe. We don't pin it either way — the
	// test's contract is "non-nil bridge with a configured proxy".
}

func TestStartServerCoreSuccess(t *testing.T) {
	cred, err := credential.NewDefaultStore()
	if err != nil {
		t.Skipf("credential store unavailable: %v", err)
	}
	cfg := serverConfig{
		bind: "127.0.0.1:0",
		cred: cred,
	}
	srv, ln, err := startServerCore(cfg)
	if err != nil {
		t.Fatalf("startServerCore: %v", err)
	}
	if srv == nil {
		t.Fatal("startServerCore returned nil server")
	}
	if ln == nil {
		t.Fatal("startServerCore returned nil listener")
	}
	ln.Close()
}

func TestStartServerCorePortInUse(t *testing.T) {
	cred, err := credential.NewDefaultStore()
	if err != nil {
		t.Skipf("credential store unavailable: %v", err)
	}
	// Bind a port first to occupy it.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	cfg := serverConfig{
		bind: ln.Addr().String(),
		cred: cred,
	}
	_, _, err = startServerCore(cfg)
	if err == nil {
		t.Fatal("startServerCore must fail when port is in use")
	}
	if !strings.Contains(err.Error(), "already in use") {
		t.Errorf("expected 'already in use' error, got: %v", err)
	}
}

func TestStartServerAutoReturnsPairingCode(t *testing.T) {
	cred, err := credential.NewDefaultStore()
	if err != nil {
		t.Skipf("credential store unavailable: %v", err)
	}
	cfg := serverConfig{
		bind: "127.0.0.1:0",
		cred: cred,
	}
	code, errCh, err := startServerAuto(cfg)
	if err != nil {
		t.Fatalf("startServerAuto: %v", err)
	}
	if code == "" {
		t.Fatal("startServerAuto returned empty pairing code")
	}
	if errCh == nil {
		t.Fatal("startServerAuto returned nil error channel")
	}
}

func TestStartServerAutoPortInUse(t *testing.T) {
	cred, err := credential.NewDefaultStore()
	if err != nil {
		t.Skipf("credential store unavailable: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	cfg := serverConfig{
		bind: ln.Addr().String(),
		cred: cred,
	}
	_, _, err = startServerAuto(cfg)
	if err == nil {
		t.Fatal("startServerAuto must fail when port is in use")
	}
}

// TestResolveYtdlp pins the yt-dlp helper resolution: an explicit --ytdlp
// always wins; an empty flag falls back to a PATH lookup; a failed lookup
// leaves the helper disabled (source-job endpoints stay off, as before).
func TestResolveYtdlp(t *testing.T) {
	cases := []struct {
		name     string
		explicit string
		found    string
		lookErr  error
		want     string
	}{
		{"explicit wins", "/opt/bin/yt-dlp", "/usr/bin/yt-dlp", nil, "/opt/bin/yt-dlp"},
		{"path fallback found", "", "/data/data/com.termux/files/usr/bin/yt-dlp", nil, "/data/data/com.termux/files/usr/bin/yt-dlp"},
		{"path fallback missing", "", "", errors.New("executable not found in PATH"), ""},
		{"both empty", "", "", nil, ""},
	}
	for _, c := range cases {
		got := resolveYtdlp(c.explicit, func(string) (string, error) { return c.found, c.lookErr })
		if got != c.want {
			t.Errorf("%s: resolveYtdlp = %q, want %q", c.name, got, c.want)
		}
	}
}
