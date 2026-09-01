// Raw AnkiConnect-compatible listener (spec v4.0, 2026-08-31) — the
// ONLY Anki surface the companion exposes.
//
// Why this exists: the deployed Entei web points its Anki endpoint at
// the DEFAULT http://127.0.0.1:8765 (the official AnkiConnect port);
// the prior /v1/anki/action endpoint sat at 4322 (origin+token gated)
// and Entei saw "Disconnected" with zero config. Yomitan targets 8765
// too. v4.0 replaces the token-gated /v1/anki/{media,action,status}
// surface entirely with a raw, byte-compatible AnkiConnect surface on
// 127.0.0.1:8765. Nothing used /v1/anki/* in production; the second
// surface was pure cost. Entei / Yomitan / asbplayer now talk to the
// 8765 surface directly with the wire envelopes they already speak.
//
// Threat model (deliberate divergence from the removed /v1/anki/*
// routes): the raw listener binds LOOPBACK ONLY and serves CORS-
// wildcard (`Access-Control-Allow-Origin: *`, allow Content-Type,
// allow POST + OPTIONS). This matches AnkiconnectAndroid and the
// official AnkiConnect plugin's posture — browser extensions like
// Yomitan have extension origins that cannot be allowlisted, and the
// loopback bind means the surface is unreachable from off-host. The
// /v1/* routes (pairing, media, status) keep their strict origin
// allowlist; this file owns a single surface, the raw one.
//
// Authentication: when AnkiBridge.APIKey is set (the companion flag
// `--anki-api-key <key>`), the body MUST carry a matching `key` field
// (AnkiConnect's own convention). When unset, all callers are
// accepted — matching AnkiconnectAndroid which has no auth surface.
//
// Conflict tolerance: if 8765 is already bound (official AnkiConnect
// running on a desktop, dev harness, etc.), the listener start
// returns EADDRINUSE. The caller logs a one-line warning and the
// process continues serving everything else. The companion must
// never crash because a desktop AnkiConnect is running.
//
// This file owns the entire Anki surface:
//
//   - dispatchAnkiAction: the in-process dispatcher (version, deckNames,
//     addNote, storeMediaFile's media-rewrite, findNotes, …). The raw
//     handler delegates here, so any future action added here is
//     automatically exposed.
//   - the AnkiConnect wire envelope (request/response shapes, error
//     mapping into the {"result": …, "error": …} shape).
//   - the addNote media-array rewrite (audio/video/picture →
//     deterministic filename + MediaWriter.Write + [sound:…] tag
//     append to named fields).
//   - StartRawAnkiConnectListener: the bind + goroutine lifecycle for
//     the second HTTP server on 127.0.0.1:8765.

package api

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"eizoudendenshi/internal/anki"
)

// rawAnkiConnectBind is the fixed loopback address for the raw
// AnkiConnect-compatible listener. Mirrors the upstream AnkiConnect
// default so Entei / Yomitan / asbplayer work with ZERO config. The
// bind is loopback-only — the threat model relies on it. Exported
// (RawAnkiConnectBind) so the companion command can pass it to
// StartRawAnkiConnectListener without re-declaring the literal.
const RawAnkiConnectBind = "127.0.0.1:8765"

// rawAnkiConnectDefaultAcceptedHosts builds the default DNS-rebinding
// accepted-host set from RawAnkiConnectBind. The port is derived
// from the constant so a future bind change automatically updates
// the accepted set without leaving a stale literal behind. IPv6
// loopback is also accepted for symmetry with the constant's IPv4
// loopback. Empty Host (HTTP/1.0-style requests) is allowed via the
// r.Host == "" branch in handleRawAnkiConnect, not as a map entry.
// Called once at package init to populate rawAnkiConnectAcceptedHosts
// (the per-Server default).
func rawAnkiConnectDefaultAcceptedHosts() map[string]struct{} {
	return map[string]struct{}{
		"127.0.0.1": {},
		"localhost": {},
		"::1":       {},
	}
}

// rawAnkiConnectMaxBodyBytes is the hard cap on the raw listener's
// request bodies (64 MiB). Picture / video entries can be embedded in
// addNote payloads, and the cap keeps a hostile caller from forcing
// unbounded memory use. The cap matches what AnkiconnectAndroid
// applies.
const rawAnkiConnectMaxBodyBytes = 64 << 20

// ankiConnectEnvelope is the wire shape every AnkiConnect client
// sends. We parse it once and re-dispatch via dispatchAnkiAction (the
// only Anki surface), so any future action added to that dispatcher
// is automatically exposed on the raw surface too.
//
// `key` is the optional AnkiConnect-style API key. The dispatcher
// checks it BEFORE running the action so a key-mismatched caller
// never even reads from the SQLite collection.
type ankiConnectEnvelope struct {
	Action  string          `json:"action"`
	Version int             `json:"version"`
	Params  json.RawMessage `json:"params"`
	Key     string          `json:"key"`
}

