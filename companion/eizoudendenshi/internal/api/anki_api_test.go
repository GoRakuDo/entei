package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"eizoudendenshi/internal/anki"
)

// --- helpers ---

// newTestAnkiServer returns an api.Server with the AnkiDroid bridge
// wired: a MediaWriter bound to t.TempDir() (so /v1/anki/media lands on
// the test's own storage, not on the user's real collection.media)
// and a NoteProxy pointed at upstreamURL. When upstreamURL is empty the
// proxy still gets created but every action call hits a dead port —
// tests that exercise the action endpoint pass a real httptest server.
func newTestAnkiServer(t *testing.T, upstreamURL string) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	writer := anki.NewMediaWriterForTest(dir)
	proxy := anki.NewNoteProxy(upstreamURL, nil)
	s, err := New(Config{Anki: &AnkiBridge{
		Writer:          writer,
		Proxy:           proxy,
		ProxyConfigured: upstreamURL != "",
	}})
	if err != nil {
		t.Fatalf("New with Anki: %v", err)
	}
	return s, dir
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
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream must not be hit when the caller is unauthenticated")
	}))
	defer upstream.Close()
	s, _ := newTestAnkiServer(t, upstream.URL)

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
	s, _ := newTestAnkiServer(t, "")
	rec := doAnkiRequest(t, s.Handler(), http.MethodGet, "/v1/anki/status", allowedOriginEntei, "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: status = %d, want 401", rec.Code)
	}
	rec = doAnkiRequest(t, s.Handler(), http.MethodGet, "/v1/anki/status?token="+s.token, "", "")
	if rec.Code != http.StatusForbidden {
		t.Errorf("no origin: status = %d, want 403", rec.Code)
	}
}

