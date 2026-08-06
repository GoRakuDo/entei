package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
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
			writeJSON(w, http.StatusNotFound, errorBody("subtitle not available"))
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

// setTorrentMediaHeaders sets the common response headers for media
// streaming endpoints (torrent streaming, torrent complete). Called once
// per response to avoid header-setting duplication across code paths.
func setTorrentMediaHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Access-Control-Expose-Headers",
		"Content-Range, Accept-Ranges, Content-Length, Retry-After")
}

// serveTorrentFullRange handles Chrome's initial playback request
// (bytes=0-, i.e. start==0 && end==total-1) by delegating to
// http.ServeContent with a long-lived Reader — the same approach that
// powered rc.38's instant playback. ServeContent's io.CopyN blocks on
// the Reader for each chunk, which keeps the anacrolix piece scheduler's
// demand active (the Reader's read position drives "Now" priority forward
// piece by piece). Chrome may cancel this response to read Cues at the
// file tail — that is normal and harmless: the Reader's piece demand
// during its lifetime already advanced the prefix, and the tail-window
// pieces are pre-elevated to High.
func (s *Server) serveTorrentFullRange(w http.ResponseWriter, r *http.Request, total int64) {
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Length", strconv.FormatInt(total, 10))
		w.WriteHeader(http.StatusOK)
		return
	}
	fileName := s.torrents.SelectedFileName()
	if fileName == "" {
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return
	}
	reader, err := s.torrents.NewHTTPMediaReader(r.Context())
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return
	}
	defer reader.Close()
	fw := &flushResponseWriter{ResponseWriter: w}
	http.ServeContent(fw, r, fileName, time.Time{}, reader)
}

// ED-2H: streaming uses a custom Range response (same contract as
// serveGrowingSource) to avoid Chrome's MKV seek loop. The anacrolix
// Reader is used as an io.ReadSeeker: Seek to the requested start, then
// Read the clamped length. Availability is checked before serving to
// prevent serving beyond the verified prefix.
//
// StateComplete uses os.File + http.ServeContent (the fixture approach):
// all data is on disk, Seek works trivially, and Chrome's Cues/seek
// requests are served directly from the file without Reader overhead.
//
// Both paths replace the previous http.ServeContent + anacrolix Reader
// approach which triggered Chrome's MKV seek loop (bytes=0- → ERR_ABORTED
// → bytes=0- → ... → seeking=true, readyState=1, GPU 100%).
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
	case torrent.StateStreaming:
		s.serveTorrentStreaming(w, r, snap)
		return true
	case torrent.StateComplete:
		s.serveTorrentComplete(w, r, snap)
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

