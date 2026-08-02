# EizouDendenshi ED-2D Stage A release test harness.
#
# Runs on the Windows dev machine (pwsh). All temporary material — Minisign
# keys, signatures, release copies, fake Termux prefixes, logs — lives under
# the temporary work root (default A:\Temp\opencode\ed2d-release-test) and
# is removed at the end unless -Keep is passed. Nothing is written inside
# the repository: the harness only reads the repo scripts and never modifies
# them.
#
# Coverage (per ED-2D Stage A):
#   Dynamic (requires a POSIX sh, e.g. Git for Windows, AND a minisign
#   binary; the harness provisions the official minisign 0.12 win64 build
#   into A:\Temp\opencode when it is not already available):
#     - successful verified install -> foreground start -> pairing code
#     - release-identity: startup banner reports the requested release
#       version and agrees with the manifest version
#     - plain `build` (no -Version) keeps the dev default (0.2.0) in the
#       binary banner
#     - tampered manifest      -> failure BEFORE install
#     - tampered binary        -> failure BEFORE install
#     - missing signature      -> failure BEFORE install
#     - wrong architecture     -> failure BEFORE install
#     - unsafe (non-HTTPS) URL -> failure BEFORE install
#     - unpinned template key  -> failure BEFORE install (fail closed)
#     - unsupported helper contract -> failure BEFORE install (fail closed)
#     - non-Termux environment -> failure BEFORE install
#     - SHA-256 mismatch with valid signatures -> failure BEFORE install
#   Static fail-closed checks on the bootstrap template always run, so the
#   harness is never empty even when the dynamic tools are unavailable.
#
# The success case runs a synthetic release whose "android/arm64" artifact
# is the companion's own windows/amd64 build (same binary, different target
# label) so the real companion binary can be exec'd and observed printing a
# pairing code on this machine. Signature/SHA/manifest logic is identical;
# real android/arm64 ELF execution remains the Stage B clean-Termux gate.
#
# The release under test uses a test-only version ($script:ReleaseVersion,
# 9.9.9) distinct from the api.Version dev default (0.2.0): the banner checks
# only prove something if the injected version is observable as different
# from what an uninjected build would print.

