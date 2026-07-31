package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"eizoudendenshi/internal/media"
)

// growData is a deterministic payload distinct from the static fixture
// pattern, so a cross-wired response would not match byte-for-byte.
func growData(n int) []byte {
	d := make([]byte, n)
	for i := range d {
		d[i] = byte((i*7 + 3) % 251)
	}
	return d
}

// newGrowServer builds a server configured with an in-memory growing
// source (no downloader, no files) for the ED-2C contract tests.
func newGrowServer(t *testing.T, data []byte, avail int64) (*Server, *media.MemSource) {
	t.Helper()
	src := media.NewMemSource(data, avail)
	s, err := New(Config{GrowSource: src})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s, src
}

func growRequest(t *testing.T, h http.Handler, token, method, rng string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, mediaURL(token), nil)
	req.Header.Set("Origin", allowedOriginEntei)
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeBuffering(t *testing.T, rec *httptest.ResponseRecorder) bufferingBody {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("503 Content-Type = %q, want application/json", ct)
	}
	if ra := rec.Header().Get("Retry-After"); ra != bufferingRetryAfter {
		t.Errorf("503 Retry-After = %q, want %q", ra, bufferingRetryAfter)
	}
	if !json.Valid(rec.Body.Bytes()) {
		t.Fatalf("503 body is not valid JSON: %q", rec.Body.String())
	}
	var b bufferingBody
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("invalid buffering body %q: %v", rec.Body.String(), err)
	}
	if b.Error != "buffering" {
		t.Errorf("buffering error = %q, want %q", b.Error, "buffering")
	}
	return b
}

// assert206Window pins the exact window semantics: status 206, exact
// Content-Range/Content-Length, and a body that matches the payload
// byte-for-byte (no fabrication, no truncation).
func assert206Window(t *testing.T, rec *httptest.ResponseRecorder, data []byte, start, end int64) {
	t.Helper()
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206; body=%q", rec.Code, rec.Body.String())
	}
	wantCR := fmt.Sprintf("bytes %d-%d/%d", start, end, int64(len(data)))
	if cr := rec.Header().Get("Content-Range"); cr != wantCR {
		t.Errorf("Content-Range = %q, want %q", cr, wantCR)
	}
	wantCL := strconv.FormatInt(end-start+1, 10)
	if cl := rec.Header().Get("Content-Length"); cl != wantCL {
		t.Errorf("Content-Length = %q, want %q", cl, wantCL)
	}
	if rec.Body.Len() != int(end-start+1) {
		t.Fatalf("body length = %d, want %d (no truncation/fabrication)",
			rec.Body.Len(), end-start+1)
	}
	if got := rec.Body.String(); got != string(data[start:end+1]) {
		t.Error("206 body does not match the requested byte window")
	}
}

// --- GET/HEAD full representation ---

