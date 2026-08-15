package api

import (
	"io"
	"net/http"
	"os"
	"os/exec"

	"eizoudendenshi/internal/media"
)

// SampleRatePCM is the fixed output rate of /v1/media/pcm (16 kHz mono).
const SampleRatePCM = 16000

// handleMediaPcm converts the completed growing media to 16 kHz mono
// f32 LE PCM via the pinned ffmpeg helper (sub-to-audio subtitle sync).
//
// Contract (same availability gate as /v1/media/fixture):
//   - available < total  → 503 + bufferingBody (DL not finished; retry later)
//   - available == total → ffmpeg decode of the full media to PCM
//   - no media source (fixture GrowSource AND Magnet session) or Ffmpeg
//     unset → 404 (endpoint honestly disabled)
//
// Response: application/octet-stream (f32 LE, 16 kHz, mono) with an
// X-Sample-Rate header. ffmpeg stderr and paths are never logged or
// echoed (redaction contract).
func (s *Server) handleMediaPcm(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		// PCM endpoint supports GET only (no HEAD); preflight advertises
		// exactly that to stay honest.
		origin, ok := s.originAllowed(r)
		if !ok {
			writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET, OPTIONS")
		return
	}
	// Same exact-Origin + capability-token gates as /v1/media/fixture.
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
	w.Header().Set("Cache-Control", "no-store")

	if s.ffmpegPath == "" {
		http.NotFound(w, r)
		return
	}
	src, closeSrc, ok := s.mediaSourceForPCM()
	if !ok {
		http.NotFound(w, r)
		return
	}
	defer closeSrc()

	avail := src.Available()
	total := src.Total()
	if avail < total {
		s.writeBuffering(w, r, avail, total)
		return
	}

	// Materialize the completed media to a temp file (the growing source
	// may back onto a ReaderAt that ffmpeg cannot open directly), then
	// run ffmpeg reading the temp file. The temp file is removed on exit.
	tmp, err := os.CreateTemp("", "eizouden-pcm-*.media")
	if err != nil {
		http.Error(w, "media conversion unavailable", http.StatusInternalServerError)
		return
	}
	// LIFO order: Close() runs before Remove() (remove of an open handle
	// fails on Windows).
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	buf := make([]byte, 64*1024)
	remaining := total
	for remaining > 0 {
		n, err := src.ReadAt(buf, total-remaining)
		if n > 0 {
			if _, werr := tmp.Write(buf[:n]); werr != nil {
				http.Error(w, "media conversion unavailable", http.StatusInternalServerError)
				return
			}
			remaining -= int64(n)
		}
		if err != nil {
			if err == io.EOF && remaining == 0 {
				break // clean end-of-file at the exact boundary
			}
			// A real read error must not be masked as a short media: return it.
			http.Error(w, "media conversion unavailable", http.StatusInternalServerError)
			return
		}
		if n == 0 {
			// ReaderAt returned no progress without an error; fail closed.
			http.Error(w, "media conversion unavailable", http.StatusInternalServerError)
			return
		}
	}

	// ffmpeg -i <file> -f f32le -ar 16000 -ac 1 -  → PCM on stdout.
	cmd := exec.Command(
		s.ffmpegPath, "-nostdin", "-v", "error", "-i", tmp.Name(),
		"-f", "f32le", "-ar", "16000", "-ac", "1", "-",
	)
	// Stream ffmpeg stdout straight into the response instead of buffering
	// the whole PCM in memory (a 10 min 44.1 kHz clip ≈ 100+ MB).
	// Header-before-run: an ffmpeg failure after headers were written
	// leaves a truncated 200 (partial content already sent) — accepted
	// trade-off, noted here.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Sample-Rate", "16000")
	w.WriteHeader(http.StatusOK)
	cmd.Stdout = w
	if err := cmd.Run(); err != nil {
		// stderr is intentionally swallowed: paths / helper details must
		// never reach the client or logs (redaction contract).
		return
	}
}

// mediaSourceForPCM resolves the media source for /v1/media/pcm: the fixture
// growing source when configured, otherwise the active Magnet job's selected
// media (sub-to-audio). Returns ok=false when neither is available. The
// returned closer must be deferred by the caller to release any backing
// reader.
func (s *Server) mediaSourceForPCM() (media.GrowingSource, func(), bool) {
	if s.growSource != nil {
		return s.growSource, func() {}, true
	}
	if s.torrents != nil {
		src, err := s.torrents.SelectedMediaSource()
		if err == nil {
			return src, func() { _ = src.Close() }, true
		}
	}
	return nil, func() {}, false
}
