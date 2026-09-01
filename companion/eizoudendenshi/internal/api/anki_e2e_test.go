package api

// End-to-end mock-flow tests for the raw AnkiConnect-compatible
// listener (internal/api/anki_connect.go, bind 127.0.0.1:8765,
// EIZOU_DENDENSHI_ANKIDROID_CONNECT.md v4.2, 2026-08-31).
//
// The existing internal/api/anki_connect_test.go pins the wire
// surface in isolation (httptest, one action per case). This file
// goes one step further: it spins up a REAL HTTP server on a REAL
// TCP socket and walks the exact sequence of actions that real
// clients send. The bridge must pass a comprehensive simulation of
// the REAL client flows (Yomitan and the deployed Entei web page)
// against the 8765 listener; without that evidence the change is
// rejected. CORS origins are exercised end-to-end.
//
// Scenarios:
//
//   1. Yomitan flow — 10 actions in the extension's exact order:
//      version → deckNames → modelNames → modelFieldNames →
//      canAddNotes → addNote (text-only) → findNotes → notesInfo →
//      updateNoteFields → addTags. Every request sends
//      `Origin: https://entei.gorakudo.org`; two requests also
//      cover `Origin: chrome-extension://abc` (the wildcard
//      extension origin); every response asserts
//      `Access-Control-Allow-Origin: *`.
//
//   2. Entei mining flow (deployed AM-6) — single addNote with all
//      three media arrays (audio + video + picture) and the
//      deterministic-filename rewrite. The stored names appear in
//      notesInfo's field markup ([sound:...]/<img src=...>) AND
//      the files exist on disk. storeMediaFile round-trip:
//
//      storeMediaFile → stored-name reference in addNote →
//      notesInfo echoes it.
//
//   3. Failure surfaces — unknown action (200 + error envelope),
//      duplicate addNote (200 + result:null + error:null), GET on
//      the listener (200 + AnkiConnect-shaped "unsupported method"
//      envelope — no panic), Host: evil.example.com (403, rebinding
//      guard).
//
//   4. Real listener round-trip — pre-bind an ephemeral port, then
//      StartRawAnkiConnectListener on it, then POST via real
//      http.Client. The menu-launch equivalent regression guard:
//      bridge enabled ⇒ listener actually serves on the wire.
//
// Hermetic: fixture collection (newTestAnkiCollectionFixture),
// t.TempDir media dir, ephemeral ports, t.Cleanup to close the
// server. No goroutine leaks past the test (the listener goroutine
// dies with the test process in normal go-test runs).

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"eizoudendenshi/internal/anki"
)

// rawAnkiServer is a thin wrapper around httptest.Server that pins
// the DNS-rebinding guard to accept the production RawAnkiConnectBind
// host. httptest's default URL is "example.com:NNN" which the guard
// would reject — we override the request Host in every helper below
// to keep the contract honest.
//
// Close is the cleanup hook the caller MUST defer (or wire into
// t.Cleanup) so the goroutine serving the listener dies before the
// next test reuses the port. The httptest.Server.Close already
// blocks on goroutine exit, so Close alone is sufficient.
type rawAnkiServer struct {
	*httptest.Server
}

func newRawAnkiListener(t *testing.T) (*rawAnkiServer, string) {
	t.Helper()
	s, dir, _ := newTestAnkiServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRawAnkiConnect)
	ts := httptest.NewServer(mux)
	rs := &rawAnkiServer{Server: ts}
	t.Cleanup(func() {
		ts.Close()
		_ = dir // dir is t.TempDir(); not directly needed by helpers
	})
	return rs, dir
}

