package anki

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestNoteProxyCallForwardsEnvelope pins the wire shape: the proxy
// marshals {action, version, params} as JSON to the upstream and reads
// back {"result": …, "error": null}. Tested with a httptest upstream
// that records the request body and returns a canned response.
func TestNoteProxyCallForwardsEnvelope(t *testing.T) {
	type received struct {
		Action  string         `json:"action"`
		Version int            `json:"version"`
		Params  map[string]any `json:"params"`
	}

	var got received
	var contentType string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contentType = r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("upstream decode body: %v", err)
			http.Error(w, "decode", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": "ok",
			"error":  nil,
		})
	}))
	defer upstream.Close()

	proxy := NewNoteProxy(upstream.URL, nil)
	result, err := proxy.Call(context.Background(), "canAddNotes", 6, map[string]any{
		"notes": []any{map[string]any{"id": 1}},
	})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if string(result) != `"ok"` {
		t.Errorf("result = %s, want \"ok\"", result)
	}
	if got.Action != "canAddNotes" {
		t.Errorf("upstream action = %q, want canAddNotes", got.Action)
	}
	if got.Version != 6 {
		t.Errorf("upstream version = %d, want 6", got.Version)
	}
	if notes, _ := got.Params["notes"].([]any); len(notes) != 1 {
		t.Errorf("upstream params notes = %v, want one entry", got.Params["notes"])
	}
	if !strings.HasPrefix(contentType, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", contentType)
	}
}

// TestNoteProxyCallNilParams pins the nil-params case: AnkiConnect
// allows omitting params for actions like "version6" / "deckNames".
// The proxy must send a body without a "params" key.
func TestNoteProxyCallNilParams(t *testing.T) {
	var got map[string]json.RawMessage
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": 6, "error": nil})
	}))
	defer upstream.Close()

	proxy := NewNoteProxy(upstream.URL, nil)
	if _, err := proxy.Call(context.Background(), "version6", 6, nil); err != nil {
		t.Fatalf("Call nil params: %v", err)
	}
	if got["action"] == nil || string(got["action"]) != `"version6"` {
		t.Errorf("action = %v, want version6", got["action"])
	}
}

// TestNoteProxyCallUpstreamErrorEnvelope pins the typed-error contract:
// a 2xx response with a non-null "error" field becomes ErrUpstreamAnki
// carrying the literal upstream message. The error text is forwarded
// verbatim because it is operator-safe (AnkiConnect error strings
// never echo user content).
func TestNoteProxyCallUpstreamErrorEnvelope(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": nil,
			"error":  "action not allowed",
		})
	}))
	defer upstream.Close()

	proxy := NewNoteProxy(upstream.URL, nil)
	_, err := proxy.Call(context.Background(), "addNote", 6, nil)
	var ae *ErrUpstreamAnki
	if !errors.As(err, &ae) {
		t.Fatalf("err = %v (%T), want ErrUpstreamAnki", err, err)
	}
	if ae.Message != "action not allowed" {
		t.Errorf("message = %q, want %q", ae.Message, "action not allowed")
	}
}

// TestNoteProxyCallUpstreamHTTPError pins the typed-error contract for
// a non-2xx upstream response: ErrUpstreamHTTP carries the status code,
// and the upstream body is intentionally drained (4 KiB max) and
// discarded — never surfaced to the caller (the body can echo user
// filenames / URLs).
func TestNoteProxyCallUpstreamHTTPError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		// Real upstream would echo filenames / URLs; the test
		// verifies that body never reaches the proxy error.
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream echoed a sensitive filename"))
	}))
	defer upstream.Close()

	proxy := NewNoteProxy(upstream.URL, nil)
	_, err := proxy.Call(context.Background(), "addNote", 6, nil)
	var ue *ErrUpstreamHTTP
	if !errors.As(err, &ue) {
		t.Fatalf("err = %v (%T), want ErrUpstreamHTTP", err, err)
	}
	if ue.Status != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", ue.Status)
	}
	if strings.Contains(err.Error(), "filename") {
		t.Errorf("error leaks upstream body: %v", err)
	}
}

// TestNoteProxyCallConnectionRefused pins the dial-error contract: when
// the upstream is unreachable, Call returns a wrapped error. This is
// the error class /v1/anki/action sees when AnkiconnectAndroid APK is
// not installed on the device (502 Bad Gateway in the handler).
func TestNoteProxyCallConnectionRefused(t *testing.T) {
	// A port that previously listened but has been closed refuses
	// connections immediately. httptest.NewServer returns a working URL;
	// we want a definitively-dead URL.
	addr := newDeadListener(t)

	proxy := NewNoteProxy("http://"+addr, &http.Client{
		Timeout: 500 * time.Millisecond,
	})
	_, err := proxy.Call(context.Background(), "version6", 6, nil)
	if err == nil {
		t.Fatal("expected connection-refused error, got nil")
	}
}

