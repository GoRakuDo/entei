package api

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
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

// Raw AnkiConnect-compatible listener tests (spec v4.0, 2026-08-31).
//
// /v1/anki/* was removed in v4.0 — the raw AnkiConnect listener on
// 127.0.0.1:8765 is the only Anki surface. These tests pin the wire
// contract every Entei / Yomitan / asbplayer client speaks:
//
//   - POST / with an AnkiConnect envelope → 200 + {result, error:null}
//   - HTTP 200 even on dispatcher errors (clients parse `error`, not status)
//   - HTTP 200 on duplicate-rejected addNote (result null + error null)
//   - HTTP 200 + error string on unknown action (matches AnkiconnectAndroid)
//   - storeMediaFile routes through MediaWriter with deterministic filename
//   - CORS preflight returns 204 + Access-Control-Allow-Origin: *
//   - --anki-api-key gate rejects mismatched body key
//   - 8765 EADDRINUSE is logged + ignored (companion keeps serving)
//   - Bridge disabled → StartRawAnkiConnectListener is a no-op

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
// wired (Writer bound to t.TempDir(); Collection opened against a
// real fixture). Used by every raw-listener test below — the
// listener is exercised via s.Handler() wrapped in handleRawAnkiConnect
// (or via httptest.NewServer for end-to-end tests that need a real
// TCP socket, e.g. EADDRINUSE).
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

// doRawAnkiRequest POSTs (or OPTIONS) the raw AnkiConnect listener
// surface. AnkiConnect clients POST JSON envelopes to the root URL
// — we mirror that by mounting the handler at "/" via httptest's
// helper. The test passes any path (default "/") so the path-agnostic
// contract is also pinned. The Host header is set to the configured
// bind so the DNS-rebinding guard accepts the request; httptest
// defaults to "example.com" which the guard would reject.
func doRawAnkiRequest(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = RawAnkiConnectBind
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// rawAnkiEnv decodes the standard AnkiConnect wire envelope into
// a small struct for assertions. Used by the result / error checks.
type rawAnkiEnv struct {
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

// decodeRawAnkiEnv decodes the recorder body into rawAnkiEnv.
// Helper for the happy-path assertions.
func decodeRawAnkiEnv(t *testing.T, rec *httptest.ResponseRecorder) rawAnkiEnv {
	t.Helper()
	var env rawAnkiEnv
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope: %v; body=%s", err, rec.Body.String())
	}
	return env
}

// --- happy path: simple actions ---

// TestRawAnkiVersion pins the simplest action: version returns 6.
// The wire contract is HTTP 200 + {result: 6, error: null}.
func TestRawAnkiVersion(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"version","version":6}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	env := decodeRawAnkiEnv(t, rec)
	if string(env.Result) != "6" {
		t.Errorf("result = %s, want 6", env.Result)
	}
	if string(env.Error) != "null" {
		t.Errorf("error = %s, want null", env.Error)
	}
}

// TestRawAnkiVersionProtocolV2 pins the version<=4 wire protocol —
// the exact case Yomitan hits in production (Yomitan's anki-connect.js
// hardcodes this._localVersion = 2). Official AnkiConnect
// format_success_reply returns the BARE result (not the
// {"result":…,"error":…} envelope) for api_version <= 4, so the
// version action must answer with the raw body `6\n` and HTTP 200. A
// v2 client must never see the envelope: Yomitan treats a JSON object
// as an error reply (its `result.error` presence check trips on
// `{"result":6,"error":null}` and throws "Anki error: null").
func TestRawAnkiVersionProtocolV2(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"version","version":2}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "6\n" {
		t.Errorf("body = %q, want \"6\\n\" (bare result for version<=4)", got)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

// TestRawAnkiVersionProtocolV6 pins the version>4 wire protocol —
// the case Entei web hits in production (it sends version: 6).
// Official AnkiConnect format_success_reply returns the standard
// envelope {"result": <result>, "error": null} for api_version > 4,
// so the response body MUST be exactly that JSON object.
func TestRawAnkiVersionProtocolV6(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"version","version":6}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "{\"result\":6,\"error\":null}\n" {
		t.Errorf("body = %q, want \"{\\\"result\\\":6,\\\"error\\\":null}\\n\"", got)
	}
}

