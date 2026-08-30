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
//
// With the `cli` command the common three-option menu runs (pairing /
// service status / update; see cli.go). The internal `apply-update`
// child mode is spawned by the updater itself and never typed by a
// user: it replaces the verified staged core/helpers after the parent
// exits and prints an update-complete message (it does NOT auto-launch
// the new core — the user runs `grkd-edds` manually), without ever
// touching the persisted pairing credential.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"eizoudendenshi/internal/anki"
	"eizoudendenshi/internal/api"
	"eizoudendenshi/internal/credential"
	"eizoudendenshi/internal/diag"
	"eizoudendenshi/internal/job"
	"eizoudendenshi/internal/media"
	"eizoudendenshi/internal/torrent"
	"eizoudendenshi/internal/update"
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

// resolveYtdlp returns the yt-dlp helper path to use: the explicit
// --ytdlp value when given, otherwise the result of a PATH lookup for
// "yt-dlp". An explicit value always wins; PATH fallback is what enables
// Termux (auto-started grkd-edds passes no flags, and the bootstrap
// installs yt-dlp on PATH). A failed lookup leaves the value empty (the
// YouTube source-job endpoints stay disabled, as before). The lookup
// function is injectable for tests.
func resolveYtdlp(explicit string, lookPath func(string) (string, error)) string {
	if explicit != "" {
		return explicit
	}
	p, err := lookPath("yt-dlp")
	if err != nil {
		return ""
	}
	return p
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

// resolveAnkiBridge wires the AnkiDroid bridge (spec v4.1,
// 2026-08-31): the raw AnkiConnect listener on 127.0.0.1:8765 is
// the only Anki surface. The bridge wires:
//
//   - MediaWriter — used by storeMediaFile + the addNote media-array
//     rewrite. Probed from the AnkiDroid legacy media-dir candidates
//     via the existing NewMediaWriter probe (Termux auto-detect).
//   - Collection — opened on collection.anki2, either the explicit
//     --anki-collection path or, when --anki-collection is empty,
//     auto-derived as <probed media dir>/../collection.anki2 (spec
//     v3.0 contract, restored in v4.1).
//   - APIKey — optional AnkiConnect-style body key from
//     --anki-api-key; empty means no key required.
//
// The MediaWriter probe is injectable (probe fn) so tests can
// substitute a fake that returns a t.TempDir() instead of touching
// /storage/emulated/0 on the CI box. The production probe (used by
// main) is defaultAnkiProbe below, which calls anki.NewMediaWriter("")
// to write + delete a probe file in each legacy candidate; failure on
// Android means a missing /storage permission or a non-legacy
// AnkiDroid collection path, both of which the user can fix. On
// Windows / macOS dev hosts the probe returns ErrUnsupportedPlatform
// which we degrade to a nil Writer + nil error — the bridge runs
// notes-only so the developer can exercise addNote / findNotes
// against a stub AnkiDroid collection on a Linux dev box or via a
// fixture --anki-collection.
//
// Empty --anki-collection (the default; the menu/launcher path
// never passes it) restores the v3.0 auto-derive: the probe runs;
// on success we stat <media dir>/../collection.anki2; if it exists,
// the bridge is wired against that path. If the probe fails OR
// the sibling collection.anki2 is absent (the "AnkiDroid migrated
// to app-private storage" case), the bridge is disabled and the
// 8765 listener never binds. This is the user-facing fix for the
// v4.0 regression where the bridge was dead on the primary launch
// path: the whole point of v3.0 was "delete AnkiconnectAndroid
// and cards still work", which requires the bridge ON by default
// whenever a legacy AnkiDroid collection is detected.
//
// The Collection construction is best-effort too: Open failure
// (AnkiDroid play-variant app-private path, schema unsupported,
// DB locked) is logged at startup and the bridge wires with DB =
// nil. StartRawAnkiConnectListener still binds 8765 (and
// dispatchAnkiAction surfaces the failure as an AnkiConnect-shaped
// error envelope for every action).
//
// Spec v4.1 (2026-08-31): the default is AUTO-DERIVE (probe
// collection.media → sibling collection.anki2); --anki-collection
// is now an OVERRIDE for non-standard locations (e.g. an
// app-private path the user wants the bridge to talk to).
// --anki-media-dir was removed back in v4.0; --anki-api-key is the
// optional API-key flag. apiKey=="" disables the key gate (matches
// AnkiconnectAndroid).
func resolveAnkiBridge(collectionOverride, apiKey string, diagLog *diag.Logger, probe func() (*anki.MediaWriter, error)) *api.AnkiBridge {
	writer, werr := probe()
	if werr != nil && collectionOverride == "" && diagLog != nil {
		// Only logged in the auto-derive branch: an explicit
		// --anki-collection has its own error path (OpenCollection
		// below) and surfaces through the per-action dispatch.
		diagLog.Warnf("anki", "collection.media probe failed: %v (AnkiDroid may be migrated to app-private storage; bridge disabled)", werr)
		return nil
	}
	var collectionPath string
	switch {
	case collectionOverride != "":
		collectionPath = collectionOverride
	case writer != nil && writer.Dir() != "":
		// v3.0 auto-derive contract: the AnkiDroid collection.anki2
		// lives next to collection.media. Stat the sibling; absent
		// means the user migrated AnkiDroid to app-private storage,
		// which Termux can't reach — disable the bridge with one
		// diagnostic line instead of guessing.
		sibling := filepath.Join(filepath.Dir(writer.Dir()), "collection.anki2")
		if _, statErr := os.Stat(sibling); statErr != nil {
			if diagLog != nil {
				diagLog.Warnf("anki", "no collection.anki2 next to media dir %s — AnkiDroid may be migrated to app-private storage; bridge disabled", writer.Dir())
			}
			writer = nil
			break
		}
		collectionPath = sibling
	}
	var db *anki.Collection
	if collectionPath != "" {
		var err error
		db, err = anki.OpenCollection(collectionPath)
		if err != nil && diagLog != nil {
			diagLog.Warnf("anki", "collection open: %v", err)
		}
	}
	if collectionPath == "" && writer == nil {
		// Nothing wired: probe failed or sibling missing in the
		// auto-derive branch. Returning a non-nil empty struct
		// would make ankiStatusLine print "neither half is up"
		// and cfg.anki != nil — the bridge stays disabled, just
		// like the v4.0 opt-in contract: no 8765 listener, no
		// dispatch surface. An explicit --anki-collection that
		// fails to open still returns the non-nil shape so the
		// listener binds and dispatch surfaces the per-action
		// error envelope.
		return nil
	}
	return &api.AnkiBridge{
		Writer:  writer,
		DB:      db,
		APIKey:  apiKey,
		Enabled: writer != nil || db != nil,
	}
}

// defaultAnkiProbe is the production probe injected into
// resolveAnkiBridge from main. It maps anki.NewMediaWriter's
// (writer, err) return to a stable shape: nil writer + nil error
// means "this platform is unsupported" (ErrUnsupportedPlatform,
// which we silently swallow here — resolveAnkiBridge only logs the
// error in the auto-derive branch). On Android/Termux a real
// /storage/emulated/0/AnkiDroid/collection.media is returned (or
// the failure error if the legacy candidate is unwritable).
func defaultAnkiProbe() (*anki.MediaWriter, error) {
	return anki.NewMediaWriter("")
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
	ankiCollection := flag.String("anki-collection", "",
		"path to the AnkiDroid collection.anki2 SQLite database (spec "+
			"EIZOU_DENDENSHI_ANKIDROID_CONNECT.md v4.1, 2026-08-31). The "+
			"raw AnkiConnect-compatible listener on 127.0.0.1:8765 is the "+
			"only Anki surface — Entei / Yomitan / asbplayer connect with "+
			"zero config. DEFAULT: auto-derive from the probed "+
			"collection.media sibling — the companion probes the legacy "+
			"AnkiDroid media dir candidates and, when the sibling "+
			"collection.anki2 exists, wires the bridge against that path. "+
			"This is the spec v3.0 contract restored in v4.1 (the v4.0 "+
			"opt-in flag was a regression: the menu/launcher path never "+
			"passes flags, so the bridge was dead on the primary launch "+
			"path). Use this flag only as an OVERRIDE for non-standard "+
			"locations (e.g. an app-private path the user wants the "+
			"bridge to talk to). When the probe fails OR the sibling "+
			"collection.anki2 is missing (AnkiDroid migrated to app-"+
			"private storage; Termux can't reach it) the bridge stays "+
			"disabled and the 8765 listener never binds. The companion "+
			"opens the resolved file with modernc.org/sqlite (pure-Go, "+
			"no CGO; busy_timeout=5000; respects AnkiDroid's existing "+
			"journal_mode). Failure to open logs a warning; the 8765 "+
			"listener still binds and dispatch surfaces the failure as "+
			"an AnkiConnect-shaped error envelope per action.")
	ankiAPIKey := flag.String("anki-api-key", "",
		"optional AnkiConnect-style API key required in the body `key` "+
			"field of every raw-listener request (constant-time compared). "+
			"Empty disables the key gate — any caller may use the bridge "+
			"(matches AnkiconnectAndroid). The flag never reaches the log "+
			"or any wire response.")
	flag.Parse()

	// Android (Termux) DNS bootstrap: pure-Go (CGO_ENABLED=0) resolver
	// cannot reach the OS resolver, so install the Termux resolv.conf
	// nameservers (fallback 1.1.1.1) BEFORE any hostname resolution —
	// DHT bootstrap, tracker metadata, and the updater all depend on it.
	// No-op on other platforms.
	installAndroidDNSResolver()

	// YouTube helper auto-detection: Termux's grkd-edds (auto-start) never
	// passes --ytdlp, but the bootstrap installs yt-dlp onto PATH
	// ($PREFIX/bin/yt-dlp). Without it the job manager stays nil and the
	// browser sees a CORS-less 404 on /v1/source/jobs. LookPath keeps the
	// behavior explicit-only elsewhere (Windows keeps its old semantics
	// unless yt-dlp happens to be on PATH).
	*ytdlp = resolveYtdlp(*ytdlp, exec.LookPath)

	args := flag.Args()
	if len(args) > 0 && args[0] == "apply-update" {
		// Internal --apply-update child mode (spawned by the updater's
		// CLI option 3): replaces the verified staged core/helpers after
		// the parent exits and prints the update-complete message (the
		// new core is NOT auto-launched — the user runs `grkd-edds`
		// manually). This runs BEFORE any credential/server
		// initialization so the child never touches pairing state.
		os.Exit(update.ApplyStaged(args[1:]))
	}
	if len(args) > 0 && args[0] != "cli" {
		log.Fatalf("unknown command %q (expected \"cli\" or no arguments)", args[0])
	}

	// Diagnostic file logger (best effort). The resolved directory is never
	// printed, and a failure to open the log disables logging silently —
	// the companion must still run. nil means "no logging" everywhere.
	diagLog := openDiagLogger()

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
		jobs, err = job.New(job.Config{HelperPath: *ytdlp, Timeout: *jobTimeout, Logger: diagLog})
		if err != nil {
			log.Fatalf("init jobs: %v", err)
		}
	}

	// ED-2G: Torrent jobs via anacrolix/torrent engine (no seeding, private
	// session; peer transport on all interfaces — see engine_anacrolix.go).
	// Always enabled; each torrent session gets its own Engine (per-job
	// Client) to avoid anacrolix v1.61 issue #1048 (stale tracker weakref
	// when the same Client re-adds the same infohash after Drop). The
	// torrent endpoints are registered whenever a manager is provided.
	torrents, err := torrent.New(torrent.Config{
		EngineFactory: torrent.NewAnacrolixEngine,
		Timeout:       *torrentTimeout,
		Logger:        diagLog,
	})
	if err != nil {
		log.Fatalf("init torrents: %v", err)
	}

	// Best-effort cleanup of leftover session-* directories from previous
	// (possibly crashed) runs. Runs in a background goroutine so startup
	// is never blocked; errors are silently ignored.
	go func() {
		if n := torrents.CleanupStaleSessions(); n > 0 {
			if diagLog != nil {
				diagLog.Infof("torrent", "cleaned %d stale session dirs", n)
			}
		}
	}()

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
			ffmpeg:   *ffmpeg,
			origins:  allowOrigins,
			jobs:     jobs,
			torrents: torrents,
			cred:     cred,
			log:      diagLog,
			anki:     resolveAnkiBridge(*ankiCollection, *ankiAPIKey, diagLog, defaultAnkiProbe),
		}
		code := runCLI(cliOptions{
			version:   api.Version,
			ytdlp:     *ytdlp,
			ffmpeg:    *ffmpeg,
			logStatus: diagStatusLine(diagLog),
			runUpdate: func(w io.Writer) bool {
				return update.Run(w, update.Config{
					Version:     api.Version,
					InstallRoot: updateInstallRoot(),
				})
			},
			autoStart: func() (string, <-chan error, error) {
				return startServerAuto(cfg)
			},
		}, os.Stdin, os.Stdout, func() error { return runServer(cfg, *ytdlp) })
		terminateDiag(diagLog)
		os.Exit(code)
	}

	if err := runServer(serverConfig{
		bind:     bind,
		fixture:  *fixture,
		grow:     growSource,
		ffmpeg:   *ffmpeg,
		origins:  allowOrigins,
		jobs:     jobs,
		torrents: torrents,
		cred:     cred,
		log:      diagLog,
		anki:     resolveAnkiBridge(*ankiCollection, *ankiAPIKey, diagLog, defaultAnkiProbe),
	}, *ytdlp); err != nil {
		terminateDiag(diagLog)
		log.Fatal(err)
	}
	terminateDiag(diagLog)
}