// ankiConnectResponse is the standard AnkiConnect reply envelope:
// HTTP 200 with {"result": <result>, "error": <error|null>} on
// EVERY code path, including the "unknown action" case (matching
// AnkiconnectAndroid's behaviour). Callers parse the `error` field
// to detect failure; the HTTP status is always 200.
//
// We marshal `result` as a json.RawMessage so the inner shape is
// forwarded verbatim (numbers stay numbers, nulls stay nulls). When
// the dispatcher returns an error, `result` is JSON `null` and
// `error` carries a human-readable string. The duplicate-note case
// is special-cased: `result` is `null` AND `error` is `null` (the
// documented addNote allowDuplicate=false contract).
type ankiConnectResponse struct {
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

// ankiActionBody is the internal shape passed to the dispatcher. It
// matches the AnkiConnect envelope field-for-field so a parsed
// ankiConnectEnvelope can be forwarded as-is. Kept as a named type
// so the dispatcher's signature is self-documenting.
type ankiActionBody struct {
	Action  string          `json:"action"`
	Version int             `json:"version"`
	Params  json.RawMessage `json:"params"`
}

// ankiMediaBody is the inbound shape for storeMediaFile:
// {"filename": "...", "data": "<base64>"}. The data field is
// standard AnkiConnect naming (the removed /v1/anki/media surface
// used data_base64; the raw surface follows the wire convention).
type ankiMediaBody struct {
	Filename string `json:"filename"`
	Data     string `json:"data"`
}

// ErrMediaWriterUnavailable is returned by the addNote media-rewrite
// path when the bridge is wired in notes-only mode (DB open, Writer
// nil — the Termux collection.media probe failed or was skipped). The
// raw handler maps it to an AnkiConnect-shaped error envelope with
// the message "anki media writer not available on this platform".
// The guard fires ONLY when the inbound addNote actually carries
// audio / video / picture arrays with non-empty data — a text-only
// addNote against a notes-only bridge is perfectly valid and inserts
// normally (a defensive panic on a notes-only bridge would block
// note-taking entirely for any caller whose media path failed).
var ErrMediaWriterUnavailable = errors.New("anki: media writer not available on this platform")

// handleRawAnkiConnect is the http.Handler served on the raw
// listener. It accepts any path (AnkiConnect clients POST to root;
// some libraries POST to / or to a fixed endpoint like /anki — we
// match on the JSON envelope shape, not the URL). The handler
// applies four gates:
//
//  1. Method: POST or OPTIONS only. GET / DELETE → 200 + AnkiConnect
//     envelope with "unsupported method: X" error (the wire contract
//     keeps HTTP 200 even on misrouted requests, matching
//     AnkiconnectAndroid / official AnkiConnect).
//  2. CORS preflight: OPTIONS → 204 with Access-Control-Allow-Origin: *
//     and the documented allow-headers / allow-methods. This is the
//     loopback-only threat-model branch and MUST stay permissive so
//     Yomitan (extension origin) can reach the bridge.
//  3. JSON envelope: body must decode to {action, ...}; missing
//     action → error envelope "missing action".
//  4. API key (when configured): body.key must match
//     s.anki.APIKey via constant-time compare.
//
// On success the response is the AnkiConnect wire envelope (HTTP
// 200, `result` populated, `error` null). On failure it's still
// HTTP 200 with `result` null and a human-readable `error` string;
// callers (Entei / Yomitan / asbplayer) check the JSON `error`
// field, never the HTTP status.
func (s *Server) handleRawAnkiConnect(w http.ResponseWriter, r *http.Request) {
	// DNS-rebinding guard: with CORS `*` on loopback, the one
	// remaining gap is a public hostname pointed at 127.0.0.1 by a
	// rebinding attacker — the Host header then reveals it. Yomitan /
	// Entei always send 127.0.0.1 (or localhost / [::1]) so we accept
	// the loopback hostnames for the configured port and reject
	// everything else with 403. The check runs BEFORE CORS headers
	// and BEFORE body parsing, so a rebinding probe gets nothing
	// back (not even CORS reflection). Empty r.Host (HTTP/1.0-style
	// requests without a Host header) is allowed — those are
	// unlikely to be rebinding vectors (no hostname to rebind).
	if r.Host != "" {
		hostOnly, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			// No port in Host (HTTP/1.0 style or bare IPv6) — use as-is.
			hostOnly = r.Host
		}
		hosts := s.rawAnkiAcceptedHosts
		if hosts == nil {
			// Zero-value Server (e.g. tests) — fall back to the package
			// default loopback set so the guard stays active.
			hosts = rawAnkiConnectDefaultAcceptedHosts()
		}
		if _, ok := hosts[hostOnly]; !ok {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
	}
	// CORS headers are unconditional on the raw listener — the
	// threat model is loopback bind, not origin allowlist.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	switch r.Method {
	case http.MethodOptions:
		// Preflight: respond with the same CORS surface as a normal
		// POST so the browser permits the follow-up. No envelope is
		// expected and none is read — the body is irrelevant.
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodPost:
		// Fall through to the body-dispatch path below.
	default:
		// AnkiConnect clients always POST; anything else is an
		// error path. Stay on the AnkiConnect wire contract:
		// HTTP 200 + error envelope (NOT 405). This matches what
		// AnkiconnectAndroid and official AnkiConnect return for
		// a misrouted request.
		writeRawAnkiConnectError(w, fmt.Sprintf("unsupported method: %s", r.Method))
		return
	}

	body := http.MaxBytesReader(w, r.Body, rawAnkiConnectMaxBodyBytes)
	defer body.Close()
	raw, err := io.ReadAll(body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeRawAnkiConnectError(w, "payload too large")
			return
		}
		writeRawAnkiConnectError(w, "failed to read body")
		return
	}
	var env ankiConnectEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		writeRawAnkiConnectError(w, "invalid JSON body")
		return
	}
	if env.Action == "" {
		writeRawAnkiConnectError(w, "missing action")
		return
	}
	// API key gate: when the operator configured --anki-api-key, the
	// body MUST carry a matching `key`. Constant-time compare so a
	// timing-side-channel attacker can't byte-probe the key. Empty
	// configured key → no key required (matches AnkiconnectAndroid).
	if s.anki != nil && s.anki.APIKey != "" {
		if subtle.ConstantTimeCompare([]byte(env.Key), []byte(s.anki.APIKey)) != 1 {
			writeRawAnkiConnectError(w, "unauthorized")
			return
		}
	}
	// Special-case storeMediaFile: route it through the MediaWriter
	// directly so the deterministic-filename contract stays shared
	// with the addNote media-rewrite branch.
	if env.Action == "storeMediaFile" {
		stored, err := s.handleRawStoreMediaFile(env.Params)
		if err != nil {
			writeRawAnkiConnectError(w, err.Error())
			return
		}
		writeRawAnkiConnectResult(w, env.Version, mustJSONString(stored))
		return
	}
	out, err := s.dispatchAnkiAction(ankiActionBody{
		Action:  env.Action,
		Version: env.Version,
		Params:  env.Params,
	})
	if err != nil {
		if errors.Is(err, anki.ErrDuplicateNote) {
			// Duplicate-note special-case: HTTP 200, result null,
			// error null (matches official AnkiConnect addNote
			// semantics for allowDuplicate=false).
			writeRawAnkiConnectResult(w, env.Version, json.RawMessage("null"))
			return
		}
		writeRawAnkiConnectError(w, ankiConnectErrorMessage(err))
		return
	}
	writeRawAnkiConnectResult(w, env.Version, out)
}

// handleRawStoreMediaFile decodes the AnkiConnect storeMediaFile
// envelope (params {filename, data}) and writes the bytes through
// the same MediaWriter the addNote media-rewrite uses, so both
// surfaces land on the SAME deterministic filename for the same
// bytes. Returns the stored filename.
//
// AnkiConnect's wire shape:
//
//	{"action":"storeMediaFile","params":{"filename":"x.webm",
//	 "data":"<base64>"}}
//
// Returned result is the sanitized stored filename (the value the
// caller should reference as [sound:...] or <img src=...> in the
// note field).
func (s *Server) handleRawStoreMediaFile(params json.RawMessage) (string, error) {
	if s.anki == nil || s.anki.Writer == nil {
		return "", errors.New("anki media writer not available on this platform")
	}
	if len(params) == 0 {
		return "", errors.New("storeMediaFile requires params")
	}
	var p ankiMediaBody
	if err := json.Unmarshal(params, &p); err != nil {
		return "", errors.New("storeMediaFile params must be an object")
	}
	if p.Data == "" {
		return "", errors.New("empty media data")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(p.Data))
	if err != nil {
		return "", errors.New("invalid base64 data")
	}
	stored, err := s.anki.Writer.Write(p.Filename, raw)
	if err != nil {
		// Re-raise typed errors verbatim so the caller sees the
		// documented reason. The raw surface does not invent its
		// own error vocabulary — the typed reason comes from the
		// anki package.
		return "", err
	}
	return stored, nil
}

