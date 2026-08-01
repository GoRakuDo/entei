package torrent

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateMagnetAccepted(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
		},
		{
			// Uppercase hex canonicalizes to lowercase.
			"magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567",
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
		},
		{
			// Base32 infohash (32 chars) canonicalizes to 40 hex.
			"magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
			"magnet:?xt=urn:btih:00443214c74254b635cf84653a56d7c675be77df",
		},
		{
			// dn is dropped; a SAFE tracker is preserved canonically.
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=foo&tr=udp%3A%2F%2Fx",
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp%3A%2F%2Fx",
		},
		{
			// Safe https tracker preserved.
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=https%3A%2F%2Ftracker.example%2Fannounce",
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=https%3A%2F%2Ftracker.example%2Fannounce",
		},
	}
	for _, tc := range cases {
		got, err := ValidateMagnet(tc.in)
		if err != nil {
			t.Errorf("ValidateMagnet(%q) unexpected error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("ValidateMagnet(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestValidateMagnetRejected(t *testing.T) {
	cases := []string{
		"",
		"not a magnet",
		"http://example.com/x",
		"https://www.youtube.com/watch?v=abcdefghijk",
		"magnet:?xt=urn:btmh:1220abcdef",                                // not btih
		"magnet:?xt=urn:btih:",                                          // empty infohash
		"magnet:?xt=urn:btih:short",                                     // wrong length
		"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef012345678", // 41 chars
		"magnet:?xt=urn:btih:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",  // non-hex 40
		"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&xt=urn:btih:0123456789abcdef0123456789abcdef01234567", // two xt
		"magnet:?xt=urn:sha1:0123456789abcdef0123456789abcdef01234567",                                                      // wrong urn
		"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567/..",                                                   // path trick
		"file:///C:/Windows/win.ini", // arbitrary file path
		"magnet://evil/../",          // not a query form
		"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567;rm+-rf", // shell-ish
		"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567%00",     // null byte
	}
	for _, tc := range cases {
		if got, err := ValidateMagnet(tc); err == nil {
			t.Errorf("ValidateMagnet(%q) = %q, want rejection", tc, got)
		}
	}
}

// TestValidateMagnetErrorsNeverEcho pins the generic-error contract.
func TestValidateMagnetErrorsNeverEcho(t *testing.T) {
	nasty := "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp://tracker.example:1337"
	if _, err := ValidateMagnet("magnet:?xt=urn:btih:zz"); err == nil {
		t.Fatal("expected rejection")
	} else if err != ErrInvalidMagnet && !errors.Is(err, ErrInvalidMagnet) {
		t.Errorf("error must be the generic ErrInvalidMagnet, got %q", err.Error())
	}
	// The safe tracker is preserved in the canonical form (never echoed in
	// ERRORS — the error contract only covers rejection paths).
	canon, _ := ValidateMagnet(nasty)
	want := "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp%3A%2F%2Ftracker.example%3A1337"
	if canon != want {
		t.Errorf("canonical form must preserve the safe tracker, got %q want %q", canon, want)
	}
	// An UNSAFE tracker rejects the whole magnet with the generic error.
	if _, err := ValidateMagnet("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp%3A%2F%2F127.0.0.1%3A6969"); err == nil {
		t.Error("loopback tracker must reject the whole magnet")
	}
}

// TestValidateMagnetTrackerPolicy covers the tracker preservation contract.
func TestValidateMagnetTrackerPolicy(t *testing.T) {
	const ih = "0123456789abcdef0123456789abcdef01234567"
	base := "magnet:?xt=urn:btih:" + ih

	accepted := []struct {
		name string
		in   string
		want string
	}{
		{
			"udp tracker canonical host casing",
			base + "&tr=udp%3A%2F%2FTRACKER.Example%2Fannounce",
			base + "&tr=udp%3A%2F%2Ftracker.example%2Fannounce",
		},
		{
			"http tracker with query preserved",
			base + "&tr=http%3A%2F%2Ftr.example%2Fann%3Fpasskey%3Dabc123",
			base + "&tr=http%3A%2F%2Ftr.example%2Fann%3Fpasskey%3Dabc123",
		},
		{
			"dedup + deterministic order",
			base + "&tr=udp%3A%2F%2Fb.example%2Fann&tr=udp%3A%2F%2Fa.example%2Fann&tr=udp%3A%2F%2Fb.example%2Fann",
			base + "&tr=udp%3A%2F%2Fa.example%2Fann&tr=udp%3A%2F%2Fb.example%2Fann",
		},
		{
			"explicit port preserved, casing normalized",
			base + "&tr=udp%3A%2F%2Ftracker.example%3A1337",
			base + "&tr=udp%3A%2F%2Ftracker.example%3A1337",
		},
		{
			"no port allowed",
			base + "&tr=https%3A%2F%2Ftracker.example",
			base + "&tr=https%3A%2F%2Ftracker.example",
		},
		{
			"exactly maxTrackers accepted",
			base + "&tr=udp%3A%2F%2Ft1.example%2Fa&tr=udp%3A%2F%2Ft2.example%2Fa&tr=udp%3A%2F%2Ft3.example%2Fa&tr=udp%3A%2F%2Ft4.example%2Fa&tr=udp%3A%2F%2Ft5.example%2Fa",
			base + "&tr=udp%3A%2F%2Ft1.example%2Fa&tr=udp%3A%2F%2Ft2.example%2Fa&tr=udp%3A%2F%2Ft3.example%2Fa&tr=udp%3A%2F%2Ft4.example%2Fa&tr=udp%3A%2F%2Ft5.example%2Fa",
		},
	}
	for _, tc := range accepted {
		got, err := ValidateMagnet(tc.in)
		if err != nil {
			t.Errorf("%s: unexpected error: %v", tc.name, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}

	rejected := []struct {
		name string
		in   string
	}{
		{"unsafe scheme", base + "&tr=ftp%3A%2F%2Ftracker.example%2Fann"},
		{"wss scheme", base + "&tr=wss%3A%2F%2Ftracker.example%2Fann"},
		{"userinfo", base + "&tr=udp%3A%2F%2Fuser%3Apass%40tracker.example%3A1337"},
		{"fragment", base + "&tr=udp%3A%2F%2Ftracker.example%2Fann%23frag"},
		{"private IPv4 literal", base + "&tr=udp%3A%2F%2F192.168.1.1%3A6969"},
		{"public IPv4 literal", base + "&tr=udp%3A%2F%2F1.2.3.4%3A6969"},
		{"IPv6 literal", base + "&tr=udp%3A%2F%2F%5B2001%3Adb8%3A%3A1%5D%3A6969"},
		{"loopback hostname", base + "&tr=udp%3A%2F%2Flocalhost%3A6969"},
		{"loopback IP", base + "&tr=udp%3A%2F%2F127.0.0.1%3A6969"},
		{"link-local IP", base + "&tr=udp%3A%2F%2F169.254.1.1%3A6969"},
		{"unspecified IP", base + "&tr=udp%3A%2F%2F0.0.0.0%3A6969"},
		{"port 0", base + "&tr=udp%3A%2F%2Ftracker.example%3A0"},
		{"port 65536", base + "&tr=udp%3A%2F%2Ftracker.example%3A65536"},
		{"empty host", base + "&tr=udp%3A%2F%2F%3A6969"},
		{"backslash in path", base + "&tr=udp%3A%2F%2Ftracker.example%2Fann%5Cevil"},
		{"control char", base + "&tr=udp%3A%2F%2Ftracker.example%2Fann%01"},
		{"whitespace", base + "&tr=udp%3A%2F%2Ftracker%20.example%2Fann"},
		{"non-ASCII", base + "&tr=udp%3A%2F%2Ftracker.%E4%BA%9Cexample%2Fann"},
		{"more than maxTrackers", base + "&tr=udp%3A%2F%2Ft1.example%2Fa&tr=udp%3A%2F%2Ft2.example%2Fa&tr=udp%3A%2F%2Ft3.example%2Fa&tr=udp%3A%2F%2Ft4.example%2Fa&tr=udp%3A%2F%2Ft5.example%2Fa&tr=udp%3A%2F%2Ft6.example%2Fa"},
		{"tracker too long", base + "&tr=udp%3A%2F%2Ftracker.example%2F" + strings.Repeat("a", 520)},
	}
	for _, tc := range rejected {
		if got, err := ValidateMagnet(tc.in); err == nil {
			t.Errorf("%s: expected rejection, got canonical %q", tc.name, got)
		}
	}
}

// TestValidateMagnetTrackerlessCompatible pins that legacy trackerless
// magnets keep working byte-for-byte.
func TestValidateMagnetTrackerlessCompatible(t *testing.T) {
	in := "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
	got, err := ValidateMagnet(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != in {
		t.Errorf("trackerless magnet must be unchanged, got %q", got)
	}
}
