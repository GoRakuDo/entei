// Package update implements the EizouDendenshi in-place updater (common
// CLI option 3, "Update EizouDendenshi").
//
// Flow:
//
//   - The release feed is queried over HTTPS from
//     https://api.github.com/repos/GoRakuDo/entei/releases?per_page=20
//     with a bounded timeout and at most 5 HTTPS-only redirects. The
//     newest published non-draft release whose tag starts with
//     "eizoudendenshi-v" is chosen (prereleases included — the latest
//     release is always a prerelease and /releases/latest excludes them).
//   - Every artifact is verified into a private staging dir BEFORE
//     anything is applied: the signed manifest first (Minisign with the
//     pinned public key + strict structure), then each platform artifact
//     (Minisign + manifest SHA-256). The manifest version must equal the
//     selected tag suffix. Missing/duplicate/unsafe asset names and any
//     non-HTTPS redirect target fail closed.
//   - The updater executable is spawned in an internal --apply-update
//     child mode carrying ONLY the staging path, the parent PID, and the
//     target paths. On Windows the child is launched from a copy of the
//     running executable under the OS temp dir (the running image cannot
//     be renamed there; POSIX semantics allow the running image on
//     Termux). The parent exits before replacement; the child waits
//     (bounded) for the parent, replaces the verified core/helpers with
//     backup+rollback (old core is kept on any failure), then relaunches
//     the new core in CLI mode (cli, with the explicit Windows helper
//     paths) and exits.
//
// Security boundaries:
//
//   - PinnedPublicKey is injected at link time by scripts/release.ps1
//     (-ldflags -X eizoudendenshi/internal/update.PinnedPublicKey=...).
//     Dev builds keep the placeholder and fail closed with an "updater
//     unavailable" status; an arbitrary key from a response or env is
//     never trusted.
//   - The Minisign verifier is the installed one
//     (<install root>\tools\minisign.exe on Windows, else a PATH
//     minisign) and only after a 0.12 version check; the pinned key is
//     written ONLY to a private temp file, the verifier is invoked with
//     argv only (no shell), and its output is captured but never printed.
//   - The pairing credential (credential.bin / the DPAPI store) is never
//     read, written, rotated, or replaced by any code path here: the
//     update touches only the staged files and the core/helper targets,
//     so Web pairing and the persisted credential survive the update.
//   - The updater prints only safe, non-sensitive status text; it never
//     prints release URLs, keys, local paths, tokens, magnets, or raw
//     errors.
package update

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// PinnedPublicKey is the Minisign public key pinned into release binaries
// at link time (scripts/release.ps1 -ldflags -X
// eizoudendenshi/internal/update.PinnedPublicKey=<RW...>). Dev builds
// keep the placeholder and the updater fails closed; it must stay a var
// (never a const) for -X injection.
var PinnedPublicKey = "REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY"

// maxParentWait bounds how long the --apply-update child waits for the
// parent to exit before giving up and keeping the old core. A var so
// tests can shrink the bound.
var maxParentWait = 30 * time.Second

// releaseAPI is the GitHub releases feed for the EizouDendenshi releases
// published in the GoRakuDo/entei repository. Prereleases are required,
// so /releases/latest (which excludes them) is never used.
const releaseAPI = "https://api.github.com/repos/GoRakuDo/entei/releases?per_page=20"

// releaseTagPrefix is the exact release-tag prefix this updater accepts.
const releaseTagPrefix = "eizoudendenshi-v"

// manifestAssetName is the signed manifest asset carried by every
// release.
const manifestAssetName = "eizouden-manifest.json"

// semverShape matches the semver contract of scripts/release.ps1.
var semverShape = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)

// Config carries the caller-provided context for Run.
type Config struct {
	// Version is the current core version (api.Version).
	Version string
	// InstallRoot is the directory containing the running core
	// (the launcher runs the core from the user-private install root on
	// Windows and from $PREFIX/var/lib/eizouden on Termux).
	InstallRoot string
	// Client is the HTTP client used for the release feed and
	// downloads. nil selects the hardened default (bounded timeout,
	// at most 5 redirects, HTTPS-only redirect targets).
	Client *http.Client
}

// Run performs the update flow for CLI option 3. It prints ONLY safe,
// non-sensitive status text to w (never URLs, keys, local paths, tokens,
// or raw errors). It returns true when the caller should exit so the
// spawned child can replace the running core, and false to stay in the
// menu (failure, nothing to do, or updater unavailable).
func Run(w io.Writer, cfg Config) bool {
	if !keyPinned() {
		fmt.Fprintln(w, "update: updater unavailable")
		return false
	}
	verifier, err := resolveVerifier(cfg.InstallRoot)
	if err != nil {
		fmt.Fprintln(w, "update: updater unavailable")
		return false
	}
	client := cfg.Client
	if client == nil {
		client = newHardenedClient()
	}

	fmt.Fprintln(w, "update: checking for updates...")
	rel, err := selectRelease(client)
	if err != nil {
		fmt.Fprintln(w, "update: could not check for updates")
		return false
	}
	if rel.Version == cfg.Version {
		fmt.Fprintf(w, "update: already up to date (v%s)\n", rel.Version)
		return false
	}

	staging, err := os.MkdirTemp(stagingBase(cfg.InstallRoot), "eizouden-update-*")
	if err != nil {
		fmt.Fprintln(w, "update: update failed")
		return false
	}
	plan, err := stageRelease(client, verifier, staging, cfg.InstallRoot, rel)
	if err != nil {
		os.RemoveAll(staging)
		fmt.Fprintln(w, "update: release verification failed")
		return false
	}
	if err := spawnApply(staging, plan); err != nil {
		os.RemoveAll(staging)
		fmt.Fprintln(w, "update: update failed")
		return false
	}
	// Success: the staging dir is handed to the child (which removes it
	// after applying); the parent must NOT remove it before exiting.
	fmt.Fprintln(w, "update: verified and restarting...")
	return true
}

// keyPinned reports whether PinnedPublicKey is a plausible Minisign
// public key. The placeholder, an empty value, a wrong prefix, an
// unexpected length, or invalid base64 characters all fail closed.
func keyPinned() bool {
	k := PinnedPublicKey
	if k == "" || strings.Contains(k, "REPLACE_ME") || !strings.HasPrefix(k, "RW") {
		return false
	}
	if len(k) < 42 || len(k) > 80 {
		return false
	}
	for _, r := range k[2:] {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '+' || r == '/':
		default:
			return false
		}
	}
	return true
}

// stagingBase returns the directory the update staging dir is created
// under: the install root, i.e. filepath.Dir(plan.Core) — windowsPlan
// and termuxPlan always join the core name onto installRoot. Staging on
// the same drive as the install target keeps the apply child's final
// rename inside one filesystem (os.Rename cannot move a file across
// devices; e.g. a RAM-disk TEMP on A: with the install on C: fails with
// ERROR_NOT_SAME_DEVICE). copyThenRemove in the child is the backstop;
// same-drive staging avoids the failure mode entirely. An empty root,
// a relative root that cannot be absolutized, or a missing/non-directory
// root falls back to the OS temp dir (the historical behavior).
func stagingBase(installRoot string) string {
	if installRoot == "" {
		return ""
	}
	abs, err := filepath.Abs(installRoot)
	if err != nil {
		return ""
	}
	if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
		return ""
	}
	return abs
}