func TestGrowGetCompleteFull200(t *testing.T) {
	data := growData(2048)
	s, _ := newGrowServer(t, data, int64(len(data)))
	h := s.Handler()

	rec := growRequest(t, h, s.token, http.MethodGet, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%q", rec.Code, rec.Body.String())
	}
	if cl := rec.Header().Get("Content-Length"); cl != "2048" {
		t.Errorf("Content-Length = %q, want 2048", cl)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "video/mp4" {
		t.Errorf("Content-Type = %q, want video/mp4", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	if ar := rec.Header().Get("Accept-Ranges"); ar != "bytes" {
		t.Errorf("Accept-Ranges = %q, want bytes", ar)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != allowedOriginEntei {
		t.Errorf("ACAO = %q, want %q", got, allowedOriginEntei)
	}
	if !hasVary(rec, "Origin") {
		t.Error("missing Vary: Origin")
	}
	if exposed := rec.Header().Get("Access-Control-Expose-Headers"); !strings.Contains(exposed, "Retry-After") {
		t.Errorf("Expose-Headers = %q, want Retry-After included", exposed)
	}
	if rec.Body.String() != string(data) {
		t.Error("full GET body does not match the payload")
	}
	assertNoSecrets(t, rec, s, "")
}

// A full GET of an incomplete representation must NOT succeed: a 200 would
// falsely claim the file is complete (truncated success). Explicit 503.
func TestGrowGetIncompleteFullIsBuffering503(t *testing.T) {
	data := growData(2048)
	s, _ := newGrowServer(t, data, 100)
	h := s.Handler()

	rec := growRequest(t, h, s.token, http.MethodGet, "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%q", rec.Code, rec.Body.String())
	}
	b := decodeBuffering(t, rec)
	if b.Available != 100 || b.Total != 2048 {
		t.Errorf("buffering body = %+v, want available 100 / total 2048", b)
	}
	// The body is metadata only: no media bytes, no paths, no secrets.
	if strings.Contains(rec.Body.String(), string(data[0:16])) {
		t.Fatal("503 body contains media bytes")
	}
	assertNoSecrets(t, rec, s, "")

	// Zero available bytes is the same explicit buffering state.
	s0, _ := newGrowServer(t, data, 0)
	rec0 := growRequest(t, s0.Handler(), s0.token, http.MethodGet, "")
	if rec0.Code != http.StatusServiceUnavailable {
		t.Fatalf("avail=0: status = %d, want 503", rec0.Code)
	}
	if b := decodeBuffering(t, rec0); b.Available != 0 || b.Total != 2048 {
		t.Errorf("avail=0 body = %+v, want available 0 / total 2048", b)
	}
}

// --- Range semantics within the available prefix ---

func TestGrowRangeWithinAvailable206(t *testing.T) {
	data := growData(2048)
	s, _ := newGrowServer(t, data, int64(len(data)))
	h := s.Handler()

	// Complete file: identical window shape to the static fixture path.
	rec := growRequest(t, h, s.token, http.MethodGet, "bytes=0-99")
	assert206Window(t, rec, data, 0, 99)

	// Incomplete file, range fully inside the available prefix.
	s2, _ := newGrowServer(t, data, 100)
	rec2 := growRequest(t, s2.Handler(), s2.token, http.MethodGet, "bytes=10-49")
	assert206Window(t, rec2, data, 10, 49)
}

func TestGrowRangeBoundaryExactEnd(t *testing.T) {
	data := growData(2048)
	s, _ := newGrowServer(t, data, 100)
	h := s.Handler()

	// The range ending exactly at avail-1 is servable.
	rec := growRequest(t, h, s.token, http.MethodGet, "bytes=0-99")
	assert206Window(t, rec, data, 0, 99)

	// One byte past the boundary: crossing → 503, never a truncated 206.
	rec = growRequest(t, h, s.token, http.MethodGet, "bytes=0-100")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("bytes=0-100: status = %d, want 503 (crossing)", rec.Code)
	}
	if b := decodeBuffering(t, rec); b.Available != 100 {
		t.Errorf("crossing body = %+v, want available 100", b)
	}

	// Range starting exactly at the boundary: 503, NOT 416 (it may become
	// satisfiable) and not a zero-byte fake success.
	rec = growRequest(t, h, s.token, http.MethodGet, "bytes=100-")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("bytes=100-: status = %d, want 503", rec.Code)
	}
	rec = growRequest(t, h, s.token, http.MethodGet, "bytes=100-100")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("bytes=100-100: status = %d, want 503", rec.Code)
	}
}

func TestGrowRangeCrossingAvailability503(t *testing.T) {
	data := growData(2048)
	s, _ := newGrowServer(t, data, 100)
	h := s.Handler()

	rec := growRequest(t, h, s.token, http.MethodGet, "bytes=50-150")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("crossing range status = %d, want 503 (never a truncated 206/200)", rec.Code)
	}
	b := decodeBuffering(t, rec)
	if b.Available != 100 || b.Total != 2048 {
		t.Errorf("body = %+v, want available 100 / total 2048", b)
	}
	if rec.Header().Get("Content-Range") != "" {
		t.Error("503 must not carry a Content-Range (no partial success)")
	}
	assertNoSecrets(t, rec, s, "")
}

func TestGrowRangeEntirelyUnavailable503(t *testing.T) {
	data := growData(2048)
	s, _ := newGrowServer(t, data, 100)
	h := s.Handler()

	for _, rng := range []string{"bytes=100-199", "bytes=150-", "bytes=150-1499", "bytes=100-100"} {
		rec := growRequest(t, h, s.token, http.MethodGet, rng)
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("%s: status = %d, want 503 (temporarily unavailable, NOT 416)", rng, rec.Code)
			continue
		}
		if b := decodeBuffering(t, rec); b.Available != 100 {
			t.Errorf("%s: body = %+v, want available 100", rng, b)
		}
	}
}

