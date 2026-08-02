//go:build android

package credential

import (
	"errors"
	"os"
	"path/filepath"
)

// DefaultCredentialPath resolves the Termux app-private credential path:
// $PREFIX/var/lib/eizouden/credential.bin — the same app-private storage
// the Termux bootstrap installs the verified core into. PREFIX is always
// set inside Termux; without it the path cannot be resolved safely and
// the caller fails closed. The EIZOUDEN_CREDENTIAL_DIR override
// (harness/tests only) redirects the directory.
func DefaultCredentialPath() string {
	if dir := os.Getenv("EIZOUDEN_CREDENTIAL_DIR"); dir != "" {
		return filepath.Join(dir, "credential.bin")
	}
	return filepath.Join(os.Getenv("PREFIX"), "var", "lib", "eizouden", "credential.bin")
}

// NewDefaultStore returns the Termux app-private file store. If PREFIX is
// unset (not running inside Termux) the store cannot be placed in an
// app-private location, so construction fails closed instead of silently
// falling back to a world-visible path.
func NewDefaultStore() (Store, error) {
	path := DefaultCredentialPath()
	if os.Getenv("EIZOUDEN_CREDENTIAL_DIR") == "" && os.Getenv("PREFIX") == "" {
		return nil, errors.New("credential: Termux PREFIX is not set; cannot resolve app-private storage")
	}
	return NewFileStore(path), nil
}