[CmdletBinding()]
param(
    [string]$WorkRoot = 'A:\Temp\opencode\ed2d-release-test',
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ReleasePs1 = Join-Path $PSScriptRoot 'release.ps1'
$BootstrapTemplate = Join-Path $PSScriptRoot 'termux-bootstrap.sh'
$BootstrapText = [System.IO.File]::ReadAllText($BootstrapTemplate)

$Results = [System.Collections.Generic.List[object]]::new()
$script:FailCount = 0
function Check([string]$Name, $Ok, [string]$Detail) {
    $b = $false
    try { $b = [bool]$Ok }
    catch { $Detail = "bool-convert-error ($($Ok.GetType().FullName)): $($_.Exception.Message) | $Detail" }
    $Results.Add([pscustomobject]@{ Case = $Name; Result = $(if ($b) { 'PASS' } else { 'FAIL' }); Detail = $Detail })
    if (-not $b) { $script:FailCount++ }
}

# --- Tool detection ---------------------------------------------------------

function Find-Sh {
    foreach ($cand in @(
            'C:\Program Files\Git\bin\sh.exe',
            'C:\Program Files\Git\usr\bin\sh.exe',
            (Get-Command sh -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
        )) {
        if ($cand -and (Test-Path -LiteralPath $cand)) { return $cand }
    }
    return $null
}

function Find-Minisign {
    $found = Get-Command minisign -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
    if ($found) { return $found }
    foreach ($cand in @(
            'A:\Temp\opencode\minisign-bin\minisign-win64\x86_64\minisign.exe',
            'A:\Temp\opencode\minisign.exe'
        )) {
        if (Test-Path -LiteralPath $cand) { return $cand }
    }
    return $null
}

function Get-Minisign {
    $existing = Find-Minisign
    if ($existing) { return $existing }
    # Provision the official minisign 0.12 win64 build into A:\Temp\opencode.
    $zip = 'A:\Temp\opencode\minisign-0.12-win64.zip'
    $dest = 'A:\Temp\opencode\minisign-bin'
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri 'https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip' -OutFile $zip
        Expand-Archive -Path $zip -DestinationPath $dest -Force
        $exe = 'A:\Temp\opencode\minisign-bin\minisign-win64\x86_64\minisign.exe'
        if (Test-Path -LiteralPath $exe) { return $exe }
    }
    catch {
        Write-Warning "minisign provisioning failed: $($_.Exception.Message)"
    }
    return $null
}

# --- Static fail-closed checks (always run) ---------------------------------

function Static-Checks {
    $boot = $BootstrapText
    # Code-only text: the header documentation itself mentions "curl|sh"
    # when describing the prohibition, so comments must be excluded.
    $code = ($boot -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    Check 'static: no curl|sh / pipe-to-shell' (
        $code -notmatch 'curl[^\r\n]*(?<!\|)\|\s*(?!\|)' -and
        $code -notmatch '\|\s*(sh|bash)\b') 'template must never pipe remote code into a shell'
    Check 'static: pinned-key placeholder present and rejected' (
        $boot.Contains('REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY') -and
        $boot.Contains('refusing to run an unpinned bootstrap')) 'unreplaced template must fail closed'
    Check 'static: HTTPS-only release URL validation' (
        $boot.Contains('must be https://') -and $boot.Contains('refusing non-HTTPS download')) 'non-HTTPS base URL must be rejected'
    # Ordering is asserted inside main()'s body (function definitions
    # precede it in the file): the SHA-256 check and the signature checks
    # must come before the install call.
    $mainIdx = $boot.IndexOf('main() {')
    $body = $boot.Substring($mainIdx)
    $iSig = $body.IndexOf('verify_minisign')
    $iSha = $body.IndexOf('sha256sum -c')
    $iInst = $body.IndexOf('install_verified_core')
    Check 'static: verify happens before install' (
        $iSig -ge 0 -and $iSha -ge 0 -and $iInst -gt $iSig -and $iInst -gt $iSha) 'signature and SHA-256 checks must precede the install call in main()'
    Check 'static: prerequisites limited to verifier/download tools' (
        $boot.Contains('pkg install -y minisign curl coreutils') -and
        $boot -notmatch 'pkg install[^\r\n]*(yt-dlp|aria2|ffmpeg)' -and
        $boot -notmatch 'termux-wake-lock') 'no helper installs or permission prompts in the bootstrap'
    Check 'static: no privilege escalation' ($boot -notmatch '\bsu\b' -and $boot -notmatch 'sudo') 'no su/sudo in template'
    Check 'static: private temp dir with cleanup' (
        $boot.Contains('mktemp -d') -and $boot.Contains('chmod 700') -and $boot.Contains('trap cleanup')) 'mode-700 temp dir removed on exit'
    Check 'static: app-private atomic install path' (
        $boot.Contains('var/lib/eizouden') -and $boot.Contains('mv -f')) 'install under $PREFIX/var/lib/eizouden'
    Check 'static: foreground pairing start' (
        $boot.Contains('exec "') -and $boot.IndexOf('pairing', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) 'bootstrap must exec the core in the foreground'
    Check 'static: helper contract fails closed' ($boot.Contains('fails closed') -and $boot.Contains('minimumVersions')) 'unknown contract must be refused'
    # The production fetch must follow GitHub Release 302 redirects (release
    # asset URLs redirect to the CDN; an unfollowed redirect would save the
    # 302 response body and fail Minisign verification — hit live on the
    # rc.1 Termux clean-install). Every curl invocation must use --location
    # with a positive bounded --max-redirs and --proto-redir =https (no
    # silent HTTPS->HTTP redirect downgrade) and keep --fail plus the
    # timeout/retry flags.
    $curlInvocations = @($code -split "`n" | Where-Object { $_ -match 'curl\s+-\S' })
    $curlFollowsRedirects = $curlInvocations.Count -gt 0
    foreach ($cl in $curlInvocations) {
        if ($cl -notmatch '--location' -or
            $cl -notmatch '--max-redirs\s+[1-9]\d*' -or
            $cl -notmatch '--proto-redir\s*=\s*https' -or
            $cl -notmatch '(-fsS\b|--fail(?!-))' -or
            $cl -notmatch '--connect-timeout' -or
            $cl -notmatch '--max-time' -or
            $cl -notmatch '--retry') { $curlFollowsRedirects = $false }
    }
    Check 'static: curl fetch follows redirects (--location, bounded --max-redirs, --proto-redir =https) and keeps --fail/timeout/retry' $curlFollowsRedirects 'GitHub Release assets answer 302; a bootstrap that stops following redirects cannot regress unnoticed'
    Check 'static: release.ps1 takes key via explicit arg/env only' (
        (Get-Content -Raw (Join-Path $PSScriptRoot 'release.ps1')).Contains('EIZOUDEN_MINISIGN_KEY')) 'no key file inside the repo'
}

# --- Dynamic suite ----------------------------------------------------------

function Invoke-BootstrapCase {
    param(
        [string]$Name,
        [string]$BootstrapPath,
        [string]$Url,
        [hashtable]$Env,
        [switch]$ExpectSuccess,
        [string]$ExpectErrorPattern = '',
        [string]$PrefixPath
    )
    $outFile = Join-Path $script:LogsDir "$Name.out.log"
    $errFile = Join-Path $script:LogsDir "$Name.err.log"
    $runner = Join-Path $script:WorkDir "$Name-runner.sh"
    "#!/bin/sh`nexec sh `"`$1`" `"`$2`"" | Set-Content -LiteralPath $runner -Encoding ascii -NoNewline

    $proc = Start-Process -FilePath $script:ShPath `
        -ArgumentList @("`"$runner`"", "`"$BootstrapPath`"", "`"$Url`"") `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
        -PassThru -NoNewWindow -Environment $Env

    $installed = Join-Path $PrefixPath "var\lib\eizouden\eizouden-android-arm64"

    if ($ExpectSuccess) {
        # The core binary runs forever; wait for the pairing code, then kill
        # the whole process tree.
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        $sawPairing = $false
        while ([DateTime]::UtcNow -lt $deadline -and -not $proc.HasExited) {
            $out = if (Test-Path -LiteralPath $outFile) { Get-Content -Raw -LiteralPath $outFile } else { '' }
            if ($out -match 'Pairing code:\s*\d{6}') { $sawPairing = $true; break }
            Start-Sleep -Milliseconds 300
        }
        if ($sawPairing) {
            & 'C:\Windows\System32\taskkill.exe' /T /F /PID $proc.Id 2>&1 | Out-Null
        }
        $proc.WaitForExit()
        $out = (Get-Content -Raw -LiteralPath $outFile -ErrorAction SilentlyContinue) +
            (Get-Content -Raw -LiteralPath $errFile -ErrorAction SilentlyContinue)
        Check "${Name}: foreground pairing code printed" $sawPairing ($out -replace '\s+', ' ')
        Check "${Name}: verified-install message printed" ($out -match ('verified EizouDendenshi {0} installed' -f [regex]::Escape($script:ManifestVersion))) ($out -replace '\s+', ' ')
        Check "${Name}: core installed in app-private storage" (Test-Path -LiteralPath $installed) "expected $installed"
        # Release-identity display contract: the startup banner must report
        # the version the release was requested with, and it must agree with
        # the version parsed from the signed manifest. With the test-only
        # version 9.9.9, an uninjected (dev-default 0.2.0) binary fails here.
        $bannerVersion = $null
        if ($out -match 'EizouDendenshi ED-2B \(([^)]+)\) listening on http') { $bannerVersion = $Matches[1] }
        Check "${Name}: startup banner reports the requested release version" ($bannerVersion -eq $script:ReleaseVersion) "banner version '$bannerVersion' vs requested '$($script:ReleaseVersion)'"
        Check "${Name}: startup banner version agrees with manifest version" ($bannerVersion -eq $script:ManifestVersion) "banner '$bannerVersion' vs manifest '$($script:ManifestVersion)'"
        if (Test-Path -LiteralPath $installed) {
            $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $installed).Hash.ToLowerInvariant()
            $want = $script:ManifestAndroidSha
            Check "${Name}: installed bytes match signed manifest" ($got -eq $want) "got $got want $want"
        }
    }
    else {
        if (-not $proc.WaitForExit(90000)) {
            & 'C:\Windows\System32\taskkill.exe' /T /F /PID $proc.Id 2>&1 | Out-Null
            $proc.WaitForExit()
            Check "${Name}: process exited (failure case)" $false 'did not exit within 90s'
        }
        else {
            $out = (Get-Content -Raw -LiteralPath $outFile -ErrorAction SilentlyContinue) +
                (Get-Content -Raw -LiteralPath $errFile -ErrorAction SilentlyContinue)
            Check "${Name}: exited non-zero" ($proc.ExitCode -ne 0) "exit=$($proc.ExitCode)"
            if ($ExpectErrorPattern) {
                Check "${Name}: expected error surfaced" ($out -match $ExpectErrorPattern) "looking for /$ExpectErrorPattern/ in: $($out -replace '\s+',' ')"
            }
            Check "${Name}: nothing installed (failure-before-install)" (-not (Test-Path -LiteralPath $installed)) "must not exist: $installed"
        }
    }
    # The private temp dir must always be cleaned up, success or failure.
    $leftovers = @(Get-ChildItem -LiteralPath $script:TempDir -Filter 'eizouden-bootstrap.*' -ErrorAction SilentlyContinue)
    Check "${Name}: private temp dir cleaned" ($leftovers.Count -eq 0) ('leftover: ' + ($leftovers.Name -join ','))
}

function New-BootstrapCopy {
    param([string]$DestDir, [switch]$KeepPlaceholder)
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    $dest = Join-Path $DestDir 'eizouden-bootstrap.sh'
    if ($KeepPlaceholder) {
        [System.IO.File]::WriteAllText($dest, $BootstrapText, (New-Object System.Text.UTF8Encoding($false)))
    }
    else {
        $text = $BootstrapText.Replace('REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY', $script:PubKey)
        [System.IO.File]::WriteAllText($dest, $text, (New-Object System.Text.UTF8Encoding($false)))
    }
    return $dest
}

function New-Prefix {
    param([string]$Name)
    $p = Join-Path $script:WorkDir "prefix-$Name"
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    return $p
}

function Copy-Mirror {
    param([string]$Name)
    $src = Join-Path $script:WorkDir 'dist2'
    $dst = Join-Path $script:MirrorDir $Name
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    foreach ($f in @('eizouden-manifest.json', 'eizouden-manifest.json.minisig',
            'eizouden-android-arm64', 'eizouden-android-arm64.minisig')) {
        Copy-Item (Join-Path $src $f) (Join-Path $dst $f)
    }
    return $dst
}

function Sign-Manifest {
    param([string]$Dir)
    Remove-Item (Join-Path $Dir 'eizouden-manifest.json.minisig') -Force -ErrorAction SilentlyContinue
    & $script:Minisign -S -m (Join-Path $Dir 'eizouden-manifest.json') -s $script:KeyPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "re-sign manifest failed (exit $LASTEXITCODE)" }
}

function Sign-Core {
    param([string]$Dir)
    Remove-Item (Join-Path $Dir 'eizouden-android-arm64.minisig') -Force -ErrorAction SilentlyContinue
    & $script:Minisign -S -m (Join-Path $Dir 'eizouden-android-arm64') -s $script:KeyPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "re-sign core failed (exit $LASTEXITCODE)" }
}

