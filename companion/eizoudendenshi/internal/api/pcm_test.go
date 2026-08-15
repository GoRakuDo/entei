package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"eizoudendenshi/internal/media"
	"eizoudendenshi/internal/torrent"
)

// fakeFfmpeg writes a platform-appropriate fake "ffmpeg" that prints a
// fixed PCM buffer (16 kHz mono f32) to stdout — enough to verify the
// endpoint plumbing without a real ffmpeg install. Windows gets a .bat,
// everything else a POSIX shell script (Termux etc.).
func fakeFfmpeg(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	exe := filepath.Join(dir, "fake-ffmpeg")
	var content string
	if runtime.GOOS == "windows" {
		exe += ".bat"
		content = "@echo off\r\n" +
			"setlocal EnableDelayedExpansion\r\n" +
			"for /l %%i in (1,1,32) do (\r\n" +
			"  set /p dummy=<nul\r\n" +
			"  <nul set /p =^0^0^0^0^0^0^0^0^0^0^0^0^0^0^0^0\r\n" +
			")\r\n" +
			"exit /b 0\r\n"
	} else {
		content = "#!/bin/sh\n" +
			"head -c 512 /dev/zero\n"
	}
	if err := os.WriteFile(exe, []byte(content), 0o700); err != nil {
		t.Fatalf("write fake ffmpeg: %v", err)
	}
	return exe
}

func pcmServer(t *testing.T, src media.GrowingSource) *Server {
	t.Helper()
	s, err := New(Config{GrowSource: src, Ffmpeg: fakeFfmpeg(t)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

// pcmTorrentServer builds a PCM-enabled server backed by a Magnet torrent
// manager (no fixture grow source) — the /v1/media/pcm Magnet path.
func pcmTorrentServer(t *testing.T, spec string) (*Server, *torrent.Manager, *trackedEngines) {
	t.Helper()
	tracked := &trackedEngines{}
	m, err := torrent.New(torrent.Config{
		EngineFactory: tracked.factory(spec),
		Timeout:       20 * time.Second,
	})
	if err != nil {
		t.Fatalf("torrent.New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	s, err := New(Config{Torrents: m, Ffmpeg: fakeFfmpeg(t)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s, m, tracked
}

func waitForTorrentBuffering(t *testing.T, s *Server, id string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		rec := doTorrent(t, s, http.MethodGet, "/v1/source/torrents/"+id, allowedOriginLocal, "")
		var js struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &js)
		if js.State == "buffering" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("never reached buffering; last=%s", js.State)
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func TestMediaPcmAuthRequired(t *testing.T) {
	src := media.NewMemSource(growData(100), 100)
	s := pcmServer(t, src)
	// Allowed origin but no token → 401 (same gate as fixture).
	rec := doRequest(t, s.Handler(), http.MethodGet, "/v1/media/pcm", allowedOriginLocal, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestMediaPcmDisabledWithoutFfmpeg(t *testing.T) {
	src := media.NewMemSource(growData(100), 100)
	s, err := New(Config{GrowSource: src})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	req := doRequest(t, s.Handler(), http.MethodGet,
		"/v1/media/pcm?token="+s.token, allowedOriginLocal, "")
	if req.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (ffmpeg unset)", req.Code)
	}
}

func TestMediaPcmBuffering503(t *testing.T) {
	// Available (2048) < total (4096) → 503 buffering, Retry-After present.
	src := media.NewMemSource(growData(4096), 2048)
	s := pcmServer(t, src)
	rec := doRequest(t, s.Handler(), http.MethodGet,
		"/v1/media/pcm?token="+s.token, allowedOriginLocal, "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("missing Retry-After on 503")
	}
}

func TestMediaPcmOkComplete(t *testing.T) {
	// Available == total → PCM body with sample-rate header.
	src := media.NewMemSource(growData(2048), 2048)
	s := pcmServer(t, src)
	rec := doRequest(t, s.Handler(), http.MethodGet,
		"/v1/media/pcm?token="+s.token, allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if sr := rec.Header().Get("X-Sample-Rate"); sr != "16000" {
		t.Fatalf("X-Sample-Rate = %q, want 16000", sr)
	}
	if rec.Body.Len() == 0 {
		t.Fatal("empty PCM body")
	}
}

func TestMediaPcmUnknownRoute404(t *testing.T) {
	src := media.NewMemSource(growData(100), 100)
	s := pcmServer(t, src)
	rec := doRequest(t, s.Handler(), http.MethodGet,
		"/v1/media/pcmx?token="+s.token, allowedOriginLocal, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// TestMediaPcmMagnetBuffering503: a Magnet job whose selected media is
// still downloading (avail < total) answers 503 buffering, same contract as
// the fixture grow source.
func TestMediaPcmMagnetBuffering503(t *testing.T) {
	s, _, tracked := pcmTorrentServer(t, "Episode 01.mkv:200")

	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	waitForTorrentBuffering(t, s, created.ID)

	if rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select",
		allowedOriginLocal, `{"videoFileId":"f0"}`); rec.Code != http.StatusOK {
		t.Fatalf("select = %d, want 200", rec.Code)
	}
	// Partial download → 503 + Retry-After (web's fetchMagnetPcm shows %).
	tracked.last().h.avail.Store(100)
	rec = doRequest(t, s.Handler(), http.MethodGet, "/v1/media/pcm?token="+s.token, allowedOriginLocal, "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("missing Retry-After on 503")
	}
}

// TestMediaPcmMagnetOkComplete: a complete Magnet job converts via ffmpeg.
func TestMediaPcmMagnetOkComplete(t *testing.T) {
	s, _, tracked := pcmTorrentServer(t, "Episode 01.mkv:200")

	rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents", allowedOriginLocal,
		`{"magnet":"`+testMagnet+`"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	waitForTorrentBuffering(t, s, created.ID)

	if rec := doTorrent(t, s, http.MethodPost, "/v1/source/torrents/"+created.ID+"/select",
		allowedOriginLocal, `{"videoFileId":"f0"}`); rec.Code != http.StatusOK {
		t.Fatalf("select = %d, want 200", rec.Code)
	}
	// Download complete → PCM body with the sample-rate header.
	tracked.last().h.avail.Store(200)
	rec = doRequest(t, s.Handler(), http.MethodGet, "/v1/media/pcm?token="+s.token, allowedOriginLocal, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if sr := rec.Header().Get("X-Sample-Rate"); sr != "16000" {
		t.Fatalf("X-Sample-Rate = %q, want 16000", sr)
	}
	if rec.Body.Len() == 0 {
		t.Fatal("empty PCM body")
	}
}

// TestMediaPcmMagnetNoSession404: no Magnet session at all → 404 (the
// endpoint has no media source without a fixture or an active job).
func TestMediaPcmMagnetNoSession404(t *testing.T) {
	s, _, _ := pcmTorrentServer(t, "Episode 01.mkv:200")
	rec := doRequest(t, s.Handler(), http.MethodGet, "/v1/media/pcm?token="+s.token, allowedOriginLocal, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (no magnet session)", rec.Code)
	}
}