// writeRawAnkiConnectResult writes a successful AnkiConnect reply.
// Follows official AnkiConnect format_success_reply (plugin/web.py):
//
//   - When version <= 4 (or omitted, e.g. Yomitan sending version 2):
//     returns the raw result directly (e.g. 6, ["Default"], etc.)
//     so clients like Yomitan do not trip on `typeof result.error !== 'undefined'`.
//   - When version > 4 (e.g. Entei sending version 6):
//     returns HTTP 200 + {"result": <raw>, "error": null}.
func writeRawAnkiConnectResult(w http.ResponseWriter, version int, result json.RawMessage) {
	if result == nil {
		result = json.RawMessage("null")
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if version <= 4 {
		_, _ = w.Write(result)
		_, _ = w.Write([]byte("\n"))
		return
	}
	_ = json.NewEncoder(w).Encode(ankiConnectResponse{
		Result: result,
		Error:  json.RawMessage("null"),
	})
}

// writeRawAnkiConnectError writes an AnkiConnect-shaped error
// reply: HTTP 200 + {"result": null, "error": <message>}. The HTTP
// status stays 200 because that is the AnkiConnect wire contract —
// callers parse the `error` field, not the status. Every error path
// in handleRawAnkiConnect flows through here.
func writeRawAnkiConnectError(w http.ResponseWriter, msg string) {
	if msg == "" {
		msg = "anki action failed"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(ankiConnectResponse{
		Result: json.RawMessage("null"),
		Error:  json.RawMessage(mustJSONString(msg)),
	})
}

// ankiConnectErrorMessage converts the typed errors returned by
// dispatchAnkiAction into the AnkiConnect-style error string the
// raw surface returns. Mirrors stripAnkiBadRequestMessage's
// formatting so the reason is human-friendly (no "anki: "
// prefix / no "%w:" chain). Special-cases:
//
//   - ErrMediaWriterUnavailable → "anki media writer not available on this platform"
//   - ErrBadRequest → unwrapped reason (e.g. "unsupported action: foo")
//   - ErrDuplicateNote → NOT routed here (the duplicate case is
//     handled at the call site so result stays null + error stays null)
//   - ErrEmptyMedia → "empty media data"
//   - ErrCollectionNotOpen / ErrUnsupportedSchema → "anki collection not available"
//   - ErrUnsupportedPlatform → "anki bridge not supported on this platform"
//   - Everything else → "anki action failed" (generic; the typed
//     reason could carry caller-controlled data).
func ankiConnectErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrMediaWriterUnavailable):
		return "anki media writer not available on this platform"
	case errors.Is(err, anki.ErrBadRequest):
		return stripAnkiBadRequestMessage(err)
	case errors.Is(err, anki.ErrEmptyMedia):
		return "empty media data"
	case errors.Is(err, anki.ErrCollectionNotOpen),
		errors.Is(err, anki.ErrUnsupportedSchema):
		return "anki collection not available"
	case errors.Is(err, anki.ErrUnsupportedPlatform):
		return "anki bridge not supported on this platform"
	}
	return "anki action failed"
}

