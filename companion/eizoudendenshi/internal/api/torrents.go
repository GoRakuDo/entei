package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"eizoudendenshi/internal/torrent"
)

// Torrent endpoints (ED-2G): localhost companion-only torrent job
// foundation. All routes share the exact Origin + capability gates of the
// media endpoints and are registered only when a torrent manager is
// configured (Config.Torrents != nil).
//
//	POST /v1/source/torrents             — create (body {"magnet": "…"})
//	GET  /v1/source/torrents/{id}        — read redacted state
//	POST /v1/source/torrents/{id}/cancel — cancel + free the session
//	GET  /v1/source/torrents/{id}/files  — sanitized file listing (after download)
//	POST /v1/source/torrents/{id}/select — one video + optional subtitle
//
// Responses are metadata-only: opaque job ids, sanitized file metadata, and
// generic errors — never the magnet, absolute paths, trackers, or engine
// internals. Up to 2 concurrent torrent sessions (oldest-first eviction on
// 3rd create). YouTube active blocks torrent create and vice versa
// (cross-kind mix → 409). YouTube remains one-session.

// torrentResponseBody is the redacted torrent job view.
type torrentResponseBody struct {
	ID                string       `json:"id"`
	State             string       `json:"state"`
	Error             string       `json:"error,omitempty"`
	ErrorCode         string       `json:"errorCode,omitempty"`
	HasEligibleVideo  bool         `json:"hasEligibleVideo"`
	SelectedVideoFile string       `json:"selectedVideoFile,omitempty"`
	Media             jobMediaBody `json:"media"`
}

func torrentSnapshotToBody(s torrent.Snapshot) torrentResponseBody {
	return torrentResponseBody{
		ID:                s.ID,
		State:             string(s.State),
		Error:             s.Error,
		ErrorCode:         s.ErrorCode,
		HasEligibleVideo:  s.HasEligibleVideo,
		SelectedVideoFile: s.SelectedVideoFile,
		Media: jobMediaBody{
			Available: s.Media.Available,
			Total:     s.Media.Total,
			HeadReady: s.Media.HeadReady,
		},
	}
}

func (s *Server) handleTorrentCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handleTorrentPreflight(w, r)
		return
	}
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST, OPTIONS")
		return
	}
	if !s.jobGates(w, r) {
		return
	}
	// YouTube active blocks torrent create (cross-kind mix forbidden).
	if s.jobs != nil && s.jobs.Current() != nil {
		writeJSON(w, http.StatusConflict, errorBody("a YouTube job is already active"))
		return
	}
	var req struct {
		Magnet string `json:"magnet"`
	}
	body := http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid JSON body"))
		return
	}
	snap, err := s.torrents.Start(req.Magnet)
	if err != nil {
		// Generic rejection; the magnet is never echoed.
		writeJSON(w, http.StatusBadRequest, errorBody("invalid magnet URI"))
		return
	}
	writeJSON(w, http.StatusCreated, torrentSnapshotToBody(snap))
}

