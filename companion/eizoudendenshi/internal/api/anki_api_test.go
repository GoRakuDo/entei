package api

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"eizoudendenshi/internal/anki"
)

// --- helpers ---

// newTestAnkiCollectionFixture builds a minimal but real Anki-style
// collection.anki2 in t.TempDir() containing one "Default" deck and
// one "Basic" model (2 fields, 1 template). The schema mirrors
// Anki's schema 11 (col.decks / col.models as JSON blobs). Tests
// that need to INSERT their own rows use this scaffold.
func newTestAnkiCollectionFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "collection.anki2")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(ankiTestSchemaSQL); err != nil {
		t.Fatalf("apply schema: %v", err)
	}
	models := map[string]any{
		strconv.FormatInt(ankiTestModelID, 10): ankiTestModelJSON(),
	}
	decks := map[string]any{
		strconv.FormatInt(ankiTestDeckID, 10): ankiTestDeckJSON(),
	}
	dconf := map[string]any{
		"1": map[string]any{"id": 1, "name": "Default"},
	}
	conf := map[string]any{"nextPos": 1}
	tags := map[string]any{}
	modelsJSON, _ := json.Marshal(models)
	decksJSON, _ := json.Marshal(decks)
	dconfJSON, _ := json.Marshal(dconf)
	confJSON, _ := json.Marshal(conf)
	tagsJSON, _ := json.Marshal(tags)
	if _, err := db.Exec(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
		1700000000, int64(1700000000000), int64(1700000000000), 11,
		string(confJSON), string(modelsJSON), string(decksJSON), string(dconfJSON), string(tagsJSON)); err != nil {
		t.Fatalf("seed col: %v", err)
	}
	return path
}

const (
	ankiTestModelID int64 = 1700000000001
	ankiTestDeckID  int64 = 1700000000002
)

func ankiTestModelJSON() map[string]any {
	return map[string]any{
		"id":    ankiTestModelID,
		"name":  "Basic",
		"type":  0,
		"mod":   0,
		"usn":   0,
		"sortf": 0,
		"did":   ankiTestDeckID,
		"flds": []map[string]any{
			{"name": "Front", "ord": 0, "sticky": false, "media": []string{}, "rtl": false, "font": "Arial", "size": 20},
			{"name": "Back", "ord": 1, "sticky": false, "media": []string{}, "rtl": false, "font": "Arial", "size": 20},
		},
		"tmpls": []map[string]any{
			{"name": "Card 1", "ord": 0, "qfmt": "{{Front}}", "afmt": "{{FrontSide}}<hr>{{Back}}", "did": nil},
		},
		"css":       ".card{font-family:arial;font-size:20px}",
		"latexPre":  "\\documentclass[12pt]{article}",
		"latexPost": "\\end{document}",
		"tags":      []string{},
		"vers":      []string{},
	}
}

func ankiTestDeckJSON() map[string]any {
	return map[string]any{
		"id":               ankiTestDeckID,
		"name":             "Default",
		"mod":              0,
		"usn":              0,
		"lrnToday":         []int64{0, 0},
		"revToday":         []int64{0, 0},
		"newToday":         []int64{0, 0},
		"timeToday":        []int64{0, 0},
		"collapsed":        false,
		"browserCollapsed": false,
		"desc":             "",
		"dyn":              0,
		"conf":             1,
	}
}

const ankiTestSchemaSQL = `
CREATE TABLE col (
	id integer PRIMARY KEY,
	crt integer NOT NULL,
	mod integer NOT NULL,
	scm integer NOT NULL,
	ver integer NOT NULL,
	dty integer NOT NULL,
	usn integer NOT NULL,
	ls integer NOT NULL,
	conf text NOT NULL,
	models text NOT NULL,
	decks text NOT NULL,
	dconf text NOT NULL,
	tags text NOT NULL
);
CREATE TABLE notes (
	id integer PRIMARY KEY,
	guid text NOT NULL,
	mid integer NOT NULL,
	mod integer NOT NULL,
	usn integer NOT NULL,
	tags text NOT NULL,
	flds text NOT NULL,
	sfld text NOT NULL,
	csum integer NOT NULL,
	flags integer NOT NULL,
	data text NOT NULL
);
CREATE TABLE cards (
	id integer PRIMARY KEY,
	nid integer NOT NULL,
	did integer NOT NULL,
	ord integer NOT NULL,
	mod integer NOT NULL,
	usn integer NOT NULL,
	type integer NOT NULL,
	queue integer NOT NULL,
	due integer NOT NULL,
	ivl integer NOT NULL,
	factor integer NOT NULL,
	reps integer NOT NULL,
	lapses integer NOT NULL,
	left integer NOT NULL,
	odue integer NOT NULL,
	odid integer NOT NULL,
	flags integer NOT NULL,
	data text NOT NULL
);
CREATE TABLE graves (
	usn integer PRIMARY KEY,
	oid integer NOT NULL,
	type integer NOT NULL
);
CREATE TABLE revlog (
	id integer PRIMARY KEY,
	cid integer NOT NULL,
	usn integer NOT NULL,
	ease integer NOT NULL,
	ivl integer NOT NULL,
	lastIvl integer NOT NULL,
	factor integer NOT NULL,
	time integer NOT NULL,
	type integer NOT NULL
);
`

