package credential

import (
	"errors"
	"os"
)

// fileStore persists the plaintext envelope at a fixed private path with
// strict mode 0600 and atomic writes. It is used on Android / Termux
// (app-private storage) and as the documented development fallback on
// other non-Windows platforms. Symlinked targets, path tricks, oversized
// files, and corrupt envelopes all fail closed.
type fileStore struct {
	path string
}

// NewFileStore returns a Store backed by the file at path. Callers choose
// the location (Termux app-private storage, user config dir, a test temp
// dir); the store itself never invents one.
func NewFileStore(path string) Store {
	return &fileStore{path: path}
}

func (f *fileStore) Load() (string, int, bool, error) {
	b, err := readFileBounded(f.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", 0, false, nil // never stored: not an error
		}
		return "", 0, false, errors.New("credential: stored credential unreadable")
	}
	env, err := UnmarshalEnvelope(b)
	if err != nil {
		return "", 0, false, err
	}
	return env.Token, env.Version, true, nil
}

func (f *fileStore) Save(token string) error {
	b, err := MarshalEnvelope(token)
	if err != nil {
		return err
	}
	// Symlink rejection must happen before the atomic rename so an
	// attacker-controlled symlink can never redirect the credential.
	if fi, err := os.Lstat(f.path); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return errors.New("credential: refusing symlinked credential path")
	}
	if err := writeFileAtomic(f.path, b); err != nil {
		return errors.New("credential: credential write failed")
	}
	return nil
}

func (f *fileStore) Delete() error {
	err := os.Remove(f.path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("credential: credential delete failed")
	}
	return nil
}
