package anki

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ErrUpstreamHTTP is returned when the AnkiconnectAndroid HTTP response
// is non-2xx. The wrapped error carries the status code but never the
// upstream body (AnkiDroid echoes the original AnkiConnect message text,
// which can include filenames / URLs / user content).
type ErrUpstreamHTTP struct {
	Status int
}

func (e *ErrUpstreamHTTP) Error() string {
	return fmt.Sprintf("anki: upstream HTTP %d", e.Status)
}

// ErrUpstreamAnki is returned when the upstream response is 2xx but the
// AnkiConnect envelope carries a non-null "error" field. The wrapped
// error message is the literal upstream message (AnkiConnect /
// AnkiconnectAndroid error strings are operator-safe — see spec §9).
type ErrUpstreamAnki struct {
	Message string
}

func (e *ErrUpstreamAnki) Error() string {
	return "anki: " + e.Message
}

// NoteProxy forwards AnkiConnect envelopes to AnkiconnectAndroid on
// :8080. The shape (action / version / params) is exactly what
// AnkiConnect uses; AnkiconnectAndroid accepts POST JSON at its root
// the same way. The response envelope ({"result":…,"error":…}) is
// decoded and returned as json.RawMessage so the API layer can
// forward it to the caller verbatim — the caller is the upstream
// contract.
//
// Construction takes the base URL (e.g. "http://127.0.0.1:8080") and
// an optional *http.Client (nil → http.DefaultClient). Tests inject a
// custom Transport; production code uses the default.
type NoteProxy struct {
	baseURL string
	client  *http.Client
}

// NewNoteProxy returns a NoteProxy bound to baseURL. Trailing slashes
// are trimmed so the request path "/<action-handler>" (if any) can be
// appended later without surprises — currently we POST JSON to the
// root, which is what both AnkiConnect (port 8765) and
// AnkiconnectAndroid (port 8080) accept.
func NewNoteProxy(baseURL string, client *http.Client) *NoteProxy {
	baseURL = strings.TrimRight(baseURL, "/")
	if client == nil {
		client = http.DefaultClient
	}
	return &NoteProxy{baseURL: baseURL, client: client}
}

// envelope is the wire shape shared by AnkiConnect and
// AnkiconnectAndroid. Only the fields the proxy reads are declared;
// the inner params are forwarded verbatim as raw JSON.
type envelope struct {
	Action  string          `json:"action"`
	Version int             `json:"version"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// responseEnvelope is the wire shape of the upstream reply. The result
// is intentionally undecoded — the caller forwards it as-is.
type responseEnvelope struct {
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

// Call sends the AnkiConnect envelope to the upstream proxy and
// returns the result field. Non-2xx HTTP or a non-null "error" field
// become typed errors so the API layer can map them to HTTP statuses
// without leaking the upstream body (which can echo user content).
//
// The "version" and "params" fields are forwarded verbatim — the proxy
// does not interpret them, only the caller does (in particular, the
// /v1/anki/action handler rewrites params.note.audio/video/picture
// entries before forwarding, but the proxy itself is a plain pipe).
func (p *NoteProxy) Call(ctx context.Context, action string, version int, params map[string]any) (json.RawMessage, error) {
	if p == nil || p.baseURL == "" {
		return nil, errors.New("anki: proxy not configured")
	}
	var paramsRaw json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return nil, fmt.Errorf("anki: marshal params: %w", err)
		}
		paramsRaw = b
	}
	body, err := json.Marshal(envelope{Action: action, Version: version, Params: paramsRaw})
	if err != nil {
		return nil, fmt.Errorf("anki: marshal envelope: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("anki: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("anki: upstream request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Drain a bounded prefix so the connection can be reused; never
		// surface the body — it can echo user filenames or URLs (spec §9
		// redaction discipline).
		_, _ = io.CopyN(io.Discard, resp.Body, 4096)
		return nil, &ErrUpstreamHTTP{Status: resp.StatusCode}
	}
	var env responseEnvelope
	dec := json.NewDecoder(resp.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		return nil, fmt.Errorf("anki: decode upstream envelope: %w", err)
	}
	if len(env.Error) > 0 && !isJSONNull(env.Error) {
		// AnkiConnect / AnkiconnectAndroid return error as a string
		// ("action not allowed") or as a richer object; we surface
		// the JSON-as-string form (operator-safe; never echoes user
		// content) and stringify an object form so the API layer can
		// return it directly without further decode.
		var asStr string
		if err := json.Unmarshal(env.Error, &asStr); err == nil {
			return nil, &ErrUpstreamAnki{Message: asStr}
		}
		return nil, &ErrUpstreamAnki{Message: string(env.Error)}
	}
	return env.Result, nil
}

// isJSONNull reports whether the raw JSON token is a literal null. The
// upstream envelope uses null as the success indicator for "no error".
func isJSONNull(b []byte) bool {
	s := strings.TrimSpace(string(b))
	return s == "" || s == "null"
}

// ForwardEnvelope is a thin pass-through used by the /v1/anki/action
// handler: the handler parses the inbound envelope (so it can rewrite
// params.note.media arrays), then hands the already-marshaled JSON back
// to the proxy. This avoids a re-marshal round-trip on the params
// subtree (which can be large for picture/video entries).
//
// The action/version/params shape is enforced at parse time by the
// caller; ForwardEnvelope forwards whatever it is given. The error
// contract matches Call.
func (p *NoteProxy) ForwardEnvelope(ctx context.Context, raw []byte) (json.RawMessage, error) {
	if p == nil || p.baseURL == "" {
		return nil, errors.New("anki: proxy not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL, bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("anki: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("anki: upstream request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.CopyN(io.Discard, resp.Body, 4096)
		return nil, &ErrUpstreamHTTP{Status: resp.StatusCode}
	}
	var env responseEnvelope
	dec := json.NewDecoder(resp.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		return nil, fmt.Errorf("anki: decode upstream envelope: %w", err)
	}
	if len(env.Error) > 0 && !isJSONNull(env.Error) {
		var asStr string
		if err := json.Unmarshal(env.Error, &asStr); err == nil {
			return nil, &ErrUpstreamAnki{Message: asStr}
		}
		return nil, &ErrUpstreamAnki{Message: string(env.Error)}
	}
	return env.Result, nil
}