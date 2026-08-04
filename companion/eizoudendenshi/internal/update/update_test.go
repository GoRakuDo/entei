package update

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeMinisignSrc is a tiny verifier stand-in: `-v` answers with a
// configurable version banner (default 0.12); the verify invocation
// succeeds only when FAKE_MINISIGN_OK=1. The real release binaries use
// the real Minisign 0.12 (see verify.go); the fake only exercises the
// updater's wiring.
const fakeMinisignSrc = `package main

import (
	"os"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "-v" {
		v := os.Getenv("FAKE_MINISIGN_VER")
		if v == "" {
			v = "0.12"
		}
		println("minisign " + v)
		return
	}
	if os.Getenv("FAKE_MINISIGN_OK") == "1" {
		return
	}
	os.Exit(1)
}
`

var fakeMinisignPath string

func TestMain(m *testing.M) {
	// Windows real self-replacement test (TestSpawnApplyWindowsRealSelfReplace):
	// the real spawnApply launches the apply child from a COPY of this test
	// binary. When EIZOUDEN_TEST_APPLY_CHILD is set (only by that test), the
	// test binary dispatches the updater's internal child modes instead of
	// running the test suite — normal test runs and the production binary
	// (cmd/eizouden) are unaffected.
	if os.Getenv("EIZOUDEN_TEST_APPLY_CHILD") == "1" && len(os.Args) > 1 {
		switch os.Args[1] {
		case "apply-update":
			// Real apply child: record the executable this child runs from
			// (evidence that it is a %TEMP% copy, never the running exe),
			// then run the REAL ApplyStaged.
			if log := os.Getenv("EIZOUDEN_TEST_CHILD_LOG"); log != "" {
				if exe, err := os.Executable(); err == nil {
					_ = os.WriteFile(log, []byte(exe), 0o600)
				}
			}
			os.Exit(ApplyStaged(os.Args[2:]))
		case "apply-driver":
			// Short-lived driver: calls the REAL spawnApply (which copies
			// this executable to the OS temp dir and starts the apply
			// child) and exits immediately, so the apply child sees a dead
			// parent and starts replacing right away.
			if len(os.Args) < 4 {
				os.Exit(1)
			}
			if err := spawnApply(os.Args[2], &applyPlan{Core: os.Args[3]}); err != nil {
				os.Exit(1)
			}
			os.Exit(0)
		case "cli":
			// The staged fake core relaunched by ApplyStaged: exit
			// immediately instead of running the test suite.
			os.Exit(0)
		}
	}
	dir, err := os.MkdirTemp("", "eizouden-update-fake-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)
	src := filepath.Join(dir, "main.go")
	if err := os.WriteFile(src, []byte(fakeMinisignSrc), 0o600); err != nil {
		panic(err)
	}
	exe := filepath.Join(dir, "minisign")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	out, err := exec.Command("go", "build", "-o", exe, src).CombinedOutput()
	if err != nil {
		panic("fake minisign build failed: " + string(out))
	}
	fakeMinisignPath = exe
	os.Exit(m.Run())
}

// testKey is a valid-shaped Minisign public key used to stand in for the
// pinned release key in tests (the real key is injected at release time).
const testKey = "RWTQYXX35SPmSGxO2EUXXGCHfIV6EapS6rRRPvkVALs5zl9yE1qMMrWf"

// installFakeVerifier plants the fake minisign at
// <installRoot>/tools/minisign[.exe] (the Windows install-root location).
func installFakeVerifier(t *testing.T, installRoot string) {
	t.Helper()
	tools := filepath.Join(installRoot, "tools")
	if err := os.MkdirAll(tools, 0o700); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(fakeMinisignPath)
	if err != nil {
		t.Fatal(err)
	}
	name := "minisign"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := os.WriteFile(filepath.Join(tools, name), b, 0o700); err != nil {
		t.Fatal(err)
	}
}

func pinTestKey(t *testing.T) {
	t.Helper()
	orig := PinnedPublicKey
	PinnedPublicKey = testKey
	t.Cleanup(func() { PinnedPublicKey = orig })
}

func shaOf(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// feedRT is a fake HTTP transport serving the release feed (exact URL),
// files by URL basename, and optional redirects for specific basenames.
type feedRT struct {
	apiBody   []byte
	files     map[string][]byte
	redirects map[string]string // basename -> redirect Location
	apiCalls  int
}

func (rt *feedRT) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.String() == releaseAPI {
		rt.apiCalls++
		return rt.respond(http.StatusOK, rt.apiBody)
	}
	name := path.Base(req.URL.Path)
	if loc, ok := rt.redirects[name]; ok {
		h := http.Header{}
		h.Set("Location", loc)
		return &http.Response{StatusCode: http.StatusFound, Header: h, Request: req,
			Body: io.NopCloser(strings.NewReader(""))}, nil
	}
	b, ok := rt.files[name]
	if !ok {
		return &http.Response{StatusCode: http.StatusNotFound, Request: req,
			Body: io.NopCloser(strings.NewReader(""))}, nil
	}
	return rt.respond(http.StatusOK, b)
}

func (rt *feedRT) respond(code int, b []byte) (*http.Response, error) {
	return &http.Response{StatusCode: code, Request: &http.Request{},
		Body: io.NopCloser(bytes.NewReader(b))}, nil
}

func (rt *feedRT) client() *http.Client {
	c := newHardenedClient()
	c.Transport = rt
	return c
}

// releaseEntry is one feed entry builder.
type releaseEntry struct {
	tag     string
	draft   bool
	pubTime string
	assets  map[string]string // name -> browser_download_url
}

func feedBody(entries ...releaseEntry) []byte {
	type assetJSON struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	}
	type releaseJSON struct {
		TagName     string      `json:"tag_name"`
		Draft       bool        `json:"draft"`
		PublishedAt string      `json:"published_at"`
		Assets      []assetJSON `json:"assets"`
	}
	var out []releaseJSON
	for _, e := range entries {
		r := releaseJSON{TagName: e.tag, Draft: e.draft, PublishedAt: e.pubTime}
		for name, url := range e.assets {
			r.Assets = append(r.Assets, assetJSON{Name: name, BrowserDownloadURL: url})
		}
		out = append(out, r)
	}
	b, _ := json.Marshal(out)
	return b
}

