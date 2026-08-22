// Package api implements the EizouDendenshi loopback HTTP API: a minimal,
// narrowly scoped JSON + media surface proving safe local API / pairing /
// Range foundations.
//
// Contract:
//   - GET  /v1/health — non-sensitive readiness/version data.
//   - POST /v1/pair   — exchange a correct pairing code for an opaque
//     capability token. Requires an allowed Origin. The code is consumed
//     on success (single-use) and is never echoed in errors or logs.
//     When a credential store is configured, the token is persisted
//     BEFORE the 200 is returned; a persistence failure fails the pair
//     request without a token response.
//   - DELETE /v1/pair  — authenticated (Origin + capability token)
//     explicit reset: deletes the persisted credential (best effort),
//     invalidates the in-memory token, and issues a FRESH pairing code +
//     token so the pairing dialog works again without a restart. Only
//     the credential is touched — never jobs or media.
//   - GET  /v1/pair/status — authenticated (Origin + capability token)
//     non-sensitive acknowledgement used by the browser to re-validate a
//     stored token after reload. Never echoes the token, code, path, or
//     storage errors, and never creates pairing state.
//   - OPTIONS /v1/pair and /v1/pair/status — CORS preflight (origin-gated).
//   - GET/HEAD /v1/media/fixture — the configured fixture, served with
//     correct byte Range semantics. Requires BOTH an allowed Origin AND a
//     valid capability token via the `token` query parameter (video
//     elements cannot set request headers; query-token is PoC-only).
//     OPTIONS preflight is strictly origin-gated.
//   - GET/HEAD /v1/media/status — metadata-only availability snapshot for
//     the configured media source (ED-2E buffering bridge). Same Origin +
//     capability gates as /v1/media/fixture. The body carries only
//     state/available/total/headReady/retryAfter — never a path, token,
//     pairing code, or media bytes. HEAD mirrors GET; OPTIONS preflight is
//     origin-gated.
//   - Unknown routes → 404; known routes with unknown methods → 405.
//
// Security boundaries:
//   - Binding is loopback-only (enforced by the command, not here).
//   - CORS allows exactly https://entei.gorakudo.org and
//     http://localhost:4321 — no wildcard. A per-process development
//     override (Config.AllowOrigins, e.g. --allow-origin) may add further
//     exact origins for QA; it never replaces the fixed set and is never
//     persisted.
//   - Development LAN QA origins http://192.168.100.*:4321 are accepted
//     (RFC 1918 private space, phone-on-LAN testing of the media
//     endpoints) with full IPv4 octet + fixed-port validation; the
//     capability-token gate still applies on top of CORS.
//   - The pairing code is never logged, echoed, or exposed in errors. The
//     capability token is returned exactly once by POST /v1/pair and is
//     otherwise never logged, echoed, or exposed. With a configured
//     credential store the token persists (platform-encrypted) across
//     companion restarts; without one it exists only in process memory.
//   - No fixture configured → the media endpoint is honestly disabled
//     (generic 404). Local paths are never disclosed.
package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"

	"eizoudendenshi/internal/credential"
	"eizoudendenshi/internal/diag"
	"eizoudendenshi/internal/job"
	"eizoudendenshi/internal/media"
	"eizoudendenshi/internal/pairing"
	"eizoudendenshi/internal/torrent"
)

// Version is the release version reported by /v1/health and the startup
// banner. The dev default is 0.2.0; release builds override it at link time
// (-ldflags -X eizoudendenshi/internal/api.Version=<semver>, wired by
// scripts/release.ps1) so a compiled release binary always reports exactly
// the manifest version. It must stay a var (never a const) for -X
// injection; plain go run / go test builds keep the dev default.
var Version = "0.2.0"

// apiVersion is the stable API namespace.
const apiVersion = "v1"