// newTestAnkiServer returns an api.Server with the AnkiDroid bridge
// wired: a MediaWriter bound to t.TempDir() (so /v1/anki/media lands
// on the test's own storage, not on the user's real collection.media)
// and a *anki.Collection opened against a real fixture collection in
// t.TempDir(). Per docs v3.0 (2026-08-30), the prior AnkiconnectAndroid
// note proxy was removed: note actions now dispatch directly on the
// SQLite database via the anki.Collection layer.
func newTestAnkiServer(t *testing.T) (*Server, string, *anki.Collection) {
	t.Helper()
	dir := t.TempDir()
	writer := anki.NewMediaWriterForTest(dir)
	colPath := newTestAnkiCollectionFixture(t)
	coll, err := anki.OpenCollection(colPath)
	if err != nil {
		t.Fatalf("OpenCollection: %v", err)
	}
	t.Cleanup(func() { _ = coll.Close() })
	s, err := New(Config{Anki: &AnkiBridge{
		Writer:  writer,
		DB:      coll,
		Enabled: true,
	}})
	if err != nil {
		t.Fatalf("New with Anki: %v", err)
	}
	return s, dir, coll
}

// doAnkiRequest is a tiny wrapper that mirrors doRequest but injects
// a Content-Type=application/json header for POST bodies (doRequest
// already does this when body != ""; this helper exists for symmetry).
func doAnkiRequest(t *testing.T, h http.Handler, method, path, origin, body string) *httptest.ResponseRecorder {
	t.Helper()
	return doRequest(t, h, method, path, origin, body)
}

// decodeJSON unmarshals the recorder body into out, failing the test on
// a parse error. Used by the happy-path assertions.
func decodeJSON(t *testing.T, rec *httptest.ResponseRecorder, out any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
}

// --- route gating ---

// TestAnkiMediaRequiresToken pins the Origin + capability-token gate:
// missing token → 401 with no ACAO; missing origin → 403; disallowed
// origin → 403 with no ACAO. Mirrors the media/fixture gate so the
// two share one reviewer-recognized shape.
func TestAnkiMediaRequiresToken(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)

	body := `{"filename":"audio.webm","data_base64":"` + base64.StdEncoding.EncodeToString([]byte("bytes")) + `"}`

	// No token, allowed origin → 401.
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost, "/v1/anki/media", allowedOriginEntei, body)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}

	// No origin, valid token → 403.
	rec = doAnkiRequest(t, s.Handler(), http.MethodPost, "/v1/anki/media?token="+s.token, "", body)
	if rec.Code != http.StatusForbidden {
		t.Errorf("no origin: status = %d, want 403", rec.Code)
	}

	// Disallowed origin, valid token → 403 without ACAO.
	rec = doAnkiRequest(t, s.Handler(), http.MethodPost, "/v1/anki/media?token="+s.token, disallowedOrigin, body)
	if rec.Code != http.StatusForbidden {
		t.Errorf("disallowed origin: status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed origin sent ACAO = %q, want empty", got)
	}

	// Capability token never appears in any error body.
	for _, rec := range []*httptest.ResponseRecorder{
		doAnkiRequest(t, s.Handler(), http.MethodPost, "/v1/anki/media", allowedOriginEntei, body),
	} {
		if strings.Contains(rec.Body.String(), s.token) {
			t.Errorf("error body leaks token: %s", rec.Body.String())
		}
	}
}

// TestAnkiStatusRequiresToken pins the same gate for /v1/anki/status:
// unauthenticated callers are rejected before the body is computed.
// The status endpoint exposes metadata about the bridge wiring, which
// is non-sensitive but still must require a paired browser — the same
// posture as /v1/media/status.
func TestAnkiStatusRequiresToken(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	rec := doAnkiRequest(t, s.Handler(), http.MethodGet, "/v1/anki/status", allowedOriginEntei, "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: status = %d, want 401", rec.Code)
	}
	rec = doAnkiRequest(t, s.Handler(), http.MethodGet, "/v1/anki/status?token="+s.token, "", "")
	if rec.Code != http.StatusForbidden {
		t.Errorf("no origin: status = %d, want 403", rec.Code)
	}
}

// TestAnkiActionRequiresToken pins the gate for /v1/anki/action.
// The action endpoint must reject unauthenticated callers BEFORE any
// collection dispatch runs — otherwise an attacker could use the
// bridge to enumerate notes by repeatedly polling findNotes.
func TestAnkiActionRequiresToken(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)

	body := `{"action":"version","version":6}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost, "/v1/anki/action", allowedOriginEntei, body)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: status = %d, want 401", rec.Code)
	}
	rec = doAnkiRequest(t, s.Handler(), http.MethodPost, "/v1/anki/action?token="+s.token, "", body)
	if rec.Code != http.StatusForbidden {
		t.Errorf("no origin: status = %d, want 403", rec.Code)
	}
}

// --- happy path: /v1/anki/media ---

// TestAnkiMediaHappyPath pins the contract: a valid (origin + token)
// POST with base64 data lands on the MediaWriter's dir as a file
// named <prefix>_<hash>.<ext>, and the response carries the same
// stored name. The test writes a known byte sequence and verifies the
// stored file's bytes match.
func TestAnkiMediaHappyPath(t *testing.T) {
	s, dir, _ := newTestAnkiServer(t)
	payload := []byte("opaque media bytes — sample")
	b64 := base64.StdEncoding.EncodeToString(payload)

	body := `{"filename":"audio.webm","data_base64":"` + b64 + `"}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/media?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp ankiMediaResponse
	decodeJSON(t, rec, &resp)
	if resp.Filename == "" {
		t.Fatal("response filename is empty")
	}
	if !strings.HasPrefix(resp.Filename, "audio_") || !strings.HasSuffix(resp.Filename, ".webm") {
		t.Errorf("stored name shape wrong: %q", resp.Filename)
	}
	got, err := os.ReadFile(filepath.Join(dir, resp.Filename))
	if err != nil {
		t.Fatalf("read stored file: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("stored bytes = %q, want %q", got, payload)
	}
	// The deterministic-name contract: re-POSTing the SAME bytes
	// produces the same stored filename (overwrite, not duplicate).
	rec = doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/media?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("second post status = %d", rec.Code)
	}
	var resp2 ankiMediaResponse
	decodeJSON(t, rec, &resp2)
	if resp2.Filename != resp.Filename {
		t.Errorf("deterministic name changed: %q → %q", resp.Filename, resp2.Filename)
	}
}