// Only a range starting at or beyond the known TOTAL is permanently
// unsatisfiable → 416 with "bytes */total". This is the one final answer.
func TestGrowRangeStartBeyondTotal416(t *testing.T) {
	data := growData(2048)
	for _, avail := range []int64{100, 2048} {
		s, _ := newGrowServer(t, data, avail)
		h := s.Handler()

		for _, rng := range []string{"bytes=999999999-", "bytes=2048-", "bytes=9999-10000", "bytes=2048-2048"} {
			rec := growRequest(t, h, s.token, http.MethodGet, rng)
			if rec.Code != http.StatusRequestedRangeNotSatisfiable {
				t.Errorf("avail=%d %s: status = %d, want 416", avail, rng, rec.Code)
				continue
			}
			if cr := rec.Header().Get("Content-Range"); cr != "bytes */2048" {
				t.Errorf("avail=%d %s: Content-Range = %q, want bytes */2048", avail, rng, cr)
			}
		}
	}
}

func TestGrowSuffixRange(t *testing.T) {
	data := growData(2048)

	// Complete file: suffix serves the last n bytes; n > total serves the
	// entire representation (RFC 9110).
	s, _ := newGrowServer(t, data, int64(len(data)))
	h := s.Handler()
	assert206Window(t, growRequest(t, h, s.token, http.MethodGet, "bytes=-100"), data, 1948, 2047)
	assert206Window(t, growRequest(t, h, s.token, http.MethodGet, "bytes=-5000"), data, 0, 2047)

	// Incomplete file: a suffix selects the final n bytes of the TOTAL
	// representation (RFC 9110), which do not exist yet — so every suffix
	// request is 503 until the file completes. Never a fabricated window.
	s2, _ := newGrowServer(t, data, 100)
	h2 := s2.Handler()
	for _, rng := range []string{"bytes=-50", "bytes=-100", "bytes=-101", "bytes=-2048"} {
		rec := growRequest(t, h2, s2.token, http.MethodGet, rng)
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("%s (avail 100): status = %d, want 503", rng, rec.Code)
			continue
		}
		if b := decodeBuffering(t, rec); b.Available != 100 {
			t.Errorf("%s: body = %+v, want available 100", rng, b)
		}
	}
}

// RFC 9110 clamping: last-byte-pos beyond the representation end clamps to
// total-1 instead of failing.
func TestGrowRangeClampedToTotal(t *testing.T) {
	data := growData(2048)
	s, _ := newGrowServer(t, data, int64(len(data)))
	rec := growRequest(t, s.Handler(), s.token, http.MethodGet, "bytes=0-99999")
	assert206Window(t, rec, data, 0, 2047)
}

// Malformed / non-bytes / multi-range headers are ignored per RFC 9110
// (treated as no Range): complete → 200 full; incomplete → 503 buffering.
func TestGrowInvalidRangeIgnored(t *testing.T) {
	bad := []string{
		"bytes=abc",
		"bytes=5-2",     // last < first: invalid
		"bytes=-",       // no digits
		"bytes=-0",      // zero-length suffix: ignored
		"bytes=0-1-2",   // extra dash
		"items=0-99",    // non-bytes unit
		"bytes=0-1,3-4", // multi-range (multipart not supported)
		"bytes=0-99,200-299",
		"bytes=  0-99",
	}

	// Complete: ignored Range → full 200.
	data := growData(2048)
	s, _ := newGrowServer(t, data, int64(len(data)))
	h := s.Handler()
	for _, rng := range bad {
		rec := growRequest(t, h, s.token, http.MethodGet, rng)
		if rec.Code != http.StatusOK {
			t.Errorf("complete %q: status = %d, want 200 (Range ignored)", rng, rec.Code)
		}
		if rec.Body.String() != string(data) {
			t.Errorf("complete %q: body is not the full representation", rng)
		}
	}

	// Incomplete: ignored Range → full GET semantics → 503 buffering.
	s2, _ := newGrowServer(t, data, 100)
	h2 := s2.Handler()
	for _, rng := range bad {
		rec := growRequest(t, h2, s2.token, http.MethodGet, rng)
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("incomplete %q: status = %d, want 503 (Range ignored)", rng, rec.Code)
		}
		if b := decodeBuffering(t, rec); b.Available != 100 {
			t.Errorf("incomplete %q: body = %+v, want available 100", rng, b)
		}
	}
}

// --- HEAD semantics ---

