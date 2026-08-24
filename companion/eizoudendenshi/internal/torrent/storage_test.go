package torrent

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anacrolix/torrent"
)

// Storage lifecycle tests: every torrent session gets its own private
// absolute storage dir (anacrolix piece-completion DB location), invalid
// paths fail closed, and the dir is removed after the session ends on every
// exit path. External/caller-provided roots are never removed.

// --- clientConfig contract (engine_anacrolix) ---

func TestClientConfigSetsAbsoluteDataDir(t *testing.T) {
	dir := t.TempDir()
	cfg, stor, err := clientConfig(dir)
	if err != nil {
		t.Fatalf("clientConfig: %v", err)
	}
	defer stor.Close()
	if cfg.DataDir == "" {
		t.Fatal("DataDir must not be empty")
	}
	if !filepath.IsAbs(cfg.DataDir) {
		t.Errorf("DataDir = %q, want absolute", cfg.DataDir)
	}
	if cfg.DataDir != filepath.Clean(dir) {
		t.Errorf("DataDir = %q, want %q", cfg.DataDir, filepath.Clean(dir))
	}
	// The explicit DefaultStorage (stremio-server-go pattern) must be set so
	// NewClient never falls back to the DataDir-only path (Ramdisk bolt DB
	// failure → download stall).
	if cfg.DefaultStorage == nil {
		t.Error("DefaultStorage must not be nil (explicit FileByInfoHash storage)")
	}
}

func TestClientConfigRejectsInvalidStorageDirs(t *testing.T) {
	fileDir := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(fileDir, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		dir  string
	}{
		{"empty", ""},
		{"relative", "relative/session-dir"},
		{"existing file", fileDir},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := clientConfig(tc.dir); err == nil {
				t.Errorf("clientConfig(%q) must fail closed, got nil error", tc.dir)
			}
		})
	}
}

func TestClientConfigCreatesMissingDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "session-dir")
	cfg, stor, err := clientConfig(dir)
	if err != nil {
		t.Fatalf("clientConfig: %v", err)
	}
	defer stor.Close()
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		t.Fatalf("storage dir not created: %v", err)
	}
	if cfg.DataDir != filepath.Clean(dir) {
		t.Errorf("DataDir = %q, want %q", cfg.DataDir, filepath.Clean(dir))
	}
}

// TestAnacrolixClientWritesPieceCompletionDBInDataDir proves with the real
// anacrolix client that the piece-completion DB is opened INSIDE the
// session DataDir (never the working directory). Uses the same loopback,
// no-DHT client settings as the engine tests so it is deterministic on
// Windows.
func TestAnacrolixClientWritesPieceCompletionDBInDataDir(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	before, _ := filepath.Glob(filepath.Join(cwd, ".torrent*"))
	dir := t.TempDir()

	cfg, stor, err := clientConfig(dir)
	if err != nil {
		t.Fatalf("clientConfig: %v", err)
	}
	// Test-only overrides: disable DHT/uTP so the client performs no
	// network activity and the test verifies deterministically that the
	// piece-completion DB lands in the session DataDir (and nowhere else).
	// Production clientConfig does not set these; the engine's normal
	// loopback behavior is unchanged.
	cfg.NoDHT = true
	cfg.DisableUTP = true
	cl, err := torrent.NewClient(cfg)
	if err != nil {
		t.Fatalf("anacrolix client: %v", err)
	}
	cl.Close()
	// The explicitly-provided DefaultStorage is owned by the caller —
	// release the bolt piece-completion DB before the TempDir cleanup.
	stor.Close()

	after, _ := filepath.Glob(filepath.Join(cwd, ".torrent*"))
	if len(after) > len(before) {
		t.Errorf("torrent state leaked into the working directory: %v", after)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read session dir: %v", err)
	}
	found := false
	for _, e := range entries {
		if len(e.Name()) >= len(".torrent") && e.Name()[:len(".torrent")] == ".torrent" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("no .torrent* state file inside the session dir; entries=%v", entryNames(entries))
	}
}

// --- Manager session storage lifecycle (fake engine) ---

// storageDirs is a mutex-guarded record of every storageDir a factory has
// received. The factory (run goroutine) appends; the test reads.
type storageDirs struct {
	mu   sync.Mutex
	dirs []string
}

func (s *storageDirs) add(dir string) {
	s.mu.Lock()
	s.dirs = append(s.dirs, dir)
	s.mu.Unlock()
}

func (s *storageDirs) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.dirs))
	copy(out, s.dirs)
	return out
}

func (s *storageDirs) waitFor(t *testing.T, n int) []string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := s.snapshot()
		if len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d storage dirs (have %d)", n, len(got))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// storageFactory returns an EngineFactory that records every storageDir it