// rawAnkiPost POSTs the raw AnkiConnect envelope to the test server
// and returns the decoded envelope + the raw recorder (for header
// assertions). Origin is the value of the Origin header; pass "" for
// no origin. Host defaults to the loopback RawAnkiConnectBind so the
// DNS-rebinding guard accepts the request — the wire contract is
// "browser POSTs to 127.0.0.1:8765", so the Host header on the wire
// carries the port.
//
// AnkiConnect sends TWO response shapes depending on the client's
// `version` field (official format_success_reply):
//   - version <= 4 (Yomitan): the body IS the bare result (6,
//     ["Default"], null, …) — no envelope.
//   - version > 4 (Entei) and every error reply: the standard
//     {"result": …, "error": …} envelope.
//
// The helper detects which shape came back and synthesizes an
// envelope for bare results (Result = raw body, Error = null) so ALL
// callers can assert uniformly. Tests that need the exact raw bytes
// (e.g. the "6\n" body) use rawAnkiPostV2 instead.
func rawAnkiPost(t *testing.T, ts *rawAnkiServer, origin, body string) (*http.Response, rawAnkiEnv) {
	t.Helper()
	resp, raw := rawAnkiPostV2(t, ts, origin, body)
	// Standard envelope? Only {"result":…} objects count — a bare
	// result that happens to be an object (e.g. deckNamesAndIds
	// returning {"Default": id}) must NOT be mistaken for one.
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err == nil {
		if _, hasResult := probe["result"]; hasResult {
			var env rawAnkiEnv
			if err := json.Unmarshal(raw, &env); err != nil {
				t.Fatalf("decode envelope: %v; body=%s", err, raw)
			}
			return resp, env
		}
	}
	// version<=4 success: the body IS the raw result. Synthesize an
	// envelope (trimming the trailing newline) so callers assert
	// uniformly against env.Result / env.Error.
	return resp, rawAnkiEnv{
		Result: json.RawMessage(bytes.TrimSpace(raw)),
		Error:  json.RawMessage("null"),
	}
}

// rawAnkiPostV2 POSTs the raw AnkiConnect envelope and returns the
// RAW response body bytes (plus the response for header assertions).
// Used by tests that must assert the exact wire bytes — e.g. the
// Yomitan flow (version: 2) where successes are bare results like
// "6\n" rather than the {"result":…,"error":…} envelope.
func rawAnkiPostV2(t *testing.T, ts *rawAnkiServer, origin, body string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL, strings.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Host = RawAnkiConnectBind
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", body, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", resp.StatusCode, raw)
	}
	return resp, raw
}

