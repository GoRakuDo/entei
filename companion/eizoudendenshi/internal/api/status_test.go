package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// statusURL builds the /v1/media/status request path with the capability
// token as the query parameter (same shape as the media endpoint).
func statusURL(token string) string {
	return "/v1/media/status?token=" + token
}

// doStatus issues an authorized GET for /v1/media/status from the Entei
// origin.
func doStatus(t *testing.T, h http.Handler, token, method string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, statusURL(token), nil)
	req.Header.Set("Origin", allowedOriginEntei)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// decodeStatus parses a status response and pins the envelope: 200 JSON,
// no-store, exact ACAO, Vary: Origin, and no secrets in the body.
func decodeStatus(t *testing.T, rec *httptest.ResponseRecorder, s *Server) statusBody {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%q", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != allowedOriginEntei {
		t.Errorf("ACAO = %q, want %q", got, allowedOriginEntei)
	}
	if !hasVary(rec, "Origin") {
		t.Error("missing Vary: Origin")
	}
	if !json.Valid(rec.Body.Bytes()) {
		t.Fatalf("body is not valid JSON: %q", rec.Body.String())
	}
	var b statusBody
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("invalid status body %q: %v", rec.Body.String(), err)
	}
	assertNoSecrets(t, rec, s, "")
	return b
}

// assertStatusKeys pins the body to exactly the documented fields — no
// extra keys can carry leaked information.
func assertStatusKeys(t *testing.T, rec *httptest.ResponseRecorder, wantRetryAfter bool) {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("unmarshal keys: %v", err)
	}
	expected := []string{"state", "available", "total", "headReady"}
	if wantRetryAfter {
		expected = append(expected, "retryAfter")
	}
	if len(m) != len(expected) {
		t.Errorf("status body has %d keys (%v), want exactly %v",
			len(m), sortedKeys(m), expected)
	}
	for _, k := range expected {
		if _, ok := m[k]; !ok {
			t.Errorf("status body missing key %q", k)
		}
	}
}

func sortedKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}

// The Retry-After hint in the status body and the 503 media responses must
// stay in sync — both are the same contract value.
func TestStatusRetryAfterTiedToBufferingContract(t *testing.T) {
	if got := strconv.Itoa(bufferingRetryAfterSec); got != bufferingRetryAfter {
		t.Errorf("bufferingRetryAfterSec = %d, but growing.go sends Retry-After %q",
			bufferingRetryAfterSec, bufferingRetryAfter)
	}
}

// --- state cases ---

func TestStatusDisabledWhenNoSource(t *testing.T) {
	s := newTestServer(t)
	rec := doStatus(t, s.Handler(), s.token, http.MethodGet)
	b := decodeStatus(t, rec, s)
	if b.State != statusDisabled {
		t.Errorf("state = %q, want %q", b.State, statusDisabled)
	}
	if b.Available != 0 || b.Total != 0 {
		t.Errorf("disabled body = %+v, want available 0 / total 0", b)
	}
	if b.HeadReady {
		t.Error("headReady = true, want false (not implemented)")
	}
	if b.RetryAfter != 0 {
		t.Errorf("disabled body carries retryAfter = %d, want absent", b.RetryAfter)
	}
	assertStatusKeys(t, rec, false)
}

func TestStatusStaticFixtureComplete(t *testing.T) {
	s, fixture := newTestServerWithFixture(t)
	fixtureBytes, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	rec := doStatus(t, s.Handler(), s.token, http.MethodGet)
	b := decodeStatus(t, rec, s)
	if b.State != statusComplete {
		t.Errorf("state = %q, want %q", b.State, statusComplete)
	}
	if b.Available != int64(len(fixtureBytes)) || b.Total != int64(len(fixtureBytes)) {
		t.Errorf("static fixture body = %+v, want available == total == %d", b, len(fixtureBytes))
	}
	if b.HeadReady {
		t.Error("headReady = true, want false (not implemented)")
	}
	assertStatusKeys(t, rec, false)
}