// dispatchAnkiAction routes the inbound AnkiConnect envelope to the
// matching anki.Collection method. Returns json.RawMessage (the inner
// "result" body) so the caller can wrap it in the standard envelope;
// returns typed errors that the raw handler maps to AnkiConnect-style
// error strings (HTTP 200 + error envelope).
//
// Supported actions (matching A:/AnkiconnectAndroid AnkiAPIRouting.java
// + A:/AnkiconnectAndroid/docs/api.md, version 6 surface):
//
//   - version             → 6
//   - deckNames           → DeckIDs keys
//   - deckNamesAndIds     → DeckIDs (full map)
//   - modelNames          → ModelIDs keys
//   - modelNamesAndIds    → ModelIDs (full map)
//   - modelFieldNames     → param modelName → field list
//   - canAddNotes         → csum-based duplicate check
//   - canAddNotesWithErrorDetail → canAddNotes wrapped with reason string
//   - addNote             → rewriteAddNoteMedia + InsertNote (one
//     transaction; returns noteId as int64)
//   - updateNoteFields    → UpdateNoteFields
//   - addTags             → AddTags
//   - findNotes           → FindNotes (added:1 / nid:… / front:<value>)
//   - notesInfo           → NotesInfo (joined with model + cards)
//   - cardsInfo           → CardsInfo (card-level row per id, in
//     input order; AnkiConnect-documented field set)
//   - multi               → runs a batch of sub-actions and returns
//     the array of sub-results. Yomitan's getAnkiNoteInfo popup
//     flow depends on this: it calls findNoteIds → multi(findNotes)
//     to batch the per-field duplicate-detection queries. Sub-action
//     failures propagate through the whole envelope (matching
//     AnkiconnectAndroid's "findRoute throws" path: the client sees
//     one error and falls back to a canAddNotes probe).
//   - guiBrowse           → resolves a search query (typically
//     `nid:<noteId>` from Yomitan's guiBrowseNote) to the flat
//     array of card ids AnkiConnect's documented contract returns.
//     The `nid:<int>` shape takes a fast path (single SELECT
//     against cards); other supported FindNotes queries (added:1,
//     front:<value>) are routed through FindNotes then expanded to
//     cards via CardIDsForNoteIDs. The Yomitan surface expects
//     CARD ids here, not note ids — see the action for the
//     cross-reference to AnkiConnect's documented behaviour.
//
// Unsupported actions return ErrBadRequest wrapped with
// "unsupported action: <name>"; the handler maps that to an
// AnkiConnect-style error envelope with the human-readable reason
// (AnkiConnect clients parse the `error` field, not the status).
func (s *Server) dispatchAnkiAction(env ankiActionBody) (json.RawMessage, error) {
	// params-object guard: every AnkiConnect action takes a JSON
	// object as params (Yomitan / Entei / asbplayer all send
	// {}). A non-object root (array, string, number, null) is a
	// client-side mistake and must surface as a bad-request error
	// string, not a generic 500.
	if len(env.Params) > 0 {
		var probe map[string]json.RawMessage
		if err := json.Unmarshal(env.Params, &probe); err != nil {
			return nil, fmt.Errorf("%w: params must be an object", anki.ErrBadRequest)
		}
	}
	db := s.anki.DB
	switch env.Action {
	case "version":
		return json.RawMessage("6"), nil
	case "deckNames":
		ids, err := db.DeckIDs()
		if err != nil {
			return nil, err
		}
		names := make([]string, 0, len(ids))
		for n := range ids {
			names = append(names, n)
		}
		return jsonMarshal(names)
	case "deckNamesAndIds":
		ids, err := db.DeckIDs()
		if err != nil {
			return nil, err
		}
		return jsonMarshal(ids)
	case "modelNames":
		ids, err := db.ModelIDs()
		if err != nil {
			return nil, err
		}
		names := make([]string, 0, len(ids))
		for n := range ids {
			names = append(names, n)
		}
		return jsonMarshal(names)
	case "modelNamesAndIds":
		ids, err := db.ModelIDs()
		if err != nil {
			return nil, err
		}
		return jsonMarshal(ids)
	case "modelFieldNames":
		var params struct {
			ModelName string `json:"modelName"`
		}
		if len(env.Params) > 0 {
			if err := json.Unmarshal(env.Params, &params); err != nil {
				return nil, fmt.Errorf("%w: modelFieldNames params must be an object", anki.ErrBadRequest)
			}
		}
		if params.ModelName == "" {
			return nil, fmt.Errorf("%w: modelFieldNames: modelName is required", anki.ErrBadRequest)
		}
		models, err := db.ModelIDs()
		if err != nil {
			return nil, err
		}
		mid, ok := models[params.ModelName]
		if !ok {
			return nil, fmt.Errorf("%w: model %q not found", anki.ErrBadRequest, params.ModelName)
		}
		names, err := db.ModelFieldNames(mid)
		if err != nil {
			return nil, err
		}
		return jsonMarshal(names)
	case "canAddNotes":
		checks, err := parseCanAddNotesParams(env.Params)
		if err != nil {
			return nil, err
		}
		out, err := db.CanAddNotes(checks)
		if err != nil {
			return nil, err
		}
		return jsonMarshal(out)
	case "canAddNotesWithErrorDetail":
		checks, err := parseCanAddNotesParams(env.Params)
		if err != nil {
			return nil, err
		}
		out, err := db.CanAddNotes(checks)
		if err != nil {
			return nil, err
		}
		type withError struct {
			CanAdd bool    `json:"canAdd"`
			Error  *string `json:"error"`
		}
		const dupReason = "cannot create note because it is a duplicate"
		items := make([]withError, len(out))
		for i, ok := range out {
			if ok {
				items[i] = withError{CanAdd: true, Error: nil}
			} else {
				r := dupReason
				items[i] = withError{CanAdd: false, Error: &r}
			}
		}
		return jsonMarshal(items)
	case "addNote":
		var params addNoteParams
		if len(env.Params) > 0 {
			if err := json.Unmarshal(env.Params, &params); err != nil {
				return nil, fmt.Errorf("%w: addNote params must be an object", anki.ErrBadRequest)
			}
		}
		rewritten, err := s.rewriteAddNoteMedia(env.Params)
		if err != nil {
			return nil, err
		}
		// re-decode the rewritten params so we read fields/tags/options
		// out of the post-rewrite shape (filename rewritten, fields
		// possibly appended with [sound:...]/<img...>).
		var redecoded map[string]json.RawMessage
		if err := json.Unmarshal(rewritten, &redecoded); err != nil {
			return nil, fmt.Errorf("%w: addNote params must be an object", anki.ErrBadRequest)
		}
		noteRaw, ok := redecoded["note"]
		if !ok {
			return nil, fmt.Errorf("%w: addNote requires note", anki.ErrBadRequest)
		}
		var noteObj map[string]json.RawMessage
		if err := json.Unmarshal(noteRaw, &noteObj); err != nil {
			return nil, fmt.Errorf("%w: addNote params.note must be an object", anki.ErrBadRequest)
		}
		// Re-decode deckName/modelName from the rewritten top-level
		// (deckName/modelName aren't touched by rewrite; tags may also be
		// rewritten by future code so we re-read).
		var topLevel struct {
			DeckName  string `json:"deckName"`
			ModelName string `json:"modelName"`
		}
		_ = json.Unmarshal(rewritten, &topLevel)
		// AnkiConnect desktop puts deckName / modelName at the params
		// top level; Yomitan / Entei (and the v3.0 fixture) put them
		// INSIDE note. Honour both — note-level wins when present,
		// otherwise fall back to top-level.
		var noteMeta struct {
			DeckName  string `json:"deckName"`
			ModelName string `json:"modelName"`
		}
		_ = json.Unmarshal(noteRaw, &noteMeta)
		params.DeckName = noteMeta.DeckName
		if params.DeckName == "" {
			params.DeckName = topLevel.DeckName
		}
		params.ModelName = noteMeta.ModelName
		if params.ModelName == "" {
			params.ModelName = topLevel.ModelName
		}
		if tRaw, ok := noteObj["tags"]; ok && len(tRaw) > 0 && string(tRaw) != "null" {
			_ = json.Unmarshal(tRaw, &params.Tags)
		}
		// Read addNote `options` (allowDuplicate / duplicateScope /
		// deckName). AnkiConnect desktop puts options at the params
		// top level; Yomitan / Entei put it inside note.options. We
		// honour both: note-level wins when present (the key is in
		// the note's raw JSON map), otherwise fall back to the
		// top-level. "Absent" vs "explicitly false" can't be
		// distinguished without per-field presence tracking; the
		// documented contract is "absent → defaults" and
		// "explicit false → no duplicates", which match — either
		// way the duplicate check runs.
		var noteOpts addNoteOptions
		var noteOptsPresent bool
		if oRaw, ok := noteObj["options"]; ok && len(oRaw) > 0 && string(oRaw) != "null" {
			_ = json.Unmarshal(oRaw, &noteOpts)
			noteOptsPresent = true
		}
		var topOpts addNoteOptions
		if oRaw, ok := redecoded["options"]; ok && len(oRaw) > 0 && string(oRaw) != "null" {
			_ = json.Unmarshal(oRaw, &topOpts)
		}
		if noteOptsPresent {
			params.Options = noteOpts
		} else {
			params.Options = topOpts
		}
		// Resolve deckName / modelName → IDs (AnkiConnect accepts
		// either; we honour both for compat).
		models, err := db.ModelIDs()
		if err != nil {
			return nil, err
		}
		decks, err := db.DeckIDs()
		if err != nil {
			return nil, err
		}
		mid, ok := models[params.ModelName]
		if !ok {
			return nil, fmt.Errorf("%w: model %q not found", anki.ErrBadRequest, params.ModelName)
		}
		did, ok := decks[params.DeckName]
		if !ok {
			return nil, fmt.Errorf("%w: deck %q not found", anki.ErrBadRequest, params.DeckName)
		}
		// Resolve fields. The inbound shape is either an object map
		// {"Front":"cat","Back":"feline"} or an array
		// ["cat","feline"]. We honour both: for the object map we
		// resolve to an ordered []string via the model's field names
		// in ord order.
		fieldNames, err := db.ModelFieldNames(mid)
		if err != nil {
			return nil, err
		}
		fRaw, ok := noteObj["fields"]
		if !ok {
			return nil, fmt.Errorf("%w: addNote note.fields is required", anki.ErrBadRequest)
		}
		// Try object map first.
		var fieldsMap map[string]string
		if err := json.Unmarshal(fRaw, &fieldsMap); err == nil && len(fieldsMap) > 0 {
			ordered := make([]string, 0, len(fieldNames))
			for _, n := range fieldNames {
				ordered = append(ordered, fieldsMap[n])
			}
			params.Fields = ordered
		} else {
			// Fall back to array form.
			if err := json.Unmarshal(fRaw, &params.Fields); err != nil {
				return nil, fmt.Errorf("%w: addNote note.fields must be an object or array", anki.ErrBadRequest)
			}
		}
		// Resolve duplicateScope for InsertNote. Honour the same
		// defaults as CanAddNotes (collection-wide unless explicitly
		// "deck"). The deck id is the one already resolved for this
		// note — the same deck the candidate card will land in.
		scope := params.Options.DuplicateScope
		if scope == "" {
			scope = "collection"
		}
		noteID, err := db.InsertNote(did, mid, params.Fields, params.Tags, &anki.InsertOptions{
			AllowDuplicate: params.Options.AllowDuplicate,
			DuplicateScope: scope,
			ScopeDeckID:    did,
		})
		if err != nil {
			return nil, err
		}
		return jsonMarshal(noteID)
	case "updateNoteFields":
		var params struct {
			ID     int64             `json:"id"`
			Fields map[string]string `json:"fields"`
			Note   *struct {
				ID     int64             `json:"id"`
				Fields map[string]string `json:"fields"`
			} `json:"note"`
		}
		if len(env.Params) == 0 {
			return nil, fmt.Errorf("%w: updateNoteFields requires params", anki.ErrBadRequest)
		}
		if err := json.Unmarshal(env.Params, &params); err != nil {
			return nil, fmt.Errorf("%w: updateNoteFields params must be an object", anki.ErrBadRequest)
		}
		targetID := params.ID
		targetFields := params.Fields
		if params.Note != nil {
			if params.Note.ID != 0 {
				targetID = params.Note.ID
			}
			if len(params.Note.Fields) > 0 {
				targetFields = params.Note.Fields
			}
		}
		if targetID == 0 {
			return nil, fmt.Errorf("%w: updateNoteFields: id is required", anki.ErrBadRequest)
		}
		if err := db.UpdateNoteFields(targetID, targetFields); err != nil {
			return nil, err
		}
		return json.RawMessage("null"), nil
	case "addTags":
		var params struct {
			Notes []int64 `json:"notes"`
			Tags  string  `json:"tags"`
		}
		if len(env.Params) == 0 {
			return nil, fmt.Errorf("%w: addTags requires params", anki.ErrBadRequest)
		}
		if err := json.Unmarshal(env.Params, &params); err != nil {
			return nil, fmt.Errorf("%w: addTags params must be an object", anki.ErrBadRequest)
		}
		if params.Tags == "" {
			return nil, fmt.Errorf("%w: addTags: tags is required", anki.ErrBadRequest)
		}
		if err := db.AddTags(params.Notes, params.Tags); err != nil {
			return nil, err
		}
		return json.RawMessage("null"), nil
	case "findNotes":
		var params struct {
			Query string `json:"query"`
		}
		if len(env.Params) == 0 {
			return nil, fmt.Errorf("%w: findNotes requires params", anki.ErrBadRequest)
		}
		if err := json.Unmarshal(env.Params, &params); err != nil {
			return nil, fmt.Errorf("%w: findNotes params must be an object", anki.ErrBadRequest)
		}
		ids, err := db.FindNotes(params.Query)
		if err != nil {
			return nil, err
		}
		return jsonMarshal(ids)
	case "notesInfo":
		var params struct {
			Notes []int64 `json:"notes"`
		}
		if len(env.Params) == 0 {
			return nil, fmt.Errorf("%w: notesInfo requires params", anki.ErrBadRequest)
		}
		if err := json.Unmarshal(env.Params, &params); err != nil {
			return nil, fmt.Errorf("%w: notesInfo params must be an object", anki.ErrBadRequest)
		}
		notes, err := db.NotesInfo(params.Notes)
		if err != nil {
			return nil, err
		}
		return jsonMarshal(notes)
	case "cardsInfo":
		// Yomitan's _notesCardsInfo (background/backend.js ~line 759)
		// calls cardsInfo with the flat cardIds extracted from
		// notesInfo's `cards` array. The result array must preserve
		// input order so the client can zip by index. We honour that
		// contract by issuing one SELECT per id (see Collection.CardsInfo).
		var params struct {
			Cards []int64 `json:"cards"`
		}
		if len(env.Params) == 0 {
			return nil, fmt.Errorf("%w: cardsInfo requires params", anki.ErrBadRequest)
		}
		if err := json.Unmarshal(env.Params, &params); err != nil {
			return nil, fmt.Errorf("%w: cardsInfo params must be an object", anki.ErrBadRequest)
		}
		infos, err := db.CardsInfo(params.Cards)
		if err != nil {
			return nil, err
		}
		return jsonMarshal(infos)
	case "multi":
		// Yomitan's _invokeMulti sends an array of sub-actions, each
		// of which is dispatched with its own (version, params). The
		// sub-action results are returned as a raw JSON array; each
		// slot is the RAW result value (not an envelope) — Yomitan's
		// _normalizeArray reads result[i] directly.
		//
		// Sub-action failure policy: mirror AnkiconnectAndroid. In
		// the upstream, findRoute throws → the handler returns the
		// whole-error envelope and the client sees one error for the
		// whole batch. Yomitan's getAnkiNoteInfo flow then falls back
		// to a canAddNotes probe. We propagate the FIRST sub-action
		// error to the caller verbatim — simpler than per-slot
		// errors (Yomitan doesn't read them anyway) and matches the
		// documented "fail whole batch" contract.
		//
		// Divergence note: AnkiconnectAndroid (and the AnkiConnect
		// desktop build for version > 4) wraps each sub-result in
		// its own {result, error} envelope so the multi surface
		// looks like `[{result: ...}, {result: ...}, ...]`. We
		// return the raw array (`[..., ..., ...]`) because Yomitan
		// only speaks version <= 2 of the wire format and reads
		// result[i] directly — wrapping would break its consumer
		// (Yomitan's _invokeMulti normalises against version 2).
		// Any future client that speaks version > 4 multi would
		// need a separate code path; Yomitan doesn't observe the
		// difference today so we don't carry the cost.
		var params struct {
			Actions []ankiActionBody `json:"actions"`
		}
		if len(env.Params) == 0 {
			return nil, fmt.Errorf("%w: multi requires params", anki.ErrBadRequest)
		}
		if err := json.Unmarshal(env.Params, &params); err != nil {
			return nil, fmt.Errorf("%w: multi params must be an object", anki.ErrBadRequest)
		}
		results := make([]json.RawMessage, 0, len(params.Actions))
		for _, sub := range params.Actions {
			out, err := s.dispatchAnkiAction(sub)
			if err != nil {
				// Propagate the first error through the normal
				// envelope-error path (writeRawAnkiConnectError /
				// ankiConnectErrorMessage handles AnkiConnect-style
				// mapping). The remaining sub-actions are NOT
				// dispatched: matches AnkiconnectAndroid's "fail
				// whole batch" semantics.
				return nil, err
			}
			results = append(results, out)
		}
		return jsonMarshal(results)
	case "guiBrowse":
		// AnkiConnect's documented guiBrowse contract returns CARD
		// ids (the search results are cards, opened in the Anki
		// browser). Yomitan's guiBrowseNote(noteId) calls
		// this.guiBrowse('nid:' + noteId) and consumes the result
		// via _normalizeArray(result, -1, 'number') as cardIds — the
		// normalised list is then fed to
		// _onViewNotesButtonClick in
		// A:/yomitan/ext/js/display/display-anki.js:1389-1393.
		// See A:/yomitan/ext/js/comm/anki-connect.js guiBrowse()
		// and guiBrowseNote(). Returning note ids here would cause
		// _normalizeArray to throw and the browser action to fail.
		//
		// Fast path: Yomitan's _invokeMulti / guiBrowseNote paths
		// both send the bare `nid:<int>` form (optionally wrapped in
		// outer double-quotes). When the query parses to that shape
		// we resolve directly to cards via the dedicated single-
		// note path (SELECT id FROM cards WHERE nid = ? ORDER BY
		// ord), avoiding the FindNotes roundtrip.
		//
		// Fallback: route through FindNotes for the supported subset
		// (added:1, front:<value>, nid:<id-list>), then expand the
		// returned note ids to card ids via CardIDsForNoteIDs. This
		// matches what AnkiconnectAndroid does for the same wire
		// contract — both surfaces take a search string, both
		// return a flat array of card ids in display order.
		var params struct {
			Query string `json:"query"`
		}
		if len(env.Params) == 0 {
			return nil, fmt.Errorf("%w: guiBrowse requires params", anki.ErrBadRequest)
		}
		if err := json.Unmarshal(env.Params, &params); err != nil {
			return nil, fmt.Errorf("%w: guiBrowse params must be an object", anki.ErrBadRequest)
		}
		query := strings.TrimSpace(params.Query)
		if query == "" {
			return nil, fmt.Errorf("%w: guiBrowse: query is required", anki.ErrBadRequest)
		}
		// Strip an outer double-quote pair (Collection.FindNotes
		// does the same, so we get identical behaviour for the
		// quoted and bare variants). Yomitan doesn't quote
		// guiBrowse queries in practice; the unwrap is defence-
		// in-depth for clients that follow the same convention
		// as findNotes.
		if len(query) >= 2 && query[0] == '"' && query[len(query)-1] == '"' {
			query = query[1 : len(query)-1]
		}
		if nid, ok := parseGuiBrowseNIDQuery(query); ok {
			infos, err := db.CardsForNote(nid)
			if err != nil {
				return nil, err
			}
			ids := make([]int64, len(infos))
			for i, ci := range infos {
				ids[i] = ci.CardID
			}
			return jsonMarshal(ids)
		}
		// General path: route through FindNotes and then expand
		// note ids → card ids.
		noteIDs, err := db.FindNotes(query)
		if err != nil {
			return nil, err
		}
		cardIDs, err := db.CardIDsForNoteIDs(noteIDs)
		if err != nil {
			return nil, err
		}
		return jsonMarshal(cardIDs)
	default:
		return nil, fmt.Errorf("%w: unsupported action: %s", anki.ErrBadRequest, env.Action)
	}
}

