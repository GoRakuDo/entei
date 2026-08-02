//go:build windows

package credential

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// windowsStore encrypts the envelope with DPAPI (CryptProtectData,
// user-scoped: only the current Windows user can decrypt) and stores the
// ciphertext atomically in a user-private app path. Profile mismatch,
// decryption failure, or corrupt content fail closed — Load returns an
// error and no credential, and the caller must generate fresh ones.
type windowsStore struct {
	path string
}

// NewWindowsStore returns the DPAPI-backed store at path (used by
// NewDefaultStore; tests pass a temp dir path).
func NewWindowsStore(path string) Store {
	return &windowsStore{path: path}
}

// DefaultCredentialPath resolves the user-private app path for the
// pairing credential: %LOCALAPPDATA%\GoRakuDo\EizouDendenshi\credential.bin
// — the same user-private root the Windows bootstrap installs into. The
// EIZOUDEN_CREDENTIAL_DIR override (harness/tests only) redirects the
// directory so automated runs never write into the real profile.
func DefaultCredentialPath() string {
	if dir := os.Getenv("EIZOUDEN_CREDENTIAL_DIR"); dir != "" {
		return filepath.Join(dir, "credential.bin")
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base, _ = os.UserConfigDir()
	}
	return filepath.Join(base, "GoRakuDo", "EizouDendenshi", "credential.bin")
}

// NewDefaultStore returns the user-scoped DPAPI store at the user-private
// app path (EIZOUDEN_CREDENTIAL_DIR override honored for harness/tests).
func NewDefaultStore() (Store, error) {
	return NewWindowsStore(DefaultCredentialPath()), nil
}

func (s *windowsStore) Load() (string, int, bool, error) {
	cipher, err := readFileBounded(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", 0, false, nil // never stored: not an error
		}
		return "", 0, false, errors.New("credential: stored credential unreadable")
	}
	plain, err := dpapiUnprotect(cipher)
	if err != nil {
		// Fail closed: profile mismatch, corrupt ciphertext, or a wrong
		// user's blob must never yield a credential.
		return "", 0, false, errors.New("credential: stored credential cannot be decrypted")
	}
	env, err := UnmarshalEnvelope(plain)
	if err != nil {
		return "", 0, false, err
	}
	return env.Token, env.Version, true, nil
}

func (s *windowsStore) Save(token string) error {
	plain, err := MarshalEnvelope(token)
	if err != nil {
		return err
	}
	cipher, err := dpapiProtect(plain)
	if err != nil {
		return errors.New("credential: credential encryption failed")
	}
	if fi, err := os.Lstat(s.path); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return errors.New("credential: refusing symlinked credential path")
	}
	if err := writeFileAtomic(s.path, cipher); err != nil {
		return errors.New("credential: credential write failed")
	}
	return nil
}

func (s *windowsStore) Delete() error {
	err := os.Remove(s.path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("credential: credential delete failed")
	}
	return nil
}

// dpapiProtect encrypts plaintext for the current Windows user. No UI,
// no entropy, no local-machine scope — only the same user (and profile)
// can decrypt the result.
func dpapiProtect(plain []byte) ([]byte, error) {
	in := windows.DataBlob{Size: uint32(len(plain))}
	if len(plain) > 0 {
		in.Data = &plain[0]
	}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil,
		windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	// Copy the ciphertext into a Go-owned buffer BEFORE LocalFree: the
	// output blob is allocated by DPAPI, and unsafe.Slice only aliases it.
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return bytes.Clone(unsafe.Slice(out.Data, out.Size)), nil
}

// dpapiUnprotect decrypts a DPAPI blob. Any failure (wrong profile,
// tampered ciphertext, unsupported blob) is an error — never a partial
// value.
func dpapiUnprotect(cipher []byte) ([]byte, error) {
	in := windows.DataBlob{Size: uint32(len(cipher))}
	if len(cipher) > 0 {
		in.Data = &cipher[0]
	}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, 0, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return bytes.Clone(unsafe.Slice(out.Data, out.Size)), nil
}
