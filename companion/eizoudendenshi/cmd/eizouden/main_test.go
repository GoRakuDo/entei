package main

import (
	"database/sql"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"eizoudendenshi/internal/anki"
	"eizoudendenshi/internal/api"
	"eizoudendenshi/internal/credential"
	"eizoudendenshi/internal/diag"
	"eizoudendenshi/internal/media"
)

func TestDefaultAddrIsPlayerContractPort(t *testing.T) {
	if defaultAddr != "127.0.0.1:4322" {
		t.Fatalf("defaultAddr = %q, want the Entei Player pairing contract 127.0.0.1:4322", defaultAddr)
	}
}

func TestResolveBindAddress(t *testing.T) {
	tests := []struct {
		name    string
		addr    string
		wantErr bool
	}{
		{"loopback ipv4 ephemeral", "127.0.0.1:0", false},
		{"loopback ipv4 fixed", "127.0.0.1:4321", false},
		{"loopback range ipv4", "127.0.0.2:9000", false},
		{"loopback range ipv4 upper", "127.255.255.254:80", false},
		{"loopback ipv6", "[::1]:0", false},
		{"empty addr", "", true},
		{"empty host binds all interfaces", ":4321", true},
		{"wildcard ipv4", "0.0.0.0:4321", true},
		{"unspecified ipv6", "[::]:8080", true},
		{"private lan ip", "192.168.1.5:4321", true},
		{"public ip", "8.8.8.8:4321", true},
		{"non-loopback hostname", "example.com:4321", true},
		{"localhost hostname rejected", "localhost:4321", true},
		{"localhost mixed case rejected", "LOCALHOST:4321", true},
		{"missing port", "127.0.0.1", true},
		{"missing port localhost", "localhost", true},
		{"non-numeric port", "127.0.0.1:http", true},
		{"port out of range", "127.0.0.1:65536", true},
		{"negative port", "127.0.0.1:-1", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveBindAddress(tt.addr)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("resolveBindAddress(%q) = %q, want error", tt.addr, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveBindAddress(%q) error: %v", tt.addr, err)
			}
			if got != tt.addr {
				t.Errorf("resolveBindAddress(%q) = %q, want input preserved", tt.addr, got)
			}
		})
	}
}

