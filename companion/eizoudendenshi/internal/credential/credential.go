// Package credential persists the EizouDendenshi pairing credential.
//
// The persisted form is a schema-versioned envelope containing ONLY the
// opaque capability token and the envelope version — never the pairing
// code, a source URL, magnet, media, or cookies. Storage is platform
// specific:
//
//   - Windows: DPAPI-encrypted bytes (golang.org/x/sys/windows
//     CryptProtectData / CryptUnprotectData), user-scoped (LOCALAPPDATA,
//     i.e. the same user-private GoRakuDo\EizouDendenshi root the Windows
//     bootstrap installs into), written atomically.
//   - Android / Termux: plain envelope file in Termux app-private storage
//     ($PREFIX/var/lib/eizouden), mode 0600, atomic write, symlinks and
//     path tricks rejected. DPAPI is never used on Android.
//   - Other platforms: a documented development fallback (user config
//     dir, mode 0600, atomic write).
//
// Every failure mode is fail-closed: a corrupt file, a decryption /
// profile-mismatch failure, an invalid envelope, or an invalid token
// shape yields NO credential (the caller must generate fresh ones and
// must never accept the stored value). Errors are generic and carry no
// content detail.
package credential

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// CurrentVersion is the schema version of the persisted envelope. It is
// the only version the current build accepts; anything else fails closed.
const CurrentVersion = 1

// MaxEnvelopeBytes bounds the persisted file size so a hostile or corrupt
// file cannot force unbounded memory use.
const MaxEnvelopeBytes = 4096

// Envelope is the schema-versioned persisted credential. Only the opaque
// token and the envelope version are stored.
type Envelope struct {
	Version int    `json:"version"`
	Token   string `json:"token"`
}

// tokenShape is the capability-token contract shared with internal/api:
// 32 random bytes encoded as 64 lowercase hex characters.
var tokenShape = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidToken reports whether t matches the opaque capability-token shape.
func ValidToken(t string) bool {
	return tokenShape.MatchString(t)
}

// Store is the narrow persistent-credential abstraction used by the API.
// Implementations must be safe for concurrent use (the API serializes all
// calls under its own mutex anyway) and must fail closed: Load returns an
// error — never a partial or unvalidated value — when the stored content
// is missing-detail corrupt, undecryptable, or profile-mismatched.
type Store interface {
	// Load returns the stored token and envelope version. ok is false
	// when no credential has ever been stored (not an error). Any other
	// unreadable / corrupt / unverifiable state is an error with no
	// token (fail closed).
	Load() (token string, version int, ok bool, err error)
	// Save stores the token atomically (version CurrentVersion). It must
	// succeed before a pair response returns 200; an error means the pair
	// request fails without a token response.
	Save(token string) error
	// Delete removes the persisted credential (best effort, atomic
	// semantics). Removing an absent credential is not an error.
	Delete() error
}

// MarshalEnvelope encodes the versioned envelope for the given token.
// The token shape is validated first (fail closed on anything else).
func MarshalEnvelope(token string) ([]byte, error) {
	if !ValidToken(token) {
		return nil, errors.New("credential: invalid token shape")
	}
	return json.Marshal(Envelope{Version: CurrentVersion, Token: token})
}

// UnmarshalEnvelope parses and validates a persisted envelope. Corrupt
// JSON, a wrong version, or an invalid token shape all fail closed.
func UnmarshalEnvelope(b []byte) (Envelope, error) {
	if len(b) == 0 || len(b) > MaxEnvelopeBytes {
		return Envelope{}, errors.New("credential: invalid envelope size")
	}
	var env Envelope
	dec := json.NewDecoder(bytes.NewReader(b))
	if err := dec.Decode(&env); err != nil {
		return Envelope{}, errors.New("credential: corrupt envelope")
	}
	if dec.More() {
		return Envelope{}, errors.New("credential: trailing data in envelope")
	}
	if env.Version != CurrentVersion {
		return Envelope{}, fmt.Errorf("credential: unsupported version %d", env.Version)
	}
	if !ValidToken(env.Token) {
		return Envelope{}, errors.New("credential: invalid stored token")
	}
	return env, nil
}

// writeFileAtomic writes b to path atomically and privately: the payload
// lands in a temp file (same directory, so the rename cannot cross
// filesystems) with mode 0600 and is renamed over the target. On
// platforms where symlinks matter the caller additionally rejects
// symlinked targets before calling.
func writeFileAtomic(path string, b []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".credential-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return err
	}
	return nil
}

// readFileBounded reads path with a hard size cap (fail closed on
// anything larger or on a symlinked target).
func readFileBounded(path string) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("credential: refusing symlinked credential file")
	}
	if fi.Size() > MaxEnvelopeBytes {
		return nil, errors.New("credential: credential file too large")
	}
	return os.ReadFile(path)
}