// HEAD mirrors GET's status and headers exactly, with an empty body.
func TestGrowHeadMirrorsGet(t *testing.T) {
	data := growData(2048)
	cases := []struct {
		name    string
		avail   int64
		rng     string
		want    int
		headers map[string]string
	}{
		{
			name:  "complete full",
			avail: int64(len(data)), want: http.StatusOK,
			headers: map[string]string{"Content-Length": "2048"},
		},
		{
			name:  "incomplete full buffering",
			avail: 100, want: http.StatusServiceUnavailable,
			headers: map[string]string{"Retry-After": bufferingRetryAfter},
		},
		{
			name:  "range within available",
			avail: 100, rng: "bytes=10-49", want: http.StatusPartialContent,
			headers: map[string]string{"Content-Range": "bytes 10-49/2048", "Content-Length": "40"},
		},
		{
			name:  "range crossing availability",
			avail: 100, rng: "bytes=50-150", want: http.StatusServiceUnavailable,
			headers: map[string]string{"Retry-After": bufferingRetryAfter},
		},
		{
			name:  "range beyond total",
			avail: 100, rng: "bytes=999999-", want: http.StatusRequestedRangeNotSatisfiable,
			headers: map[string]string{"Content-Range": "bytes */2048"},
		},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			s, _ := newGrowServer(t, data, tt.avail)
			h := s.Handler()
			rec := growRequest(t, h, s.token, http.MethodHead, tt.rng)
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d", rec.Code, tt.want)
			}
			for k, v := range tt.headers {
				if got := rec.Header().Get(k); got != v {
					t.Errorf("%s = %q, want %q", k, got, v)
				}
			}
			if rec.Body.Len() != 0 {
				t.Fatalf("HEAD returned %d body bytes, want 0", rec.Body.Len())
			}
			// HEAD and GET must agree on the status for the same request.
			recG := growRequest(t, h, s.token, http.MethodGet, tt.rng)
			if recG.Code != tt.want {
				t.Errorf("GET status = %d, want %d (HEAD/GET consistency)", recG.Code, tt.want)
			}
		})
	}
}

// --- concurrency / TOCTOU ---

