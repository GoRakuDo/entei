package main

import (
	"reflect"
	"testing"
)

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