// fixedOrigins are the only production Origins accepted for pairing. Exact
// string match only — no wildcards, no suffix/prefix matching. Per-process
// development origins (Config.AllowOrigins) are added to the combined set
// at New time; the fixed set changes only when a new production or dev
// origin is identified.
//
// Both loopback spellings are listed: browsers resolve localhost and
// 127.0.0.1 as distinct Origins, and the dev server can be reached via
// either (2026-08-10: OPTIONS /v1/pair 403 from http://127.0.0.1:4321 —
// the Origin was missing from the fixed set, so the preflight got no
// Access-Control-Allow-Origin header).
var fixedOrigins = map[string]struct{}{
	"https://entei.gorakudo.org": {},
	"http://localhost:4321":      {},
	"http://127.0.0.1:4321":      {},
}

// ParseOrigin validates s as an exact HTTP(S) origin and returns its
// normalized form, or an error if it is not usable as an allowlist entry.
//
// Accepted shape: scheme http or https, host required, optional numeric
// port. Userinfo, path, query, fragment, wildcards, and empty hosts are
// rejected. Normalization lowercases the scheme and host and drops default
// ports (http:80, https:443), matching how browsers serialize Origin.
// Errors are generic and never echo the input value.
func ParseOrigin(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", errors.New("empty origin")
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", errors.New("invalid origin")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errors.New("origin scheme must be http or https")
	}
	if u.Host == "" {
		return "", errors.New("origin host is required")
	}
	if u.User != nil {
		return "", errors.New("origin must not contain userinfo")
	}
	if u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("origin must not contain a path, query, or fragment")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", errors.New("origin host is required")
	}
	if strings.ContainsAny(host, "*") {
		return "", errors.New("origin must not contain wildcards")
	}
	port := u.Port()
	if port != "" {
		p, err := strconv.Atoi(port)
		if err != nil || p < 1 || p > 65535 {
			return "", errors.New("origin has an invalid port")
		}
		if (scheme == "http" && p == 80) || (scheme == "https" && p == 443) {
			port = "" // default ports are implicit in the Origin serialization
		}
	}
	// Rebuild canonical form: bracketed IPv6, explicit non-default port.
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	return scheme + "://" + host, nil
}

// Config carries options for New.
type Config struct {
	// FixturePath is the single media file served at /v1/media/fixture.
	// Empty means the media endpoint is honestly disabled (generic 404).
	// The endpoint never scans directories.
	FixturePath string

	// GrowSource, when set, serves /v1/media/fixture with the ED-2C
	// growing-media contract: availability-aware Range semantics with an
	// explicit 503+Retry-After buffering response for ranges touching
	// bytes not yet available (see serveGrowingMedia). It is mutually
	// exclusive with FixturePath — exactly one media source may be
	// configured.
	GrowSource media.GrowingSource

	// Ffmpeg, when set, is the pinned ffmpeg executable used by
	// /v1/media/pcm to convert the completed media to 16 kHz mono f32 PCM
	// (sub-to-audio subtitle sync). Empty disables the PCM endpoint.
	// The path must be validated by the caller (cmd/eizouden does).
	Ffmpeg string

	// AllowOrigins are additional exact HTTP(S) origins permitted by CORS
	// for this process only — a development/QA override (ED-2C). Each entry
	// is validated and normalized with ParseOrigin; an invalid entry makes
	// New fail. The fixed production origins always remain.
	AllowOrigins []string

	// Jobs, when set, enables the ED-2F YouTube source-job endpoints
	// (/v1/source/jobs…). Nil leaves them unregistered (404) and the
	// media/status endpoints behave exactly as before.
	Jobs *job.Manager

	// Torrents, when set, enables the ED-2G torrent-job endpoints
	// (/v1/source/torrents…). Nil leaves them unregistered (404). One
	// active job is enforced across Jobs and Torrents together.
	Torrents *torrent.Manager

	// Credential, when set, persists the capability token across
	// companion restarts (see internal/credential). A valid saved token
	// is loaded at New; otherwise fresh code + token are generated. A
	// successful pair persists the token BEFORE the 200 response; a
	// persistence failure fails the pair request without a token. Nil
	// keeps the historical memory-only contract (useful for tests and
	// tools that must never touch disk).
	Credential credential.Store

	// OnPairingReset, when set, is invoked with the FRESH pairing code
	// after an authenticated DELETE /v1/pair, so the command can print
	// the new code to the terminal (the pairing dialog then works
	// without a restart). Nil for tests and non-interactive runs.
	OnPairingReset func(code string)

	// Logger, when set, enables request + pairing diagnostics (components
	// "api" / "pairing"). Nil keeps the historical no-logging behavior.
	// Redaction contract (see internal/diag): request lines are
	// method + path (query stripped) + status only — a capability token
	// carried in the query string can never reach the log; pairing lines
	// are success/failure only, never a code or token.
	Logger *diag.Logger
}

