package update

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// minisignExpectedVersion is the pinned verifier version the bootstraps
// use; the version check matches this exact substring in `minisign -v`
// output (the Windows bootstrap's Assert-MinisignVersion uses the same
// match).
const minisignExpectedVersion = "0.12"

// resolveVerifier locates the Minisign verifier and checks its version.
// Fail closed: no verifier, or a verifier that fails the version check,
// yields an error.
//
// Windows: <install root>\tools\minisign.exe (installed by the bootstrap
// after the pinned-ZIP verification) is used when present. An
// install-root verifier that fails the version check is NOT bypassed by
// a PATH fallback (fail closed). Only when the install-root verifier is
// absent is a PATH minisign accepted, and only after the same version
// check.
//
// Termux / other platforms: minisign from PATH with the version check.
func resolveVerifier(installRoot string) (string, error) {
	if runtime.GOOS == "windows" {
		installed := filepath.Join(installRoot, "tools", "minisign.exe")
		if fi, err := os.Stat(installed); err == nil && !fi.IsDir() {
			if verifierVersionOK(installed) {
				return installed, nil
			}
			return "", errors.New("update: verifier failed the version check")
		}
	}
	p, err := exec.LookPath("minisign")
	if err != nil {
		return "", errors.New("update: no verifier found")
	}
	if !verifierVersionOK(p) {
		return "", errors.New("update: verifier failed the version check")
	}
	return p, nil
}

// verifierVersionOK runs `minisign -v` and requires the 0.12 version
// banner. The output is captured and never printed.
func verifierVersionOK(exe string) bool {
	out, err := exec.Command(exe, "-v").CombinedOutput()
	if err != nil {
		return false
	}
	return bytes.Contains(out, []byte(minisignExpectedVersion))
}

// verifyMinisign verifies file against the pinned public key with the
// given verifier. The pinned key is written ONLY to a private temp file
// inside staging (mode 0600, standard Minisign key-file format); the
// verifier is invoked with argv only (no shell), and its output is
// captured but never printed.
func verifyMinisign(verifier, file, staging string) error {
	keyPath := filepath.Join(staging, ".pinned-pubkey")
	keyText := "untrusted comment: eizouden update public key\n" + PinnedPublicKey + "\n"
	if err := os.WriteFile(keyPath, []byte(keyText), 0o600); err != nil {
		return errors.New("update: verifier key write failed")
	}
	out, err := exec.Command(verifier, "-Vm", file, "-p", keyPath).CombinedOutput()
	if err != nil {
		return errors.New("update: signature verification failed")
	}
	_ = out // captured, never printed
	return nil
}
