package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

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

	// Shapes: /{id}, /{id}/cancel, /{id}/files, /{id}/select.
	var id string
	var op string
	switch {
	case strings.HasSuffix(rest, "/cancel"):
		id, op = strings.TrimSuffix(rest, "/cancel"), "cancel"
	case strings.HasSuffix(rest, "/files"):
		id, op = strings.TrimSuffix(rest, "/files"), "files"
	case strings.HasSuffix(rest, "/select"):
		id, op = strings.TrimSuffix(rest, "/select"), "select"
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
	}
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
	snap, src := s.torrents.ActiveMedia()
	switch snap.State {
	case torrent.StateQueued, torrent.StateDownloading, torrent.StateBuffering:
		return statusBody{
			State:      statusBuffering,
			Available:  snap.Media.Available,
			Total:      snap.Media.Total,
			RetryAfter: bufferingRetryAfterSec,
		}, true
	case torrent.StateStreaming:
		// The streaming serve path handles 503/206 correctly per request,
		// but the bridge needs a "playable" signal to assign the URL.
		if src != nil && snap.Media.Available > 0 {
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

// serveTorrentMedia serves the active torrent job's selected media:
//
//	complete → the growing serv (available == total)
//	playable / streaming → the verified-prefix streaming serv (206 for
//	                        ranges within the VERIFIED prefix only; 503 for
//	                        anything beyond; never fabricated bytes)
//	downloading / buffering (metadata listed, awaiting selection) → 503
//	error → generic 404
func (s *Server) serveTorrentMedia(w http.ResponseWriter, r *http.Request) bool {
	if s.torrents == nil {
		return false
	}
	snap, src := s.torrents.ActiveMedia()
	// The selected file's extension governs the Content-Type (never a
	// hardcoded video/mp4): MKV → video/x-matroska, etc.
	mime := s.torrents.SelectedMediaType()
	if mime != "" {
		w.Header().Set("Content-Type", mime)
	}
	switch snap.State {
	case torrent.StateComplete:
		if src != nil {
			s.serveGrowingSource(src, w, r)
			return true
		}
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return true
	case torrent.StateStreaming:
		if src != nil {
			// Use the verified-prefix streaming serve: 206 for ranges
			// within the verified prefix, 503 for anything beyond.
			// The growing serv would fabricate a 200 body for
			// avail==total mid-stream which is unsafe here.
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Access-Control-Expose-Headers",
				"Content-Range, Accept-Ranges, Content-Length, Retry-After")
			s.serveStreamingPrefix(w, r, src, snap.Media.Available, snap.Media.Total)
			return true
		}
		s.writeBuffering(w, r, snap.Media.Available, snap.Media.Total)
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