// Server holds in-memory pairing state for one process lifetime.
type Server struct {
	mu             sync.Mutex
	code           string              // 6-digit pairing code; consumed after a successful pair
	token          string              // opaque capability token; never logged, persisted only via cred
	cred           credential.Store    // optional persistent credential store (nil = memory-only)
	onReset        func(code string)   // optional fresh-code notifier after DELETE /v1/pair
	log            *diag.Logger        // optional diagnostic sink (nil-safe)
	fixturePath    string              // ED-2B: static media fixture served at /v1/media/fixture
	growSource     media.GrowingSource // ED-2C: availability-aware growing source (mutually exclusive with fixturePath)
	ffmpegPath     string              // ED-2H /v1/media/pcm converter (16 kHz mono PCM for sub-to-audio)
	jobs           *job.Manager        // ED-2F: optional YouTube source-job manager (nil = disabled)
	torrents       *torrent.Manager    // ED-2G: optional torrent-job manager (nil = disabled)
	allowedOrigins map[string]struct{} // fixed + per-process extra exact origins

	// createMu serializes job/torrent create handlers so cross-kind
	// fire-and-forget replaces cannot interleave into mixed kinds.
	createMu sync.Mutex
}

// New loads the persisted credential when a store is configured (a
// corrupt / undecryptable stored value fails closed and is never
// accepted — fresh credentials are generated instead), otherwise
// generates fresh pairing credentials for the process, and builds the
// combined exact origin allowlist: the fixed production origins plus any
// validated Config.AllowOrigins extras.
func New(cfg Config) (*Server, error) {
	if cfg.FixturePath != "" && cfg.GrowSource != nil {
		return nil, errors.New("fixture path and growing source are mutually exclusive")
	}
	code, err := pairing.GenerateCode()
	if err != nil {
		return nil, err
	}
	token, err := pairing.GenerateToken()
	if err != nil {
		return nil, err
	}
	if cfg.Credential != nil {
		if saved, _, ok, loadErr := cfg.Credential.Load(); loadErr == nil && ok {
			// The store only ever returns validated tokens (fail closed),
			// so a loaded value is trusted as the capability token.
			token = saved
		}
		// A load error (corrupt / undecryptable / profile mismatch) is
		// deliberately NOT surfaced: the credential is rejected and fresh
		// credentials are generated, with no detail leaked anywhere.
	}
	allowed := make(map[string]struct{}, len(fixedOrigins)+len(cfg.AllowOrigins))
	for o := range fixedOrigins {
		allowed[o] = struct{}{}
	}
	for _, o := range cfg.AllowOrigins {
		norm, err := ParseOrigin(o)
		if err != nil {
			return nil, fmt.Errorf("invalid allow origin: %w", err)
		}
		allowed[norm] = struct{}{}
	}
	return &Server{
		code:           code,
		token:          token,
		cred:           cfg.Credential,
		onReset:        cfg.OnPairingReset,
		log:            cfg.Logger,
		fixturePath:    cfg.FixturePath,
		growSource:     cfg.GrowSource,
		ffmpegPath:     cfg.Ffmpeg,
		jobs:           cfg.Jobs,
		torrents:       cfg.Torrents,
		allowedOrigins: allowed,
	}, nil
}

