package update

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"runtime"
)

// manifest is the parsed signed release manifest (single-line canonical
// JSON produced by scripts/release.ps1).
type manifest struct {
	Format         string `json:"format"`
	FormatVersion  int    `json:"formatVersion"`
	Version        string `json:"version"`
	HelperContract struct {
		Version         int                   `json:"version"`
		Helpers         map[string]helperSpec `json:"helpers"`
		MinimumVersions json.RawMessage       `json:"minimumVersions"`
		Termux          json.RawMessage       `json:"termux"`
	} `json:"helperContract"`
	Artifacts []artifact `json:"artifacts"`
}

type helperSpec struct {
	Required     bool   `json:"required"`
	Version      string `json:"version"`
	Artifact     string `json:"artifact"`
	Archive      bool   `json:"archive"`
	ExpectedFile string `json:"expectedFile"`
}

type artifact struct {
	Name   string `json:"name"`
	Target string `json:"target"`
	SHA256 string `json:"sha256"`
}

var sha256Shape = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Platform artifact/target constants (names are part of the release
// contract; the bootstraps hardcode them and fail closed on any other
// name).
const (
	coreWindowsName = "eizouden-windows-amd64.exe"
	coreAndroidName = "eizouden-android-arm64"
	windowsTarget   = "windows/amd64"
	androidTarget   = "android/arm64"
)

// parseManifest parses and validates the signed manifest. Unknown
// fields, an unknown format, a wrong format version, an invalid version,
// an unsupported helper contract, duplicate or unsafe artifact names,
// wrong targets, and malformed SHA-256 values all fail closed.
func parseManifest(b []byte) (*manifest, error) {
	if len(b) == 0 || len(b) > 1<<20 {
		return nil, errors.New("update: manifest has an invalid size")
	}
	var m manifest
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return nil, errors.New("update: manifest is not valid JSON")
	}
	if dec.More() {
		return nil, errors.New("update: trailing data in manifest")
	}
	if m.Format != "eizoudendenshi-release-manifest" {
		return nil, errors.New("update: manifest has an unknown format")
	}
	if m.FormatVersion != 1 {
		return nil, errors.New("update: manifest format version is not supported")
	}
	if !semverShape.MatchString(m.Version) {
		return nil, errors.New("update: manifest version is not a valid semver")
	}
	hc := m.HelperContract.Version
	if hc < 1 || hc > 3 {
		return nil, errors.New("update: manifest helper contract is not supported")
	}
	seen := make(map[string]bool, len(m.Artifacts))
	for _, a := range m.Artifacts {
		if !safeAssetName.MatchString(a.Name) {
			return nil, errors.New("update: manifest has an unsafe artifact name")
		}
		if seen[a.Name] {
			return nil, errors.New("update: manifest has a duplicate artifact name")
		}
		seen[a.Name] = true
		if !sha256Shape.MatchString(a.SHA256) {
			return nil, errors.New("update: manifest has an invalid artifact SHA-256")
		}
	}
	return &m, nil
}

// stagedFile is one verified file to be applied: the staged file name
// (== the basename of the target) and the absolute install target, plus
// the download/verification source.
type stagedFile struct {
	StagedName string // staged file name (child: staging/<StagedName>)
	Target     string // absolute install target path
	SourceName string // release asset / manifest artifact logical name
	SHA256     string // manifest-attested SHA-256 of SourceName bytes
	Archive    bool   // SourceName is a zip; extract Expected into StagedName
	Expected   string // exact member to extract when Archive
}

// applyPlan is the platform apply plan handed to the --apply-update
// child (and used for staging).
type applyPlan struct {
	// Files are applied in order: helpers first, the core LAST, so a
	// helper failure aborts before the core is ever touched.
	Files  []stagedFile
	Core   string // absolute core target (relaunch path)
	Ytdlp  string // absolute yt-dlp helper path ("" on Termux)
	Ffmpeg string // absolute ffmpeg helper path ("" on Termux)
}

// platformPlan builds the apply plan for the current platform.
//
// Windows amd64: the manifest must carry the helper contract (v2/v3)
// with yt-dlp and ffmpeg; the artifacts must include the core, the
// yt-dlp exe, and the ffmpeg archive; the ffmpeg archive's expected
// member is extracted as the runtime helper. Helper runtime names
// preserve the bootstrap layout (archive -> expectedFile, standalone ->
// artifact name) under <install root>/helpers.
//
// Termux (android/arm64): only the android core artifact is updated;
// Termux package helpers stay managed by the signed helper bootstrap /
// pkg contract and are never touched here. Helper contracts v1/v2/v3 are
// all accepted (current releases are v3).
func (m *manifest) platformPlan(installRoot string, rel *Release) (*applyPlan, error) {
	switch runtime.GOOS {
	case "windows":
		return m.windowsPlan(installRoot, rel)
	default:
		return m.termuxPlan(installRoot, rel)
	}
}