// A static fixture that cannot be opened is a source failure: fail closed
// with a generic "error" state — no path hints, no sizes.
func TestStatusStaticFixtureMissingFailsClosed(t *testing.T) {
	fixture := filepath.Join(t.TempDir(), "missing.mp4")
	s, err := New(Config{FixturePath: fixture})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	rec := doStatus(t, s.Handler(), s.token, http.MethodGet)
	b := decodeStatus(t, rec, s)
	if b.State != statusError {
		t.Errorf("state = %q, want %q", b.State, statusError)
	}
	if b.Available != 0 || b.Total != 0 {
		t.Errorf("fail-closed body = %+v, want available 0 / total 0", b)
	}
	if strings.Contains(rec.Body.String(), "missing") || strings.Contains(rec.Body.String(), ".mp4") {
		t.Errorf("fail-closed body leaks path hints: %q", rec.Body.String())
	}
	assertStatusKeys(t, rec, false)
}

func TestStatusGrowingBuffering(t *testing.T) {
	data := growData(2048)
	s, _ := newGrowServer(t, data, 100)
	rec := doStatus(t, s.Handler(), s.token, http.MethodGet)
	b := decodeStatus(t, rec, s)
	if b.State != statusBuffering {
		t.Errorf("state = %q, want %q", b.State, statusBuffering)
	}
	if b.Available != 100 || b.Total != 2048 {
		t.Errorf("buffering body = %+v, want available 100 / total 2048", b)
	}
	if b.HeadReady {
		t.Error("headReady = true, want false (not implemented)")
	}
	if b.RetryAfter != bufferingRetryAfterSec {
		t.Errorf("retryAfter = %d, want %d", b.RetryAfter, bufferingRetryAfterSec)
	}
	assertStatusKeys(t, rec, true)
}

func TestStatusGrowingComplete(t *testing.T) {
	data := growData(2048)
	s, _ := newGrowServer(t, data, int64(len(data)))
	rec := doStatus(t, s.Handler(), s.token, http.MethodGet)
	b := decodeStatus(t, rec, s)
	if b.State != statusComplete {
		t.Errorf("state = %q, want %q", b.State, statusComplete)
	}
	if b.Available != 2048 || b.Total != 2048 {
		t.Errorf("complete body = %+v, want available 2048 / total 2048", b)
	}
	if b.RetryAfter != 0 {
		t.Errorf("complete body carries retryAfter = %d, want absent", b.RetryAfter)
	}
	assertStatusKeys(t, rec, false)
}

// Availability is monotonic and the body always reflects the current
// snapshot: it advances with SetAvailable, never decreases, and never
// exceeds total.
func TestStatusGrowingMonotonicCurrent(t *testing.T) {
	data := growData(4096)
	s, src := newGrowServer(t, data, 0)
	h := s.Handler()

	state := func() (string, int64, int64) {
		rec := doStatus(t, h, s.token, http.MethodGet)
		b := decodeStatus(t, rec, s)
		return b.State, b.Available, b.Total
	}

	if st, avail, total := state(); st != statusBuffering || avail != 0 || total != 4096 {
		t.Fatalf("initial = %s %d/%d, want buffering 0/4096", st, avail, total)
	}

	src.SetAvailable(100)
	if st, avail, _ := state(); st != statusBuffering || avail != 100 {
		t.Fatalf("after SetAvailable(100) = %s %d, want buffering 100", st, avail)
	}

	// A lower value is ignored (monotonic): the snapshot must not go back.
	src.SetAvailable(50)
	if _, avail, _ := state(); avail != 100 {
		t.Fatalf("monotonicity violated: available went back to %d", avail)
	}

	src.SetAvailable(int64(len(data)))
	if st, avail, total := state(); st != statusComplete || avail != total || total != 4096 {
		t.Fatalf("after completion = %s %d/%d, want complete 4096/4096", st, avail, total)
	}
}

// --- HEAD parity ---

