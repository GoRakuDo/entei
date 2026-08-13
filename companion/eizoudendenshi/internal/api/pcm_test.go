package api

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"eizoudendenshi/internal/media"
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