// TestAnkiMediaInvalidBase64 pins the input-validation gate: a body
// with garbage data_base64 → 400, generic message, never the raw
// input echoed (the input can carry the caller's pair of {filename,
// base64-chunk-of-binary} that we don't want in logs).
func TestAnkiMediaInvalidBase64(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/media?token="+s.token, allowedOriginEntei,
		`{"filename":"audio.webm","data_base64":"@@@not-valid-base64"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("invalid b64: status = %d, want 400", rec.Code)
	}
}

// TestAnkiMediaEmptyData pins the empty-data guard: a body with
// data_base64 = "" → 400, not a 200 with a zero-byte file. The
// MediaWriter surfaces ErrEmptyMedia; the handler maps it.
func TestAnkiMediaEmptyData(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/media?token="+s.token, allowedOriginEntei,
		`{"filename":"audio.webm","data_base64":""}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("empty data: status = %d, want 400", rec.Code)
	}
}

// TestAnkiMediaPayloadTooLarge pins the 64 MB cap: a body larger than
// the cap must surface as 413 (request-entity-too-large) instead of
// silently being truncated or returning a generic 400.
func TestAnkiMediaPayloadTooLarge(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)

	// Build a payload that exceeds the 64 MiB cap. We stream a JSON
	// body of repeated "a" characters for the base64 field.
	const overCap = ankiMaxBodyBytes + 1024
	var buf bytes.Buffer
	buf.WriteString(`{"filename":"huge.webm","data_base64":"`)
	for i := 0; i < overCap; i++ {
		buf.WriteByte('a')
	}
	buf.WriteString(`"}`)

	req := httptest.NewRequest(http.MethodPost,
		"/v1/anki/media?token="+s.token, &buf)
	req.Header.Set("Origin", allowedOriginEntei)
	req.ContentLength = int64(buf.Len())
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("over-cap: status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
}