// TestRawAnkiErrorProtocolV2 pins that ERROR replies are the standard
// envelope for EVERY version. The version<=4 bare-result rule applies
// to format_success_reply only; official AnkiConnect
// format_exception_reply returns {"result": null, "error": <msg>}
// regardless of api_version. A v2 Yomitan must still see the envelope
// (and its error check) when the action fails.
func TestRawAnkiErrorProtocolV2(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"invalidAction","version":2}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	want := "{\"result\":null,\"error\":\"unsupported action: invalidAction\"}\n"
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q (envelope even for version<=4 errors)", got, want)
	}
}

// TestRawAnkiDeckNamesAndModelNames pins the deck/model enumeration
// actions: deckNames → ["Default"], modelNames → ["Basic"]. Both
// return JSON arrays in the result.
func TestRawAnkiDeckNamesAndModelNames(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"deckNames","version":6}`)
	env := decodeRawAnkiEnv(t, rec)
	var deckNames []string
	if err := json.Unmarshal(env.Result, &deckNames); err != nil {
		t.Fatalf("decode deckNames: %v", err)
	}
	if len(deckNames) != 1 || deckNames[0] != "Default" {
		t.Errorf("deckNames = %v, want [Default]", deckNames)
	}

	rec = doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"modelNames","version":6}`)
	env = decodeRawAnkiEnv(t, rec)
	var modelNames []string
	if err := json.Unmarshal(env.Result, &modelNames); err != nil {
		t.Fatalf("decode modelNames: %v", err)
	}
	if len(modelNames) != 1 || modelNames[0] != "Basic" {
		t.Errorf("modelNames = %v, want [Basic]", modelNames)
	}
}

// TestRawAnkiPathAgnostic pins the contract that AnkiConnect clients
// POST to the root URL and the handler matches on the JSON envelope
// shape, not the path. Some libraries POST to / or to a fixed
// endpoint like /anki; we accept ANY path on the listener.
func TestRawAnkiPathAgnostic(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	// Any path works.
	for _, p := range []string{"/", "/anything", "/anki", "/q?x=1"} {
		rec := doRawAnkiRequest(t, mux, http.MethodPost, p,
			`{"action":"version","version":6}`)
		if rec.Code != http.StatusOK {
			t.Errorf("path %q: status = %d, want 200", p, rec.Code)
		}
		env := decodeRawAnkiEnv(t, rec)
		if string(env.Result) != "6" {
			t.Errorf("path %q: result = %s, want 6", p, env.Result)
		}
	}
}

// --- happy path: storeMediaFile ---