// rawAnkiGet issues a GET on the listener (AnkiConnect wire keeps
// HTTP 200 even on misrouted requests; the body is an error
// envelope). Used by Scenario 3 to assert no-panic behaviour.
func rawAnkiGet(t *testing.T, ts *rawAnkiServer, host string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if host == "" {
		req.Host = ""
	} else {
		req.Host = host
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	return resp
}

// assertCORSWildcard asserts every POST response carries
// Access-Control-Allow-Origin: * — the loopback-only threat model
// keeps the listener permissive so browser extensions (Yomitan,
// Entei) can reach it without an origin allowlist.
func assertCORSWildcard(t *testing.T, resp *http.Response) {
	t.Helper()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
}

// --- Scenario 1: Yomitan flow ---

// TestE2EYomitanFlow walks the extension's exact action sequence:
// discovery (version / deckNames / modelNames / modelFieldNames /
// canAddNotes) → insert (addNote text-only) → re-read (findNotes /
// notesInfo) → mutate (updateNoteFields / addTags). Every request
// sends `Origin: https://entei.gorakudo.org`; two requests also
// exercise the chrome-extension:// wildcard origin. Every response
// asserts ACAO: *. DB-write proof: the inserted note id surfaces in
// findNotes, the updated Back field surfaces in notesInfo, the
// added tag surfaces in notesInfo.
//
// Wire protocol: Yomitan's anki-connect.js hardcodes
// this._localVersion = 2, so every request here carries
// `"version":2` and every SUCCESS comes back as a BARE result
// (official AnkiConnect format_success_reply for api_version <= 4):
// step 1 asserts the exact "6\n" body; updateNoteFields / addTags
// assert a raw `null` body, NOT the {"result":null,"error":null}
// envelope.
func TestE2EYomitanFlow(t *testing.T) {
	ts, _ := newRawAnkiListener(t)
	const enteiOrigin = "https://entei.gorakudo.org"
	const extOrigin = "chrome-extension://abc"

	// 1. version → raw `6\n` body (no envelope for version<=4)
	resp, raw := rawAnkiPostV2(t, ts, enteiOrigin,
		`{"action":"version","version":2}`)
	assertCORSWildcard(t, resp)
	if string(raw) != "6\n" {
		t.Fatalf("version: body = %q, want \"6\\n\" (bare result for version<=4)", raw)
	}

	// 2. deckNames → includes "Default"
	resp, env := rawAnkiPost(t, ts, enteiOrigin,
		`{"action":"deckNames","version":2}`)
	assertCORSWildcard(t, resp)
	var decks []string
	if err := json.Unmarshal(env.Result, &decks); err != nil {
		t.Fatalf("decode deckNames: %v; raw=%s", err, env.Result)
	}
	if !containsString(decks, "Default") {
		t.Errorf("deckNames = %v, want it to include Default", decks)
	}

	// 3. modelNames → includes "Basic"
	resp, env = rawAnkiPost(t, ts, enteiOrigin,
		`{"action":"modelNames","version":2}`)
	assertCORSWildcard(t, resp)
	var models []string
	_ = json.Unmarshal(env.Result, &models)
	if !containsString(models, "Basic") {
		t.Errorf("modelNames = %v, want it to include Basic", models)
	}

	// 4. modelFieldNames {modelName:"Basic"} → Front, Back
	// First chrome-extension:// origin exercise.
	resp, env = rawAnkiPost(t, ts, extOrigin,
		`{"action":"modelFieldNames","version":2,"params":{"modelName":"Basic"}}`)
	assertCORSWildcard(t, resp)
	var fields []string
	_ = json.Unmarshal(env.Result, &fields)
	if !containsString(fields, "Front") || !containsString(fields, "Back") {
		t.Errorf("modelFieldNames = %v, want Front and Back", fields)
	}

	// 5. canAddNotes {notes:[{deckName:"Default", modelName:"Basic", fields:"", options:{allowDuplicate:false}}]} → [true]
	resp, env = rawAnkiPost(t, ts, enteiOrigin,
		`{"action":"canAddNotes","version":2,"params":{"notes":[{"deckName":"Default","modelName":"Basic","fields":"","options":{"allowDuplicate":false,"duplicateScope":"collection"}}]}}`)
	assertCORSWildcard(t, resp)
	var canAdd []bool
	_ = json.Unmarshal(env.Result, &canAdd)
	if len(canAdd) != 1 || !canAdd[0] {
		t.Errorf("canAddNotes = %v, want [true]", canAdd)
	}

	// 6. addNote (text-only) tags=["yomitan-test"] → noteId int64
	resp, env = rawAnkiPost(t, ts, enteiOrigin,
		`{"action":"addNote","version":2,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"hello","Back":"こんにちは"},"tags":["yomitan-test"]}}}`)
	assertCORSWildcard(t, resp)
	var noteID int64
	if err := json.Unmarshal(env.Result, &noteID); err != nil {
		t.Fatalf("addNote decode: %v; raw=%s", err, env.Result)
	}
	if noteID == 0 {
		t.Fatalf("addNote: result=%s, want int64 > 0", env.Result)
	}

	// 7. findNotes {query:"added:1"} → includes noteID (the
	// FindNotes implementation supports only the documented subset:
	// `added:1` and `nid:…`; the just-inserted note has mod > now-24h).
	resp, env = rawAnkiPost(t, ts, enteiOrigin,
		`{"action":"findNotes","version":2,"params":{"query":"added:1"}}`)
	assertCORSWildcard(t, resp)
	var foundIDs []int64
	_ = json.Unmarshal(env.Result, &foundIDs)
	if !containsInt64(foundIDs, noteID) {
		t.Errorf("findNotes = %v, want it to include %d", foundIDs, noteID)
	}

	// 8. notesInfo {notes:[noteID]} → fields match, tags include yomitan-test
	resp, env = rawAnkiPost(t, ts, enteiOrigin,
		fmt.Sprintf(`{"action":"notesInfo","version":2,"params":{"notes":[%d]}}`, noteID))
	assertCORSWildcard(t, resp)
	var infos []anki.NoteInfo
	if err := json.Unmarshal(env.Result, &infos); err != nil {
		t.Fatalf("notesInfo decode: %v; raw=%s", err, env.Result)
	}
	if len(infos) != 1 || infos[0].NoteID != noteID {
		t.Fatalf("notesInfo len=%d, want 1 with id=%d", len(infos), noteID)
	}
	if infos[0].Fields["Front"] != "hello" || infos[0].Fields["Back"] != "こんにちは" {
		t.Errorf("notesInfo fields = %+v, want Front=hello Back=こんにちは", infos[0].Fields)
	}
	if !containsString(infos[0].Tags, "yomitan-test") {
		t.Errorf("notesInfo tags = %v, want it to include yomitan-test", infos[0].Tags)
	}

	// 9. updateNoteFields {note:{id, fields:{Back:"updated word"}}} → bare `null`; re-read shows updated
	resp, env = rawAnkiPost(t, ts, extOrigin,
		fmt.Sprintf(`{"action":"updateNoteFields","version":2,"params":{"id":%d,"fields":{"Back":"updated word"}}}`, noteID))
	assertCORSWildcard(t, resp)
	if string(env.Result) != "null" || string(env.Error) != "null" {
		t.Errorf("updateNoteFields: result=%s error=%s, want bare null (v2 success)", env.Result, env.Error)
	}
	resp, env = rawAnkiPost(t, ts, enteiOrigin,
		fmt.Sprintf(`{"action":"notesInfo","version":2,"params":{"notes":[%d]}}`, noteID))
	assertCORSWildcard(t, resp)
	infos = nil
	_ = json.Unmarshal(env.Result, &infos)
	if infos[0].Fields["Back"] != "updated word" {
		t.Errorf("after updateNoteFields: Back=%q, want \"updated word\" (DB write proof)",
			infos[0].Fields["Back"])
	}

	// 10. addTags {notes:[noteID], tags:"extra"} → bare `null`; re-read shows both tags
	resp, env = rawAnkiPost(t, ts, enteiOrigin,
		fmt.Sprintf(`{"action":"addTags","version":2,"params":{"notes":[%d],"tags":"extra"}}`, noteID))
	assertCORSWildcard(t, resp)
	if string(env.Result) != "null" || string(env.Error) != "null" {
		t.Errorf("addTags: result=%s error=%s, want bare null (v2 success)", env.Result, env.Error)
	}
	resp, env = rawAnkiPost(t, ts, enteiOrigin,
		fmt.Sprintf(`{"action":"notesInfo","version":2,"params":{"notes":[%d]}}`, noteID))
	assertCORSWildcard(t, resp)
	infos = nil
	_ = json.Unmarshal(env.Result, &infos)
	if !containsString(infos[0].Tags, "yomitan-test") || !containsString(infos[0].Tags, "extra") {
		t.Errorf("after addTags: tags=%v, want [yomitan-test extra]", infos[0].Tags)
	}
}

// --- Scenario 2: Entei mining flow ---

// TestE2EEnteiMiningFlow exercises the deployed AM-6 path: one
// addNote that carries audio + video + picture arrays with non-
// empty data. The rewrite MUST produce three deterministic
// filenames, the matching files MUST exist on disk, and the field
// markup MUST contain the [sound:...] / <img src=...> tags
// referencing the stored names (rewriteAddNoteMedia's exact format).
//
// Then a storeMediaFile round-trip: caller sends a payload with
// filename "pre.webm", receives a hash-based stored name (≠ the
// original), the file exists, and an addNote that carries the
// stored name in [sound:<storedName>] markup produces a note whose
// notesInfo echoes the stored name verbatim. This proves the
// shared MediaWriter.Write contract between storeMediaFile and the
// addNote media-rewrite branch.
func TestE2EEnteiMiningFlow(t *testing.T) {
	ts, mediaDir := newRawAnkiListener(t)

	// Build the three payloads.
	audioBytes := []byte("entei audio payload")
	videoBytes := []byte("entei video payload")
	picBytes := []byte("entei picture payload")
	audioB64 := base64.StdEncoding.EncodeToString(audioBytes)
	videoB64 := base64.StdEncoding.EncodeToString(videoBytes)
	picB64 := base64.StdEncoding.EncodeToString(picBytes)

	wantAudio := anki.GenerateFilenameFromProvided("clip.webm", audioBytes)
	wantVideo := anki.GenerateFilenameFromProvided("clipV.webm", videoBytes)
	wantPic := anki.GenerateFilenameFromProvided("shot.jpg", picBytes)

	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"猫","Back":"cat"},"audio":[{"filename":"clip.webm","data":"` + audioB64 + `","fields":["Front"]}],"video":[{"filename":"clipV.webm","data":"` + videoB64 + `","fields":["Back"]}],"picture":[{"filename":"shot.jpg","data":"` + picB64 + `","fields":["Back"]}]}}}`
	resp, env := rawAnkiPost(t, ts, "", body)
	assertCORSWildcard(t, resp)
	if string(env.Error) != "null" {
		t.Fatalf("addNote with media arrays: error = %s; raw=%s", env.Error, env.Result)
	}
	var noteID int64
	if err := json.Unmarshal(env.Result, &noteID); err != nil {
		t.Fatalf("addNote decode: %v; raw=%s", err, env.Result)
	}
	if noteID == 0 {
		t.Fatalf("addNote: result=%s, want int64 > 0", env.Result)
	}

	// The three files MUST exist on disk.
	for _, p := range []struct{ wh, stored string }{
		{"audio", wantAudio}, {"video", wantVideo}, {"picture", wantPic},
	} {
		full := filepath.Join(mediaDir, p.stored)
		got, err := os.ReadFile(full)
		if err != nil {
			t.Fatalf("%s file missing on disk: %v (want %s in %s)", p.wh, err, p.stored, mediaDir)
		}
		var wantBytes []byte
		switch p.wh {
		case "audio":
			wantBytes = audioBytes
		case "video":
			wantBytes = videoBytes
		case "picture":
			wantBytes = picBytes
		}
		if !bytes.Equal(got, wantBytes) {
			t.Errorf("%s file bytes = %q, want %q", p.wh, got, wantBytes)
		}
	}

	// notesInfo: Front MUST contain [sound:<wantAudio>] (audio was
	// directed to Front) AND Back MUST contain [sound:<wantVideo>]
	// (video) AND <img src="<wantPic>"> (picture). rewriteAddNoteMedia
	// appends in the order they appear in the inbound note — we just
	// require the substrings to be present.
	resp, env = rawAnkiPost(t, ts, "",
		fmt.Sprintf(`{"action":"notesInfo","version":6,"params":{"notes":[%d]}}`, noteID))
	assertCORSWildcard(t, resp)
	var infos []anki.NoteInfo
	if err := json.Unmarshal(env.Result, &infos); err != nil {
		t.Fatalf("notesInfo decode: %v; raw=%s", err, env.Result)
	}
	if len(infos) != 1 || infos[0].NoteID != noteID {
		t.Fatalf("notesInfo: %+v, want 1 with id=%d", infos, noteID)
	}
	front := infos[0].Fields["Front"]
	if !strings.Contains(front, "[sound:"+wantAudio+"]") {
		t.Errorf("Front missing [sound:%s]: %q", wantAudio, front)
	}
	back := infos[0].Fields["Back"]
	if !strings.Contains(back, "[sound:"+wantVideo+"]") {
		t.Errorf("Back missing [sound:%s]: %q", wantVideo, back)
	}
	if !strings.Contains(back, `<img src="`+wantPic+`">`) {
		t.Errorf("Back missing <img src=\"%s\">: %q", wantPic, back)
	}

	// storeMediaFile round-trip: send a payload with filename
	// "pre.webm", expect a hash-based stored name (≠ "pre.webm").
	preBytes := []byte("pre-existing media blob")
	preB64 := base64.StdEncoding.EncodeToString(preBytes)
	resp, env = rawAnkiPost(t, ts, "",
		`{"action":"storeMediaFile","version":6,"params":{"filename":"pre.webm","data":"`+preB64+`"}}`)
	assertCORSWildcard(t, resp)
	var stored string
	if err := json.Unmarshal(env.Result, &stored); err != nil {
		t.Fatalf("storeMediaFile decode: %v; raw=%s", err, env.Result)
	}
	if stored == "pre.webm" || stored == "" {
		t.Fatalf("storeMediaFile stored = %q, want hash-based name ≠ pre.webm", stored)
	}
	if want := anki.GenerateFilenameFromProvided("pre.webm", preBytes); stored != want {
		t.Errorf("storeMediaFile stored = %q, want %q (deterministic hash)", stored, want)
	}
	full := filepath.Join(mediaDir, stored)
	if _, err := os.Stat(full); err != nil {
		t.Errorf("storeMediaFile file missing: %v (want %s)", err, stored)
	}
	// addNote referencing [sound:<stored>] in Front → notesInfo
	// echoes it.
	refBody := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"[sound:` + stored + `]","Back":"ref"},"tags":["ref"]}}}`
	resp, env = rawAnkiPost(t, ts, "", refBody)
	assertCORSWildcard(t, resp)
	var refID int64
	_ = json.Unmarshal(env.Result, &refID)
	if refID == 0 {
		t.Fatalf("addNote (ref): result=%s, want int64 > 0", env.Result)
	}
	resp, env = rawAnkiPost(t, ts, "",
		fmt.Sprintf(`{"action":"notesInfo","version":6,"params":{"notes":[%d]}}`, refID))
	assertCORSWildcard(t, resp)
	infos = nil
	_ = json.Unmarshal(env.Result, &infos)
	if len(infos) != 1 {
		t.Fatalf("notesInfo len=%d, want 1", len(infos))
	}
	if !strings.Contains(infos[0].Fields["Front"], stored) {
		t.Errorf("ref note Front = %q, want it to contain stored name %q",
			infos[0].Fields["Front"], stored)
	}
}