// PairingCode returns the current pairing code. Used by the command to
// print it to the terminal; the capability token has no getter.
func (s *Server) PairingCode() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.code
}

// Handler returns the HTTP handler for the API. When a diagnostic logger
// is configured, every request is logged as "method path status" — the
// path carries no query string, so a capability token passed as a query
// parameter can never reach the log.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", s.handleHealth)
	mux.HandleFunc("/v1/pair", s.handlePair)
	mux.HandleFunc("/v1/pair/status", s.handlePairStatus)
	mux.HandleFunc("/v1/media/fixture", s.handleMediaFixture)
	mux.HandleFunc("/v1/media/pcm", s.handleMediaPcm)
	mux.HandleFunc("/v1/media/status", s.handleMediaStatus)
	if s.jobs != nil {
		// ED-2F: YouTube source jobs. Registered only when a job manager is
		// configured; otherwise these routes are honestly 404.
		mux.HandleFunc("/v1/source/jobs", s.handleJobCreate)
		mux.HandleFunc("/v1/source/jobs/", s.handleJobByID)
	}
	if s.torrents != nil {
		// ED-2G: torrent jobs. Registered only when a torrent manager
		// is configured; otherwise these routes are honestly 404.
		mux.HandleFunc("/v1/source/torrents", s.handleTorrentCreate)
		mux.HandleFunc("/v1/source/torrents/", s.handleTorrentByID)
	}
	mux.HandleFunc("/", s.handleNotFound)
	if s.log == nil {
		return mux
	}
	return s.requestLog(mux)
}

// requestLog wraps h with per-request diagnostics: method + path (query
// stripped) + status only. The status is captured via a recording writer so
// streaming handlers (http.ServeContent, 206/503 media paths) log their
// real final status.
//
// Steady-state polling (pair/status, media/status, job/torrent status GETs)
// is logged ONLY on failure: the browser repeats those every 1–30 s while a
// session is live, drowning the genuinely interesting lines. Successes of
// those status-only GETs stay silent; errors of the same endpoints, and
// every other request (media/fixture, subtitles, file listings, mutations)
// is still logged as before.
func (s *Server) requestLog(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w}
		h.ServeHTTP(rec, r)
		status := rec.status()
		if isStatusPolling(r.Method, r.URL.Path) && status >= 200 && status < 300 {
			return
		}
		s.log.Infof("api", "%s %s %d", r.Method, r.URL.Path, status)
	})
}

// isStatusPolling reports whether a GET/HEAD request is a steady-state
// status poll whose 2xx responses are suppressed from the request log.
// Accepted:
//
//	/v1/pair/status            — pair validation (5 s cadence)
//	/v1/media/status           — buffering bridge snapshot (30 s cadence)
//	/v1/source/jobs/{id}       — active job snapshot
//	/v1/source/torrents/{id}   — active torrent snapshot
//
// Payload GETs (media/fixture, subtitles, file listings) and all mutations
// (POST/DELETE) are never suppressed — only the bare status id endpoint.
func isStatusPolling(method, path string) bool {
	if method != http.MethodGet && method != http.MethodHead {
		return false
	}
	switch {
	case path == "/v1/pair/status", path == "/v1/media/status":
		return true
	case strings.HasPrefix(path, "/v1/source/jobs/"):
		// The bare status GET is /v1/source/jobs/{id}; any suffix
		// ({id}/subtitle…) carries a payload and stays logged.
		rest := strings.TrimPrefix(path, "/v1/source/jobs/")
		return rest != "" && !strings.Contains(rest, "/")
	case strings.HasPrefix(path, "/v1/source/torrents/"):
		rest := strings.TrimPrefix(path, "/v1/source/torrents/")
		return rest != "" && !strings.Contains(rest, "/")
	}
	return false
}

