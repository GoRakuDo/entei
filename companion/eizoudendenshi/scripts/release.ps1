# EizouDendenshi ED-2D Stage A build/release helper (Windows dev machine).
#
# Usage:
#   pwsh scripts/release.ps1 build                                  # binaries only
#   pwsh scripts/release.ps1 release -Version 0.2.0 `
#       -MinisignKeyPath C:\secrets\eizouden.key `
#       [-PublicKeyFile C:\secrets\eizouden.pub] `
#       [-OutDir dist]
#
# Contract:
#   - `build`  cross-compiles the companion for windows/amd64 and
#              android/arm64 (CGO_ENABLED=0). No manifest, no signatures;
#              the binaries keep the dev-default version (0.2.0).
#   - `release` builds the binaries with the validated -Version injected at
#              link time (-ldflags -X eizoudendenshi/internal/api.Version),
#              writes the single-line versioned JSON manifest (canonical
#              field order, see bootstrap parse contract), and creates
#              detached Minisign signatures (file.minisig) for the manifest
#              and every artifact. It fails closed if no Minisign key is
#              provided or Minisign itself is unavailable — an unsigned
#              "release" is never produced.
#   - The Minisign secret key path is passed EXPLICITLY as -MinisignKeyPath
#     or via the EIZOUDEN_MINISIGN_KEY environment variable only. No secret
#     file is ever written into, read from, or defaulted inside the repo.
#   - -PublicKeyFile (or env EIZOUDEN_MINISIGN_PUBKEY_FILE) supplies the
#     Minisign PUBLIC key: it is read and validated BEFORE any binary is
#     built, injected into both release core binaries at link time
#     (-ldflags -X eizoudendenshi/internal/update.PinnedPublicKey=<RW...>)
#     so the built-in updater (CLI option 3) verifies releases against the
#     pinned key, and substituted into the distribution-ready bootstrap
#     templates. The repo templates and `build` binaries always keep the
#     unpinned placeholder (the updater fails closed as "updater
#     unavailable" without a pinned key). The private key is never
#     exposed.
#
# Manifest (one line, canonical order — the bootstraps parse it):
#   Core-only (Termux path, unchanged):
#     {"format":"eizoudendenshi-release-manifest","formatVersion":1,
#      "version":"<VERSION>",
#      "helperContract":{"version":1,"minimumVersions":{}},
#      "artifacts":[{"name":"...","target":"windows/amd64","sha256":"..."},
#                   {"name":"...","target":"android/arm64","sha256":"..."}]}
#   Windows helper-enabled (when -HelpersFile is given):
#     helperContract.version = 2 with a "helpers" map, e.g.
#       {"version":2,"helpers":{"yt-dlp":{"required":true,"version":"…",
#        "artifact":"yt-dlp-windows-amd64.exe"},
#        "ffmpeg":{"required":false,"version":"…","artifact":"ffmpeg-windows-amd64.zip",
#         "archive":true,"expectedFile":"ffmpeg.exe"}, …}}
#     plus one artifacts entry per helper artifact (target windows/amd64).
#   The Termux bootstrap ONLY accepts exactly {"version":1,
#   "minimumVersions":{}} (fails closed on anything else), so helper-enabled
#   releases are refused there — Termux stays helper-none. The Windows
#   bootstrap ONLY accepts version 2 with the helpers map (fails closed on
#   version 1). The v1 contract output is byte-for-byte unchanged when no
#   helper inputs are given.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('build', 'release')]
    [string]$Verb = 'build',

    [string]$Version = '',

    [string]$OutDir = '',

    [string]$MinisignKeyPath = '',

    [string]$PublicKeyFile = '',

    [string]$HelpersFile = ''
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
# Leading ./ is required: a bare `cmd/eizouden` argument is resolved against
# GOROOT/src/cmd first and fails with "not in std" even inside the module.
$CoreCmd = './cmd/eizouden'