// startServerCore creates the API server and binds the loopback listener.
// It returns the server and listener so the caller decides how to serve
// (blocking or goroutine) and what to print. The caller owns the listener
// lifecycle: close it after http.Serve returns.
func startServerCore(cfg serverConfig) (*api.Server, net.Listener, error) {
	srv, err := api.New(api.Config{
		FixturePath:  cfg.fixture,
		GrowSource:   cfg.grow,
		Ffmpeg:       cfg.ffmpeg,
		AllowOrigins: cfg.origins,
		Jobs:         cfg.jobs,
		Torrents:     cfg.torrents,
		Credential:   cfg.cred,
		Logger:       cfg.log,
		Anki:         cfg.anki,
		OnPairingReset: func(code string) {
			fmt.Fprintf(os.Stdout, "Pairing code (new): %s\n", code)
		},
	})
	if err != nil {
		return nil, nil, err
	}
	ln, err := net.Listen("tcp", cfg.bind)
	if err != nil {
		if strings.Contains(err.Error(), "address already in use") ||
			strings.Contains(err.Error(), "Only one usage of each socket address") {
			return nil, nil, fmt.Errorf("port %s is already in use — another EizouDendenshi companion is already running (stop it first, or choose another port with --addr)", cfg.bind)
		}
		return nil, nil, err
	}
	return srv, ln, nil
}

