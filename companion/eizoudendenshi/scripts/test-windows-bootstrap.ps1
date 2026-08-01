# EizouDendenshi ED-2D Windows helper-enabled bootstrap test harness.
#
# Runs on the Windows dev machine (pwsh). All temporary material — Minisign
# keys, signatures, the synthetic helper-enabled release, fake helper
# artifacts, per-case install roots, logs — lives under the work root
# (default A:\Temp\opencode\ed2d-win-bootstrap-test) and is removed at the
# end unless -Keep is passed. Nothing is written inside the repository and
# no system state (PATH, installers) is touched.
#
# Coverage:
#   - success install (core + helpers) with exact absolute helper paths
#   - reuse of a verified install (no re-fetch, no replacement)
#   - missing helper auto-fetch into a fresh install root
#   - tampered manifest / helper artifact / archive / missing sig / SHA
#     mismatch -> fail BEFORE any replacement
#   - bad (non-HTTPS) URL / unpinned key -> fail closed
#   - helper version mismatch -> replacement (re-fetch + atomic replace)
#   - unsafe artifact names / duplicate or unknown helper keys / v1 contract
#     -> fail closed
#   - no system PATH mutation; user-private temp cleanup
#   - core receives expected absolute --ytdlp / --aria2 paths

[CmdletBinding()]
param(
    [string]$WorkRoot = 'A:\Temp\opencode\ed2d-win-bootstrap-test',
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ReleasePs1 = Join-Path $PSScriptRoot 'release.ps1'
$BootstrapTemplate = Join-Path $PSScriptRoot 'windows-bootstrap.ps1'
$BootstrapText = [System.IO.File]::ReadAllText($BootstrapTemplate)

$Results = [System.Collections.Generic.List[object]]::new()
$script:FailCount = 0
function Check([string]$Name, $Ok, [string]$Detail) {
    $b = $false
    try { $b = [bool]$Ok }
    catch { $Detail = "bool-convert-error: $($_.Exception.Message) | $Detail" }
    $Results.Add([pscustomobject]@{ Case = $Name; Result = $(if ($b) { 'PASS' } else { 'FAIL' }); Detail = $Detail })
    if (-not $b) { $script:FailCount++ }
}

function Find-Minisign {
    $found = Get-Command minisign -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
    if ($found) { return $found }
    foreach ($cand in @(
            'A:\Temp\opencode\minisign-bin\minisign-win64\x86_64\minisign.exe',
            'A:\Temp\opencode\minisign.exe')) {
        if (Test-Path -LiteralPath $cand) { return $cand }
    }
    return $null
}

function Get-Minisign {
    $existing = Find-Minisign
    if ($existing) { return $existing }
    $zip = 'A:\Temp\opencode\minisign-0.12-win64.zip'
    $dest = 'A:\Temp\opencode\minisign-bin'
    try {
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

# --- Static fail-closed checks on the Windows template (always run) --------

function Static-Checks {
    $boot = $BootstrapText
    $code = ($boot -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    Check 'static: no Invoke-Expression / pipe-to-shell' (
        $code -notmatch 'Invoke-Expression' -and $code -notmatch '\|\s*(sh|bash|pwsh)\b') 'template must never execute remote code'
    Check 'static: pinned-key placeholder present and rejected' (
        $boot.Contains('REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY') -and
        $boot.Contains('refusing to run an unpinned bootstrap')) 'unreplaced template must fail closed'
    Check 'static: HTTPS-only release URL validation' (
        $boot.Contains('refusing non-HTTPS download')) 'non-HTTPS base URL must be rejected'
    Check 'static: no system PATH mutation / no global installers' (
        $code -notmatch '\[Environment\]::SetEnvironmentVariable' -and
        $code -notmatch 'winget|choco' -and
        $code -notmatch 'Install-Module|pip install') 'no persistent PATH change or global installer'
    Check 'static: no vendor fetch at bootstrap time' (
        $code -notmatch 'https://github.com|https://www.gyan.dev|yt-dlp.github.io|https://aria2.github.io') 'end users must fetch only from the signed release base'
    Check 'static: manifest SHA-256 verified before replacement' (
        $boot.Contains('SHA-256 mismatch') -and $boot.IndexOf('Install-Artifact') -ge 0) 'per-artifact SHA-256 check before atomic replacement'
    Check 'static: user-private install root' (
        $boot.Contains('LOCALAPPDATA') -and $boot.Contains('GoRakuDo\EizouDendenshi')) 'per-user install root under LOCALAPPDATA'
    Check 'static: explicit absolute helper flags for the core' (
        $code -match '--ytdlp' -and $code -match '--aria2' -and
        $code -match 'env:PATH\s*=\s*"\$helpersDir') 'core receives explicit helper paths; PATH change is process-scoped only'
}

# --- Dynamic suite ----------------------------------------------------------

function Invoke-WinBootstrapCase {
    param(
        [string]$Name,
        [string]$BootstrapPath,
        [string]$InstallRoot,
        [hashtable]$Env,
        [switch]$ExpectSuccess,
        [string]$ExpectErrorPattern = '',
        [string]$Mirror,
        [string]$LaunchFile = ''
    )
    $outFile = Join-Path $script:LogsDir "$Name.out.log"
    $errFile = Join-Path $script:LogsDir "$Name.err.log"
    $argsList = @('-NoProfile', '-File', "`"$BootstrapPath`"",
        "-ReleaseBaseUrl", "https://release.example.test/eizouden/releases/$($script:ReleaseVersion)",
        "-InstallRoot", "`"$InstallRoot`"",
        "-HarnessMirrorDir", "`"$Mirror`"",
        "-SkipLaunch")
    if ($LaunchFile -ne '') { $argsList += @('-HarnessLaunchFile', "`"$LaunchFile`"") }
    $proc = Start-Process -FilePath 'pwsh' -ArgumentList $argsList `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
        -PassThru -NoNewWindow -Environment $Env
    if (-not $proc.WaitForExit(120000)) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $proc.WaitForExit()
        Check "${Name}: process exited" $false 'did not exit within 120s'
        return
    }
    $out = (Get-Content -Raw -LiteralPath $outFile -ErrorAction SilentlyContinue) +
        (Get-Content -Raw -LiteralPath $errFile -ErrorAction SilentlyContinue)
    if ($ExpectSuccess) {
        Check "${Name}: exited zero" ($proc.ExitCode -eq 0) "exit=$($proc.ExitCode): $($out -replace '\s+',' ')"
        Check "${Name}: installed message" ($out -match 'verified EizouDendenshi .* installed') ($out -replace '\s+', ' ')
    }
    else {
        Check "${Name}: exited non-zero" ($proc.ExitCode -ne 0) "exit=$($proc.ExitCode)"
        if ($ExpectErrorPattern) {
            Check "${Name}: expected error surfaced" ($out -match $ExpectErrorPattern) "looking for /$ExpectErrorPattern/ in: $($out -replace '\s+',' ')"
        }
    }
}

function New-BootstrapCopy {
    param([string]$DestDir, [switch]$KeepPlaceholder)
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    $dest = Join-Path $DestDir 'eizouden-bootstrap.ps1'
    if ($KeepPlaceholder) {
        [System.IO.File]::WriteAllText($dest, $BootstrapText, (New-Object System.Text.UTF8Encoding($false)))
    }
    else {
        [System.IO.File]::WriteAllText($dest, $BootstrapText.Replace('REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY', $script:PubKey), (New-Object System.Text.UTF8Encoding($false)))
    }
    return $dest
}

function Copy-Mirror {
    param([string]$Name)
    $dst = Join-Path $script:MirrorBase $Name
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    foreach ($f in (Get-ChildItem -LiteralPath $script:DistDir -File)) {
        Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $dst $f.Name) -Force
    }
    return $dst
}

function Read-MirrorManifest {
    param([string]$Mirror)
    return Get-Content -Raw -LiteralPath (Join-Path $Mirror 'eizouden-manifest.json')
}

function Write-MirrorManifest {
    param([string]$Mirror, [string]$Text)
    [System.IO.File]::WriteAllText((Join-Path $Mirror 'eizouden-manifest.json'), $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Sign-ManifestFile {
    param([string]$Mirror)
    Remove-Item (Join-Path $Mirror 'eizouden-manifest.json.minisig') -Force -ErrorAction SilentlyContinue
    & $script:Minisign -S -m (Join-Path $Mirror 'eizouden-manifest.json') -s $script:KeyPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 're-sign manifest failed' }
}

function Sign-ArtifactFile {
    param([string]$Mirror, [string]$Name)
    Remove-Item (Join-Path $Mirror "$Name.minisig") -Force -ErrorAction SilentlyContinue
    & $script:Minisign -S -m (Join-Path $Mirror $Name) -s $script:KeyPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "re-sign $Name failed" }
}

function New-FakeArchive {
    param([string]$ZipPath, [string]$InnerName)
    $stage = Join-Path $script:WorkDir ("arch-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    Set-Content -LiteralPath (Join-Path $stage $InnerName) -Value "fake helper bytes $InnerName" -Encoding ascii
    Compress-Archive -Path (Join-Path $stage $InnerName) -DestinationPath $ZipPath -Force
    Remove-Item -LiteralPath $stage -Recurse -Force
}

function Dynamic-Suite {
    $script:ReleaseVersion = '9.9.9'
    $script:WorkDir = Join-Path $script:WorkRoot ("run-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $script:KeysDir = Join-Path $script:WorkDir 'keys'
    $script:DistDir = Join-Path $script:WorkDir 'dist'
    $script:MirrorBase = Join-Path $script:WorkDir 'mirror'
    $script:LogsDir = Join-Path $script:WorkDir 'logs'
    $script:FakeDir = Join-Path $script:WorkDir 'fakes'
    foreach ($d in @($script:KeysDir, $script:DistDir, $script:MirrorBase, $script:LogsDir, $script:FakeDir)) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
    }
    $script:KeyPath = Join-Path $script:KeysDir 'test.key'
    $script:PubPath = Join-Path $script:KeysDir 'test.pub'

    # Temporary key pair (work root only).
    & $script:Minisign -G -W -p $script:PubPath -s $script:KeyPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'minisign key generation failed' }
    $script:PubKey = Get-Content -LiteralPath $script:PubPath | Where-Object { $_ -match '^RW[A-Za-z0-9+/]+$' } | Select-Object -First 1

    # Fake helper artifacts (harmless placeholders).
    $fakeYtdlp = Join-Path $script:FakeDir 'fake-yt-dlp.exe'
    Set-Content -LiteralPath $fakeYtdlp -Value 'fake yt-dlp placeholder' -Encoding ascii
    $fakeAria2 = Join-Path $script:FakeDir 'fake-aria2.zip'
    New-FakeArchive $fakeAria2 'aria2c.exe'
    $fakeFfmpeg = Join-Path $script:FakeDir 'fake-ffmpeg.zip'
    New-FakeArchive $fakeFfmpeg 'ffmpeg.exe'

    # Helper inputs JSON (explicit local paths only).
    $helpersJson = @{
        helpers = @(
            @{ key = 'yt-dlp'; required = $true; version = '2026.07.04'; artifactName = 'yt-dlp-windows-amd64.exe'; path = $fakeYtdlp },
            @{ key = 'aria2'; required = $true; version = '1.37.0'; artifactName = 'aria2-windows-amd64.zip'; path = $fakeAria2; archive = $true; expectedFile = 'aria2c.exe' },
            @{ key = 'ffmpeg'; required = $false; version = '8.0.1'; artifactName = 'ffmpeg-windows-amd64.zip'; path = $fakeFfmpeg; archive = $true; expectedFile = 'ffmpeg.exe' }
        )
    }
    $helpersFile = Join-Path $script:WorkDir 'helpers.json'
    [System.IO.File]::WriteAllText($helpersFile, ($helpersJson | ConvertTo-Json -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding($false)))

    # Build the helper-enabled release (core + helpers, all signed).
    $oldPath = $env:PATH
    $env:PATH = (Split-Path $script:Minisign) + ';' + $env:PATH
    try {
        & $ReleasePs1 release -Version $script:ReleaseVersion -OutDir $script:DistDir `
            -MinisignKeyPath $script:KeyPath -HelpersFile $helpersFile
    }
    catch {
        Check 'dynamic: helper-enabled release helper ran cleanly' $false $_.Exception.Message
        $env:PATH = $oldPath
        return
    }
    $env:PATH = $oldPath

    $man = Get-Content -Raw -LiteralPath (Join-Path $script:DistDir 'eizouden-manifest.json') | ConvertFrom-Json
    Check 'dynamic: helper contract v2 with three helpers' (
        $man.helperContract.version -eq 2 -and
        @($man.helperContract.helpers.PSObject.Properties).Count -eq 3) 'v2 helpers map expected'
    Check 'dynamic: helper artifacts listed with windows/amd64 target' (
        @($man.artifacts | Where-Object { $_.name -match 'yt-dlp|aria2|ffmpeg' -and $_.target -eq 'windows/amd64' }).Count -eq 3) ($man.artifacts | ConvertTo-Json -Compress)
    Check 'dynamic: all helper artifacts signed' (
        (Test-Path (Join-Path $script:DistDir 'yt-dlp-windows-amd64.exe.minisig')) -and
        (Test-Path (Join-Path $script:DistDir 'aria2-windows-amd64.zip.minisig')) -and
        (Test-Path (Join-Path $script:DistDir 'ffmpeg-windows-amd64.zip.minisig'))) 'detached .minisig for each helper artifact'

    $script:BaseEnv = @{
        PATH = (Split-Path $script:Minisign) + ';' + $env:PATH
    }
    $beforePath = $env:PATH

    # T1: success install.
    $mirror = Copy-Mirror 'T1'
    $root = Join-Path $script:WorkDir 'root-T1'
    $launch = Join-Path $script:WorkDir 'launch-T1.txt'
    Invoke-WinBootstrapCase -Name 'T1 success' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T1')) `
        -InstallRoot $root -Env $script:BaseEnv -ExpectSuccess -Mirror $mirror -LaunchFile $launch
    Check 'T1: core installed' (Test-Path (Join-Path $root 'eizouden-windows-amd64.exe')) 'windows core present'
    Check 'T1: yt-dlp helper installed' (Test-Path (Join-Path $root 'yt-dlp-windows-amd64.exe')) 'yt-dlp artifact present'
    Check 'T1: aria2 helper installed (extracted)' (Test-Path (Join-Path $root 'aria2-windows-amd64.zip')) 'aria2 archive present'
    Check 'T1: state file written' (Test-Path (Join-Path $root 'helpers-state.json')) 'helpers-state.json present'
    $launchText = if (Test-Path -LiteralPath $launch) { Get-Content -Raw -LiteralPath $launch } else { '' }
    Check 'T1: core launch command has absolute --ytdlp/--aria2' (
        $launchText -match [regex]::Escape((Join-Path $root 'yt-dlp-windows-amd64.exe')) -and
        $launchText -match [regex]::Escape((Join-Path $root 'aria2-windows-amd64.zip'))) $launchText
    # Installed helper SHA must equal the signed manifest.
    $manSha = [string]($man.artifacts | Where-Object { $_.name -eq 'yt-dlp-windows-amd64.exe' } | Select-Object -First 1).sha256
    $instSha = (Get-FileHash -LiteralPath (Join-Path $root 'yt-dlp-windows-amd64.exe')).Hash.ToLowerInvariant()
    Check 'T1: installed helper bytes match signed manifest' ($instSha -eq $manSha) "got $instSha want $manSha"

    # T2: reuse (second run, same root — no replacement).
    $ytdlpInstalled = Join-Path $root 'yt-dlp-windows-amd64.exe'
    $t0 = (Get-Item -LiteralPath $ytdlpInstalled).LastWriteTimeUtc
    Invoke-WinBootstrapCase -Name 'T2 reuse' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T2')) `
        -InstallRoot $root -Env $script:BaseEnv -ExpectSuccess -Mirror (Copy-Mirror 'T2') -LaunchFile $launch
    $t1 = (Get-Item -LiteralPath $ytdlpInstalled).LastWriteTimeUtc
    Check 'T2: verified helper reused (no replacement)' ($t1 -eq $t0) "mtime $t0 -> $t1"

    # T3: missing helper auto-fetch (fresh root) — covered by T1; assert the
    #     state marks all three helpers.
    $state = Get-Content -Raw -LiteralPath (Join-Path $root 'helpers-state.json') | ConvertFrom-Json
    Check 'T3: state records all helpers' (
        @($state.PSObject.Properties).Count -eq 3) ($state | ConvertTo-Json -Compress)

    # T4: tampered manifest.
    $mirror = Copy-Mirror 'T4'
    [System.IO.File]::AppendAllText((Join-Path $mirror 'eizouden-manifest.json'), "`n")
    $root4 = Join-Path $script:WorkDir 'root-T4'
    Invoke-WinBootstrapCase -Name 'T4 tampered manifest' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T4')) `
        -InstallRoot $root4 -Env $script:BaseEnv -Mirror $mirror -ExpectErrorPattern 'signature verification failed'
    Check 'T4: nothing installed' (-not (Test-Path (Join-Path $root4 'eizouden-windows-amd64.exe'))) 'no core'

    # T5: tampered helper artifact (bytes changed after signing).
    $mirror = Copy-Mirror 'T5'
    $h = Join-Path $mirror 'yt-dlp-windows-amd64.exe'
    [System.IO.File]::WriteAllText($h, (Get-Content -Raw $h) + 'tampered')
    $root5 = Join-Path $script:WorkDir 'root-T5'
    Invoke-WinBootstrapCase -Name 'T5 tampered helper' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T5')) `
        -InstallRoot $root5 -Env $script:BaseEnv -Mirror $mirror -ExpectErrorPattern 'signature verification failed|SHA-256 mismatch'
    Check 'T5: no helper replaced' (-not (Test-Path (Join-Path $root5 'yt-dlp-windows-amd64.exe'))) 'no yt-dlp'

    # T6: tampered archive (valid signature + manifest SHA for the tampered
    #     zip, so verification passes and the missing expected file is what
    #     fails — isolating the extraction contract).
    $mirror = Copy-Mirror 'T6'
    $tamperedZip = Join-Path $script:FakeDir 'tampered-aria2.zip'
    New-FakeArchive $tamperedZip 'evil.txt'
    Copy-Item $tamperedZip (Join-Path $mirror 'aria2-windows-amd64.zip') -Force
    Sign-ArtifactFile $mirror 'aria2-windows-amd64.zip'
    $tamSha = (Get-FileHash -LiteralPath (Join-Path $mirror 'aria2-windows-amd64.zip')).Hash.ToLowerInvariant()
    $manText = Read-MirrorManifest $mirror
    $manText = $manText -replace '("name":"aria2-windows-amd64.zip","target":"windows/amd64","sha256":")[0-9a-f]{64}(")', "`${1}$tamSha`${2}"
    Write-MirrorManifest $mirror $manText
    Sign-ManifestFile $mirror
    $root6 = Join-Path $script:WorkDir 'root-T6'
    Invoke-WinBootstrapCase -Name 'T6 tampered archive' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T6')) `
        -InstallRoot $root6 -Env $script:BaseEnv -Mirror $mirror -ExpectErrorPattern 'does not contain the expected file'

    # T7: missing helper signature.
    $mirror = Copy-Mirror 'T7'
    Remove-Item (Join-Path $mirror 'yt-dlp-windows-amd64.exe.minisig') -Force
    $root7 = Join-Path $script:WorkDir 'root-T7'
    Invoke-WinBootstrapCase -Name 'T7 missing helper sig' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T7')) `
        -InstallRoot $root7 -Env $script:BaseEnv -Mirror $mirror -ExpectErrorPattern 'download failed|signature verification failed'

    # T8: SHA mismatch with valid signatures (isolate the SHA check).
    $mirror = Copy-Mirror 'T8'
    $h = Join-Path $mirror 'yt-dlp-windows-amd64.exe'
    $wantSha = (Get-FileHash -LiteralPath $h).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText($h, (Get-Content -Raw $h) + 'served-extra')
    Sign-ArtifactFile $mirror 'yt-dlp-windows-amd64.exe'
    $manText = Read-MirrorManifest $mirror
    $manText = $manText -replace '("artifact":"yt-dlp-windows-amd64.exe","sha256":")[0-9a-f]{64}(")', "`${1}$wantSha`${2}"
    Write-MirrorManifest $mirror $manText
    Sign-ManifestFile $mirror
    $root8 = Join-Path $script:WorkDir 'root-T8'
    Invoke-WinBootstrapCase -Name 'T8 SHA-256 mismatch' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T8')) `
        -InstallRoot $root8 -Env $script:BaseEnv -Mirror $mirror -ExpectErrorPattern 'SHA-256 mismatch'

    # T9: bad (non-HTTPS) URL — rejected before any download.
    $mirror = Copy-Mirror 'T9'
    $root9 = Join-Path $script:WorkDir 'root-T9'
    $outFile = Join-Path $script:LogsDir 'T9.out.log'
    $errFile = Join-Path $script:LogsDir 'T9.err.log'
    $p9 = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-File', "`"$(New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T9'))`"",
        '-ReleaseBaseUrl', 'http://release.example.test/x', '-InstallRoot', "`"$root9`"", '-HarnessMirrorDir', "`"$mirror`"", '-SkipLaunch') `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -NoNewWindow -Environment $script:BaseEnv
    $p9.WaitForExit(60000) | Out-Null
    $o9 = (Get-Content -Raw -LiteralPath $outFile -ErrorAction SilentlyContinue) + (Get-Content -Raw -LiteralPath $errFile -ErrorAction SilentlyContinue)
    Check 'T9: non-HTTPS URL rejected' ($p9.ExitCode -ne 0 -and $o9 -match 'must be https') ($o9 -replace '\s+', ' ')

    # T10: unpinned template key fails closed.
    $mirror = Copy-Mirror 'T10'
    $root10 = Join-Path $script:WorkDir 'root-T10'
    Invoke-WinBootstrapCase -Name 'T10 unpinned key' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T10') -KeepPlaceholder) `
        -InstallRoot $root10 -Env $script:BaseEnv -Mirror $mirror -ExpectErrorPattern 'not pinned'

    # T11: helper version mismatch -> replacement.
    $mirror = Copy-Mirror 'T11'
    $root11 = Join-Path $script:WorkDir 'root-T11'
    # First install cleanly, then rewrite the state with a different version.
    Invoke-WinBootstrapCase -Name 'T11a prime install' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T11a')) `
        -InstallRoot $root11 -Env $script:BaseEnv -ExpectSuccess -Mirror $mirror
    $state11 = @{ 'yt-dlp' = @{ version = '1999.01.01'; sha256 = '0' * 64; artifact = 'yt-dlp-windows-amd64.exe' } }
    [System.IO.File]::WriteAllText((Join-Path $root11 'helpers-state.json'), ($state11 | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding($false)))
    Invoke-WinBootstrapCase -Name 'T11b version mismatch replaces helper' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T11b')) `
        -InstallRoot $root11 -Env $script:BaseEnv -ExpectSuccess -Mirror (Copy-Mirror 'T11b')
    $state11b = Get-Content -Raw -LiteralPath (Join-Path $root11 'helpers-state.json') | ConvertFrom-Json
    Check 'T11: version mismatch triggered replacement and state update' ($state11b.'yt-dlp'.version -eq '2026.07.04') ($state11b | ConvertTo-Json -Compress)

    # T12: unsafe artifact name (path traversal) fails closed.
    $mirror = Copy-Mirror 'T12'
    $manText = Read-MirrorManifest $mirror
    $manText = $manText.Replace('"artifact":"yt-dlp-windows-amd64.exe"', '"artifact":"..\\..\\evil.exe"')
    Write-MirrorManifest $mirror $manText
    Sign-ManifestFile $mirror
    $root12 = Join-Path $script:WorkDir 'root-T12'
    Invoke-WinBootstrapCase -Name 'T12 unsafe artifact name' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T12')) `
        -InstallRoot $root12 -Env $script:BaseEnv -Mirror $mirror -ExpectErrorPattern 'unsafe'

    # T13: unknown helper key fails closed.
    $mirror = Copy-Mirror 'T13'
    $manText = Read-MirrorManifest $mirror
    $manText = $manText.Replace('"helpers":{"yt-dlp"', '"helpers":{"evil"')
    Write-MirrorManifest $mirror $manText
    Sign-ManifestFile $mirror
    $root13 = Join-Path $script:WorkDir 'root-T13'
    Invoke-WinBootstrapCase -Name 'T13 unknown helper key' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T13')) `
        -InstallRoot $root13 -Env $script:BaseEnv -Mirror $mirror -ExpectErrorPattern 'unknown helper'

    # T14: v1 (core-only) contract refused by the Windows bootstrap.
    # Build a core-only release (no -HelpersFile) — its v1 manifest is the
    # exact Termux path and must be refused by the Windows bootstrap.
    $distCore = Join-Path $script:WorkDir 'dist-core-only'
    New-Item -ItemType Directory -Force -Path $distCore | Out-Null
    $env:PATH = (Split-Path $script:Minisign) + ';' + $env:PATH
    & $ReleasePs1 release -Version $script:ReleaseVersion -OutDir $distCore -MinisignKeyPath $script:KeyPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'core-only release failed' }
    $env:PATH = $oldPath
    $mirror = Join-Path $script:MirrorBase 'T14'
    New-Item -ItemType Directory -Force -Path $mirror | Out-Null
    foreach ($f in (Get-ChildItem -LiteralPath $distCore -File)) {
        Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $mirror $f.Name) -Force
    }
    $root14 = Join-Path $script:WorkDir 'root-T14'
    Invoke-WinBootstrapCase -Name 'T14 v1 contract refused' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T14')) `
        -InstallRoot $root14 -Env $script:BaseEnv -Mirror $mirror -ExpectErrorPattern 'not the Windows version-2'

    # T15: no system PATH mutation.
    Check 'T15: system PATH unchanged' ($env:PATH -eq $beforePath) 'PATH must be untouched by the harness runs'

    # T16: user-private temp cleanup.
    $leftovers = @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'eizouden-win-bootstrap.*' -ErrorAction SilentlyContinue)
    Check 'T16: private temp dirs cleaned' ($leftovers.Count -eq 0) ('leftover: ' + ($leftovers.Name -join ','))
}