func (s *Server) handleTorrentByID(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handleTorrentPreflight(w, r)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/v1/source/torrents/")
	if rest == "" || strings.Contains(rest, "//") {
		writeJSON(w, http.StatusNotFound, errorBody("not found"))
		return
	}
	if !s.jobGates(w, r) {
		return
	}

	// Shapes: /{id}, /{id}/cancel, /{id}/files, /{id}/select, /{id}/subtitle.
	var id string
	var op string
	switch {
	case strings.HasSuffix(rest, "/cancel"):
		id, op = strings.TrimSuffix(rest, "/cancel"), "cancel"
	case strings.HasSuffix(rest, "/files"):
		id, op = strings.TrimSuffix(rest, "/files"), "files"
	case strings.HasSuffix(rest, "/select"):
		id, op = strings.TrimSuffix(rest, "/select"), "select"
	case strings.HasSuffix(rest, "/subtitle"):
		id, op = strings.TrimSuffix(rest, "/subtitle"), "subtitle"
	default:
		id, op = rest, "read"
	}

	switch op {
	case "read":
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, "GET, OPTIONS")
			return
		}
		snap := s.torrents.Get(id)
		if snap == nil {
			writeJSON(w, http.StatusNotFound, errorBody("job not found"))
			return
		}
		writeJSON(w, http.StatusOK, torrentSnapshotToBody(*snap))
	case "cancel":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, "POST, OPTIONS")
			return
		}
		snap, err := s.torrents.Cancel(id)
		if err != nil {
			writeJSON(w, http.StatusNotFound, errorBody("job not found"))
			return
		}
		writeJSON(w, http.StatusOK, torrentSnapshotToBody(snap))
	case "files":
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, "GET, OPTIONS")
			return
		}
		files, err := s.torrents.Files(id)
		if err != nil {
			if errors.Is(err, torrent.ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errorBody("job not found"))
				return
			}
			writeJSON(w, http.StatusConflict, errorBody("file listing not ready"))
			return
		}
		// Synthesize folder entries and filter by the requested parentPath.
		// parentPath is frontend-only navigation — never persisted or used
		// for file selection. Files retain their original "f0"/"f1" IDs;
		// folder entries get deterministic "d"-prefixed IDs.
		parentPath := r.URL.Query().Get("parentPath")
		entries, err := torrent.SynthesizeEntries(files, parentPath)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid folder path"))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"files": entries})
	case "select":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, "POST, OPTIONS")
			return
		}
		var req struct {
			VideoFileID    string `json:"videoFileId"`
			SubtitleFileID string `json:"subtitleFileId"`
		}
		body := http.MaxBytesReader(w, r.Body, 4096)
		if err := json.NewDecoder(body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid JSON body"))
			return
		}
		snap, err := s.torrents.Select(id, req.VideoFileID, req.SubtitleFileID)
		if err != nil {
			switch {
			case errors.Is(err, torrent.ErrNotFound):
				writeJSON(w, http.StatusNotFound, errorBody("job not found"))
			case errors.Is(err, torrent.ErrNotListed):
				writeJSON(w, http.StatusConflict, errorBody("file listing not ready"))
			default:
				writeJSON(w, http.StatusBadRequest, errorBody("invalid selection"))
			}
			return
		}
		writeJSON(w, http.StatusOK, torrentSnapshotToBody(snap))
	case "subtitle":
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, "GET, OPTIONS")
			return
		}
		content, err := s.torrents.SelectedSubtitleContent(r.Context())
		if err != nil {
			switch {
			case errors.Is(err, torrent.ErrNoEmbeddedSubtitleTrack):
				// Permanent: the selected video carries no embedded text
				// subtitle track — nothing more to wait for, so the web
				// layer shows a toast instead of polling again.
				writeJSON(w, http.StatusNotFound, errorBody("no_embedded_subtitle_track"))
			case errors.Is(err, torrent.ErrSubtitleCuesPending):
				// Transient: the DL'd prefix holds no subtitle cue yet.
				// 503 + Retry-After (Growing Media buffering contract) so
				// the web layer waits for more data.
				w.Header().Set("Retry-After", bufferingRetryAfter)
				writeJSON(w, http.StatusServiceUnavailable, map[string]any{
					"error":      "cues_pending",
					"retryAfter": 1,
				})
			default:
				writeJSON(w, http.StatusNotFound, errorBody("subtitle not available"))
			}
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(content))
	}
}

// flushResponseWriter wraps an http.ResponseWriter and flushes after
// every Write. This ensures that data from the anacrolix Reader reaches
// the network immediately — critical for streaming after a seek where
// the Reader blocks between piece completions. Without flushing,
// io.Copy inside http.ServeContent may buffer data in the kernel TCP
// stack, causing the video element to stall (readyState=1, networkState=IDLE)
// even though the server has data available.
type flushResponseWriter struct {
	http.ResponseWriter
}

func (fw *flushResponseWriter) Write(p []byte) (int, error) {
	n, err := fw.ResponseWriter.Write(p)
	if f, ok := fw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
	return n, err
}