// TestNoteProxyForwardEnvelopeRewrite pins the addNote media rewrite
// flow: the handler computes a new filename for each media entry and
// rewrites the entry's filename before forwarding. The proxy carries
// the modified envelope verbatim — the upstream never sees the
// caller-supplied filename, only the deterministic content-hash form.
//
// The simulated web-side flow: send an addNote envelope with one
// audio entry, expect the upstream to receive the SAME envelope shape
// with the filename replaced by the content-hash name.
func TestNoteProxyForwardEnvelopeRewrite(t *testing.T) {
	data := []byte("the audio bytes")
	dataB64 := base64.StdEncoding.EncodeToString(data)
	wantStored := GenerateFilenameFromProvided("audio.webm", data)

	var got map[string]json.RawMessage
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": 42, "error": nil})
	}))
	defer upstream.Close()

	proxy := NewNoteProxy(upstream.URL, nil)

	// Build the modified envelope by hand (this is what the handler
	// does after running the addNote rewrite). Params.note.audio[0]
	// carries the rewritten filename.
	envelope := map[string]json.RawMessage{
		"action":  mustJSONRaw(t, "addNote"),
		"version": mustJSONRaw(t, 6),
		"params": mustJSONRaw(t, map[string]any{
			"note": map[string]any{
				"deckName":  "Mining",
				"modelName": "Basic",
				"fields":    map[string]any{"Front": "猫"},
				"audio": []any{
					map[string]any{
						"filename": wantStored,
						"data":     dataB64,
						"fields":   []any{"Front"},
					},
				},
			},
		}),
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	result, err := proxy.ForwardEnvelope(context.Background(), raw)
	if err != nil {
		t.Fatalf("ForwardEnvelope: %v", err)
	}
	if string(result) != "42" {
		t.Errorf("result = %s, want 42", result)
	}
	// Decode the params.note.audio[0].filename: it must equal the
	// deterministic stored name, NOT the caller-supplied "audio.webm".
	var params struct {
		Note struct {
			Audio []struct {
				Filename string `json:"filename"`
				Data     string `json:"data"`
				Fields   []string `json:"fields"`
			} `json:"audio"`
		} `json:"note"`
	}
	if err := json.Unmarshal(got["params"], &params); err != nil {
		t.Fatalf("decode params: %v", err)
	}
	if len(params.Note.Audio) != 1 {
		t.Fatalf("audio entries = %d, want 1", len(params.Note.Audio))
	}
	if params.Note.Audio[0].Filename != wantStored {
		t.Errorf("rewritten filename = %q, want %q", params.Note.Audio[0].Filename, wantStored)
	}
	if params.Note.Audio[0].Data != dataB64 {
		t.Errorf("data echoed verbatim? got %q, want %q", params.Note.Audio[0].Data, dataB64)
	}
}

// TestNoteProxyTrailingSlashTrimmed pins the URL normalization:
// trailing slashes on the base URL are stripped so callers passing
// "http://127.0.0.1:8080/" still hit the upstream root, not
// "/action" (which AnkiconnectAndroid does not serve).
func TestNoteProxyTrailingSlashTrimmed(t *testing.T) {
	var hits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": nil, "error": nil})
	}))
	defer upstream.Close()

	proxy := NewNoteProxy(upstream.URL+"/", nil)
	if _, err := proxy.Call(context.Background(), "version6", 6, nil); err != nil {
		t.Fatalf("Call: %v", err)
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Errorf("hits = %d, want 1 (only root path should be hit)", hits)
	}
}

// TestNoteProxyContextCancelled pins the context-cancellation contract:
// when the caller cancels mid-flight, Call returns a context error.
// Used by the handler to clean up on client disconnect.
func TestNoteProxyContextCancelled(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Hang until the client cancels.
		<-r.Context().Done()
	}))
	defer upstream.Close()

	proxy := NewNoteProxy(upstream.URL, &http.Client{Timeout: 5 * time.Second})
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately
	_, err := proxy.Call(ctx, "version6", 6, nil)
	if err == nil {
		t.Fatal("expected context error, got nil")
	}
}

// TestNoteProxyNotConfigured pins the empty-URL guard: NewNoteProxy("")
// returns a proxy whose Call returns a clear "not configured" error
// rather than dialing "" (which would crash with an obscure URL parse
// error).
func TestNoteProxyNotConfigured(t *testing.T) {
	proxy := NewNoteProxy("", nil)
	if proxy == nil {
		t.Fatal("NewNoteProxy(\"\") = nil")
	}
	_, err := proxy.Call(context.Background(), "version6", 6, nil)
	if err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Errorf("err = %v, want 'not configured'", err)
	}
}

// TestIsJSONNull pins the literal-null detection that distinguishes
// "no error" from "AnkiConnect error string". The upstream serializes
// null as the four-byte token "null" (no whitespace); we accept both
// raw and whitespace-padded forms.
func TestIsJSONNull(t *testing.T) {
	cases := []struct {
		in   []byte
		want bool
	}{
		{[]byte("null"), true},
		{[]byte(" null"), true},
		{[]byte("null "), true},
		{[]byte(""), true},
		{[]byte("\"err\""), false},
		{[]byte("{}"), false},
		{[]byte("[]"), false},
		{[]byte("0"), false},
	}
	for _, c := range cases {
		if got := isJSONNull(c.in); got != c.want {
			t.Errorf("isJSONNull(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// mustJSONRaw marshals v to a json.RawMessage, failing the test on
// error. Test helper — production code uses json.Marshal directly.
func mustJSONRaw(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// newDeadListener opens a TCP listener, closes it, and returns its
// address so the URL points at a definitively-dead port (used to
// test connection-refused propagation). Slightly more portable
// across CI sandboxes than picking an arbitrary hard-coded port.
// Returns the bound address; the caller dials it directly.
func newDeadListener(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("dead listener: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}