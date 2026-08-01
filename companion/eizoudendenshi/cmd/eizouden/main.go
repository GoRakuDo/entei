// Command eizouden is the EizouDendenshi loopback companion.
//
// It binds a loopback-only HTTP API, prints its resolved bound address and a
// freshly generated 6-digit pairing code to the terminal, then serves the
// /v1 API. Pairing code and capability token live only in process memory;
// nothing is written to disk, storage, or logs. With --fixture, a single
// media file is served at /v1/media/fixture with byte Range semantics. With
// --grow-fixture/--grow-total, a file still being appended is served at the
// same URL with the ED-2C growing-media contract (availability-aware 206 /
// 503+Retry-After buffering; see internal/api). With --allow-origin, one or
// more exact HTTP(S) origins are additionally permitted by CORS for this
// process only (ED-2C development/QA override; never used in production).
package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"eizoudendenshi/internal/api"
	"eizoudendenshi/internal/job"
	"eizoudendenshi/internal/media"
)

// originList collects repeatable --allow-origin values. The values are never
// printed: String is only used for the flag default display and always
// reports an empty default.
type originList []string

func (o *originList) String() string { return "" }

func (o *originList) Set(v string) error {
	*o = append(*o, v)
	return nil
}

// parseAllowOrigins validates each value with api.ParseOrigin and returns
// the normalized allowlist entries. Empty values are ignored (the contract
// is that every *nonempty* value must parse). main calls this before
// net.Listen, so malformed values are rejected before the server starts.
func parseAllowOrigins(values []string) ([]string, error) {
	var out []string
	for _, v := range values {
		if v == "" {
			continue
		}
		norm, err := api.ParseOrigin(v)
		if err != nil {
			return nil, err
		}
		out = append(out, norm)
	}
	return out, nil
}

// resolveGrowSource validates the --grow-fixture/--grow-total pair and
// builds the file-backed growing source. main calls it before net.Listen,
// so a malformed configuration fails before the server starts. Returns nil
// when neither flag was given.
func resolveGrowSource(path string, total int64) (media.GrowingSource, error) {
	if path == "" && total == 0 {
		return nil, nil // neither flag given: media stays disabled or static
	}
	if path == "" {
		return nil, errors.New("--grow-total requires --grow-fixture")
	}
	if total <= 0 {
		return nil, errors.New("--grow-total must be a positive byte count")
	}
	return media.NewFileSource(path, total)
}