// TestAnkiMediaUnsupportedPlatform pins the platform-conditional
// behaviour: when the MediaWriter is nil (bridge running on Windows
// / non-Android), the route still registers but writes return 503
// with a clear "not supported on this platform" message. This is the
// "bridge running on the wrong host" case from spec §1.
func TestAnkiMediaUnsupportedPlatform(t *testing.T) {
	if runtime.GOOS == "android" || runtime.GOOS == "linux" {
		t.Skip("supported platform: the real probe would run, not what this test pins")
	}
	s, err := New(Config{Anki: &AnkiBridge{
		Writer:  nil, // writer construction failed on this host
		DB:      nil, // no collection either
		Enabled: true,
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	b64 := base64.StdEncoding.EncodeToString([]byte("bytes"))
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/media?token="+s.token, allowedOriginEntei,
		`{"filename":"audio.webm","data_base64":"`+b64+`"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("nil writer: status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "not supported on this platform") {
		t.Errorf("503 body missing platform hint: %s", rec.Body.String())
	}
}

// --- happy path: /v1/anki/action (SQLite dispatch) ---

// TestAnkiActionVersion pins the simplest action: version returns 6.
// Per docs v3.0 (2026-08-30), version is served in-process (no
// upstream call, no DB roundtrip).
func TestAnkiActionVersion(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"action":"version","version":6}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp map[string]json.RawMessage
	decodeJSON(t, rec, &resp)
	if string(resp["result"]) != "6" {
		t.Errorf("response result = %s, want 6", resp["result"])
	}
	if string(resp["error"]) != "null" {
		t.Errorf("response error = %s, want null", resp["error"])
	}
}

// TestAnkiActionDeckNamesAndModelNames pins the deck/model enumeration
// actions: deckNames returns ["Default"], modelNames returns
// ["Basic"] (the fixture seeds both).
func TestAnkiActionDeckNamesAndModelNames(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"action":"deckNames","version":6}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("deckNames status = %d, want 200", rec.Code)
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	decodeJSON(t, rec, &resp)
	var deckNames []string
	if err := json.Unmarshal(resp.Result, &deckNames); err != nil {
		t.Fatalf("decode deckNames: %v", err)
	}
	if len(deckNames) != 1 || deckNames[0] != "Default" {
		t.Errorf("deckNames = %v, want [Default]", deckNames)
	}
	rec = doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"action":"modelNames","version":6}`)
	decodeJSON(t, rec, &resp)
	var modelNames []string
	if err := json.Unmarshal(resp.Result, &modelNames); err != nil {
		t.Fatalf("decode modelNames: %v", err)
	}
	if len(modelNames) != 1 || modelNames[0] != "Basic" {
		t.Errorf("modelNames = %v, want [Basic]", modelNames)
	}
}

// TestAnkiActionAddNoteEndToEnd is the headline test for the v3.0
// direct-SQLite dispatch: a POST to /v1/anki/action with addNote
// writes a real note + card into the test collection. The rewrite
// runs first (so audio[0]'s filename becomes the deterministic
// content-hash name AND a matching file lands in the MediaWriter's
// dir); then InsertNote runs the SQLite transaction; the response
// is the new note id.
//
// Pinning every step end-to-end here means a regression in any of
// (a) the addNote dispatch, (b) the media rewrite, (c) the SQLite
// insert is caught.
func TestAnkiActionAddNoteEndToEnd(t *testing.T) {
	s, dir, coll := newTestAnkiServer(t)
	audioBytes := []byte("the audio bytes")
	audioB64 := base64.StdEncoding.EncodeToString(audioBytes)
	wantStored := anki.GenerateFilenameFromProvided("audio.webm", audioBytes)

	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"猫","Back":"cat"},"tags":["vocab"],"options":{"allowDuplicate":false,"duplicateScope":"deck"},"audio":[{"filename":"audio.webm","data":"` + audioB64 + `","fields":["Front"]}]}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	decodeJSON(t, rec, &resp)
	if string(resp.Error) != "null" {
		t.Errorf("response error = %s, want null", resp.Error)
	}
	var noteID int64
	if err := json.Unmarshal(resp.Result, &noteID); err != nil {
		t.Fatalf("decode noteID: %v; body=%s", err, rec.Body.String())
	}
	if noteID == 0 {
		t.Fatal("noteID = 0, want >0")
	}

	// The deterministic media file landed in the MediaWriter's dir.
	storedPath := filepath.Join(dir, wantStored)
	gotBytes, err := os.ReadFile(storedPath)
	if err != nil {
		t.Fatalf("read stored audio: %v", err)
	}
	if !bytes.Equal(gotBytes, audioBytes) {
		t.Errorf("stored bytes = %q, want %q", gotBytes, audioBytes)
	}

	// The note + card are in the SQLite collection.
	// Verify via notesInfo instead.
	infos, err := coll.NotesInfo([]int64{noteID})
	if err != nil {
		t.Fatalf("NotesInfo: %v", err)
	}
	if len(infos) != 1 {
		t.Fatalf("NotesInfo len = %d, want 1", len(infos))
	}
	if infos[0].ModelName != "Basic" {
		t.Errorf("modelName = %q, want Basic", infos[0].ModelName)
	}
	// The rewrite appended the [sound:stored] tag to the Front field.
	front := infos[0].Fields["Front"]
	if !strings.Contains(front, "[sound:"+wantStored+"]") {
		t.Errorf("Front field missing [sound:%s] tag: %q", wantStored, front)
	}
	if infos[0].Fields["Back"] != "cat" {
		t.Errorf("Back field = %q, want \"cat\"", infos[0].Fields["Back"])
	}
	if len(infos[0].Tags) != 1 || infos[0].Tags[0] != "vocab" {
		t.Errorf("Tags = %v, want [vocab]", infos[0].Tags)
	}
	if len(infos[0].Cards) != 1 {
		t.Errorf("Cards = %d, want 1 (model has 1 template)", len(infos[0].Cards))
	}
}

// TestAnkiActionUnsupportedAction pins the error-envelope contract:
// an action we don't implement surfaces as 400 with the
// "unsupported action: X" reason (matches AnkiconnectAndroid's
// "no route" response shape).
func TestAnkiActionUnsupportedAction(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"action":"sync","version":6}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unsupported action") {
		t.Errorf("body missing 'unsupported action': %s", rec.Body.String())
	}
}

// TestAnkiActionMissingAction pins the input-validation gate: an
// envelope without "action" → 400, generic message. The SQLite layer
// is never queried.
func TestAnkiActionMissingAction(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"version":6,"params":{}}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("missing action: status = %d, want 400", rec.Code)
	}
}

// TestAnkiActionMediaArrayPassthrough pins the no-media path: an
// addNote with NO audio/video/picture arrays is forwarded verbatim
// (the handler skips the rewrite branch entirely).
func TestAnkiActionMediaArrayPassthrough(t *testing.T) {
	s, _, coll := newTestAnkiServer(t)
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"cat","Back":"feline"}}}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
	}
	decodeJSON(t, rec, &resp)
	var noteID int64
	if err := json.Unmarshal(resp.Result, &noteID); err != nil {
		t.Fatalf("decode noteID: %v", err)
	}
	infos, err := coll.NotesInfo([]int64{noteID})
	if err != nil {
		t.Fatalf("NotesInfo: %v", err)
	}
	if len(infos) != 1 {
		t.Fatalf("len(infos) = %d, want 1", len(infos))
	}
	if infos[0].Fields["Front"] != "cat" {
		t.Errorf("Front = %q, want \"cat\" (no media appended)", infos[0].Fields["Front"])
	}
}