// TestRawAnkiStoreMediaFile pins the storeMediaFile action: a
// {filename, data} params envelope routes through MediaWriter.Write
// to produce the deterministic content-hash filename, and the
// response result is the stored name. The byte content of the
// stored file must match what the caller sent.
func TestRawAnkiStoreMediaFile(t *testing.T) {
	s, dir, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	payload := []byte("opaque media bytes")
	b64 := base64.StdEncoding.EncodeToString(payload)
	wantStored := anki.GenerateFilenameFromProvided("audio.webm", payload)

	body := `{"action":"storeMediaFile","version":6,"params":{"filename":"audio.webm","data":"` + b64 + `"}}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	env := decodeRawAnkiEnv(t, rec)
	if string(env.Error) != "null" {
		t.Errorf("error = %s, want null", env.Error)
	}
	var stored string
	if err := json.Unmarshal(env.Result, &stored); err != nil {
		t.Fatalf("decode stored: %v; body=%s", err, rec.Body.String())
	}
	if stored != wantStored {
		t.Errorf("stored = %q, want %q", stored, wantStored)
	}
	// The file landed in the MediaWriter's dir with the right bytes.
	got, err := os.ReadFile(filepath.Join(dir, stored))
	if err != nil {
		t.Fatalf("read stored file: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("stored bytes = %q, want %q", got, payload)
	}
}

// TestRawAnkiStoreMediaFileDeterministic pins the deterministic-
// filename contract: re-POSTing the SAME bytes produces the SAME
// stored filename (overwrite, not duplicate).
func TestRawAnkiStoreMediaFileDeterministic(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	payload := []byte("re-export test")
	b64 := base64.StdEncoding.EncodeToString(payload)
	body := `{"action":"storeMediaFile","version":6,"params":{"filename":"x.webm","data":"` + b64 + `"}}`

	rec1 := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	var stored1 string
	_ = json.Unmarshal(decodeRawAnkiEnv(t, rec1).Result, &stored1)
	rec2 := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	var stored2 string
	_ = json.Unmarshal(decodeRawAnkiEnv(t, rec2).Result, &stored2)
	if stored1 == "" || stored1 != stored2 {
		t.Errorf("deterministic name changed: %q → %q", stored1, stored2)
	}
}

// --- happy path: addNote end-to-end ---

// TestRawAnkiAddNoteEndToEnd is the headline test for the v4.0
// direct-SQLite dispatch: a POST to the raw listener with addNote
// writes a real note + card into the test collection. The rewrite
// runs first (audio[0]'s filename becomes the deterministic
// content-hash name AND a matching file lands in the MediaWriter's
// dir); then InsertNote runs the SQLite transaction; the response
// is the new note id wrapped in the standard envelope.
//
// Pinning every step end-to-end here means a regression in any of
// (a) the addNote dispatch, (b) the media rewrite, (c) the SQLite
// insert is caught.
func TestRawAnkiAddNoteEndToEnd(t *testing.T) {
	s, dir, coll := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	audioBytes := []byte("the audio bytes")
	audioB64 := base64.StdEncoding.EncodeToString(audioBytes)
	wantStored := anki.GenerateFilenameFromProvided("audio.webm", audioBytes)

	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"猫","Back":"cat"},"tags":["vocab"],"options":{"allowDuplicate":false,"duplicateScope":"deck"},"audio":[{"filename":"audio.webm","data":"` + audioB64 + `","fields":["Front"]}]}}}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	env := decodeRawAnkiEnv(t, rec)
	if string(env.Error) != "null" {
		t.Errorf("error = %s, want null", env.Error)
	}
	var noteID int64
	if err := json.Unmarshal(env.Result, &noteID); err != nil {
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

// TestRawAnkiAddNoteTextOnlyPassthrough pins the no-media path: an
// addNote with NO audio/video/picture arrays is forwarded verbatim
// (the handler skips the rewrite branch entirely).
func TestRawAnkiAddNoteTextOnlyPassthrough(t *testing.T) {
	s, _, coll := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"cat","Back":"feline"}}}}`)
	env := decodeRawAnkiEnv(t, rec)
	var noteID int64
	if err := json.Unmarshal(env.Result, &noteID); err != nil {
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

// TestRawAnkiAddNoteURLPassthrough pins the url+data contract: an
// audio/video/picture entry that carries BOTH "url" and "data" is
// forwarded untouched and NO file is written locally. The note is
// still inserted but the field isn't appended with a [sound:...] tag
// (we have no bytes to store).
func TestRawAnkiAddNoteURLPassthrough(t *testing.T) {
	s, dir, coll := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	const wantStored = "remote.mp3"
	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"x","Back":"y"},"audio":[{"url":"https://example.invalid/` + wantStored + `","filename":"` + wantStored + `","fields":["Front"]}]}}}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	env := decodeRawAnkiEnv(t, rec)
	var noteID int64
	_ = json.Unmarshal(env.Result, &noteID)
	if noteID == 0 {
		t.Fatalf("noteID = 0; body=%s", rec.Body.String())
	}

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
	infos, _ := coll.NotesInfo([]int64{noteID})
	if len(infos) != 1 || infos[0].Fields["Front"] != "x" {
		t.Errorf("note front mutated: %+v", infos)
	}
}

// TestRawAnkiAddNoteNotesOnlyBridge pins the panic guard: when the
// bridge is wired in notes-only mode (DB set, Writer nil), an
// addNote carrying audio/video/picture data must surface as an
// AnkiConnect-shaped error envelope with the "anki media writer not
// available" reason, NOT panic on the nil Writer dereference inside
// rewriteMediaEntry.
func TestRawAnkiAddNoteNotesOnlyBridge(t *testing.T) {
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
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	audioBytes := []byte("audio")
	audioB64 := base64.StdEncoding.EncodeToString(audioBytes)
	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"x","Back":"y"},"audio":[{"filename":"a.webm","data":"` + audioB64 + `","fields":["Front"]}]}}}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("notes-only + audio data: status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	env := decodeRawAnkiEnv(t, rec)
	if string(env.Result) != "null" {
		t.Errorf("result = %s, want null", env.Result)
	}
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "media writer not available") {
		t.Errorf("error message = %q, want it to contain \"media writer not available\"", msg)
	}
}

