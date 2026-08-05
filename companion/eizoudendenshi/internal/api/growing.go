package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// bufferingRetryAfter is the Retry-After delta-seconds sent with 503
// buffering responses. PoC fixed default: a future downloader-backed source
// can compute it from progress; Entei may use it to schedule the next
// attempt.
const bufferingRetryAfter = "1"

// bufferingBody is the JSON payload of a 503 buffering response. It
// carries only availability metadata — enough for a bridge to decide when
// a retry makes sense — and never a path, token, or pairing data.
type bufferingBody struct {
	Error     string `json:"error"`
	Available int64  `json:"available"`
	Total     int64  `json:"total"`
}

// serveGrowingMedia serves the configured growing source (ED-2C). It is a
// thin wrapper over the shared serveGrowingSource (internal/api/jobs.go),
// which also serves the ED-2F job media path.
//
// Contract (documented in companion/eizoudendenshi/README.md and
// docs/EIZOU_DENDENSHI.md):
//   - GET/HEAD without a usable Range: 200 with the full body only when
//     Available == Total. Otherwise 503 — a 200 would falsely claim the
//     representation is complete (truncated success).
//   - Single Range starting within [0, Available()): 206 Partial Content —
//     when the requested end reaches beyond Available() (e.g. the
//     open-ended bytes=0- Chrome 151 sends first) it is clamped to
//     Available()-1 per RFC 9110: an exact partial response, never a byte
//     beyond the verified prefix.
//   - Single Range starting at or beyond Available(): long-polled until
//     Available() strictly passes the requested start, then 206 with the
//     same clamping; only after the hold timeout (streamingHoldTimeout,
//     30 s) is a 503 Service Unavailable with Retry-After returned —
//     never fabricated bytes, never an indefinite block.
//   - Range starting at or beyond Total: 416 with "bytes */Total" — the
//     only permanently-unsatisfiable case; a merely-not-yet range is 503.
//   - HEAD mirrors GET's status and headers with an empty body.
//   - A malformed, non-bytes, or multi-range Range header is ignored
//     (treated as no Range), per RFC 9110; multipart ranges are out of
//     scope for the growing endpoint.
//
// TOCTOU: Available() is snapshotted once per request and the served
// window is derived from that snapshot; reads never cross it. Sources
// additionally refuse reads past their own availability (see
// internal/media) and availability is monotonic, so a concurrent writer
// cannot cause an unavailable byte to be served.
func (s *Server) serveGrowingMedia(w http.ResponseWriter, r *http.Request) {
	s.serveGrowingSource(s.growSource, w, r)
}

// writeBuffering emits the retryable buffering response: 503 Service
// Unavailable with Retry-After (delta-seconds) and a JSON body carrying
// only availability metadata. Nothing else — no paths, no tokens, no
// pairing data, and no media bytes.
func (s *Server) writeBuffering(w http.ResponseWriter, r *http.Request, avail, total int64) {
	w.Header().Set("Retry-After", bufferingRetryAfter)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	if r.Method == http.MethodHead {
		return
	}
	_ = json.NewEncoder(w).Encode(bufferingBody{
		Error:     "buffering",
		Available: avail,
		Total:     total,
	})
}

// streamingHoldPollMs and streamingHoldTimeout bound the availability
// long-poll in waitForPrefix: a request whose start is not yet verified
// is held until the prefix strictly passes it, polling every
// streamingHoldPollMs, for at most streamingHoldTimeout. Both are vars
// (not consts) so tests can shrink them — same pattern as
// renameRetryAttempts in internal/update.
var (
	streamingHoldPollMs  = 250
	streamingHoldTimeout = 30 * time.Second
)

// waitForPrefix long-polls src until its available prefix strictly
// exceeds want (the requested start byte). avail > want is required:
// avail == want means the byte at want is not yet available (ReadAt
// returns EOF at off >= avail), so the request must keep waiting.
//
// Returns true when the prefix caught up, with *avail updated to the
// latest snapshot so the caller can serve the range. Returns false when
// the request context was cancelled (nothing written — the client is
// gone) or when streamingHoldTimeout elapsed without the prefix passing
// want (a 503 buffering response has been written then).
func (s *Server) waitForPrefix(w http.ResponseWriter, r *http.Request, src interface{ Available() int64 }, want, total int64, avail *int64) bool {
	cur := src.Available()
	if cur > want {
		*avail = cur
		return true
	}
	poll := time.NewTicker(time.Duration(streamingHoldPollMs) * time.Millisecond)
	defer poll.Stop()
	timeout := time.NewTimer(streamingHoldTimeout)
	defer timeout.Stop()
	for {
		select {
		case <-r.Context().Done():
			// Client went away; there is no one to answer.
			return false
		case <-timeout.C:
			s.writeBuffering(w, r, cur, total)
			return false
		case <-poll.C:
			cur = src.Available()
			if cur > want {
				*avail = cur
				return true
			}
		}
	}
}

// parseSingleRange parses a single RFC 9110 byte-range spec
// ("bytes=a-b", "bytes=a-", "bytes=-n") against the given representation
// size. It returns start and end as inclusive offsets (end clamped to
// total-1 for satisfiable ranges) and ok=true when the header should be
// honored. ok=false means the header must be ignored: it is absent, uses a
// non-bytes unit, is malformed, or contains multiple ranges (multipart is
// out of scope for the growing endpoint — documented).
//
// A range whose first byte is at or beyond total is returned with
// ok=true and start >= total so the caller can answer 416
// ("bytes */total"); that is the caller's permanently-unsatisfiable case.
func parseSingleRange(spec string, total int64) (start, end int64, ok bool) {
	const prefix = "bytes="
	if !strings.HasPrefix(spec, prefix) {
		return 0, 0, false
	}
	body := spec[len(prefix):]
	if body == "" || strings.Contains(body, ",") {
		// Empty or multi-range: ignore (multipart not supported).
		return 0, 0, false
	}
	dash := strings.IndexByte(body, '-')
	if dash < 0 {
		return 0, 0, false
	}
	a, b := body[:dash], body[dash+1:]
	switch {
	case a != "" && b != "":
		first, err := strconv.ParseInt(a, 10, 64)
		last, err2 := strconv.ParseInt(b, 10, 64)
		if err != nil || err2 != nil || first < 0 || last < first {
			return 0, 0, false
		}
		start, end = first, last
	case a != "":
		first, err := strconv.ParseInt(a, 10, 64)
		if err != nil || first < 0 {
			return 0, 0, false
		}
		start, end = first, total-1
	case b != "":
		n, err := strconv.ParseInt(b, 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false
		}
		if n > total {
			n = total
		}
		start, end = total-n, total-1
	default:
		// "bytes=-": no digits at all.
		return 0, 0, false
	}
	if start >= total {
		// Never satisfiable; the caller answers 416.
		return start, end, true
	}
	if end >= total {
		end = total - 1 // RFC 9110: last-byte-pos clamps to the representation end.
	}
	return start, end, true
}