func (s *Server) handleTorrentPreflight(w http.ResponseWriter, r *http.Request) {
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

// activeTorrentStatus maps the current torrent job onto the status
// contract. ok=false means no torrent job and no recent eviction.
func (s *Server) activeTorrentStatus() (statusBody, bool) {
	if s.torrents == nil {
		return statusBody{}, false
	}
	snap, _ := s.torrents.ActiveMedia()
	switch snap.State {
	case torrent.StateQueued, torrent.StateDownloading, torrent.StateBuffering:
		return statusBody{
			State:      statusBuffering,
			Available:  snap.Media.Available,
			Total:      snap.Media.Total,
			RetryAfter: bufferingRetryAfterSec,
		}, true
	case torrent.StateStreaming:
		// The streaming serve path uses custom Range responses
		// (serveGrowingSource contract); the bridge needs a
		// "playable" signal to assign the URL.
		if snap.Media.Available > 0 {
			return statusBody{
				State:     statusPlayable,
				Available: snap.Media.Available,
				Total:     snap.Media.Total,
			}, true
		}
		return statusBody{
			State:      statusBuffering,
			Available:  snap.Media.Available,
			Total:      snap.Media.Total,
			RetryAfter: bufferingRetryAfterSec,
		}, true
	case torrent.StateComplete:
		return statusBody{
			State:     statusComplete,
			Available: snap.Media.Total,
			Total:     snap.Media.Total,
		}, true
	case torrent.StateError:
		return statusBody{
			State:     statusError,
			ErrorCode: snap.ErrorCode,
		}, true
	default:
		// No active session (StateCancelled or empty). Eviction info is
		// carried by the job status endpoint (/v1/source/torrents/{id}).
		return statusBody{}, false
	}
}

// setTorrentMediaHeaders sets the common response headers for torrent
// media serving (streaming or complete). Called once per response to
// avoid header-setting duplication across code paths.
func setTorrentMediaHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Access-Control-Expose-Headers",
		"Content-Range, Accept-Ranges, Content-Length, Retry-After")
}

// serveTorrentMedia serves torrent media (streaming or complete) via
// http.ServeContent + anacrolix Reader + modtime (htorrent/go-peerflix
// pattern). ServeContent handles Range, If-Range, HEAD, and seek
// internally — no custom Range logic needed. The Reader blocks until
// data is available (piece completion), keeping the anacrolix piece
// scheduler's demand active.
func (s *Server) serveTorrentMedia(w http.ResponseWriter, r *http.Request) bool {
	if s.torrents == nil {
		return false
	}
	snap, _ := s.torrents.ActiveMedia()
	// The selected file's extension governs the Content-Type (never a
	// hardcoded video/mp4): MKV → video/x-matroska, etc.
	mime := s.torrents.SelectedMediaType()
	if mime != "" {
		w.Header().Set("Content-Type", mime)
	}
	switch snap.State {
	case torrent.StateStreaming, torrent.StateComplete:
		s.serveTorrentContent(w, r)
		return true
	case torrent.StateDownloading, torrent.StateBuffering:
		s.writeBuffering(w, r, snap.Media.Available, snap.Media.Total)
		return true
	case torrent.StateError, torrent.StateCancelled:
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return true
	default:
		return false
	}
}

// serveTorrentContent serves a torrent file via http.ServeContent with
// anacrolix Reader and torrent CreationDate as modtime. This is the
// htorrent/go-peerflix pattern (reference: htorrent/pkg/server/gateway.go:328,
// go-peerflix/client.go:295). ServeContent handles Range requests, HEAD,
// If-Range, and seek internally. The Reader blocks until data is available
// (piece completion), driving the anacrolix piece scheduler's demand.
//
// On Range requests, the seek position is passed to AnchorSeek (tiramisu
// pattern: cache.go:426-448) so the piece at the seek location is elevated
// to PiecePriorityNow, preventing the Chrome seek loop (GPU 100%).
func (s *Server) serveTorrentContent(w http.ResponseWriter, r *http.Request) {
	setTorrentMediaHeaders(w)
	fileName := s.torrents.SelectedFileName()
	if fileName == "" {
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return
	}
	// Anchor the seek position: elevate the piece at the Range start to
	// PiecePriorityNow so the data is fetched immediately (tiramisu pattern).
	if rangeHeader := r.Header.Get("Range"); rangeHeader != "" {
		if start, _, ok := parseSingleRange(rangeHeader, 0); ok && start > 0 {
			s.torrents.AnchorSeek(start)
		}
	}
	reader, err := s.torrents.NewHTTPMediaReader(r.Context())
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return
	}
	defer torrent.SafeCloseReader(reader)
	fw := &flushResponseWriter{ResponseWriter: w}
	modtime := time.Unix(s.torrents.CreationDate(), 0)
	http.ServeContent(fw, r, fileName, modtime, reader)
}
