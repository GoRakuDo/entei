package pairing

import (
	"regexp"
	"strconv"
	"testing"
)

var codeShape = regexp.MustCompile(`^[0-9]{6}$`)

func TestGenerateCodeShape(t *testing.T) {
	for i := 0; i < 200; i++ {
		code, err := GenerateCode()
		if err != nil {
			t.Fatalf("GenerateCode error: %v", err)
		}
		if !codeShape.MatchString(code) {
			t.Fatalf("code %q does not match 6-digit shape", code)
		}
		// Range check: parseable and within [0, 999999].
		n, err := strconv.Atoi(code)
		if err != nil || n < 0 || n > 999_999 {
			t.Fatalf("code %q out of range (parsed=%d, err=%v)", code, n, err)
		}
	}
}

func TestGenerateCodeLeadingZeros(t *testing.T) {
	// Ensure zero-padding is used: a value below 100000 must still render as
	// exactly 6 characters. We cannot force a specific draw, but a small
	// sample over a wide space must never yield a short string.
	for i := 0; i < 50; i++ {
		code, err := GenerateCode()
		if err != nil {
			t.Fatalf("GenerateCode error: %v", err)
		}
		if len(code) != CodeDigits {
			t.Fatalf("code %q has length %d, want %d", code, len(code), CodeDigits)
		}
	}
}

func TestGenerateCodeDistinct(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 50; i++ {
		code, err := GenerateCode()
		if err != nil {
			t.Fatalf("GenerateCode error: %v", err)
		}
		seen[code] = true
	}
	// Over a 10^6 space, 50 draws colliding entirely is effectively
	// impossible; requiring at least 2 distinct values proves non-constant
	// output without flaky birthday-bound collisions.
	if len(seen) < 2 {
		t.Fatalf("expected distinct codes, got only %d", len(seen))
	}
}

func TestGenerateTokenShape(t *testing.T) {
	token, err := GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken error: %v", err)
	}
	if len(token) != 64 {
		t.Fatalf("token length = %d, want 64 (32 bytes hex-encoded)", len(token))
	}
	for _, c := range token {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			t.Fatalf("token contains non-hex char %q", c)
		}
	}
}

func TestGenerateTokenDistinct(t *testing.T) {
	a, err := GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken error: %v", err)
	}
	b, err := GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken error: %v", err)
	}
	if a == b {
		t.Fatal("two generated tokens are identical")
	}
}

func TestCodeAndTokenDiffer(t *testing.T) {
	code, err := GenerateCode()
	if err != nil {
		t.Fatalf("GenerateCode error: %v", err)
	}
	token, err := GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken error: %v", err)
	}
	if code == token {
		t.Fatal("code and token collided")
	}
}