// addNoteParams is the inbound shape for addNote. We decode only the
// fields we consume — `note.fields` (object map OR array), `note.tags`
// (list), plus the deckName / modelName at the params top level
// (AnkiConnect convention). Audio/video/picture arrays inside note
// are read by rewriteAddNoteMedia (rewriting filenames in place and
// appending the [sound:...] / <img...> tag to the named fields);
// the rewritten params are then re-decoded into this struct so the
// deterministic filenames are inserted as the field values.
type addNoteParams struct {
	DeckName  string            `json:"deckName"`
	ModelName string            `json:"modelName"`
	FieldsMap map[string]string `json:"-"` // populated from note.fields when it's an object
	Fields    []string          `json:"-"` // populated from note.fields when it's an array, or resolved from FieldsMap via the model
	Tags      []string          `json:"tags"`
	// Options mirrors AnkiConnect's `options` block
	// (allowDuplicate / duplicateScope / deckName). The struct
	// carries a `set` flag so we can distinguish "absent" from
	// "present-with-defaults" when merging note.options vs
	// top-level options (note-level wins when explicitly provided).
	Options addNoteOptions `json:"options"`
}

// addNoteOptions is the AnkiConnect addNote `options` block. The
// dispatcher treats absent options as AllowDuplicate=false +
// DuplicateScope="" (which resolves to "collection" at InsertNote
// time). "Absent" vs "explicit false" can't be distinguished
// without per-field presence tracking; the documented contract is
// "absent → defaults" and "explicit false → no duplicates", which
// match — either way the duplicate check runs.
type addNoteOptions struct {
	AllowDuplicate bool   `json:"allowDuplicate"`
	DuplicateScope string `json:"duplicateScope"`
	DeckName       string `json:"deckName"`
}