func releaseAssetURL(version, name string) string {
	return "https://example.invalid/releases/download/eizoudendenshi-v" + version + "/" + name
}

// assetMap converts a name->URL map into the Release.Assets shape.
func assetMap(m map[string]string) map[string]Asset {
	out := make(map[string]Asset, len(m))
	for name, url := range m {
		out[name] = Asset{Name: name, URL: url}
	}
	return out
}

func windowsReleaseAssets() map[string]string {
	out := map[string]string{}
	for _, n := range []string{
		"eizouden-manifest.json", "eizouden-manifest.json.minisig",
		coreWindowsName, coreWindowsName + ".minisig",
		"yt-dlp-windows-amd64.exe", "yt-dlp-windows-amd64.exe.minisig",
		"ffmpeg-windows-amd64.zip", "ffmpeg-windows-amd64.zip.minisig",
	} {
		out[n] = releaseAssetURL("0.2.0-rc.22", n)
	}
	return out
}

// windowsManifestJSON builds a v3 helper-enabled Windows manifest whose
// artifact SHA-256 values match the given file bytes.
func windowsManifestJSON(t *testing.T, version string, core, ytdlp, ffmpegZip []byte) []byte {
	t.Helper()
	m := manifest{
		Format:        "eizoudendenshi-release-manifest",
		FormatVersion: 1,
		Version:       version,
	}
	m.HelperContract.Version = 3
	m.HelperContract.Helpers = map[string]helperSpec{
		"yt-dlp": {Required: true, Version: "2026.07.04", Artifact: "yt-dlp-windows-amd64.exe"},
		"ffmpeg": {Required: false, Version: "2026-07-27", Artifact: "ffmpeg-windows-amd64.zip",
			Archive: true, ExpectedFile: "ffmpeg.exe"},
	}
	m.Artifacts = []artifact{
		{Name: coreWindowsName, Target: windowsTarget, SHA256: shaOf(core)},
		{Name: "yt-dlp-windows-amd64.exe", Target: windowsTarget, SHA256: shaOf(ytdlp)},
		{Name: "ffmpeg-windows-amd64.zip", Target: windowsTarget, SHA256: shaOf(ffmpegZip)},
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func makeZip(t *testing.T, member string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create(member)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// --- release selection ------------------------------------------------------

func TestSelectReleaseChoosesNewestPrereleaseByPublishedAt(t *testing.T) {
	rt := &feedRT{apiBody: feedBody(
		releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.22", pubTime: "2026-08-03T22:46:29Z",
			assets: map[string]string{"a": releaseAssetURL("0.2.0-rc.22", "a")}},
		releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.21", pubTime: "2026-08-03T16:12:43Z",
			assets: map[string]string{"a": releaseAssetURL("0.2.0-rc.21", "a")}},
		// Newest but a DRAFT: must never be chosen.
		releaseEntry{tag: "eizoudendenshi-v9.9.9-rc.99", draft: true, pubTime: "2026-08-04T00:00:00Z",
			assets: map[string]string{"a": releaseAssetURL("9.9.9-rc.99", "a")}},
		// Newest but a different tag prefix: ignored.
		releaseEntry{tag: "other-v10.0.0", pubTime: "2026-08-05T00:00:00Z",
			assets: map[string]string{"a": "https://example.invalid/x"}},
	)}
	rel, err := selectRelease(rt.client())
	if err != nil {
		t.Fatalf("selectRelease: %v", err)
	}
	if rel.Tag != "eizoudendenshi-v0.2.0-rc.22" {
		t.Fatalf("chosen tag = %q, want the newest prerelease by published_at", rel.Tag)
	}
	if rel.Version != "0.2.0-rc.22" {
		t.Fatalf("version = %q, want the tag suffix", rel.Version)
	}
}

func TestSelectReleaseSkipsPoisonedNewest(t *testing.T) {
	t.Run("unsafe asset name", func(t *testing.T) {
		rt := &feedRT{apiBody: feedBody(
			releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.22", pubTime: "2026-08-03T22:46:29Z",
				assets: map[string]string{"..\\evil": "https://example.invalid/evil"}},
			releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.21", pubTime: "2026-08-03T16:12:43Z",
				assets: map[string]string{"a": releaseAssetURL("0.2.0-rc.21", "a")}},
		)}
		rel, err := selectRelease(rt.client())
		if err != nil {
			t.Fatalf("selectRelease: %v", err)
		}
		if rel.Tag != "eizoudendenshi-v0.2.0-rc.21" {
			t.Fatalf("chosen tag = %q, want the next-newest valid release", rel.Tag)
		}
	})
	t.Run("duplicate asset name", func(t *testing.T) {
		rt := &feedRT{apiBody: []byte(`[` +
			`{"tag_name":"eizoudendenshi-v0.2.0-rc.22","draft":false,"published_at":"2026-08-03T22:46:29Z",` +
			`"assets":[{"name":"a","browser_download_url":"https://example.invalid/a"},` +
			`{"name":"a","browser_download_url":"https://example.invalid/b"}]},` +
			`{"tag_name":"eizoudendenshi-v0.2.0-rc.21","draft":false,"published_at":"2026-08-03T16:12:43Z",` +
			`"assets":[{"name":"a","browser_download_url":"https://example.invalid/a"}]}]`)}
		rel, err := selectRelease(rt.client())
		if err != nil {
			t.Fatalf("selectRelease: %v", err)
		}
		if rel.Tag != "eizoudendenshi-v0.2.0-rc.21" {
			t.Fatalf("chosen tag = %q, want the next-newest valid release", rel.Tag)
		}
	})
	t.Run("non-HTTPS asset URL", func(t *testing.T) {
		rt := &feedRT{apiBody: feedBody(
			releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.22", pubTime: "2026-08-03T22:46:29Z",
				assets: map[string]string{"a": "http://example.invalid/a"}},
			releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.21", pubTime: "2026-08-03T16:12:43Z",
				assets: map[string]string{"a": releaseAssetURL("0.2.0-rc.21", "a")}},
		)}
		rel, err := selectRelease(rt.client())
		if err != nil {
			t.Fatalf("selectRelease: %v", err)
		}
		if rel.Tag != "eizoudendenshi-v0.2.0-rc.21" {
			t.Fatalf("chosen tag = %q, want the next-newest valid release", rel.Tag)
		}
	})
}