// statusRecorder captures the response status written by the handler.
type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.code == 0 {
		r.code = http.StatusOK
	}
	return r.ResponseWriter.Write(b)
}

func (r *statusRecorder) status() int {
	if r.code == 0 {
		return http.StatusOK
	}
	return r.code
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	// Non-sensitive read: data is always served; CORS headers only for
	// allowed origins so a browser can read it.
	s.setOriginHeaders(w, r)
	writeJSON(w, http.StatusOK, map[string]string{
		"status":     "ready",
		"version":    Version,
		"apiVersion": apiVersion,
	})
}

// handlePair serves POST /v1/pair (code → token) and DELETE /v1/pair
// (authenticated reset of the pairing credential) with the same origin
// gate and CORS preflight.
func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handlePairPreflight(w, r)
		return
	}
	switch r.Method {
	case http.MethodPost:
		s.pairWithCode(w, r)
	case http.MethodDelete:
		s.deletePairing(w, r)
	default:
		writeMethodNotAllowed(w, "POST, DELETE, OPTIONS")
	}
}

// pairWithCode exchanges a correct pairing code for the capability token.
// The token is persisted BEFORE the 200 is returned when a credential
// store is configured; a persistence failure fails the pair request
// (generic 500, no token response) and does NOT consume the code, so the
// user can retry with the same code.
func (s *Server) pairWithCode(w http.ResponseWriter, r *http.Request) {
	// Pairing is a state change: missing or disallowed Origin is rejected.
	// The error is returned without CORS headers, so a disallowed browser
	// origin cannot read it either.
	origin, ok := s.originAllowed(r)
	if !ok {
		s.log.Warnf("pairing", "pair fail origin denied")
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Add("Vary", "Origin")

	var req struct {
		Code string `json:"code"`
	}
	body := http.MaxBytesReader(w, r.Body, 1024)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid JSON body"))
		return
	}
	if !validCodeFormat(req.Code) {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid pairing code format"))
		return
	}

	s.mu.Lock()
	match := subtle.ConstantTimeCompare([]byte(req.Code), []byte(s.code)) == 1
	if match && s.cred != nil {
		// Persist BEFORE returning 200. Failure fails the pair request and
		// leaves the code unconsumed (the user can retry once storage
		// recovers).
		if err := s.cred.Save(s.token); err != nil {
			s.mu.Unlock()
			writeJSON(w, http.StatusInternalServerError, errorBody("pairing unavailable"))
			return
		}
	}
	if match {
		// Single-use: consume the code only after persistence succeeded.
		s.code = ""
	}
	token := s.token
	s.mu.Unlock()

	if !match {
		// Generic failure line — the code itself is never written.
		s.log.Warnf("pairing", "pair fail invalid code")
		writeJSON(w, http.StatusForbidden, errorBody("invalid pairing code"))
		return
	}

	// Success line: no code, no token.
	s.log.Infof("pairing", "pair ok")
	// The token is returned exactly once, here. It is never echoed in any
	// other response, error, or log.
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

// deletePairing is the authenticated explicit reset: it deletes the
// persisted credential (best effort — the in-memory invalidation below is
// authoritative), rotates the in-memory token, and issues a FRESH pairing
// code so the pairing dialog works again without a restart. Only the
// credential is touched — jobs and media are never affected. The
// response is a non-sensitive acknowledgement that never echoes the
// token or the new code.
func (s *Server) deletePairing(w http.ResponseWriter, r *http.Request) {
	origin, ok := s.originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Add("Vary", "Origin")

	// Authenticated: a valid capability token is required to delete the
	// credential (an unauthenticated reset would be a DoS on pairing).
	if !s.tokenValid(r) {
		writeJSON(w, http.StatusUnauthorized, errorBody("unauthorized"))
		return
	}

	// Rotate credentials first so a generation failure never leaves the
	// server half-reset (old token deleted, old credential gone).
	newToken, err := pairing.GenerateToken()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("pairing reset unavailable"))
		return
	}
	newCode, err := pairing.GenerateCode()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("pairing reset unavailable"))
		return
	}

	s.mu.Lock()
	if s.cred != nil {
		// Best effort: even if the persisted file survives (e.g. disk
		// error), the in-memory rotation below makes the old credential
		// useless and the next successful pair overwrites it.
		_ = s.cred.Delete()
	}
	s.token = newToken
	s.code = newCode
	onReset := s.onReset
	s.mu.Unlock()

	// Tell the command so the FRESH code reaches the terminal; the
	// pairing dialog then works without a companion restart.
	if onReset != nil {
		onReset(newCode)
	}
	s.log.Infof("pairing", "pair reset")
	writeJSON(w, http.StatusOK, map[string]string{"status": "unpaired"})
}

