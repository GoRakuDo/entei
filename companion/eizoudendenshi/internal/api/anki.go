package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"eizoudendenshi/internal/anki"
)

// Anki Media routes (ED-3 / spec EIZOU_DENDENSHI_ANKIDROID_CONNECT.md,
// 2026-08-29):
//
//	POST /v1/anki/media   — body {"filename": "...", "data_base64": "..."}
//	                       → MediaWriter.Write → respond {"filename": "<stored>"}
//	                       64 MB hard cap on the request body.
//	POST /v1/anki/action  — body is the full AnkiConnect envelope
//	                       {"action": "...", "version": ..., "params": {...}}
//	                       → for "addNote" the params.note.audio / video /
//	                       picture arrays are rewritten so each entry's
//	                       "filename" is the deterministic content-hash
//	                       name of its decoded "data" (the bytes are
//	                       written via MediaWriter). The envelope is then
//	                       forwarded verbatim to AnkiconnectAndroid via
//	                       NoteProxy and the upstream result is returned
//	                       unchanged.
//	GET  /v1/anki/status  — non-sensitive readiness snapshot:
//	                       {"proxyConfigured": bool,
//	                        "mediaDirWritable": bool,
//	                        "mediaDir": "<path or empty>"}.
//	                       The media dir path is not sensitive (spec §9);
//	                       the AnkiconnectAndroid URL is also not sensitive.
//	                       Capability tokens are NEVER in responses or logs.
//
// All three routes share the exact Origin + capability-token gates of
// the media endpoints; CORS preflights advertise POST / GET / OPTIONS
// with Content-Type.
//
// Routes are registered ONLY when Config.Anki != nil (the companion
// command wires the bridge when --anki-proxy is non-empty). With no
// bridge configured the paths stay 404 — zero behavior change for
// existing callers (spec §2.1 / Phase plan).

// ankiMediaBody is the inbound shape for /v1/anki/media.
//   - filename: optional. Caller-provided stem + extension; the response
//     returns the SANITIZED deterministic form.
//   - data_base64: standard-base64 encoded media bytes. Empty /
//     whitespace-only is rejected at decode time → 400.
type ankiMediaBody struct {
	Filename  string `json:"filename"`
	DataBase64 string `json:"data_base64"`
}

// ankiMediaResponse is the success reply for /v1/anki/media.
// `filename` is the deterministic stored name — the value AnkiDroid
// indexes in collection.media. The web-side Player reads it back as
// the `[sound:filename]` field token.
type ankiMediaResponse struct {
	Filename string `json:"filename"`
}