// TestParseAllowOrigins covers the ED-2C --allow-origin contract: nonempty
// values must parse as exact HTTP(S) origins (and are normalized), empty
// values are ignored, and any malformed value makes the whole flag set
// invalid. main calls parseAllowOrigins before net.Listen, so a malformed
// value is rejected before the server starts listening.
func TestParseAllowOrigins(t *testing.T) {
	tests := []struct {
		name    string
		in      []string
		want    []string
		wantErr bool
	}{
		{
			name: "empty list",
			in:   nil,
			want: nil,
		},
		{
			name: "empty values ignored",
			in:   []string{"", ""},
			want: nil,
		},
		{
			name:    "whitespace-only value rejected as malformed",
			in:      []string{"   "},
			wantErr: true,
		},
		{
			name: "single valid origin normalized",
			in:   []string{"HTTP://EXAMPLE.COM:80"},
			want: []string{"http://example.com"},
		},
		{
			name: "single valid origin with port",
			in:   []string{"http://192.0.2.10:4321"},
			want: []string{"http://192.0.2.10:4321"},
		},
		{
			name: "multiple origins preserved in order",
			in:   []string{"https://a.example", "http://b.example:8080"},
			want: []string{"https://a.example", "http://b.example:8080"},
		},
		{
			name: "duplicate values deduplicated by New, kept here",
			in:   []string{"http://a.example", "http://a.example"},
			want: []string{"http://a.example", "http://a.example"},
		},
		{
			name:    "malformed origin rejected",
			in:      []string{"http://example.com/path"},
			wantErr: true,
		},
		{
			name:    "malformed origin among valid rejected",
			in:      []string{"http://a.example", "ftp://b.example"},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseAllowOrigins(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseAllowOrigins(%v) = %v, want error", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseAllowOrigins(%v) error: %v", tt.in, err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseAllowOrigins(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

// TestBannerCarriesVersion pins the startup-line contract: the banner must
// carry the same api.Version that /v1/health reports, so a release build's
// startup line cannot diverge from the manifest version injected at link
// time (asserted end-to-end by scripts/test-release.ps1).
func TestBannerCarriesVersion(t *testing.T) {
	const addr = "127.0.0.1:4322"
	got := banner(addr)
	for _, want := range []string{
		"EizouDendenshi ED-2B (" + api.Version + ")",
		"listening on http://" + addr,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("banner = %q, missing %q", got, want)
		}
	}
}

// TestResolveGrowSource covers the ED-2C --grow-fixture/--grow-total pair:
// neither flag → nil source; a partial pair → error; a valid pair builds a
// file-backed growing source with the declared total, failing fast on a
// missing file, a directory, or a size beyond the declared total. main
// calls resolveGrowSource before net.Listen, so a malformed configuration
// is rejected before the server starts.
func TestResolveGrowSource(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "grow.mp4")
	payload := make([]byte, 100)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("neither flag", func(t *testing.T) {
		src, err := resolveGrowSource("", 0)
		if err != nil || src != nil {
			t.Fatalf("resolveGrowSource(\"\", 0) = %v, %v; want nil, nil", src, err)
		}
	})

	t.Run("total without fixture rejected", func(t *testing.T) {
		if _, err := resolveGrowSource("", 100); err == nil {
			t.Fatal("want error for --grow-total without --grow-fixture")
		}
	})

	t.Run("fixture without total rejected", func(t *testing.T) {
		if _, err := resolveGrowSource(path, 0); err == nil {
			t.Fatal("want error for --grow-fixture without --grow-total")
		}
	})

	t.Run("missing file rejected", func(t *testing.T) {
		if _, err := resolveGrowSource(filepath.Join(dir, "nope.mp4"), 100); err == nil {
			t.Fatal("want error for missing file")
		}
	})

	t.Run("size beyond total rejected", func(t *testing.T) {
		if _, err := resolveGrowSource(path, 50); err == nil {
			t.Fatal("want error when current size exceeds declared total")
		}
	})

	t.Run("valid pair builds growing source", func(t *testing.T) {
		src, err := resolveGrowSource(path, 300)
		if err != nil {
			t.Fatalf("resolveGrowSource: %v", err)
		}
		if src == nil {
			t.Fatal("want non-nil growing source")
		}
		if got := src.Total(); got != 300 {
			t.Errorf("Total = %d, want 300", got)
		}
		if got := src.Available(); got != 100 {
			t.Errorf("Available = %d, want 100", got)
		}
		src.(*media.FileSource).Close()
	})
}

func TestMediaStatusLine(t *testing.T) {
	grow := media.NewMemSource(make([]byte, 10), 4)
	tests := []struct {
		name    string
		fixture string
		grow    media.GrowingSource
		want    string
	}{
		{"disabled", "", nil, "Media fixture: disabled (--fixture not set)"},
		{"static", `C:\tmp\fixture.mp4`, nil, "Media fixture: enabled (fixture.mp4)"},
		{"growing", "", grow, "Media fixture: growing (total 10 bytes, available 4)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := mediaStatusLine(tt.fixture, tt.grow); got != tt.want {
				t.Errorf("mediaStatusLine = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestAnkiStatusLine pins the terminal-handoff shape for the AnkiDroid
// bridge: disabled / media-only / notes-only / both / neither. The
// line must never echo a capability token or a pairing code (the only
// sensitive strings the command has access to); a non-empty writer
// path is OK because the spec marks the directory as non-sensitive.
func TestAnkiStatusLine(t *testing.T) {
	// A real Collection so DB.Path() returns a non-empty string
	// (the notes-only + both cases need a path).
	colPath := filepath.Join(t.TempDir(), "collection.anki2")
	// Build a minimal collection file via the anki package fixture
	// helper equivalent — we only need DB.Path() to return a value,
	// so a fresh open against a fixture is the simplest path.
	colRealPath := newColFixtureForStatusTest(t)
	coll, err := anki.OpenCollection(colRealPath)
	if err != nil {
		t.Fatalf("OpenCollection: %v", err)
	}
	t.Cleanup(func() { _ = coll.Close() })
	tests := []struct {
		name   string
		bridge *api.AnkiBridge
		want   string
	}{
		{
			"disabled",
			nil,
			"Anki bridge: disabled (no AnkiDroid collection detected)",
		},
		{
			"media-only (writer ok, collection not open)",
			&api.AnkiBridge{Writer: anki.NewMediaWriterForTest("/storage/emulated/0/AnkiDroid/collection.media"), DB: nil, Enabled: true},
			"Anki bridge: media-only, 8765 listener (collection not open; media dir: /storage/emulated/0/AnkiDroid/collection.media)",
		},
		{
			"both halves up",
			&api.AnkiBridge{Writer: anki.NewMediaWriterForTest("/storage/emulated/0/AnkiDroid/collection.media"), DB: coll, Enabled: true},
			"Anki bridge: enabled, 8765 listener (media dir: /storage/emulated/0/AnkiDroid/collection.media; collection: " + coll.Path() + ")",
		},
		{
			"notes-only (collection open, writer nil — the Fix-1 panic class)",
			&api.AnkiBridge{Writer: nil, DB: coll, Enabled: true},
			"Anki bridge: notes-only, 8765 listener (media dir not writable; collection: " + coll.Path() + ")",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ankiStatusLine(tt.bridge); got != tt.want {
				t.Errorf("ankiStatusLine = %q, want %q", got, tt.want)
			}
		})
	}
	_ = colPath
}

// newColFixtureForStatusTest builds a minimal collection.anki2 for
// TestAnkiStatusLine — we only need DB.Path() to be non-empty, so
// the lightweight schema-less file (the OpenCollection auto-
// detection would reject this) is replaced by an in-process
// anki.OpenCollection against a fixture built by the anki package's
// test helper. We import the package-private helper via the same
// test boundary.
//
// The test fixture in internal/anki/collection_test.go is in
// package anki and therefore not directly callable from cmd/eizouden.
// We build our own SQLite file with the required tables + a single
// col row so OpenCollection succeeds.
func newColFixtureForStatusTest(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "collection.anki2")
	db, err := openSQLiteForStatusTest(path)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(schemaForStatusTest); err != nil {
		t.Fatalf("apply schema: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, 0, 0, 0, 11, 0, 0, 0, '{}', '{}', '{}', '{}', '{}')`); err != nil {
		t.Fatalf("seed col: %v", err)
	}
	return path
}

// openSQLiteForStatusTest opens a pure-Go SQLite database for the
// status-line fixture. We use modernc.org/sqlite (already an indirect
// dep of the anki package) so this test needs no CGO.
func openSQLiteForStatusTest(path string) (*sql.DB, error) {
	return sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
}

// schemaForStatusTest is the minimal Anki schema slice the fixture
// needs (col / notes / cards). OpenCollection's schema detector only
// requires the three core tables to be present; the empty values in
// col.conf / col.models / col.decks / col.dconf / col.tags are fine
// because the ankiStatusLine under test only reads DB.Path().
const schemaForStatusTest = `
CREATE TABLE col (
	id integer PRIMARY KEY,
	crt integer NOT NULL,
	mod integer NOT NULL,
	scm integer NOT NULL,
	ver integer NOT NULL,
	dty integer NOT NULL,
	usn integer NOT NULL,
	ls integer NOT NULL,
	conf text NOT NULL,
	models text NOT NULL,
	decks text NOT NULL,
	dconf text NOT NULL,
	tags text NOT NULL
);
CREATE TABLE notes (
	id integer PRIMARY KEY,
	guid text NOT NULL,
	mid integer NOT NULL,
	mod integer NOT NULL,
	usn integer NOT NULL,
	tags text NOT NULL,
	flds text NOT NULL,
	sfld text NOT NULL,
	csum integer NOT NULL,
	flags integer NOT NULL,
	data text NOT NULL
);
CREATE TABLE cards (
	id integer PRIMARY KEY,
	nid integer NOT NULL,
	did integer NOT NULL,
	ord integer NOT NULL,
	mod integer NOT NULL,
	usn integer NOT NULL,
	type integer NOT NULL,
	queue integer NOT NULL,
	due integer NOT NULL,
	ivl integer NOT NULL,
	factor integer NOT NULL,
	reps integer NOT NULL,
	lapses integer NOT NULL,
	left integer NOT NULL,
	odue integer NOT NULL,
	odid integer NOT NULL,
	flags integer NOT NULL,
	data text NOT NULL
);
`

// TestResolveAnkiBridge pins the wiring function (spec v4.1,
// 2026-08-31). The probe function is injectable so tests can
// substitute a t.TempDir() fixture instead of touching
// /storage/emulated/0 on the CI box. Each subtest names the v4.1
// contract branch it's pinning.
//
// The MediaWriter probe runs in production via defaultAnkiProbe
// (calls anki.NewMediaWriter("")); here we substitute a fake that
// either returns a pre-prepared t.TempDir() or reports failure.
// OpenCollection is the only production-only call that touches
// real paths — it's exercised through newColFixtureForStatusTest,
// which builds a minimal collection.anki2 in t.TempDir().
func TestResolveAnkiBridge(t *testing.T) {
	t.Run("auto-derive: probe ok + collection.anki2 sibling enables bridge", func(t *testing.T) {
		// Fake probe returns <tempdir>/collection.media (a real,
		// writable dir created by t.TempDir). The sibling
		// <tempdir>/collection.anki2 is pre-created with a real
		// Anki schema so the auto-derive stat succeeds AND
		// OpenCollection succeeds (otherwise DB would be nil and
		// the test would fail to distinguish "bridge wired" from
		// "bridge disabled").
		dir := t.TempDir()
		mediaDir := filepath.Join(dir, "collection.media")
		if err := os.MkdirAll(mediaDir, 0o775); err != nil {
			t.Fatalf("mkdir collection.media: %v", err)
		}
		sibling := newColFixtureAt(t, dir, "collection.anki2")
		probe := func() (*anki.MediaWriter, error) {
			return anki.NewMediaWriterForTest(mediaDir), nil
		}
		b := resolveAnkiBridge("", "", nil, probe)
		if b == nil {
			t.Fatal("auto-derive: bridge = nil, want non-nil (probe + sibling ok)")
		}
		if b.Writer == nil || b.Writer.Dir() != mediaDir {
			t.Errorf("Writer = %+v, want dir=%s", b.Writer, mediaDir)
		}
		if b.DB == nil {
			t.Fatal("DB = nil, want non-nil (auto-derived sibling opened)")
		} else {
			if got := b.DB.Path(); got != sibling {
				t.Errorf("DB.Path() = %q, want %q", got, sibling)
			}
			_ = b.DB.Close()
		}
		if !b.Enabled {
			t.Error("Enabled = false, want true (both halves wired via auto-derive)")
		}
	})

	t.Run("auto-derive: probe ok + NO collection.anki2 sibling disables bridge", func(t *testing.T) {
		dir := t.TempDir()
		mediaDir := filepath.Join(dir, "collection.media")
		if err := os.MkdirAll(mediaDir, 0o775); err != nil {
			t.Fatalf("mkdir collection.media: %v", err)
		}
		// No sibling file → AnkiDroid migrated to app-private storage.
		probe := func() (*anki.MediaWriter, error) {
			return anki.NewMediaWriterForTest(mediaDir), nil
		}
		log, logRead := newDiagForTest(t)
		b := resolveAnkiBridge("", "", log, probe)
		if b != nil {
			t.Errorf("bridge = %+v, want nil (no sibling collection.anki2)", b)
		}
		if !strings.Contains(logRead.String(), "no collection.anki2 next to media dir") {
			t.Errorf("diagnostic log missing sibling-missing line; got: %s", logRead.String())
		}
	})

	t.Run("auto-derive: probe fails disables bridge", func(t *testing.T) {
		probe := func() (*anki.MediaWriter, error) {
			return nil, errors.New("anki: no writable AnkiDroid collection.media candidate")
		}
		log, logRead := newDiagForTest(t)
		b := resolveAnkiBridge("", "", log, probe)
		if b != nil {
			t.Errorf("bridge = %+v, want nil (probe failed)", b)
		}
		if !strings.Contains(logRead.String(), "collection.media probe failed") {
			t.Errorf("diagnostic log missing probe-failed line; got: %s", logRead.String())
		}
	})

	t.Run("explicit override: temp collection.anki2 wins over probe", func(t *testing.T) {
		notesOnlyPath := newColFixtureForStatusTest(t)
		// Probe that would succeed, but the explicit override must
		// take the path verbatim and the bridge must wire DB on the
		// override, not the sibling of the probe's dir.
		probe := func() (*anki.MediaWriter, error) {
			return anki.NewMediaWriterForTest("/storage/emulated/0/AnkiDroid/collection.media"), nil
		}
		b := resolveAnkiBridge(notesOnlyPath, "", nil, probe)
		if b == nil {
			t.Fatal("explicit override: bridge = nil, want non-nil")
		}
		if b.DB == nil {
			t.Fatal("explicit override: DB = nil, want non-nil")
		}
		if got := b.DB.Path(); got != notesOnlyPath {
			t.Errorf("DB.Path() = %q, want override %q", got, notesOnlyPath)
		}
		// On non-Android the probe runs the production
		// ErrUnsupportedPlatform path through NewMediaWriter; with
		// our fake probe the Writer is the test-only helper, which
		// is non-nil here. The contract is just "override wins";
		// Writer shape is checked separately in TestAnkiStatusLine.
		_ = b.DB.Close()
	})

	t.Run("notes-only: explicit --anki-collection + non-Android probe", func(t *testing.T) {
		// Pins the v4.0 regression-Fix-1 panic class: Writer nil +
		// DB non-nil must stay "enabled notes-only" (not "disabled
		// bridge"). The fake probe here mimics what the real
		// production probe returns on Windows/macOS dev hosts —
		// a nil writer + ErrUnsupportedPlatform error which
		// resolveAnkiBridge must NOT log against the explicit
		// override path.
		notesOnlyPath := newColFixtureForStatusTest(t)
		probe := func() (*anki.MediaWriter, error) {
			return nil, anki.ErrUnsupportedPlatform
		}
		log, logRead := newDiagForTest(t)
		b := resolveAnkiBridge(notesOnlyPath, "", log, probe)
		if b == nil {
			t.Fatal("notes-only (explicit collection): bridge = nil, want non-nil")
		}
		if b.DB == nil {
			t.Error("notes-only: DB = nil, want non-nil (explicit --anki-collection)")
		}
		if b.Writer != nil {
			t.Errorf("notes-only on non-Android host: Writer = %+v, want nil", b.Writer)
		}
		if !b.Enabled {
			t.Error("notes-only: Enabled = false, want true (notes half is wired)")
		}
		if logRead.String() != "" {
			t.Errorf("explicit-override path must not log probe errors; got: %s", logRead.String())
		}
		_ = b.DB.Close()
	})

	t.Run("API key passthrough unchanged by v4.1", func(t *testing.T) {
		notesOnlyPath := newColFixtureForStatusTest(t)
		probe := func() (*anki.MediaWriter, error) {
			return nil, anki.ErrUnsupportedPlatform
		}
		b := resolveAnkiBridge(notesOnlyPath, "secret-key-xyz", nil, probe)
		if b == nil {
			t.Fatal("API key wiring: bridge = nil, want non-nil")
		}
		if b.APIKey != "secret-key-xyz" {
			t.Errorf("APIKey = %q, want %q", b.APIKey, "secret-key-xyz")
		}
		_ = b.DB.Close()
	})
}

// newColFixtureAt creates a minimal Anki collection.anki2 fixture
// (schema + a single col row) at <dir>/<name>. OpenCollection's
// schema detector only requires col/notes/cards to be present, so
// the empty JSON values in col.conf/models/decks/dconf/tags are
// fine — the test only reads DB.Path(). Returns the absolute path.
func newColFixtureAt(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	db, err := openSQLiteForStatusTest(path)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(schemaForStatusTest); err != nil {
		t.Fatalf("apply schema: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, 0, 0, 0, 11, 0, 0, 0, '{}', '{}', '{}', '{}', '{}')`); err != nil {
		t.Fatalf("seed col: %v", err)
	}
	return path
}

// newDiagForTest opens a diag.Logger backed by a t.TempDir log file
// and returns a wrapper whose String() reads back the written lines
// so tests can assert on the diagnostic output of resolveAnkiBridge.
// The returned *diag.Logger is the value to pass into the function
// under test; the *testDiagLog is the reader side. The Logger is
// closed via t.Cleanup so the temp file is released before TempDir
// removal.
func newDiagForTest(t *testing.T) (*diag.Logger, *testDiagLog) {
	t.Helper()
	dir := t.TempDir()
	l, err := diag.NewLogger(dir)
	if err != nil {
		t.Fatalf("diag.NewLogger: %v", err)
	}
	td := &testDiagLog{Logger: l, dir: dir}
	t.Cleanup(func() { _ = td.Close() })
	return l, td
}

// testDiagLog is a thin diag.Logger wrapper that exposes the
// accumulated log content via String(). The diag package never
// reads its own file back; we do, so a test can assert
// "the bridge logged the sibling-missing line" without exposing
// internals from the package.
type testDiagLog struct {
	*diag.Logger
	dir string
}

func (t *testDiagLog) String() string {
	b, err := os.ReadFile(filepath.Join(t.dir, "eizouden.log"))
	if err != nil {
		return ""
	}
	return string(b)
}

func TestStartServerCoreSuccess(t *testing.T) {
	cred, err := credential.NewDefaultStore()
	if err != nil {
		t.Skipf("credential store unavailable: %v", err)
	}
	cfg := serverConfig{
		bind: "127.0.0.1:0",
		cred: cred,
	}
	srv, ln, err := startServerCore(cfg)
	if err != nil {
		t.Fatalf("startServerCore: %v", err)
	}
	if srv == nil {
		t.Fatal("startServerCore returned nil server")
	}
	if ln == nil {
		t.Fatal("startServerCore returned nil listener")
	}
	ln.Close()
}

func TestStartServerCorePortInUse(t *testing.T) {
	cred, err := credential.NewDefaultStore()
	if err != nil {
		t.Skipf("credential store unavailable: %v", err)
	}
	// Bind a port first to occupy it.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	cfg := serverConfig{
		bind: ln.Addr().String(),
		cred: cred,
	}
	_, _, err = startServerCore(cfg)
	if err == nil {
		t.Fatal("startServerCore must fail when port is in use")
	}
	if !strings.Contains(err.Error(), "already in use") {
		t.Errorf("expected 'already in use' error, got: %v", err)
	}
}

func TestStartServerAutoReturnsPairingCode(t *testing.T) {
	cred, err := credential.NewDefaultStore()
	if err != nil {
		t.Skipf("credential store unavailable: %v", err)
	}
	cfg := serverConfig{
		bind: "127.0.0.1:0",
		cred: cred,
	}
	code, errCh, err := startServerAuto(cfg)
	if err != nil {
		t.Fatalf("startServerAuto: %v", err)
	}
	if code == "" {
		t.Fatal("startServerAuto returned empty pairing code")
	}
	if errCh == nil {
		t.Fatal("startServerAuto returned nil error channel")
	}
}

func TestStartServerAutoPortInUse(t *testing.T) {
	cred, err := credential.NewDefaultStore()
	if err != nil {
		t.Skipf("credential store unavailable: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	cfg := serverConfig{
		bind: ln.Addr().String(),
		cred: cred,
	}
	_, _, err = startServerAuto(cfg)
	if err == nil {
		t.Fatal("startServerAuto must fail when port is in use")
	}
}

// TestResolveYtdlp pins the yt-dlp helper resolution: an explicit --ytdlp
// always wins; an empty flag falls back to a PATH lookup; a failed lookup
// leaves the helper disabled (source-job endpoints stay off, as before).
func TestResolveYtdlp(t *testing.T) {
	cases := []struct {
		name     string
		explicit string
		found    string
		lookErr  error
		want     string
	}{
		{"explicit wins", "/opt/bin/yt-dlp", "/usr/bin/yt-dlp", nil, "/opt/bin/yt-dlp"},
		{"path fallback found", "", "/data/data/com.termux/files/usr/bin/yt-dlp", nil, "/data/data/com.termux/files/usr/bin/yt-dlp"},
		{"path fallback missing", "", "", errors.New("executable not found in PATH"), ""},
		{"both empty", "", "", nil, ""},
	}
	for _, c := range cases {
		got := resolveYtdlp(c.explicit, func(string) (string, error) { return c.found, c.lookErr })
		if got != c.want {
			t.Errorf("%s: resolveYtdlp = %q, want %q", c.name, got, c.want)
		}
	}
}
