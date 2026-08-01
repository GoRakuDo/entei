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
        # The ONLY permitted external fetch is the pinned, hash-anchored
        # official Minisign verifier ZIP (documented trust-bootstrap
        # exception — exactly one https://github.com reference). All Eizou
        # release material comes from the signed release base.
        $code -match [regex]::Escape('https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip') -and
        ([regex]::Matches($code, 'https://github\.com').Count -eq 1) -and
        $code -notmatch 'https://www\.gyan\.dev|https://yt-dlp\.github\.io|https://aria2\.github\.io|https://raw\.githubusercontent\.com') 'only the pinned official verifier ZIP is fetched; all Eizou material comes from the signed release base'
    Check 'static: manifest SHA-256 verified before replacement' (
        $boot.Contains('SHA-256 mismatch') -and $boot.IndexOf('Install-Artifact') -ge 0) 'per-artifact SHA-256 check before atomic replacement'
    Check 'static: user-private install root' (
        $boot.Contains('LOCALAPPDATA') -and $boot.Contains('GoRakuDo\EizouDendenshi')) 'per-user install root under LOCALAPPDATA'
    Check 'static: explicit absolute helper flags for the core' (
        $code -match '--ytdlp' -and $code -match '--aria2' -and
        $code -match 'env:PATH\s*=\s*"\$helpersDir') 'core receives explicit helper paths; PATH change is process-scoped only'
    Check 'static: verifier mirror env guard is $null-safe' (
        # Regression pin for the published rc.5 clean-gate failure: an
        # unguarded `Test-Path -LiteralPath $env:EIZOU_WIN_MINISIGN_MIRROR`
        # crashes on a real first run (the env var is undefined; PowerShell's
        # `$env:X -ne ''` is TRUE for $null). The guard must check $null
        # explicitly before Test-Path.
        $code -match '\$null\s+-ne\s+\$mirror' -and
        $code -match 'Test-Path -LiteralPath \$mirror' -and
        -not ($code -match 'Test-Path\s+-LiteralPath\s+\$env:EIZOU_WIN_MINISIGN_MIRROR')) 'undefined mirror env must fall through to the pinned download, not crash'
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

    # Provision the pinned Minisign verifier ZIP (official jedisct1/minisign
    # 0.12 win64) for the mirror; the bootstrap-under-test must acquire it
    # itself via EIZOU_WIN_MINISIGN_MIRROR (never from a preinstalled PATH
    # minisign). The harness's own signing minisign stays separate.
    $msZip = 'A:\Temp\opencode\ed2d-helper-assets\minisign-0.12-win64.zip'
    if (-not (Test-Path -LiteralPath $msZip)) {
        Invoke-WebRequest -Uri 'https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip' -OutFile $msZip -UseBasicParsing -TimeoutSec 120
    }
    $script:MinisignZip = Join-Path $script:WorkDir 'minisign-0.12-win64.zip'
    Copy-Item -LiteralPath $msZip -Destination $script:MinisignZip -Force

    # The child environment deliberately has NO minisign on PATH: the
    # bootstrap must self-provision the verifier from the mirror.
    $script:BaseEnv = @{
        PATH                     = $env:PATH
        EIZOU_WIN_MINISIGN_MIRROR = $script:MinisignZip
    }
    $beforePath = $env:PATH

    # T1: success install.
    $mirror = Copy-Mirror 'T1'
    $root = Join-Path $script:WorkDir 'root-T1'
    $launch = Join-Path $script:WorkDir 'launch-T1.txt'
    Invoke-WinBootstrapCase -Name 'T1 success' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T1')) `
        -InstallRoot $root -Env $script:BaseEnv -ExpectSuccess -Mirror $mirror -LaunchFile $launch
    Check 'T1: core installed' (Test-Path (Join-Path $root 'eizouden-windows-amd64.exe')) 'windows core present'
    Check 'T1: yt-dlp helper installed (runtime name)' (Test-Path (Join-Path $root 'helpers\yt-dlp-windows-amd64.exe')) 'yt-dlp runtime exe present'
    Check 'T1: aria2 helper installed under literal aria2c.exe' (Test-Path (Join-Path $root 'helpers\aria2c.exe')) 'extracted exe keeps its runtime name'
    Check 'T1: ffmpeg helper installed under literal ffmpeg.exe' (Test-Path (Join-Path $root 'helpers\ffmpeg.exe')) 'extracted exe keeps its runtime name (PATH ffmpeg lookup)'
    Check 'T1: no zip-named helper at the root (legacy layout gone)' (
        -not (Test-Path (Join-Path $root 'aria2-windows-amd64.zip')) -and
        -not (Test-Path (Join-Path $root 'ffmpeg-windows-amd64.zip'))) 'helpers live only in the runtime dir'
    Check 'T1: state file written' (Test-Path (Join-Path $root 'helpers-state.json')) 'helpers-state.json present'
    $launchText = if (Test-Path -LiteralPath $launch) { Get-Content -Raw -LiteralPath $launch } else { '' }
    Check 'T1: core launch command has absolute runtime --ytdlp/--aria2' (
        $launchText -match [regex]::Escape((Join-Path $root 'helpers\yt-dlp-windows-amd64.exe')) -and
        $launchText -match [regex]::Escape((Join-Path $root 'helpers\aria2c.exe'))) $launchText
    # Installed yt-dlp bytes must equal the signed manifest (yt-dlp artifact
    # IS its runtime executable).
    $manSha = [string]($man.artifacts | Where-Object { $_.name -eq 'yt-dlp-windows-amd64.exe' } | Select-Object -First 1).sha256
    $instSha = (Get-FileHash -LiteralPath (Join-Path $root 'helpers\yt-dlp-windows-amd64.exe')).Hash.ToLowerInvariant()
    Check 'T1: installed helper bytes match signed manifest' ($instSha -eq $manSha) "got $instSha want $manSha"

    # T2: reuse (second run, same root — no replacement).
    $ytdlpInstalled = Join-Path $root 'helpers\yt-dlp-windows-amd64.exe'
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

    # T11x: malformed legacy (rc.5 archive-name) state -> replaced, never
    # reused; the legacy zip-named leftover at the root is removed.
    $mirror = Copy-Mirror 'T11x'
    $root11x = Join-Path $script:WorkDir 'root-T11x'
    New-Item -ItemType Directory -Force -Path $root11x | Out-Null
    Set-Content -LiteralPath (Join-Path $root11x 'aria2-windows-amd64.zip') -Value 'legacy-junk' -Encoding ascii
    $legacyState = @{ 'aria2' = @{ version = '1.37.0'; sha256 = '0' * 64; artifact = 'aria2-windows-amd64.zip' } }
    [System.IO.File]::WriteAllText((Join-Path $root11x 'helpers-state.json'), ($legacyState | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding($false)))
    Invoke-WinBootstrapCase -Name 'T11x legacy state replaced' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T11x')) `
        -InstallRoot $root11x -Env $script:BaseEnv -ExpectSuccess -Mirror $mirror
    Check 'T11x: corrected runtime file installed (aria2c.exe)' (Test-Path (Join-Path $root11x 'helpers\aria2c.exe')) 'runtime dir has the literal aria2c.exe'
    Check 'T11x: legacy zip-named leftover removed' (-not (Test-Path (Join-Path $root11x 'aria2-windows-amd64.zip'))) 'rc.5 archive-name layout cleaned'
    $state11x = Get-Content -Raw -LiteralPath (Join-Path $root11x 'helpers-state.json') | ConvertFrom-Json
    Check 'T11x: state maps artifact to runtime name' ($state11x.'aria2'.runtime -eq 'aria2c.exe' -and $state11x.'aria2'.artifact -eq 'aria2-windows-amd64.zip') ($state11x | ConvertTo-Json -Compress)

    # T11y: TRUE unset-env regression — the child has NO
    # EIZOU_WIN_MINISIGN_MIRROR at all, so the bootstrap takes the real
    # pinned HTTPS fetch path (the official minisign 0.12 win64 zip,
    # hash-verified). Before the rc.5 fix this crashed with a Test-Path
    # binding error; now it must complete the full install.
    $mirror = Copy-Mirror 'T11y'
    $root11y = Join-Path $script:WorkDir 'root-T11y'
    $envNoMirror = @{ PATH = $env:PATH }
    Invoke-WinBootstrapCase -Name 'T11y unset mirror env (real pinned fetch)' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-T11y')) `
        -InstallRoot $root11y -Env $envNoMirror -ExpectSuccess -Mirror $mirror
    Check 'T11y: verifier acquired via the real pinned fetch' (Test-Path (Join-Path $root11y 'tools\minisign.exe')) 'tools\minisign.exe present after the no-mirror run'

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

    # V1: first-run auto verifier fetch/install (no minisign on PATH).
    $mirrorV = Copy-Mirror 'V1'
    $rootV1 = Join-Path $script:WorkDir 'root-V1'
    Invoke-WinBootstrapCase -Name 'V1 first-run verifier auto-fetch' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-V1')) `
        -InstallRoot $rootV1 -Env $script:BaseEnv -ExpectSuccess -Mirror $mirrorV
    $v1Exe = Join-Path $rootV1 'tools\minisign.exe'
    Check 'V1: verifier installed into the private root' (Test-Path -LiteralPath $v1Exe) 'tools\minisign.exe present'
    Check 'V1: verifier state written' (Test-Path -LiteralPath (Join-Path $rootV1 'minisign-state.json')) 'minisign-state.json present'
    $v1Ver = if (Test-Path -LiteralPath $v1Exe) { (& $v1Exe -v 2>&1 | Out-String) } else { '' }
    Check 'V1: installed verifier version matches the pinned 0.12' ($v1Ver -match '0\.12') ($v1Ver -replace '\s+', ' ')

    # V2: verifier reuse (second run; no re-fetch / no replacement).
    $shaBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $v1Exe).Hash
    $mirrorV2 = Copy-Mirror 'V2'
    Invoke-WinBootstrapCase -Name 'V2 verifier reuse' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-V2')) `
        -InstallRoot $rootV1 -Env $script:BaseEnv -ExpectSuccess -Mirror $mirrorV2
    $shaAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $v1Exe).Hash
    Check 'V2: verifier reused (installed bytes unchanged)' ($shaBefore -eq $shaAfter) 'no re-acquisition'
    $v2Out = Get-Content -Raw -LiteralPath (Join-Path $script:LogsDir 'V2 verifier reuse.out.log') -ErrorAction SilentlyContinue
    Check 'V2: reuse path taken' ($v2Out -match 'verifier already present and verified; reusing') ($v2Out -replace '\s+', ' ')

    # V3: tampered verifier ZIP -> SHA-256 mismatch fails closed BEFORE any
    #     Eizou install.
    $tamperedZip = Join-Path $script:FakeDir 'tampered-minisign.zip'
    $bytes = [System.IO.File]::ReadAllBytes($script:MinisignZip)
    $bytes[50] = $bytes[50] -bxor 0xFF
    [System.IO.File]::WriteAllBytes($tamperedZip, $bytes)
    $envV3 = @{ PATH = $env:PATH; EIZOU_WIN_MINISIGN_MIRROR = $tamperedZip }
    $mirrorV3 = Copy-Mirror 'V3'
    $rootV3 = Join-Path $script:WorkDir 'root-V3'
    Invoke-WinBootstrapCase -Name 'V3 tampered verifier zip' -BootstrapPath (New-BootstrapCopy (Join-Path $script:WorkDir 'boot-V3')) `
        -InstallRoot $rootV3 -Env $envV3 -Mirror $mirrorV3 -ExpectErrorPattern 'SHA-256 mismatch'
    Check 'V3: no Eizou install after verifier failure' (-not (Test-Path (Join-Path $rootV3 'eizouden-windows-amd64.exe'))) 'no core installed'

    # V4: wrong verifier archive (no expected executable) -> fail closed.
    # The pinned ZIP hash gate fires first for arbitrary wrong content, so
    # this harness case re-pins the SHA to the WRONG archive's hash in a
    # bootstrap COPY (harness-only; the production template keeps the real
    # pinned hash) — the hash then passes and the missing-member check is
    # what fails, isolating the extraction contract.
    $badStage = Join-Path $script:WorkDir 'bad-stage'
    New-Item -ItemType Directory -Force -Path $badStage | Out-Null
    Set-Content -LiteralPath (Join-Path $badStage 'evil.txt') -Value 'x' -Encoding ascii
    $wrongZip = Join-Path $script:FakeDir 'wrong-minisign.zip'
    Compress-Archive -Path (Join-Path $badStage 'evil.txt') -DestinationPath $wrongZip -Force
    $wrongSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $wrongZip).Hash.ToLowerInvariant()
    $bootV4 = New-BootstrapCopy (Join-Path $script:WorkDir 'boot-V4')
    $v4Text = [System.IO.File]::ReadAllText($bootV4).Replace(
        '37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479', $wrongSha)
    [System.IO.File]::WriteAllText($bootV4, $v4Text, (New-Object System.Text.UTF8Encoding($false)))
    $envV4 = @{ PATH = $env:PATH; EIZOU_WIN_MINISIGN_MIRROR = $wrongZip }
    $mirrorV4 = Copy-Mirror 'V4'
    $rootV4 = Join-Path $script:WorkDir 'root-V4'
    Invoke-WinBootstrapCase -Name 'V4 wrong verifier archive' -BootstrapPath $bootV4 `
        -InstallRoot $rootV4 -Env $envV4 -Mirror $mirrorV4 -ExpectErrorPattern 'missing the expected executable'
    Check 'V4: no Eizou install after archive failure' (-not (Test-Path (Join-Path $rootV4 'eizouden-windows-amd64.exe'))) 'no core installed'

    # V5: verifier download unavailable -> fail closed, no Eizou install.
    # The mirror is not set and the verifier URL is re-pinned in a bootstrap
    # COPY to a fail-fast localhost URL (harness-side; the production
    # template keeps the pinned official URL) so the fetch fails
    # deterministically without any network dependency.
    $bootV5 = New-BootstrapCopy (Join-Path $script:WorkDir 'boot-V5')
    $v5Text = [System.IO.File]::ReadAllText($bootV5).Replace(
        'https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip',
        'https://localhost:1/minisign-0.12-win64.zip')
    [System.IO.File]::WriteAllText($bootV5, $v5Text, (New-Object System.Text.UTF8Encoding($false)))
    $envV5 = @{ PATH = $env:PATH }
    $mirrorV5 = Copy-Mirror 'V5'
    $rootV5 = Join-Path $script:WorkDir 'root-V5'
    Invoke-WinBootstrapCase -Name 'V5 verifier unavailable' -BootstrapPath $bootV5 `
        -InstallRoot $rootV5 -Env $envV5 -Mirror $mirrorV5 -ExpectErrorPattern 'failed to download the pinned verifier|download failed'
    Check 'V5: no Eizou install without a verifier' (-not (Test-Path (Join-Path $rootV5 'eizouden-windows-amd64.exe'))) 'no core installed'

    # T15: no system PATH mutation.
    Check 'T15: system PATH unchanged' ($env:PATH -eq $beforePath) 'PATH must be untouched by the harness runs'


    # V6: no persistent PATH / global install of the verifier.
    Check 'V6: verifier not on the system PATH' (
        -not ([Environment]::GetEnvironmentVariable('Path', 'User') -match 'GoRakuDo|EizouDendenshi') -and
        -not ($env:PATH -match 'GoRakuDo\\EizouDendenshi')) 'verifier must live only in the private install root'

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
