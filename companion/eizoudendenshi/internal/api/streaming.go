package api

import (
	"fmt"
	"net/http"
	"strconv"
)

// serveStreamingPrefix serves the selected torrent file's VERIFIED
// contiguous prefix with truthful byte semantics:
//
//   - a Range whose start lies within [0, avail) → 206; when the requested
//     end reaches beyond avail (e.g. the open-ended bytes=0- that Chrome
//     sends first), end is clamped to avail-1 per RFC 9110, answering a
//     partial response with exact Content-Range bytes start-(avail-1)/total.
//     Every returned byte is real verified data, never fabricated; bytes
//     beyond avail are never served.
//   - a Range starting at or beyond avail → long-polled (waitForPrefix):
//     held until the verified prefix strictly passes the requested start,
//     then answered 206 with the same clamping. Only the 30 s hold timeout
//     yields a 503 + Retry-After (buffering). The hold is what keeps
//     Chrome's ~25 ms follow-up bytes=avail- request from failing the
//     element with error code 4 (measured 2026-08-05; the browser does
//     not auto-retry a 503).
//   - no Range while avail < total → 503 (a partial 200 is never served)
//   - HEAD mirrors GET status/headers without a body
//
// avail is the hash-verified prefix (never the file's allocated size).
func (s *Server) serveStreamingPrefix(w http.ResponseWriter, r *http.Request, src interface {
	ReadAt(p []byte, off int64) (int, error)
	Available() int64
}, avail, total int64) {
	origin, ok := s.originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Add("Vary", "Origin")
	w.Header().Set("Cache-Control", "no-store")
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", mediaContentType)
	}
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET, HEAD, OPTIONS")
		return
	}

	rangeHeader := r.Header.Get("Range")
	if rangeHeader == "" {
		if avail >= total {
			// Complete file: serve the full body (the growing 200 path).
			s.serveRange(w, r, 0, total, total, src)
			return
		}
		// Partial 200 would fabricate a full body — never.
		s.writeBuffering(w, r, avail, total)
		return
	}

	start, end, ok := parseSingleRange(rangeHeader, total)
	if !ok {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", total))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	if start >= total {
		// Permanently unsatisfiable — the one final answer, matching the
		// growing contract. Waiting cannot help: avail never exceeds total.
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", total))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	if start >= avail {
		// The verified prefix has not passed the requested start yet.
		// Chrome 151 first requests bytes=0- (answered 206 clamped above)
		// and then, ~25 ms later, bytes=avail-; a 503 to that follow-up
		// fails the element with error code 4 and it does not auto-retry.
		// Hold until the prefix catches up, then answer 206 — only the
		// hold timeout produces a 503 (buffering).
		if !s.waitForPrefix(w, r, src, start, total, &avail) {
			return // 503 written by the timeout, or client cancelled
		}
	}
	if end >= avail {
		// RFC 9110: a request whose range end lies beyond the verified
		// prefix (Chrome 151 sends open-ended bytes=0- first, and a 503
		// makes the element fail with error code 4 before playback can
		// start) is answered 206 with end clamped to avail-1. Bytes beyond
		// avail are never served, so the no-fabrication safety contract is
		// unchanged.
		end = avail - 1
	}
	s.serveRange(w, r, start, end, total, src)
}

// serveRange serves [start, end] of the active growing source (verified
// prefix / complete file) as a 206 with exact Content-Range bytes.
func (s *Server) serveRange(w http.ResponseWriter, r *http.Request, start, end, total int64, src interface {
	ReadAt(p []byte, off int64) (int, error)
}) {
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, total))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	w.WriteHeader(http.StatusPartialContent)
	buf := make([]byte, 32*1024)
	pos := start
	for pos <= end {
		n := len(buf)
		if remain := end - pos + 1; remain < int64(n) {
			n = int(remain)
		}
		rn, err := src.ReadAt(buf[:n], pos)
		if rn > 0 {
			if _, werr := w.Write(buf[:rn]); werr != nil {
				return
			}
		}
		pos += int64(rn)
		if err != nil || rn == 0 {
			return
		}
	}
}

const mediaContentType = "video/mp4"
