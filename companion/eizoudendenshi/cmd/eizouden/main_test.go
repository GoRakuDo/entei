package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"eizoudendenshi/internal/api"
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