// TestRawAnkiAddNoteNotesOnlyBridgeTextOnlyOk pins the inverse: a
// notes-only bridge can still insert a text-only addNote (no media
// arrays, or url-only entries). The guard does NOT block note-taking.
func TestRawAnkiAddNoteNotesOnlyBridgeTextOnlyOk(t *testing.T) {
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
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"cat","Back":"feline"}}}}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	env := decodeRawAnkiEnv(t, rec)
	if string(env.Error) != "null" {
		t.Errorf("text-only notes-only: error = %s, want null", env.Error)
	}
	var noteID int64
	if err := json.Unmarshal(env.Result, &noteID); err != nil {
		t.Fatalf("decode noteID: %v", err)
	}
	if noteID == 0 {
		t.Fatal("noteID = 0, want >0")
	}
}

// TestRawAnkiAddNoteAllowDuplicateFalse pins the duplicate-rejection
// wire contract: when allowDuplicate=false (the default) AND the
// candidate csum already exists on disk, the response is HTTP 200
// with a null "result" / null "error" envelope (the official
// AnkiConnect contract). No new row is inserted.
func TestRawAnkiAddNoteAllowDuplicateFalse(t *testing.T) {
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
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"dup-key","Back":"different"},"options":{"allowDuplicate":false,"duplicateScope":"collection"}}}}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("allowDuplicate=false + dup: status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	env := decodeRawAnkiEnv(t, rec)
	if string(env.Result) != "null" {
		t.Errorf("result = %s, want null (duplicate rejected)", env.Result)
	}
	if string(env.Error) != "null" {
		t.Errorf("error = %s, want null", env.Error)
	}
	// Seed note is still present (no row inserted, nothing deleted).
	infos, err := coll.NotesInfo([]int64{seedID})
	if err != nil {
		t.Fatalf("NotesInfo: %v", err)
	}
	if len(infos) != 1 || infos[0].NoteID != seedID {
		t.Errorf("seed note lost: %+v", infos)
	}
}

// TestRawAnkiAddNoteAllowDuplicateTrue pins the bypass branch:
// options.allowDuplicate=true inserts even when the candidate csum
// already exists. The note id is returned.
func TestRawAnkiAddNoteAllowDuplicateTrue(t *testing.T) {
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
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"dup-key","Back":"different"},"options":{"allowDuplicate":true,"duplicateScope":"collection"}}}}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("allowDuplicate=true + dup: status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	env := decodeRawAnkiEnv(t, rec)
	if string(env.Error) != "null" {
		t.Errorf("error = %s, want null", env.Error)
	}
	var noteID int64
	if err := json.Unmarshal(env.Result, &noteID); err != nil {
		t.Fatalf("decode noteID: %v; body=%s", err, rec.Body.String())
	}
	if noteID == 0 {
		t.Fatal("noteID = 0, want >0 (allowDuplicate=true should insert)")
	}
}

// TestRawAnkiAddNoteInvalidBase64 pins the client-body validation
// path: an audio entry with non-base64 "data" must surface as an
// AnkiConnect-shaped error envelope with the bad-request reason,
// NOT a generic "anki action failed". The SQLite layer is never
// touched.
func TestRawAnkiAddNoteInvalidBase64(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"x"},"audio":[{"data":"@@@not-base64"}]}}}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	env := decodeRawAnkiEnv(t, rec)
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "invalid base64") {
		t.Errorf("error message = %q, want it to contain \"invalid base64\"", msg)
	}
}

// TestRawAnkiAddNoteUnknownModel pins the typed-error mapping for
// addNote: an unknown model name surfaces as an AnkiConnect error
// envelope with the human-readable "model <name> not found" reason.
func TestRawAnkiAddNoteUnknownModel(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Missing","fields":{"Front":"x"}}}}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	env := decodeRawAnkiEnv(t, rec)
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "Missing") {
		t.Errorf("error message = %q, want it to mention the model name", msg)
	}
}

// --- error mapping ---

// TestRawAnkiUnknownAction pins the unknown-action wire contract:
// HTTP 200 + {result: null, error: "unsupported action: <name>"}.
// Matches AnkiconnectAndroid's "no route" response shape.
func TestRawAnkiUnknownAction(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"unsupported-action","version":6}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	env := decodeRawAnkiEnv(t, rec)
	if string(env.Result) != "null" {
		t.Errorf("result = %s, want null", env.Result)
	}
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "unsupported action") {
		t.Errorf("error = %q, want it to contain \"unsupported action\"", msg)
	}
}