# Assert-PinnedPublicKeyFile reads the RW... Minisign public key line
# from the given file and validates its shape (the same checks the
# bootstraps apply to the pinned key). Returns the bare key line.
function Assert-PinnedPublicKeyFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "public key file not found: $Path"
    }
    $pubLine = Get-Content -LiteralPath $Path | Where-Object { $_ -match '^RW[A-Za-z0-9+/]+$' } | Select-Object -First 1
    if (-not $pubLine) {
        throw "no RW... Minisign public key line found in $Path"
    }
    if ($pubLine.Length -lt 42 -or $pubLine.Length -gt 80) {
        throw 'pinned public key has an unexpected length'
    }
    return $pubLine
}

# --- Output directory ---
if ($OutDir -eq '') {
    $OutDir = Join-Path $RepoRoot 'dist'
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# --- Artifacts (names are part of the release contract; the bootstrap
#     hardcodes eizouden-android-arm64 and fails closed on any other name) ---
$Artifacts = @(
    [ordered]@{ Name = 'eizouden-windows-amd64.exe'; Target = 'windows/amd64'; GOOS = 'windows'; GOARCH = 'amd64' },
    [ordered]@{ Name = 'eizouden-android-arm64';    Target = 'android/arm64';  GOOS = 'android';  GOARCH = 'arm64' }
)

# --- Version validation (release only) ---
if ($Verb -eq 'release') {
    if ($Version -eq '') {
        throw 'release requires -Version (semver, e.g. 0.2.0)'
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
        throw "invalid -Version '$Version'; expected semver (e.g. 0.2.0)"
    }
}

# --- Pinned update public key (release only) --------------------------------
# The updater (CLI option 3) verifies every release artifact against the
# public key pinned into the release binary. -PublicKeyFile (or env
# EIZOUDEN_MINISIGN_PUBKEY_FILE) supplies it; the key is read and
# validated BEFORE any binary is built so a bad key file can never
# produce binaries carrying garbage. The same validated key is also
# substituted into the distribution-ready bootstrap templates below.
$script:PinnedUpdateKey = ''
if ($Verb -eq 'release') {
    if ($PublicKeyFile -eq '') {
        $PublicKeyFile = $env:EIZOUDEN_MINISIGN_PUBKEY_FILE
    }
    if ($PublicKeyFile -ne '') {
        $script:PinnedUpdateKey = Assert-PinnedPublicKeyFile -Path $PublicKeyFile
        Write-Host 'update public key pinned: yes (injected into both release cores)'
    }
    else {
        Write-Host 'update public key pinned: NO - release cores keep the placeholder and the built-in updater fails closed (pass -PublicKeyFile or set EIZOUDEN_MINISIGN_PUBKEY_FILE)'
    }
}

# --- Windows helper inputs (ED-2D helper-enabled release) -------------------
# Helpers are supplied ONLY as explicit local artifact paths via -HelpersFile
# (a JSON file). The release tool NEVER downloads vendor code: it validates,
# copies, hashes, and signs the supplied artifacts. Without -HelpersFile the
# release is core-only and the manifest keeps the exact v1 Termux contract.
$script:HelperSpecs = @()   # ordered list of validated helper specs
$script:HelperNames = @{}   # key -> artifactName (duplicate detection)

function Assert-SafeArtifactName {
    param([string]$Name, [string]$What)
    if ($Name -eq '' -or $Name -match '[/\\]' -or $Name -match '\.\.' -or $Name -match '[\s"<>|:*?]' -or $Name -notmatch '^[A-Za-z0-9._-]+$') {
        throw "unsafe $What artifact name '$Name' (fails closed)"
    }
    return $Name
}

function Load-HelperSpecs {
    if ($script:HelpersFile -eq '') {
        return $false
    }
    $path = [System.IO.Path]::GetFullPath($script:HelpersFile)
    if (-not (Test-Path -LiteralPath $path)) {
        throw "helper inputs file not found: $path"
    }
    $specs = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    if ($null -eq $specs.helpers -or @($specs.helpers).Count -eq 0) {
        throw 'helper inputs file has no "helpers" array (fails closed)'
    }
    foreach ($h in $specs.helpers) {
        $key = [string]$h.key
        if ($key -notin @('yt-dlp', 'ffmpeg')) {
            throw "unknown helper key '$key' (only yt-dlp / ffmpeg are supported)"
        }
        if ($script:HelperNames.ContainsKey($key)) {
            throw "duplicate helper key '$key' (fails closed)"
        }
        $artifact = Assert-SafeArtifactName ([string]$h.artifactName) 'helper'
        $version = [string]$h.version
        if ($version -eq '' -or $version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') {
            throw "invalid version '$version' for helper '$key'"
        }
        $src = [System.IO.Path]::GetFullPath([string]$h.path)
        if (-not (Test-Path -LiteralPath $src)) {
            throw "helper artifact '$artifact' (key '$key') not found at the explicit local path: $src"
        }
        if ((Get-Item -LiteralPath $src).PSIsContainer) {
            throw "helper artifact '$artifact' is a directory; a single file is required"
        }
        if ((Get-Item -LiteralPath $src).Length -eq 0) {
            throw "helper artifact '$artifact' is empty (reject zero-byte helpers)"
        }
        $required = [bool]$h.required
        $archive = [bool]$h.archive
        $expectedFile = ''
        if ($archive) {
            $expectedFile = Assert-SafeArtifactName ([string]$h.expectedFile) 'archive target'
        }
        $script:HelperNames[$key] = $artifact
        $script:HelperSpecs += [ordered]@{
            key          = $key
            required     = $required
            version      = $version
            artifactName = $artifact
            srcPath      = $src
            archive      = $archive
            expectedFile = $expectedFile
        }
    }
    return $true
}

# --- Build binaries ---
function Build-Binary {
    param(
        [string]$Goos,
        [string]$Goarch,
        [string]$Name,
        [string]$PinnedKey
    )
    $out = Join-Path $OutDir $Name
    $prev = @{
        CGO_ENABLED = $env:CGO_ENABLED
        GOOS        = $env:GOOS
        GOARCH      = $env:GOARCH
    }
    try {
        $env:CGO_ENABLED = '0'
        $env:GOOS = $Goos
        $env:GOARCH = $Goarch
        Push-Location $RepoRoot
        try {
            $ldflags = '-s -w -checklinkname=0'
            if ($Verb -eq 'release') {
                # Link-time version injection: the release binary must report
                # exactly the validated -Version that the manifest carries.
                # `build` deliberately omits this so dev binaries keep the
                # api.Version dev default (0.2.0). $Version is validated
                # semver (no quotes/spaces), so embedding it is safe.
                $ldflags = "$ldflags -X eizoudendenshi/internal/api.Version=$Version"
                if ($PinnedKey -ne '') {
                    # Updater pinned-key injection: the release binary
                    # verifies releases against this validated RW... key.
                    # Without it the built-in updater fails closed as
                    # "updater unavailable". The key is validated
                    # RW[A-Za-z0-9+/]+ (no quotes/spaces), so embedding it
                    # is safe; the private key is never touched.
                    $ldflags = "$ldflags -X eizoudendenshi/internal/update.PinnedPublicKey=$PinnedKey"
                }
            }
            $goOut = & go build -trimpath -ldflags $ldflags -o $out $CoreCmd 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "go build $Goos/$Goarch failed (exit $LASTEXITCODE): $($goOut -join ' ')"
            }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        $env:CGO_ENABLED = $prev.CGO_ENABLED
        $env:GOOS = $prev.GOOS
        $env:GOARCH = $prev.GOARCH
    }
    $len = (Get-Item $out).Length
    if ($len -eq 0) {
        throw "build artifact $Name is empty"
    }
    Write-Host "built  $Name ($Goos/$Goarch, $len bytes)"
}

foreach ($a in $Artifacts) {
    Build-Binary -Goos $a.GOOS -Goarch $a.GOARCH -Name $a.Name -PinnedKey $script:PinnedUpdateKey
}

if ($Verb -eq 'build') {
    Write-Host "build complete: $OutDir"
    return
}

# --- release: Minisign key resolution (explicit arg/env only) ---
if ($MinisignKeyPath -eq '') {
    $MinisignKeyPath = $env:EIZOUDEN_MINISIGN_KEY
}
if ($MinisignKeyPath -eq '') {
    throw 'release requires a Minisign secret key: pass -MinisignKeyPath or set EIZOUDEN_MINISIGN_KEY. No unsigned release is produced (fails closed).'
}
$MinisignKeyPath = [System.IO.Path]::GetFullPath($MinisignKeyPath)
if (-not (Test-Path -LiteralPath $MinisignKeyPath)) {
    throw "Minisign secret key not found: $MinisignKeyPath"
}

$Minisign = Get-Command minisign -ErrorAction SilentlyContinue
if (-not $Minisign) {
    throw 'minisign not found on PATH; install it (Termux: pkg install minisign; Windows: use the official win64 binary)'
}

# --- SHA-256 + manifest ---
function Get-Sha256Lower {
    param([string]$Path)
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

# Load + copy the Windows helper artifacts (explicit local inputs only).
$helperEnabled = Load-HelperSpecs
$helperArtifacts = @()
if ($helperEnabled) {
    foreach ($h in $script:HelperSpecs) {
        $dest = Join-Path $OutDir $h.artifactName
        Copy-Item -LiteralPath $h.srcPath -Destination $dest -Force
        $helperArtifacts += [ordered]@{
            name   = $h.artifactName
            target = 'windows/amd64'
            sha256 = Get-Sha256Lower $dest
        }
        Write-Host "helper  $($h.key) -> $($h.artifactName) ($([string]$h.version))"
    }
}

$ManifestName = 'eizouden-manifest.json'
$ManifestPath = Join-Path $OutDir $ManifestName

$artifactEntries = @()
foreach ($a in $Artifacts) {
    $p = Join-Path $OutDir $a.Name
    $artifactEntries += [ordered]@{
        name   = $a.Name
        target = $a.Target
        sha256 = Get-Sha256Lower $p
    }
}
# Helper artifacts follow the core entries (canonical order: cores first).
$artifactEntries += $helperArtifacts

$helperContract = [ordered]@{
    version         = 1
    minimumVersions = @{}   # placeholder: Termux bootstrap fails closed on any non-empty value
}
if ($helperEnabled) {
    $helpersMap = [ordered]@{}
    foreach ($h in $script:HelperSpecs) {
        $entry = [ordered]@{
            required = $h.required
            version  = $h.version
            artifact = $h.artifactName
        }
        if ($h.archive) {
            $entry.archive = $true
            $entry.expectedFile = $h.expectedFile
        }
        $helpersMap[$h.key] = $entry
    }
    # Contract v3 = canonical helper contract: the Windows artifact helpers
    # above PLUS the fixed Termux package requirements. The Termux map is a
    # compiled-in constant (official Termux pkg repo names + minimum
    # versions); it is never derived from user input. The Windows bootstrap
    # accepts versions 2 and 3 (both carry the artifact helpers map); the
    # helper-enabled Termux bootstrap requires version 3 (fails closed on 1
    # and 2). The v1 core-only Termux bootstrap stays byte-for-byte
    # unchanged and refuses anything but v1.
    $helperContract = [ordered]@{
        version = 3
        helpers = $helpersMap
        termux  = [ordered]@{
            packages = [ordered]@{
                'yt-dlp' = [ordered]@{ package = 'python-yt-dlp'; command = 'yt-dlp'; minimum = '2025.03.31' }
                'ffmpeg' = [ordered]@{ package = 'ffmpeg'; command = 'ffmpeg'; minimum = '4.4' }
            }
        }
    }
}

$manifest = [ordered]@{
    format        = 'eizoudendenshi-release-manifest'
    formatVersion = 1
    version       = $Version
    helperContract = $helperContract
    artifacts     = $artifactEntries
}
# Single-line canonical JSON (the bootstraps parse it against this exact
# compact form; changing the layout fails closed there).
$manifestJson = ($manifest | ConvertTo-Json -Depth 8 -Compress)
[System.IO.File]::WriteAllText($ManifestPath, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "wrote  $ManifestName (v$Version)"

# --- Sign manifest + every artifact (detached .minisig next to the file) ---
function Sign-File {
    param([string]$Path)
    $sig = "$Path.minisig"
    if (Test-Path -LiteralPath $sig) {
        Remove-Item -LiteralPath $sig -Force
    }
    & $Minisign.Source -S -m $Path -s $MinisignKeyPath
    if ($LASTEXITCODE -ne 0) {
        throw "minisign signing failed for $Path (exit $LASTEXITCODE)"
    }
    if (-not (Test-Path -LiteralPath $sig)) {
        throw "minisign did not produce $sig"
    }
    Write-Host "signed $(Split-Path $Path -Leaf)"
}

Sign-File $ManifestPath
foreach ($a in $Artifacts) {
    Sign-File (Join-Path $OutDir $a.Name)
}
foreach ($h in $helperArtifacts) {
    Sign-File (Join-Path $OutDir $h.name)
}

# --- Optional: emit distribution-ready bootstraps with the pinned key ---
# The key was already read and validated BEFORE the builds above
# ($script:PinnedUpdateKey); it is the exact same key the release cores
# carry. Each bootstrap also gets the EXACT release base URL baked in
# (REPLACE_ME_RELEASE_BASE_URL placeholder) so the public install is a
# plain one-liner with no required arguments.
if ($script:PinnedUpdateKey -ne '') {
    $placeholder = 'REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY'
    $releaseUrlPlaceholder = 'REPLACE_ME_RELEASE_BASE_URL'
    # GitHub Release asset base for this exact release tag. The version is
    # validated semver (no quotes/spaces), so embedding it is safe.
    $releaseBaseUrl = "https://github.com/GoRakuDo/entei/releases/download/eizoudendenshi-v$Version/"
    foreach ($pair in @(
            @('termux-bootstrap.sh', 'eizouden-bootstrap.sh'),
            @('termux-bootstrap-helper.sh', 'eizouden-bootstrap-helper.sh'),
            @('windows-bootstrap.ps1', 'eizouden-bootstrap.ps1'))) {
        $template = Join-Path $PSScriptRoot $pair[0]
        $text = [System.IO.File]::ReadAllText($template)
        if (-not $text.Contains($placeholder)) {
            throw "bootstrap template $($pair[0]) does not contain the pinned-key placeholder (template changed?)"
        }
        if (-not $text.Contains($releaseUrlPlaceholder)) {
            throw "bootstrap template $($pair[0]) does not contain the release URL placeholder (template changed?)"
        }
        $text = $text.Replace($placeholder, $script:PinnedUpdateKey)
        $text = $text.Replace($releaseUrlPlaceholder, $releaseBaseUrl)
        $outBoot = Join-Path $OutDir $pair[1]
        [System.IO.File]::WriteAllText($outBoot, $text, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "wrote  $($pair[1]) (public key pinned, release URL baked in, distribution-ready)"
    }
}
else {
    Write-Host 'skipped bootstrap emission (no -PublicKeyFile / EIZOUDEN_MINISIGN_PUBKEY_FILE)'
}

Write-Host "release complete: $OutDir"