func TestSelectReleaseAllPoisonedFailsClosed(t *testing.T) {
	rt := &feedRT{apiBody: feedBody(
		releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.22", pubTime: "2026-08-03T22:46:29Z",
			assets: map[string]string{"..\\evil": "https://example.invalid/evil"}},
	)}
	if _, err := selectRelease(rt.client()); err == nil {
		t.Fatal("selectRelease must fail closed when every candidate is poisoned")
	}
}

func TestSelectReleaseNoMatchFailsClosed(t *testing.T) {
	rt := &feedRT{apiBody: feedBody(
		releaseEntry{tag: "unrelated-v1.0.0", pubTime: "2026-08-03T22:46:29Z",
			assets: map[string]string{"a": "https://example.invalid/a"}},
		releaseEntry{tag: "eizoudendenshi-vnot-semver", pubTime: "2026-08-03T22:46:29Z",
			assets: map[string]string{"a": "https://example.invalid/a"}},
	)}
	if _, err := selectRelease(rt.client()); err == nil {
		t.Fatal("selectRelease must fail closed without a matching release")
	}
}

// --- Run flows ---------------------------------------------------------------

func TestRunPlaceholderKeyFailsClosedWithoutNetwork(t *testing.T) {
	// The package default is the placeholder; ensure it explicitly.
	PinnedPublicKey = "REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY"
	defer func() { PinnedPublicKey = testKey }()
	rt := &feedRT{apiBody: feedBody()}
	var out bytes.Buffer
	ok := Run(&out, Config{Version: "0.2.0-rc.20", InstallRoot: t.TempDir(), Client: rt.client()})
	if ok {
		t.Fatal("placeholder key must never update")
	}
	if !strings.Contains(out.String(), "update: updater unavailable") {
		t.Fatalf("output = %q, want the updater unavailable status", out.String())
	}
	if rt.apiCalls != 0 {
		t.Fatalf("placeholder key must fail closed BEFORE any network access (apiCalls = %d)", rt.apiCalls)
	}
}

