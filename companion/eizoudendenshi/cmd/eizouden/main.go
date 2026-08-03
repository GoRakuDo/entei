// Command eizouden is the EizouDendenshi loopback companion.
//
// It binds a loopback-only HTTP API, prints its resolved bound address and a
// freshly generated 6-digit pairing code to the terminal, then serves the
// /v1 API. The pairing code is never persisted; the capability token IS
// persisted (platform-appropriate user-private storage — DPAPI on Windows,
// Termux app-private on Android; see internal/credential) so a successful
// pairing survives browser reloads and companion restarts until the user
// explicitly deletes it (DELETE /v1/pair). With --fixture, a single media
// file is served at /v1/media/fixture with byte Range semantics. With
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
	"strings"
	"time"

	"eizoudendenshi/internal/api"
	"eizoudendenshi/internal/credential"
	"eizoudendenshi/internal/job"
	"eizoudendenshi/internal/media"
	"eizoudendenshi/internal/torrent"
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

// defaultAddr is the fixed loopback port the Entei Player pairing /
// Magnet / bridge clients are hardcoded to (http://127.0.0.1:4322). The
// common CLI's option 1 and plain interactive launches must bind this
// default; tests and harnesses pass an explicit --addr for isolation.
const defaultAddr = "127.0.0.1:4322"

func main() {
	addr := flag.String("addr", defaultAddr,
		"loopback bind address host:port (default "+defaultAddr+", the "+
			"Entei Player pairing contract; use 127.0.0.1:0 for an ephemeral "+
			"test/dev port)")
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
	ffmpeg := flag.String("ffmpeg", "",
		"path to a pinned ffmpeg executable reported by the common CLI "+
			"service status (Windows launcher; the server itself never invokes "+
			"ffmpeg — yt-dlp does)")
	torrentTimeout := flag.Duration("torrent-timeout", 2*time.Minute,
		"metadata fetch timeout for torrent source jobs (ED-2G; default 2m)")
	flag.Parse()

	args := flag.Args()
	if len(args) > 0 && args[0] != "cli" {
		log.Fatalf("unknown command %q (expected \"cli\" or no arguments)", args[0])
	}

	bind, err := resolveBindAddress(*addr)
	if err != nil {
		log.Fatalf("invalid --addr: %v", err)
	}

	if *fixture != "" {
		st, err := os.Stat(*fixture)
		if err != nil {
			log.Fatalf("--fixture: %v", err)
		}
		if st.IsDir() {
			log.Fatalf("--fixture: %q is a directory; a single file is required", *fixture)
		}
	}

	allowOrigins, err := parseAllowOrigins(extraOrigins)
	if err != nil {
		log.Fatalf("invalid --allow-origin: %v", err)
	}

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
		if st.Size() == 0 {
			log.Fatalf("--ytdlp: %q is empty (reject zero-byte helper)", *ytdlp)
		}
		jobs, err = job.New(job.Config{HelperPath: *ytdlp, Timeout: *jobTimeout})
		if err != nil {
			log.Fatalf("init jobs: %v", err)
		}
	}

	// ED-2G: Torrent jobs via anacrolix/torrent engine (loopback-only, no
	// seeding, private session). Always enabled; each torrent session gets
	// its own Engine (per-job Client) to avoid anacrolix v1.61 issue #1048
	// (stale tracker weakref when the same Client re-adds the same
	// infohash after Drop). The torrent endpoints are registered whenever
	// a manager is provided.
	torrents, err := torrent.New(torrent.Config{
		EngineFactory: torrent.NewAnacrolixEngine,
		Timeout:       *torrentTimeout,
	})
	if err != nil {
		log.Fatalf("init torrents: %v", err)
	}

	if *ffmpeg != "" {
		st, err := os.Stat(*ffmpeg)
		if err != nil {
			log.Fatalf("--ffmpeg: %v", err)
		}
		if st.IsDir() {
			log.Fatalf("--ffmpeg: %q is a directory; a single executable is required", *ffmpeg)
		}
		if st.Size() == 0 {
			log.Fatalf("--ffmpeg: %q is empty (reject zero-byte helper)", *ffmpeg)
		}
	}

	// Persistent pairing credential (platform-appropriate user-private
	// storage: DPAPI on Windows, Termux app-private on Android). The
	// platform resolution fails closed — never silently fall back to a
	// memory-only companion the user believes is persistent.
	cred, err := credential.NewDefaultStore()
	if err != nil {
		log.Fatalf("init pairing credential store: %v", err)
	}

	if len(args) > 0 && args[0] == "cli" {
		cfg := serverConfig{
			bind:     bind,
			fixture:  *fixture,
			grow:     growSource,
			origins:  allowOrigins,
			jobs:     jobs,
			torrents: torrents,
			cred:     cred,
		}
		code := runCLI(cliOptions{
			version: api.Version,
			ytdlp:   *ytdlp,
			ffmpeg:  *ffmpeg,
		}, os.Stdin, os.Stdout, func() error { return runServer(cfg, *ytdlp) })
		os.Exit(code)
	}

	if err := runServer(serverConfig{
		bind:     bind,
		fixture:  *fixture,
		grow:     growSource,
		origins:  allowOrigins,
		jobs:     jobs,
		torrents: torrents,
		cred:     cred,
	}, *ytdlp); err != nil {
		log.Fatal(err)
	}
}

