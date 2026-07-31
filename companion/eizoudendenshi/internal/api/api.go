// Package api implements the EizouDendenshi loopback HTTP API: a minimal,
// narrowly scoped JSON + media surface proving safe local API / pairing /
// Range foundations.
//
// Contract:
//   - GET  /v1/health — non-sensitive readiness/version data.
//   - POST /v1/pair   — exchange a correct pairing code for an opaque
//     capability token. Requires an allowed Origin. The code is consumed
//     on success (single-use) and is never echoed in errors or logs.
//   - OPTIONS /v1/pair — CORS preflight for the pair endpoint.
//   - GET/HEAD /v1/media/fixture — the configured fixture, served with
//     correct byte Range semantics. Requires BOTH an allowed Origin AND a
//     valid capability token via the `token` query parameter (video
//     elements cannot set request headers; query-token is PoC-only).
//     OPTIONS preflight is strictly origin-gated.
//   - Unknown routes → 404; known routes with unknown methods → 405.
//
// Security boundaries:
//   - Binding is loopback-only (enforced by the command, not here).
//   - CORS allows exactly https://entei.gorakudo.org and
//     http://localhost:4321 — no wildcard.
//   - Pairing code and capability token exist only in process memory and
//     are never logged, echoed, or exposed in errors.
//   - No fixture configured → the media endpoint is honestly disabled
//     (generic 404). Local paths are never disclosed.
package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"sync"

	"eizoudendenshi/internal/pairing"
)

// Version is the release version reported by /v1/health.
const Version = "0.2.0"

// apiVersion is the stable API namespace.
const apiVersion = "v1"

// allowedOrigins are the only Origins accepted for pairing. Exact string
// match only — no wildcards, no suffix/prefix matching.
var allowedOrigins = map[string]struct{}{
	"https://entei.gorakudo.org": {},
	"http://localhost:4321":      {},
}

// Config carries options for New.
type Config struct {
	// FixturePath is the single media file served at /v1/media/fixture.
	// Empty means the media endpoint is honestly disabled (generic 404).
	// The endpoint never scans directories.
	FixturePath string
}

// Server holds in-memory pairing state for one process lifetime.
type Server struct {
	mu          sync.Mutex
	code        string // 6-digit pairing code; consumed after a successful pair
	token       string // opaque capability token; never logged or persisted
	fixturePath string // ED-2B: media fixture served at /v1/media/fixture
}

// New generates fresh pairing credentials for the process.
func New(cfg Config) (*Server, error) {
	code, err := pairing.GenerateCode()
	if err != nil {
		return nil, err
	}
	token, err := pairing.GenerateToken()
	if err != nil {
		return nil, err
	}
	return &Server{code: code, token: token, fixturePath: cfg.FixturePath}, nil
}

// PairingCode returns the current pairing code. Used by the command to
// print it to the terminal; the capability token has no getter.
func (s *Server) PairingCode() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.code
}

// Handler returns the HTTP handler for the API.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", s.handleHealth)
	mux.HandleFunc("/v1/pair", s.handlePair)
	mux.HandleFunc("/v1/media/fixture", s.handleMediaFixture)
	mux.HandleFunc("/", handleNotFound)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	// Non-sensitive read: data is always served; CORS headers only for
	// allowed origins so a browser can read it.
	setOriginHeaders(w, r)
	writeJSON(w, http.StatusOK, map[string]string{
		"status":     "ready",
		"version":    Version,
		"apiVersion": apiVersion,
	})
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handlePairPreflight(w, r)
		return
	}
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST, OPTIONS")
		return
	}

	// Pairing is a state change: missing or disallowed Origin is rejected.
	// The error is returned without CORS headers, so a disallowed browser
	// origin cannot read it either.
	origin, ok := originAllowed(r)
	if !ok {
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
	if match {
		// Single-use: consume the code on success.
		s.code = ""
	}
	s.mu.Unlock()

	if !match {
		writeJSON(w, http.StatusForbidden, errorBody("invalid pairing code"))
		return
	}

	// The token is returned exactly once, here. It is never echoed in any
	// other response, error, or log.
	writeJSON(w, http.StatusOK, map[string]string{"token": s.token})
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
	origin, ok := originAllowed(r)
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
	origin, ok := originAllowed(r)
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
	a := sha256.Sum256([]byte(supplied))
	b := sha256.Sum256([]byte(s.token))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

func (s *Server) handlePairPreflight(w http.ResponseWriter, r *http.Request) {
	origin, ok := originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.Header().Add("Vary", "Origin")
	w.WriteHeader(http.StatusNoContent)
}

// originAllowed returns the request Origin only when it is exactly one of
// the allowlisted origins. Missing and disallowed origins both return false
// without leaking which case occurred.
func originAllowed(r *http.Request) (string, bool) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return "", false
	}
	if _, ok := allowedOrigins[origin]; !ok {
		return "", false
	}
	return origin, true
}

// setOriginHeaders adds CORS headers when the request Origin is allowed.
func setOriginHeaders(w http.ResponseWriter, r *http.Request) {
	if origin, ok := originAllowed(r); ok {
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

func handleNotFound(w http.ResponseWriter, _ *http.Request) {
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