func TestRunBadVerifierFailsClosed(t *testing.T) {
	pinTestKey(t)
	t.Setenv("FAKE_MINISIGN_VER", "0.9") // installed verifier fails the version check
	root := t.TempDir()
	installFakeVerifier(t, root)
	rt := &feedRT{apiBody: feedBody()}
	var out bytes.Buffer
	ok := Run(&out, Config{Version: "0.2.0-rc.20", InstallRoot: root, Client: rt.client()})
	if ok {
		t.Fatal("a verifier that fails the version check must never update")
	}
	if !strings.Contains(out.String(), "update: updater unavailable") {
		t.Fatalf("output = %q, want the updater unavailable status", out.String())
	}
	if rt.apiCalls != 0 {
		t.Fatalf("bad verifier must fail closed BEFORE any network access (apiCalls = %d)", rt.apiCalls)
	}
}

func TestRunAlreadyUpToDate(t *testing.T) {
	pinTestKey(t)
	root := t.TempDir()
	installFakeVerifier(t, root)
	rt := &feedRT{apiBody: feedBody(
		releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.22", pubTime: "2026-08-03T22:46:29Z",
			assets: windowsReleaseAssets()},
	)}
	spawned := false
	origSpawn := spawnApply
	spawnApply = func(string, *applyPlan) error { spawned = true; return nil }
	defer func() { spawnApply = origSpawn }()
	var out bytes.Buffer
	ok := Run(&out, Config{Version: "0.2.0-rc.22", InstallRoot: root, Client: rt.client()})
	if ok {
		t.Fatal("Run must stay in the menu when already up to date")
	}
	if !strings.Contains(out.String(), "update: already up to date (v0.2.0-rc.22)") {
		t.Fatalf("output = %q, want the already-up-to-date status", out.String())
	}
	if spawned {
		t.Fatal("no apply child may be spawned when already up to date")
	}
}

