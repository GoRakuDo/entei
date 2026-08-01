# EizouDendenshi ED-2G torrent magnet QA script (user-run, non-executed by CI).
#
# A QA-only helper: the USER runs this script interactively to exercise the
# real torrent job API (create -> poll -> files -> select -> Range) against
# their own private Eizou install. It never downloads media, never touches
# the user's real install, and never persists anything sensitive.
#
# Security properties (do not weaken):
#   - The magnet is read ONLY via `Read-Host -AsSecureString` and converted
#     in process memory; it is NEVER echoed, saved, logged, or written to
#     console / file / error / transcript / history. The script rejects
#     non-interactive invocation.
#   - The companion is started as an OWNED process with stdout/stderr
#     redirected to private transient files (hidden window). The pairing
#     code is extracted ONLY from that private log and is never printed; the
#     pairing token stays in process memory only.
#   - The addr must be a literal loopback (127.0.0.1 / ::1 / localhost);
#     helper paths must be the user's own private install layout (or
#     explicit -CorePath/-Aria2Path) — arbitrary PATH helpers are never
#     used, and no installs / Invoke-Expression / remote script fetching
#     occur.
#   - A pre-existing 4322 listener fails the script safely before anything
#     is started (never stopped). On Ctrl+C / error / timeout: the job is
#     cancelled best-effort, ONLY the owned core process tree is stopped,
#     ONLY the script-created transient temp dir/logs are removed, and the
#     script reports whether 4322 is free afterward. The user's install
#     root, persistent config, home caches, global PATH, and unrelated
#     processes are never touched.
#   - API errors map to generic safe labels; raw server detail is never
#     rendered (it may contain sensitive data).
#
# Usage (interactive terminal only):
#   pwsh -NoProfile -File scripts/qa-torrent-magnet.ps1 -InstallRoot <your private install root>
#   pwsh -NoProfile -File scripts/qa-torrent-magnet.ps1 -CorePath <core> -Aria2Path <aria2c>
#
# Static self-validation (no torrent, no network):
#   pwsh -NoProfile -File scripts/qa-torrent-magnet.ps1 -SelfTest

[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$CorePath = '',
    [string]$Aria2Path = '',
    [string]$Addr = '127.0.0.1:4322',
    [string]$Origin = 'http://localhost:4321',
    [int]$TimeoutMin = 15,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- constants --------------------------------------------------------------

$script:TransientRoot = ''
$script:OwnedCorePid = $null
$script:CtrlC = $false
$script:CancelHandler = $null

# Expected private-install layout (from the windows-bootstrap contract).
$script:ExpectedCore = 'eizouden-windows-amd64.exe'
$script:ExpectedAria2 = 'helpers\aria2c.exe'

# --- helpers ----------------------------------------------------------------

function Exit-Fail([string]$Msg) {
    # Friendly message only; never reveals raw API detail or secrets.
    Write-Error "qa-torrent-magnet: $Msg"
    exit 1
}

function Assert-Interactive {
    if ($Host.Name -ne 'ConsoleHost' -or -not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
        Exit-Fail 'this script must be run interactively in a terminal (stdin must not be redirected)'
    }
}

function Assert-LoopbackAddr([string]$Spec, [string]$What) {
    if ($Spec -eq '') { throw "$What address is empty" }
    $hostPart = $Spec
    # Extract the host before an optional :port (handles IPv6 literals like
    # ::1:4322, where a plain colon-split would break).
    if ($Spec -match '^(\S+):\d{1,5}$') { $hostPart = $Matches[1] }
    if ($hostPart -notin @('127.0.0.1', '::1', 'localhost')) {
        throw "$What address must be a literal loopback (127.0.0.1 / ::1 / localhost); refusing non-loopback"
    }
    return $Spec
}

function Assert-UserPath([string]$Path, [string]$What) {
    if ($Path -eq '') { return $false }
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $full)) { return $false }
    foreach ($bad in @($env:WINDIR, "$env:ProgramFiles", "${env:ProgramFiles(x86)}")) {
        if ($bad -and $full.StartsWith($bad, [System.StringComparison]::OrdinalIgnoreCase)) {
            Exit-Fail "$What must be a user-owned path (system locations are refused)"
        }
    }
    return $true
}

