package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"eizoudendenshi/internal/credential"
)

// TestPairPersistsBeforeResponse pins the persistent-pairing contract: a
// successful pair writes the token to the credential store BEFORE the 200
// response is produced.
func TestPairPersistsBeforeResponse(t *testing.T) {
	store := credential.NewMemStore()
	s, err := New(Config{Credential: store})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	code := s.PairingCode()

	rec := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
		`{"code":"`+code+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := store.StoredToken(); got == "" {
		t.Fatal("pair response returned 200 but the credential store is empty")
	}
}

// TestPairSaveFailureFailsPair pins the fail-closed persistence contract:
// when the store cannot persist, the pair request fails WITHOUT a token
// response and the code is NOT consumed (the user can retry).
func TestPairSaveFailureFailsPair(t *testing.T) {
	store := credential.NewMemStore()
	store.SetSaveError(errors.New("disk full"))
	s, err := New(Config{Credential: store})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	code := s.PairingCode()

	rec := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
		`{"code":"`+code+`"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "disk full") {
		t.Fatal("storage error detail leaked into the response")
	}
	if strings.Contains(rec.Body.String(), `"token"`) {
		t.Fatal("pair failure must not return a token")
	}

	// The code must still be valid: clear the failure, retry, succeed.
	store.SetSaveError(nil)
	rec2 := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
		`{"code":"`+code+`"}`)
	if rec2.Code != http.StatusOK {
		t.Fatalf("retry after storage recovery: status = %d, want 200", rec2.Code)
	}
}

// TestStartupLoadsPersistedToken pins the reload contract: a companion
// restarted with a valid persisted token accepts the SAME token without
// any pairing exchange, and a fresh pairing code is still issued.
func TestStartupLoadsPersistedToken(t *testing.T) {
	store := credential.NewMemStore()
	saved := strings.Repeat("ab", 32) // 64 lowercase hex
	store.SeedToken(saved)

	s, err := New(Config{Credential: store})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// The status acknowledgement validates the persisted token without
	// pairing and without creating any state.
	rec := doRequest(t, s.Handler(), http.MethodGet,
		"/v1/pair/status?token="+saved, allowedOriginEntei, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != "{\"status\":\"paired\"}\n" {
		t.Fatalf("body = %q, want the fixed acknowledgement only", rec.Body.String())
	}
	// A fresh pairing code is still available for new browsers.
	if got := s.PairingCode(); got == "" || len(got) != 6 {
		t.Fatalf("PairingCode = %q, want a fresh 6-digit code", got)
	}
}

// TestCorruptStoredCredentialFailsClosed pins the fail-closed load: a
// corrupt / undecryptable stored value is never accepted — fresh
// credentials are generated and the stored value is not echoed anywhere.
func TestCorruptStoredCredentialFailsClosed(t *testing.T) {
	store := credential.NewMemStore()
	store.SeedToken("corrupt-would-be-token")
	store.SetLoadError(errors.New("corrupt"))
	// Simulate a stored value that Load must never surface.
	s, err := New(Config{Credential: store})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	rec := doRequest(t, s.Handler(), http.MethodGet,
		"/v1/pair/status?token=corrupt-would-be-token", allowedOriginEntei, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (corrupt credential not accepted)", rec.Code)
	}
	// The corrupt value must not appear in the error body.
	if strings.Contains(rec.Body.String(), "corrupt") {
		t.Fatal("storage failure detail leaked")
	}
	// Fresh pair still works and overwrites the corrupt value.
	code := s.PairingCode()
	store.SetLoadError(nil)
	rec2 := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
		`{"code":"`+code+`"}`)
	if rec2.Code != http.StatusOK {
		t.Fatalf("pair after corrupt load: status = %d, want 200", rec2.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec2.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if store.StoredToken() != body["token"] {
		t.Fatal("new pair did not overwrite the corrupt stored value")
	}
}

// TestPairStatusGates covers the authenticated status acknowledgement:
// same Origin + token gates as media endpoints, no state created, no
// secret echoed.
func TestPairStatusGates(t *testing.T) {
	s := newTestServer(t)
	token := pairAndGetToken(t, s)

	t.Run("missing origin", func(t *testing.T) {
		rec := doRequest(t, s.Handler(), http.MethodGet,
			"/v1/pair/status?token="+token, "", "")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
		if rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("disallowed request must not receive CORS headers")
		}
	})
	t.Run("disallowed origin", func(t *testing.T) {
		rec := doRequest(t, s.Handler(), http.MethodGet,
			"/v1/pair/status?token="+token, disallowedOrigin, "")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
	})
	t.Run("missing token", func(t *testing.T) {
		rec := doRequest(t, s.Handler(), http.MethodGet, "/v1/pair/status",
			allowedOriginEntei, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})
	t.Run("invalid token", func(t *testing.T) {
		rec := doRequest(t, s.Handler(), http.MethodGet,
			"/v1/pair/status?token=deadbeef", allowedOriginEntei, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})
	t.Run("valid token is a fixed acknowledgement, never the token", func(t *testing.T) {
		rec := doRequest(t, s.Handler(), http.MethodGet,
			"/v1/pair/status?token="+token, allowedOriginEntei, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if strings.Contains(rec.Body.String(), token) {
			t.Fatal("status response echoes the token")
		}
	})
	t.Run("wrong method", func(t *testing.T) {
		rec := doRequest(t, s.Handler(), http.MethodPost,
			"/v1/pair/status?token="+token, allowedOriginEntei, `{}`)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", rec.Code)
		}
		if got := rec.Header().Get("Allow"); got != "GET, OPTIONS" {
			t.Errorf("Allow = %q, want GET, OPTIONS", got)
		}
	})
	t.Run("OPTIONS preflight is origin-gated", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodOptions, "/v1/pair/status", nil)
		req.Header.Set("Origin", allowedOriginLocal)
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", rec.Code)
		}
		reqBad := httptest.NewRequest(http.MethodOptions, "/v1/pair/status", nil)
		reqBad.Header.Set("Origin", disallowedOrigin)
		recBad := httptest.NewRecorder()
		s.Handler().ServeHTTP(recBad, reqBad)
		if recBad.Code != http.StatusForbidden {
			t.Fatalf("disallowed preflight status = %d, want 403", recBad.Code)
		}
	})
}

// TestPairDeleteInvalidates pins the explicit reset contract: after an
// authenticated DELETE the old token is dead, a FRESH pairing code exists,
// pairing works again without restart, and the store is emptied.
func TestPairDeleteInvalidates(t *testing.T) {
	store := credential.NewMemStore()
	s, err := New(Config{Credential: store, OnPairingReset: func(string) {}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	token := pairAndGetToken(t, s)
	oldCode := s.PairingCode() // consumed after pair: expect ""

	// Media gates still accept the token before the reset.
	rec := doRequest(t, s.Handler(), http.MethodGet,
		"/v1/pair/status?token="+token, allowedOriginEntei, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("pre-delete status = %d, want 200", rec.Code)
	}

	// Authenticated DELETE.
	recDel := doRequest(t, s.Handler(), http.MethodDelete,
		"/v1/pair?token="+token, allowedOriginEntei, "")
	if recDel.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200; body=%s", recDel.Code, recDel.Body.String())
	}
	if strings.Contains(recDel.Body.String(), token) {
		t.Fatal("delete response echoes the old token")
	}

	// Old token is invalidated everywhere.
	recAfter := doRequest(t, s.Handler(), http.MethodGet,
		"/v1/pair/status?token="+token, allowedOriginEntei, "")
	if recAfter.Code != http.StatusUnauthorized {
		t.Fatalf("post-delete status = %d, want 401 (token invalidated)", recAfter.Code)
	}

	// Store is emptied.
	if got := store.StoredToken(); got != "" {
		t.Fatalf("store still holds %q after delete", got)
	}

	// A FRESH code exists (the old one was consumed) and pairing with it
	// issues a NEW token without restarting the server.
	newCode := s.PairingCode()
	if newCode == "" || newCode == oldCode {
		t.Fatalf("fresh code = %q, old = %q", newCode, oldCode)
	}
	recPair := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
		`{"code":"`+newCode+`"}`)
	if recPair.Code != http.StatusOK {
		t.Fatalf("re-pair after delete: status = %d, want 200", recPair.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(recPair.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["token"] == token {
		t.Fatal("re-pair returned the SAME token; expected a rotated credential")
	}
	// The new token was persisted again.
	if store.StoredToken() != body["token"] {
		t.Fatal("re-pair did not persist the new token")
	}
}

// TestPairDeleteGates covers the reset endpoint's authentication: without
// a valid Origin or token the credential is NOT deleted.
func TestPairDeleteGates(t *testing.T) {
	store := credential.NewMemStore()
	s, err := New(Config{Credential: store})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	token := pairAndGetToken(t, s)

	t.Run("missing origin", func(t *testing.T) {
		rec := doRequest(t, s.Handler(), http.MethodDelete,
			"/v1/pair?token="+token, "", "")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
		if store.StoredToken() == "" {
			t.Fatal("credential deleted despite missing origin")
		}
	})
	t.Run("missing token", func(t *testing.T) {
		rec := doRequest(t, s.Handler(), http.MethodDelete, "/v1/pair",
			allowedOriginEntei, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
		if store.StoredToken() == "" {
			t.Fatal("credential deleted despite missing token")
		}
	})
	t.Run("wrong method on pair", func(t *testing.T) {
		rec := doRequest(t, s.Handler(), http.MethodPut, "/v1/pair", "", "")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", rec.Code)
		}
		if got := rec.Header().Get("Allow"); got != "POST, DELETE, OPTIONS" {
			t.Errorf("Allow = %q, want POST, DELETE, OPTIONS", got)
		}
	})
	t.Run("preflight allows DELETE", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodOptions, "/v1/pair", nil)
		req.Header.Set("Origin", allowedOriginLocal)
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "POST, DELETE, OPTIONS" {
			t.Errorf("Allow-Methods = %q, want POST, DELETE, OPTIONS", got)
		}
	})
}

// TestPairDeleteBestEffortPins pins the "best effort correct semantics":
// even when the persisted delete fails, the in-memory credential is
// invalidated and a fresh code is issued (the user-visible unpaired state
// is authoritative).
func TestPairDeleteBestEffort(t *testing.T) {
	store := credential.NewMemStore()
	s, err := New(Config{Credential: store, OnPairingReset: func(string) {}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	token := pairAndGetToken(t, s)
	store.SetDeleteError(errors.New("locked"))

	rec := doRequest(t, s.Handler(), http.MethodDelete,
		"/v1/pair?token="+token, allowedOriginEntei, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200 (best effort)", rec.Code)
	}
	recAfter := doRequest(t, s.Handler(), http.MethodGet,
		"/v1/pair/status?token="+token, allowedOriginEntei, "")
	if recAfter.Code != http.StatusUnauthorized {
		t.Fatalf("post-delete status = %d, want 401 (in-memory invalidation is authoritative)", recAfter.Code)
	}
	if code := s.PairingCode(); code == "" {
		t.Fatal("no fresh pairing code after best-effort delete")
	}
}

// TestPairDeleteDoesNotTouchJobsOrMedia pins the reset boundary: DELETE
// /v1/pair only removes the credential — the fixture stays servable with
// the NEW token, and no job state is involved.
func TestPairDeleteDoesNotTouchJobsOrMedia(t *testing.T) {
	store := credential.NewMemStore()
	s, fixture := newTestServerWithFixtureCred(t, store)
	token := pairAndGetToken(t, s)

	// Fixture servable before reset.
	recMedia := doRequest(t, s.Handler(), http.MethodGet,
		"/v1/media/fixture?token="+token, allowedOriginEntei, "")
	if recMedia.Code != http.StatusOK {
		t.Fatalf("pre-delete fixture status = %d, want 200", recMedia.Code)
	}

	recDel := doRequest(t, s.Handler(), http.MethodDelete,
		"/v1/pair?token="+token, allowedOriginEntei, "")
	if recDel.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200", recDel.Code)
	}

	// The media file itself is untouched and servable with the new token.
	newCode := s.PairingCode()
	recPair := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
		`{"code":"`+newCode+`"}`)
	if recPair.Code != http.StatusOK {
		t.Fatalf("re-pair status = %d, want 200", recPair.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(recPair.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	recMedia2 := doRequest(t, s.Handler(), http.MethodGet,
		"/v1/media/fixture?token="+body["token"], allowedOriginEntei, "")
	if recMedia2.Code != http.StatusOK {
		t.Fatalf("post-reset fixture status = %d, want 200 (media untouched)", recMedia2.Code)
	}
	if _, err := os.Stat(fixture); err != nil {
		t.Fatalf("fixture file missing after reset: %v", err)
	}
}

// TestOnPairingResetNotified pins the fresh-code notification: the reset
// callback receives the new code so the command can print it.
func TestOnPairingResetNotified(t *testing.T) {
	var gotCode string
	s, err := New(Config{Credential: credential.NewMemStore(),
		OnPairingReset: func(code string) { gotCode = code }})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	token := pairAndGetToken(t, s)
	rec := doRequest(t, s.Handler(), http.MethodDelete,
		"/v1/pair?token="+token, allowedOriginEntei, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200", rec.Code)
	}
	if gotCode == "" || gotCode != s.PairingCode() {
		t.Fatalf("reset callback code = %q, current = %q", gotCode, s.PairingCode())
	}
}

// TestRestartWithSameFileStoreKeepsToken pins the in-place-update
// pairing boundary: a NEW companion process started against the SAME
// persisted credential file (exactly what happens after the updater
// replaces the verified core — credential.bin is untouched) accepts the
// existing token without any pairing exchange, issues a fresh code, and
// never rewrites or resets the stored credential.
func TestRestartWithSameFileStoreKeepsToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credential.bin")
	store := credential.NewFileStore(path)

	// First process: pair and persist the token.
	s1, err := New(Config{Credential: store})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	token := pairAndGetToken(t, s1)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read credential: %v", err)
	}

	// "After the update": a brand-new server instance over the same
	// credential file reports paired with the SAME token.
	s2, err := New(Config{Credential: store})
	if err != nil {
		t.Fatalf("New after restart: %v", err)
	}
	rec := doRequest(t, s2.Handler(), http.MethodGet,
		"/v1/pair/status?token="+token, allowedOriginEntei, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status after restart = %d, want 200 (persisted token still valid)", rec.Code)
	}
	if rec.Body.String() != "{\"status\":\"paired\"}\n" {
		t.Fatalf("body = %q, want the fixed acknowledgement only", rec.Body.String())
	}

	// The credential file is byte-identical and the store still reports
	// the SAME token: no rotation, no reset, no rewrite.
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read credential after restart: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("companion restart rewrote the persisted credential")
	}
	got, _, ok, err := store.Load()
	if err != nil || !ok || got != token {
		t.Fatalf("stored token after restart = %q ok=%v err=%v, want the same token", got, ok, err)
	}
	// A fresh pairing code is still available for new browsers, but no
	// state was created by the status check.
	if code := s2.PairingCode(); code == "" || len(code) != 6 {
		t.Fatalf("PairingCode = %q, want a fresh 6-digit code", code)
	}
	after2, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read credential after status check: %v", err)
	}
	if !bytes.Equal(before, after2) {
		t.Fatal("a status acknowledgement must never write the credential")
	}
}

// --- helpers -------------------------------------------------------------

func pairAndGetToken(t *testing.T, s *Server) string {
	t.Helper()
	code := s.PairingCode()
	rec := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginEntei,
		`{"code":"`+code+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("pair status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	tok := body["token"]
	if !tokenShape.MatchString(tok) {
		t.Fatalf("token %q does not match the capability shape", tok)
	}
	return tok
}

func newTestServerWithFixtureCred(t *testing.T, store credential.Store) (*Server, string) {
	t.Helper()
	s, fixture := newTestServerWithFixture(t)
	s.cred = store
	return s, fixture
}