// serveTorrentStreaming serves a streaming torrent (partial download) with
// the same availability-aware Range contract as serveGrowingSource:
//   - Range start >= avail → long-poll until prefix catches up, then 206
//   - Range end > avail → clamp to avail-1 (RFC 9110)
//   - start >= total → 416
//   - no Range + avail < total → 503 buffering
//   - no Range + avail == total → 200 full body
//
// The anacrolix Reader is used as an io.ReadSeeker: Seek(start) then
// io.CopyN(w, reader, length). Each Write is flushed immediately via
// flushResponseWriter so data reaches the network without kernel TCP
// buffering delays.
func (s *Server) serveTorrentStreaming(w http.ResponseWriter, r *http.Request, snap torrent.Snapshot) {
	total := snap.Media.Total

	// A zero or negative total is invalid for Range serving — reject
	// immediately rather than falling through to parseSingleRange.
	if total <= 0 {
		w.Header().Set("Content-Range", "bytes */0")
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}

	setTorrentMediaHeaders(w)

	start, end, hasRange := parseSingleRange(r.Header.Get("Range"), total)
	if hasRange {
		if start >= total {
			w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(total, 10))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}

		// Chrome's first request for initial playback is always bytes=0-
		// (the entire file as a single range).
		if start == 0 && end == total-1 {
			s.serveTorrentFullRange(w, r, total)
			return
		}

		// Seek request (start > 0) or partial range: use the custom Range
		// handler with availability clamping and long-polling.
		avail := snap.Media.Available
		if start >= avail {
			src := &torrentAvailSource{m: s.torrents}
			if !s.waitForPrefix(w, r, src, start, total, &avail) {
				return // 503 written by the timeout, or client cancelled
			}
		}
		if end >= avail {
			end = avail - 1 // RFC 9110: clamp to avail-1
		}
		length := end - start + 1
		w.Header().Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(total, 10))
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusPartialContent)
			return
		}
		reader, err := s.torrents.NewHTTPMediaReader(r.Context())
		if err != nil {
			writeJSON(w, http.StatusNotFound, errorBody("media not available"))
			return
		}
		defer reader.Close()
		if _, err := reader.Seek(start, io.SeekStart); err != nil {
			writeJSON(w, http.StatusRequestedRangeNotSatisfiable, errorBody("seek failed"))
			return
		}
		w.WriteHeader(http.StatusPartialContent)
		fw := &flushResponseWriter{ResponseWriter: w}
		_, _ = io.CopyN(fw, reader, length)
		return
	}

	// No Range header.
	avail := snap.Media.Available
	if avail < total {
		s.writeBuffering(w, r, avail, total)
		return
	}
	// All data available — serve the full body. Obtain the Reader and
	// Seek first so that errors can be surfaced as 404/500 before any
	// status code is written.
	reader, err := s.torrents.NewHTTPMediaReader(r.Context())
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return
	}
	defer reader.Close()
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("seek failed"))
		return
	}
	w.Header().Set("Content-Length", strconv.FormatInt(total, 10))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	fw := &flushResponseWriter{ResponseWriter: w}
	_, _ = io.CopyN(fw, reader, total)
}

// serveTorrentComplete serves a fully downloaded torrent from the on-disk
// file via http.ServeContent. When the disk file is available, this gives
// Chrome a regular file seek path (no anacrolix Reader, no piece
// blocking). When the disk path is unavailable (memory storage), falls
// back to the anacrolix Reader.
func (s *Server) serveTorrentComplete(w http.ResponseWriter, r *http.Request, snap torrent.Snapshot) {
	total := snap.Media.Total

	if r.Method == http.MethodHead {
		setTorrentMediaHeaders(w)
		w.Header().Set("Content-Length", strconv.FormatInt(total, 10))
		w.WriteHeader(http.StatusOK)
		return
	}

	// Try disk file first (os.File + http.ServeContent = fixture approach).
	diskPath, diskErr := s.torrents.SelectedDiskPath()
	if diskErr == nil {
		file, err := os.Open(diskPath)
		if err == nil {
			defer file.Close()
			setTorrentMediaHeaders(w)
			fw := &flushResponseWriter{ResponseWriter: w}
			http.ServeContent(fw, r, filepath.Base(diskPath), time.Time{}, file)
			return
		}
	}

	// Fallback: anacrolix Reader (memory storage or disk unavailable).
	fileName := s.torrents.SelectedFileName()
	if fileName == "" {
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return
	}
	reader, err := s.torrents.NewHTTPMediaReader(r.Context())
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("media not available"))
		return
	}
	defer reader.Close()
	setTorrentMediaHeaders(w)
	fw := &flushResponseWriter{ResponseWriter: w}
	http.ServeContent(fw, r, fileName, time.Time{}, reader)
}

// torrentAvailSource adapts the torrent Manager's availability to the
// interface expected by waitForPrefix (Available() int64). This lets the
// streaming Range handler use the same long-poll logic as the growing
// source.
type torrentAvailSource struct {
	m *torrent.Manager
}

func (t *torrentAvailSource) Available() int64 { return t.m.AvailablePrefix() }