function Resolve-Paths {
    # Either an explicit -InstallRoot (bootstrap layout) or explicit
    # -CorePath / -Aria2Path. Never PATH lookup.
    if ($InstallRoot -ne '') {
        if ($CorePath -ne '' -or $Aria2Path -ne '') {
            Exit-Fail 'choose EITHER -InstallRoot OR -CorePath/-Aria2Path, not both'
        }
        $root = [System.IO.Path]::GetFullPath($InstallRoot)
        if (-not (Test-Path -LiteralPath $root)) {
            Exit-Fail 'the install root does not exist (hint: run the windows bootstrap first, or pass -InstallRoot explicitly)'
        }
        $core = Join-Path $root $script:ExpectedCore
        $aria2 = Join-Path $root $script:ExpectedAria2
        if (-not (Test-Path -LiteralPath $core) -or -not (Test-Path -LiteralPath $aria2)) {
            Exit-Fail 'the install root does not match the expected private layout (eizouden-windows-amd64.exe + helpers\aria2c.exe)'
        }
        Assert-UserPath $root 'install root'
        return @{ core = $core; aria2 = $aria2 }
    }
    if ($CorePath -eq '' -or $Aria2Path -eq '') {
        Exit-Fail 'pass -InstallRoot, or both -CorePath and -Aria2Path'
    }
    Assert-UserPath $CorePath 'core path'
    Assert-UserPath $Aria2Path 'aria2 path'
    if ((Get-Item -LiteralPath $CorePath).PSIsContainer -or (Get-Item -LiteralPath $Aria2Path).PSIsContainer) {
        Exit-Fail 'core and aria2 paths must be files, not directories'
    }
    return @{ core = [System.IO.Path]::GetFullPath($CorePath); aria2 = [System.IO.Path]::GetFullPath($Aria2Path) }
}