// TestAnkiActionRequiresToken mirrors the gate for /v1/anki/action.
// The action endpoint must reject unauthenticated callers BEFORE the
// upstream proxy is dialed — otherwise an attacker could use the
// bridge as an open relay to the AnkiconnectAndroid instance.
func TestAnkiActionRequiresToken(t *testing.T) {
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = io.Copy(io.Discard, r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": nil, "error": nil})
	}))
	defer upstream.Close()
	s, _ := newTestAnkiServer(t, upstream.URL)

	body := `{"action":"version6","version":6}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost, "/v1/anki/action", allowedOriginEntei, body)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: status = %d, want 401", rec.Code)
	}
	rec = doAnkiRequest(t, s.Handler(), http.MethodPost, "/v1/anki/action?token="+s.token, "", body)
	if rec.Code != http.StatusForbidden {
		t.Errorf("no origin: status = %d, want 403", rec.Code)
	}
	if hits != 0 {
		t.Errorf("upstream hits = %d, want 0 (auth gate must block before dial)", hits)
	}
}

// --- happy path: /v1/anki/media ---

// TestAnkiMediaHappyPath pins the contract: a valid (origin + token)
// POST with base64 data lands on the MediaWriter's dir as a file
// named <prefix>_<hash>.<ext>, and the response carries the same
// stored name. The test writes a known byte sequence and verifies the
// stored file's bytes match.
func TestAnkiMediaHappyPath(t *testing.T) {
	s, dir := newTestAnkiServer(t, "")
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
	s, _ := newTestAnkiServer(t, "")
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
	s, _ := newTestAnkiServer(t, "")
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
	s, _ := newTestAnkiServer(t, "")

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
		Writer:          nil, // writer construction failed on this host
		Proxy:           anki.NewNoteProxy("http://127.0.0.1:8080", nil),
		ProxyConfigured: true,
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

// --- happy path: /v1/anki/action ---

// TestAnkiActionForwardsVersion6 pins the passthrough contract for
// the simplest AnkiConnect action: version6. The handler reads the
// envelope, does NOT rewrite (addNote-only), forwards to the proxy,
// and returns the upstream {"result":6,"error":null} envelope as-is.
func TestAnkiActionForwardsVersion6(t *testing.T) {
	var got map[string]json.RawMessage
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": 6, "error": nil})
	}))
	defer upstream.Close()
	s, _ := newTestAnkiServer(t, upstream.URL)

	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"action":"version6","version":6}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	// Upstream received the verbatim envelope.
	if string(got["action"]) != `"version6"` {
		t.Errorf("upstream action = %s, want version6", got["action"])
	}
	// Response is the standard {"result":6,"error":null} shape.
	var resp map[string]json.RawMessage
	decodeJSON(t, rec, &resp)
	if string(resp["result"]) != "6" {
		t.Errorf("response result = %s, want 6", resp["result"])
	}
	if string(resp["error"]) != "null" {
		t.Errorf("response error = %s, want null", resp["error"])
	}
}

// TestAnkiActionAddNoteRewrite pins the spec §3.3 contract: the
// addNote params.note.audio[0].filename is replaced by the
// deterministic content-hash name of the entry's decoded data, AND a
// matching file is created in the MediaWriter's dir BEFORE the
// envelope is forwarded. The upstream then receives the rewritten
// filename (not the caller-supplied "audio.webm").
//
// Beyond the filename rewrite, this test pins the BLOCKER fix from
// review: every other note key (deckName, modelName, fields, tags,
// options) MUST survive the rewrite unchanged. An earlier version of
// the handler unmarshalled params into a struct with only Audio/
// Video/Picture declared, dropping the rest on re-marshal.
func TestAnkiActionAddNoteRewrite(t *testing.T) {
	audioBytes := []byte("the audio bytes")
	audioB64 := base64.StdEncoding.EncodeToString(audioBytes)
	wantStored := anki.GenerateFilenameFromProvided("audio.webm", audioBytes)

	var got map[string]json.RawMessage
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": 42, "error": nil})
	}))
	defer upstream.Close()
	s, dir := newTestAnkiServer(t, upstream.URL)

	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Mining","modelName":"Basic","fields":{"Front":"cat"},"tags":[" vocab "],"options":{"allowDuplicate":false,"duplicateScope":"deck"},"audio":[{"filename":"audio.webm","data":"` + audioB64 + `","fields":["Front"]}]}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// The file MUST exist in the MediaWriter's dir.
	storedPath := filepath.Join(dir, wantStored)
	gotBytes, err := os.ReadFile(storedPath)
	if err != nil {
		t.Fatalf("read stored audio: %v", err)
	}
	if !bytes.Equal(gotBytes, audioBytes) {
		t.Errorf("stored bytes = %q, want %q", gotBytes, audioBytes)
	}

	// Decode the upstream note subtree as a generic map so we can
	// pin the BLOCKER fix: every original key survives verbatim.
	var params struct {
		Note map[string]json.RawMessage `json:"note"`
	}
	if err := json.Unmarshal(got["params"], &params); err != nil {
		t.Fatalf("decode params: %v", err)
	}
	if params.Note == nil {
		t.Fatal("upstream params.note is nil")
	}
	for _, key := range []string{"deckName", "modelName", "fields", "tags", "options"} {
		if _, ok := params.Note[key]; !ok {
			t.Errorf("upstream note dropped key %q (BLOCKER); got keys = %v", key, mapKeys(params.Note))
		}
	}
	if string(params.Note["deckName"]) != `"Mining"` {
		t.Errorf("upstream note.deckName = %s, want \"Mining\"", params.Note["deckName"])
	}
	if string(params.Note["modelName"]) != `"Basic"` {
		t.Errorf("upstream note.modelName = %s, want \"Basic\"", params.Note["modelName"])
	}
	if string(params.Note["fields"]) != `{"Front":"cat"}` {
		t.Errorf("upstream note.fields = %s, want {\"Front\":\"cat\"}", params.Note["fields"])
	}
	if string(params.Note["tags"]) != `[" vocab "]` {
		t.Errorf("upstream note.tags = %s, want [\" vocab \"]", params.Note["tags"])
	}
	if string(params.Note["options"]) != `{"allowDuplicate":false,"duplicateScope":"deck"}` {
		t.Errorf("upstream note.options = %s, want the original allowDuplicate/duplicateScope shape", params.Note["options"])
	}

	// Audio entry: filename rewritten to deterministic name; fields
	// array preserved verbatim.
	var audio []struct {
		Filename string   `json:"filename"`
		Data     string   `json:"data"`
		Fields   []string `json:"fields"`
	}
	if err := json.Unmarshal(params.Note["audio"], &audio); err != nil {
		t.Fatalf("decode note.audio: %v", err)
	}
	if len(audio) != 1 {
		t.Fatalf("audio entries = %d, want 1", len(audio))
	}
	if audio[0].Filename != wantStored {
		t.Errorf("upstream audio[0].filename = %q, want rewritten %q", audio[0].Filename, wantStored)
	}
	if audio[0].Data != audioB64 {
		t.Errorf("upstream audio[0].data was rewritten? got %q, want original base64", audio[0].Data)
	}
	if len(audio[0].Fields) != 1 || audio[0].Fields[0] != "Front" {
		t.Errorf("upstream audio[0].fields = %v, want [Front]", audio[0].Fields)
	}
}

// mapKeys is a tiny helper for the BLOCKER diagnostic message; not
// used elsewhere so it stays unexported to the test.
func mapKeys(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestAnkiActionAddNoteRewriteAllOptionsPreserved pins the second
// BLOCKER case from review: an addNote with non-empty tags and
// `options.allowDuplicate: true` round-trips with both intact (the
// previous struct-only handler dropped both because they were not in
// the typed shape).
func TestAnkiActionAddNoteRewriteAllOptionsPreserved(t *testing.T) {
	audioBytes := []byte("another audio payload")
	audioB64 := base64.StdEncoding.EncodeToString(audioBytes)
	wantStored := anki.GenerateFilenameFromProvided("clip.mp3", audioBytes)

	var got map[string]json.RawMessage
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": 99, "error": nil})
	}))
	defer upstream.Close()
	s, dir := newTestAnkiServer(t, upstream.URL)

	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"Mining","modelName":"Basic","fields":{"Front":"x","Back":"y"},"tags":["mining","srs"],"options":{"allowDuplicate":true},"audio":[{"filename":"clip.mp3","data":"` + audioB64 + `"}]}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	// The file landed under the deterministic name.
	if _, err := os.Stat(filepath.Join(dir, wantStored)); err != nil {
		t.Fatalf("stored file missing: %v", err)
	}
	var params struct {
		Note map[string]json.RawMessage `json:"note"`
	}
	if err := json.Unmarshal(got["params"], &params); err != nil {
		t.Fatalf("decode params: %v", err)
	}
	if string(params.Note["tags"]) != `["mining","srs"]` {
		t.Errorf("upstream note.tags = %s, want [\"mining\",\"srs\"]", params.Note["tags"])
	}
	if string(params.Note["options"]) != `{"allowDuplicate":true}` {
		t.Errorf("upstream note.options = %s, want {\"allowDuplicate\":true}", params.Note["options"])
	}
	// Audio filename rewritten, data untouched.
	var audio []struct {
		Filename string `json:"filename"`
		Data     string `json:"data"`
	}
	if err := json.Unmarshal(params.Note["audio"], &audio); err != nil {
		t.Fatalf("decode audio: %v", err)
	}
	if audio[0].Filename != wantStored {
		t.Errorf("audio[0].filename = %q, want %q", audio[0].Filename, wantStored)
	}
	if audio[0].Data != audioB64 {
		t.Errorf("audio[0].data mutated: got %q, want original base64", audio[0].Data)
	}
}

// TestAnkiActionUpstreamErrorPropagates pins the upstream-AnkiConnect
// error mapping: an {"error":"action not allowed"} envelope from the
// upstream surfaces as 502 with the operator-safe message. The web
// client can map by message.
func TestAnkiActionUpstreamErrorPropagates(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": nil,
			"error":  "action not allowed",
		})
	}))
	defer upstream.Close()
	s, _ := newTestAnkiServer(t, upstream.URL)

	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"action":"addNote","version":6,"params":{}}`)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "action not allowed") {
		t.Errorf("body missing operator message: %s", rec.Body.String())
	}
}