func TestRunEndToEndWindowsStagesVerifiedArtifacts(t *testing.T) {
	pinTestKey(t)
	t.Setenv("FAKE_MINISIGN_OK", "1")
	root := t.TempDir()
	installFakeVerifier(t, root)

	core := []byte("fake-core-v22")
	ytdlp := []byte("fake-ytdlp-v22")
	ffmpegMember := []byte("fake-ffmpeg-member")
	ffmpegZip := makeZip(t, "ffmpeg.exe", ffmpegMember)
	manifest := windowsManifestJSON(t, "0.2.0-rc.22", core, ytdlp, ffmpegZip)

	rt := &feedRT{
		apiBody: feedBody(
			releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.22", pubTime: "2026-08-03T22:46:29Z",
				assets: windowsReleaseAssets()},
		),
		files: map[string][]byte{
			"eizouden-manifest.json":           manifest,
			"eizouden-manifest.json.minisig":   []byte("sig"),
			coreWindowsName:                    core,
			coreWindowsName + ".minisig":       []byte("sig"),
			"yt-dlp-windows-amd64.exe":         ytdlp,
			"yt-dlp-windows-amd64.exe.minisig": []byte("sig"),
			"ffmpeg-windows-amd64.zip":         ffmpegZip,
			"ffmpeg-windows-amd64.zip.minisig": []byte("sig"),
		},
	}

	var gotStaging string
	var gotPlan *applyPlan
	origSpawn := spawnApply
	spawnApply = func(staging string, plan *applyPlan) error {
		gotStaging, gotPlan = staging, plan
		return nil
	}
	defer func() { spawnApply = origSpawn }()

	var out bytes.Buffer
	ok := Run(&out, Config{Version: "0.2.0-rc.20", InstallRoot: root, Client: rt.client()})
	if !ok {
		t.Fatalf("Run must exit for the restart; output = %q", out.String())
	}
	if !strings.Contains(out.String(), "update: verified and restarting...") {
		t.Fatalf("output = %q, want the verified-and-restarting status", out.String())
	}
	if gotPlan == nil {
		t.Fatal("spawnApply was not called with a plan")
	}
	// Plan targets preserve the bootstrap helper layout.
	want := func(p string) string { return filepath.Join(root, p) }
	if gotPlan.Core != want(coreWindowsName) {
		t.Errorf("core target = %q, want %q", gotPlan.Core, want(coreWindowsName))
	}
	if gotPlan.Ytdlp != want(filepath.Join("helpers", "yt-dlp-windows-amd64.exe")) {
		t.Errorf("yt-dlp target = %q", gotPlan.Ytdlp)
	}
	if gotPlan.Ffmpeg != want(filepath.Join("helpers", "ffmpeg.exe")) {
		t.Errorf("ffmpeg target = %q", gotPlan.Ffmpeg)
	}
	// Files apply helpers first, core last.
	if len(gotPlan.Files) != 3 || gotPlan.Files[2].StagedName != coreWindowsName {
		t.Errorf("apply order must end with the core: %+v", gotPlan.Files)
	}
	// Staging holds verified content only.
	for name, content := range map[string]string{
		coreWindowsName:            string(core),
		"yt-dlp-windows-amd64.exe": string(ytdlp),
		"ffmpeg.exe":               string(ffmpegMember),
	} {
		b, err := os.ReadFile(filepath.Join(gotStaging, name))
		if err != nil {
			t.Fatalf("staged %s: %v", name, err)
		}
		if string(b) != content {
			t.Errorf("staged %s = %q, want %q", name, b, content)
		}
	}
	if _, err := os.Stat(filepath.Join(gotStaging, "ffmpeg-windows-amd64.zip")); !os.IsNotExist(err) {
		t.Error("verified zip must be removed after extraction")
	}
	// The staging dir must NOT be removed by the parent (the child owns it).
	if _, err := os.Stat(gotStaging); err != nil {
		t.Fatalf("staging dir must survive until the child applies: %v", err)
	}
	// Staging lives on the SAME drive as the install target
	// (filepath.Dir(plan.Core) == installRoot): the apply child's final
	// rename must stay inside one filesystem, or a cross-device failure
	// (ERROR_NOT_SAME_DEVICE) needs the copy fallback. Same-drive
	// staging avoids the failure mode entirely.
	if filepath.Dir(gotStaging) != filepath.Dir(gotPlan.Core) {
		t.Errorf("staging dir %q must be created under the core target dir %q",
			gotStaging, filepath.Dir(gotPlan.Core))
	}
	// Privacy regression guard: no URLs, keys, local paths, or internal
	// mode names in the status output.
	for _, leak := range []string{"https://", "example.invalid", root, "RW", "apply-update", "minisign"} {
		if strings.Contains(out.String(), leak) {
			t.Errorf("status output leaked %q: %q", leak, out.String())
		}
	}
}