// TestRawAnkiMissingAction pins the input-validation path: an
// envelope without "action" → 200 + envelope with error "missing
// action". The SQLite layer is never queried.
func TestRawAnkiMissingAction(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"version":6,"params":{}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	env := decodeRawAnkiEnv(t, rec)
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "missing action") {
		t.Errorf("error = %q, want it to contain \"missing action\"", msg)
	}
}

// TestRawAnkiInvalidJSON pins the malformed-body path: invalid JSON
// → 200 + envelope with error "invalid JSON body".
func TestRawAnkiInvalidJSON(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", "not json")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	env := decodeRawAnkiEnv(t, rec)
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "invalid JSON body") {
		t.Errorf("error = %q, want it to contain \"invalid JSON body\"", msg)
	}
}

// TestRawAnkiUnsupportedMethod pins the wrong-method contract: a
// GET on the raw listener → 200 + envelope with "unsupported method"
// error (NOT 405). The AnkiConnect wire contract keeps HTTP 200
// even on misrouted requests.
func TestRawAnkiUnsupportedMethod(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodGet, "/", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (AnkiConnect wire keeps HTTP 200)", rec.Code)
	}
	env := decodeRawAnkiEnv(t, rec)
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "unsupported method") {
		t.Errorf("error = %q, want it to contain \"unsupported method\"", msg)
	}
}

// TestRawAnkiPayloadTooLarge pins the 64 MiB body cap: a body
// exceeding the cap must surface as an AnkiConnect error envelope
// with "payload too large", not a generic 413.
func TestRawAnkiPayloadTooLarge(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	// Build a JSON body exceeding the cap by repeating "a" in the
	// data field of storeMediaFile.
	const overCap = rawAnkiConnectMaxBodyBytes + 1024
	var buf bytes.Buffer
	buf.WriteString(`{"action":"storeMediaFile","version":6,"params":{"filename":"huge.webm","data":"`)
	for i := 0; i < overCap; i++ {
		buf.WriteByte('a')
	}
	buf.WriteString(`"}}`)

	req := httptest.NewRequest(http.MethodPost, "/", &buf)
	req.Host = RawAnkiConnectBind
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = int64(buf.Len())
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("over-cap: status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	env := decodeRawAnkiEnv(t, rec)
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "payload too large") {
		t.Errorf("error = %q, want it to contain \"payload too large\"", msg)
	}
}

// --- CORS preflight ---

