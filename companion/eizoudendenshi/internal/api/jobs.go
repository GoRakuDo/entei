package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"eizoudendenshi/internal/job"
	"eizoudendenshi/internal/media"
)

// Job endpoints (ED-2F): localhost companion-only YouTube source job
// foundation. All routes share the exact Origin + capability gates of the
// media endpoints and are registered only when a job manager is configured
// (Config.Jobs != nil).
//
//	POST   /v1/source/jobs            — create a job (body: {"url": "…"})
//	GET    /v1/source/jobs/{id}       — read a job's redacted state
//	POST   /v1/source/jobs/{id}/cancel — cancel the job and free the session
//	GET    /v1/source/jobs/{id}/subtitle — subtitle text content (VTT)
//
// Responses are metadata-only: they never contain the URL, local paths, the
// helper command line, helper output, or any credential. The URL is
// redacted from public responses and logs.

// jobMediaBody is the metadata-only media view in job responses.
type jobMediaBody struct {
	Available int64 `json:"available"`
	Total     int64 `json:"total"`
	HeadReady bool  `json:"headReady"`
}

// jobResponseBody is the redacted job view returned to callers.
type jobResponseBody struct {
	ID      string       `json:"id"`
	State   string       `json:"state"`
	Mode    string       `json:"mode"`
	Quality int          `json:"quality,omitempty"` // selected format height (0 = unknown)
	Title   string       `json:"title,omitempty"`   // YouTube video title (display name)
	Error   string       `json:"error,omitempty"`
	Media   jobMediaBody `json:"media"`
}

func snapshotToJobBody(s job.Snapshot) jobResponseBody {
	return jobResponseBody{
		ID:      s.ID,
		State:   string(s.State),
		Mode:    string(s.Mode),
		Quality: s.Quality,
		Title:   s.Title,
		Error:   s.Error,
		Media: jobMediaBody{
			Available: s.Media.Available,
			Total:     s.Media.Total,
			HeadReady: s.Media.HeadReady,
		},
	}
}

func (s *Server) handleJobCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handleJobPreflight(w, r)
		return
	}
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST, OPTIONS")
		return
	}
	if !s.jobGates(w, r) {
		return
	}
	var req struct {
		URL  string `json:"url"`
		Mode string `json:"mode"`
	}
	body := http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid JSON body"))
		return
	}
	var mode job.Mode
	switch req.Mode {
	case "", "speed":
		// Empty defaults to speed (2026-08-08: unified with the web
		// DEFAULT_MODE — instant-playback first). Explicit "speed" is the
		// same path.
		mode = job.ModeSpeed
	case "quality":
		mode = job.ModeQuality
	default:
		writeJSON(w, http.StatusBadRequest, errorBody("invalid mode"))
		return
	}
	// One active YouTube session (but torrents can have up to 2).
	if s.jobs != nil && s.jobs.Current() != nil {
		writeJSON(w, http.StatusConflict, errorBody("a YouTube job is already active"))
		return
	}
	// Torrents active blocks YouTube create (cross-kind mix forbidden).
	if s.torrents != nil && s.torrents.ActiveCount() > 0 {
		writeJSON(w, http.StatusConflict, errorBody("a torrent job is already active"))
		return
	}
	snap, err := s.jobs.Start(req.URL, mode)
	if err != nil {
		if errors.Is(err, job.ErrConflict) {
			writeJSON(w, http.StatusConflict, errorBody("a job is already active"))
			return
		}
		// Validation failure and everything else: generic, and the URL is
		// never echoed.
		writeJSON(w, http.StatusBadRequest, errorBody("invalid URL"))
		return
	}
	writeJSON(w, http.StatusCreated, snapshotToJobBody(snap))
}

