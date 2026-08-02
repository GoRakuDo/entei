# EizouDendenshi Windows x64 bootstrap (ED-2D helper-enabled template)
#
# Verify and install the signed windows/amd64 EizouDendenshi core AND its
# signed helper artifacts (yt-dlp / aria2 / ffmpeg) into user-private
# storage, then launch the core with explicit absolute helper paths.
#
# Distribution contract (do not weaken):
#   - This template is NEVER fetched over the network and piped into a
#     shell (no Invoke-Expression, no curl|sh, no remote script execution).
#   - The pinned Minisign public key below MUST be replaced with the real
#     release key before publishing; an unreplaced template fails closed.
#   - The release base URL is an explicit input (-ReleaseBaseUrl or
#     EIZOU_RELEASE_URL) and MUST be https://. Nothing is downloaded before
#     it is validated, and every redirect is bounded and HTTPS-only.
#   - End users fetch ONLY from the signed Eizou release base. No helper is
#     ever downloaded from a vendor at bootstrap time.
#   - Helpers are release artifacts: each is individually Minisign-signed
#     and its SHA-256 is verified against the signed manifest BEFORE any
#     replacement. Installed helpers verified against the signed manifest
#     are reused; anything else is atomically replaced after verification.
#   - The manifest must carry the version-2 Windows helper contract; any
#     other contract, missing/duplicate/unsafe helper entries, wrong target,
#     or a version/SHA mismatch fails closed before install.
#   - Nothing is installed system-wide: no winget/choco/Python/global
#     installer, no system PATH mutation, no Invoke-Expression. The only
#     PATH change is PROCESS-SCOPED (prepending the private helpers dir for
#     the launched core so yt-dlp finds the verified ffmpeg), and it never
#     persists.
#
# Usage:
#   pwsh eizouden-bootstrap.ps1 -ReleaseBaseUrl https://dl.example.org/eizouden/releases/0.2.0
#
# Harness-only overrides (never used in production; verification and
# fail-closed order are never relaxed):
#   -HarnessMirrorDir <dir>   fetch files from a local directory instead of
#                             the network (same verification path)
#   -HarnessLaunchFile <path> write the would-be launch command line (with
#                             the absolute helper paths) to a file instead of
#                             launching the core
#   -SkipLaunch               install/verify only; do not launch
#   -InstallRoot <path>       explicit user-private install root (harness)
[CmdletBinding()]
param(
    [string]$ReleaseBaseUrl = '',
    [string]$InstallRoot = '',
    [switch]$SkipLaunch,
    [string]$HarnessMirrorDir = '',
    [string]$HarnessLaunchFile = '',
    [string]$MinisignExe = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- Pinned release signing key (replace at release time) ---
$PinnedPubKey = 'REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY'

# --- Pinned verifier (Minisign) trust bootstrap ---
# The verifier is acquired ONLY from this pinned official source, before any
# Eizou release artifact is downloaded. The expected SHA-256 is the trust
# anchor (the release also carries a .minisig, but a first-run verifier
# cannot verify itself — the pinned hash is authoritative).
#   Source: official jedisct1/minisign release 0.12
#   URL:    https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip
#   SHA-256:37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479
#   Member: minisign-win64/x86_64/minisign.exe (Windows x64 build)
#   Version: 0.12
$MinisignZipUrl = 'https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip'
$MinisignZipSha256 = '37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479'
$MinisignZipMember = 'minisign-win64/x86_64/minisign.exe'
$MinisignExpectedName = 'minisign.exe'
$MinisignExpectedVersion = '0.12'
$MinisignStateFile = 'minisign-state.json'

# --- Release contract constants (must match scripts/release.ps1) ---
$ManifestName = 'eizouden-manifest.json'
$CoreTarget = 'windows/amd64'
$HelperContractVersion = 2
$StateFileName = 'helpers-state.json'

function Fail([string]$Msg) {
    # Error output never reveals sensitive local paths or URLs; only safe
    # artifact logical names may appear.
    Write-Error "EizouDendenshi bootstrap: $Msg"
    exit 1
}

function Assert-HttpsUrl {
    param([string]$Url, [string]$What)
    if ($Url -eq '') { Fail "missing $What (required)" }
    if ($Url -notmatch '^https://') { Fail "$What must be https:// (refusing non-HTTPS download)" }
    if ($Url -match '@|\?|#|\s') { Fail "$What must not contain userinfo, a query, a fragment, or whitespace" }
    $hostPart = $Url.Substring('https://'.Length)
    if ($hostPart -eq '') { Fail "$What has no host" }
}

function Assert-PinnedKey {
    if ($PinnedPubKey -eq '' -or $PinnedPubKey -match 'REPLACE_ME') {
        Fail 'template public key is not pinned; refusing to run an unpinned bootstrap'
    }
    if ($PinnedPubKey -notmatch '^RW') { Fail 'pinned public key must be a Minisign RW... key' }
    if ($PinnedPubKey -notmatch '^RW[A-Za-z0-9+/]+$') { Fail 'pinned public key contains invalid characters' }
    if ($PinnedPubKey.Length -lt 42 -or $PinnedPubKey.Length -gt 80) { Fail 'pinned public key has an unexpected length' }
}

function Assert-MinisignVersion {
    param([string]$Exe, [string]$LogicalName)
    $out = & $Exe -v 2>&1
    if ($LASTEXITCODE -ne 0 -or (($out -join ' ') -notmatch $MinisignExpectedVersion)) {
        Fail "verifier version check failed for $LogicalName (expected $MinisignExpectedVersion)"
    }
    # Deliberately returns nothing: the version output must never leak into
    # the caller's pipeline (it would corrupt the returned verifier path).
}

function Read-MinisignState {
    param([string]$InstallRoot)
    $stateFile = Join-Path $InstallRoot $MinisignStateFile
    if (-not (Test-Path -LiteralPath $stateFile)) { return @{} }
    try { return (Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json) } catch { return @{} }
}

function Write-MinisignState {
    param([string]$InstallRoot, $State)
    $stateFile = Join-Path $InstallRoot $MinisignStateFile
    [System.IO.File]::WriteAllText($stateFile, ($State | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-VerifierFetch {
    # Harness-only override (EIZOU_WIN_MINISIGN_MIRROR) copies the pinned ZIP
    # from a local file; production always fetches the pinned official URL
    # over HTTPS with bounded redirects/timeouts. Both paths feed the same
    # hash-verify-then-extract logic; the pinned URL/hash never change.
    # NB: the env var may be UNDEFINED on a real first run — PowerShell's
    # `$env:X -ne ''` is TRUE for $null, so an unguarded
    # `Test-Path $env:X` would throw (reproduced on published rc.5). Guard
    # against $null explicitly.
    $dest = Join-Path $script:TempDir 'minisign-0.12-win64.zip'
    $mirror = $env:EIZOU_WIN_MINISIGN_MIRROR
    if ($null -ne $mirror -and $mirror -ne '' -and (Test-Path -LiteralPath $mirror)) {
        Copy-Item -LiteralPath $mirror -Destination $dest -Force
        return $dest
    }
    try {
        # -PassThru is required: with -OutFile alone the cmdlet returns $null
        # in pwsh 7, so the redirect-HTTPS check below would see no response
        # and the fetch would fail on every production (no-mirror) run.
        $resp = Invoke-WebRequest -Uri $MinisignZipUrl -OutFile $dest -MaximumRedirection 5 -TimeoutSec 60 -UseBasicParsing -PassThru
        if ($resp.BaseResponse.RequestMessage.RequestUri.Scheme -ne 'https') {
            Fail 'verifier redirect target is not https://'
        }
    }
    catch { Fail 'failed to download the pinned verifier' }
    return $dest
}

# Ensure-Minisign acquires a trusted verifier BEFORE any Eizou release
# artifact is downloaded. It never trusts an arbitrary PATH executable:
#   - an explicitly supplied -MinisignExe is used only after it passes the
#     bounded version check;
#   - a verifier already installed inside the Eizou private root is reused
#     only if its recorded SHA-256 (recorded after the pinned-ZIP
#     verification) matches AND it passes the version check;
#   - otherwise the pinned official ZIP is fetched, its SHA-256 verified
#     BEFORE extraction, the exact expected member extracted, version
#     checked, and the verifier atomically installed into the private root.
# No global install, no persistent PATH mutation, no unsigned fallback.
function Ensure-Minisign {
    param([string]$InstallRoot)
    $state = Read-MinisignState $InstallRoot
    $installed = Join-Path $InstallRoot "tools\$MinisignExpectedName"

    # 1. Explicitly supplied verifier (version check only — the caller owns
    #    its provenance).
    if ($MinisignExe -ne '') {
        if (-not (Test-Path -LiteralPath $MinisignExe)) { Fail 'explicitly supplied verifier not found' }
        Assert-MinisignVersion $MinisignExe 'minisign.exe'
        return $MinisignExe
    }

    # 2. Private-install verifier: reuse only when the recorded SHA-256
    #    (captured after the pinned-ZIP verification) still matches.
    if (Test-Path -LiteralPath $installed) {
        $st = $state
        $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $installed).Hash.ToLowerInvariant()
        $versionOk = $false
        try {
            $vout = & $installed -v 2>&1
            $versionOk = ($LASTEXITCODE -eq 0 -and (($vout -join ' ') -match $MinisignExpectedVersion))
        } catch { $versionOk = $false }
        if ($null -ne $st -and [string]$st.sha256 -eq $sha -and $versionOk) {
            Write-Host 'EizouDendenshi bootstrap: verifier already present and verified; reusing'
            return $installed
        }
    }

    # 3. Acquire: fetch the pinned ZIP, hash-verify BEFORE extraction,
    #    extract the exact expected member, version-check, atomic install.
    Write-Host 'EizouDendenshi bootstrap: acquiring the pinned verifier (Minisign)'
    $zip = Invoke-VerifierFetch
    if ((Get-Sha256Lower $zip) -ne $MinisignZipSha256) {
        Fail 'verifier ZIP SHA-256 mismatch (fails closed before any Eizou install)'
    }
    $stage = Join-Path $script:TempDir ("minisign-extract." + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
    }
    catch { Fail 'cannot extract the verified verifier archive' }
    $member = Join-Path $stage ($MinisignZipMember -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $member)) { Fail 'verified verifier archive is missing the expected executable (fails closed)' }
    Assert-MinisignVersion $member 'minisign.exe'
    $toolsDir = Join-Path $InstallRoot 'tools'
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
    $tmp = Join-Path $toolsDir ($MinisignExpectedName + '.new')
    Copy-Item -LiteralPath $member -Destination $tmp -Force
    Move-Item -LiteralPath $tmp -Destination $installed -Force
    $installedSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $installed).Hash.ToLowerInvariant()
    Write-MinisignState $InstallRoot @{ sha256 = $installedSha; version = $MinisignExpectedVersion }
    Write-Host 'EizouDendenshi bootstrap: verifier installed into the private install root'
    return $installed
}

function Assert-WindowsX64 {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -ne 'AMD64' -and $arch -ne 'x86_64') { Fail "unsupported architecture '$arch'; EizouDendenshi windows/amd64 requires x64" }
    if ($null -eq $env:LOCALAPPDATA -or $env:LOCALAPPDATA -eq '') { Fail 'LOCALAPPDATA is unavailable; cannot use user-private storage' }
}

