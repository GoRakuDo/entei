package api

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"eizoudendenshi/internal/diag"
)

// TestRequestLogSilencesStatusPolls verifies the steady-state polling
// suppression contract of requestLog:
//
//   - 2xx of the status polls (/v1/pair/status, /v1/media/status,
//     job/torrent bare status GETs) produce NO log line — the browser
//     repeats them every 1–30 s and would drown the log otherwise
//   - errors on the same endpoints DO log (failures matter)
//   - payload endpoints (media/fixture) keep logging on success —
//     the fixture 200/206 lines are the useful playback evidence
func TestRequestLogSilencesStatusPolls(t *testing.T) {
	base := t.TempDir()
	logDir := filepath.Join(base, "logs")
	logger, err := diag.NewLogger(logDir)
	if err != nil {
		t.Fatalf("diag.NewLogger: %v", err)
	}
	defer logger.Close()

	fixture := filepath.Join(base, "fixture.mp4")
	if err := os.WriteFile(fixture, bytes.Repeat([]byte{0x41}, 4096), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	s, err := New(Config{FixturePath: fixture, Logger: logger})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	token := s.token
	h := s.Handler()

	// --- status polls: 2xx must be silent ---
	pairStatus := doRequest(t, h, http.MethodGet, "/v1/pair/status?token="+token, allowedOriginLocal, "")
	if pairStatus.Code != http.StatusOK {
		t.Fatalf("pair/status = %d, want 200", pairStatus.Code)
	}
	mediaStatus := doRequest(t, h, http.MethodGet, "/v1/media/status?token="+token, allowedOriginLocal, "")
	if mediaStatus.Code != http.StatusOK {
		t.Fatalf("media/status = %d, want 200", mediaStatus.Code)
	}
	// Bare job-status GET shapes (jobs not configured → 404, which must
	// still be logged; the shape is what matters for the silent path).
	jobStatus404 := doRequest(t, h, http.MethodGet, "/v1/source/jobs/abc?token="+token, allowedOriginLocal, "")
	if jobStatus404.Code != http.StatusNotFound {
		t.Fatalf("jobs/abc = %d, want 404", jobStatus404.Code)
	}

	// --- error on a poll path: must be logged ---
	badToken := doRequest(t, h, http.MethodGet, "/v1/media/status?token=deadbeef", allowedOriginLocal, "")
	if badToken.Code != http.StatusUnauthorized {
		t.Fatalf("media/status bad token = %d, want 401", badToken.Code)
	}

	// --- payload GET: must be logged on success ---
	fix := doRequest(t, h, http.MethodGet, "/v1/media/fixture?token="+token, allowedOriginLocal, "")
	if fix.Code != http.StatusOK {
		t.Fatalf("media/fixture = %d, want 200", fix.Code)
	}

	logger.Close()
	raw, err := os.ReadFile(filepath.Join(logDir, "eizouden.log"))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	logContent := string(raw)
	t.Logf("--- diagnostic log ---\n%s", logContent)

	// 2xx polls absent.
	for _, suppressed := range []string{
		"GET /v1/pair/status 200",
		"GET /v1/media/status 200",
	} {
		if strings.Contains(logContent, suppressed) {
			t.Errorf("status poll 2xx must not be logged, found %q", suppressed)
		}
	}
	// Errors on poll paths still present.
	for _, kept := range []string{
		"GET /v1/media/status 401",
		"GET /v1/source/jobs/abc 404",
	} {
		if !strings.Contains(logContent, kept) {
			t.Errorf("log missing poll-path error %q", kept)
		}
	}
	// Payload GET still logged.
	if !strings.Contains(logContent, "GET /v1/media/fixture 200") {
		t.Error("log missing fixture GET line (payload must stay logged)")
	}
}

// TestStatusPollingShape is a pure table test for the path classification,
// covering every registered route shape so the silent set cannot drift.
func TestStatusPollingShape(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
		want   bool
	}{
		{"pair status", http.MethodGet, "/v1/pair/status", true},
		{"media status", http.MethodGet, "/v1/media/status", true},
		{"media status head", http.MethodHead, "/v1/media/status", true},
		{"job bare", http.MethodGet, "/v1/source/jobs/abc", true},
		{"torrent bare", http.MethodGet, "/v1/source/torrents/abc", true},
		{"health", http.MethodGet, "/v1/health", false},
		{"fixture", http.MethodGet, "/v1/media/fixture", false},
		{"job subtitle payload", http.MethodGet, "/v1/source/jobs/abc/subtitle", false},
		{"job create", http.MethodPost, "/v1/source/jobs", false},
		{"job cancel", http.MethodPost, "/v1/source/jobs/abc/cancel", false},
		{"torrent files payload", http.MethodGet, "/v1/source/torrents/abc/files", false},
		{"torrent subtitle payload", http.MethodGet, "/v1/source/torrents/abc/subtitle", false},
		{"torrent select", http.MethodPost, "/v1/source/torrents/abc/select", false},
		{"torrent cancel", http.MethodPost, "/v1/source/torrents/abc/cancel", false},
		{"unknown", http.MethodGet, "/v1/not/a/route", false},
		{"pair status post", http.MethodPost, "/v1/pair/status", false},
	}
	for _, tc := range cases {
		if got := isStatusPolling(tc.method, tc.path); got != tc.want {
			t.Errorf("%s: isStatusPolling(%s %s) = %v, want %v", tc.name, tc.method, tc.path, got, tc.want)
		}
	}
}