func (s *Server) handleJobByID(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handleJobPreflight(w, r)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/v1/source/jobs/")
	if rest == "" || strings.Contains(rest, "//") {
		writeJSON(w, http.StatusNotFound, errorBody("not found"))
		return
	}
	if !s.jobGates(w, r) {
		return
	}

	// Shape: "/v1/source/jobs/{id}" or "/v1/source/jobs/{id}/cancel" or "/v1/source/jobs/{id}/subtitle".
	if strings.HasSuffix(rest, "/subtitle") {
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, "GET, OPTIONS")
			return
		}
		id := strings.TrimSuffix(rest, "/subtitle")
		snap := s.jobs.Get(id)
		if snap == nil {
			writeJSON(w, http.StatusNotFound, errorBody("job not found"))
			return
		}
		content, err := s.jobs.SelectedSubtitleContent(r.Context())
		if err != nil {
			writeJSON(w, http.StatusNotFound, errorBody("subtitle not available"))
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(content))
		return
	}
	if strings.HasSuffix(rest, "/cancel") {
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, "POST, OPTIONS")
			return
		}
		id := strings.TrimSuffix(rest, "/cancel")
		snap, err := s.jobs.Cancel(id)
		if err != nil {
			writeJSON(w, http.StatusNotFound, errorBody("job not found"))
			return
		}
		writeJSON(w, http.StatusOK, snapshotToJobBody(snap))
		return
	}
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET, OPTIONS")
		return
	}
	snap := s.jobs.Get(rest)
	if snap == nil {
		writeJSON(w, http.StatusNotFound, errorBody("job not found"))
		return
	}
	writeJSON(w, http.StatusOK, snapshotToJobBody(*snap))
}