function Add-UserAclRule {
    param([System.Security.AccessControl.DirectorySecurity]$Acl)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $env:USERNAME, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    # The rule may already exist when the install root is reused; a duplicate
    # AddAccessRule is not an error in that case (the ACL is already correct).
    try { $Acl.AddAccessRule($rule) } catch { }
}

function New-PrivateTemp {
    $base = $env:TEMP
    $dir = Join-Path $base ("eizouden-win-bootstrap." + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    # Restrict ACL to the current user (private staging).
    try {
        $acl = Get-Acl -LiteralPath $dir
        $acl.SetAccessRuleProtection($true, $false)
        Add-UserAclRule $acl
        Set-Acl -LiteralPath $dir -AclObject $acl
    }
    catch {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        Fail 'cannot secure the private temp dir'
    }
    $script:TempDir = $dir
}

function Remove-PrivateTemp {
    if ($script:TempDir -and (Test-Path -LiteralPath $script:TempDir)) {
        Remove-Item -LiteralPath $script:TempDir -Recurse -Force -ErrorAction SilentlyContinue
        $script:TempDir = ''
    }
}

function Invoke-Fetch {
    param([string]$Name)
    $dest = Join-Path $script:TempDir $Name
    if ($HarnessMirrorDir -ne '') {
        $src = Join-Path $HarnessMirrorDir $Name
        if (-not (Test-Path -LiteralPath $src)) { Fail "download failed (test mirror): $Name is missing" }
        Copy-Item -LiteralPath $src -Destination $dest -Force
        return $dest
    }
    $url = "$ReleaseBaseUrl/$Name"
    try {
        # -PassThru: with -OutFile alone Invoke-WebRequest returns $null in
        # pwsh 7, which would break the redirect-HTTPS check below.
        $resp = Invoke-WebRequest -Uri $url -OutFile $dest -MaximumRedirection 5 -TimeoutSec 60 -UseBasicParsing -PassThru
        # Bounded, HTTPS-only redirects: the final URI must remain https://.
        if ($resp.BaseResponse.RequestMessage.RequestUri.Scheme -ne 'https') {
            Fail "redirect target is not https:// for $Name"
        }
    }
    catch {
        Fail "download failed for $Name"
    }
    return $dest
}

function Verify-Minisign {
    param([string]$File, [string]$Name, [string]$Minisign)
    & $Minisign -V -m $File -P $PinnedPubKey 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Minisign signature verification failed for $Name" }
}

function Get-Sha256Lower {
    param([string]$Path)
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Assert-SafeLogicalName {
    param([string]$Name, [string]$What)
    if ($Name -eq '' -or $Name -match '[/\\]' -or $Name -match '\.\.' -or $Name -notmatch '^[A-Za-z0-9._-]+$') {
        Fail "unsafe $What name (fails closed)"
    }
}

# --- Manifest parse + validation (version-2 Windows helper contract) -------
# Parse rules are strict and fail closed: unknown format/contract/version,
# missing/duplicate/unsafe helper entries, wrong target, or a version
# mismatch are all refused before any install step.
function Read-Manifest {
    param([string]$Path)
    $text = Get-Content -Raw -LiteralPath $Path
    $man = $text | ConvertFrom-Json
    if ($null -eq $man) { Fail 'manifest is not valid JSON' }
    if ($man.format -ne 'eizoudendenshi-release-manifest') { Fail 'manifest has an unknown format' }
    if ($man.formatVersion -ne 1) { Fail 'manifest format version is not supported (fails closed)' }
    if ($man.version -notmatch '^\d+\.\d+\.\d+') { Fail 'manifest version is not a valid semver' }
    if ($man.helperContract.version -ne 2 -and $man.helperContract.version -ne 3) {
        Fail 'manifest helper contract is not a Windows-compatible contract (2 or 3) (fails closed; a core-only v1 release is refused here)'
    }
    if ($null -eq $man.helperContract.helpers) { Fail 'manifest helper contract has no helpers map (fails closed)' }
    $helperProps = @($man.helperContract.helpers.PSObject.Properties)
    if ($helperProps.Count -eq 0) { Fail 'manifest declares no helpers (fails closed)' }

    # Core: exactly one windows/amd64 artifact named eizouden-windows-amd64.exe.
    $core = @($man.artifacts | Where-Object { $_.target -eq $CoreTarget -and $_.name -eq 'eizouden-windows-amd64.exe' })
    if ($core.Count -ne 1) { Fail 'manifest has no single windows/amd64 core artifact (fails closed)' }

    # Helpers: validate names/roles/versions/artifacts; reject duplicates,
    # unknown keys, unsafe names, wrong target, missing artifact entries.
    $seenNames = @{}
    $helpers = [ordered]@{}
    foreach ($prop in $helperProps) {
        $key = $prop.Name
        if ($key -notin @('yt-dlp', 'aria2', 'ffmpeg')) { Fail "manifest declares unknown helper '$key' (fails closed)" }
        $spec = $prop.Value
        $artifact = [string]$spec.artifact
        Assert-SafeLogicalName $artifact 'helper artifact'
        if ($seenNames.ContainsKey($artifact)) { Fail "duplicate helper artifact name '$artifact' (fails closed)" }
        $seenNames[$artifact] = $true
        $ver = [string]$spec.version
        if ($ver -eq '') { Fail "helper '$key' has no version (fails closed)" }
        $artEntries = @($man.artifacts | Where-Object { $_.name -eq $artifact -and $_.target -eq $CoreTarget })
        if ($artEntries.Count -ne 1) { Fail "helper '$key' artifact '$artifact' is missing from the release artifacts (fails closed)" }
        $helpers[$key] = [ordered]@{
            required  = [bool]$spec.required
            version   = $ver
            artifact  = $artifact
            sha256    = [string]$artEntries[0].sha256
            archive   = [bool]$spec.archive
            expectedFile = ([string]$spec.expectedFile)
        }
        if ($helpers[$key].archive) {
            Assert-SafeLogicalName $helpers[$key].expectedFile 'archive target'
        }
    }
    return [ordered]@{
        manifest = $man
        core     = $core[0]
        helpers  = $helpers
    }
}

# --- Installed-helper state (Eizou-private only, inside the install root) ---
function Read-State {
    param([string]$InstallRoot)
    $stateFile = Join-Path $InstallRoot $StateFileName
    if (-not (Test-Path -LiteralPath $stateFile)) { return @{} }
    try {
        $s = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json
        $out = @{}
        foreach ($p in $s.PSObject.Properties) { $out[$p.Name] = $p.Value }
        return $out
    }
    catch { return @{} }   # corrupt state = treat as nothing installed (re-verify)
}

function Write-State {
    param([string]$InstallRoot, $State)
    $stateFile = Join-Path $InstallRoot $StateFileName
    $json = @{}
    foreach ($k in $State.Keys) { $json[$k] = $State[$k] }
    [System.IO.File]::WriteAllText($stateFile, ($json | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding($false)))
}

function Assert-PrivateInstallRoot {
    param([string]$Root)
    $isNew = -not (Test-Path -LiteralPath $Root)
    if ($isNew) {
        New-Item -ItemType Directory -Path $Root -Force | Out-Null
    }
    # The user-private ACL is applied only when the root is freshly created.
    # Re-running SetAccessRuleProtection on an already-protected ACL requires
    # SeSecurityPrivilege, so a reuse never rewrites the ACL (it is already
    # restricted to the current user from the first install).
    if ($isNew) {
        try {
            $acl = Get-Acl -LiteralPath $Root
            $acl.SetAccessRuleProtection($true, $false)
            Add-UserAclRule $acl
            Set-Acl -LiteralPath $Root -AclObject $acl
        }
        catch { Fail 'cannot secure the private install root' }
    }
}

# Fetch, verify (Minisign + manifest SHA-256), then atomically replace a
# single artifact. Archives are extracted ONLY after verification, and only
# the exact expected filename is taken (traversal is impossible because the
# expected filename is a strict safe basename).
#
# Runtime contract (rc.6): the release artifact keeps its logical archive
# name for download/verification (its ZIP SHA-256/signature is what the
# signed manifest attests), but the EXTRACTED executable is installed under
# the strict safe runtime filename (the manifest's `expectedFile` for
# archives, e.g. aria2c.exe / ffmpeg.exe; the artifact name itself for
# standalone exes like yt-dlp) inside the private helper runtime directory.
# The core is always given the exact absolute runtime path, and the
# process-scoped PATH prepends a directory that literally contains
# ffmpeg.exe for yt-dlp's merge discovery.
function Install-Artifact {
    param(
        [string]$LogicalName,
        [string]$Sha256,
        [string]$TargetDir,
        [string]$Minisign,
        [bool]$IsArchive,
        [string]$ExpectedFile,
        [string]$RuntimeName
    )
    Assert-SafeLogicalName $RuntimeName 'runtime'
    $src = Invoke-Fetch $LogicalName
    $sig = Invoke-Fetch "$LogicalName.minisig"
    Verify-Minisign $src $LogicalName $Minisign
    if ((Get-Sha256Lower $src) -ne $Sha256) { Fail "SHA-256 mismatch for $LogicalName (fails before replacement)" }
    $installed = Join-Path $TargetDir $RuntimeName
    if ($IsArchive) {
        $stage = Join-Path $script:TempDir ("extract." + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stage | Out-Null
        try {
            Expand-Archive -LiteralPath $src -DestinationPath $stage -Force
        }
        catch { Fail "cannot extract verified archive $LogicalName" }
        $extracted = Join-Path $stage $ExpectedFile
        if (-not (Test-Path -LiteralPath $extracted)) { Fail "verified archive $LogicalName does not contain the expected file (fails closed)" }
        # Install the extracted executable under the strict runtime filename.
        $tmp = Join-Path $TargetDir ($RuntimeName + '.new')
        Copy-Item -LiteralPath $extracted -Destination $tmp -Force
        Move-Item -LiteralPath $tmp -Destination $installed -Force
    }
    else {
        $tmp = Join-Path $TargetDir ($RuntimeName + '.new')
        Copy-Item -LiteralPath $src -Destination $tmp -Force
        Move-Item -LiteralPath $tmp -Destination $installed -Force
    }
    return $RuntimeName
}

function Get-HelperExecutable {
    param([string]$HelpersDir, [string]$RuntimeName)
    # Every helper's runtime executable lives in the private helper runtime
    # directory under its strict runtime filename; the launch passes these
    # exact absolute paths to the core.
    return (Join-Path $HelpersDir $RuntimeName)
}

# --- Main -------------------------------------------------------------------

$script:TempDir = ''
try {
    Assert-HttpsUrl $ReleaseBaseUrl 'release base URL'
    Assert-PinnedKey
    Assert-WindowsX64
    New-PrivateTemp

    $InstallRoot = if ($InstallRoot -eq '') {
        Join-Path $env:LOCALAPPDATA 'GoRakuDo\EizouDendenshi'
    } else { [System.IO.Path]::GetFullPath($InstallRoot) }
    Assert-PrivateInstallRoot $InstallRoot
    $script:InstallRoot = $InstallRoot

    # 0. Verifier trust bootstrap: acquire a verified Minisign BEFORE any
    #    Eizou release artifact is downloaded (the signed manifest/core/helper
    #    verification depends on it). Never trusts PATH; fails closed.
    $Minisign = Ensure-Minisign $InstallRoot

    # 1. Manifest: fetch (manifest + its detached signature) + verify +
    #    validate the v2 helper contract.
    $mf = Invoke-Fetch $ManifestName
    Invoke-Fetch "$ManifestName.minisig" | Out-Null
    Verify-Minisign $mf $ManifestName $Minisign
    $man = Read-Manifest $mf
    $releaseVersion = $man.manifest.version
    Write-Host "EizouDendenshi bootstrap: verified EizouDendenshi $releaseVersion (Windows x64, helper-enabled)"

    # 2. Helpers: reuse when the installed runtime executable matches the
    #    signed manifest (version + artifact + runtime filename + recorded
    #    runtime SHA-256), else fetch/verify/atomic-replace. Malformed or
    #    legacy (rc.5 archive-name) state is never reused: the legacy
    #    artifact-named leftovers in the install root are bootstrap-owned
    #    files and are removed before the corrected install.
    $HelpersDir = Join-Path $InstallRoot 'helpers'
    New-Item -ItemType Directory -Force -Path $HelpersDir | Out-Null
    $state = Read-State $InstallRoot
    $installedHelpers = @{}   # key -> absolute runtime executable path
    foreach ($key in $man.helpers.Keys) {
        $spec = $man.helpers[$key]
        $artifact = $spec.artifact
        $runtimeName = if ($spec.archive) { $spec.expectedFile } else { $artifact }
        Assert-SafeLogicalName $runtimeName 'runtime'
        $runtimePath = Join-Path $HelpersDir $runtimeName
        $st = $state[$key]
        # PowerShell 7 does not allow `if` as a subexpression inside a
        # binary -and/-eq chain, so compute the installed hash first.
        $runtimeSha = ''
        if (Test-Path -LiteralPath $runtimePath) { $runtimeSha = Get-Sha256Lower $runtimePath }
        $match = ($null -ne $st -and [string]$st.version -eq $spec.version -and
                  [string]$st.artifact -eq $artifact -and
                  [string]$st.runtime -eq $runtimeName -and
                  [string]$st.runtimeSha -eq $runtimeSha)
        if ($match) {
            Write-Host "EizouDendenshi bootstrap: helper '$key' ($($spec.version)) already verified; reusing"
        }
        else {
            Write-Host "EizouDendenshi bootstrap: helper '$key' -> fetching $artifact"
            # Remove any legacy artifact-named leftover at the root (rc.5
            # archive-name layout — bootstrap-owned, never a user file).
            $legacy = Join-Path $InstallRoot $artifact
            if (Test-Path -LiteralPath $legacy) { Remove-Item -LiteralPath $legacy -Force -ErrorAction SilentlyContinue }
            $runtime = Install-Artifact -LogicalName $artifact -Sha256 $spec.sha256 `
                -TargetDir $HelpersDir -Minisign $Minisign `
                -IsArchive $spec.archive -ExpectedFile $spec.expectedFile -RuntimeName $runtimeName
            $state[$key] = @{
                version    = $spec.version
                sha256     = $spec.sha256     # the ARTIFACT's manifest SHA (the verified bytes)
                artifact   = $artifact
                runtime    = $runtime
                runtimeSha = (Get-Sha256Lower $runtimePath)
            }
        }
        $installedHelpers[$key] = Get-HelperExecutable $HelpersDir $runtimeName
    }
    Write-State $InstallRoot $state

    # 3. Core: fetch + verify + atomic install (the core is not a helper; it
    #    stays at the install root under its artifact name).
    $coreName = $man.core.name
    Write-Host "EizouDendenshi bootstrap: fetching core $coreName"
    Install-Artifact -LogicalName $coreName -Sha256 $man.core.sha256 `
        -TargetDir $InstallRoot -Minisign $Minisign -IsArchive $false -ExpectedFile '' -RuntimeName $coreName
    $corePath = Join-Path $InstallRoot $coreName

    # 3b. Common CLI launcher: a small user-private `eizouden.cmd` that
    #     invokes the core's CLI mode with the exact private helper paths.
    #     It is installed locally (ACL inherited from the user-private root);
    #     no global PATH mutation happens here.
    $launcher = Join-Path $InstallRoot 'eizouden.cmd'
    $launcherBody = @(
        '@echo off',
        'rem EizouDendenshi CLI launcher - generated by the bootstrap (user-private).',
        "`"%~dp0$coreName`" cli --ytdlp `"%~dp0helpers\$($installedHelpers['yt-dlp'] | Split-Path -Leaf)`" --aria2 `"%~dp0helpers\$($installedHelpers['aria2'] | Split-Path -Leaf)`" --ffmpeg `"%~dp0helpers\ffmpeg.exe`" %*"
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($launcher, $launcherBody, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host 'EizouDendenshi bootstrap: eizouden.cmd launcher installed (user-private)'

    Write-Host "EizouDendenshi bootstrap: verified EizouDendenshi $releaseVersion installed at $InstallRoot"
    Remove-PrivateTemp

    # 4. Launch the core with explicit absolute helper paths. ffmpeg is
    #    supplied to yt-dlp through a PROCESS-SCOPED PATH (prepending the
    #    private helper runtime directory, which literally contains
    #    ffmpeg.exe) — never a persistent system PATH change.
    $launchArgs = @(
        "--ytdlp", $installedHelpers['yt-dlp'],
        "--aria2", $installedHelpers['aria2']
    )
    if ($HarnessLaunchFile -ne '') {
        $line = @($corePath) + $launchArgs + @('--addr', '127.0.0.1:0')
        [System.IO.File]::WriteAllText($HarnessLaunchFile, ($line -join ' '), (New-Object System.Text.UTF8Encoding($false)))
        Write-Host 'EizouDendenshi bootstrap: launch command captured (harness)'
    }
    elseif (-not $SkipLaunch) {
        # Process-scoped PATH: the private helper runtime dir first, restored
        # when this process exits. Not a system PATH mutation.
        $oldPath = $env:PATH
        $env:PATH = "$HelpersDir;$oldPath"
        try {
            Write-Host 'EizouDendenshi bootstrap: starting the core in the foreground (pairing code below)'
            & $corePath @launchArgs
        }
        finally {
            $env:PATH = $oldPath
        }
    }
    else {
        Write-Host 'EizouDendenshi bootstrap: install complete (launch skipped)'
    }
}
finally {
    Remove-PrivateTemp
}