// runServer starts the foreground loopback companion: API wiring, listener,
// terminal-only handoff (banner + pairing code), then serving until
// Ctrl+C. Shared by the plain server mode and the CLI's option 1 so startup
// behavior is never duplicated.
func runServer(cfg serverConfig, ytdlpPath string) error {
	srv, err := api.New(api.Config{
		FixturePath:  cfg.fixture,
		GrowSource:   cfg.grow,
		AllowOrigins: cfg.origins,
		Jobs:         cfg.jobs,
		Torrents:     cfg.torrents,
		Credential:   cfg.cred,
		// After an authenticated DELETE /v1/pair the in-memory credential
		// is rotated and a FRESH code is issued; print it to the terminal
		// so the pairing dialog works again without a restart.
		OnPairingReset: func(code string) {
			fmt.Fprintf(os.Stdout, "Pairing code (new): %s\n", code)
		},
	})
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", cfg.bind)
	if err != nil {
		if strings.Contains(err.Error(), "address already in use") ||
			strings.Contains(err.Error(), "Only one usage of each socket address") {
			return fmt.Errorf("port %s is already in use — another EizouDendenshi companion is already running (stop it first, or choose another port with --addr)", cfg.bind)
		}
		return err
	}
	fmt.Fprintln(os.Stdout, banner(ln.Addr().String()))
	fmt.Fprintf(os.Stdout, "Pairing code: %s\n", srv.PairingCode())
	fmt.Fprintln(os.Stdout, mediaStatusLine(cfg.fixture, cfg.grow))
	fmt.Fprintln(os.Stdout, jobsStatusLine(ytdlpPath))
	fmt.Fprintln(os.Stdout, "Torrent jobs: enabled (anacrolix engine, max 2 concurrent)")
	if err := http.Serve(ln, srv.Handler()); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// serverConfig bundles the values needed to start the loopback companion.
type serverConfig struct {
	bind     string
	fixture  string
	grow     media.GrowingSource
	origins  []string
	jobs     *job.Manager
	torrents *torrent.Manager
	cred     credential.Store
}

// banner is the startup line printed to the terminal.
func banner(addr string) string {
	return fmt.Sprintf("EizouDendenshi ED-2B (%s) listening on http://%s", api.Version, addr)
}

// mediaStatusLine is the terminal handoff line for the media endpoint.
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

// jobsStatusLine is the terminal handoff line for YouTube source jobs.
func jobsStatusLine(helperPath string) string {
	if helperPath == "" {
		return "Source jobs: disabled (--ytdlp not set)"
	}
	return fmt.Sprintf("Source jobs: enabled (helper: %s)", filepath.Base(helperPath))
}

// resolveBindAddress enforces the loopback-only binding policy.
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
