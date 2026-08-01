// Package youtube validates YouTube media URLs for the EizouDendenshi
// local source job API (ED-2F).
//
// The validation is deliberately strict: only a small, exact set of YouTube
// host forms is accepted, and the returned canonical URL is the ONLY
// user-derived value ever passed to the download helper — never as part of
// a flag, always as its own argv element. Everything else (host suffixes,
// extra query parameters, ports, userinfo, fragments, non-ASCII, path
// tricks) is rejected before any process is spawned.
package youtube

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// ErrInvalidURL is returned for every rejected input; it is deliberately
// generic and never echoes the offending URL.
var ErrInvalidURL = errors.New("invalid YouTube URL")

// videoIDChars are the characters permitted in a YouTube video ID (the
// standard 11-character base64url-shaped identifier).
const videoIDChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"

// hostForms maps the accepted YouTube host forms (lowercase, no port, no
// subdomain wildcards) to their canonical host for normalization. Any other
// host — including lookalikes such as youtube.com.evil.example — is
// rejected by exact match only.
var hostForms = map[string]bool{
	"youtube.com":       true,
	"www.youtube.com":   true,
	"m.youtube.com":     true,
	"music.youtube.com": true,
	"youtu.be":          true,
}

// ValidateURL parses and validates a user-supplied YouTube URL and returns
// a canonical https URL suitable as the final argv element for the download
// helper. It rejects everything that is not one of the exact supported
// forms; errors are generic (ErrInvalidURL) and never contain the input.
func ValidateURL(raw string) (string, error) {
	if raw == "" {
		return "", ErrInvalidURL
	}
	if !isASCII(raw) {
		return "", ErrInvalidURL
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", ErrInvalidURL
	}
	if u.Scheme != "https" {
		// Strict: only https. No http, no protocol-relative "//…", no
		// javascript: or other schemes.
		return "", ErrInvalidURL
	}
	if u.User != nil {
		return "", ErrInvalidURL
	}
	if u.Port() != "" {
		return "", ErrInvalidURL
	}
	if u.Fragment != "" {
		return "", ErrInvalidURL
	}
	host := strings.ToLower(u.Hostname())
	if !hostForms[host] {
		return "", ErrInvalidURL
	}

	// youtu.be/<id> — exactly one path segment, no query, no further path.
	if host == "youtu.be" {
		id := strings.TrimPrefix(u.Path, "/")
		if id == "" || strings.Contains(id, "/") || u.RawQuery != "" {
			return "", ErrInvalidURL
		}
		if !validVideoID(id) {
			return "", ErrInvalidURL
		}
		return fmt.Sprintf("https://youtu.be/%s", id), nil
	}

	// youtube.com family paths: /watch?v=…, /shorts/<id>, /embed/<id>,
	// /live/<id>. Anything else is rejected.
	path := u.Path
	switch {
	case path == "/watch":
		q := u.Query()
		if len(q) != 1 {
			return "", ErrInvalidURL
		}
		id, ok := q["v"]
		if !ok || len(id) != 1 || !validVideoID(id[0]) {
			return "", ErrInvalidURL
		}
		return fmt.Sprintf("https://%s/watch?v=%s", host, id[0]), nil
	case strings.HasPrefix(path, "/shorts/"),
		strings.HasPrefix(path, "/embed/"),
		strings.HasPrefix(path, "/live/"):
		if u.RawQuery != "" {
			return "", ErrInvalidURL
		}
		// The id is exactly one path segment after the fixed prefix; the
		// prefix itself must be one of the accepted forms.
		segments := strings.Split(strings.TrimPrefix(path, "/"), "/")
		if len(segments) != 2 {
			return "", ErrInvalidURL
		}
		id := segments[1]
		if !validVideoID(id) {
			return "", ErrInvalidURL
		}
		return fmt.Sprintf("https://%s/%s/%s", host, segments[0], id), nil
	default:
		return "", ErrInvalidURL
	}
}

// validVideoID requires the standard 11-character base64url YouTube video
// identifier.
func validVideoID(id string) bool {
	if len(id) != 11 {
		return false
	}
	for i := 0; i < len(id); i++ {
		if !strings.ContainsRune(videoIDChars, rune(id[i])) {
			return false
		}
	}
	return true
}

// isASCII reports whether s contains only ASCII bytes.
func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}
