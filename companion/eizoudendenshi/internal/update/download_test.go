package update

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// TestTransientErrClassifier pins the retry predicate: transport timeouts
// (including url.Error-wrapped ones), context deadline, and connection
// resets are retryable; everything else — especially HTTP-level and
// package-produced errors — fails closed without a retry.
func TestTransientErrClassifier(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"dns timeout", &net.DNSError{IsTimeout: true}, true},
		{"url-wrapped timeout", &url.Error{Op: "Get", URL: "https://example.invalid/x", Err: &net.DNSError{IsTimeout: true}}, true},
		{"deadline exceeded", context.DeadlineExceeded, true},
		{"connection reset (string)", errors.New("Get \"https://example.invalid/x\": read tcp: connection reset by peer"), true},
		// The real stdlib chain produced on a reset connection (url.Error
		// → net.OpError → os.SyscallError → syscall.ECONNRESET); verified
		// to format as "... read tcp: read: connection reset by peer".
		{"connection reset (stdlib chain)", &url.Error{
			Op:  "Get",
			URL: "https://example.invalid/x",
			Err: &net.OpError{
				Op:  "read",
				Net: "tcp",
				Err: &os.SyscallError{Syscall: "read", Err: syscall.ECONNRESET},
			},
		}, true},
		{"plain error", errors.New("boom"), false},
		{"eof", io.EOF, false},
		{"http level", errors.New("update: download failed (HTTP 404)"), false},
		{"size limit", errors.New("update: download failed (size limit)"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := transientErr(tc.err); got != tc.want {
				t.Errorf("transientErr(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestFetchRetriesTransientTimeout verifies the bounded retry: a server
// that fails the first two attempts with a response-header timeout
// (transient) and then answers 200 results in a successful fetch with
// exactly three attempts.
func TestFetchRetriesTransientTimeout(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if attempts.Add(1) <= 2 {
			// Sleep well past the client's 100ms header timeout so the
			// first two attempts fail with a transport timeout.
			time.Sleep(400 * time.Millisecond)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("artifact body"))
	}))
	defer srv.Close()
	client := &http.Client{
		Transport: &http.Transport{ResponseHeaderTimeout: 100 * time.Millisecond},
	}
	dir := t.TempDir()
	dest, err := fetch(client, dir, "media.bin", srv.URL, 1024)
	if err != nil {
		t.Fatalf("fetch after transient timeouts: %v", err)
	}
	if attempts.Load() != 3 {
		t.Fatalf("attempts = %d, want 3 (2 transient failures + 1 success)", attempts.Load())
	}
	b, err := os.ReadFile(dest)
	if err != nil || string(b) != "artifact body" {
		t.Fatalf("dest = %q (%v), want 'artifact body'", b, err)
	}
}

// TestFetchNoRetryOnHTTPError verifies the fail-closed path: an HTTP-level
// failure (404) is permanent and must NOT be retried — the error carries
// the status code and the partial file is removed.
func TestFetchNoRetryOnHTTPError(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()
	dir := t.TempDir()
	_, err := fetch(clientForTest(), dir, "media.bin", srv.URL, 1024)
	if err == nil {
		t.Fatal("fetch = nil error, want the HTTP-level failure")
	}
	if !strings.Contains(err.Error(), "HTTP 404") {
		t.Errorf("error = %q, want 'update: download failed (HTTP 404)'", err)
	}
	if attempts.Load() != 1 {
		t.Errorf("attempts = %d, want 1 (404 must not be retried)", attempts.Load())
	}
	if _, statErr := os.Stat(filepath.Join(dir, "media.bin")); !os.IsNotExist(statErr) {
		t.Errorf("partial file must be removed after a failed fetch (stat err = %v)", statErr)
	}
}

// clientForTest returns a plain client for fetch-path tests (the retry
// predicate is exercised independently of the hardened client's tuning).
func clientForTest() *http.Client {
	return &http.Client{Transport: &http.Transport{}}
}