function Get-ManifestText {
    param([string]$Dir)
    return [System.IO.File]::ReadAllText((Join-Path $Dir 'eizouden-manifest.json'))
}

function Set-ManifestText {
    param([string]$Dir, [string]$Text)
    [System.IO.File]::WriteAllText((Join-Path $Dir 'eizouden-manifest.json'), $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function New-CaseEnv {
    param([string]$Mirror, [string]$Prefix)
    $env = @{}
    $script:BaseEnv.GetEnumerator() | ForEach-Object { $env[$_.Key] = $_.Value }
    $env.EIZOU_MIRROR_DIR = $Mirror
    # Test mode: the harness stands in for Termux and supplies PREFIX.
    $env.PREFIX = $Prefix
    # Bind the foreground core to an ephemeral loopback port (isolation);
    # never the production default 127.0.0.1:4322.
    $env.EIZOU_TEST_ADDR = '127.0.0.1:0'
    return $env
}

# --- Termux helper-enabled bootstrap suite (ED-2F/ED-2G v3 contract) --------

function New-FakeArchive {
    param([string]$ZipPath, [string]$InnerName)
    $stage = Join-Path $script:WorkDir ("arch-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Set-Content -LiteralPath (Join-Path $stage $InnerName) -Value 'fake helper bytes' -Encoding ascii
    Compress-Archive -Path (Join-Path $stage $InnerName) -DestinationPath $ZipPath -Force
    Remove-Item -LiteralPath $stage -Recurse -Force
}

function New-FakeTermuxPrefix {
    param([string]$Name, [hashtable]$Versions)
    $p = Join-Path $script:WorkDir "prefix-helper-$Name"
    New-Item -ItemType Directory -Force -Path (Join-Path $p 'bin') | Out-Null
    $mk = {
        param($cmd, $body)
        $f = Join-Path $p "bin\$cmd"
        [System.IO.File]::WriteAllText($f, $body, (New-Object System.Text.UTF8Encoding($false)))
        & $script:ShPath -c "chmod +x `"$f`""
    }
    & $mk 'yt-dlp' "#!/bin/sh`necho $($Versions.ytdlp)"
    & $mk 'aria2c' "#!/bin/sh`necho aria2 version $($Versions.aria2)"
    & $mk 'ffmpeg' "#!/bin/sh`necho ffmpeg version $($Versions.ffmpeg)"
    return $p
}

function Invoke-TermuxHelperCase {
    param(
        [string]$Name,
        [string]$BootstrapPath,
        [string]$Prefix,
        [string]$InputFile,
        [switch]$ExpectSuccess,
        [string]$ExpectErrorPattern = ''
    )
    $outFile = Join-Path $script:LogsDir "$Name.out.log"
    $errFile = Join-Path $script:LogsDir "$Name.err.log"
    $runner = Join-Path $script:WorkDir "$Name-helper-runner.sh"
    "#!/bin/sh`nexec sh `"`$1`" `"`$2`" < `"`$3`"" | Set-Content -LiteralPath $runner -Encoding ascii -NoNewline
    $envH = @{
        EIZOU_TEST = '1'
        EIZOU_BOOTSTRAP_SKIP_PKG = '1'
        EIZOU_MIRROR_DIR = $script:HelperMirror
        EIZOU_TEST_ADDR = '127.0.0.1:0'
        PREFIX = $Prefix
        TMPDIR = $script:TempDir
        # The fake helper commands live in the prefix bin; it must come
        # FIRST so no real machine helper shadows them.
        PATH = (Join-Path $Prefix 'bin') + ';' + $script:GitBins + ';' + (Split-Path $script:Minisign) + ';' + $env:PATH
    }
    $proc = Start-Process -FilePath $script:ShPath -ArgumentList @("`"$runner`"", "`"$BootstrapPath`"", "`"$($script:HelperBaseUrl)`"", "`"$InputFile`"") `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -NoNewWindow -Environment $envH
    $exited = $proc.WaitForExit(90000)
    if (-not $exited) {
        & 'C:\Windows\System32\taskkill.exe' /T /F /PID $proc.Id 2>&1 | Out-Null
        $proc.WaitForExit()
        Check "${Name}: process exited" $false 'did not exit within 90s'
        return
    }
    $out = (Get-Content -Raw -LiteralPath $outFile -ErrorAction SilentlyContinue) +
        (Get-Content -Raw -LiteralPath $errFile -ErrorAction SilentlyContinue)
    $core = Join-Path $Prefix "var\lib\eizouden\eizouden-android-arm64"
    $launcher = Join-Path $Prefix "bin\grkd-edds"
    if ($ExpectSuccess) {
        Check "${Name}: exited zero" ($proc.ExitCode -eq 0) "exit=$($proc.ExitCode): $($out -replace '\s+',' ')"
        Check "${Name}: helpers verified" ($out -match 'helper .* version .* OK') ($out -replace '\s+', ' ')
        Check "${Name}: core installed in app-private storage" (Test-Path -LiteralPath $core) "expected $core"
        Check "${Name}: CLI launcher installed at PREFIX/bin/grkd-edds" (Test-Path -LiteralPath $launcher) "expected $launcher"
        Check "${Name}: legacy PREFIX/bin/eizouden launcher removed" (-not (Test-Path -LiteralPath (Join-Path $Prefix "bin\eizouden"))) "legacy launcher present"
        Check "${Name}: CLI status rendered (common CLI contract)" ($out -match 'core: installed \(v') ($out -replace '\s+', ' ')
    }
    else {
        Check "${Name}: exited non-zero" ($proc.ExitCode -ne 0) "exit=$($proc.ExitCode)"
        if ($ExpectErrorPattern) {
            Check "${Name}: expected error surfaced" ($out -match $ExpectErrorPattern) "looking for /$ExpectErrorPattern/ in: $($out -replace '\s+',' ')"
        }
        Check "${Name}: nothing installed before failure" (-not (Test-Path -LiteralPath $core)) 'no core'
    }
    $leftovers = @(Get-ChildItem -LiteralPath $script:TempDir -Filter 'eizouden-bootstrap.*' -ErrorAction SilentlyContinue)
    Check "${Name}: private temp dir cleaned" ($leftovers.Count -eq 0) ('leftover: ' + ($leftovers.Name -join ','))
}

function Termux-Helper-Suite {
    $script:HelperWork = Join-Path $script:WorkDir 'helper'
    New-Item -ItemType Directory -Force -Path $script:HelperWork | Out-Null
    $dist = Join-Path $script:HelperWork 'dist'
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    $fakeDir = Join-Path $script:HelperWork 'fakes'
    New-Item -ItemType Directory -Force -Path $fakeDir | Out-Null
    # Fake Windows helper artifacts (the Termux side never consumes them).
    $fakeYtdlp = Join-Path $fakeDir 'fake-yt-dlp.exe'
    Set-Content -LiteralPath $fakeYtdlp -Value 'fake' -Encoding ascii
    $fakeAria2 = Join-Path $fakeDir 'fake-aria2.zip'
    New-FakeArchive $fakeAria2 'aria2c.exe'
    $fakeFfmpeg = Join-Path $fakeDir 'fake-ffmpeg.zip'
    New-FakeArchive $fakeFfmpeg 'ffmpeg.exe'
    $helpersJson = @{
        helpers = @(
            @{ key = 'yt-dlp'; required = $true; version = '2026.07.04'; artifactName = 'yt-dlp-windows-amd64.exe'; path = $fakeYtdlp },
            @{ key = 'aria2'; required = $true; version = '1.37.0'; artifactName = 'aria2-windows-amd64.zip'; path = $fakeAria2; archive = $true; expectedFile = 'aria2c.exe' },
            @{ key = 'ffmpeg'; required = $false; version = '5.1.2'; artifactName = 'ffmpeg-windows-amd64.zip'; path = $fakeFfmpeg; archive = $true; expectedFile = 'ffmpeg.exe' }
        )
    }
    $helpersFile = Join-Path $script:HelperWork 'helpers.json'
    [System.IO.File]::WriteAllText($helpersFile, ($helpersJson | ConvertTo-Json -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding($false)))
    $oldPath = $env:PATH
    $env:PATH = (Split-Path $script:Minisign) + ';' + $env:PATH
    & $ReleasePs1 release -Version $script:ReleaseVersion -OutDir $dist -MinisignKeyPath $script:KeyPath -HelpersFile $helpersFile | Out-Null
    $env:PATH = $oldPath
    if ($LASTEXITCODE -ne 0) { Check 'helper: release built' $false 'helper release failed'; return }

    $man = Get-Content -Raw -LiteralPath (Join-Path $dist 'eizouden-manifest.json') | ConvertFrom-Json
    Check 'helper: manifest v3 with fixed Termux packages' (
        $man.helperContract.version -eq 3 -and
        $man.helperContract.termux.packages.'yt-dlp'.package -eq 'python-yt-dlp' -and
        $man.helperContract.termux.packages.'aria2'.package -eq 'aria2' -and
        $man.helperContract.termux.packages.'ffmpeg'.package -eq 'ffmpeg' -and
        $man.helperContract.termux.packages.'yt-dlp'.command -eq 'yt-dlp' -and
        $man.helperContract.termux.packages.'aria2'.command -eq 'aria2c' -and
        $man.helperContract.termux.packages.'ffmpeg'.command -eq 'ffmpeg') ($man.helperContract | ConvertTo-Json -Compress)

    # Mirror the release files (the helper bootstrap fetches from it). The
    # android/arm64 entry carries the companion's own windows build (same
    # synthetic trick as the v1 suite) so the CLI can be exec'd on this
    # machine; verification logic is identical.
    $script:HelperMirror = Join-Path $script:HelperWork 'mirror'
    New-Item -ItemType Directory -Force -Path $script:HelperMirror | Out-Null
    foreach ($f in (Get-ChildItem -LiteralPath $dist -File)) {
        if ($f.Name -eq 'eizouden-android-arm64') {
            Copy-Item (Join-Path $dist 'eizouden-windows-amd64.exe') (Join-Path $script:HelperMirror 'eizouden-android-arm64') -Force
        } else {
            Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $script:HelperMirror $f.Name) -Force
        }
    }
    $newSha = (Get-FileHash -LiteralPath (Join-Path $script:HelperMirror 'eizouden-android-arm64')).Hash.ToLowerInvariant()
    $manText = [System.IO.File]::ReadAllText((Join-Path $script:HelperMirror 'eizouden-manifest.json'))
    $manText = $manText -replace '("target":"android/arm64","sha256":")[0-9a-f]{64}(")', "`${1}$newSha`${2}"
    [System.IO.File]::WriteAllText((Join-Path $script:HelperMirror 'eizouden-manifest.json'), $manText, (New-Object System.Text.UTF8Encoding($false)))
    & $script:Minisign -S -m (Join-Path $script:HelperMirror 'eizouden-manifest.json') -s $script:KeyPath | Out-Null
    & $script:Minisign -S -m (Join-Path $script:HelperMirror 'eizouden-android-arm64') -s $script:KeyPath | Out-Null
    $script:HelperBaseUrl = "https://release.example.test/eizouden/releases/$($script:ReleaseVersion)"

    function New-HelperBootstrapCopy {
        param([string]$Name)
        $text = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'termux-bootstrap-helper.sh'))
        $text = $text.Replace('REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY', $script:PubKey)
        $dest = Join-Path $script:HelperWork "boot-$Name.sh"
        [System.IO.File]::WriteAllText($dest, $text, (New-Object System.Text.UTF8Encoding($false)))
        return $dest
    }

    $inputStatus = Join-Path $script:HelperWork 'input-status.txt'
    Set-Content -LiteralPath $inputStatus -Value '2' -Encoding ascii -NoNewline

    # H1 success: helpers verified, core + launcher installed, CLI rendered.
    $prefix = New-FakeTermuxPrefix 'H1' @{ ytdlp = '2026.07.04'; aria2 = '1.37.0'; ffmpeg = '5.1.2' }
    Invoke-TermuxHelperCase -Name 'H1 helper success' -BootstrapPath (New-HelperBootstrapCopy 'H1') `
        -Prefix $prefix -InputFile $inputStatus -ExpectSuccess

    # H2: v2 (Windows-only) contract refused.
    $p2 = New-FakeTermuxPrefix 'H2' @{ ytdlp = '2026.07.04'; aria2 = '1.37.0'; ffmpeg = '5.1.2' }
    $m2 = Join-Path $script:HelperWork 'mirror-H2'
    New-Item -ItemType Directory -Force -Path $m2 | Out-Null
    foreach ($f in (Get-ChildItem -LiteralPath $script:HelperMirror -File)) { Copy-Item $f.FullName (Join-Path $m2 $f.Name) -Force }
    $manText = [System.IO.File]::ReadAllText((Join-Path $m2 'eizouden-manifest.json'))
    $manText = $manText.Replace('"version":3,', '"version":2,')
    [System.IO.File]::WriteAllText((Join-Path $m2 'eizouden-manifest.json'), $manText, (New-Object System.Text.UTF8Encoding($false)))
    & $script:Minisign -S -m (Join-Path $m2 'eizouden-manifest.json') -s $script:KeyPath | Out-Null
    $savedMirror = $script:HelperMirror
    $script:HelperMirror = $m2
    Invoke-TermuxHelperCase -Name 'H2 v2 contract refused' -BootstrapPath (New-HelperBootstrapCopy 'H2') `
        -Prefix $p2 -InputFile $inputStatus -ExpectErrorPattern 'not exactly 3|no Termux packages map'
    $script:HelperMirror = $savedMirror

    # H3: missing helper command fails before the core install.
    $p3 = New-FakeTermuxPrefix 'H3' @{ ytdlp = '2026.07.04'; aria2 = '1.37.0'; ffmpeg = '5.1.2' }
    Remove-Item -LiteralPath (Join-Path $p3 'bin\aria2c') -Force
    Invoke-TermuxHelperCase -Name 'H3 missing helper' -BootstrapPath (New-HelperBootstrapCopy 'H3') `
        -Prefix $p3 -InputFile $inputStatus -ExpectErrorPattern 'helper aria2 not found'

    # H4: helper version below the manifest minimum fails before the core.
    $p4 = New-FakeTermuxPrefix 'H4' @{ ytdlp = '1.0.0'; aria2 = '1.37.0'; ffmpeg = '5.1.2' }
    Invoke-TermuxHelperCase -Name 'H4 version below minimum' -BootstrapPath (New-HelperBootstrapCopy 'H4') `
        -Prefix $p4 -InputFile $inputStatus -ExpectErrorPattern 'below the manifest minimum'

    # H5: tampered core fails signature verification before install.
    $p5 = New-FakeTermuxPrefix 'H5' @{ ytdlp = '2026.07.04'; aria2 = '1.37.0'; ffmpeg = '5.1.2' }
    $m5 = Join-Path $script:HelperWork 'mirror-H5'
    New-Item -ItemType Directory -Force -Path $m5 | Out-Null
    foreach ($f in (Get-ChildItem -LiteralPath $script:HelperMirror -File)) { Copy-Item $f.FullName (Join-Path $m5 $f.Name) -Force }
    $coreFile = Join-Path $m5 'eizouden-android-arm64'
    $bytes = [System.IO.File]::ReadAllBytes($coreFile)
    $bytes[10] = $bytes[10] -bxor 0xFF
    [System.IO.File]::WriteAllBytes($coreFile, $bytes)
    $savedMirror = $script:HelperMirror
    $script:HelperMirror = $m5
    Invoke-TermuxHelperCase -Name 'H5 tampered core' -BootstrapPath (New-HelperBootstrapCopy 'H5') `
        -Prefix $p5 -InputFile $inputStatus -ExpectErrorPattern 'signature verification failed'
    $script:HelperMirror = $savedMirror

    # H6: the launcher is the app-private CLI entry (asserted in H1 via
    #     Invoke-TermuxHelperCase); additionally assert its content targets
    #     the installed core.
    $launcher6 = Join-Path (Join-Path $script:WorkDir 'prefix-helper-H1') 'bin\grkd-edds'
    if (Test-Path -LiteralPath $launcher6) {
        $lc = Get-Content -Raw -LiteralPath $launcher6
        Check 'H6: launcher execs the app-private core CLI' ($lc -match 'eizouden-android-arm64' -and $lc -match 'cli') ($lc -replace '\s+', ' ')
    } else {
        Check 'H6: launcher execs the app-private core CLI' $false 'launcher missing'
    }
}

function Dynamic-Suite {
    # Test-only version, distinct from the api.Version dev default (0.2.0):
    # the release-identity banner checks are only meaningful when the
    # injected version is observable as different from an uninjected build.
    $script:ReleaseVersion = '9.9.9'
    $script:WorkDir = Join-Path $script:WorkRoot ("run-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $script:KeysDir = Join-Path $script:WorkDir 'keys'
    $script:MirrorDir = Join-Path $script:WorkDir 'mirror'
    $script:TempDir = Join-Path $script:WorkDir 'tmp'
    $script:LogsDir = Join-Path $script:WorkDir 'logs'
    foreach ($d in @($script:KeysDir, (Join-Path $script:WorkDir 'dist'), (Join-Path $script:WorkDir 'dist2'),
            $script:MirrorDir, (Join-Path $script:WorkDir 'prefix'), $script:TempDir, $script:LogsDir)) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
    }
    $script:KeyPath = Join-Path $script:KeysDir 'test.key'
    $script:PubPath = Join-Path $script:KeysDir 'test.pub'

    # 1. Temporary key pair (work root only, removed at the end).
    & $script:Minisign -G -W -p $script:PubPath -s $script:KeyPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'minisign key generation failed' }
    $script:PubKey = Get-Content -LiteralPath $script:PubPath | Where-Object { $_ -match '^RW[A-Za-z0-9+/]+$' } | Select-Object -First 1
    Check 'dynamic: test public key is a Minisign key' ($script:PubKey -match '^RW[A-Za-z0-9+/]+$') $script:PubKey

    # 2. Real release helper run (build + manifest + detached signatures).
    $oldPath = $env:PATH
    $env:PATH = (Split-Path $script:Minisign) + ';' + $env:PATH
    $releaseFailed = $false
    try {
        $dist = Join-Path $script:WorkDir 'dist'
        & $ReleasePs1 release -Version $script:ReleaseVersion -OutDir $dist -MinisignKeyPath $script:KeyPath -PublicKeyFile $script:PubPath
    }
    catch {
        $releaseFailed = $true
        Check 'dynamic: release helper ran cleanly' $false $_.Exception.Message
    }
    finally {
        $env:PATH = $oldPath
    }
    if ($releaseFailed) { return }

    # 2b. Plain `build` (no -Version) must keep the dev default in the
    #     binaries: only `release` injects the version at link time. Run the
    #     built windows binary and read its startup banner.
    $buildFailed = $false
    $buildBanner = ''
    try {
        $buildDir = Join-Path $script:WorkDir 'build'
        & $ReleasePs1 build -OutDir $buildDir
        $builtExe = Join-Path $buildDir 'eizouden-windows-amd64.exe'
        $bannerLog = Join-Path $script:LogsDir 'build-banner.log'
        $bp = Start-Process -FilePath $builtExe -ArgumentList @('--addr', '127.0.0.1:0') -RedirectStandardOutput $bannerLog `
            -RedirectStandardError "$bannerLog.err" -PassThru -NoNewWindow
        $bDeadline = [DateTime]::UtcNow.AddSeconds(45)
        while ([DateTime]::UtcNow -lt $bDeadline -and -not $bp.HasExited) {
            $buildBanner = if (Test-Path -LiteralPath $bannerLog) { Get-Content -Raw -LiteralPath $bannerLog -ErrorAction SilentlyContinue } else { '' }
            if ($buildBanner -match 'listening on http') { break }
            Start-Sleep -Milliseconds 300
        }
        if (-not $bp.HasExited) {
            & 'C:\Windows\System32\taskkill.exe' /T /F /PID $bp.Id 2>&1 | Out-Null
        }
        $bp.WaitForExit()
    }
    catch {
        $buildFailed = $true
        Check 'dynamic: plain build ran cleanly and keeps dev default version' $false $_.Exception.Message
    }
    if (-not $buildFailed) {
        Check 'dynamic: plain build keeps dev default 0.2.0 in banner' `
            ($buildBanner -match 'EizouDendenshi ED-2B \(0\.2\.0\) listening on http') ($buildBanner -replace '\s+', ' ')
    }

    $manifestFile = Join-Path $dist 'eizouden-manifest.json'
    Check 'dynamic: release helper produced manifest + signatures' (
        (Test-Path -LiteralPath $manifestFile) -and
        (Test-Path -LiteralPath "$manifestFile.minisig") -and
        (Test-Path -LiteralPath (Join-Path $dist 'eizouden-windows-amd64.exe')) -and
        (Test-Path -LiteralPath (Join-Path $dist 'eizouden-windows-amd64.exe.minisig')) -and
        (Test-Path -LiteralPath (Join-Path $dist 'eizouden-android-arm64')) -and
        (Test-Path -LiteralPath (Join-Path $dist 'eizouden-android-arm64.minisig'))) 'expected manifest, both binaries, and all .minisig files'

    # 3. Manifest content and SHA-256 integrity.
    $man = Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
    $script:ManifestVersion = $man.version
    Check 'dynamic: manifest format/version/helper contract' (
        $man.format -eq 'eizoudendenshi-release-manifest' -and
        $man.formatVersion -eq 1 -and
        $man.version -eq $script:ReleaseVersion -and
        $man.helperContract.version -eq 1 -and
        @($man.helperContract.minimumVersions.PSObject.Properties).Count -eq 0) (Get-ManifestText $dist)
    Check 'dynamic: manifest lists both targets' (
        @($man.artifacts | Where-Object target -eq 'windows/amd64').Count -gt 0 -and
        @($man.artifacts | Where-Object target -eq 'android/arm64').Count -gt 0) ($man.artifacts | ConvertTo-Json -Compress)
    $ok = $true
    foreach ($a in $man.artifacts) {
        $p = Join-Path $dist $a.name
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() -ne $a.sha256) { $ok = $false }
    }
    Check 'dynamic: manifest SHA-256 fields match artifacts' $ok 'per-artifact sha256 must equal file hashes'

    # 4. Detached signatures verify against the temporary public key.
    $ok = $true
    foreach ($f in @($manifestFile, (Join-Path $dist 'eizouden-windows-amd64.exe'), (Join-Path $dist 'eizouden-android-arm64'))) {
        & $script:Minisign -V -m $f -P $script:PubKey 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { $ok = $false }
    }
    Check 'dynamic: all detached signatures verify' $ok 'minisign -V must pass for manifest and both artifacts'

    # 5. Synthetic runnable release: the android/arm64 entry carries the
    #    companion's own windows build so the real companion binary can be
    #    exec'd and observed printing a pairing code here. Verification
    #    logic is identical; real android/arm64 ELF execution remains the
    #    Stage B device gate.
    $dist2 = Join-Path $script:WorkDir 'dist2'
    Copy-Item (Join-Path $dist 'eizouden-windows-amd64.exe') (Join-Path $dist2 'eizouden-android-arm64') -Force
    $newSha = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $dist2 'eizouden-android-arm64')).Hash.ToLowerInvariant()
    $manText = Get-ManifestText $dist
    $manText = $manText -replace '("target":"android/arm64","sha256":")[0-9a-f]{64}(")', "`${1}$newSha`${2}"
    Copy-Item $manifestFile (Join-Path $dist2 'eizouden-manifest.json')
    Copy-Item "$manifestFile.minisig" (Join-Path $dist2 'eizouden-manifest.json.minisig')
    Set-ManifestText $dist2 $manText
    Sign-Core $dist2
    Sign-Manifest $dist2
    $script:ManifestAndroidSha = ($manText -replace '.*"target":"android/arm64","sha256":"([0-9a-f]{64})".*', '${1}')

    # 6. Base environment for every case.
    $script:BaseEnv = @{
        EIZOU_TEST               = '1'
        EIZOU_BOOTSTRAP_SKIP_PKG = '1'
        TMPDIR                   = $script:TempDir
        PATH                     = $script:GitBins + ';' + (Split-Path $script:Minisign) + ';' + $env:PATH
    }
    $baseUrl = "https://release.example.test/eizouden/releases/$($script:ReleaseVersion)"

    # T1: success (verified install -> foreground pairing code).
    $p = New-Prefix 'T1'
    $m = Copy-Mirror 'T1'
    Invoke-BootstrapCase -Name 'T1 success' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T1')) `
        -Url $baseUrl -Env (New-CaseEnv $m $p) -ExpectSuccess -PrefixPath $p

    # T2: tampered manifest (bytes changed after signing).
    $p = New-Prefix 'T2'; $m = Copy-Mirror 'T2'
    [System.IO.File]::AppendAllText((Join-Path $m 'eizouden-manifest.json'), "`n", (New-Object System.Text.UTF8Encoding($false)))
    Invoke-BootstrapCase -Name 'T2 tampered manifest' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T2')) `
        -Url $baseUrl -Env (New-CaseEnv $m $p) -ExpectErrorPattern 'signature verification failed' -PrefixPath $p

    # T3: tampered binary (bytes changed after signing).
    $p = New-Prefix 'T3'; $m = Copy-Mirror 'T3'
    $core = Join-Path $m 'eizouden-android-arm64'
    $bytes = [System.IO.File]::ReadAllBytes($core); $bytes[10] = $bytes[10] -bxor 0xFF
    [System.IO.File]::WriteAllBytes($core, $bytes)
    Invoke-BootstrapCase -Name 'T3 tampered binary' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T3')) `
        -Url $baseUrl -Env (New-CaseEnv $m $p) -ExpectErrorPattern 'signature verification failed' -PrefixPath $p

    # T4a: missing core signature.
    $p = New-Prefix 'T4a'; $m = Copy-Mirror 'T4a'
    Remove-Item (Join-Path $m 'eizouden-android-arm64.minisig') -Force
    Invoke-BootstrapCase -Name 'T4a missing core sig' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T4a')) `
        -Url $baseUrl -Env (New-CaseEnv $m $p) -ExpectErrorPattern 'download failed|signature verification failed' -PrefixPath $p

    # T4b: missing manifest signature.
    $p = New-Prefix 'T4b'; $m = Copy-Mirror 'T4b'
    Remove-Item (Join-Path $m 'eizouden-manifest.json.minisig') -Force
    Invoke-BootstrapCase -Name 'T4b missing manifest sig' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T4b')) `
        -Url $baseUrl -Env (New-CaseEnv $m $p) -ExpectErrorPattern 'download failed|signature verification failed' -PrefixPath $p

    # T5: wrong architecture (manifest has no android/arm64 artifact).
    $p = New-Prefix 'T5'; $m = Copy-Mirror 'T5'
    $manText = Get-ManifestText $m
    $manText = $manText.Replace('"target":"android/arm64"', '"target":"android/x86_64"')
    Set-ManifestText $m $manText
    Sign-Manifest $m
    Invoke-BootstrapCase -Name 'T5 wrong architecture' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T5')) `
        -Url $baseUrl -Env (New-CaseEnv $m $p) -ExpectErrorPattern 'no android/arm64 artifact' -PrefixPath $p

    # T6: unsafe (non-HTTPS) release base URL — rejected before any download.
    $p = New-Prefix 'T6'; $m = Copy-Mirror 'T6'
    Invoke-BootstrapCase -Name 'T6 unsafe base URL' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T6')) `
        -Url 'http://release.example.test/eizouden/releases/0.2.0' -Env (New-CaseEnv $m $p) `
        -ExpectErrorPattern 'must be https://' -PrefixPath $p

    # T7: unpinned template key — fails closed.
    $p = New-Prefix 'T7'; $m = Copy-Mirror 'T7'
    Invoke-BootstrapCase -Name 'T7 unpinned template key' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T7') -KeepPlaceholder) `
        -Url $baseUrl -Env (New-CaseEnv $m $p) -ExpectErrorPattern 'not pinned' -PrefixPath $p

    # T8: unsupported helper contract — fails closed before install.
    $p = New-Prefix 'T8'; $m = Copy-Mirror 'T8'
    $manText = Get-ManifestText $m
    $manText = $manText.Replace('"helperContract":{"version":1,"minimumVersions":{}}', '"helperContract":{"version":2,"minimumVersions":{}}')
    Set-ManifestText $m $manText
    Sign-Manifest $m
    Invoke-BootstrapCase -Name 'T8 unsupported helper contract' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T8')) `
        -Url $baseUrl -Env (New-CaseEnv $m $p) -ExpectErrorPattern 'helper contract' -PrefixPath $p

    # T9: non-Termux environment (real validation, no test mode).
    $p = New-Prefix 'T9'; $m = Copy-Mirror 'T9'
    $env9 = @{
        EIZOU_BOOTSTRAP_SKIP_PKG = '1'
        EIZOU_MIRROR_DIR         = $m
        EIZOU_PREFIX             = $p
        TMPDIR                   = $script:TempDir
        PATH                     = $script:GitBins + ';' + (Split-Path $script:Minisign) + ';' + $env:PATH
    }
    Invoke-BootstrapCase -Name 'T9 non-Termux env' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T9')) `
        -Url $baseUrl -Env $env9 -ExpectErrorPattern 'not running in Termux|not running on Linux' -PrefixPath $p

    # T10: SHA-256 mismatch with valid signatures (isolates the SHA check).
    $p = New-Prefix 'T10'; $m = Copy-Mirror 'T10'
    $core = Join-Path $m 'eizouden-android-arm64'
    $wantSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $core).Hash.ToLowerInvariant()   # sha of the signed content
    $served = [System.IO.File]::ReadAllBytes($core) + [byte]0x00                              # what the mirror actually serves
    [System.IO.File]::WriteAllBytes($core, $served)
    Sign-Core $m
    $manText = Get-ManifestText $m
    $manText = $manText -replace '("target":"android/arm64","sha256":")[0-9a-f]{64}(")', "`${1}$wantSha`${2}"
    Set-ManifestText $m $manText
    Sign-Manifest $m
    Invoke-BootstrapCase -Name 'T10 SHA-256 mismatch' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T10')) `
        -Url $baseUrl -Env (New-CaseEnv $m $p) -ExpectErrorPattern 'SHA-256 mismatch' -PrefixPath $p
}

# --- Main -------------------------------------------------------------------

Write-Host 'EizouDendenshi ED-2D Stage A test harness'
Write-Host "  repo:     $RepoRoot"
Write-Host "  work:     $WorkRoot"

# Make the Git-for-Windows toolchain (sh, curl, sha256sum, mktemp, sed,
# grep, head, ...) available to every child process.
$script:GitBins = 'C:\Program Files\Git\usr\bin;C:\Program Files\Git\bin'

Static-Checks

$script:ShPath = Find-Sh
$script:Minisign = Get-Minisign
$script:WorkRoot = $WorkRoot

if (-not $script:ShPath) {
    Write-Host '  [SKIP] dynamic suite: no POSIX sh found (install Git for Windows)'
}
elseif (-not $script:Minisign) {
    Write-Host '  [SKIP] dynamic suite: minisign unavailable (PATH, A:\Temp\opencode, or network provisioning)'
}
else {
    Write-Host "  sh:       $($script:ShPath)"
    Write-Host "  minisign: $($script:Minisign)"
    try {
        Dynamic-Suite
        Termux-Helper-Suite
    }
    catch {
        $script:FailCount++
        Check 'dynamic: suite completed' $false "aborted: $($_.Exception.Message) | $($_.ScriptStackTrace -replace '\s+',' ')"
    }
}

Write-Host ''
Write-Host ('RESULTS: {0} passed, {1} failed, {2} total' -f
    (($Results | Where-Object Result -eq 'PASS').Count), $script:FailCount, $Results.Count)
$Results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

if (-not $Keep -and $script:WorkDir) {
    Remove-Item -LiteralPath $script:WorkDir -Recurse -Force
    Write-Host "cleaned: $($script:WorkDir)"
}

if ($script:FailCount -gt 0) { exit 1 }
exit 0
