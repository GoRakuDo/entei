package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"eizoudendenshi/internal/diag"
	"eizoudendenshi/internal/torrent"
)

// TestDiagnosticLogRedaction runs a REAL job lifecycle (fake engine) with
// real API requests against a server wired to a file logger, then verifies
// the redaction contract end to end:
//
//	POSITIVE: lifecycle lines exist (job id, short infohash, metadata,
//	select, pairing ok/fail, request lines with status).
//	NEGATIVE: the log never contains the magnet URI, tracker data, the
//	full 40-hex infohash, the capability token, the pairing code, the
//	`?token=` query form, local paths, or the loopback API address.
//
// The fake engine keeps the test deterministic and network-free; the
// manager, API server and logger are the real production types.
func TestDiagnosticLogRedaction(t *testing.T) {
	base := t.TempDir()
	logDir := filepath.Join(base, "logs")
	logger, err := diag.NewLogger(logDir)
	if err != nil {
		t.Fatalf("diag.NewLogger: %v", err)
	}
	defer logger.Close()

	storageRoot := filepath.Join(base, "storage")
	tracked := &trackedEngines{}
	m, err := torrent.New(torrent.Config{
		EngineFactory: tracked.factory("Episode 01.mkv:200|Episode 01.ass:40|readme.txt:10"),
		Timeout:       20 * time.Second,
		StorageRoot:   storageRoot,
		Logger:        logger,
	})
	if err != nil {
		t.Fatalf("torrent.New: %v", err)
	}
	defer m.Close()

	s, err := New(Config{Torrents: m, Logger: logger})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	const fullInfohash = "0123456789abcdef0123456789abcdef01234567"
	// A magnet carrying a tracker: the tracker must never reach the log.
	magnet := "magnet:?xt=urn:btih:" + fullInfohash +
		"&tr=udp%3A%2F%2Ftracker.example%3A1337&tr=http%3A%2F%2Fa.example%2Fannounce"
	token := s.token
	pairCode := s.PairingCode()

	// --- pairing attempts (wrong then right code) ---
	rec := doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginLocal,
		`{"code":"000000"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("wrong-code pair = %d, want 403", rec.Code)
	}
	rec = doRequest(t, s.Handler(), http.MethodPost, "/v1/pair", allowedOriginLocal,
		`{"code":"`+pairCode+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("pair = %d, want 200", rec.Code)
	}

	// --- torrent job lifecycle ---
	created := doTorrent(t, s, http.MethodPost, "/v1/source/torrents",
		allowedOriginLocal, `{"magnet":"`+magnet+`"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d (%s), want 201", created.Code, created.Body.String())
	}
	var createdBody struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(created.Body.Bytes(), &createdBody)
	id := createdBody.ID
	if id == "" {
		t.Fatal("create returned no job id")
	}

	// Wait for a job state via the API (polling).
	waitState := func(jobID, want string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			r := doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+jobID, allowedOriginLocal, "")
			if r.Code != http.StatusOK {
				t.Fatalf("read = %d (%s)", r.Code, r.Body.String())
			}
			var snap struct {
				State string `json:"state"`
			}
			_ = json.Unmarshal(r.Body.Bytes(), &snap)
			if snap.State == want {
				return
			}
			if snap.State == "error" {
				t.Fatalf("job errored while waiting for %s", want)
			}
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for state %s", want)
			}
			time.Sleep(30 * time.Millisecond)
		}
	}
	waitState(id, "buffering")

	files := doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+id+"/files", allowedOriginLocal, "")
	if files.Code != http.StatusOK {
		t.Fatalf("files = %d (%s), want 200", files.Code, files.Body.String())
	}

	sel := doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+id+"/select",
		allowedOriginLocal, `{"videoFileId":"f0","subtitleFileId":"f1"}`)
	if sel.Code != http.StatusOK {
		t.Fatalf("select = %d (%s), want 200", sel.Code, sel.Body.String())
	}
	waitState(id, "streaming")

	// Complete the fake download, then cancel (cancel after complete is a
	// no-op for the run loop — no "cancelled" line is expected for this
	// job; the second job below exercises that path).
	tracked.last().h.avail.Store(tracked.last().files[tracked.last().h.selected].Length)
	waitState(id, "complete")
	cancel := doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+id+"/cancel", allowedOriginLocal, "")
	if cancel.Code != http.StatusOK {
		t.Fatalf("cancel = %d (%s), want 200", cancel.Code, cancel.Body.String())
	}

	// Second job: cancel while STREAMING so the run loop logs "cancelled".
	created2 := doTorrent(t, s, http.MethodPost, "/v1/source/torrents",
		allowedOriginLocal, `{"magnet":"`+magnet+`"}`)
	if created2.Code != http.StatusCreated {
		t.Fatalf("create 2 = %d (%s), want 201", created2.Code, created2.Body.String())
	}
	var createdBody2 struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(created2.Body.Bytes(), &createdBody2)
	id2 := createdBody2.ID
	waitState(id2, "buffering")
	sel2 := doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+id2+"/select",
		allowedOriginLocal, `{"videoFileId":"f0","subtitleFileId":"f1"}`)
	if sel2.Code != http.StatusOK {
		t.Fatalf("select 2 = %d (%s), want 200", sel2.Code, sel2.Body.String())
	}
	waitState(id2, "streaming")
	cancel2 := doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+id2+"/cancel", allowedOriginLocal, "")
	if cancel2.Code != http.StatusOK {
		t.Fatalf("cancel 2 = %d (%s), want 200", cancel2.Code, cancel2.Body.String())
	}

	// --- read the log and verify the redaction contract ---
	logger.Close()
	raw, err := os.ReadFile(filepath.Join(logDir, "eizouden.log"))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	logContent := string(raw)
	t.Logf("--- diagnostic log ---\n%s", logContent)

	// POSITIVE: the lifecycle events are present and sanitized.
	positives := []string{
		"[INFO] api: POST /v1/pair ",
		"[INFO] api: POST /v1/source/torrents 201",
		"[INFO] api: GET /v1/source/torrents/",
		"[INFO] api: POST /v1/source/torrents/" + id + "/select 200",
		"[INFO] pairing: pair ok",
		"[WARN] pairing: pair fail invalid code",
		"[INFO] torrent: job=" + id + " infohash=0123456789ab… created",
		"[INFO] torrent: job=" + id + " metadata wait",
		"[INFO] torrent: job=" + id + " metadata ok files=3 video=true",
		"[INFO] torrent: job=" + id + " select video=f0 subtitle=true",
		"[INFO] torrent: job=" + id + " streaming started",
		"[INFO] torrent: job=" + id + " complete",
		"[WARN] torrent: job=" + id2 + " cancelled",
	}
	for _, want := range positives {
		if !strings.Contains(logContent, want) {
			t.Errorf("log missing %q", want)
		}
	}

	// NEGATIVE: nothing sensitive ever reaches the log.
	negatives := map[string]string{
		"full magnet URI":      "magnet:?xt=urn:btih:" + fullInfohash,
		"full infohash":        fullInfohash,
		"tracker host":         "tracker.example",
		"tracker param":        "tr=",
		"token value":          token,
		"token query form":     "token=",
		"pairing code":         pairCode,
		"loopback API address": "127.0.0.1:4322",
		"storage root path":    storageRoot,
		"log dir path":         logDir,
	}
	if runtime.GOOS == "windows" {
		negatives["windows drive path"] = "C:\\"
	}
	for name, forbidden := range negatives {
		if strings.Contains(logContent, forbidden) {
			t.Errorf("log leaked %s: %q", name, forbidden)
		}
	}
}

// TestDiagnosticLogDisabledWithoutLogger: without a configured logger the
// server behaves exactly as before — no middleware wraps the handler.
func TestDiagnosticLogDisabledWithoutLogger(t *testing.T) {
	s := newTestServer(t)
	h := s.Handler()
	rec := doRequest(t, h, http.MethodGet, "/v1/health", allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("health = %d, want 200", rec.Code)
	}
	// The bare mux is returned when no logger is configured (zero overhead,
	// no behavioral change for existing callers).
	if _, ok := h.(*http.ServeMux); !ok {
		t.Errorf("Handler() = %T without logger, want *http.ServeMux", h)
	}
}