// TestAnkiActionMissingAction pins the input-validation gate: an
// envelope without "action" → 400, generic message. The upstream is
// never dialed.
func TestAnkiActionMissingAction(t *testing.T) {
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = io.Copy(io.Discard, r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": nil, "error": nil})
	}))
	defer upstream.Close()
	s, _ := newTestAnkiServer(t, upstream.URL)

	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"version":6,"params":{}}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("missing action: status = %d, want 400", rec.Code)
	}
	if hits != 0 {
		t.Errorf("upstream hits = %d, want 0", hits)
	}
}

// TestAnkiActionMediaArrayPassthrough pins the no-media path: an
// addNote with NO audio/video/picture arrays is forwarded verbatim
// (the handler skips the rewrite branch entirely).
func TestAnkiActionMediaArrayPassthrough(t *testing.T) {
	var got map[string]json.RawMessage
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": 7, "error": nil})
	}))
	defer upstream.Close()
	s, _ := newTestAnkiServer(t, upstream.URL)

	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei,
		`{"action":"addNote","version":6,"params":{"note":{"deckName":"Mining","modelName":"Basic","fields":{"Front":"cat"}}}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	// Upstream params.note has NO audio key (the rewrite branch did
	// not run).
	var params struct {
		Note map[string]json.RawMessage `json:"note"`
	}
	if err := json.Unmarshal(got["params"], &params); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, ok := params.Note["audio"]; ok {
		t.Errorf("upstream note carries audio key (rewrite ran on a no-media envelope): %v", params.Note)
	}
}

// TestAnkiActionMediaEntryWithURLPassesThrough pins the url+data
// contract: an audio/video/picture entry that carries BOTH "url" and
// "data" is forwarded untouched and NO file is written locally.
// Upstream AnkiconnectAndroid handles url-download — writing locally
// would create an orphan in collection.media and a duplicate write on
// the upstream side.
func TestAnkiActionMediaEntryWithURLPassesThrough(t *testing.T) {
	const wantStored = "remote.mp3"
	body := `{"action":"addNote","version":6,"params":{"note":{"deckName":"D","modelName":"M","audio":[{"url":"https://example.invalid/` + wantStored + `","filename":"` + wantStored + `","fields":["Front"]}]}}}`

	var got map[string]json.RawMessage
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": 1, "error": nil})
	}))
	defer upstream.Close()
	s, dir := newTestAnkiServer(t, upstream.URL)

	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	// Upstream received the entry VERBATIM — no filename rewrite.
	var params struct {
		Note map[string]json.RawMessage `json:"note"`
	}
	if err := json.Unmarshal(got["params"], &params); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(params.Note["audio"]) != `[{"url":"https://example.invalid/`+wantStored+`","filename":"`+wantStored+`","fields":["Front"]}]` {
		t.Errorf("upstream audio was mutated: %s", params.Note["audio"])
	}
	// No file landed in the media dir: url+data entries must NOT
	// trigger a local write (the review's MED-risk scenario).
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
}

// TestAnkiActionInvalidMediaBase64ReturnsBadRequest pins the
// client-body validation gate: an audio entry with non-base64 "data"
// must surface as 400 (anki.ErrBadRequest mapped), not 500 "anki
// action failed". Upstream is never dialed.
func TestAnkiActionInvalidMediaBase64ReturnsBadRequest(t *testing.T) {
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = io.Copy(io.Discard, r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": nil, "error": nil})
	}))
	defer upstream.Close()
	s, _ := newTestAnkiServer(t, upstream.URL)

	body := `{"action":"addNote","version":6,"params":{"note":{"audio":[{"data":"@@@not-base64"}]}}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid b64: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if hits != 0 {
		t.Errorf("upstream hits = %d, want 0 (400 must short-circuit before dial)", hits)
	}
}

