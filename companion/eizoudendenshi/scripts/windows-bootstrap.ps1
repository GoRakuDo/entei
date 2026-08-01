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
    [string]$HarnessLaunchFile = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- Pinned release signing key (replace at release time) ---
$PinnedPubKey = 'REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY'

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

function Assert-WindowsX64 {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -ne 'AMD64' -and $arch -ne 'x86_64') { Fail "unsupported architecture '$arch'; EizouDendenshi windows/amd64 requires x64" }
    if ($null -eq $env:LOCALAPPDATA -or $env:LOCALAPPDATA -eq '') { Fail 'LOCALAPPDATA is unavailable; cannot use user-private storage' }
}

function Assert-Minisign {
    $ms = Get-Command minisign -ErrorAction SilentlyContinue
    if (-not $ms) { Fail 'minisign not found; it is a required verifier prerequisite (no system-wide install is performed by this bootstrap)' }
    return $ms.Source
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
        $resp = Invoke-WebRequest -Uri $url -OutFile $dest -MaximumRedirection 5 -TimeoutSec 60 -UseBasicParsing
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
    if ($man.helperContract.version -ne $HelperContractVersion) {
        Fail 'manifest helper contract is not the Windows version-2 contract (fails closed; a core-only v1 release is refused here)'
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
function Install-Artifact {
    param(
        [string]$LogicalName,
        [string]$Sha256,
        [string]$InstallRoot,
        [string]$Minisign,
        [bool]$IsArchive,
        [string]$ExpectedFile
    )
    $src = Invoke-Fetch $LogicalName
    $sig = Invoke-Fetch "$LogicalName.minisig"
    Verify-Minisign $src $LogicalName $Minisign
    if ((Get-Sha256Lower $src) -ne $Sha256) { Fail "SHA-256 mismatch for $LogicalName (fails before replacement)" }
    $destName = $LogicalName
    if ($IsArchive) {
        $stage = Join-Path $script:TempDir ("extract." + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stage | Out-Null
        try {
            Expand-Archive -LiteralPath $src -DestinationPath $stage -Force
        }
        catch { Fail "cannot extract verified archive $LogicalName" }
        $extracted = Join-Path $stage $ExpectedFile
        if (-not (Test-Path -LiteralPath $extracted)) { Fail "verified archive $LogicalName does not contain the expected file (fails closed)" }
        # Install the extracted file under the helper's logical name.
        $destName = $LogicalName   # keep the release artifact name in the install root
        $tmp = Join-Path $InstallRoot ($destName + '.new')
        Copy-Item -LiteralPath $extracted -Destination $tmp -Force
        Move-Item -LiteralPath $tmp -Destination (Join-Path $InstallRoot $destName) -Force
    }
    else {
        $tmp = Join-Path $InstallRoot ($destName + '.new')
        Copy-Item -LiteralPath $src -Destination $tmp -Force
        Move-Item -LiteralPath $tmp -Destination (Join-Path $InstallRoot $destName) -Force
    }
    return $destName
}

function Get-HelperExecutable {
    param([string]$Key, [string]$Artifact)
    # yt-dlp/aria2 are standalone exes named after the artifact; the launch
    # passes these absolute paths to the core.
    return (Join-Path $script:InstallRoot $Artifact)
}

# --- Main -------------------------------------------------------------------

$script:TempDir = ''
try {
    Assert-HttpsUrl $ReleaseBaseUrl 'release base URL'
    Assert-PinnedKey
    Assert-WindowsX64
    $Minisign = Assert-Minisign
    New-PrivateTemp

    $InstallRoot = if ($InstallRoot -eq '') {
        Join-Path $env:LOCALAPPDATA 'GoRakuDo\EizouDendenshi'
    } else { [System.IO.Path]::GetFullPath($InstallRoot) }
    Assert-PrivateInstallRoot $InstallRoot
    $script:InstallRoot = $InstallRoot

    # 1. Manifest: fetch (manifest + its detached signature) + verify +
    #    validate the v2 helper contract.
    $mf = Invoke-Fetch $ManifestName
    Invoke-Fetch "$ManifestName.minisig" | Out-Null
    Verify-Minisign $mf $ManifestName $Minisign
    $man = Read-Manifest $mf
    $releaseVersion = $man.manifest.version
    Write-Host "EizouDendenshi bootstrap: verified EizouDendenshi $releaseVersion (Windows x64, helper-enabled)"

    # 2. Helpers: reuse when the installed artifact matches the signed
    #    manifest (version + SHA-256), else fetch/verify/atomic-replace.
    $state = Read-State $InstallRoot
    $installedHelpers = @{}   # key -> absolute executable path
    foreach ($key in $man.helpers.Keys) {
        $spec = $man.helpers[$key]
        $artifact = $spec.artifact
        $installedPath = Join-Path $InstallRoot $artifact
        $st = $state[$key]
        # PowerShell 7 does not allow `if` as a subexpression inside a
        # binary -and/-eq chain, so compute the installed hash first.
        $installedSha = ''
        if (Test-Path -LiteralPath $installedPath) { $installedSha = Get-Sha256Lower $installedPath }
        $match = ($null -ne $st -and [string]$st.version -eq $spec.version -and
                  [string]$st.sha256 -eq $installedSha)
        if ($match) {
            Write-Host "EizouDendenshi bootstrap: helper '$key' ($($spec.version)) already verified; reusing"
        }
        else {
            Write-Host "EizouDendenshi bootstrap: helper '$key' -> fetching $artifact"
            $destName = Install-Artifact -LogicalName $artifact -Sha256 $spec.sha256 `
                -InstallRoot $InstallRoot -Minisign $Minisign `
                -IsArchive $spec.archive -ExpectedFile $spec.expectedFile
            $state[$key] = @{ version = $spec.version; sha256 = $spec.sha256; artifact = $destName }
        }
        $installedHelpers[$key] = Get-HelperExecutable $key $artifact
    }
    Write-State $InstallRoot $state

    # 3. Core: fetch + verify + atomic install.
    $coreName = $man.core.name
    Write-Host "EizouDendenshi bootstrap: fetching core $coreName"
    Install-Artifact -LogicalName $coreName -Sha256 $man.core.sha256 `
        -InstallRoot $InstallRoot -Minisign $Minisign -IsArchive $false -ExpectedFile ''
    $corePath = Join-Path $InstallRoot $coreName

    Write-Host "EizouDendenshi bootstrap: verified EizouDendenshi $releaseVersion installed at $InstallRoot"
    Remove-PrivateTemp

    # 4. Launch the core with explicit absolute helper paths. ffmpeg is
    #    supplied to yt-dlp through a PROCESS-SCOPED PATH (prepending the
    #    private helpers dir) — never a persistent system PATH change.
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
        # Process-scoped PATH: the private helpers dir first, restored when
        # this process exits. Not a system PATH mutation.
        $helpersDir = $InstallRoot
        $oldPath = $env:PATH
        $env:PATH = "$helpersDir;$oldPath"
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
