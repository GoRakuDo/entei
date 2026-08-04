// Package torrent implements the EizouDendenshi local-torrent job
// boundary (ED-2G): up to MaxConcurrentTorrents concurrent
// anacrolix/torrent-backed BitTorrent sessions (oldest-first eviction),
// whose completed files later feed the existing status/media
// bridge — strictly gated by an explicit one-video + optional-subtitle
// selection. No GoRakuDo proxy, no browser WebTorrent.
//
// Security contract:
//   - Only `magnet:?xt=urn:btih:` infohash magnets are accepted and
//     canonicalized to a deterministic 40-hex form; safe `tr=` announce
//     trackers may be preserved (see tracker policy below); every other
//     input is rejected before any process is spawned, and errors never
//     echo the magnet or tracker data.
//   - Tracker policy: at most maxTrackers announce URLs are preserved, each
//     strictly validated (scheme udp/http/https only; no userinfo, fragment,
//     IP-literal hosts, localhost/loopback/unspecified/link-local/private
//     addresses, ports outside 1-65535, non-ASCII/control/whitespace, or
//     unsafe paths). If ANY supplied tracker is unsafe the WHOLE magnet is
//     rejected (visible, fail-closed contract — unsafe trackers are never
//     silently dropped). Canonical trackers are deduplicated and emitted in
//     deterministic sorted order. `http` is allowed only with the documented
//     tradeoff (plaintext announce exposes the infohash and the user's IP to
//     the tracker operator and on-path observers); `dn`, `xl`, webseeds and
//     every other parameter remain dropped. Validation never performs DNS
//     resolution. Tracker data never appears in API snapshots, errors, logs,
//     or docs output.
//   - The torrent engine is constructed at startup. Its BitTorrent peer
//     transport binds ALL interfaces (uTP/DHT/TCP share the listen socket
//     with outgoing dials; loopback binding would kill udp-tracker, DHT
//     and uTP connectivity — see engine_anacrolix.go). The security
//     boundary is held elsewhere: NoUpload=true, metadata-only until the
//     user selects a file, selected-files-only download, and the HTTP API
//     on its own loopback-only listener (127.0.0.1:4322). The canonicalized
//     magnet is passed directly; no shell is ever involved.
//   - Cancellation / failure / session end drops the torrent and frees
//     the session. User files are never touched.
//   - Responses expose only opaque job ids and sanitized file metadata
//     (basename / extension / byteSize / kind) — never absolute paths, the
//     magnet, trackers, or engine internals. Nothing is served before a
//     valid selection.
//
// Privacy note: a tracker is a third-party endpoint. Once a torrent job
// actually runs, the user's IP address is exposed to the tracker(s) and to
// torrent peers (via PEX/DHT); the tracker also learns the infohash. The
// rest of the companion remains local-only. User consent for this exposure
// is a future UI phase; the docs describe it accurately.
package torrent

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ErrInvalidMagnet is the generic rejection error; it never echoes input.
var ErrInvalidMagnet = errors.New("invalid magnet URI")

// ErrNotFound is returned when the requested job id does not exist.
var ErrNotFound = errors.New("job not found")

// ErrNotListed is returned when the file listing is not ready yet (the
// download has not completed) or the job errored.
var ErrNotListed = errors.New("file listing not ready")

// ErrInvalidSelection is returned when a selection does not satisfy the
// one-video + optional-subtitle contract.
var ErrInvalidSelection = errors.New("invalid selection")

// Error codes returned in Snapshot.ErrorCode for frontend routing.
// These are stable identifiers; the frontend maps them to localized
// user-facing messages and never compares error strings.
const (
	ErrCodeConcurrencyLimit = "torrent_concurrency_limit"
	ErrCodeEngineFailed     = "torrent_engine_failed"
	ErrCodeMetadataTimeout  = "torrent_metadata_timeout"
	ErrCodeNoPlayableVideo  = "torrent_no_playable_video"
	ErrCodeReaderFailed     = "torrent_reader_failed"
	ErrCodeMetadataFailed   = "torrent_metadata_failed"
)

// MaxConcurrentTorrents is the maximum number of concurrent torrent sessions.
// A third create evicts the oldest session with ErrCodeConcurrencyLimit.
const MaxConcurrentTorrents = 2

// EvictedTTLDefault is how long an evicted session remains readable after
// eviction. The frontend polls at 5s intervals; 30s covers 5-6 polls with
// margin. Config.EvictedTTL overrides this in tests.
const EvictedTTLDefault = 30 * time.Second

const btihPrefix = "urn:btih:"

