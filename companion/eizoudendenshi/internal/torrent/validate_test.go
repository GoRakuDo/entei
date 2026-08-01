package torrent

import (
	"errors"
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
			// Extra tracker/dn params are dropped; only the canonical
			// infohash reaches the helper.
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=foo&tr=udp%3A%2F%2Fx",
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
		},
		{
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=https%3A%2F%2Ftracker.example%2Fannounce",
			"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
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
	// The accepted case drops tracker data entirely.
	canon, _ := ValidateMagnet(nasty)
	if canon != "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" {
		t.Errorf("canonical form must drop tracker params, got %q", canon)
	}
}