// jobGates applies the exact-Origin + capability-token gates shared with
// the media endpoints. It writes the error response itself and returns
// false when the request must stop.
func (s *Server) jobGates(w http.ResponseWriter, r *http.Request) bool {
	origin, ok := s.originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return false
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Add("Vary", "Origin")
	if !s.tokenValid(r) {
		writeJSON(w, http.StatusUnauthorized, errorBody("unauthorized"))
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	return true
}

func (s *Server) handleJobPreflight(w http.ResponseWriter, r *http.Request) {
	origin, ok := s.originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.Header().Add("Vary", "Origin")
	w.WriteHeader(http.StatusNoContent)
}

// activeJobStatus maps the current job onto the existing status states when
// a job session is active. ok=false means no job is current (the caller
// falls back to the configured fixture/grow source).
func (s *Server) activeJobStatus() (statusBody, bool) {
	snap, _ := s.jobs.ActiveMedia()
	switch snap.State {
	case job.StateQueued, job.StateDownloading, job.StateBuffering:
		// Speed mode is instantly streamable once the .part file exists:
		// report "playable" so the bridge hands the URL to the element.
		if snap.Mode == job.ModeSpeed && snap.Media.Available > 0 {
			return statusBody{
				State:     statusPlayable,
				Available: snap.Media.Available,
				Total:     snap.Media.Total,
				Title:     snap.Title,
			}, true
		}
		return statusBody{
			State:      statusBuffering,
			Available:  snap.Media.Available,
			Total:      snap.Media.Total,
			RetryAfter: bufferingRetryAfterSec,
			Title:      snap.Title,
		}, true
	case job.StateComplete:
		return statusBody{
			State:     statusComplete,
			Available: snap.Media.Total,
			Total:     snap.Media.Total,
			Title:     snap.Title,
		}, true
	case job.StateError:
		return statusBody{State: statusError}, true
	default:
		// cancelled (or no job): no active source; caller falls through.
		return statusBody{}, false
	}
}

// serveJobMedia serves the active job's media with the growing-media
// contract when the job is the current session. Returns true when the
// request was fully handled. Mapping:
//
//	complete     → the growing serv (available == total → 200/206)
//	downloading/ → 503 buffering with current bytes / total (0 until known)
//	buffering      … EXCEPT speed mode, where the growing .part source is
//	                served (206 clamped to available; instant playback)
//	error        → generic 404 (no media)
//
// A job in any state takes precedence over the configured fixture/grow
// source: it IS the active session.
func (s *Server) serveJobMedia(w http.ResponseWriter, r *http.Request) bool {
	snap, src := s.jobs.ActiveMedia()
	switch snap.State {
	case job.StateComplete:
		if src != nil {
			s.serveGrowingSource(src, w, r)
			return true
		}
		// Complete but the source failed to materialize: honest generic 404.
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return true
	case job.StateDownloading, job.StateBuffering:
		// Speed mode: the .part file is servable while downloading (the
		// GrowingSource reports the current available prefix; Range reads
		// are clamped to it — chromes requests bytes=0- and streams).
		if snap.Mode == job.ModeSpeed && src != nil {
			s.serveGrowingSource(src, w, r)
			return true
		}
		s.writeBuffering(w, r, snap.Media.Available, snap.Media.Total)
		return true
	case job.StateError, job.StateCancelled:
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return true
	default:
		return false // no active job: caller falls through to configured source
	}
}

// serveGrowingSource serves any growing source with the availability-aware
// Range contract. It is the parameterized body of serveGrowingMedia (which
// passes the configured grow source); the job media path passes the job's
// completed source.
//
// Contract (documented in companion/eizoudendenshi/README.md and
// docs/EIZOU_DENDENSHI.md):
//   - a Range whose start lies within [0, avail) → 206; when the requested
//     end reaches beyond avail (e.g. Chrome's open-ended bytes=0-), end is
//     clamped to avail-1 per RFC 9110 — an exact partial response, never a
//     byte beyond avail
//   - a Range starting at or beyond avail → long-polled (waitForPrefix):
//     held until the available prefix strictly passes the requested start,
//     then answered 206 with the same clamping; only the 30 s hold timeout
//     yields a 503 + Retry-After (buffering) — a 503 in the ~25 ms gap
//     between Chrome's bytes=0- and its bytes=avail- follow-up fails the
//     element with error code 4 (measured 2026-08-05)
//   - a Range starting at or beyond total → 416 ("bytes */total")
//   - no usable Range while avail < total → 503 (a partial 200 is never
//     served); with avail == total → 200 full body
//   - HEAD mirrors GET status/headers without a body
func (s *Server) serveGrowingSource(src media.GrowingSource, w http.ResponseWriter, r *http.Request) {
	// TEMPORARY diagnostic (2026-08-09): latency measurement for the
	// companion streaming path. Logs one line per fixture request with
	// the request start, the handler processing time (ms), and the Range
	// header, so the "avail=0 → complete wait" latency can be measured on
	// the device. Remove after the latency measurement is finished
	// (by 2026-08-31).
	reqStart := time.Now()
	defer func() {
		if s.log != nil {
			s.log.Infof("api", "[TEMPORARY] media fixture start=%s elapsed_ms=%d range=%s",
				reqStart.Format(time.RFC3339Nano), time.Since(reqStart).Milliseconds(), r.Header.Get("Range"))
		}
	}()
	total := src.Total()
	avail := src.Available()

	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "video/mp4")
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Access-Control-Expose-Headers",
		"Content-Range, Accept-Ranges, Content-Length, Retry-After")

	start, end, hasRange := parseSingleRange(r.Header.Get("Range"), total)
	if hasRange {
		if start >= total && media.TotalFixed(src) {
			// 416 only when the total is a determinate final boundary
			// (fixed-size sources; a .part source after its estimated
			// total was pinned). With an unpinned growing .part, "start
			// beyond the current total" merely means "not downloaded
			// yet" — those requests must fall through to the
			// availability long-poll below (and 503 on hold timeout),
			// never a permanent 416 that would fail the player.
			w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(total, 10))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		if start >= avail {
			// The available prefix has not passed the requested start.
			// Hold (long-poll) until it does — a 503 here fails Chrome's
			// media element with error code 4 (no auto-retry) during the
			// ~25 ms gap before its bytes=avail- follow-up. Only the hold
			// timeout yields the 503 buffering response.
			if !s.waitForPrefix(w, r, src, start, total, &avail) {
				return // 503 written by the timeout, or client cancelled
			}
		}
		if end >= avail {
			// RFC 9110: clamp to avail-1 (Chrome 151 sends open-ended
			// bytes=0- first; a 503 makes the element fail before playback
			// can start). Bytes beyond avail are never served.
			end = avail - 1
		}
		length := end - start + 1
		w.Header().Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(total, 10))
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
		w.WriteHeader(http.StatusPartialContent)
		if r.Method == http.MethodHead {
			return
		}
		_, _ = io.Copy(w, io.NewSectionReader(src, start, length))
		return
	}

	if avail < total {
		s.writeBuffering(w, r, avail, total)
		return
	}
	w.Header().Set("Content-Length", strconv.FormatInt(total, 10))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, io.NewSectionReader(src, 0, total))
}