// startServerAuto creates the API server, binds the listener, and starts
// http.Serve in a goroutine. It returns the pairing code (for display on
// option 1), an error channel that receives the http.Serve result (nil on
// clean shutdown), and a startup error if the server could not be created.
// The goroutine is killed when the process exits (Ctrl+C). It also
// starts the raw AnkiConnect-compatible listener on 127.0.0.1:8765
// when the Anki bridge is enabled; EADDRINUSE on 8765 is logged as a
// one-line warning and never blocks startup (a desktop AnkiConnect
// must not break the companion).
func startServerAuto(cfg serverConfig) (pairingCode string, errCh <-chan error, err error) {
	srv, ln, err := startServerCore(cfg)
	if err != nil {
		return "", nil, err
	}
	if err := srv.StartRawAnkiConnectListener(api.RawAnkiConnectBind); err != nil {
		// EADDRINUSE on 8765 is the documented "desktop AnkiConnect
		// is running" case — warn and continue. Other bind failures
		// (parse error etc.) get the same treatment: the Anki
		// surface is best-effort and the main /v1/* server keeps
		// serving regardless.
		fmt.Fprintf(os.Stdout, "anki-compat listener on %s unavailable: %v (official AnkiConnect may be running; companion keeps serving)\n", api.RawAnkiConnectBind, err)
	}
	ch := make(chan error, 1)
	go func() {
		if err := http.Serve(ln, srv.Handler()); err != nil && !errors.Is(err, http.ErrServerClosed) {
			ch <- err
		}
		close(ch)
	}()
	return srv.PairingCode(), ch, nil
}

