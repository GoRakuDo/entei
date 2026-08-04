package torrent

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anacrolix/dht/v2"
	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"

	"eizoudendenshi/internal/diag"
)

// TestClientConfigBindsAllInterfaces pins the peer-transport root-cause
// fix: clientConfig must leave ListenHost at the anacrolix default (empty =
// all interfaces) so the uTP socket / DHT server / TCP listeners — which
// anacrolix also uses for OUTGOING dials — can reach udp trackers, the DHT
// and uTP peers. A loopback ListenHost silently killed all UDP-based
// transports (DHT queries, uTP peer connections, udp tracker announces),
// leaving only HTTP trackers and TCP peers alive, which made metadata
// fetch impossible for udp-tracker magnets (e.g. nyaa).
//
// The security boundary is asserted too: random port, no seeding, no
// upload — the transport is open, but the client never publishes or
// uploads anything.
func TestClientConfigBindsAllInterfaces(t *testing.T) {
	cfg, err := clientConfig(t.TempDir())
	if err != nil {
		t.Fatalf("clientConfig: %v", err)
	}
	if cfg.ListenHost == nil {
		t.Fatal("ListenHost must be the default (non-nil) function")
	}
	// The anacrolix default ListenHost returns "" = bind all interfaces.
	if got := cfg.ListenHost("tcp4"); got != "" {
		t.Errorf("ListenHost(\"tcp4\") = %q, want \"\" (all interfaces)", got)
	}
	if cfg.ListenPort != 0 {
		t.Errorf("ListenPort = %d, want 0 (random ephemeral)", cfg.ListenPort)
	}
	if cfg.Seed {
		t.Error("Seed must stay false (no seeding)")
	}
	if !cfg.NoUpload {
		t.Error("NoUpload must stay true (never upload)")
	}

	cl, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { cl.Close() })

	listeners := cl.Listeners()
	if len(listeners) == 0 {
		t.Fatal("no listeners bound")
	}
	for _, l := range listeners {
		addr := l.Addr().String()
		t.Logf("peer transport listener: %s", addr)
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			t.Fatalf("listener addr %q: %v", addr, err)
		}
		ip := net.ParseIP(host)
		if host == "127.0.0.1" || host == "::1" || host == "localhost" {
			t.Errorf("listener %s is loopback; peer transport must bind all interfaces", addr)
		}
		if ip != nil && ip.IsLoopback() {
			t.Errorf("listener %s resolves to a loopback IP; peer transport must bind all interfaces", addr)
		}
	}
	// Also via ListenAddrs (the public client view).
	for _, a := range cl.ListenAddrs() {
		t.Logf("ListenAddrs entry: %s", a)
	}

	// The DHT servers must exist and their Stats() must be the
	// dht.ServerStats shape the diagnostics read (node counts).
	if len(cl.DhtServers()) == 0 {
		t.Error("expected at least one DHT server (transport open)")
	}
	for _, ds := range cl.DhtServers() {
		st := ds.Stats()
		ss, ok := st.(dht.ServerStats)
		if !ok {
			t.Errorf("DhtServer.Stats() type = %T, want dht.ServerStats", st)
			continue
		}
		if ss.Nodes < 0 || ss.GoodNodes < 0 || ss.OutboundQueriesAttempted < 0 {
			t.Errorf("negative DHT stats: %+v", ss)
		}
	}
}

// TestEngineDiagnosticsLogSanitized runs the engine's diagnostics once
// against a real anacrolix client + local torrent and verifies the log
// line carries counts only — no magnet, no tracker, no infohash, no path.
func TestEngineDiagnosticsLogSanitized(t *testing.T) {
	base := t.TempDir()
	logDir := filepath.Join(base, "logs")
	logger, err := diag.NewLogger(logDir)
	if err != nil {
		t.Fatalf("diag.NewLogger: %v", err)
	}
	defer logger.Close()

	storageDir := filepath.Join(base, "storage")
	eng, err := NewAnacrolixEngine(storageDir)
	if err != nil {
		t.Fatalf("NewAnacrolixEngine: %v", err)
	}
	defer eng.Close()
	an := eng.(*engineAnacrolix)
	an.SetLogger(logger)

	info := &metainfo.Info{
		Name:        "Movie.2026.mkv",
		PieceLength: 16384,
		Length:      1024,
	}
	info.Pieces = make([]byte, 20)
	ib, err := bencode.Marshal(info)
	if err != nil {
		t.Fatalf("marshal info: %v", err)
	}
	tt, err := an.client.AddTorrent(&metainfo.MetaInfo{InfoBytes: ib})
	if err != nil {
		t.Fatalf("add torrent: %v", err)
	}
	<-tt.GotInfo()

	an.diag(tt)

	raw, err := os.ReadFile(filepath.Join(logDir, "eizouden.log"))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	s := string(raw)
	t.Logf("diag log:\n%s", s)
	if !strings.Contains(s, "[INFO] torrent.engine: diag peers=") {
		t.Errorf("missing sanitized diag line:\n%s", s)
	}
	// The piece-completion and byte counters must be present too: complete
	// over total pieces and bytes_read (counts only, same redaction
	// contract). The exact values depend on the local torrent state, so
	// only the presence of the fields is pinned.
	if !strings.Contains(s, "complete=0/1 bytes_read=") {
		t.Errorf("missing piece/byte diagnostics in diag line:\n%s", s)
	}
	for _, forbidden := range []string{
		"Movie.2026.mkv", // torrent name / path
		"magnet:",        // magnet URI
		"infohash=",      // the diag line must not carry an infohash at all
		base,             // storage + log paths
	} {
		if strings.Contains(s, forbidden) {
			t.Errorf("diag log leaked %q:\n%s", forbidden, s)
		}
	}
}

// TestEngineCloseRaceWithDiagnostics pins the engine-level client guard:
// diag() (the diagnostics path, normally driven by diagLoop) must be safe
// to call concurrently with Close() — the client is captured under the
// engine lock, and a closed engine skips the line instead of dereferencing
// nil. This test fails under -race if the guard regresses.
func TestEngineCloseRaceWithDiagnostics(t *testing.T) {
	eng, err := NewAnacrolixEngine(t.TempDir())
	if err != nil {
		t.Fatalf("NewAnacrolixEngine: %v", err)
	}
	an := eng.(*engineAnacrolix)

	info := &metainfo.Info{Name: "race.mkv", PieceLength: 16384, Length: 1024}
	info.Pieces = make([]byte, 20)
	ib, err := bencode.Marshal(info)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	tt, err := an.client.AddTorrent(&metainfo.MetaInfo{InfoBytes: ib})
	if err != nil {
		t.Fatalf("add torrent: %v", err)
	}
	<-tt.GotInfo()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			an.diag(tt)
		}
	}()
	// Give the diagnostics goroutine a head start, then close concurrently.
	time.Sleep(time.Millisecond)
	if err := eng.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	wg.Wait()
	// After Close the engine is inert: diag must be a no-op, not a panic.
	an.diag(tt)
}