func (m *manifest) findArtifact(name, target string) (*artifact, error) {
	found := 0
	var out *artifact
	for i := range m.Artifacts {
		a := &m.Artifacts[i]
		if a.Name == name && a.Target == target {
			found++
			out = a
		}
	}
	if found != 1 {
		return nil, fmt.Errorf("update: manifest has no single %s artifact for %s", name, target)
	}
	return out, nil
}

// requireAsset checks that the release carries the given asset.
func requireAsset(rel *Release, name string) error {
	a, ok := rel.Assets[name]
	if !ok || a.Name != name {
		return fmt.Errorf("update: release is missing the %s asset", name)
	}
	return nil
}

func (m *manifest) windowsPlan(installRoot string, rel *Release) (*applyPlan, error) {
	hc := m.HelperContract.Version
	if hc != 2 && hc != 3 {
		return nil, errors.New("update: manifest helper contract is not a Windows-compatible contract")
	}
	if len(m.HelperContract.Helpers) == 0 {
		return nil, errors.New("update: manifest declares no helpers")
	}
	yt, okYt := m.HelperContract.Helpers["yt-dlp"]
	ff, okFf := m.HelperContract.Helpers["ffmpeg"]
	if !okYt || !okFf {
		return nil, errors.New("update: manifest is missing the yt-dlp or ffmpeg helper")
	}
	if !safeAssetName.MatchString(yt.Artifact) || !safeAssetName.MatchString(ff.Artifact) {
		return nil, errors.New("update: manifest has an unsafe helper artifact name")
	}
	if ff.Archive {
		if !safeAssetName.MatchString(ff.ExpectedFile) {
			return nil, errors.New("update: manifest has an unsafe archive target")
		}
	} else if ff.ExpectedFile != "" {
		return nil, errors.New("update: manifest declares an archive target without an archive")
	}

	if err := requireAsset(rel, manifestAssetName); err != nil {
		return nil, err
	}
	core, err := m.findArtifact(coreWindowsName, windowsTarget)
	if err != nil {
		return nil, err
	}
	if err := requireAsset(rel, coreWindowsName); err != nil {
		return nil, err
	}
	ytArt, err := m.findArtifact(yt.Artifact, windowsTarget)
	if err != nil {
		return nil, err
	}
	if err := requireAsset(rel, yt.Artifact); err != nil {
		return nil, err
	}
	ffArt, err := m.findArtifact(ff.Artifact, windowsTarget)
	if err != nil {
		return nil, err
	}
	if err := requireAsset(rel, ff.Artifact); err != nil {
		return nil, err
	}

	helpersDir := filepath.Join(installRoot, "helpers")
	ytRuntime := yt.Artifact
	ffRuntime := ff.Artifact
	if ff.Archive {
		ffRuntime = ff.ExpectedFile
	}
	plan := &applyPlan{
		Core:   filepath.Join(installRoot, coreWindowsName),
		Ytdlp:  filepath.Join(helpersDir, ytRuntime),
		Ffmpeg: filepath.Join(helpersDir, ffRuntime),
	}
	plan.Files = []stagedFile{
		{StagedName: ytRuntime, Target: plan.Ytdlp, SourceName: ytArt.Name, SHA256: ytArt.SHA256},
	}
	if ff.Archive {
		plan.Files = append(plan.Files, stagedFile{
			StagedName: ffRuntime, Target: plan.Ffmpeg,
			SourceName: ffArt.Name, SHA256: ffArt.SHA256,
			Archive: true, Expected: ff.ExpectedFile,
		})
	}
	plan.Files = append(plan.Files, stagedFile{
		StagedName: coreWindowsName, Target: plan.Core,
		SourceName: core.Name, SHA256: core.SHA256,
	})
	return plan, nil
}

func (m *manifest) termuxPlan(installRoot string, rel *Release) (*applyPlan, error) {
	if err := requireAsset(rel, manifestAssetName); err != nil {
		return nil, err
	}
	core, err := m.findArtifact(coreAndroidName, androidTarget)
	if err != nil {
		return nil, err
	}
	if err := requireAsset(rel, coreAndroidName); err != nil {
		return nil, err
	}
	target := filepath.Join(installRoot, coreAndroidName)
	return &applyPlan{
		Files: []stagedFile{{
			StagedName: coreAndroidName, Target: target,
			SourceName: core.Name, SHA256: core.SHA256,
		}},
		Core: target,
	}, nil
}