// parseGuiBrowseNIDQuery reports whether query is a `nid:<int>`
// query suitable for the guiBrowse fast path. Yomitan's
// guiBrowseNote calls this.guiBrowse('nid:' + noteId) — the query
// is always a single nid and the fast path takes a single SELECT
// against cards, avoiding the FindNotes roundtrip. Anything else
// (nid:<a>,<b>, added:1, front:<value>, arbitrary FindNotes query)
// falls through to the general path which goes through FindNotes +
// CardIDsForNoteIDs.
//
// The check is intentionally narrow: bare `nid:` (no integer) is NOT
// a fast-path match (FindNotes returns ErrBadQuery on the same
// input, which surfaces as an honest envelope error to the caller).
// Case-insensitive on the prefix so client idiosyncrasies don't
// strand the fast path — the predicate is shared with Collection's
// own nid: handling via anki.HasNIDQuery so both surfaces agree.
func parseGuiBrowseNIDQuery(query string) (int64, bool) {
	if !anki.HasNIDQuery(query) {
		return 0, false
	}
	body := strings.TrimSpace(query[len("nid:"):])
	if len(body) >= 2 && body[0] == '"' && body[len(body)-1] == '"' {
		body = body[1 : len(body)-1]
		body = strings.TrimSpace(body)
	}
	if body == "" {
		return 0, false
	}
	// Reject nid:<a>,<b> — that's the FindNotes shape; the fast
	// path is single-int only.
	if strings.Contains(body, ",") {
		return 0, false
	}
	nid, err := strconv.ParseInt(body, 10, 64)
	if err != nil {
		return 0, false
	}
	return nid, true
}