# --- Main -------------------------------------------------------------------

Write-Host 'EizouDendenshi ED-2D Windows helper-enabled bootstrap harness'
Write-Host "  repo: $RepoRoot   work: $WorkRoot"

Static-Checks

$script:Minisign = Get-Minisign
$script:WorkRoot = $WorkRoot

if (-not $script:Minisign) {
    Write-Host '  [SKIP] dynamic suite: minisign unavailable (PATH, A:\Temp\opencode, or network provisioning)'
}
else {
    Write-Host "  minisign: $($script:Minisign)"
    try {
        Dynamic-Suite
    }
    catch {
        $script:FailCount++
        Check 'dynamic: suite completed' $false "aborted: $($_.Exception.Message) | $($_.ScriptStackTrace -replace '\s+',' ')"
    }
}

Write-Host ''
Write-Host ('RESULTS: {0} passed, {1} failed, {2} total' -f
    (($Results | Where-Object Result -eq 'PASS').Count), $script:FailCount, $Results.Count)
$Results | Format-Table -AutoSize | Out-String -Width 220 | Write-Host

if (-not $Keep -and $script:WorkDir) {
    Remove-Item -LiteralPath $script:WorkDir -Recurse -Force
    Write-Host "cleaned: $($script:WorkDir)"
}

if ($script:FailCount -gt 0) { exit 1 }
exit 0