// Availability changes concurrently with requests: every response must stay
// well-formed — a 206 window always exactly matches the payload (no
// truncation, no fabricated bytes), a 503 always carries consistent
// availability metadata, and no unavailable byte can ever be served (the
// source additionally enforces the bound; see internal/media tests).
func TestGrowConcurrentAvailabilityChange(t *testing.T) {
	data := growData(65536)
	total := int64(len(data))
	s, src := newGrowServer(t, data, 0)
	h := s.Handler()

	// Writer: simulate download progress (monotonic, append-only shape).
	// The initial delay guarantees readers observe the buffering state
	// before completion; the mid-growth sleeps interleave requests with
	// availability changes.
	var wg sync.WaitGroup
	done := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(10 * time.Millisecond)
		avail := int64(0)
		for avail < total {
			avail += 97*13 + (avail*31)%4097
			if avail > total {
				avail = total
			}
			src.SetAvailable(avail)
			time.Sleep(time.Millisecond)
		}
		close(done)
	}()

	// Readers: mixed request shapes against the same handler.
	var mu sync.Mutex
	var bad []string
	var n503, n206, n200, n416 int
	var rwg sync.WaitGroup
	for g := 0; g < 8; g++ {
		rwg.Add(1)
		go func(seed int) {
			defer rwg.Done()
			ranges := []string{
				"",
				"bytes=0-",
				fmt.Sprintf("bytes=%d-%d", 10000+seed, 30000+seed),
				fmt.Sprintf("bytes=%d-", 5000+seed),
				fmt.Sprintf("bytes=-%d", 1000+seed),
			}
			for i := 0; i < 50; i++ {
				rng := ranges[(seed+i)%len(ranges)]
				rec := growRequest(t, h, s.token, http.MethodGet, rng)
				report := func(format string, args ...any) {
					mu.Lock()
					bad = append(bad, fmt.Sprintf("range %q: "+format, append([]any{rng}, args...)...))
					mu.Unlock()
				}
				switch rec.Code {
				case http.StatusPartialContent:
					mu.Lock()
					n206++
					mu.Unlock()
					// Parse "bytes a-b/total" and verify the exact window.
					cr := rec.Header().Get("Content-Range")
					var a, b, ttl int64
					if _, err := fmt.Sscanf(cr, "bytes %d-%d/%d", &a, &b, &ttl); err != nil || ttl != total {
						report("206: bad Content-Range %q", cr)
						continue
					}
					if rec.Body.Len() != int(b-a+1) {
						report("206: body length %d != window %d (truncated!)", rec.Body.Len(), b-a+1)
						continue
					}
					if cl := rec.Header().Get("Content-Length"); cl != strconv.FormatInt(b-a+1, 10) {
						report("206: Content-Length %q != window %d", cl, b-a+1)
						continue
					}
					if got := rec.Body.String(); got != string(data[a:b+1]) {
						report("206: body does not match payload window [%d,%d]", a, b)
					}
				case http.StatusServiceUnavailable:
					mu.Lock()
					n503++
					mu.Unlock()
					if rec.Header().Get("Retry-After") != bufferingRetryAfter {
						report("503: missing Retry-After")
						continue
					}
					var body bufferingBody
					if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
						report("503: invalid JSON: %v", err)
						continue
					}
					if body.Available < 0 || body.Available > total || body.Total != total {
						report("503: inconsistent metadata %+v", body)
					}
				case http.StatusOK:
					mu.Lock()
					n200++
					mu.Unlock()
					if rec.Body.String() != string(data) {
						report("200: body is not the full payload")
					}
				case http.StatusRequestedRangeNotSatisfiable:
					mu.Lock()
					n416++
					mu.Unlock()
					if cr := rec.Header().Get("Content-Range"); cr != "bytes */"+strconv.FormatInt(total, 10) {
						report("416: Content-Range %q", cr)
					}
				default:
					report("unexpected status %d body=%q", rec.Code, rec.Body.String())
				}
			}
		}(g)
	}
	rwg.Wait()
	<-done
	wg.Wait()

	if len(bad) > 0 {
		t.Fatalf("concurrent requests produced %d violations, first 5: %s", len(bad), strings.Join(bad[:min(5, len(bad))], "\n  "))
	}
	// The buffering state must have been observable before completion.
	if n503 == 0 {
		t.Error("no 503 buffering response observed during growth")
	}

	// After completion, no request may ever be answered with 503 again and
	// the full Range semantics apply deterministically.
	src.SetAvailable(total)
	for _, rng := range []string{"bytes=0-", "bytes=0-99", "bytes=-100"} {
		rec := growRequest(t, h, s.token, http.MethodGet, rng)
		if rec.Code == http.StatusServiceUnavailable {
			t.Fatalf("completed file answered 503 for %q", rng)
		}
		if rec.Code == http.StatusPartialContent {
			mu.Lock()
			n206++
			mu.Unlock()
		}
	}
	if n206 == 0 {
		t.Error("no 206 response observed after completion")
	}
}

// --- gates and config ---

func TestGrowGatesRunBeforeServing(t *testing.T) {
	data := growData(2048)
	s, _ := newGrowServer(t, data, 100)
	h := s.Handler()

	// No token → 401 (same gate as the static path).
	req := httptest.NewRequest(http.MethodGet, "/v1/media/fixture", nil)
	req.Header.Set("Origin", allowedOriginEntei)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("missing token: status = %d, want 401", rec.Code)
	}

	// Valid token, disallowed origin → 403 without CORS headers.
	rec = growRequest(t, h, "deadbeef", http.MethodGet, "bytes=0-99")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("invalid token: status = %d, want 401", rec.Code)
	}
	req = httptest.NewRequest(http.MethodGet, mediaURL(s.token), nil)
	req.Header.Set("Origin", disallowedOrigin)
	req.Header.Set("Range", "bytes=0-99")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("disallowed origin: status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed origin received ACAO = %q, want empty", got)
	}
}

func TestGrowPreflightUnchanged(t *testing.T) {
	data := growData(2048)
	s, _ := newGrowServer(t, data, 100)
	req := httptest.NewRequest(http.MethodOptions, "/v1/media/fixture", nil)
	req.Header.Set("Origin", allowedOriginEntei)
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", rec.Code)
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
}

func TestGrowMutuallyExclusiveWithFixture(t *testing.T) {
	src := media.NewMemSource(growData(100), 100)
	if _, err := New(Config{FixturePath: "x.mp4", GrowSource: src}); err == nil {
		t.Fatal("New with both FixturePath and GrowSource: want error")
	}
}