func TestStatusHeadMirrorsGet(t *testing.T) {
	cases := []struct {
		name string
		make func(*testing.T) (http.Handler, string)
	}{
		{"disabled", func(t *testing.T) (http.Handler, string) {
			s := newTestServer(t)
			return s.Handler(), s.token
		}},
		{"static complete", func(t *testing.T) (http.Handler, string) {
			s, _ := newTestServerWithFixture(t)
			return s.Handler(), s.token
		}},
		{"growing buffering", func(t *testing.T) (http.Handler, string) {
			s, _ := newGrowServer(t, growData(2048), 100)
			return s.Handler(), s.token
		}},
		{"growing complete", func(t *testing.T) (http.Handler, string) {
			s, _ := newGrowServer(t, growData(2048), 2048)
			return s.Handler(), s.token
		}},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			h, tok := tt.make(t)
			recG := doStatus(t, h, tok, http.MethodGet)
			recH := doStatus(t, h, tok, http.MethodHead)
			if recH.Code != recG.Code {
				t.Errorf("HEAD status = %d, want %d (GET parity)", recH.Code, recG.Code)
			}
			for _, header := range []string{"Content-Type", "Cache-Control", "Access-Control-Allow-Origin"} {
				if got := recH.Header().Get(header); got != recG.Header().Get(header) {
					t.Errorf("HEAD %s = %q, want %q (GET parity)", header, got, recG.Header().Get(header))
				}
			}
			if recH.Body.Len() != 0 {
				t.Fatalf("HEAD returned %d body bytes, want 0", recH.Body.Len())
			}
		})
	}
}

// --- gates ---

func TestStatusGatesBeforeServing(t *testing.T) {
	s, _ := newGrowServer(t, growData(2048), 100)
	h := s.Handler()

	// Missing token (allowed origin) → 401.
	req := httptest.NewRequest(http.MethodGet, "/v1/media/status", nil)
	req.Header.Set("Origin", allowedOriginEntei)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("missing token: status = %d, want 401", rec.Code)
	}
	assertNoSecrets(t, rec, s, "")

	// Invalid token (allowed origin) → 401.
	rec = doStatus(t, h, "deadbeef", http.MethodGet)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("invalid token: status = %d, want 401", rec.Code)
	}
	assertNoSecrets(t, rec, s, "")

	// Valid token, no Origin → 403 without CORS headers.
	req = httptest.NewRequest(http.MethodGet, statusURL(s.token), nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("no origin: status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("no-origin rejection sent ACAO = %q, want empty", got)
	}
	assertNoSecrets(t, rec, s, "")

	// Valid token, disallowed origin → 403 without CORS headers.
	req = httptest.NewRequest(http.MethodGet, statusURL(s.token), nil)
	req.Header.Set("Origin", disallowedOrigin)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("disallowed origin: status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed origin received ACAO = %q, want empty", got)
	}
	assertNoSecrets(t, rec, s, "")
}

func TestStatusPreflight(t *testing.T) {
	s, _ := newGrowServer(t, growData(2048), 100)

	// Allowed origin → 204 with GET/HEAD/OPTIONS advertised.
	req := httptest.NewRequest(http.MethodOptions, "/v1/media/status", nil)
	req.Header.Set("Origin", allowedOriginEntei)
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != allowedOriginEntei {
		t.Errorf("ACAO = %q, want %q", got, allowedOriginEntei)
	}
	methods := rec.Header().Get("Access-Control-Allow-Methods")
	for _, m := range []string{http.MethodGet, http.MethodHead, http.MethodOptions} {
		if !strings.Contains(methods, m) {
			t.Errorf("ACAM = %q, missing %s", methods, m)
		}
	}
	if !hasVary(rec, "Origin") {
		t.Error("missing Vary: Origin")
	}

	// Disallowed origin → 403 without CORS headers.
	req = httptest.NewRequest(http.MethodOptions, "/v1/media/status", nil)
	req.Header.Set("Origin", disallowedOrigin)
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("disallowed preflight status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed preflight received ACAO = %q, want empty", got)
	}
}

func TestStatusWrongMethod(t *testing.T) {
	s, _ := newGrowServer(t, growData(2048), 100)
	rec := doStatus(t, s.Handler(), s.token, http.MethodPost)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST status = %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Allow"); got != "GET, HEAD, OPTIONS" {
		t.Errorf("Allow = %q, want GET, HEAD, OPTIONS", got)
	}
}