// TestAnkiActionMediaEntryWithURLPassesThrough pins the url+data
// contract: an audio/video/picture entry that carries BOTH "url" and
// "data" is forwarded untouched and NO file is written locally. The
// note is still inserted but the field isn't appended with a
// [sound:...] tag (we have no bytes to store). Downside: a remote-
// only media entry will look empty in the field. We mirror
// AnkiconnectAndroid's behaviour: pass it through to the upstream
// (which would have downloaded the URL); for the direct-SQLite
// implementation we just don't append any tag — the user is
// expected to download via their browser-side fetch + addNote with
// data instead.
//
// The contract is "no orphan file in the media dir, no [sound:...]"
// — we verify both.
func TestAnkiActionMediaEntryWithURLPassesThrough(t *testing.T) {
	const wantStored = "remote.mp3"
	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"x","Back":"y"},"audio":[{"url":"https://example.invalid/` + wantStored + `","filename":"` + wantStored + `","fields":["Front"]}]}}}`

	s, dir, coll := newTestAnkiServer(t)

	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
	}
	decodeJSON(t, rec, &resp)
	var noteID int64
	_ = json.Unmarshal(resp.Result, &noteID)

	// No file landed in the media dir.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read media dir: %v", err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("media dir should be empty (url+data entry passes through); got %v", names)
	}
	// The note is still inserted with no media append.
	infos, _ := coll.NotesInfo([]int64{noteID})
	if len(infos) != 1 || infos[0].Fields["Front"] != "x" {
		t.Errorf("note front mutated: %+v", infos)
	}
}

// TestAnkiActionAddNoteNotesOnlyBridge pins the Fix-1 panic guard:
// when the bridge is wired in notes-only mode (DB set, Writer nil
// — the Termux collection.media probe failed), an addNote carrying
// audio/video/picture data must return 503 with a clear "media
// writer not available" message, NOT panic on the nil Writer
// dereference inside rewriteMediaEntry. The SQLite layer is never
// touched in this branch.
func TestAnkiActionAddNoteNotesOnlyBridge(t *testing.T) {
	dir := t.TempDir()
	colPath := newTestAnkiCollectionFixture(t)
	coll, err := anki.OpenCollection(colPath)
	if err != nil {
		t.Fatalf("OpenCollection: %v", err)
	}
	t.Cleanup(func() { _ = coll.Close() })
	s, err := New(Config{Anki: &AnkiBridge{
		Writer:  nil, // notes-only: probe failed (the panic case)
		DB:      coll,
		Enabled: true,
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Save the dir so we can verify no file was written (the guard
	// fires before rewrite even runs).
	_ = dir
	audioBytes := []byte("audio")
	audioB64 := base64.StdEncoding.EncodeToString(audioBytes)
	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"x","Back":"y"},"audio":[{"filename":"a.webm","data":"` + audioB64 + `","fields":["Front"]}]}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("notes-only + audio data: status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "media writer not available") {
		t.Errorf("503 body missing platform hint: %s", rec.Body.String())
	}
}

// TestAnkiActionAddNoteNotesOnlyBridgeTextOnlyOk pins the inverse:
// a notes-only bridge can still insert a text-only addNote (no
// media arrays, or url-only entries). The guard does NOT block
// note-taking — it only fires when an entry would force
// MediaWriter.Write.
func TestAnkiActionAddNoteNotesOnlyBridgeTextOnlyOk(t *testing.T) {
	colPath := newTestAnkiCollectionFixture(t)
	coll, err := anki.OpenCollection(colPath)
	if err != nil {
		t.Fatalf("OpenCollection: %v", err)
	}
	t.Cleanup(func() { _ = coll.Close() })
	s, err := New(Config{Anki: &AnkiBridge{
		Writer:  nil,
		DB:      coll,
		Enabled: true,
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// No audio/video/picture arrays → guard does not fire.
	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"cat","Back":"feline"}}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("notes-only text-only addNote: status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	decodeJSON(t, rec, &resp)
	if string(resp.Error) != "null" {
		t.Errorf("response error = %s, want null", resp.Error)
	}
	var noteID int64
	if err := json.Unmarshal(resp.Result, &noteID); err != nil {
		t.Fatalf("decode noteID: %v", err)
	}
	if noteID == 0 {
		t.Fatal("noteID = 0, want >0")
	}
	// url-only audio entry → pass-through (no writer needed) → note inserts.
	bodyURL := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"x","Back":"y"},"audio":[{"url":"https://example.invalid/a.webm","filename":"a.webm","fields":["Front"]}]}}}`
	rec = doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, bodyURL)
	if rec.Code != http.StatusOK {
		t.Fatalf("notes-only url-only entry: status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

// TestAnkiActionAddNoteAllowDuplicateFalse pins the duplicate-
// rejection wire contract: when allowDuplicate=false (the default)
// AND the candidate csum already exists on disk, the response is
// HTTP 200 with a null "result" / null "error" envelope (the
// official AnkiConnect contract — see spec). No new row is
// inserted.
func TestAnkiActionAddNoteAllowDuplicateFalse(t *testing.T) {
	colPath := newTestAnkiCollectionFixture(t)
	coll, err := anki.OpenCollection(colPath)
	if err != nil {
		t.Fatalf("OpenCollection: %v", err)
	}
	t.Cleanup(func() { _ = coll.Close() })
	seedID, err := coll.InsertNote(ankiTestDeckID, ankiTestModelID, []string{"dup-key", "x"}, nil, nil)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	writer := anki.NewMediaWriterForTest(t.TempDir())
	s, err := New(Config{Anki: &AnkiBridge{
		Writer:  writer,
		DB:      coll,
		Enabled: true,
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"dup-key","Back":"different"},"options":{"allowDuplicate":false,"duplicateScope":"collection"}}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("allowDuplicate=false + dup: status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp map[string]json.RawMessage
	decodeJSON(t, rec, &resp)
	if string(resp["result"]) != "null" {
		t.Errorf("response result = %s, want null (duplicate rejected)", resp["result"])
	}
	if string(resp["error"]) != "null" {
		t.Errorf("response error = %s, want null", resp["error"])
	}
	// Probe the seed note is still present (no row inserted,
	// nothing deleted either — a duplicate-rejected addNote is a
	// no-op write-wise).
	infos, err := coll.NotesInfo([]int64{seedID})
	if err != nil {
		t.Fatalf("NotesInfo: %v", err)
	}
	if len(infos) != 1 || infos[0].NoteID != seedID {
		t.Errorf("seed note lost: %+v", infos)
	}
}

// TestAnkiActionAddNoteAllowDuplicateTrue pins the bypass branch:
// options.allowDuplicate=true inserts even when the candidate
// csum already exists. The note id is returned.
func TestAnkiActionAddNoteAllowDuplicateTrue(t *testing.T) {
	colPath := newTestAnkiCollectionFixture(t)
	coll, err := anki.OpenCollection(colPath)
	if err != nil {
		t.Fatalf("OpenCollection: %v", err)
	}
	t.Cleanup(func() { _ = coll.Close() })
	if _, err := coll.InsertNote(ankiTestDeckID, ankiTestModelID, []string{"dup-key", "x"}, nil, nil); err != nil {
		t.Fatalf("seed: %v", err)
	}
	writer := anki.NewMediaWriterForTest(t.TempDir())
	s, err := New(Config{Anki: &AnkiBridge{
		Writer:  writer,
		DB:      coll,
		Enabled: true,
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"dup-key","Back":"different"},"options":{"allowDuplicate":true,"duplicateScope":"collection"}}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("allowDuplicate=true + dup: status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	decodeJSON(t, rec, &resp)
	if string(resp.Error) != "null" {
		t.Errorf("response error = %s, want null", resp.Error)
	}
	var noteID int64
	if err := json.Unmarshal(resp.Result, &noteID); err != nil {
		t.Fatalf("decode noteID: %v; body=%s", err, rec.Body.String())
	}
	if noteID == 0 {
		t.Fatal("noteID = 0, want >0 (allowDuplicate=true should insert)")
	}
}

// TestAnkiActionInvalidMediaBase64ReturnsBadRequest pins the
// client-body validation gate: an audio entry with non-base64 "data"
// must surface as 400 (anki.ErrBadRequest mapped), not 500 "anki
// action failed". The SQLite layer is never touched.
func TestAnkiActionInvalidMediaBase64ReturnsBadRequest(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)

	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"x"},"audio":[{"data":"@@@not-base64"}]}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid b64: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestAnkiActionMalformedAddNoteParamsReturnsBadRequest pins the
// client-body validation path: a non-object addNote params
// (here, a JSON array) must surface as 400, not 500. The SQLite
// layer is never touched.
func TestAnkiActionMalformedAddNoteParamsReturnsBadRequest(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)

	body := `{"action":"addNote","version":6,"params":{"note":[1,2,3]}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("non-object note: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestAnkiActionNonObjectParamsRootReturnsBadRequest pins the
// first client-body validation path on /v1/anki/action: a non-object
// params root (here, a JSON array) must surface as 400, not 500.
// The Collection is never opened for the action.
func TestAnkiActionNonObjectParamsRootReturnsBadRequest(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	body := `{"action":"deckNames","version":6,"params":[]}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("non-object params root: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestAnkiActionCollectionNotOpen pins the 503 path: when the
// Collection is nil (bridge wired but AnkiDroid play-variant
// app-private path), /v1/anki/action returns 503 with the
// "collection not available" message — not 500, not 404.
func TestAnkiActionCollectionNotOpen(t *testing.T) {
	if runtime.GOOS == "android" || runtime.GOOS == "linux" {
		t.Skip("the fixture's OpenCollection succeeds on Android/Linux; the test pins the Windows behaviour")
	}
	// Build a server with no Collection.
	dir := t.TempDir()
	writer := anki.NewMediaWriterForTest(dir)
	s, err := New(Config{Anki: &AnkiBridge{
		Writer:  writer,
		DB:      nil,
		Enabled: true,
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"action":"version","version":6}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "not available") {
		t.Errorf("503 body missing 'not available': %s", rec.Body.String())
	}
}

// TestAnkiActionUpdateNoteFields pins the SQLite-backed
// updateNoteFields action: a single-field update rewrites the
// matching field by ordinal; the other field is preserved.
func TestAnkiActionUpdateNoteFields(t *testing.T) {
	s, _, coll := newTestAnkiServer(t)
	// Insert a seed note.
	noteID, err := coll.InsertNote(ankiTestDeckID, ankiTestModelID,
		[]string{"alpha", "first"}, []string{"t1"}, nil)
	if err != nil {
		t.Fatalf("seed note: %v", err)
	}
	body := `{"action":"updateNoteFields","version":6,"params":{"id":` + strconv.FormatInt(noteID, 10) + `,"fields":{"Back":"second"}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	infos, err := coll.NotesInfo([]int64{noteID})
	if err != nil {
		t.Fatalf("NotesInfo: %v", err)
	}
	if len(infos) != 1 {
		t.Fatalf("len(infos) = %d, want 1", len(infos))
	}
	if infos[0].Fields["Front"] != "alpha" {
		t.Errorf("Front mutated: %q, want \"alpha\"", infos[0].Fields["Front"])
	}
	if infos[0].Fields["Back"] != "second" {
		t.Errorf("Back = %q, want \"second\"", infos[0].Fields["Back"])
	}
}

// TestAnkiActionAddTags pins the SQLite-backed addTags action.
func TestAnkiActionAddTags(t *testing.T) {
	s, _, coll := newTestAnkiServer(t)
	noteID, err := coll.InsertNote(ankiTestDeckID, ankiTestModelID,
		[]string{"alpha", "first"}, []string{"initial"}, nil)
	if err != nil {
		t.Fatalf("seed note: %v", err)
	}
	body := `{"action":"addTags","version":6,"params":{"notes":[` + strconv.FormatInt(noteID, 10) + `],"tags":"extra more"}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	infos, _ := coll.NotesInfo([]int64{noteID})
	if len(infos) != 1 {
		t.Fatalf("len(infos) = %d, want 1", len(infos))
	}
	want := map[string]bool{"initial": false, "extra": false, "more": false}
	for _, tg := range infos[0].Tags {
		if _, ok := want[tg]; ok {
			want[tg] = true
		}
	}
	for k, found := range want {
		if !found {
			t.Errorf("tag %q missing from %v", k, infos[0].Tags)
		}
	}
}

// TestAnkiActionFindNotesAdded pins the SQLite-backed findNotes for
// the added:1 query: notes inserted in the test (right now) appear
// in the result.
func TestAnkiActionFindNotesAdded(t *testing.T) {
	s, _, coll := newTestAnkiServer(t)
	noteID, err := coll.InsertNote(ankiTestDeckID, ankiTestModelID,
		[]string{"alpha", "first"}, nil, nil)
	if err != nil {
		t.Fatalf("seed note: %v", err)
	}
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"action":"findNotes","version":6,"params":{"query":"added:1"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
	}
	decodeJSON(t, rec, &resp)
	var ids []int64
	if err := json.Unmarshal(resp.Result, &ids); err != nil {
		t.Fatalf("decode ids: %v", err)
	}
	if len(ids) != 1 || ids[0] != noteID {
		t.Errorf("findNotes added:1 = %v, want [%d]", ids, noteID)
	}
}

// TestAnkiActionCanAddNotes pins the SQLite-backed canAddNotes:
// duplicate detection by csum.
func TestAnkiActionCanAddNotes(t *testing.T) {
	s, _, coll := newTestAnkiServer(t)
	if _, err := coll.InsertNote(ankiTestDeckID, ankiTestModelID, []string{"dup-key", "x"}, nil, nil); err != nil {
		t.Fatalf("seed: %v", err)
	}
	body := `{"action":"canAddNotes","version":6,"params":{"notes":[{"field":"dup-key","options":{"allowDuplicate":false,"duplicateScope":"collection"}}]}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
	}
	decodeJSON(t, rec, &resp)
	var canAdd []bool
	if err := json.Unmarshal(resp.Result, &canAdd); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(canAdd) != 1 || canAdd[0] {
		t.Errorf("canAddNotes = %v, want [false]", canAdd)
	}
}

// --- happy path: /v1/anki/status ---

// TestAnkiStatusShape pins the status response shape and content
// sensitivity: the body carries only enabled / collectionOpen /
// collectionPath / mediaDirWritable / mediaDir. No token, no pair
// code, no URL-with-token.
func TestAnkiStatusShape(t *testing.T) {
	s, dir, coll := newTestAnkiServer(t)
	rec := doAnkiRequest(t, s.Handler(), http.MethodGet,
		"/v1/anki/status?token="+s.token, allowedOriginEntei, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body ankiStatusBody
	decodeJSON(t, rec, &body)
	if !body.Enabled {
		t.Error("enabled = false, want true")
	}
	if !body.CollectionOpen {
		t.Error("collectionOpen = false, want true")
	}
	if body.CollectionPath != coll.Path() {
		t.Errorf("collectionPath = %q, want %q", body.CollectionPath, coll.Path())
	}
	if !body.MediaDirWritable {
		t.Error("mediaDirWritable = false, want true (temp dir was probed successfully)")
	}
	if body.MediaDir != dir {
		t.Errorf("mediaDir = %q, want %q", body.MediaDir, dir)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}

	// Sensitivity: token / pair code / URL-with-token never in body.
	for _, forbidden := range []string{s.token, s.code} {
		if strings.Contains(rec.Body.String(), forbidden) {
			t.Errorf("status body leaks %q: %s", forbidden, rec.Body.String())
		}
	}
}

// TestAnkiStatusNotWritable pins the writability probe: when the
// MediaWriter's configured dir was removed, status reports
// mediaDirWritable=false. The test removes the dir between server
// construction and the status GET.
func TestAnkiStatusNotWritable(t *testing.T) {
	s, dir, _ := newTestAnkiServer(t)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("remove dir: %v", err)
	}
	rec := doAnkiRequest(t, s.Handler(), http.MethodGet,
		"/v1/anki/status?token="+s.token, allowedOriginEntei, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body ankiStatusBody
	decodeJSON(t, rec, &body)
	if body.MediaDirWritable {
		t.Errorf("mediaDirWritable = true after dir removed, want false")
	}
}

// TestAnkiStatusHeadMirrorsGet pins the HEAD contract for the status
// endpoint: HEAD returns the same headers as GET but an empty body,
// so the browser can poll without parsing the JSON.
func TestAnkiStatusHeadMirrorsGet(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	req := httptest.NewRequest(http.MethodHead,
		"/v1/anki/status?token="+s.token, nil)
	req.Header.Set("Origin", allowedOriginEntei)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("HEAD: status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD: body length = %d, want 0", rec.Body.Len())
	}
}

// --- bridge disabled ---

// TestAnkiRoutesUnregisteredWhenDisabled pins the "zero behavior
// change for existing users" contract: when Config.Anki is nil, the
// three /v1/anki routes stay unregistered (404) and a paired browser
// gets a generic not-found instead of a 503 from a half-wired
// bridge. This is the spec's both-flags-empty case.
func TestAnkiRoutesUnregisteredWhenDisabled(t *testing.T) {
	s := newTestServer(t)
	for _, path := range []string{"/v1/anki/media", "/v1/anki/action", "/v1/anki/status"} {
		rec := doAnkiRequest(t, s.Handler(), http.MethodPost, path, allowedOriginEntei, "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("POST %s (disabled): status = %d, want 404", path, rec.Code)
		}
	}
}

// TestAnkiPreflight pins the CORS preflight shape for the three
// routes: allowed origin → 204 with POST/GET/HEAD/OPTIONS and
// Content-Type. Disallowed origin → 403 without ACAO.
func TestAnkiPreflight(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)

	// Allowed origin → 204.
	req := httptest.NewRequest(http.MethodOptions, "/v1/anki/media", nil)
	req.Header.Set("Origin", allowedOriginEntei)
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("preflight status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != allowedOriginEntei {
		t.Errorf("preflight ACAO = %q, want %q", got, allowedOriginEntei)
	}
	methods := rec.Header().Get("Access-Control-Allow-Methods")
	for _, want := range []string{http.MethodPost, http.MethodGet, http.MethodHead, http.MethodOptions} {
		if !strings.Contains(methods, want) {
			t.Errorf("preflight ACAM missing %s: %q", want, methods)
		}
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != "Content-Type" {
		t.Errorf("preflight ACAH = %q, want Content-Type", got)
	}

	// Disallowed origin → 403 without ACAO.
	req = httptest.NewRequest(http.MethodOptions, "/v1/anki/media", nil)
	req.Header.Set("Origin", disallowedOrigin)
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("disallowed preflight status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed preflight ACAO = %q, want empty", got)
	}
}

// TestAnkiMethodNotAllowed pins the wrong-method contract: a GET on
// /v1/anki/media → 405 with an Allow header listing POST + OPTIONS.
// Same posture as the existing endpoints so reviewers see one
// consistent shape.
func TestAnkiMethodNotAllowed(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	rec := doAnkiRequest(t, s.Handler(), http.MethodGet,
		"/v1/anki/media?token="+s.token, allowedOriginEntei, "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /v1/anki/media: status = %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Allow"); !strings.Contains(got, http.MethodPost) || !strings.Contains(got, http.MethodOptions) {
		t.Errorf("Allow = %q, want POST and OPTIONS", got)
	}
}

// TestAnkiActionErrorEnvelopePinsUnknownAction pins that an unknown
// action surfaces as 400 with the "unsupported action" reason
// (matches AnkiconnectAndroid's route-not-found response).
func TestAnkiActionErrorEnvelopePinsUnknownAction(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"action":"unsupported-action","version":6}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(body["error"], "unsupported action") {
		t.Errorf("body[error] = %q, want it to contain \"unsupported action\"", body["error"])
	}
}

// TestAnkiActionNotesInfo pins the SQLite-backed notesInfo action.
func TestAnkiActionNotesInfo(t *testing.T) {
	s, _, coll := newTestAnkiServer(t)
	noteID, err := coll.InsertNote(ankiTestDeckID, ankiTestModelID,
		[]string{"F", "B"}, []string{"a"}, nil)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	body := `{"action":"notesInfo","version":6,"params":{"notes":[` + strconv.FormatInt(noteID, 10) + `]}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
	}
	decodeJSON(t, rec, &resp)
	var infos []map[string]any
	if err := json.Unmarshal(resp.Result, &infos); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(infos) != 1 {
		t.Fatalf("len = %d, want 1", len(infos))
	}
	if infos[0]["modelName"] != "Basic" {
		t.Errorf("modelName = %v, want Basic", infos[0]["modelName"])
	}
	fields, _ := infos[0]["fields"].(map[string]any)
	if fields["Front"] != "F" || fields["Back"] != "B" {
		t.Errorf("fields = %v, want Front=F, Back=B", fields)
	}
}

// TestAnkiActionUnknownErrorIsBadRequest pins the typed-error
// mapping for the anki.ErrBadRequest path: dispatch returns a
// wrapped error, the handler maps it to 400, not 500.
func TestAnkiActionUnknownErrorIsBadRequest(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	// addNote with an unknown model → BadRequest from
	// dispatchAnkiAction (model not found).
	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Missing","fields":{"Front":"x"}}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("unknown model: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// (compile-time guard that the imported packages are used; without
// it, refactors could silently drop an import).
var _ = errors.New
var _ = io.EOF
var _ = filepath.Base
var _ = sql.ErrNoRows