// handlePairStatus is the authenticated non-sensitive acknowledgement
// used by the browser to re-validate a stored token after a reload. It
// performs the same Origin + token gates as the media endpoints but
// returns only a fixed acknowledgement — never the token, the code, a
// path, or a storage error — and creates no pairing state.
func (s *Server) handlePairStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handlePairStatusPreflight(w, r)
		return
	}
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET, OPTIONS")
		return
	}

	origin, ok := s.originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Add("Vary", "Origin")

	if !s.tokenValid(r) {
		writeJSON(w, http.StatusUnauthorized, errorBody("unauthorized"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "paired"})
}

// handleMediaFixture serves the configured fixture with correct HTTP byte
// Range semantics (206 / Content-Range / Accept-Ranges) via http.ServeContent
// from the standard library — the file is streamed, never read fully into
// memory. Access requires BOTH an allowed Origin AND a valid capability
// token (query parameter; video elements cannot set request headers).
//
// The capability token is never logged or echoed: all errors are generic
// and never disclose the token, pairing code, or any local path.
func (s *Server) handleMediaFixture(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handleMediaPreflight(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeMethodNotAllowed(w, "GET, HEAD, OPTIONS")
		return
	}

	// Origin gate first: missing / disallowed Origin is rejected without
	// CORS headers, so a disallowed browser origin cannot read the body.
	origin, ok := s.originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Add("Vary", "Origin")

	// Capability gate: constant-time token comparison.
	if !s.tokenValid(r) {
		writeJSON(w, http.StatusUnauthorized, errorBody("unauthorized"))
		return
	}

	// ED-2F/ED-2G: an active job session (YouTube or torrent) takes
	// precedence over the configured fixture/grow source — it IS the
	// current media session.
	if s.jobs != nil && s.serveJobMedia(w, r) {
		return
	}
	if s.torrents != nil && s.serveTorrentMedia(w, r) {
		return
	}

	// ED-2C: a growing source (when configured) serves the same URL with
	// the availability-aware contract. Mutual exclusivity with FixturePath
	// is enforced by New.
	if s.growSource != nil {
		s.serveGrowingSource(s.growSource, w, r)
		return
	}

	if s.fixturePath == "" {
		// Honest disabled state. The body stays generic — a missing
		// fixture must not expose whether a path exists or what it is.
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return
	}

	file, err := os.Open(s.fixturePath)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return
	}
	defer file.Close()

	st, err := file.Stat()
	if err != nil || st.IsDir() {
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return
	}

	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Expose-Headers",
		"Content-Range, Accept-Ranges, Content-Length")
	// http.ServeContent handles Range / If-Range / If-Modified-Since,
	// 206 Partial Content and 416 Unsatisfiable Range itself, streaming
	// the requested byte window from the file.
	http.ServeContent(w, r, "fixture.mp4", st.ModTime(), file)
}

func (s *Server) handleMediaPreflight(w http.ResponseWriter, r *http.Request) {
	origin, ok := s.originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Range")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.Header().Add("Vary", "Origin")
	w.WriteHeader(http.StatusNoContent)
}