// Tracker policy constants (documented in the package contract).
const (
	// maxTrackers is the maximum number of preserved announce URLs. More
	// trackers than this reject the whole magnet (fail closed).
	maxTrackers = 5
	// maxTrackerLen bounds a single announce URL (including its query
	// payload). Announce URLs beyond this reject the whole magnet.
	maxTrackerLen = 512
)

// allowedTrackerSchemes: udp is the standard announce transport; http/https
// cover tracker deployments that only speak plaintext/tls. http is allowed
// with the documented plaintext-exposure tradeoff.
var allowedTrackerSchemes = map[string]bool{"udp": true, "http": true, "https": true}

// ValidateMagnet parses and canonicalizes a user-supplied magnet URI.
//
// Accepted: `magnet:?xt=urn:btih:<40-hex | 32-base32>` with exactly one xt
// parameter, plus up to maxTrackers `tr=` announce URLs that each pass the
// strict tracker policy. The canonical form is
// `magnet:?xt=urn:btih:<40-lowercase-hex>[&tr=<canonical>...]` with the
// trackers deduplicated and sorted deterministically. ANY other parameter
// (dn / xl / webseeds / …) is dropped; ANY unsafe tracker rejects the whole
// magnet. Errors are generic and never contain the input.
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

	// Trackers: preserve only strictly valid announce URLs; ANY unsafe
	// tracker rejects the whole magnet (never silently dropped).
	trs := q["tr"]
	if len(trs) > maxTrackers {
		return "", ErrInvalidMagnet
	}
	canonTrackers := make([]string, 0, len(trs))
	seen := make(map[string]bool, len(trs))
	for _, tr := range trs {
		ct, err := canonicalTracker(tr)
		if err != nil {
			return "", ErrInvalidMagnet
		}
		if !seen[ct] {
			seen[ct] = true
			canonTrackers = append(canonTrackers, ct)
		}
	}
	sort.Strings(canonTrackers)

	var b strings.Builder
	b.WriteString("magnet:?xt=")
	b.WriteString(btihPrefix)
	b.WriteString(canon)
	for _, ct := range canonTrackers {
		b.WriteString("&tr=")
		b.WriteString(url.QueryEscape(ct))
	}
	return b.String(), nil
}

// canonicalTracker strictly validates a single announce URL and returns its
// canonical form (lowercase scheme + host, preserved path/query, no
// userinfo/fragment, no IP-literal or unsafe host, bounded port and length).
// It never performs DNS resolution and never echoes the input in errors.
func canonicalTracker(raw string) (string, error) {
	if raw == "" || len(raw) > maxTrackerLen {
		return "", ErrInvalidMagnet
	}
	// Pure-ASCII, no whitespace/control characters anywhere.
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c < 0x21 || c > 0x7E { // rejects control/whitespace/non-ASCII
			return "", ErrInvalidMagnet
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || u.Fragment != "" || u.RawPath != "" {
		return "", ErrInvalidMagnet
	}
	scheme := strings.ToLower(u.Scheme)
	if !allowedTrackerSchemes[scheme] {
		return "", ErrInvalidMagnet
	}
	host := u.Hostname()
	if host == "" {
		return "", ErrInvalidMagnet
	}
	// Hostname required: any IP literal (public/private, v4 or v6) is
	// rejected, which also covers localhost/loopback/unspecified/link-local/
	// private and IPv6 literals.
	if ip := net.ParseIP(host); ip != nil {
		return "", ErrInvalidMagnet
	}
	low := strings.ToLower(host)
	if low == "localhost" {
		return "", ErrInvalidMagnet
	}
	// Port: absent is fine; an explicit port must be 1-65535.
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return "", ErrInvalidMagnet
		}
	}
	// Path must be announce-compatible: empty or starting with '/', and no
	// backslashes anywhere.
	path := u.EscapedPath()
	if path != "" && !strings.HasPrefix(path, "/") {
		return "", ErrInvalidMagnet
	}
	if strings.ContainsAny(path, "\\") || strings.ContainsAny(u.RawQuery, "\\") {
		return "", ErrInvalidMagnet
	}
	// Rebuild canonically: scheme://host[:port][/path][?query].
	var b strings.Builder
	b.WriteString(scheme)
	b.WriteString("://")
	b.WriteString(low)
	if p := u.Port(); p != "" {
		b.WriteString(":")
		b.WriteString(p)
	}
	b.WriteString(path)
	if u.RawQuery != "" {
		b.WriteString("?")
		b.WriteString(u.RawQuery)
	}
	return b.String(), nil
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