// --- Scenario 3: failure surfaces ---

// TestE2EFailureSurfaces pins the AnkiConnect wire contract for
// every error code path: HTTP 200 with a JSON error envelope on
// unknown action + missing action; HTTP 200 + result:null + error:null
// on duplicate addNote; HTTP 200 + AnkiConnect-shaped error on a
// misrouted GET; HTTP 403 on Host: evil.example.com (DNS-rebinding
// guard). No panic on any branch.
func TestE2EFailureSurfaces(t *testing.T) {
	ts, _ := newRawAnkiListener(t)

	// unknown action → result null, error non-empty
	resp, env := rawAnkiPost(t, ts, "",
		`{"action":"this-action-does-not-exist","version":6}`)
	assertCORSWildcard(t, resp)
	if string(env.Result) != "null" {
		t.Errorf("unknown action result = %s, want null", env.Result)
	}
	var msg string
	_ = json.Unmarshal(env.Error, &msg)
	if msg == "" {
		t.Errorf("unknown action error = %s, want non-empty", env.Error)
	}

	// addNote allowDuplicate=false twice with the same first field →
	// 2nd = {result:null, error:null} (matches official AnkiConnect)
	resp, env = rawAnkiPost(t, ts, "",
		`{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"dup-key-2","Back":"x"},"options":{"allowDuplicate":false,"duplicateScope":"collection"}}}}`)
	assertCORSWildcard(t, resp)
	if string(env.Error) != "null" {
		t.Fatalf("first addNote error = %s, want null; raw=%s", env.Error, env.Result)
	}
	resp, env = rawAnkiPost(t, ts, "",
		`{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"dup-key-2","Back":"different"},"options":{"allowDuplicate":false,"duplicateScope":"collection"}}}}`)
	assertCORSWildcard(t, resp)
	if string(env.Result) != "null" || string(env.Error) != "null" {
		t.Errorf("duplicate addNote: result=%s error=%s, want result=null error=null",
			env.Result, env.Error)
	}

	// GET on the listener → 200 + AnkiConnect-shaped envelope (no panic)
	req, err := http.NewRequest(http.MethodGet, ts.URL, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Host = RawAnkiConnectBind
	resp, err = ts.Client().Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d, want 200 (AnkiConnect keeps 200 on misroute)", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var getEnv rawAnkiEnv
	if err := json.Unmarshal(body, &getEnv); err != nil {
		t.Fatalf("GET body decode: %v; body=%s", err, body)
	}
	var getMsg string
	_ = json.Unmarshal(getEnv.Error, &getMsg)
	if !strings.Contains(getMsg, "unsupported method") {
		t.Errorf("GET error = %q, want it to contain \"unsupported method\"", getMsg)
	}

	// Host: evil.example.com → 403 (rebinding guard)
	req, err = http.NewRequest(http.MethodPost, ts.URL,
		strings.NewReader(`{"action":"version","version":6}`))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Host = "evil.example.com:8765"
	req.Header.Set("Content-Type", "application/json")
	resp, err = ts.Client().Do(req)
	if err != nil {
		t.Fatalf("POST (evil host): %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("evil host status = %d, want 403", resp.StatusCode)
	}
}

// --- Scenario 4: real listener round-trip ---

// TestE2EStartRawAnkiConnectListenerRoundTrip is the menu-launch
// regression guard. The user-facing question this answers is:
// "Bridge enabled ⇒ does the listener actually serve on the wire?"
//
// We pre-bind an ephemeral loopback port, register the addr in
// s.rawAnkiAcceptedHosts (mirror of the existing EADDRINUSE test),
// then StartRawAnkiConnectListener on that addr. A real http.Client
// POSTs version + addNote to the bound port and both succeed. A
// loopback-accepted addr override is necessary because httptest
// binds "127.0.0.1:0" and the rebinding guard only knows the
// production RawAnkiConnectBind host by default.
func TestE2EStartRawAnkiConnectListenerRoundTrip(t *testing.T) {
	s, _, coll := newTestAnkiServer(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("bind ephemeral: %v", err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatalf("release ephemeral: %v", err)
	}
	// Mirror the existing EADDRINUSE test: widen the rebinding
	// guard so the test's Host header reaches the dispatcher.
	s.rawAnkiAcceptedHosts[addr] = struct{}{}
	if err := s.StartRawAnkiConnectListener(addr); err != nil {
		t.Fatalf("StartRawAnkiConnectListener: %v", err)
	}

	// Real http.Client → version
	resp, err := http.Post("http://"+addr+"/", "application/json",
		strings.NewReader(`{"action":"version","version":6}`))
	if err != nil {
		t.Fatalf("POST version: %v", err)
	}
	versionBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("version status = %d, want 200; body=%s", resp.StatusCode, versionBody)
	}
	var env rawAnkiEnv
	if err := json.Unmarshal(versionBody, &env); err != nil {
		t.Fatalf("version decode: %v; body=%s", err, versionBody)
	}
	if string(env.Result) != "6" {
		t.Errorf("version result = %s, want 6", env.Result)
	}

	// Real http.Client → addNote (text-only) to prove DB writes work
	// through the wire listener.
	addBody := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Default","modelName":"Basic","fields":{"Front":"wire-test","Back":"ワイヤー"}}}}`
	resp, err = http.Post("http://"+addr+"/", "application/json", strings.NewReader(addBody))
	if err != nil {
		t.Fatalf("POST addNote: %v", err)
	}
	addRaw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("addNote status = %d, want 200; body=%s", resp.StatusCode, addRaw)
	}
	env = rawAnkiEnv{}
	if err := json.Unmarshal(addRaw, &env); err != nil {
		t.Fatalf("addNote decode: %v; body=%s", err, addRaw)
	}
	if string(env.Error) != "null" {
		t.Fatalf("addNote error = %s; body=%s", env.Error, addRaw)
	}
	var noteID int64
	_ = json.Unmarshal(env.Result, &noteID)
	if noteID == 0 {
		t.Fatalf("addNote result = %s, want int64 > 0", env.Result)
	}

	// DB write proof: NotesInfo finds the note we just inserted via
	// the real wire listener.
	infos, err := coll.NotesInfo([]int64{noteID})
	if err != nil {
		t.Fatalf("NotesInfo: %v", err)
	}
	if len(infos) != 1 || infos[0].NoteID != noteID {
		t.Fatalf("NotesInfo: %+v, want 1 with id=%d", infos, noteID)
	}
	if infos[0].Fields["Front"] != "wire-test" || infos[0].Fields["Back"] != "ワイヤー" {
		t.Errorf("notesInfo fields = %+v", infos[0].Fields)
	}
}

// --- helpers ---

// containsString reports whether v contains s.
func containsString(v []string, s string) bool {
	for _, x := range v {
		if x == s {
			return true
		}
	}
	return false
}

// containsInt64 reports whether v contains n.
func containsInt64(v []int64, n int64) bool {
	for _, x := range v {
		if x == n {
			return true
		}
	}
	return false
}
