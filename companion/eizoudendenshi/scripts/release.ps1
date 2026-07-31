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
#              android/arm64 (CGO_ENABLED=0). No manifest, no signatures.
#   - `release` builds the binaries, writes the single-line versioned JSON
#              manifest (canonical field order, see bootstrap parse contract),
#              and creates detached Minisign signatures (file.minisig) for the
#              manifest and every artifact. It fails closed if no Minisign
#              key is provided or Minisign itself is unavailable — an
#              unsigned "release" is never produced.
#   - The Minisign secret key path is passed EXPLICITLY as -MinisignKeyPath
#     or via the EIZOUDEN_MINISIGN_KEY environment variable only. No secret
#     file is ever written into, read from, or defaulted inside the repo.
#   - -PublicKeyFile (or env EIZOUDEN_MINISIGN_PUBKEY_FILE) optionally emits
#     a distribution-ready copy of scripts/termux-bootstrap.sh with the
#     pinned public key substituted into the repo template. The repo
#     template itself always keeps the unpinned placeholder (fails closed).
#
# Manifest (one line, canonical order — the bootstrap parses it):
#   {"format":"eizoudendenshi-release-manifest","formatVersion":1,
#    "version":"<VERSION>",
#    "helperContract":{"version":1,"minimumVersions":{}},
#    "artifacts":[{"name":"...","target":"windows/amd64","sha256":"..."},
#                 {"name":"...","target":"android/arm64","sha256":"..."}]}
#   helperContract is the placeholder for future yt-dlp/aria2/ffmpeg minimum
#   versions. It fails closed: the bootstrap only accepts exactly
#   {"version":1,"minimumVersions":{}}; anything else (including future
#   contract versions or non-empty minimumVersions) is refused before
#   install, because this template provisions no helpers.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('build', 'release')]
    [string]$Verb = 'build',

    [string]$Version = '',

    [string]$OutDir = '',

    [string]$MinisignKeyPath = '',

    [string]$PublicKeyFile = ''
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
# Leading ./ is required: a bare `cmd/eizouden` argument is resolved against
# GOROOT/src/cmd first and fails with "not in std" even inside the module.
$CoreCmd = './cmd/eizouden'

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

# --- Build binaries ---
function Build-Binary {
    param(
        [string]$Goos,
        [string]$Goarch,
        [string]$Name
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
            $goOut = & go build -trimpath -ldflags '-s -w' -o $out $CoreCmd 2>&1
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
    Build-Binary -Goos $a.GOOS -Goarch $a.GOARCH -Name $a.Name
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
$manifest = [ordered]@{
    format        = 'eizoudendenshi-release-manifest'
    formatVersion = 1
    version       = $Version
    helperContract = [ordered]@{
        version         = 1
        minimumVersions = @{}   # placeholder: bootstrap fails closed on any non-empty value
    }
    artifacts     = $artifactEntries
}
# Single-line canonical JSON (the Termux bootstrap parses it with grep/sed
# against this exact compact form; changing the layout fails closed there).
$manifestJson = ($manifest | ConvertTo-Json -Depth 6 -Compress)
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

# --- Optional: emit distribution-ready bootstrap with the pinned key ---
if ($PublicKeyFile -eq '') {
    $PublicKeyFile = $env:EIZOUDEN_MINISIGN_PUBKEY_FILE
}
if ($PublicKeyFile -ne '') {
    $PublicKeyFile = [System.IO.Path]::GetFullPath($PublicKeyFile)
    $pubLine = Get-Content -LiteralPath $PublicKeyFile | Where-Object { $_ -match '^RW[A-Za-z0-9+/]+$' } | Select-Object -First 1
    if (-not $pubLine) {
        throw "no RW... Minisign public key line found in $PublicKeyFile"
    }
    $template = Join-Path $PSScriptRoot 'termux-bootstrap.sh'
    $text = [System.IO.File]::ReadAllText($template)
    $placeholder = 'REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY'
    if (-not $text.Contains($placeholder)) {
        throw 'bootstrap template does not contain the pinned-key placeholder (template changed?)'
    }
    $text = $text.Replace($placeholder, $pubLine)
    $outBoot = Join-Path $OutDir 'eizouden-bootstrap.sh'
    [System.IO.File]::WriteAllText($outBoot, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "wrote  eizouden-bootstrap.sh (public key pinned, distribution-ready)"
}
else {
    Write-Host 'skipped bootstrap emission (no -PublicKeyFile / EIZOUDEN_MINISIGN_PUBKEY_FILE)'
}

Write-Host "release complete: $OutDir"