// receives and delegates to newFakeEngine.
func storageFactory(t *testing.T) (EngineFactory, *storageDirs) {
	t.Helper()
	dirs := &storageDirs{}
	factory := func(dir string) (Engine, error) {
		dirs.add(dir)
		return newFakeEngine("media.mp4:6000"), nil
	}
	return factory, dirs
}

func waitForDirGone(t *testing.T, dir string) {
	t.Helper()
	// The storage dir is removed by the run() goroutine's cleanupSession
	// after context cancellation. On a loaded CI runner, goroutine scheduling
	// can be delayed; 10 seconds gives ample margin for eviction + cleanup.
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("storage dir still present after 10s: %s", dir)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestManagerStorageDirRemovedOnEngineFactoryFailure(t *testing.T) {
	factory := func(dir string) (Engine, error) {
		return nil, errInvalidMagnet
	}
	m, err := New(Config{
		EngineFactory: factory,
		Timeout:       10 * time.Second,
		// Hermetic root: this test asserts the root becomes empty, which
		// must never race the shared persistent default (real companion).
		StorageRoot: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	// Start creates the session dir, then the run goroutine's factory call
	// fails and must remove that dir (the engine was never created).
	if _, err := m.Start(testMagnet); err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		entries, _ := os.ReadDir(m.storageRoot)
		if len(entries) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("session dirs remain under root: %v", entryNames(entries))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestManagerStorageDirRemovedOnMetadataTimeout(t *testing.T) {
	engine := newFakeEngine("media.mp4:6000")
	engine.startDelay = 5 * time.Second // longer than the timeout
	dirs := &storageDirs{}
	factory := func(dir string) (Engine, error) {
		dirs.add(dir)
		return engine, nil
	}
	m, err := New(Config{EngineFactory: factory, Timeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	_ = snap
	got := dirs.waitFor(t, 1)
	waitForDirGone(t, got[0])
}

func TestManagerStorageDirRemovedOnNoVideo(t *testing.T) {
	engine := newFakeEngine("readme.txt:10|song.mp3:50") // no video entry
	dirs := &storageDirs{}
	factory := func(dir string) (Engine, error) {
		dirs.add(dir)
		return engine, nil
	}
	m, err := New(Config{EngineFactory: factory, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	if _, err := m.Start(testMagnet); err != nil {
		t.Fatalf("Start: %v", err)
	}
	got := dirs.waitFor(t, 1)
	waitForDirGone(t, got[0])
}

func TestManagerStorageDirRemovedOnCancel(t *testing.T) {
	dirs := &storageDirs{}
	factory := func(dir string) (Engine, error) {
		dirs.add(dir)
		return newFakeEngine("media.mp4:6000"), nil
	}
	m, err := New(Config{EngineFactory: factory, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	got := dirs.waitFor(t, 1)
	if _, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	waitForDirGone(t, got[0])
}

func TestManagerStorageDirRemovedOnEviction(t *testing.T) {
	dirs := &storageDirs{}
	factory := func(dir string) (Engine, error) {
		dirs.add(dir)
		return newFakeEngine("media.mp4:6000"), nil
	}
	m, err := New(Config{
		EngineFactory: factory,
		Timeout:       10 * time.Second,
		EvictedTTL:    5 * time.Second,
		// Hermetic root: this timing-sensitive eviction test must never race
		// the shared persistent default (real companion) under load.
		StorageRoot: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	s1, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 1: %v", err)
	}
	if _, err := m.Start(testMagnet); err != nil {
		t.Fatalf("Start 2: %v", err)
	}
	if _, err := m.Start(testMagnet); err != nil {
		t.Fatalf("Start 3: %v", err)
	}
	got := dirs.waitFor(t, 3)
	// The oldest session (s1) was evicted; its storage dir must be gone.
	_ = s1
	waitForDirGone(t, got[0])
}

func TestManagerStorageDirRemovedOnCompleteCancel(t *testing.T) {
	engine := newFakeEngine("media.mp4:100")
	dirs := &storageDirs{}
	factory := func(dir string) (Engine, error) {
		dirs.add(dir)
		return engine, nil
	}
	m, err := New(Config{EngineFactory: factory, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	snap, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	got := dirs.waitFor(t, 1)
	// The factory has been invoked, but the fake engine's handle is set
	// INSIDE Start() — the factory-return → Start gap is a timing window
	// that becomes visible under -race. Poll until the handle exists so
	// the test is deterministic.
	var h *fakeHandle
	deadline := time.Now().Add(5 * time.Second)
	for {
		engine.mu.Lock()
		h = engine.h
		engine.mu.Unlock()
		if h != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fake handle not created")
		}
		time.Sleep(2 * time.Millisecond)
	}
	if _, err := m.Select(snap.ID, "f0", ""); err != nil {
		t.Fatalf("Select: %v", err)
	}
	h.avail.Store(h.files[0].Length)
	waitForState(t, m, snap.ID, StateComplete, 3*time.Second)
	if _, err := m.Cancel(snap.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	waitForDirGone(t, got[0])
}

func TestManagerSessionsHaveDistinctStorageDirs(t *testing.T) {
	dirs := &storageDirs{}
	factory := func(dir string) (Engine, error) {
		dirs.add(dir)
		return newFakeEngine("media.mp4:6000"), nil
	}
	m, err := New(Config{EngineFactory: factory, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	s1, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 1: %v", err)
	}
	s2, err := m.Start(testMagnet)
	if err != nil {
		t.Fatalf("Start 2: %v", err)
	}
	got := dirs.waitFor(t, 2)
	if got[0] == "" || got[1] == "" {
		t.Fatalf("session storage dirs must be non-empty: %v", got)
	}
	if got[0] == got[1] {
		t.Fatalf("concurrent sessions must not share a storage dir: %v", got)
	}
	if !filepath.IsAbs(got[0]) || !filepath.IsAbs(got[1]) {
		t.Fatalf("session storage dirs must be absolute: %v", got)
	}
	_, _ = m.Cancel(s1.ID)
	_, _ = m.Cancel(s2.ID)
}

// TestManagerStorageRootPersistsOnClose: neither the default persistent
// root nor a caller-provided root is removed wholesale on Close — only the
// per-session subdirectories the Manager creates are (plus leftover
// session-* dirs via CleanupStaleSessions).
func TestManagerStorageRootPersistsOnClose(t *testing.T) {
	t.Run("default root is the persistent data dir", func(t *testing.T) {
		factory, _ := storageFactory(t)
		m, err := New(Config{EngineFactory: factory, Timeout: 10 * time.Second})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		root := m.storageRoot
		if root == "" {
			t.Fatal("default storage root must be set")
		}
		if !filepath.IsAbs(root) {
			t.Errorf("default storage root must be absolute: %q", root)
		}
		// The default root must NOT resolve under the OS temp dir — a
		// Ramdisk temp (e.g. A:\Temp) breaks bbolt piece-completion (mmap)
		// and stalls the download.
		if strings.HasPrefix(filepath.Clean(root), filepath.Clean(os.TempDir())) {
			t.Errorf("default storage root must not be under the OS temp dir: %q", root)
		}
		if !strings.HasSuffix(root, "torrent-sessions") {
			t.Errorf("default storage root must end with torrent-sessions: %q", root)
		}
		if err := m.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
		// The persistent root survives Close (only session subdirs go).
		if _, err := os.Stat(root); os.IsNotExist(err) {
			t.Errorf("default storage root must persist on Close: %q", root)
		}
	})

	t.Run("caller root survives close", func(t *testing.T) {
		root := t.TempDir()
		factory, dirs := storageFactory(t)
		m, err := New(Config{EngineFactory: factory, Timeout: 10 * time.Second, StorageRoot: root})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if _, err := m.Start(testMagnet); err != nil {
			t.Fatalf("Start: %v", err)
		}
		got := dirs.waitFor(t, 1)
		if err := m.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
		if _, err := os.Stat(root); err != nil {
			t.Errorf("caller-provided storage root must survive Close: %v", err)
		}
		if _, err := os.Stat(got[0]); !os.IsNotExist(err) {
			t.Errorf("session dir must be removed even under a caller root, stat err=%v", err)
		}
	})
}

// TestDefaultStorageRootResolver pins the platform mapping of the default
// per-session storage root (mirror of diag.DefaultDir, with a
// "torrent-sessions" leaf and never the OS temp dir).
func TestDefaultStorageRootResolver(t *testing.T) {
	root, err := defaultStorageRoot()
	if err != nil {
		t.Fatalf("defaultStorageRoot: %v", err)
	}
	if root == "" || !filepath.IsAbs(root) {
		t.Fatalf("defaultStorageRoot = %q, want non-empty absolute", root)
	}
	if !strings.HasSuffix(root, filepath.Join("torrent-sessions")) {
		t.Errorf("defaultStorageRoot = %q, want .../torrent-sessions", root)
	}
	// The OS temp dir (Ramdisk hazard) must never be the chosen base.
	if strings.HasPrefix(filepath.Clean(root), filepath.Clean(os.TempDir())) {
		t.Errorf("defaultStorageRoot must not be under the OS temp dir: %q", root)
	}
}

func entryNames(entries []os.DirEntry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Name()
	}
	return out
}