func TestRunManifestVersionMismatchFailsClosed(t *testing.T) {
	pinTestKey(t)
	t.Setenv("FAKE_MINISIGN_OK", "1")
	root := t.TempDir()
	installFakeVerifier(t, root)

	core := []byte("fake-core")
	ffmpegZip := makeZip(t, "ffmpeg.exe", []byte("member"))
	// Manifest says rc.21 while the release tag says rc.22.
	manifest := windowsManifestJSON(t, "0.2.0-rc.21", core, []byte("yt"), ffmpegZip)
	rt := &feedRT{
		apiBody: feedBody(
			releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.22", pubTime: "2026-08-03T22:46:29Z",
				assets: windowsReleaseAssets()},
		),
		files: map[string][]byte{
			"eizouden-manifest.json": manifest, "eizouden-manifest.json.minisig": []byte("sig"),
		},
	}
	spawned := false
	origSpawn := spawnApply
	spawnApply = func(string, *applyPlan) error { spawned = true; return nil }
	defer func() { spawnApply = origSpawn }()
	var out bytes.Buffer
	ok := Run(&out, Config{Version: "0.2.0-rc.20", InstallRoot: root, Client: rt.client()})
	if ok {
		t.Fatal("manifest/tag version mismatch must fail closed")
	}
	if spawned {
		t.Fatal("no apply child may be spawned on a mismatched release")
	}
	if !strings.Contains(out.String(), "update: release verification failed") {
		t.Fatalf("output = %q, want the generic verification failure", out.String())
	}
}

// TestStagingBasePinsInstallRoot pins the staging placement: staging is
// created under the install root (== filepath.Dir(plan.Core)), an
// existing directory resolves to itself (absolutized), and a missing or
// empty root falls back to the OS temp dir (empty string), so a bad
// install root can never fail the update on staging creation.
func TestStagingBasePinsInstallRoot(t *testing.T) {
	root := t.TempDir()
	if got := stagingBase(root); got != root {
		t.Errorf("stagingBase(%q) = %q, want the install root itself", root, got)
	}
	// filepath.Dir of the plan core target is the same directory.
	core := filepath.Join(root, coreWindowsName)
	if got := stagingBase(filepath.Dir(core)); got != filepath.Dir(core) {
		t.Errorf("stagingBase(filepath.Dir(plan.Core)) = %q, want %q", got, filepath.Dir(core))
	}
	if got := stagingBase(filepath.Join(root, "missing")); got != "" {
		t.Errorf("stagingBase(missing root) = %q, want the empty fallback", got)
	}
	if got := stagingBase(""); got != "" {
		t.Errorf("stagingBase(empty root) = %q, want the empty fallback", got)
	}
}

func TestRunRedirectToHTTPFailsClosed(t *testing.T) {
	pinTestKey(t)
	t.Setenv("FAKE_MINISIGN_OK", "1")
	root := t.TempDir()
	installFakeVerifier(t, root)
	core := []byte("fake-core")
	ffmpegZip := makeZip(t, "ffmpeg.exe", []byte("member"))
	rt := &feedRT{
		apiBody: feedBody(
			releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.22", pubTime: "2026-08-03T22:46:29Z",
				assets: windowsReleaseAssets()},
		),
		files: map[string][]byte{
			"eizouden-manifest.json": windowsManifestJSON(t, "0.2.0-rc.22", core, []byte("yt"), ffmpegZip),
		},
		// The manifest download redirects to a non-HTTPS target.
		redirects: map[string]string{"eizouden-manifest.json": "http://evil.example/manifest"},
	}
	var out bytes.Buffer
	ok := Run(&out, Config{Version: "0.2.0-rc.20", InstallRoot: root, Client: rt.client()})
	if ok {
		t.Fatal("a non-HTTPS redirect target must fail closed")
	}
	if !strings.Contains(out.String(), "update: release verification failed") {
		t.Fatalf("output = %q, want the generic verification failure", out.String())
	}
}