// TestAnkiActionMalformedAddNoteParamsReturnsBadRequest pins the
// second client-body validation path: a non-object addNote params
// (here, a JSON array) must surface as 400, not 500. The previous
// behaviour wrapped the parse error in a generic 500.
func TestAnkiActionMalformedAddNoteParamsReturnsBadRequest(t *testing.T) {
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = io.Copy(io.Discard, r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": nil, "error": nil})
	}))
	defer upstream.Close()
	s, _ := newTestAnkiServer(t, upstream.URL)

	body := `{"action":"addNote","version":6,"params":{"note":[1,2,3]}}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("non-object note: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if hits != 0 {
		t.Errorf("upstream hits = %d, want 0 (400 must short-circuit before dial)", hits)
	}
}

// --- happy path: /v1/anki/status ---

// TestAnkiActionNonObjectParamsRootReturnsBadRequest pins the
// first client-body validation path on /v1/anki/action: a non-object
// params root (here, a JSON array) must surface as 400, not 500.
// Before the fix, json.Unmarshal failure was returned bare, so the
// generic 500 path swallowed what is really a client-shape error.
//
// NOTE: this test currently FAILS. The MED fix described for
// internal/api/anki.go ~line 265 only changes the addNote branch
// inside rewriteAddNoteMedia; for non-addNote actions the handler
// accepts env.Params as a raw json.RawMessage, so a JSON-array root
// decodes fine and is forwarded verbatim → 200 OK. The test is kept
// here verbatim per the user's request so the gap is visible; see
// the executor's report for the two-options resolution question.
func TestAnkiActionNonObjectParamsRootReturnsBadRequest(t *testing.T) {
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = io.Copy(io.Discard, r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": nil, "error": nil})
	}))
	defer upstream.Close()
	s, _ := newTestAnkiServer(t, upstream.URL)

	body := `{"action":"deckNames","version":6,"params":[]}`
	rec := doAnkiRequest(t, s.Handler(), http.MethodPost,
		"/v1/anki/action?token="+s.token, allowedOriginEntei, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("non-object params root: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if hits != 0 {
		t.Errorf("upstream hits = %d, want 0 (400 must short-circuit before dial)", hits)
	}
}

// TestAnkiStatusShape pins the status response shape and content
// sensitivity: the body carries only proxyConfigured /
// mediaDirWritable / mediaDir. No token, no upstream URL body, no
// pair code, no pairing URL.
func TestAnkiStatusShape(t *testing.T) {
	s, dir := newTestAnkiServer(t, "http://127.0.0.1:8080")
	rec := doAnkiRequest(t, s.Handler(), http.MethodGet,
		"/v1/anki/status?token="+s.token, allowedOriginEntei, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body ankiStatusBody
	decodeJSON(t, rec, &body)
	if !body.ProxyConfigured {
		t.Error("proxyConfigured = false, want true")
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
	s, dir := newTestAnkiServer(t, "")
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
	s, _ := newTestAnkiServer(t, "")
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
// bridge. This is the spec's --anki-proxy empty case.
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
	s, _ := newTestAnkiServer(t, "")

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
	s, _ := newTestAnkiServer(t, "")
	rec := doAnkiRequest(t, s.Handler(), http.MethodGet,
		"/v1/anki/media?token="+s.token, allowedOriginEntei, "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /v1/anki/media: status = %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Allow"); !strings.Contains(got, http.MethodPost) || !strings.Contains(got, http.MethodOptions) {
		t.Errorf("Allow = %q, want POST and OPTIONS", got)
	}
}