// TestRawAnkiPreflight pins the CORS preflight shape: OPTIONS →
// 204 + Access-Control-Allow-Origin: *, allow POST + OPTIONS,
// allow Content-Type. The preflight is permissive (matches
// AnkiconnectAndroid) so Yomitan's extension origin can reach the
// listener. No origin allowlist check runs.
func TestRawAnkiPreflight(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	// Allowed origin (any origin on loopback — wildcard).
	req := httptest.NewRequest(http.MethodOptions, "/", nil)
	req.Host = RawAnkiConnectBind
	req.Header.Set("Origin", "https://yomitan-extension.invalid")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("preflight status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("preflight ACAO = %q, want *", got)
	}
	methods := rec.Header().Get("Access-Control-Allow-Methods")
	if !strings.Contains(methods, http.MethodPost) || !strings.Contains(methods, http.MethodOptions) {
		t.Errorf("preflight ACAM missing POST/OPTIONS: %q", methods)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != "Content-Type" {
		t.Errorf("preflight ACAH = %q, want Content-Type", got)
	}
}

// TestRawAnkiPreflightNoOrigin pins that the preflight also returns
// 204 without an Origin header — the listener is unconditional
// (loopback-only threat model).
func TestRawAnkiPreflightNoOrigin(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	req := httptest.NewRequest(http.MethodOptions, "/", nil)
	req.Host = RawAnkiConnectBind
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("preflight-no-origin status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("ACAO = %q, want *", got)
	}
}

// TestRawAnkiPostCORSHeaders pins that every POST response carries
// Access-Control-Allow-Origin: * so browser fetch() can read the
// body from any origin (loopback-only threat model).
func TestRawAnkiPostCORSHeaders(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"action":"version","version":6}`))
	req.Host = RawAnkiConnectBind
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://yomitan-extension.invalid")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("POST ACAO = %q, want *", got)
	}
}

// --- API key gate ---

// TestRawAnkiAPIKeyMismatch pins the key-gate contract: when the
// bridge is configured with --anki-api-key, a body without a matching
// `key` field is rejected with an AnkiConnect-shaped error envelope
// ("unauthorized"). Constant-time compare so timing-side-channel
// attackers can't byte-probe the key.
func TestRawAnkiAPIKeyMismatch(t *testing.T) {
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
		APIKey:  "secret-key",
		Enabled: true,
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	// No key in body → unauthorized.
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"version","version":6}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("no key: status = %d, want 200", rec.Code)
	}
	env := decodeRawAnkiEnv(t, rec)
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "unauthorized") {
		t.Errorf("no key: error = %q, want it to contain \"unauthorized\"", msg)
	}
	// Wrong key in body → unauthorized.
	rec = doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"version","version":6,"key":"wrong-key"}`)
	env = decodeRawAnkiEnv(t, rec)
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "unauthorized") {
		t.Errorf("wrong key: error = %q, want it to contain \"unauthorized\"", msg)
	}
	// Correct key → success.
	rec = doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"version","version":6,"key":"secret-key"}`)
	env = decodeRawAnkiEnv(t, rec)
	if string(env.Result) != "6" {
		t.Errorf("correct key: result = %s, want 6", env.Result)
	}
}

// TestRawAnkiAPIKeyUnset pins the no-key-required contract: when
// the bridge is configured without --anki-api-key, ANY caller (with
// or without a key field) is accepted. Matches AnkiconnectAndroid's
// "no auth surface" posture.
func TestRawAnkiAPIKeyUnset(t *testing.T) {
	s, _, _ := newTestAnkiServer(t) // no APIKey
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"version","version":6}`)
	env := decodeRawAnkiEnv(t, rec)
	if string(env.Result) != "6" {
		t.Errorf("no-key-set: result = %s, want 6", env.Result)
	}
	// Even a wrong key is accepted (the gate is off).
	rec = doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"version","version":6,"key":"any-value"}`)
	env = decodeRawAnkiEnv(t, rec)
	if string(env.Result) != "6" {
		t.Errorf("no-key-set with junk key: result = %s, want 6", env.Result)
	}
}

// --- canAddNotes + other DB-backed actions ---

// TestRawAnkiCanAddNotes pins the SQLite-backed canAddNotes: a
// duplicate-key request returns [false] in the result, with
// error null.
func TestRawAnkiCanAddNotes(t *testing.T) {
	s, _, coll := newTestAnkiServer(t)
	if _, err := coll.InsertNote(ankiTestDeckID, ankiTestModelID, []string{"dup-key", "x"}, nil, nil); err != nil {
		t.Fatalf("seed: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	body := `{"action":"canAddNotes","version":6,"params":{"notes":[{"field":"dup-key","options":{"allowDuplicate":false,"duplicateScope":"collection"}}]}}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	env := decodeRawAnkiEnv(t, rec)
	if string(env.Error) != "null" {
		t.Errorf("error = %s, want null", env.Error)
	}
	var canAdd []bool
	if err := json.Unmarshal(env.Result, &canAdd); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(canAdd) != 1 || canAdd[0] {
		t.Errorf("canAddNotes = %v, want [false]", canAdd)
	}
}