func TestRunRedirectChainBounded(t *testing.T) {
	pinTestKey(t)
	t.Setenv("FAKE_MINISIGN_OK", "1")
	root := t.TempDir()
	installFakeVerifier(t, root)
	core := []byte("fake-core")
	ffmpegZip := makeZip(t, "ffmpeg.exe", []byte("member"))
	rt := &feedRT{
		apiBody: feedBody(
			releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.22", pubTime: "2026-08-03T22:46:29Z",
				assets: windowsReleaseAssets()},
		),
		files: map[string][]byte{
			"eizouden-manifest.json": windowsManifestJSON(t, "0.2.0-rc.22", core, []byte("yt"), ffmpegZip),
		},
		// An HTTPS redirect chain that exceeds the bound of 5 must fail
		// closed (the chain never reaches a final file).
		redirects: map[string]string{
			"eizouden-manifest.json": "https://example.invalid/r1",
			"r1":                     "https://example.invalid/r2",
			"r2":                     "https://example.invalid/r3",
			"r3":                     "https://example.invalid/r4",
			"r4":                     "https://example.invalid/r5",
			"r5":                     "https://example.invalid/r6",
		},
	}
	var out bytes.Buffer
	ok := Run(&out, Config{Version: "0.2.0-rc.20", InstallRoot: root, Client: rt.client()})
	if ok {
		t.Fatal("an unbounded redirect chain must fail closed")
	}
	if !strings.Contains(out.String(), "update: release verification failed") {
		t.Fatalf("output = %q, want the generic verification failure", out.String())
	}
}

func TestRunHashMismatchFailsClosed(t *testing.T) {
	pinTestKey(t)
	t.Setenv("FAKE_MINISIGN_OK", "1")
	root := t.TempDir()
	installFakeVerifier(t, root)
	core := []byte("fake-core")
	ytdlp := []byte("fake-ytdlp")
	ffmpegZip := makeZip(t, "ffmpeg.exe", []byte("member"))
	manifest := windowsManifestJSON(t, "0.2.0-rc.22", core, ytdlp, ffmpegZip)
	// Corrupt the manifest so the core SHA-256 no longer matches.
	corrupt := strings.Replace(string(manifest), shaOf(core), strings.Repeat("0", 64), 1)
	rt := &feedRT{
		apiBody: feedBody(
			releaseEntry{tag: "eizoudendenshi-v0.2.0-rc.22", pubTime: "2026-08-03T22:46:29Z",
				assets: windowsReleaseAssets()},
		),
		files: map[string][]byte{
			"eizouden-manifest.json": []byte(corrupt), "eizouden-manifest.json.minisig": []byte("sig"),
			coreWindowsName: core, coreWindowsName + ".minisig": []byte("sig"),
		},
	}
	var out bytes.Buffer
	ok := Run(&out, Config{Version: "0.2.0-rc.20", InstallRoot: root, Client: rt.client()})
	if ok {
		t.Fatal("a manifest/artifact hash mismatch must fail closed")
	}
	if !strings.Contains(out.String(), "update: release verification failed") {
		t.Fatalf("output = %q, want the generic verification failure", out.String())
	}
}

// --- parseManifest / platform plans ------------------------------------------

func TestParseManifestRejectsInvalid(t *testing.T) {
	core := []byte("x")
	yt := []byte("y")
	zipb := makeZip(t, "ffmpeg.exe", []byte("z"))
	valid := func() []byte { return windowsManifestJSON(t, "0.2.0-rc.22", core, yt, zipb) }
	tests := []struct {
		name string
		mut  func() []byte
	}{
		{"empty", func() []byte { return nil }},
		{"not JSON", func() []byte { return []byte("not json") }},
		{"trailing data", func() []byte { return append(valid(), []byte(" extra")...) }},
		{"unknown field", func() []byte {
			return []byte(strings.Replace(string(valid()), `"format"`, `"bogus":1,"format"`, 1))
		}},
		{"unknown format", func() []byte {
			return []byte(strings.Replace(string(valid()), "eizoudendenshi-release-manifest", "other", 1))
		}},
		{"bad formatVersion", func() []byte {
			return []byte(strings.Replace(string(valid()), `"formatVersion":1`, `"formatVersion":2`, 1))
		}},
		{"bad version", func() []byte {
			return []byte(strings.Replace(string(valid()), "0.2.0-rc.22", "v0.2.0", 1))
		}},
		{"bad helper contract", func() []byte {
			return []byte(strings.Replace(string(valid()), `"version":3`, `"version":4`, 1))
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := parseManifest(tt.mut()); err == nil {
				t.Fatalf("parseManifest must fail closed on %s", tt.name)
			}
		})
	}
}