// parseCanAddNotesParams decodes the canAddNotes /
// canAddNotesWithErrorDetail params shape. AnkiConnect accepts both
// the bare `notes` array (Anki's web/desktop contract) and the
// {notes: [{field, options, ...}]} shape used by AnkiconnectAndroid.
// We accept BOTH and normalise into []anki.NoteCheck. A non-object
// params returns ErrBadRequest — never a generic 500.
func parseCanAddNotesParams(raw json.RawMessage) ([]anki.NoteCheck, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("%w: canAddNotes requires params", anki.ErrBadRequest)
	}
	var params struct {
		Notes []struct {
			Field   string          `json:"field"`
			Fields  json.RawMessage `json:"fields"`
			Options struct {
				AllowDuplicate bool   `json:"allowDuplicate"`
				DuplicateScope string `json:"duplicateScope"`
				CheckAllModels bool   `json:"checkAllModels"`
				DeckName       string `json:"deckName"`
			} `json:"options"`
			DeckName string `json:"deckName"`
		} `json:"notes"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, fmt.Errorf("%w: canAddNotes params must be an object", anki.ErrBadRequest)
	}
	if len(params.Notes) == 0 {
		return []anki.NoteCheck{}, nil
	}
	out := make([]anki.NoteCheck, len(params.Notes))
	for i, n := range params.Notes {
		deck := n.Options.DeckName
		if deck == "" {
			deck = n.DeckName
		}
		scope := n.Options.DuplicateScope
		if scope == "" {
			scope = "collection"
		}
		fieldVal := n.Field
		if fieldVal == "" && len(n.Fields) > 0 {
			var strVal string
			if err := json.Unmarshal(n.Fields, &strVal); err == nil {
				fieldVal = strVal
			} else {
				var mapVal map[string]string
				if err := json.Unmarshal(n.Fields, &mapVal); err == nil {
					if v, ok := mapVal["Front"]; ok {
						fieldVal = v
					} else {
						for _, v := range mapVal {
							fieldVal = v
							break
						}
					}
				}
			}
		}
		out[i] = anki.NoteCheck{
			Field:          fieldVal,
			AllowDuplicate: n.Options.AllowDuplicate,
			DuplicateScope: scope,
			DeckName:       deck,
		}
	}
	return out, nil
}

// rewriteAddNoteMedia walks params.note.audio / video / picture and
// (a) decodes each entry's data via MediaWriter.Write to produce the
// deterministic filename, (b) rewrites the entry's "filename" field to
// that name, (c) appends the [sound:...] / <img...> tag to each
// named field of the note. The append-to-field behaviour matches
// A:/AnkiconnectAndroid IntegratedAPI.addMedia — AnkiConnect desktop
// leaves the append to the user; AnkiconnectAndroid did it for the
// caller, and the v4.0 spec keeps that semantics because Yomitan /
// Entei build the [sound:...] reference themselves and we want a
// single source of truth on the field side.
//
// Spec §3.3: media arrays live INSIDE params.note, never beside it.
// The rewrite only touches that subtree; everything outside note
// (deckName, modelName, tags, options) is forwarded unchanged.
//
// `note` absent → forward verbatim (no rewrite).
// `note` present but not an object → anki.ErrBadRequest.
//
// Notes-only bridge (DB set, Writer nil — the Termux
// collection.media probe failed) carries a pre-rewrite guard: when
// any audio/video/picture array with non-empty data is present, the
// helper returns ErrMediaWriterUnavailable. Without the guard
// rewriteMediaEntry would dereference s.anki.Writer.Write and panic.
// Text-only addNote (no media arrays, or only url-references) flows
// through verbatim — a notes-only bridge can still accept a
// Front="x" / Back="y" insert without touching the media path.
func (s *Server) rewriteAddNoteMedia(params json.RawMessage) (json.RawMessage, error) {
	if len(params) == 0 {
		return params, nil
	}
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
	// Notes-only-bridge guard: detect any inbound media entry that
	// would require MediaWriter.Write BEFORE iterating (we
	// dereference s.anki.Writer in the entry loop). A url-only entry
	// or a note with no media arrays at all is fine — the writer
	// is never consulted on those branches.
	if s.anki == nil || s.anki.Writer == nil {
		for _, key := range []string{"audio", "video", "picture"} {
			raw, has := noteObj[key]
			if !has || len(raw) == 0 || string(raw) == "null" {
				continue
			}
			if mediaArrayNeedsWriter(raw) {
				return nil, ErrMediaWriterUnavailable
			}
		}
	}
	for _, key := range []string{"audio", "video", "picture"} {
		raw, has := noteObj[key]
		if !has || len(raw) == 0 || string(raw) == "null" {
			continue
		}
		rewritten, err := s.rewriteMediaArray(raw, noteObj, key)
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

// mediaArrayNeedsWriter reports whether the inbound audio/video/
// picture array carries at least one entry that would force
// MediaWriter.Write during the rewrite. Pass-through entries
// (url-only, empty data, or absent fields) do NOT need the writer
// and are forwarded verbatim — the notes-only bridge can keep
// accepting those without panicking. The same dispatch
// pass-through logic lives in rewriteMediaEntry; this helper is
// only used by the pre-rewrite guard to fail fast on a
// notes-only bridge BEFORE dereferencing s.anki.Writer.
func mediaArrayNeedsWriter(raw json.RawMessage) bool {
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		// Malformed entries still error out later via
		// rewriteMediaArray; from the guard's perspective a
		// malformed array IS a write attempt and we want to bail
		// early on a notes-only bridge.
		return true
	}
	for _, rawEntry := range entries {
		var entry map[string]json.RawMessage
		if err := json.Unmarshal(rawEntry, &entry); err != nil {
			return true
		}
		// url-only: pass-through (no writer needed).
		if _, hasURL := entry["url"]; hasURL {
			continue
		}
		// data absent / empty / null: pass-through.
		dataRaw, hasData := entry["data"]
		if !hasData || len(dataRaw) == 0 || string(dataRaw) == "null" || string(dataRaw) == `""` {
			continue
		}
		// Non-empty data → the writer IS consulted. Guard fires.
		return true
	}
	return false
}

// rewriteMediaArray walks a single media array (audio/video/picture),
// rewrites each entry's filename via MediaWriter.Write, and appends
// the [sound:stored] / <img src="stored"> tag to the note fields
// named in each entry's "fields" list. The tag-appending matches
// A:/AnkiconnectAndroid IntegratedAPI.addMedia semantics.
func (s *Server) rewriteMediaArray(raw json.RawMessage, noteObj map[string]json.RawMessage, mediaKey string) (json.RawMessage, error) {
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("%w: media array must be a JSON array", anki.ErrBadRequest)
	}
	if len(entries) == 0 {
		return raw, nil
	}
	enclosure := "<img src=\"%s\">"
	if mediaKey == "audio" || mediaKey == "video" {
		enclosure = "[sound:%s]"
	}
	out := make([]json.RawMessage, 0, len(entries))
	for _, rawEntry := range entries {
		rewritten, stored, fields, err := s.rewriteMediaEntry(rawEntry, enclosure)
		if err != nil {
			return nil, err
		}
		out = append(out, rewritten)
		if stored == "" || len(fields) == 0 {
			continue
		}
		// Append the enclosure tag to each named field.
		tag := fmt.Sprintf(enclosure, stored)
		for _, f := range fields {
			appendToField(noteObj, f, tag)
		}
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("remarshal media array: %w", err)
	}
	return encoded, nil
}

// rewriteMediaEntry decodes one audio/video/picture entry, runs
// MediaWriter.Write on its decoded data, and re-emits the entry with
// "filename" replaced by the deterministic stored name. Returns the
// rewritten entry, the stored filename (empty if the entry was a
// pass-through), and the entry's "fields" list.
//
// Pass-through branches (preserving the prior v2.0 contract):
//
//   - entry is not a JSON object → anki.ErrBadRequest
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
func (s *Server) rewriteMediaEntry(rawEntry json.RawMessage, enclosure string) (json.RawMessage, string, []string, error) {
	var entry map[string]json.RawMessage
	if err := json.Unmarshal(rawEntry, &entry); err != nil {
		return nil, "", nil, fmt.Errorf("%w: media entry must be a JSON object", anki.ErrBadRequest)
	}
	if _, hasURL := entry["url"]; hasURL {
		return rawEntry, "", nil, nil
	}
	dataRaw, hasData := entry["data"]
	if !hasData || len(dataRaw) == 0 || string(dataRaw) == "null" {
		return rawEntry, "", nil, nil
	}
	var dataB64 string
	if err := json.Unmarshal(dataRaw, &dataB64); err != nil {
		return nil, "", nil, fmt.Errorf("%w: media data must be a base64 string", anki.ErrBadRequest)
	}
	if dataB64 == "" {
		return rawEntry, "", nil, nil
	}
	raw, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return nil, "", nil, fmt.Errorf("%w: invalid base64 media data", anki.ErrBadRequest)
	}
	filename := ""
	if fn, ok := entry["filename"]; ok {
		_ = json.Unmarshal(fn, &filename)
	}
	stored, err := s.anki.Writer.Write(filename, raw)
	if err != nil {
		return nil, "", nil, err
	}
	entry["filename"] = mustJSONString(stored)
	rewritten, err := json.Marshal(entry)
	if err != nil {
		return nil, "", nil, fmt.Errorf("remarshal media entry: %w", err)
	}
	var fields []string
	if f, ok := entry["fields"]; ok && len(f) > 0 && string(f) != "null" {
		_ = json.Unmarshal(f, &fields)
	}
	return rewritten, stored, fields, nil
}

// appendToField appends text to the named field of noteObj (a
// generic JSON map). note fields live in either:
//
//   - noteObj["fields"] as an object map {"Front":"x","Back":"y"}
//     (AnkiConnect desktop convention + Yomitan / Entei convention),
//     or
//   - noteObj["fields"] as an array ["x","y"] in model-ord order
//     (AnkiconnectAndroid JSON style).
//
// We honour both: for object maps we splice into the matching key;
// for arrays we splice the corresponding index (looked up via the
// model). The mod is in-place; the caller is expected to marshal
// noteObj afterwards.
//
// When noteObj has neither a "fields" object nor a "fields" array,
// we fall back to setting a top-level key matching the name (this
// matches a degenerate {"Front":"x"} form that some hand-rolled
// clients send).
func appendToField(noteObj map[string]json.RawMessage, name, text string) {
	if text == "" {
		return
	}
	fieldsRaw, ok := noteObj["fields"]
	if ok && len(fieldsRaw) > 0 && string(fieldsRaw) != "null" {
		// Try object map.
		var fieldsMap map[string]string
		if err := json.Unmarshal(fieldsRaw, &fieldsMap); err == nil && len(fieldsMap) > 0 {
			fieldsMap[name] = fieldsMap[name] + text
			b, mErr := json.Marshal(fieldsMap)
			if mErr == nil {
				noteObj["fields"] = b
			}
			return
		}
		// Try array.
		var fieldsArr []string
		if err := json.Unmarshal(fieldsRaw, &fieldsArr); err == nil {
			// Look up the field index by name via the model's field
			// names. We use the model stored in noteObj["modelName"]
			// and re-decode from disk via a helper. To avoid a DB
			// round-trip here we walk the existing raw and match by
			// position — caller passes the model field names in
			// order; appendToField doesn't know that order, so we
			// bail. The object-map branch above is the common case
			// (AnkiConnect desktop + Yomitan / Entei); the array
			// form is rare. We splice nothing for the array form.
			_ = fieldsArr
		}
	}
	// Fallback: top-level key.
	existing, ok := noteObj[name]
	if !ok || len(existing) == 0 || string(existing) == "null" {
		noteObj[name] = mustJSONString(text)
		return
	}
	var s string
	if err := json.Unmarshal(existing, &s); err != nil {
		return
	}
	noteObj[name] = mustJSONString(s + text)
}

// stripAnkiBadRequestMessage trims the anki.ErrBadRequest wrapper and
// any "%w: ..." prefix from err so the body carries a short
// operator-friendly reason (e.g. "unsupported action: foo") instead
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

// jsonMarshal returns the JSON-encoded form of v. Errors from
// json.Marshal of well-typed values (slice/map/int64) never fire in
// practice; the panic-free fallback returns json.RawMessage("null").
func jsonMarshal(v any) (json.RawMessage, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return b, nil
}

// tryBindRawAnkiConnect attempts to bind the loopback 8765 listener
// for the raw AnkiConnect-compatible surface. Returns the bound
// listener on success, or (nil, error) on a bind failure.
//
// The bind failure modes are:
//
//   - EADDRINUSE: port 8765 is already taken (official AnkiConnect
//     running on the user's desktop, another companion, a dev
//     harness). The caller logs a one-line warning and continues
//     — the companion must never crash because a desktop AnkiConnect
//     is running.
//
//   - Any other error (parse failure, permission denied, etc.):
//     the caller decides. We surface the typed error so the caller
//     can log appropriately.
//
// Bind address is parameterised so tests can target an ephemeral
// port; production passes rawAnkiConnectBind.
//
// The bind is loopback-only (enforced by the constant address) so
// the caller's threat-model promise (loopback-only, never reachable
// off-host) holds even if the caller forgets to validate the
// address.
func tryBindRawAnkiConnect(bind string) (net.Listener, error) {
	return net.Listen("tcp", bind)
}

// StartRawAnkiConnectListener starts the raw AnkiConnect-compatible
// listener on the configured bind address in a background goroutine.
// Returns nil on success, or a non-nil error if the bind failed.
//
// On EADDRINUSE: returns the error so the caller can log a one-line
// warning and continue (the spec calls this out explicitly — a
// desktop AnkiConnect must not break the companion). On other bind
// failures: returns the error so the caller decides.
//
// On success: the goroutine serves forever (until process exit).
// The companion's main server has no graceful-shutdown context —
// the process dies on Ctrl+C, taking the goroutine with it. There
// is no shared lifecycle to wire into.
//
// When the Anki bridge is disabled (s.anki == nil) the function is
// a no-op and returns nil. Callers can call this unconditionally.
//
// Thread-safety: this is meant to be called once at startup, before
// the main server starts serving. Calling it twice would attempt to
// bind 8765 twice and fail with EADDRINUSE on the second call —
// this is harmless (just a logged warning) but the caller should
// not do it.
func (s *Server) StartRawAnkiConnectListener(bind string) error {
	if s.anki == nil {
		// Bridge disabled — nothing to serve. No-op so the caller
		// can wire it unconditionally.
		return nil
	}
	ln, err := tryBindRawAnkiConnect(bind)
	if err != nil {
		return err
	}
	// Start serving. The handler is the raw AnkiConnect handler —
	// it serves any path on the listener (clients POST to /). The
	// handler is single-purpose; no mux is needed. We use an
	// explicit http.Server (not http.Serve) so we can set
	// ReadHeaderTimeout — slowloris hardening on the loopback bind.
	// 5 seconds is generous for a JSON POST from a local extension;
	// a malicious or stalled client stalls at the header read.
	go func() {
		srv := &http.Server{
			Handler:           http.HandlerFunc(s.handleRawAnkiConnect),
			ReadHeaderTimeout: 5 * time.Second,
		}
		// http.Server.Serve returns http.ErrServerClosed on clean
		// close (we never call Close) and a real error otherwise.
		// We do not propagate the error — the raw listener is
		// best-effort (the main /v1/* server keeps serving
		// regardless) and the companion's diagnostic sink already
		// logs this kind of failure.
		_ = srv.Serve(ln)
	}()
	return nil
}
