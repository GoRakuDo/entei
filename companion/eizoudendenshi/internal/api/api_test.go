package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const (
	allowedOriginEntei = "https://entei.gorakudo.org"
	allowedOriginLocal = "http://localhost:4321"
	disallowedOrigin   = "https://evil.example.com"
)

var tokenShape = regexp.MustCompile(`^[0-9a-f]{64}$`)

func newTestServer(t *testing.T) *Server {
	t.Helper()
	s, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

// newTestServerWithFixture returns a server configured with a disposable
// media file (ED-2B). Returns the server and the fixture path.
func newTestServerWithFixture(t *testing.T) (*Server, string) {
	t.Helper()
	fixture := filepath.Join(t.TempDir(), "fixture.mp4")
	payload := make([]byte, 2048)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	if err := os.WriteFile(fixture, payload, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	s, err := New(Config{FixturePath: fixture})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s, fixture
}

func doRequest(t *testing.T, h http.Handler, method, path, origin, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHealthReportsNonSensitiveData(t *testing.T) {
	s := newTestServer(t)
	rec := doRequest(t, s.Handler(), http.MethodGet, "/v1/health", "", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["status"] != "ready" {
		t.Errorf("status = %q, want ready", body["status"])
	}
	if body["version"] != Version {
		t.Errorf("version = %q, want %q", body["version"], Version)
	}
	if body["apiVersion"] != apiVersion {
		t.Errorf("apiVersion = %q, want %q", body["apiVersion"], apiVersion)
	}
	// Health must never expose the pairing code or capability token.
	for _, secret := range []string{s.code, s.token} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatalf("health response leaks %q", secret)
		}
	}
}

func TestHealthCORSHappyPath(t *testing.T) {
	s := newTestServer(t)
	for _, origin := range []string{allowedOriginEntei, allowedOriginLocal} {
		rec := doRequest(t, s.Handler(), http.MethodGet, "/v1/health", origin, "")
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Errorf("origin %q: ACAO = %q, want %q", origin, got, origin)
		}
		if !hasVary(rec, "Origin") {
			t.Errorf("origin %q: missing Vary: Origin", origin)
		}
	}
}

func TestHealthDisallowedOriginGetsNoCORSHeaders(t *testing.T) {
	s := newTestServer(t)
	rec := doRequest(t, s.Handler(), http.MethodGet, "/v1/health", disallowedOrigin, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (non-sensitive data still served)", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed origin received ACAO = %q, want empty", got)
	}
}

func TestPairSuccessIssuesTokenOnlyOnce(t *testing.T) {
	s := newTestServer(t)
	code := s.PairingCode()

	rec := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
		`{"code":"`+code+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if !tokenShape.MatchString(body["token"]) {
		t.Fatalf("token %q does not match 64-hex shape", body["token"])
	}
	if body["token"] != s.token {
		t.Error("issued token differs from server-held token")
	}
	// The code must never be echoed back.
	if strings.Contains(rec.Body.String(), code) {
		t.Fatal("pair response echoes the pairing code")
	}

	// Replaying the same code must fail — the code is consumed.
	rec2 := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
		`{"code":"`+code+`"}`)
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("replay status = %d, want 403", rec2.Code)
	}
	if strings.Contains(rec2.Body.String(), s.token) {
		t.Fatal("replay error leaks the capability token")
	}
}

func TestPairWrongCodeRejected(t *testing.T) {
	s := newTestServer(t)
	rec := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
		`{"code":"000000"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if strings.Contains(rec.Body.String(), s.token) || strings.Contains(rec.Body.String(), s.code) {
		t.Fatal("wrong-code error leaks code or token")
	}
}

func TestPairMissingOriginRejected(t *testing.T) {
	s := newTestServer(t)
	code := s.PairingCode()
	rec := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", "",
		`{"code":"`+code+`"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("missing-origin rejection sent ACAO = %q, want empty", got)
	}
	if strings.Contains(rec.Body.String(), s.token) {
		t.Fatal("missing-origin error leaks token")
	}
}