func TestWindowsPlanRequiresHelpers(t *testing.T) {
	core := []byte("x")
	yt := []byte("y")
	zipb := makeZip(t, "ffmpeg.exe", []byte("z"))
	m, err := parseManifest(windowsManifestJSON(t, "0.2.0-rc.22", core, yt, zipb))
	if err != nil {
		t.Fatalf("parseManifest: %v", err)
	}
	rel := &Release{Assets: assetMap(windowsReleaseAssets())}
	plan, err := m.platformPlan(t.TempDir(), rel)
	if err != nil {
		t.Fatalf("windows plan: %v", err)
	}
	if len(plan.Files) != 3 {
		t.Fatalf("windows plan files = %d, want core + yt-dlp + ffmpeg", len(plan.Files))
	}
	// A core-only v1 manifest must be refused on Windows (no helpers map).
	m.HelperContract.Version = 1
	m.HelperContract.Helpers = nil
	if _, err := m.platformPlan(t.TempDir(), rel); err == nil {
		t.Fatal("a v1 core-only manifest must be refused by the Windows plan")
	}
	// A v3 manifest missing the ffmpeg helper must be refused.
	m.HelperContract.Version = 3
	m.HelperContract.Helpers = map[string]helperSpec{"yt-dlp": {Artifact: "yt-dlp-windows-amd64.exe"}}
	if _, err := m.platformPlan(t.TempDir(), rel); err == nil {
		t.Fatal("a manifest without the ffmpeg helper must be refused on Windows")
	}
	// Missing release assets must be refused.
	m.HelperContract.Helpers = map[string]helperSpec{
		"yt-dlp": {Artifact: "yt-dlp-windows-amd64.exe"},
		"ffmpeg": {Artifact: "ffmpeg-windows-amd64.zip", Archive: true, ExpectedFile: "ffmpeg.exe"},
	}
	relMissing := &Release{Assets: map[string]Asset{}}
	if _, err := m.platformPlan(t.TempDir(), relMissing); err == nil {
		t.Fatal("a release missing required assets must be refused")
	}
}

func TestTermuxPlanIgnoresHelpers(t *testing.T) {
	core := []byte("android-core")
	m := manifest{
		Format:        "eizoudendenshi-release-manifest",
		FormatVersion: 1,
		Version:       "0.2.0-rc.22",
		Artifacts: []artifact{
			{Name: coreAndroidName, Target: androidTarget, SHA256: shaOf(core)},
		},
	}
	m.HelperContract.Version = 1 // core-only contract
	rel := &Release{Assets: map[string]Asset{
		manifestAssetName: {Name: manifestAssetName, URL: "https://example.invalid/m"},
		coreAndroidName:   {Name: coreAndroidName, URL: "https://example.invalid/c"},
	}}
	plan, err := m.termuxPlan(t.TempDir(), rel)
	if err != nil {
		t.Fatalf("termux v1 plan: %v", err)
	}
	if len(plan.Files) != 1 || plan.Files[0].StagedName != coreAndroidName {
		t.Fatalf("termux plan must contain only the core: %+v", plan.Files)
	}
	// Current helper-enabled releases are v3; the Termux updater must
	// still accept them and only take the android core.
	m.HelperContract.Version = 3
	m.HelperContract.Helpers = map[string]helperSpec{
		"yt-dlp": {Artifact: "yt-dlp-windows-amd64.exe"},
		"ffmpeg": {Artifact: "ffmpeg-windows-amd64.zip", Archive: true, ExpectedFile: "ffmpeg.exe"},
	}
	if _, err := m.termuxPlan(t.TempDir(), rel); err != nil {
		t.Fatalf("termux v3 plan: %v", err)
	}
}