// tokenValid performs a constant-time comparison of the request's `token`
// query parameter against the server-held capability token. Both sides are
// hashed first so the comparison time does not depend on token length. The
// token itself is never exposed, logged, or echoed.
func (s *Server) tokenValid(r *http.Request) bool {
	supplied := r.URL.Query().Get("token")
	if supplied == "" {
		return false
	}
	s.mu.Lock()
	token := s.token
	s.mu.Unlock()
	a := sha256.Sum256([]byte(supplied))
	b := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

func (s *Server) handlePairPreflight(w http.ResponseWriter, r *http.Request) {
	origin, ok := s.originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.Header().Add("Vary", "Origin")
	w.WriteHeader(http.StatusNoContent)
}

// handlePairStatusPreflight is the origin-gated preflight for the
// authenticated status acknowledgement (GET only).
func (s *Server) handlePairStatusPreflight(w http.ResponseWriter, r *http.Request) {
	origin, ok := s.originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.Header().Add("Vary", "Origin")
	w.WriteHeader(http.StatusNoContent)
}

// originAllowed returns the request Origin only when it is exactly one of
// the server's allowlisted origins (fixed set plus per-process extras), or
// a development LAN origin under http://192.168.100.*:4321 (explicit
// prefix match with full IPv4 octet validation; 192.168.100.0/24 is RFC
// 1918 private space, intended for phone-on-LAN developer testing of the
// media endpoints. The capability-token gate still applies on top of
// CORS). Missing and disallowed origins both return false without leaking
// which case occurred.
func (s *Server) originAllowed(r *http.Request) (string, bool) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return "", false
	}
	if _, ok := s.allowedOrigins[origin]; ok {
		return origin, true
	}
	if isLANDevOrigin(origin) {
		return origin, true
	}
	return "", false
}

// lanDevOriginPrefix is the development-LAN origin family:
// http://192.168.100.<host-0..255>:4321. Exact prefix + full IPv4 octet
// validation + the fixed port — no wildcards, no suffix matches.
const lanDevOriginPrefix = "http://192.168.100."

// isLANDevOrigin reports whether origin is a LAN development origin
// http://192.168.100.<0-255>:4321 (192.168.100.0/24, RFC 1918).
func isLANDevOrigin(origin string) bool {
	const suffix = ":4321"
	if !strings.HasPrefix(origin, lanDevOriginPrefix) {
		return false
	}
	rest := strings.TrimPrefix(origin, lanDevOriginPrefix)
	if !strings.HasSuffix(rest, suffix) {
		return false
	}
	host := strings.TrimSuffix(rest, suffix)
	if host == "" {
		return false
	}
	n, err := strconv.Atoi(host)
	if err != nil {
		return false
	}
	return n >= 0 && n <= 255
}

// setOriginHeaders adds CORS headers when the request Origin is allowed.
func (s *Server) setOriginHeaders(w http.ResponseWriter, r *http.Request) {
	if origin, ok := s.originAllowed(r); ok {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")
	}
}

// validCodeFormat requires exactly 6 ASCII digits.
func validCodeFormat(code string) bool {
	if len(code) != 6 {
		return false
	}
	for i := 0; i < len(code); i++ {
		if code[i] < '0' || code[i] > '9' {
			return false
		}
	}
	return true
}

// handleNotFound serves the catch-all 404. It attaches CORS headers for
// allowed origins (including OPTIONS preflights to unknown routes) so the
// browser reports a concrete 404/error instead of "CORS header missing",
// which is what the player sees when a source-job endpoint is disabled.
func (s *Server) handleNotFound(w http.ResponseWriter, r *http.Request) {
	s.setOriginHeaders(w, r)
	writeJSON(w, http.StatusNotFound, errorBody("not found"))
}

func writeMethodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeJSON(w, http.StatusMethodNotAllowed, errorBody("method not allowed"))
}

func errorBody(msg string) map[string]string {
	return map[string]string{"error": msg}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