function New-TransientRoot {
    $script:TransientRoot = Join-Path $env:TEMP ("entei-qa-torrent." + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:TransientRoot | Out-Null
}

function Remove-TransientRoot {
    if ($script:TransientRoot -and (Test-Path -LiteralPath $script:TransientRoot)) {
        Remove-Item -LiteralPath $script:TransientRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Get-PortFree([int]$Port) {
    return ($null -eq (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue))
}

function Start-OwnedCompanion([string]$CoreExe, [string]$Aria2Exe, [string]$AddrSpec) {
    if (-not (Get-PortFree 4322)) {
        Exit-Fail 'port 4322 is already in use by another process — please stop the existing EizouDendenshi instance first (the QA script will not touch it)'
    }
    $outLog = Join-Path $script:TransientRoot 'companion.out.log'
    $errLog = Join-Path $script:TransientRoot 'companion.err.log'
    $p = Start-Process -FilePath $CoreExe `
        -ArgumentList @('--addr', $AddrSpec, '--aria2', "`"$Aria2Exe`"", '--torrent-timeout', "$($TimeoutMin)m") `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
        -WindowStyle Hidden -PassThru
    $script:OwnedCorePid = $p.Id
    return @{ proc = $p; out = $outLog; err = $errLog }
}

function Stop-OwnedTree([int]$Pid) {
    if ($Pid) {
        & 'C:\Windows\System32\taskkill.exe' /T /F /PID $Pid 2>&1 | Out-Null
    }
}

function Get-PairingCode([string]$OutLog, [int]$TimeoutSec) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($script:CtrlC) { return '' }
        $o = if (Test-Path -LiteralPath $OutLog) { Get-Content -Raw -LiteralPath $OutLog -ErrorAction SilentlyContinue } else { '' }
        $m = [regex]::Match([string]$o, 'Pairing code:\s*(\d{6})')
        if ($m.Success) { return $m.Groups[1].Value }
        if ($script:OwnedCorePid -and (Get-Process -Id $script:OwnedCorePid -ErrorAction SilentlyContinue) -eq $null) { return '' }
        Start-Sleep -Milliseconds 300    }
    return ''
}

function Invoke-Api([string]$Method, [string]$Path, [string]$Token, [hashtable]$Body) {
    # Gated companion call. Errors map to generic safe labels; the raw body
    # is never rendered.
    $uri = "http://$Addr$Path"
    if ($Token) { $sep = if ($Path.Contains('?')) { '&' } else { '?' }; $uri += "$sep" + 'token=' + [uri]::EscapeDataString($Token) }
    $headers = @{ Origin = $Origin }
    try {
        $params = @{
            Uri = $uri; Method = $Method; Headers = $headers; UseBasicParsing = $true
            SkipHttpErrorCheck = $true; TimeoutSec = 60
        }
        if ($Body) { $params.ContentType = 'application/json'; $params.Body = ($Body | ConvertTo-Json -Compress -Depth 4) }
        return Invoke-WebRequest @params
    }
    catch {
        return $null   # network-level failure surfaced by the caller as a safe label
    }
}

function Label-Status([int]$Code) {
    switch ($Code) {
        200 { return 'ok' }
        201 { return 'created' }
        400 { return 'invalid magnet (rejected by the companion)' }
        401 { return 'authentication required (re-pair needed)' }
        403 { return 'origin not allowed (authentication)' }
        404 { return 'not found (job or media missing)' }
        409 { return 'a job is already active (conflict)' }
        503 { return 'media not ready yet (buffering)' }
        default { return "unexpected response ($Code)" }
    }
}

function Assert-Cleanup {
    if (Get-PortFree 4322) { Write-Host '[qa] port 4322 is free after cleanup' }
    else { Write-Warning '[qa] port 4322 is STILL in use after cleanup — an unrelated process may hold it' }
}

# --- self-test (no torrent, no network) -------------------------------------

function Invoke-SelfTest {
    Write-Host '[qa] self-test: static contract validation only (no torrent, no network)'
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$null, [ref]$errors)
    if ($errors.Count -gt 0) {
        Write-Host "[qa] PARSE FAIL: $($errors[0].Message)"
        exit 1
    }
    Write-Host '[qa] parse via Parser API: OK'

    # Scan ONLY the run-mode code: strip comments and this validator's own
    # body (its forbidden-pattern list must not flag itself), then check for
    # the forbidden patterns and the magnet-leak rule.
    $src = Get-Content -Raw -LiteralPath $PSCommandPath
    $code = ($src -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    # The self-test's own forbidden-pattern list must not flag itself, so
    # its function body is excluded from the scan. The next code marker is
    # the concrete Ctrl+C registration outside this function. Build it from
    # pieces so the validator does not match its own marker assignment.
    $start = $code.IndexOf('function Invoke-SelfTest')
    $marker = '[Console]::add_' + 'CancelKeyPress('
    $end = $code.IndexOf($marker)
    if ($start -ge 0 -and $end -gt $start) {
        $code = $code.Substring(0, $start) + $code.Substring($end)
    }

    $forbidden = @(
        'Invoke-Expression',
        'Start-Job',
        '[Environment]::SetEnvironmentVariable',
        'ConvertTo-SecureString',
        'Get-Command',
        'curl', '| sh', '| bash',
        'New-ItemProperty', 'Set-ItemProperty'
    )
    $bad = @()
    foreach ($f in $forbidden) { if ($code -match [regex]::Escape($f)) { $bad += $f } }
    if ($bad.Count -gt 0) { Write-Host "[qa] FORBIDDEN PATTERNS: $($bad -join ', ')"; exit 1 }
    Write-Host '[qa] forbidden persistence/unsafe patterns: none'

    # The magnet variable must never appear in any output statement.
    $leaks = @()
    foreach ($line in ($code -split "`n")) {
        if ($line -match 'Write-(Output|Host|Error|Warning)|Write-Information' -and $line -match '\$magnet') {
            $leaks += $line.Trim()
        }
    }
    if ($leaks.Count -gt 0) { Write-Host "[qa] MAGNET LEAK in output: $($leaks -join ' | ')"; exit 1 }
    Write-Host '[qa] magnet never echoed: OK'

    # Unit checks for the pure validation functions.
    $ok = $true
    try {
        Assert-LoopbackAddr '127.0.0.1:4322' 'test'
        Assert-LoopbackAddr 'localhost:4322' 'test'
        Assert-LoopbackAddr '::1:4322' 'test'
        Assert-LoopbackAddr '127.0.0.1' 'test'
    } catch { $ok = $false }
    try { Assert-LoopbackAddr '192.168.1.10:4322' 'test'; $ok = $false } catch { }
    if (-not $ok) { Write-Host '[qa] loopback validation FAIL'; exit 1 }
    Write-Host '[qa] loopback validation: OK'
    Write-Host '[qa] self-test PASSED'
    exit 0
}

# --- main -------------------------------------------------------------------

# Console.CancelKeyPress is a .NET event, not a collection. Calling `.Add()`
# on its value returns a null-reference error before the QA flow begins. Keep
# the concrete delegate so it can be removed again during normal cleanup.
$script:CancelHandler = [ConsoleCancelEventHandler]{
    param($sender, $eventArgs)
    $eventArgs.Cancel = $true
    $script:CtrlC = $true
    Write-Host ''
    Write-Host '[qa] Ctrl+C received — cleaning up owned resources'
}
[Console]::add_CancelKeyPress($script:CancelHandler)

if ($SelfTest) { Invoke-SelfTest }

Assert-Interactive
$paths = Resolve-Paths
try { $addrSpec = Assert-LoopbackAddr $Addr 'companion' } catch { Exit-Fail $_.Exception.Message }
if ($Origin -notmatch '^https?://') { Exit-Fail 'origin must be http(s)://...' }
New-TransientRoot

try {
    Write-Host '[qa] preflight:'
    Write-Host "[qa]   companion addr : $addrSpec (loopback only)"
    Write-Host '[qa]   core + aria2   : present (user-owned private install)'
    Write-Host "[qa]   job timeout    : $TimeoutMin minutes"

    Write-Host '[qa] starting the companion (private logs, hidden window)...'
    $comp = Start-OwnedCompanion $paths.core $paths.aria2 $addrSpec

    $code = Get-PairingCode $comp.out 60
    if ($code -eq '') { Exit-Fail 'companion did not print a pairing code within 60s' }
    Write-Host '[qa] paired (code kept private)'

    $pair = Invoke-Api 'POST' '/v1/pair' '' @{ code = $code }
    if ($null -eq $pair -or $pair.StatusCode -ne 200) {
        Exit-Fail ('pairing failed: ' + $(if ($null -eq $pair) { 'companion unreachable' } else { Label-Status $pair.StatusCode }))
    }
    $token = (($pair.Content | ConvertFrom-Json).token)
    if (-not $token) { Exit-Fail 'pairing response carried no token' }

    Write-Host '[qa] paste your magnet URI now (hidden input; never echoed or saved):'
    $sec = Read-Host -AsSecureString 'magnet'
    if ($null -eq $sec -or $sec.Length -eq 0) { Exit-Fail 'no magnet entered' }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $magnet = [Runtime.InteropServices.Marshal]::PtrToStringUni($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $sec.Dispose()

    $create = Invoke-Api 'POST' '/v1/source/torrents' $token @{ magnet = $magnet }
    if ($null -eq $create -or $create.StatusCode -ne 201) {
        Exit-Fail ('job create failed: ' + $(if ($null -eq $create) { 'companion unreachable' } else { Label-Status $create.StatusCode }))
    }
    $jobId = (($create.Content | ConvertFrom-Json).id)
    Write-Host "[qa] job created (id $($jobId.Substring(0, 8))…) — polling redacted status"

    $deadline = [DateTime]::UtcNow.AddMinutes($TimeoutMin)
    $jobState = ''
    for (;;) {
        if ($script:CtrlC) { break }
        if ([DateTime]::UtcNow -ge $deadline) { Write-Host '[qa] HARD TIMEOUT reached'; break }
        $r = Invoke-Api 'GET' "/v1/source/torrents/$jobId" $token $null
        if ($null -eq $r) { Start-Sleep -Seconds 5; continue }
        $j = $r.Content | ConvertFrom-Json
        $jobState = $j.state
        Write-Host ("[qa] state={0} available={1} total={2}" -f $j.state, $j.media.available, $j.media.total)
        if ($j.state -eq 'buffering' -or $j.state -eq 'error' -or $j.state -eq 'complete') { break }
        Start-Sleep -Seconds 5
    }
    if ($script:CtrlC) { Exit-Fail 'aborted by user (cleanup in progress)' }
    if ($jobState -ne 'buffering' -and $jobState -ne 'complete') {
        Exit-Fail ("job ended in state '$jobState' (no selectable media); see the private companion log")
    }

    $files = Invoke-Api 'GET' "/v1/source/torrents/$jobId/files" $token $null
    if ($null -eq $files -or $files.StatusCode -ne 200) {
        Exit-Fail ('file listing failed: ' + $(if ($null -eq $files) { 'companion unreachable' } else { Label-Status $files.StatusCode }))
    }
    $fileList = (($files.Content | ConvertFrom-Json).files)
    Write-Host '[qa] sanitized file listing (opaque ids only):'
    $fileList | Select-Object id, basename, extension, byteSize, kind | Format-Table -AutoSize | Out-String | Write-Host

    $videos = @($fileList | Where-Object { $_.kind -eq 'video' })
    if ($videos.Count -eq 0) { Exit-Fail 'no eligible video file in the torrent' }
    $videoId = Read-Host 'video file id (opaque)'
    if ($videoId -notin @($videos.id)) { Exit-Fail 'selected video id is not in the listing' }
    $subId = Read-Host 'subtitle file id (Enter to skip)'
    if ($subId -ne '') {
        $subs = @($fileList | Where-Object { $_.kind -eq 'subtitle' })
        if ($subId -notin @($subs.id)) { Exit-Fail 'selected subtitle id is not a subtitle file' }
    }

    $sel = Invoke-Api 'POST' "/v1/source/torrents/$jobId/select" $token @{ videoFileId = $videoId; subtitleFileId = $subId }
    if ($null -eq $sel -or $sel.StatusCode -ne 200) {
        Exit-Fail ('selection failed: ' + $(if ($null -eq $sel) { 'companion unreachable' } else { Label-Status $sel.StatusCode }))
    }

    # Small Range probe from the fixture endpoint: HTTP status + header byte
    # count only — media bytes are never written or displayed.
    $rangeUri = "http://$Addr/v1/media/fixture?token=" + [uri]::EscapeDataString($token)
    try {
        $resp = Invoke-WebRequest -Uri $rangeUri -Method Get -Headers @{ Origin = $Origin; Range = 'bytes=0-1023' } `
            -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 60
        $cr = $resp.Headers['Content-Range']
        Write-Host ("[qa] fixture Range probe: HTTP {0}  Content-Range: {1}  bytes: {2}" -f $resp.StatusCode, $cr, $resp.RawContentLength)
    }
    catch {
        Write-Host '[qa] fixture Range probe: companion unreachable (safe label)'
    }

    Write-Host '[qa] done — cancelling the job (best effort) and cleaning up owned resources'
}
finally {
    if ($jobId) {
        $null = Invoke-Api 'POST' "/v1/source/torrents/$jobId/cancel" $token $null
    }
    if ($script:OwnedCorePid) {
        Stop-OwnedTree $script:OwnedCorePid
        $script:OwnedCorePid = $null
    }
    Remove-TransientRoot
    Assert-Cleanup
    if ($null -ne $script:CancelHandler) {
        [Console]::remove_CancelKeyPress($script:CancelHandler)
        $script:CancelHandler = $null
    }
}
