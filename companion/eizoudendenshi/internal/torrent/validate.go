// Package torrent implements the EizouDendenshi aria2 local-torrent job
// boundary (ED-2G): a single-session, process-supervised BitTorrent
// download whose completed files later feed the existing status/media
// bridge — strictly gated by an explicit one-video + optional-subtitle
// selection. No GoRakuDo proxy, no browser WebTorrent, no LAN/public bind.
//
// Security contract:
//   - Only `magnet:?xt=urn:btih:` infohash magnets are accepted and
//     canonicalized to a deterministic 40-hex form; every other input is
//     rejected before any process is spawned, and errors never echo the
//     magnet or tracker data.
//   - The aria2 helper is pinned by configuration (never request-derived),
//     spawned with exec.Command and a FIXED argument vector; the
//     canonicalized magnet is the only user-derived value and is passed as
//     its own final argv element. No shell is ever involved.
//   - All torrent files live in a private temp job directory; cancellation /
//     failure / session end kills the aria2 process tree and removes only
//     owned job files. User files are never touched.
//   - Responses expose only opaque job ids and sanitized file metadata
//     (basename / extension / byteSize / kind) — never absolute paths, the
//     magnet, trackers, or raw aria2 stderr. Nothing is served before a
//     valid selection.
package torrent

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"net/url"
	"strings"
)

// ErrInvalidMagnet is the generic rejection error; it never echoes input.
var ErrInvalidMagnet = errors.New("invalid magnet URI")

// ErrConflict is returned when a job is already active anywhere in the
// companion (one active session across YouTube and torrent jobs).
var ErrConflict = errors.New("a job is already active")

// ErrNotFound is returned when the requested job id does not exist.
var ErrNotFound = errors.New("job not found")

// ErrNotListed is returned when the file listing is not ready yet (the
// download has not completed) or the job errored.
var ErrNotListed = errors.New("file listing not ready")

// ErrInvalidSelection is returned when a selection does not satisfy the
// one-video + optional-subtitle contract.
var ErrInvalidSelection = errors.New("invalid selection")

const btihPrefix = "urn:btih:"

// ValidateMagnet parses and canonicalizes a user-supplied magnet URI.
//
// Accepted: `magnet:?xt=urn:btih:<40-hex | 32-base32>` with exactly one xt
// parameter. The canonical form is `magnet:?xt=urn:btih:<40-lowercase-hex>`;
// ALL other parameters (dn / tr / xl / …) are deliberately dropped — the
// infohash is the identity, and no arbitrary or tracker-supplied value
// reaches the helper. Errors are generic and never contain the input.
func ValidateMagnet(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", ErrInvalidMagnet
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "magnet" || u.Opaque != "" {
		return "", ErrInvalidMagnet
	}
	if u.User != nil || u.Fragment != "" || u.RawPath != "" {
		return "", ErrInvalidMagnet
	}
	q := u.Query()
	xts := q["xt"]
	if len(xts) != 1 {
		return "", ErrInvalidMagnet
	}
	xt := xts[0]
	if !strings.HasPrefix(xt, btihPrefix) {
		return "", ErrInvalidMagnet
	}
	ih := strings.TrimPrefix(xt, btihPrefix)
	if ih == "" {
		return "", ErrInvalidMagnet
	}
	canon, err := canonicalInfohash(ih)
	if err != nil {
		return "", ErrInvalidMagnet
	}
	return "magnet:?xt=" + btihPrefix + canon, nil
}

// canonicalInfohash normalizes a BitTorrent infohash to 40 lowercase hex.
// Accepts the two standard encodings: 40 hex characters or 32 base32
// characters (RFC 4648, unpadded).
func canonicalInfohash(s string) (string, error) {
	if len(s) == 40 {
		if !isHex(s) {
			return "", ErrInvalidMagnet
		}
		return strings.ToLower(s), nil
	}
	if len(s) == 32 {
		// Base32 → 20 raw bytes → hex. Uppercase is canonical for input.
		raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(s))
		if err != nil || len(raw) != 20 {
			return "", ErrInvalidMagnet
		}
		return hex.EncodeToString(raw), nil
	}
	return "", ErrInvalidMagnet
}

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// newJobID returns an opaque 32-hex-char job identifier with no relation to
// the magnet or any local path.
func newJobID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}