// ankiActionBody is the inbound shape for /v1/anki/action: a full
// AnkiConnect envelope. The fields are read here (so addNote
// rewrites can run) and the params subtree is forwarded verbatim.
type ankiActionBody struct {
	Action  string          `json:"action"`
	Version int             `json:"version"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// ankiStatusBody is the metadata-only reply for /v1/anki/status. It
// is a small fixed shape so the web-side diagnostic UI can render a
// pass/fail summary without parsing JSON-path probes. The capability
// token / pairing code / AnkiDroid user data are NEVER in the body.
type ankiStatusBody struct {
	ProxyConfigured bool   `json:"proxyConfigured"`
	MediaDirWritable bool  `json:"mediaDirWritable"`
	MediaDir        string `json:"mediaDir"`
}

// ankiMaxBodyBytes is the hard cap on /v1/anki/media request bodies.
// 64 MB matches the spec Phase 1 design — the heaviest single media
// payload Entei / Yomitan ship is well under this, and the cap keeps
// a hostile caller from forcing unbounded memory use. /v1/anki/action
// uses the same cap because picture/video entries can be embedded.
const ankiMaxBodyBytes = 64 << 20 // 64 MiB

// handleAnkiMedia serves POST /v1/anki/media: decode the base64 data,
// hand it to MediaWriter.Write (which produces the deterministic
// content-hash filename + write), and reply with the stored name. The
// Origin + token gates run first so a malformed body cannot bypass
// authentication.
func (s *Server) handleAnkiMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handleAnkiPreflight(w, r)
		return
	}
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST, OPTIONS")
		return
	}
	if !s.ankiGates(w, r) {
		return
	}
	if s.anki == nil || s.anki.Writer == nil {
		// The route is registered only when the bridge is wired; this
		// branch fires when the Writer failed to construct (probe
		// returned ErrUnsupportedPlatform on a non-Android/non-Linux
		// host, or the candidate list was exhausted). The proxy URL
		// may still be configured — the bridge is "half-wired" and the
		// status endpoint reports proxyConfigured=true while
		// mediaDirWritable=false. The same message serves both cases so
		// the operator can tell "bridge disabled" (route 404) from
		// "bridge running on the wrong host" (route 503).
		writeJSON(w, http.StatusServiceUnavailable, errorBody("anki bridge not supported on this platform"))
		return
	}
	body := http.MaxBytesReader(w, r.Body, ankiMaxBodyBytes)
	defer body.Close()
	var req ankiMediaBody
	dec := json.NewDecoder(body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		// MaxBytesReader surfaces a 413 via the http.MaxBytesError
		// unwrap; the handler maps it explicitly so the user sees
		// the right status (otherwise it falls through as 400 with a
		// confusing message).
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errorBody("payload too large"))
			return
		}
		writeJSON(w, http.StatusBadRequest, errorBody("invalid JSON body"))
		return
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(req.DataBase64))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid base64 data"))
		return
	}
	stored, err := s.anki.Writer.Write(req.Filename, raw)
	if err != nil {
		switch {
		case errors.Is(err, anki.ErrUnsupportedPlatform):
			writeJSON(w, http.StatusServiceUnavailable, errorBody("anki bridge not supported on this platform"))
			return
		case errors.Is(err, anki.ErrEmptyMedia):
			writeJSON(w, http.StatusBadRequest, errorBody("empty media data"))
			return
		}
		writeJSON(w, http.StatusInternalServerError, errorBody("anki media write failed"))
		return
	}
	writeJSON(w, http.StatusOK, ankiMediaResponse{Filename: stored})
}

// handleAnkiAction serves POST /v1/anki/action. It parses the inbound
// AnkiConnect envelope, runs the addNote rewrite (so audio/video/
// picture entries reference deterministic filenames that already exist
// in collection.media), and forwards the modified envelope via
// NoteProxy. The upstream result envelope is returned verbatim — the
// caller is the upstream contract, just on a different port.
//
// The handler never logs the request body. Capability tokens must
// never appear in diagnostic output; addNote params can carry
// arbitrary user content (magnet URIs, video filenames, deck names).
func (s *Server) handleAnkiAction(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handleAnkiPreflight(w, r)
		return
	}
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST, OPTIONS")
		return
	}
	if !s.ankiGates(w, r) {
		return
	}
	if s.anki == nil || s.anki.Proxy == nil {
		writeJSON(w, http.StatusServiceUnavailable, errorBody("anki bridge not configured"))
		return
	}
	body := http.MaxBytesReader(w, r.Body, ankiMaxBodyBytes)
	defer body.Close()
	var env ankiActionBody
	dec := json.NewDecoder(body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errorBody("payload too large"))
			return
		}
		writeJSON(w, http.StatusBadRequest, errorBody("invalid JSON body"))
		return
	}
	if env.Action == "" {
		writeJSON(w, http.StatusBadRequest, errorBody("missing action"))
		return
	}
	out, err := s.processAnkiAction(r, env)
	if err != nil {
		s.writeAnkiActionError(w, err)
		return
	}
	// The upstream envelope is "result / error"; the handler always
	// returns a fully-formed envelope so the caller (Entei / Yomitan /
	// asbplayer) sees the same shape regardless of bridge state.
	writeJSON(w, http.StatusOK, map[string]json.RawMessage{"result": out, "error": json.RawMessage("null")})
}

// processAnkiAction runs the inbound envelope through the addNote
// rewrite (when applicable), forwards via NoteProxy, and returns the
// upstream "result" raw JSON (so the caller can wrap it in the
// standard envelope). Returns the typed errors defined in the anki
// package; handleAnkiAction maps them to HTTP statuses.
func (s *Server) processAnkiAction(r *http.Request, env ankiActionBody) (json.RawMessage, error) {
	envelope := map[string]json.RawMessage{
		"action":  mustJSONString(env.Action),
		"version": mustJSONInt(env.Version),
	}
	if len(env.Params) > 0 {
		params := env.Params
		// AnkiConnect params is always a JSON object; a non-object params
		// (array/string/number) is a client-body error → 400, never 500
		// (2026-08-29 review finding: the addNote-only guard left other
		// actions forwarding the malformed shape upstream).
		var paramsObj map[string]json.RawMessage
		if err := json.Unmarshal(params, &paramsObj); err != nil {
			return nil, fmt.Errorf("%w: params must be an object", anki.ErrBadRequest)
		}
		if env.Action == "addNote" {
			rewritten, err := s.rewriteAddNoteMedia(params)
			if err != nil {
				return nil, err
			}
			params = rewritten
		}
		envelope["params"] = params
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("marshal envelope: %w", err)
	}
	return s.anki.Proxy.ForwardEnvelope(r.Context(), raw)
}

// rewriteAddNoteMedia walks params.note.audio / video / picture and
// (a) decodes each entry's data via MediaWriter.Write to produce the
// deterministic filename, (b) rewrites the entry's "filename" field to
// that name. The rewrite preserves entry order and every other field
// (fields, url, skipHash, etc.) verbatim — only "filename" changes.
//
// Spec §3.3: media arrays live INSIDE params.note, never beside it.
// The rewrite only touches that subtree; everything outside note
// (deckName, modelName, tags, options) is forwarded unchanged.
//
// The params payload is decoded as a generic map keyed by the JSON
// field name. We only inspect the "note" subtree (when present); for
// every other key (and for every other key INSIDE note) the original
// raw JSON bytes are re-emitted verbatim, so the upstream sees the
// exact shape the caller sent — including unknown future AnkiConnect
// fields. Round-tripping through Go structs would lose that.
//
// `note` absent → forward verbatim (no rewrite).
// `note` present but not an object → anki.ErrBadRequest (handler → 400).
func (s *Server) rewriteAddNoteMedia(params json.RawMessage) (json.RawMessage, error) {
	var p map[string]json.RawMessage
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("%w: addNote params must be an object", anki.ErrBadRequest)
	}
	noteRaw, ok := p["note"]
	if !ok || len(noteRaw) == 0 || string(noteRaw) == "null" {
		// No note subtree → nothing to rewrite. The original bytes
		// (already validated to be a JSON object by json.Unmarshal
		// into map[string]json.RawMessage above) are forwarded.
		return params, nil
	}
	var noteObj map[string]json.RawMessage
	if err := json.Unmarshal(noteRaw, &noteObj); err != nil {
		return nil, fmt.Errorf("%w: addNote params.note must be an object", anki.ErrBadRequest)
	}
	for _, key := range []string{"audio", "video", "picture"} {
		raw, has := noteObj[key]
		if !has || len(raw) == 0 || string(raw) == "null" {
			continue
		}
		rewritten, err := s.rewriteMediaArray(raw)
		if err != nil {
			return nil, err
		}
		noteObj[key] = rewritten
	}
	noteBytes, err := json.Marshal(noteObj)
	if err != nil {
		return nil, fmt.Errorf("remarshal addNote params.note: %w", err)
	}
	p["note"] = noteBytes
	out, err := json.Marshal(p)
	if err != nil {
		return nil, fmt.Errorf("remarshal addNote params: %w", err)
	}
	return out, nil
}

// rewriteMediaArray walks a single media array (audio/video/picture)
// and rewrites each entry's filename. The array shape is forwarded
// verbatim; each entry is decoded into a flexible map so unknown
// fields survive the round-trip.
func (s *Server) rewriteMediaArray(raw json.RawMessage) (json.RawMessage, error) {
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("%w: media array must be a JSON array", anki.ErrBadRequest)
	}
	if len(entries) == 0 {
		return raw, nil
	}
	out := make([]json.RawMessage, 0, len(entries))
	for _, rawEntry := range entries {
		rewritten, err := s.rewriteMediaEntry(rawEntry)
		if err != nil {
			return nil, err
		}
		out = append(out, rewritten)
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("remarshal media array: %w", err)
	}
	return encoded, nil
}

// rewriteMediaEntry decodes one audio/video/picture entry, runs
// MediaWriter.Write on its decoded data, and re-emits the entry with
// "filename" replaced by the deterministic stored name.
//
// The decoding uses a generic map so unknown fields (AnkiConnect's
// `url`, `path`, `skipHash`, `fields` etc.) survive.
//
// Three "forward verbatim" branches keep upstream behaviour intact:
//
//   - entry is not a JSON object → anki.ErrBadRequest (400)
//   - entry has no "data" (or empty / null "data") → upstream handles
//     it (typically a reference to a previously-stored file)
//   - entry has BOTH "url" and "data" → upstream would download the
//     url AND consume the embedded data, producing an orphan in
//     collection.media and a duplicate write. Forward untouched; the
//     upstream's url-download path is the canonical one.
//
// Empty "data" with empty "filename" is allowed (AnkiConnect treats
// it as a reference to a previously-stored file) — the entry is
// forwarded verbatim in that case.
func (s *Server) rewriteMediaEntry(rawEntry json.RawMessage) (json.RawMessage, error) {
	var entry map[string]json.RawMessage
	if err := json.Unmarshal(rawEntry, &entry); err != nil {
		return nil, fmt.Errorf("%w: media entry must be a JSON object", anki.ErrBadRequest)
	}
	// url+data: forward untouched. See contract above.
	if _, hasURL := entry["url"]; hasURL {
		return rawEntry, nil
	}
	dataRaw, hasData := entry["data"]
	if !hasData || len(dataRaw) == 0 || string(dataRaw) == "null" {
		return rawEntry, nil
	}
	var dataB64 string
	if err := json.Unmarshal(dataRaw, &dataB64); err != nil {
		return nil, fmt.Errorf("%w: media data must be a base64 string", anki.ErrBadRequest)
	}
	if dataB64 == "" {
		return rawEntry, nil
	}
	raw, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid base64 media data", anki.ErrBadRequest)
	}
	filename := ""
	if fn, ok := entry["filename"]; ok {
		_ = json.Unmarshal(fn, &filename)
	}
	stored, err := s.anki.Writer.Write(filename, raw)
	if err != nil {
		return nil, err
	}
	entry["filename"] = mustJSONString(stored)
	rewritten, err := json.Marshal(entry)
	if err != nil {
		return nil, fmt.Errorf("remarshal media entry: %w", err)
	}
	return rewritten, nil
}

// handleAnkiStatus serves GET /v1/anki/status: a non-sensitive
// readiness snapshot the web UI can poll without exposing any path,
// URL with a token, or capability token. Same Origin + token gate as
// the other routes; HEAD mirrors GET; OPTIONS preflight advertises GET.
func (s *Server) handleAnkiStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.handleAnkiPreflight(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeMethodNotAllowed(w, "GET, HEAD, OPTIONS")
		return
	}
	if !s.ankiGates(w, r) {
		return
	}
	body := ankiStatusBody{ProxyConfigured: s.anki != nil && s.anki.ProxyConfigured}
	if s.anki != nil && s.anki.Writer != nil {
		dir := s.anki.Writer.Dir()
		body.MediaDir = dir
		// "Writable" mirrors the same probe used at construction: a
		// successful temp write+delete in the directory. The probe
		// runs on every status hit; it's cheap and tells the user
		// "you can write today" vs "AnkiDroid was uninstalled since
		// the companion started".
		body.MediaDirWritable = dir != "" && probeWritableDir(dir)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_ = json.NewEncoder(w).Encode(body)
}

// handleAnkiPreflight answers OPTIONS for the three anki routes.
// They share the same shape (POST + Content-Type header) so a single
// preflight handler is honest and simpler.
func (s *Server) handleAnkiPreflight(w http.ResponseWriter, r *http.Request) {
	origin, ok := s.originAllowed(r)
	if !ok {
		writeJSON(w, http.StatusForbidden, errorBody("origin not allowed"))
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.Header().Add("Vary", "Origin")
	w.WriteHeader(http.StatusNoContent)
}

// ankiGates applies the exact-Origin + capability-token gates shared
// with the media endpoints. It writes the error response itself and
// returns false when the request must stop. Mirrors the jobGates
// pattern (internal/api/jobs.go) so reviewers see one consistent
// authentication shape across all authenticated routes.
func (s *Server) ankiGates(w http.ResponseWriter, r *http.Request) bool {
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

// writeAnkiActionError maps the anki package's typed errors to HTTP
// statuses. Upstream HTTP errors → 502 (we are the proxy); upstream
// AnkiConnect errors → 502 with the message (AnkiConnect's "error"
// strings are operator-safe, spec §9). Client-body mistakes
// (malformed addNote params, bad base64, non-object note / entry) →
// 400 with a short message so the caller can re-shape the request.
// Everything else → 500.
func (s *Server) writeAnkiActionError(w http.ResponseWriter, err error) {
	var ue *anki.ErrUpstreamHTTP
	var ae *anki.ErrUpstreamAnki
	switch {
	case errors.As(err, &ue):
		writeJSON(w, http.StatusBadGateway, errorBody("anki upstream HTTP error"))
		return
	case errors.As(err, &ae):
		// The AnkiConnect error message itself is operator-safe
		// (action name + reason; never user content), so we forward
		// it as-is — callers can map by message if they want.
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": ae.Message})
		return
	case errors.Is(err, anki.ErrBadRequest):
		// Strip the "anki: " prefix and the inner wrapping so the
		// client gets the human-meaningful reason only.
		writeJSON(w, http.StatusBadRequest, errorBody(stripAnkiBadRequestMessage(err)))
		return
	case errors.Is(err, anki.ErrUnsupportedPlatform):
		writeJSON(w, http.StatusServiceUnavailable, errorBody("anki bridge not supported on this platform"))
		return
	case errors.Is(err, anki.ErrEmptyMedia):
		writeJSON(w, http.StatusBadRequest, errorBody("empty media data"))
		return
	}
	writeJSON(w, http.StatusInternalServerError, errorBody("anki action failed"))
}

// stripAnkiBadRequestMessage trims the anki.ErrBadRequest wrapper and
// any "%w: ..." prefix from err so the body carries a short
// operator-friendly reason (e.g. "invalid base64 media data") instead
// of a Go-formatted chain.
func stripAnkiBadRequestMessage(err error) string {
	msg := err.Error()
	const prefix = "anki: "
	if strings.HasPrefix(msg, prefix) {
		msg = strings.TrimPrefix(msg, prefix)
	}
	if i := strings.Index(msg, ": "); i > 0 {
		// Drop a leading "<context>: " if the message was wrapped via
		// fmt.Errorf("%w: <context>", anki.ErrBadRequest). The trailing
		// portion is the human reason.
		msg = msg[i+2:]
	}
	if msg == "" {
		return "invalid anki action body"
	}
	return msg
}

// mustJSONString returns the JSON-encoded string form of s. Errors
// from json.Marshal of a primitive string never fire in practice; the
// panic-free fallback returns json.RawMessage(`""`) so a malformed
// string never breaks the upstream call.
func mustJSONString(s string) json.RawMessage {
	b, err := json.Marshal(s)
	if err != nil {
		return json.RawMessage(`""`)
	}
	return b
}

// mustJSONInt returns the JSON-encoded integer form of v. Same error
// policy as mustJSONString.
func mustJSONInt(v int) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`0`)
	}
	return b
}

// probeWritableDir is a thin shim that calls into the anki package's
// probe — kept here so the status handler does not need to import
// package-private internals. The anki package owns the probe semantics
// (and its platform split); the API layer only asks "is this dir
// writable right now?".
func probeWritableDir(dir string) bool {
	return anki.ProbeWritable(dir)
}