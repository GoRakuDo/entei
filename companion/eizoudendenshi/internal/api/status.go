package api

import (
	"encoding/json"
	"net/http"
	"os"
)

// Status states reported by /v1/media/status. They describe the configured
// media source, not the request: disabled (no source), buffering (growing
// source, available < total), complete (full representation available), and
// error (the current source failed; reported generically, fail-closed).
const (
	statusDisabled  = "disabled"
	statusBuffering = "buffering"
	statusComplete  = "complete"
	statusError     = "error"
)

// bufferingRetryAfterSec is the Retry-After hint exposed in status bodies
// while buffering — the same value the 503 media responses carry
// (bufferingRetryAfter in growing.go; kept in sync by the tied test).
const bufferingRetryAfterSec = 1

// statusBody is the metadata-only body of GET /v1/media/status. It carries
// availability and readiness facts — never a path, filename, capability
// token, pairing code, or media bytes. retryAfter is present only while
// buffering (it is the current 503 hint); headReady is reserved for a
// byte-level playable-prefix check and stays false until implemented.
type statusBody struct {
	State      string `json:"state"`
	Available  int64  `json:"available"`
	Total      int64  `json:"total"`
	HeadReady  bool   `json:"headReady"`
	RetryAfter int    `json:"retryAfter,omitempty"`
}

// handleMediaStatus serves the availability snapshot for the configured
// media source (ED-2E buffering bridge). It shares the exact Origin +
// capability gates of /v1/media/fixture: a missing or disallowed Origin is
// rejected without CORS headers, and a missing/invalid token is rejected
// with 401. The response is Cache-Control: no-store; HEAD mirrors GET with
// an empty body; OPTIONS preflight is origin-gated.
func (s *Server) handleMediaStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handleMediaStatusPreflight(w, r)
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

	// Capability gate: constant-time token comparison (same as media).
	if !s.tokenValid(r) {
		writeJSON(w, http.StatusUnauthorized, errorBody("unauthorized"))
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return // HEAD mirrors status + headers with an empty body.
	}
	_ = json.NewEncoder(w).Encode(s.currentStatus())
}

// currentStatus snapshots the configured media source once, under the
// server lock. Availability is monotonic by the GrowingSource contract
// (internal/media), so a snapshot never decreases and never exceeds Total.
// Source failures fail closed with a generic "error" state — no path, no
// size, no filename is ever disclosed.
func (s *Server) currentStatus() statusBody {
	s.mu.Lock()
	defer s.mu.Unlock()

	// ED-2F: an active job session takes precedence over the configured
	// source. queued/downloading/buffering → status "buffering" with the
	// current bytes on disk (total 0 until the helper finishes);
	// complete → "complete"; error → "error"; cancelled → fall through.
	if s.jobs != nil {
		if body, ok := s.activeJobStatus(); ok {
			return body
		}
	}

	if s.growSource != nil {
		total := s.growSource.Total()
		avail := s.growSource.Available()
		if avail >= total {
			return statusBody{State: statusComplete, Available: total, Total: total}
		}
		return statusBody{
			State:      statusBuffering,
			Available:  avail,
			Total:      total,
			RetryAfter: bufferingRetryAfterSec,
		}
	}

	if s.fixturePath != "" {
		st, err := os.Stat(s.fixturePath)
		if err != nil || st.IsDir() {
			// Fail closed: the source is unusable right now. The body stays
			// generic — it must not reveal whether a path exists or what it is.
			return statusBody{State: statusError}
		}
		total := st.Size()
		return statusBody{State: statusComplete, Available: total, Total: total}
	}

	return statusBody{State: statusDisabled}
}

// handleMediaStatusPreflight answers OPTIONS for /v1/media/status. Status
// polling is a simple GET (no custom headers), so no Allow-Headers is
// advertised; methods mirror the media endpoint.
func (s *Server) handleMediaStatusPreflight(w http.ResponseWriter, r *http.Request) {
	origin, ok := s.originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.Header().Add("Vary", "Origin")
	w.WriteHeader(http.StatusNoContent)
}
