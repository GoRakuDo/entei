//go:build !windows && !android

package credential

import (
	"os"
	"path/filepath"
)

// DefaultCredentialPath resolves the development-fallback credential path
// in the user config directory. The companion's production targets are
// Windows and Android/Termux; this branch exists so plain `go run` builds
// on other platforms stay usable for local development without touching
// the repository or the working directory.
func DefaultCredentialPath() string {
	if dir := os.Getenv("EIZOUDEN_CREDENTIAL_DIR"); dir != "" {
		return filepath.Join(dir, "credential.bin")
	}
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "eizoudendenshi", "credential.bin")
}

// NewDefaultStore returns the development-fallback file store.
func NewDefaultStore() (Store, error) {
	return NewFileStore(DefaultCredentialPath()), nil
}
