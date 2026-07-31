// Package pairing generates ephemeral pairing credentials.
//
// Both credentials are produced exclusively from crypto/rand: a human-typed
// 6-digit pairing code and a 256-bit opaque capability token. They exist only
// in process memory — nothing is written to files, storage, or logs.
package pairing

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"math/big"
)

// CodeDigits is the number of decimal digits in a pairing code.
const CodeDigits = 6

// GenerateCode returns a zero-padded 6-digit pairing code (000000–999999),
// drawn uniformly from the full range via crypto/rand.Int (rejection
// sampling, no modulo bias).
func GenerateCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", fmt.Errorf("generate pairing code: %w", err)
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// GenerateToken returns an opaque capability token: 32 random bytes from
// crypto/rand, encoded as 64 lowercase hex characters.
func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", fmt.Errorf("generate capability token: %w", err)
	}
	return hex.EncodeToString(b), nil
}