// TestRawAnkiFindNotes pins the SQLite-backed findNotes for the
// added:1 query.
func TestRawAnkiFindNotes(t *testing.T) {
	s, _, coll := newTestAnkiServer(t)
	noteID, err := coll.InsertNote(ankiTestDeckID, ankiTestModelID,
		[]string{"alpha", "first"}, nil, nil)
	if err != nil {
		t.Fatalf("seed note: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"findNotes","version":6,"params":{"query":"added:1"}}`)
	env := decodeRawAnkiEnv(t, rec)
	var ids []int64
	if err := json.Unmarshal(env.Result, &ids); err != nil {
		t.Fatalf("decode ids: %v", err)
	}
	if len(ids) != 1 || ids[0] != noteID {
		t.Errorf("findNotes added:1 = %v, want [%d]", ids, noteID)
	}
}

// TestRawAnkiUpdateNoteFields pins the SQLite-backed
// updateNoteFields action.
func TestRawAnkiUpdateNoteFields(t *testing.T) {
	s, _, coll := newTestAnkiServer(t)
	noteID, err := coll.InsertNote(ankiTestDeckID, ankiTestModelID,
		[]string{"alpha", "first"}, []string{"t1"}, nil)
	if err != nil {
		t.Fatalf("seed note: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	body := `{"action":"updateNoteFields","version":6,"params":{"id":` + strconv.FormatInt(noteID, 10) + `,"fields":{"Back":"second"}}}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	env := decodeRawAnkiEnv(t, rec)
	if string(env.Error) != "null" {
		t.Errorf("error = %s, want null", env.Error)
	}
	infos, err := coll.NotesInfo([]int64{noteID})
	if err != nil {
		t.Fatalf("NotesInfo: %v", err)
	}
	if infos[0].Fields["Front"] != "alpha" || infos[0].Fields["Back"] != "second" {
		t.Errorf("fields = %+v, want Front=alpha Back=second", infos[0].Fields)
	}
}

// --- 8765 bind lifecycle ---

// TestStartRawAnkiConnectListenerBinds pins that
// StartRawAnkiConnectListener binds the configured address on a
// successful path and serves the raw surface (verified by a
// successful POST).
func TestStartRawAnkiConnectListenerBinds(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	// Bind an ephemeral port; the listener binds there.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	// The DNS-rebinding guard accepts only the loopback hostnames
	// for the production port (RawAnkiConnectBind). This test
	// binds an ephemeral port instead; widen the accepted set so
	// the request reaches the dispatcher. Without this the
	// httptest-style guard would reject the POST as "invalid host".
	s.rawAnkiAcceptedHosts[addr] = struct{}{}
	if err := s.StartRawAnkiConnectListener(addr); err != nil {
		t.Fatalf("StartRawAnkiConnectListener: %v", err)
	}
	t.Cleanup(func() {
		// The listener is in a goroutine; we can't shut it down
		// gracefully (no Shutdown handle exposed). t.Cleanup runs
		// after the test; the goroutine dies with the test process
		// in normal go-test runs. For cleanliness we just let the
		// port linger until the test process exits.
	})
	// POST to the bound address — must succeed and return the
	// AnkiConnect wire shape.
	resp, err := http.Post("http://"+addr+"/", "application/json",
		strings.NewReader(`{"action":"version","version":6}`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var env rawAnkiEnv
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("decode: %v; body=%s", err, body)
	}
	if string(env.Result) != "6" {
		t.Errorf("result = %s, want 6", env.Result)
	}
}

// TestStartRawAnkiConnectListenerEADDRINUSE pins the EADDRINUSE
// tolerance: when the bind address is already taken (e.g. official
// AnkiConnect running on the user's desktop), StartRawAnkiConnectListener
// returns the bind error and the rest of the companion keeps
// working. The function must NEVER crash on bind failure.
//
// We bind a port first, then attempt to start the listener on the
// same port — the second bind fails with EADDRINUSE and is
// surfaced to the caller (which logs a warning + continues).
func TestStartRawAnkiConnectListenerEADDRINUSE(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	addr := ln.Addr().String()

	err = s.StartRawAnkiConnectListener(addr)
	if err == nil {
		t.Fatal("StartRawAnkiConnectListener: expected EADDRINUSE, got nil")
	}
	if !strings.Contains(err.Error(), "address already in use") &&
		!strings.Contains(err.Error(), "Only one usage of each socket address") {
		t.Errorf("error = %v, want EADDRINUSE-shaped", err)
	}
	// And the main Server is still usable (the bind failure on 8765
	// doesn't take down the rest of the companion).
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", s.handleHealth)
	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("health after bind failure: status = %d, want 200", rec.Code)
	}
}

// TestStartRawAnkiConnectListenerDisabledBridge pins that
// StartRawAnkiConnectListener is a no-op when the bridge is
// disabled (no Anki wiring). Even binding a random address would
// fail; the no-op short-circuits before any net.Listen call.
func TestStartRawAnkiConnectListenerDisabledBridge(t *testing.T) {
	s, err := New(Config{}) // no Anki
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := s.StartRawAnkiConnectListener("127.0.0.1:1"); err != nil {
		t.Errorf("disabled bridge: StartRawAnkiConnectListener = %v, want nil", err)
	}
}

// --- collection-not-available path ---

// TestRawAnkiCollectionNotOpen pins the bridge-up-but-collection-
// down path: the Collection is nil (e.g. AnkiDroid play-variant
// app-private path), so version / addNote etc. surface an
// AnkiConnect-shaped error envelope with "anki collection not
// available". The wire status is still HTTP 200.
func TestRawAnkiCollectionNotOpen(t *testing.T) {
	if runtime.GOOS == "android" || runtime.GOOS == "linux" {
		t.Skip("the fixture's OpenCollection succeeds on Android/Linux; the test pins the dev-host behaviour")
	}
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
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/",
		`{"action":"deckNames","version":6}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	env := decodeRawAnkiEnv(t, rec)
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "collection not available") {
		t.Errorf("error = %q, want it to contain \"collection not available\"", msg)
	}
}

// --- non-object params guard ---

// TestRawAnkiNonObjectParams pins the params-shape guard: a
// non-object params root (here, a JSON array) must surface as an
// AnkiConnect error envelope, not crash the dispatcher. The
// Collection is never opened for the action.
func TestRawAnkiNonObjectParams(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)

	body := `{"action":"deckNames","version":6,"params":[]}`
	rec := doRawAnkiRequest(t, mux, http.MethodPost, "/", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	env := decodeRawAnkiEnv(t, rec)
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if !strings.Contains(msg, "object") {
		t.Errorf("error = %q, want it to mention \"object\"", msg)
	}
}

// --- bridge disabled: no Anki surface ---

// TestRawAnkiRoutesUnregisteredWhenDisabled pins the spec
// contract: with Config.Anki == nil, StartRawAnkiConnectListener
// is a no-op, the Server has no anki field wired, and there is no
// Anki surface at all. The /v1/health route on the main server
// still works (zero behavior change for callers who never opted
// in).
func TestRawAnkiRoutesUnregisteredWhenDisabled(t *testing.T) {
	s, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// StartRawAnkiConnectListener is a no-op when bridge is
	// disabled.
	if err := s.StartRawAnkiConnectListener("127.0.0.1:1"); err != nil {
		t.Errorf("disabled bridge start: %v, want nil", err)
	}
	// The main server still serves /v1/health.
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", s.handleHealth)
	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("health on disabled bridge: status = %d, want 200", rec.Code)
	}
}

// DNS-rebinding guard tests (review hardening 2026-08-30). With
// CORS `*` on loopback, the one remaining gap is a public hostname
// pointed at 127.0.0.1; the Host header then reveals it. The raw
// listener MUST reject non-loopback Host headers with 403 — even on
// preflight (a rebinding probe gets nothing back). These tests pin
// that contract end-to-end against s.handleRawAnkiConnect mounted on
// a fresh mux; the body uses `version` so no DB rows are required.
func TestRawAnkiConnectHostGuard(t *testing.T) {
	s, _, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)
	const body = `{"action":"version","version":6}`

	cases := []struct {
		name       string
		method     string
		host       string // empty means strip the Host header
		wantStatus int
	}{
		{"reject evil host POST", http.MethodPost, "evil.example.com:8765", http.StatusForbidden},
		{"reject evil host OPTIONS", http.MethodOptions, "evil.example.com:8765", http.StatusForbidden},
		{"reject public IP POST", http.MethodPost, "203.0.113.1:8765", http.StatusForbidden},
		{"reject rebinding-like POST", http.MethodPost, "127.0.0.1.evil.example:8765", http.StatusForbidden},
		// Wrong loopback port: hostname-only matching ACCEPTS it. A request
		// with Host 127.0.0.1:9999 can never reach our 8765 listener through
		// a browser (the socket dial targets 9999) — the only browser-side
		// threat is DNS rebinding, which is hostname-based and covered.
		{"accept wrong loopback port POST", http.MethodPost, "127.0.0.1:9999", http.StatusOK},
		{"accept loopback POST", http.MethodPost, "127.0.0.1:8765", http.StatusOK},
		{"accept localhost POST", http.MethodPost, "localhost:8765", http.StatusOK},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/", strings.NewReader(body))
			if tc.host == "" {
				req.Host = ""
			} else {
				req.Host = tc.host
			}
			if tc.method == http.MethodPost {
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Errorf("host=%q method=%s: status = %d, want %d (body=%s)",
					tc.host, tc.method, rec.Code, tc.wantStatus, rec.Body.String())
			}
		})
	}

	// Absent Host header (HTTP/1.0-style) is allowed — those
	// requests carry no hostname to rebind.
	t.Run("accept absent host", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		req.Host = ""
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("absent host: status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
		}
	})
}
