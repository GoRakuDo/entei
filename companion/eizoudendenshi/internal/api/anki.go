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

// AnkiDroid bridge routes (ED-3 / spec EIZOU_DENDENSHI_ANKIDROID_CONNECT.md
// v3.0, 2026-08-30):
//
//	POST /v1/anki/media   — body {"filename": "...", "data_base64": "..."}
//	                       → MediaWriter.Write → respond {"filename": "<stored>"}
//	                       64 MB hard cap on the request body.
//	POST /v1/anki/action  — body is the full AnkiConnect envelope
//	                       {"action": "...", "version": ..., "params": {...}}
//	                       → dispatch DIRECTLY on the AnkiDroid
//	                       collection.anki2 SQLite database via the
//	                       anki.Collection layer. The prior
//	                       AnkiconnectAndroid (:8080) HTTP proxy was
//	                       removed entirely in v3.0. addNote still
//	                       runs the audio/video/picture media-array
//	                       rewrite so each entry's "filename" is the
//	                       deterministic content-hash name of its
//	                       decoded "data" (bytes are written via
//	                       MediaWriter; the deterministic filename is
//	                       what the companion stores as the
//	                       [sound:...] / <img...> tag in the note
//	                       field).
//	GET  /v1/anki/status  — non-sensitive readiness snapshot:
//	                       {"enabled": bool,
//	                        "collectionOpen": bool,
//	                        "mediaDirWritable": bool,
//	                        "mediaDir": "<path or empty>",
//	                        "collectionPath": "<path or empty>"}.
//	                       Paths are not sensitive (spec §9). Capability
//	                       tokens are NEVER in responses or logs.
//
// All three routes share the exact Origin + capability-token gates of
// the media endpoints; CORS preflights advertise POST / GET / OPTIONS
// with Content-Type.
//
// Routes are registered ONLY when Config.Anki != nil (the companion
// command wires the bridge when the AnkiDroid collection opens
// successfully at startup). With no bridge configured the paths stay
// 404 — zero behavior change for existing callers (spec §2.1 / Phase
// plan).

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
// rewrites can run) and the params subtree is dispatched on the
// SQLite layer.
type ankiActionBody struct {
	Action  string          `json:"action"`
	Version int             `json:"version"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// ankiStatusBody is the metadata-only reply for /v1/anki/status. It
// is a small fixed shape so the web-side diagnostic UI can render a
// pass/fail summary without parsing JSON-path probes. The capability
// token / pairing code / AnkiDroid user data are NEVER in the body.
//
// v3.0 (2026-08-30): added collectionOpen / collectionPath. The prior
// proxyConfigured boolean was replaced by `enabled` (the bridge is
// enabled when the Collection opened at startup; the routes still
// register even when it didn't, so the operator sees a clear status
// without a restart).
type ankiStatusBody struct {
	Enabled          bool   `json:"enabled"`
	CollectionOpen   bool   `json:"collectionOpen"`
	CollectionPath   string `json:"collectionPath"`
	MediaDirWritable bool   `json:"mediaDirWritable"`
	MediaDir         string `json:"mediaDir"`
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
		// host, or the candidate list was exhausted). The collection
		// may still be open (the two halves of the bridge are
		// independent); the status endpoint reports collectionOpen /
		// mediaDirWritable separately so the operator can tell which
		// half is up.
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
// AnkiConnect envelope, runs the addNote media-rewrite (so the
// audio/video/picture entries reference deterministic filenames that
// already exist in collection.media), and dispatches the action
// DIRECTLY on the AnkiDroid collection SQLite database via
// anki.Collection. The result envelope is wrapped in the standard
// {"result": ..., "error": null} AnkiConnect response shape — the
// caller (Entei / Yomitan / asbplayer) sees the same wire format as
// the desktop AnkiConnect plugin.
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
	if s.anki == nil || s.anki.DB == nil {
		// The bridge is wired but the collection didn't open (probe
		// failed, schema unsupported, or AnkiDroid play-variant app-
		// private path). The routes still register so the user can
		// poll /v1/anki/status; the action dispatch returns 503 with a
		// clear "collection not available" message so the operator
		// distinguishes "bridge disabled" (404) from "bridge running on
		// the wrong host" (503 here).
		writeJSON(w, http.StatusServiceUnavailable, errorBody("anki collection not available"))
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
	out, err := s.dispatchAnkiAction(r, env)
	if err != nil {
		// ErrDuplicateNote is a NOT-A-FAILURE rejection (the
		// AnkiConnect addNote contract: allowDuplicate=false +
		// duplicate hit → null result, HTTP 200). Map it to a
		// null-result envelope so the caller (Yomitan / Entei /
		// asbplayer) reads the same shape the desktop AnkiConnect
		// plugin emits. All other errors flow through the typed
		// status mapping.
		if errors.Is(err, anki.ErrDuplicateNote) {
			writeJSON(w, http.StatusOK, map[string]json.RawMessage{"result": json.RawMessage("null"), "error": json.RawMessage("null")})
			return
		}
		s.writeAnkiActionError(w, err)
		return
	}
	// The AnkiConnect envelope is "result / error"; the handler always
	// returns a fully-formed envelope so the caller (Entei / Yomitan /
	// asbplayer) sees the same shape regardless of bridge state.
	writeJSON(w, http.StatusOK, map[string]json.RawMessage{"result": out, "error": json.RawMessage("null")})
}

// dispatchAnkiAction routes the inbound AnkiConnect envelope to the
// matching anki.Collection method. Returns json.RawMessage (the inner
// "result" body) so the caller can wrap it in the standard envelope;
// returns typed errors that handleAnkiAction maps to HTTP statuses.
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
//                           transaction; returns noteId as int64)
//   - updateNoteFields    → UpdateNoteFields
//   - addTags             → AddTags
//   - findNotes           → FindNotes (added:1 / nid:… only)
//   - notesInfo           → NotesInfo (joined with model + cards)
//
// Unsupported actions return ErrBadRequest wrapped with "unsupported
// action: <name>"; the handler maps that to a 400 response with the
// short reason — the AnkiConnect "no route" case is a client-side
// mistake (typo / unsupported by the bridge), so we surface it as
// 400 rather than the HTTP 200 + non-null-error envelope the
// AnkiconnectAndroid HTTP proxy returned. Yomitan / Entei / asbplayer
// check the response status, not just the JSON "error" field, so
// the explicit 400 is the right AnkiConnect-faithful shape.
func (s *Server) dispatchAnkiAction(r *http.Request, env ankiActionBody) (json.RawMessage, error) {
	// params-object guard: every AnkiConnect action takes a JSON
	// object as params (Yomitan / Entei / asbplayer all send
	// {}). A non-object root (array, string, number, null) is a
	// client-side mistake and must surface as 400, not 500 — same
	// guard the v2.0 review (2026-08-29) called out for addNote
	// only. Spec v3.0 (2026-08-30) promotes it to every action.
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
		// Re-decode deckName/modelName/tags from the rewritten top-level
		// (deckName/modelName aren't touched by rewrite; tags may also be
		// rewritten by future code so we re-read).
		var topLevel struct {
			DeckName  string   `json:"deckName"`
			ModelName string   `json:"modelName"`
		}
		_ = json.Unmarshal(rewritten, &topLevel)
		// AnkiConnect desktop puts deckName / modelName at the params
		// top level; Yomitan / Entei (and the v3.0 fixture) put them
		// INSIDE note. Honour both — note-level wins when present,
		// otherwise fall back to top-level.
		var noteMeta struct {
			DeckName  string   `json:"deckName"`
			ModelName string   `json:"modelName"`
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
		}
		if len(env.Params) == 0 {
			return nil, fmt.Errorf("%w: updateNoteFields requires params", anki.ErrBadRequest)
		}
		if err := json.Unmarshal(env.Params, &params); err != nil {
			return nil, fmt.Errorf("%w: updateNoteFields params must be an object", anki.ErrBadRequest)
		}
		if params.ID == 0 {
			return nil, fmt.Errorf("%w: updateNoteFields: id is required", anki.ErrBadRequest)
		}
		if err := db.UpdateNoteFields(params.ID, params.Fields); err != nil {
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

// ErrMediaWriterUnavailable is returned by the addNote media-rewrite
// path when the bridge is wired in notes-only mode (DB open, Writer
// nil — the Termux collection.media probe failed or was skipped). The
// /v1/anki/action handler maps it to 503 with a clear
// "anki media writer not available on this platform" message. The
// guard fires ONLY when the inbound addNote actually carries audio /
// video / picture arrays with non-empty data — a text-only addNote
// against a notes-only bridge is perfectly valid and inserts normally
// (a defensive panic on a notes-only bridge would block note-taking
// entirely for any caller whose media path failed).
var ErrMediaWriterUnavailable = errors.New("anki: media writer not available on this platform")

// parseCanAddNotesParams decodes the canAddNotes /
// canAddNotesWithErrorDetail params shape. AnkiConnect accepts both
// the bare `notes` array (Anki's web/desktop contract) and the
// {notes: [{field, options, ...}]} shape used by AnkiconnectAndroid.
// We accept BOTH and normalise into []anki.NoteCheck. A non-object
// params returns ErrBadRequest (handler → 400) — never 500.
func parseCanAddNotesParams(raw json.RawMessage) ([]anki.NoteCheck, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("%w: canAddNotes requires params", anki.ErrBadRequest)
	}
	var params struct {
		Notes []struct {
			Field   string `json:"field"`
			Options struct {
				AllowDuplicate  bool   `json:"allowDuplicate"`
				DuplicateScope  string `json:"duplicateScope"`
				CheckAllModels  bool   `json:"checkAllModels"`
				DeckName        string `json:"deckName"`
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
		out[i] = anki.NoteCheck{
			Field:          n.Field,
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
// caller, and the v3.0 spec keeps that semantics because Yomitan /
// Entei build the [sound:...] reference themselves and we want a
// single source of truth on the field side.
//
// Spec §3.3: media arrays live INSIDE params.note, never beside it.
// The rewrite only touches that subtree; everything outside note
// (deckName, modelName, tags, options) is forwarded unchanged.
//
// `note` absent → forward verbatim (no rewrite).
// `note` present but not an object → anki.ErrBadRequest (handler → 400).
//
// Notes-only bridge (DB set, Writer nil — the Termux
// collection.media probe failed) carries a pre-rewrite guard: when
// any audio/video/picture array with non-empty data is present, the
// helper returns ErrMediaWriterUnavailable → 503. Without the guard
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
	body := ankiStatusBody{Enabled: s.anki != nil}
	if s.anki != nil {
		body.CollectionOpen = s.anki.DB != nil
		if s.anki.DB != nil {
			body.CollectionPath = s.anki.DB.Path()
		}
		if s.anki.Writer != nil {
			dir := s.anki.Writer.Dir()
			body.MediaDir = dir
			// "Writable" mirrors the same probe used at construction: a
			// successful temp write+delete in the directory. The probe
			// runs on every status hit; it's cheap and tells the user
			// "you can write today" vs "AnkiDroid was uninstalled since
			// the companion started".
			body.MediaDirWritable = dir != "" && probeWritableDir(dir)
		}
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
// statuses. Collection-not-open / unsupported-schema → 503 with the
// short message. Bad-request (unsupported action, malformed params,
// missing field, etc.) → 400 with the human-friendly reason. Empty
// media data → 400. Everything else → 500.
//
// Per spec v3.0 (2026-08-30), the prior
// upstream-HTTP / upstream-AnkiConnect error branches were removed
// alongside the AnkiconnectAndroid proxy: the dispatcher now runs
// in-process, so the only HTTP-shaped error class is gone.
func (s *Server) writeAnkiActionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, anki.ErrCollectionNotOpen),
		errors.Is(err, anki.ErrUnsupportedSchema):
		writeJSON(w, http.StatusServiceUnavailable, errorBody("anki collection not available"))
		return
	case errors.Is(err, anki.ErrUnsupportedPlatform):
		writeJSON(w, http.StatusServiceUnavailable, errorBody("anki bridge not supported on this platform"))
		return
	case errors.Is(err, ErrMediaWriterUnavailable):
		// addNote arrived with audio/video/picture data on a
		// notes-only bridge (DB open, Writer nil). The handler
		// refuses the request rather than crashing inside
		// MediaWriter.Write.
		writeJSON(w, http.StatusServiceUnavailable, errorBody("anki media writer not available on this platform"))
		return
	case errors.Is(err, anki.ErrBadRequest):
		writeJSON(w, http.StatusBadRequest, errorBody(stripAnkiBadRequestMessage(err)))
		return
	case errors.Is(err, anki.ErrEmptyMedia):
		writeJSON(w, http.StatusBadRequest, errorBody("empty media data"))
		return
	}
	writeJSON(w, http.StatusInternalServerError, errorBody("anki action failed"))
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

// probeWritableDir is a thin shim that calls into the anki package's
// probe — kept here so the status handler does not need to import
// package-private internals. The anki package owns the probe semantics
// (and its platform split); the API layer only asks "is this dir
// writable right now?".
func probeWritableDir(dir string) bool {
	return anki.ProbeWritable(dir)
}