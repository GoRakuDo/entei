package api

import (
	"fmt"
	"net/http"
	"strconv"
)

// serveStreamingPrefix serves the selected torrent file's VERIFIED
// contiguous prefix with truthful byte semantics:
//
//   - a Range (or open-ended bytes=0-) whose needed bytes are all within
//     [0, avail) → 206 with Content-Range 0-(end-1)/total; every returned
//     byte is real verified data, never fabricated
//   - a Range starting beyond avail → 503 + Retry-After (the browser does
//     not auto-retry; the bridge re-applies an explicit load once the
//     prefix catches up)
//   - no Range while avail < total → 503 (a partial 200 is never served)
//   - HEAD mirrors GET status/headers without a body
//
// avail is the hash-verified prefix (never the file's allocated size).
func (s *Server) serveStreamingPrefix(w http.ResponseWriter, r *http.Request, src interface {
	ReadAt(p []byte, off int64) (int, error)
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

	if avail <= 0 {
		s.writeBuffering(w, r, 0, total)
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
	if start >= avail {
		s.writeBuffering(w, r, avail, total)
		return
	}
	if end >= avail {
		// The needed bytes extend beyond the verified prefix: 503 (the
		// bridge retries with an explicit load once the prefix catches up).
		s.writeBuffering(w, r, avail, total)
		return
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