func main() {
	addr := flag.String("addr", "127.0.0.1:0",
		"loopback bind address host:port (default port 0 = ephemeral)")
	fixture := flag.String("fixture", "",
		"path to a media file served at /v1/media/fixture (ED-2B PoC; "+
			"empty = media endpoint disabled)")
	growFixture := flag.String("grow-fixture", "",
		"path to a media file still being appended (growing), served at "+
			"/v1/media/fixture with the ED-2C growing-media contract; "+
			"requires --grow-total; writers must be append-only")
	growTotal := flag.Int64("grow-total", 0,
		"known final size in bytes of --grow-fixture (ED-2C PoC; the file "+
			"itself is the source of truth for available bytes)")
	var extraOrigins originList
	flag.Var(&extraOrigins, "allow-origin",
		"additional exact HTTP(S) origin permitted by CORS for this process "+
			"(development/QA override, repeatable; fixed origins always remain)")
	ytdlp := flag.String("ytdlp", "",
		"path to a pinned yt-dlp-compatible helper executable for YouTube "+
			"source jobs (ED-2F; empty = source-job endpoints disabled)")
	jobTimeout := flag.Duration("job-timeout", 30*time.Minute,
		"per-job download timeout for YouTube source jobs (ED-2F)")
	flag.Parse()

	bind, err := resolveBindAddress(*addr)
	if err != nil {
		log.Fatalf("invalid --addr: %v", err)
	}

	if *fixture != "" {
		// Fail fast at startup if the configured fixture is unusable.
		// The HTTP endpoint itself never discloses paths.
		st, err := os.Stat(*fixture)
		if err != nil {
			log.Fatalf("--fixture: %v", err)
		}
		if st.IsDir() {
			log.Fatalf("--fixture: %q is a directory; a single file is required", *fixture)
		}
	}

	// Reject malformed --allow-origin values before the listener starts.
	allowOrigins, err := parseAllowOrigins(extraOrigins)
	if err != nil {
		log.Fatalf("invalid --allow-origin: %v", err)
	}

	// ED-2C: growing-media source. Fail fast on a malformed pair or an
	// unusable file; --fixture and --grow-fixture are mutually exclusive.
	growSource, err := resolveGrowSource(*growFixture, *growTotal)
	if err != nil {
		log.Fatalf("--grow-fixture/--grow-total: %v", err)
	}
	if growSource != nil && *fixture != "" {
		log.Fatal("--fixture and --grow-fixture are mutually exclusive")
	}

	// ED-2F: YouTube source jobs. Enabled only when a helper is pinned via
	// --ytdlp; the path is validated at startup (never derived from a
	// request). Without it the /v1/source/jobs endpoints stay unregistered.
	var jobs *job.Manager
	if *ytdlp != "" {
		st, err := os.Stat(*ytdlp)
		if err != nil {
			log.Fatalf("--ytdlp: %v", err)
		}
		if st.IsDir() {
			log.Fatalf("--ytdlp: %q is a directory; a single executable is required", *ytdlp)
		}
		jobs, err = job.New(job.Config{HelperPath: *ytdlp, Timeout: *jobTimeout})
		if err != nil {
			log.Fatalf("init jobs: %v", err)
		}
	}

	srv, err := api.New(api.Config{
		FixturePath:  *fixture,
		GrowSource:   growSource,
		AllowOrigins: allowOrigins,
		Jobs:         jobs,
	})
	if err != nil {
		log.Fatalf("init api: %v", err)
	}

	ln, err := net.Listen("tcp", bind)
	if err != nil {
		log.Fatalf("listen on %s: %v", bind, err)
	}

	// Terminal-only handoff. The pairing code is printed on purpose; the
	// capability token is never printed or logged.
	fmt.Fprintln(os.Stdout, banner(ln.Addr().String()))
	fmt.Fprintf(os.Stdout, "Pairing code: %s\n", srv.PairingCode())
	fmt.Fprintln(os.Stdout, mediaStatusLine(*fixture, growSource))
	fmt.Fprintln(os.Stdout, jobsStatusLine(*ytdlp))

	if err := http.Serve(ln, srv.Handler()); err != nil &&
		!errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// banner is the startup line printed to the terminal. It carries the same
// api.Version that /v1/health reports; release builds inject the manifest
// version into api.Version at link time, so the banner cannot diverge from
// the release manifest (asserted by scripts/test-release.ps1).
func banner(addr string) string {
	return fmt.Sprintf("EizouDendenshi ED-2B (%s) listening on http://%s", api.Version, addr)
}

// mediaStatusLine is the terminal handoff line for the media endpoint. The
// growing line reports total and current availability so a QA operator can
// see the simulated download progress; nothing sensitive is printed.
func mediaStatusLine(fixturePath string, grow media.GrowingSource) string {
	switch {
	case grow != nil:
		return fmt.Sprintf("Media fixture: growing (total %d bytes, available %d)",
			grow.Total(), grow.Available())
	case fixturePath != "":
		return fmt.Sprintf("Media fixture: enabled (%s)", filepath.Base(fixturePath))
	default:
		return "Media fixture: disabled (--fixture not set)"
	}
}

// jobsStatusLine is the terminal handoff line for YouTube source jobs
// (ED-2F). Only the basename of the pinned helper is shown — never a full
// path or anything request-derived.
func jobsStatusLine(helperPath string) string {
	if helperPath == "" {
		return "Source jobs: disabled (--ytdlp not set)"
	}
	return fmt.Sprintf("Source jobs: enabled (helper: %s)", filepath.Base(helperPath))
}

// resolveBindAddress enforces the loopback-only binding policy. Only literal
// loopback IPs are accepted: IPv4 127.0.0.0/8 (net.IP.IsLoopback) and IPv6
// ::1. Hostnames — including "localhost" — and the empty host (":port", which
// binds all interfaces) are rejected. The port must be a valid numeric port
// (0–65535; 0 = ephemeral for this PoC).
func resolveBindAddress(addr string) (string, error) {
	if addr == "" {
		return "", errors.New("empty address")
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", fmt.Errorf("invalid host:port: %w", err)
	}
	if host == "" {
		return "", errors.New("empty host binds all interfaces; use a literal loopback IP (e.g. 127.0.0.1)")
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return "", fmt.Errorf("host %q is not a literal loopback IP", host)
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 0 || n > 65535 {
		return "", fmt.Errorf("invalid port %q", port)
	}
	return addr, nil
}
