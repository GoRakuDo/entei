package youtube

import "testing"

func TestValidateURLAccepted(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://www.youtube.com/watch?v=abcdefghijk", "https://www.youtube.com/watch?v=abcdefghijk"},
		{"https://youtube.com/watch?v=abcdefghijk", "https://youtube.com/watch?v=abcdefghijk"},
		{"https://m.youtube.com/watch?v=abcdefghijk", "https://m.youtube.com/watch?v=abcdefghijk"},
		{"https://music.youtube.com/watch?v=abcdefghijk", "https://music.youtube.com/watch?v=abcdefghijk"},
		{"https://youtu.be/abcdefghijk", "https://youtu.be/abcdefghijk"},
		{"https://www.youtube.com/shorts/abcdefghijk", "https://www.youtube.com/shorts/abcdefghijk"},
		{"https://www.youtube.com/embed/abcdefghijk", "https://www.youtube.com/embed/abcdefghijk"},
		{"https://www.youtube.com/live/abcdefghijk", "https://www.youtube.com/live/abcdefghijk"},
		{"https://www.youtube.com/watch?v=ABC_DEF-012", "https://www.youtube.com/watch?v=ABC_DEF-012"}, // base64url charset
	}
	for _, tc := range cases {
		got, err := ValidateURL(tc.in)
		if err != nil {
			t.Errorf("ValidateURL(%q) unexpected error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("ValidateURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestValidateURLRejected(t *testing.T) {
	cases := []string{
		"", // empty
		"http://www.youtube.com/watch?v=abcdefghijk", // http, not https
		"https://www.youtube.com",                    // no video
		"https://www.youtube.com/",                   // no video
		"https://google.com/watch?v=abcdefghijk",
		"https://youtube.com.evil.example/watch?v=abcdefghijk",
		"https://evilyoutube.com/watch?v=abcdefghijk",
		"https://www.youtu.be/abcdefghijk", // youtu.be has no subdomains
		"https://youtu.be/abcdefghijk/extra",
		"https://youtu.be/abcdefghijk?t=30", // query on youtu.be
		"https://www.youtube.com/watch?v=short",
		"https://www.youtube.com/watch?v=abcdefghijkX",           // 12 chars
		"https://www.youtube.com/watch",                          // missing v
		"https://www.youtube.com/watch?v=abcdefghijk&list=PL123", // extra param
		"https://www.youtube.com/watch?v=abcdefghijk&t=30",
		"https://www.youtube.com/watch?v=abcdefghijk#t=30", // fragment
		"https://www.youtube.com/shorts/abcdefghijk?x=1",   // query on shorts
		"https://www.youtube.com/shorts",                   // missing id
		"https://www.youtube.com/shorts/a/b",               // extra segment
		"https://www.youtube.com/playlist?list=PL123",      // unsupported path
		"https://www.youtube.com/channel/UC123",
		"https://www.youtube.com/watch?v=abcdefghijk@evil",
		"https://user:pass@www.youtube.com/watch?v=abcdefghijk",
		"https://www.youtube.com:443/watch?v=abcdefghijk", // explicit port
		"https://www.youtube.com/watch?v=%2e%2e%2f%2e%2e", // encoded path trick (id charset rejects)
		"https://www.youtube.com/watch?v=abcdefghijk%00",
		"//www.youtube.com/watch?v=abcdefghijk",                        // protocol-relative
		"javascript:alert(1)",                                          // scheme
		"https://www.youtube.com/watch?v=abcdefghijk/../../etc/passwd", // extra path
		"https://www.youtube.com/watch?v=abcdefghijk;rm+rf",            // shell-ish chars are not the id charset
		"https://уоuтubе.com/watch?v=abcdefghijk",                      // non-ASCII lookalike
		"https://youtu.be/abcdefghijk?si=xyz",                          // share param rejected
	}
	for _, tc := range cases {
		if got, err := ValidateURL(tc); err == nil {
			t.Errorf("ValidateURL(%q) = %q, want rejection", tc, got)
		}
	}
}

// TestValidateURLRejectsErrorMessageEcho pins the contract that errors are
// generic and never contain the input.
func TestValidateURLRejectsErrorMessageEcho(t *testing.T) {
	nasty := "https://www.youtube.com/watch?v=abcdefghijk;ls"
	if _, err := ValidateURL(nasty); err == nil {
		t.Fatal("expected rejection")
	} else if err.Error() != ErrInvalidURL.Error() {
		t.Errorf("error must be the generic ErrInvalidURL, got %q", err.Error())
	}
}