func TestPairDisallowedOriginRejected(t *testing.T) {
	s := newTestServer(t)
	code := s.PairingCode()
	rec := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", disallowedOrigin,
		`{"code":"`+code+`"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed-origin rejection sent ACAO = %q, want empty", got)
	}
	if strings.Contains(rec.Body.String(), s.token) || strings.Contains(rec.Body.String(), s.code) {
		t.Fatal("disallowed-origin error leaks code or token")
	}
}

func TestPairMalformedBodyRejected(t *testing.T) {
	s := newTestServer(t)
	rec := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
		`not json`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if strings.Contains(rec.Body.String(), s.token) || strings.Contains(rec.Body.String(), s.code) {
		t.Fatal("malformed-body error leaks code or token")
	}
}

func TestPairInvalidCodeFormatRejected(t *testing.T) {
	s := newTestServer(t)
	for _, code := range []string{"", "12345", "1234567", "abcdef", "12345a", " 123456"} {
		rec := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
			`{"code":"`+code+`"}`)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("code %q: status = %d, want 400", code, rec.Code)
		}
		if strings.Contains(rec.Body.String(), s.token) {
			t.Errorf("code %q: error leaks token", code)
		}
	}
}

func TestPreflightAllowedOrigin(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/v1/pair", nil)
	req.Header.Set("Origin", allowedOriginEntei)
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != allowedOriginEntei {
		t.Errorf("ACAO = %q, want %q", got, allowedOriginEntei)
	}
	methods := rec.Header().Get("Access-Control-Allow-Methods")
	if !strings.Contains(methods, http.MethodPost) || !strings.Contains(methods, http.MethodOptions) {
		t.Errorf("ACAM = %q, want POST and OPTIONS", methods)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != "Content-Type" {
		t.Errorf("ACAH = %q, want Content-Type", got)
	}
	if got := rec.Header().Get("Access-Control-Max-Age"); got == "" {
		t.Error("missing Access-Control-Max-Age")
	}
	if !hasVary(rec, "Origin") {
		t.Error("missing Vary: Origin")
	}
}

func TestPreflightDisallowedOrigin(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/v1/pair", nil)
	req.Header.Set("Origin", disallowedOrigin)
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed preflight received ACAO = %q, want empty", got)
	}
}

func TestUnknownRouteNotFound(t *testing.T) {
	s := newTestServer(t)
	for _, path := range []string{"/", "/v1", "/v1/nope", "/v1/pair/extra", "/health", "/v1/media/other"} {
		rec := doRequest(t, s.Handler(), http.MethodGet, path, "", "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s: status = %d, want 404", path, rec.Code)
		}
		if strings.Contains(rec.Body.String(), s.token) || strings.Contains(rec.Body.String(), s.code) {
			t.Errorf("GET %s: 404 body leaks secrets", path)
		}
	}
}

func TestUnknownMethodsRejected(t *testing.T) {
	s := newTestServer(t)

	rec := doRequest(t, s.Handler(), http.MethodPost, "/v1/health", "", "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /v1/health: status = %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Allow"); got != "GET" {
		t.Errorf("POST /v1/health: Allow = %q, want GET", got)
	}

	rec = doRequest(t, s.Handler(), http.MethodGet, "/v1/pair", "", "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /v1/pair: status = %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Allow"); got != "POST, OPTIONS" {
		t.Errorf("GET /v1/pair: Allow = %q, want POST, OPTIONS", got)
	}

	rec = doRequest(t, s.Handler(), http.MethodPut, "/v1/pair", "", "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("PUT /v1/pair: status = %d, want 405", rec.Code)
	}
}

func hasVary(rec *httptest.ResponseRecorder, value string) bool {
	for _, v := range rec.Header().Values("Vary") {
		for _, part := range strings.Split(v, ",") {
			if strings.TrimSpace(part) == value {
				return true
			}
		}
	}
	return false
}

// --- ED-2B: /v1/media/fixture ---

func mediaURL(token string) string {
	return "/v1/media/fixture?token=" + token
}

func assertNoSecrets(t *testing.T, rec *httptest.ResponseRecorder, s *Server, fixturePath string) {
	t.Helper()
	body := rec.Body.String()
	for _, secret := range []string{s.code, s.token, fixturePath, "eizou-range", "fixture.mp4"} {
		if secret != "" && strings.Contains(body, secret) {
			t.Fatalf("response leaks %q: %s", secret, body)
		}
	}
}

func TestMediaUnauthenticatedRefused(t *testing.T) {
	s, _ := newTestServerWithFixture(t)
	h := s.Handler()

	// Missing token (allowed origin).
	rec := doRequest(t, h, http.MethodGet, "/v1/media/fixture", allowedOriginEntei, "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("missing token: status = %d, want 401", rec.Code)
	}
	assertNoSecrets(t, rec, s, "")

	// Invalid token (allowed origin).
	rec = doRequest(t, h, http.MethodGet, mediaURL("deadbeef"), allowedOriginEntei, "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("invalid token: status = %d, want 401", rec.Code)
	}
	assertNoSecrets(t, rec, s, "")

	// Valid token but no Origin.
	rec = doRequest(t, h, http.MethodGet, mediaURL(s.token), "", "")
	if rec.Code != http.StatusForbidden {
		t.Errorf("no origin: status = %d, want 403", rec.Code)
	}
	assertNoSecrets(t, rec, s, "")

	// Valid token but disallowed Origin.
	rec = doRequest(t, h, http.MethodGet, mediaURL(s.token), disallowedOrigin, "")
	if rec.Code != http.StatusForbidden {
		t.Errorf("disallowed origin: status = %d, want 403", rec.Code)
	}
	assertNoSecrets(t, rec, s, "")
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed origin received ACAO = %q, want empty", got)
	}
}

func TestMediaValidGet(t *testing.T) {
	s, fixture := newTestServerWithFixture(t)
	fixtureBytes, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	rec := doRequest(t, s.Handler(), http.MethodGet, mediaURL(s.token), allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "video/mp4" {
		t.Errorf("Content-Type = %q, want video/mp4", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != allowedOriginLocal {
		t.Errorf("ACAO = %q, want %q", got, allowedOriginLocal)
	}
	if !hasVary(rec, "Origin") {
		t.Error("missing Vary: Origin")
	}
	if ar := rec.Header().Get("Accept-Ranges"); ar != "bytes" {
		t.Errorf("Accept-Ranges = %q, want bytes", ar)
	}
	exposed := rec.Header().Get("Access-Control-Expose-Headers")
	if !strings.Contains(exposed, "Content-Range") || !strings.Contains(exposed, "Accept-Ranges") {
		t.Errorf("Expose-Headers = %q, want Content-Range and Accept-Ranges", exposed)
	}
	if rec.Body.Len() != len(fixtureBytes) {
		t.Errorf("body length = %d, want %d (full file)", rec.Body.Len(), len(fixtureBytes))
	}
	if rec.Body.String() != string(fixtureBytes) {
		t.Error("body does not match fixture bytes")
	}
}

func TestMediaHead(t *testing.T) {
	s, fixture := newTestServerWithFixture(t)
	fixtureBytes, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	rec := doRequest(t, s.Handler(), http.MethodHead, mediaURL(s.token), allowedOriginEntei, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if cl := rec.Header().Get("Content-Length"); cl != strconv.Itoa(len(fixtureBytes)) {
		t.Errorf("Content-Length = %q, want %d", cl, len(fixtureBytes))
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD returned %d body bytes, want 0", rec.Body.Len())
	}
}

func TestMediaByteRange(t *testing.T) {
	s, fixture := newTestServerWithFixture(t)
	fixtureBytes, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, mediaURL(s.token), nil)
	req.Header.Set("Origin", allowedOriginEntei)
	req.Header.Set("Range", "bytes=0-99")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", rec.Code)
	}
	want := "bytes 0-99/" + strconv.Itoa(len(fixtureBytes))
	if cr := rec.Header().Get("Content-Range"); cr != want {
		t.Errorf("Content-Range = %q, want %q", cr, want)
	}
	if cl := rec.Header().Get("Content-Length"); cl != "100" {
		t.Errorf("Content-Length = %q, want 100", cl)
	}
	if rec.Body.String() != string(fixtureBytes[0:100]) {
		t.Error("206 body does not match requested byte window")
	}
}

func TestMediaUnsatisfiableRange(t *testing.T) {
	s, fixture := newTestServerWithFixture(t)
	fixtureBytes, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, mediaURL(s.token), nil)
	req.Header.Set("Origin", allowedOriginEntei)
	req.Header.Set("Range", "bytes=999999999-")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("status = %d, want 416", rec.Code)
	}
	want := "bytes */" + strconv.Itoa(len(fixtureBytes))
	if cr := rec.Header().Get("Content-Range"); cr != want {
		t.Errorf("Content-Range = %q, want %q", cr, want)
	}
}

func TestMediaPreflight(t *testing.T) {
	s, _ := newTestServerWithFixture(t)

	// Allowed origin → 204 with media-appropriate methods.
	req := httptest.NewRequest(http.MethodOptions, "/v1/media/fixture", nil)
	req.Header.Set("Origin", allowedOriginEntei)
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
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
	req = httptest.NewRequest(http.MethodOptions, "/v1/media/fixture", nil)
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

func TestMediaWrongMethod(t *testing.T) {
	s, _ := newTestServerWithFixture(t)
	rec := doRequest(t, s.Handler(), http.MethodPost, mediaURL(s.token), allowedOriginEntei, "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST media: status = %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Allow"); got != "GET, HEAD, OPTIONS" {
		t.Errorf("Allow = %q, want GET, HEAD, OPTIONS", got)
	}
}

func TestMediaMissingFixtureDisabled(t *testing.T) {
	// Server without a fixture: media endpoint is honestly disabled.
	s := newTestServer(t)
	rec := doRequest(t, s.Handler(), http.MethodGet, mediaURL(s.token), allowedOriginEntei, "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 (disabled)", rec.Code)
	}
	if body := rec.Body.String(); strings.Contains(body, "media not available") == false {
		t.Errorf("body = %q, want generic disabled error", body)
	}
	assertNoSecrets(t, rec, s, "")
	// No local path or fixture hint may appear.
	if strings.Contains(rec.Body.String(), ".mp4") || strings.Contains(rec.Body.String(), "\\") {
		t.Errorf("disabled body leaks path hints: %q", rec.Body.String())
	}
}

func TestMediaNoCORSWildcard(t *testing.T) {
	s, _ := newTestServerWithFixture(t)
	h := s.Handler()

	requests := []*http.Request{
		httptest.NewRequest(http.MethodGet, "/v1/health", nil),
		httptest.NewRequest(http.MethodGet, mediaURL(s.token), nil),
	}
	for _, req := range requests {
		req.Header.Set("Origin", allowedOriginEntei)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got == "*" {
			t.Errorf("response used wildcard ACAO")
		}
	}
}