// runServer starts the foreground loopback companion: API wiring, listener,
// terminal-only handoff (banner + pairing code), then serving until
// Ctrl+C. Shared by the plain server mode and the CLI's option 1 so startup
// behavior is never duplicated. The raw AnkiConnect-compatible listener
// on 127.0.0.1:8765 starts alongside the main server; EADDRINUSE is
// logged as a one-line warning and never blocks startup.
func runServer(cfg serverConfig, ytdlpPath string) error {
	srv, ln, err := startServerCore(cfg)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, banner(ln.Addr().String()))
	fmt.Fprintf(os.Stdout, "Pairing code: %s\n", srv.PairingCode())
	fmt.Fprintln(os.Stdout, mediaStatusLine(cfg.fixture, cfg.grow))
	fmt.Fprintln(os.Stdout, jobsStatusLine(ytdlpPath))
	fmt.Fprintln(os.Stdout, "Torrent jobs: enabled (anacrolix engine, max 2 concurrent)")
	if err := srv.StartRawAnkiConnectListener(api.RawAnkiConnectBind); err != nil {
		fmt.Fprintf(os.Stdout, "anki-compat listener on %s unavailable: %v (official AnkiConnect may be running; companion keeps serving)\n", api.RawAnkiConnectBind, err)
	}
	fmt.Fprintln(os.Stdout, ankiStatusLine(cfg.anki))
	if err := http.Serve(ln, srv.Handler()); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// updateInstallRoot returns the directory containing the running core:
