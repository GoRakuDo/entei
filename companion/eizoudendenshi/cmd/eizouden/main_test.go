package main

import "testing"

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