// on Windows the launcher runs the core from the user-private install
// root (%LOCALAPPDATA%\GoRakuDo\EizouDendenshi) and on Termux from
// $PREFIX/var/lib/eizouden, so the executable's own directory IS the
// install root the updater must update in place.
func updateInstallRoot() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(exe)
}

// serverConfig bundles the values needed to start the loopback companion.
type serverConfig struct {
	bind     string
	fixture  string
	grow     media.GrowingSource
	ffmpeg   string
	origins  []string
	jobs     *job.Manager
	torrents *torrent.Manager
	cred     credential.Store
	log      *diag.Logger
	anki     *api.AnkiBridge // nil = bridge disabled (routes stay 404)
}

// openDiagLogger opens the diagnostic file logger (best effort). The log
// directory is resolved by diag.DefaultDir and is never printed anywhere;
// a resolution or open failure disables logging silently (nil logger) so
// the companion always runs. The startup line is the first entry: version,
// platform, and the log status — no paths, no credentials.
func openDiagLogger() *diag.Logger {
	dir, err := diag.DefaultDir()
	if err != nil {
		return nil
	}
	l, err := diag.NewLogger(dir)
	if err != nil {
		return nil
	}
	l.Infof("main", "start version=%s platform=%s log=enabled", api.Version, runtime.GOOS)
	return l
}

// diagStatusLine is the safe CLI status text for the diagnostic logger:
// "enabled" or "disabled" — never the log path.
func diagStatusLine(l *diag.Logger) string {
	if l == nil {
		return "disabled"
	}
	return "enabled"
}

// terminateDiag writes the final line and closes the log file. Nil-safe;
// called on every normal exit path (log.Fatal paths are terminal anyway —
// the file writes are unbuffered, so no data is lost).
func terminateDiag(l *diag.Logger) {
	if l == nil {
		return
	}
	l.Infof("main", "terminated")
	_ = l.Close()
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

// ankiStatusLine is the terminal handoff line for the AnkiDroid
// bridge (spec v4.1, 2026-08-31). The raw AnkiConnect-compatible
// listener on 127.0.0.1:8765 is the only Anki surface; the line
// reports whether 8765 will bind (the bind itself happens after
// the main server starts; EADDRINUSE there is logged as a
// separate one-liner).
//
// It mirrors the media / jobs lines: enabled / disabled / partial.
// The media dir path is included when the writer was successfully
// constructed (the operator asked for Termux direct writes — they
// deserve to see which directory the companion picked). The
// collection path is included when the Collection opened. When the
// bridge is disabled (auto-derive failed — probe error or no
// sibling collection.anki2 — or the explicit --anki-collection
// failed to open with the listener bound anyway) the line is short
// and matches the historical "opt-in only" wording.
func ankiStatusLine(bridge *api.AnkiBridge) string {
	if bridge == nil {
		return "Anki bridge: disabled (no AnkiDroid collection detected)"
	}
	mediaOK := bridge.Writer != nil
	collectionOK := bridge.DB != nil
	switch {
	case mediaOK && collectionOK:
		return fmt.Sprintf("Anki bridge: enabled, 8765 listener (media dir: %s; collection: %s)",
			bridge.Writer.Dir(), bridge.DB.Path())
	case mediaOK && !collectionOK:
		return fmt.Sprintf("Anki bridge: media-only, 8765 listener (collection not open; media dir: %s)",
			bridge.Writer.Dir())
	case !mediaOK && collectionOK:
		return fmt.Sprintf("Anki bridge: notes-only, 8765 listener (media dir not writable; collection: %s)",
			bridge.DB.Path())
	default:
		return "Anki bridge: enabled, 8765 listener but neither half is up (dispatch surfaces errors per action)"
	}
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
