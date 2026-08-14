# EizouDendenshi one-shot release publisher test harness.
#
# Runs on the Windows dev machine (pwsh). All temporary material —
# Minisign keys, the fake previous-release mirror, the fake gh
# executable, logs — lives under the temporary work root (default
# A:\Temp\opencode\ed2d-publish-test) and is removed at the end unless
# -Keep is passed. Nothing is written inside the repository (the two git
# cases temporarily swap the origin remote URL to a local bare repo and
# restore it in a finally block).
#
# The harness never touches the real network, the real Minisign key, or
# the real gh CLI:
#   - every release fetch goes through -HarnessMirrorDir (a local
#     directory mirroring GitHub releases as <tag>/<asset>);
#   - gh is replaced by EIZOU_PUBLISH_GH_BIN, a generated fake that
#     records every call, answers `release list` / `release view` with
#     canned JSON, and `release create` by copying the 13 assets into
#     the mirror (with per-case mutation hooks for the post-publish
#     failure cases);
#   - the git checks run against a local bare "fake origin" whose
#     main/tag refs the harness controls.
#
# Coverage:
#   PASS: full pipeline (reuse -> build -> local verification -> publish
#         -> post-publish verification); -SkipPublish publishes nothing;
#         -HelpersFile skips helper reuse.
#   FAIL (all fail closed): invalid -Version; release tag already
#         exists; HEAD != origin/main; helper signature mismatch; helper
#         SHA-256 mismatch; manifest version mismatch after publish;
#         minisign version too old; published asset count mismatch;
#         bootstrap pinned-key placeholder detected after publish.
#
# Static fail-closed checks on publish-release.ps1 always run, so the
# harness is never empty even when minisign is unavailable (dynamic
# suite self-skips, same policy as the sibling harnesses).

[CmdletBinding()]
param(
    [string]$WorkRoot = 'A:\Temp\opencode\ed2d-publish-test',
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PublishPs1 = Join-Path $PSScriptRoot 'publish-release.ps1'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$Results = [System.Collections.Generic.List[object]]::new()
$script:FailCount = 0
function Check([string]$Name, $Ok, [string]$Detail) {
    $b = $false
    try { $b = [bool]$Ok }
    catch { $Detail = "bool-convert-error ($($Ok.GetType().FullName)): $($_.Exception.Message) | $Detail" }
    $Results.Add([pscustomobject]@{ Case = $Name; Result = $(if ($b) { 'PASS' } else { 'FAIL' }); Detail = $Detail })
    if (-not $b) { $script:FailCount++ }
}

# --- Tool detection (same arrangement as test-release.ps1) ------------------

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

# --- Static fail-closed checks on publish-release.ps1 -----------------------

function Static-Checks {
    $text = [System.IO.File]::ReadAllText($PublishPs1)
    $code = ($text -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    Check 'static: publish-release.ps1 keeps LF endings' (-not $text.Contains("`r")) 'CRLF would break the LF contract'
    Check 'static: fetch uses bounded HTTPS-only redirects' (
        $code.Contains('MaximumRedirection 5') -and
        $code.Contains('BaseResponse.RequestMessage.RequestUri.Scheme') -and
        $code.Contains("ne 'https'")) 'every fetch must cap redirects at 5 and reject non-HTTPS final targets'
    Check 'static: harness gh override present' $code.Contains('EIZOU_PUBLISH_GH_BIN') 'fake gh injection point required'
    Check 'static: pinned-key placeholder fail-closed checks present' $code.Contains('REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY') 'placeholder detection required in the release verification'
    Check 'static: never prints the secret key path/value' (
        -not ($code -match 'Write-Host[^\r\n]*KeyPath') -and
        -not ($code -match 'Console::Out[^\r\n]*KeyPath')) 'key path/value must never reach output'
    Check 'static: no magnet URI in output paths' (-not $code.Contains('magnet')) 'magnet URIs must not be printed'
    Check 'static: gh release create contract' (
        $code.Contains('release') -and $code.Contains('--prerelease') -and
        $code.Contains('--target') -and $code.Contains('--notes-file')) 'create must pin the target commit and mark the release prerelease'
    Check 'static: fail closed with non-zero exit and temp cleanup' (
        $code.Contains('exit 1') -and $code.Contains('Remove-Item') -and $code.Contains('finally')) 'failures must exit non-zero and clean the work root'
    Check 'static: semver gate on -Version' $code.Contains("'^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'") 'invalid versions must be refused'
    $harnessText = [System.IO.File]::ReadAllText($PSScriptRoot + '\test-publish-release.ps1')
    Check 'static: harness itself keeps LF endings' (-not $harnessText.Contains("`r")) 'CRLF would break the LF contract'
}

# --- Fake gh generator --------------------------------------------------------

function New-FakeGh {
    param(
        [string]$CaseDir,
        [string]$MirrorRoot,
        [int]$ViewAssets = 13,
        [string]$Mutation = 'none',
        [object[]]$ListResponse = $null,
        [switch]$ProvideDigests,
        [string]$TamperDigestAsset = '',
        [switch]$NotPrerelease
    )
    New-Item -ItemType Directory -Force -Path $CaseDir | Out-Null
    $log = Join-Path $CaseDir 'gh-calls.log'
    $listJson = Join-Path $CaseDir 'list-response.json'
    $viewJson = Join-Path $CaseDir 'view-response.json'
    $listData = if ($null -ne $ListResponse) { $ListResponse } else { $script:ListResponse }
    [System.IO.File]::WriteAllText($listJson, ($listData | ConvertTo-Json -Depth 4 -Compress), $Utf8NoBom)
    $viewBody = [ordered]@{
        tagName         = $script:Tag
        isPrerelease    = -not $NotPrerelease
        targetCommitish = $script:HeadSha
        assets          = @($script:ViewAssetNames | Select-Object -First $ViewAssets | ForEach-Object { [pscustomobject]@{ name = $_ } })
    }
    [System.IO.File]::WriteAllText($viewJson, ($viewBody | ConvertTo-Json -Depth 4 -Compress), $Utf8NoBom)
    $fakeSrc = @'
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RawArgs
)
$ErrorActionPreference = 'Stop'
$log = '__LOG__'
$viewResponse = '__VIEW__'
$listResponse = '__LIST__'
$mirrorRoot = '__MIRROR__'
$mutation = '__MUTATION__'
[System.IO.File]::AppendAllText($log, ('CALL ' + ($RawArgs -join ' ')) + [Environment]::NewLine)
$cmd = $RawArgs[0]
if ($cmd -eq 'release' -and $RawArgs.Count -gt 1) { $cmd = $RawArgs[1] }
switch ($cmd) {
    'auth' { exit 0 }
    'list' { [Console]::Out.Write([System.IO.File]::ReadAllText($listResponse)); exit 0 }
    'view' {
        $json = [System.IO.File]::ReadAllText($viewResponse) | ConvertFrom-Json
        if ('__PROVIDE_DIGESTS__' -eq 'True') {
            # Mimic real gh: digest/size are per-asset properties of the
            # blobs GitHub hosts. In the harness those blobs are the files
            # the fake `create` already copied into mirror/<tag>.
            $tag = $RawArgs[2]
            foreach ($a in $json.assets) {
                $blob = Join-Path $mirrorRoot (Join-Path $tag $a.name)
                if (Test-Path -LiteralPath $blob) {
                    # Use raw .NET instead of Get-FileHash: the fake gh
                    # runs under whatever `powershell` resolves to in the
                    # child environment, so depend only on the Framework.
                    $shaHex = [BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.IO.File]::ReadAllBytes($blob))).Replace('-', '').ToLowerInvariant()
                    $a | Add-Member -NotePropertyName digest -NotePropertyValue ('sha256:' + $shaHex)
                    $a | Add-Member -NotePropertyName size -NotePropertyValue (Get-Item -LiteralPath $blob).Length
                }
            }
        }
        if ('__TAMPER_DIGEST_ASSET__' -ne '') {
            # Forge the digest of one asset so the publisher sees a
            # mismatch and must re-fetch + re-verify exactly that asset.
            foreach ($a in $json.assets) {
                if ($a.name -eq '__TAMPER_DIGEST_ASSET__') {
                    $a | Add-Member -NotePropertyName digest -NotePropertyValue ('sha256:' + ('0' * 64)) -Force
                }
            }
        }
        $viewText = $json | ConvertTo-Json -Depth 6 -Compress
        [Console]::Out.Write($viewText)
        exit 0
    }
    'create' {
        $tag = $RawArgs[2]
        $assets = @()
        $i = 3
        while ($i -lt $RawArgs.Count -and -not $RawArgs[$i].StartsWith('--')) { $assets += $RawArgs[$i]; $i++ }
        $dest = Join-Path $mirrorRoot $tag
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        foreach ($a in $assets) {
            Copy-Item -LiteralPath $a -Destination (Join-Path $dest (Split-Path $a -Leaf)) -Force
        }
        if ($mutation -eq 'tamperVersion') {
            $mp = Join-Path $dest 'eizouden-manifest.json'
            $text = [System.IO.File]::ReadAllText($mp)
            $text = [regex]::Replace($text, '"version":"[^"]+"', '"version":"9.9.7-tampered"')
            [System.IO.File]::WriteAllText($mp, $text, (New-Object System.Text.UTF8Encoding($false)))
        }
        elseif ($mutation -eq 'tamperBootstrapPlaceholder') {
            $bp = Join-Path $dest 'eizouden-bootstrap.ps1'
            $text = [System.IO.File]::ReadAllText($bp)
            $text = [regex]::Replace($text, 'RW[A-Za-z0-9+/]+', 'REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY')
            [System.IO.File]::WriteAllText($bp, $text, (New-Object System.Text.UTF8Encoding($false)))
        }
        [System.IO.File]::AppendAllText($log, ('CREATE ' + $tag + ' assets=' + $assets.Count) + [Environment]::NewLine)
        exit 0
    }
    default {
        [System.IO.File]::AppendAllText($log, ('UNKNOWN ' + $RawArgs[0]) + [Environment]::NewLine)
        exit 1
    }
}
'@
    $fakeSrc = $fakeSrc.Replace('__LOG__', $log).Replace('__VIEW__', $viewJson).Replace('__LIST__', $listJson).Replace('__MIRROR__', $MirrorRoot).Replace('__MUTATION__', $Mutation).Replace('__PROVIDE_DIGESTS__', $ProvideDigests.ToString()).Replace('__TAMPER_DIGEST_ASSET__', $TamperDigestAsset)
    [System.IO.File]::WriteAllText((Join-Path $CaseDir 'fake-gh.ps1'), $fakeSrc, $Utf8NoBom)
    $cmd = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0fake-gh.ps1`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    [System.IO.File]::WriteAllText((Join-Path $CaseDir 'fake-gh.cmd'), $cmd, $Utf8NoBom)
    return Join-Path $CaseDir 'fake-gh.cmd'
}

# --- Child process runner ------------------------------------------------------

function Invoke-PublishChild {
    param(
        [string]$Name,
        [string]$CaseDir,
        [string[]]$ExtraArgs = @(),
        [string]$VersionArg = '',
        [string]$MirrorOverride = '',
        [string]$FakeMinisignDir = '',
        [switch]$ExpectSuccess,
        [string]$ExpectErrorPattern = ''
    )
    $outFile = Join-Path $script:LogsDir "$Name.out.log"
    $errFile = Join-Path $script:LogsDir "$Name.err.log"
    $common = @(
        '-NoProfile', '-NonInteractive', '-File', $PublishPs1,
        '-Version', $(if ($VersionArg) { $VersionArg } else { $script:Version }),
        '-Repo', $script:TestRepo,
        '-KeyPath', $script:KeyPath,
        '-PublicKeyFile', $script:PubPath,
        '-WorkRoot', (Join-Path $CaseDir 'work'),
        '-HarnessMirrorDir', $(if ($MirrorOverride) { $MirrorOverride } else { $script:MirrorRoot })
    )
    $envH = @{}
    Get-ChildItem Env: | ForEach-Object { $envH[$_.Name] = $_.Value }
    $envH.PATH = $(if ($FakeMinisignDir -ne '') { $FakeMinisignDir + ';' } else { '' }) + $script:BasePath
    $envH.EIZOU_PUBLISH_GH_BIN = Join-Path $CaseDir 'fake-gh.cmd'
    $proc = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList ($common + $ExtraArgs) `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -NoNewWindow -Environment $envH
    if (-not $proc.WaitForExit(600000)) {
        & 'C:\Windows\System32\taskkill.exe' /T /F /PID $proc.Id 2>&1 | Out-Null
        $proc.WaitForExit()
        Check "${Name}: process exited" $false 'timeout after 600s'
        return
    }
    $out = Get-Content -Raw -LiteralPath $outFile -ErrorAction SilentlyContinue
    $err = Get-Content -Raw -LiteralPath $errFile -ErrorAction SilentlyContinue
    $both = $out + $err
    if ($ExpectSuccess) {
        Check "${Name}: exit 0" ($proc.ExitCode -eq 0) "exit=$($proc.ExitCode): $($both -replace '\s+', ' ')"
    }
    else {
        Check "${Name}: exit non-zero (fail closed)" ($proc.ExitCode -ne 0) "exit=$($proc.ExitCode)"
        if ($ExpectErrorPattern) {
            Check "${Name}: expected error surfaced" ($both -match $ExpectErrorPattern) "looking for /$ExpectErrorPattern/ in: $($both -replace '\s+', ' ')"
        }
    }
}

function Get-GhLog {
    param([string]$CaseDir)
    $p = Join-Path $CaseDir 'gh-calls.log'
    if (Test-Path -LiteralPath $p) { return Get-Content -Raw -LiteralPath $p } else { return '' }
}

function New-CaseDir {
    param([string]$Name)
    # Case dirs are passed into the child process via Start-Process
    # -ArgumentList, which joins arguments on spaces without quoting:
    # directory names must stay space-free (display names may contain
    # spaces and are used only for log file names).
    $safe = ($Name -replace '[^A-Za-z0-9_.-]', '_')
    $d = Join-Path $script:RunDir "case-$safe"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    return $d
}

# --- Fixtures ------------------------------------------------------------------

function New-FakeArchive {
    param([string]$ZipPath, [string]$InnerName)
    $stage = Join-Path $script:FakeDir ("arch-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Set-Content -LiteralPath (Join-Path $stage $InnerName) -Value 'fake helper bytes' -Encoding ascii
    Compress-Archive -Path (Join-Path $stage $InnerName) -DestinationPath $ZipPath -Force
    Remove-Item -LiteralPath $stage -Recurse -Force
}

function New-PrevReleaseFixture {
    $fixtureDir = Join-Path $script:MirrorRoot "eizoudendenshi-v$($script:PrevVersion)"
    New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null
    $fakeYt = Join-Path $script:FakeDir 'yt-dlp-windows-amd64.exe'
    [System.IO.File]::WriteAllText($fakeYt, 'fake yt-dlp helper bytes v9.9.8', $Utf8NoBom)
    $fakeFfmpeg = Join-Path $script:FakeDir 'ffmpeg-windows-amd64.zip'
    New-FakeArchive $fakeFfmpeg 'ffmpeg.exe'
    $script:FixtureYtSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $fakeYt).Hash.ToLowerInvariant()
    $script:FixtureFfSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $fakeFfmpeg).Hash.ToLowerInvariant()
    $dummy = '0' * 64
    $manifest = [ordered]@{
        format         = 'eizoudendenshi-release-manifest'
        formatVersion  = 1
        version        = $script:PrevVersion
        helperContract = [ordered]@{
            version = 3
            helpers = [ordered]@{
                'yt-dlp' = [ordered]@{ required = $true; version = '2026.07.04'; artifact = 'yt-dlp-windows-amd64.exe' }
                'ffmpeg' = [ordered]@{ required = $false; version = '5.1.2'; artifact = 'ffmpeg-windows-amd64.zip'; archive = $true; expectedFile = 'ffmpeg.exe' }
            }
            termux  = [ordered]@{
                packages = [ordered]@{
                    'yt-dlp' = [ordered]@{ package = 'python-yt-dlp'; command = 'yt-dlp'; minimum = '2025.03.31' }
                    'ffmpeg' = [ordered]@{ package = 'ffmpeg'; command = 'ffmpeg'; minimum = '4.4' }
                }
            }
        }
        artifacts      = @(
            [ordered]@{ name = 'eizouden-windows-amd64.exe'; target = 'windows/amd64'; sha256 = $dummy },
            [ordered]@{ name = 'eizouden-android-arm64'; target = 'android/arm64'; sha256 = $dummy },
            [ordered]@{ name = 'yt-dlp-windows-amd64.exe'; target = 'windows/amd64'; sha256 = $script:FixtureYtSha },
            [ordered]@{ name = 'ffmpeg-windows-amd64.zip'; target = 'windows/amd64'; sha256 = $script:FixtureFfSha }
        )
    }
    $manPath = Join-Path $fixtureDir 'eizouden-manifest.json'
    [System.IO.File]::WriteAllText($manPath, ($manifest | ConvertTo-Json -Depth 8 -Compress), $Utf8NoBom)
    & $script:Minisign -S -m $manPath -s $script:KeyPath 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'fixture manifest signing failed' }
    Copy-Item -LiteralPath $fakeYt -Destination (Join-Path $fixtureDir 'yt-dlp-windows-amd64.exe')
    & $script:Minisign -S -m (Join-Path $fixtureDir 'yt-dlp-windows-amd64.exe') -s $script:KeyPath 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'fixture yt-dlp signing failed' }
    Copy-Item -LiteralPath $fakeFfmpeg -Destination (Join-Path $fixtureDir 'ffmpeg-windows-amd64.zip')
    & $script:Minisign -S -m (Join-Path $fixtureDir 'ffmpeg-windows-amd64.zip') -s $script:KeyPath 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'fixture ffmpeg signing failed' }
    $ok = $true
    foreach ($f in @('eizouden-manifest.json', 'yt-dlp-windows-amd64.exe', 'ffmpeg-windows-amd64.zip')) {
        & $script:Minisign -V -m (Join-Path $fixtureDir $f) -P $script:PubKey 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { $ok = $false }
    }
    Check 'fixture: previous-release signatures verify' $ok 'manifest + helper minisigs must verify against the test key'
    $fixMan = Get-Content -Raw -LiteralPath $manPath | ConvertFrom-Json
    $fixYt = @($fixMan.artifacts | Where-Object { $_.name -eq 'yt-dlp-windows-amd64.exe' })
    $fixFf = @($fixMan.artifacts | Where-Object { $_.name -eq 'ffmpeg-windows-amd64.zip' })
    Check 'fixture: helper sha256 agrees with manifest' (
        [string]$fixYt[0].sha256 -eq $script:FixtureYtSha -and
        [string]$fixFf[0].sha256 -eq $script:FixtureFfSha) "yt $($fixYt[0].sha256) ff $($fixFf[0].sha256)"
}

function Copy-CaseMirror {
    param([string]$CaseDir)
    $m = Join-Path $CaseDir 'mirror'
    New-Item -ItemType Directory -Force -Path $m | Out-Null
    Copy-Item -LiteralPath (Join-Path $script:MirrorRoot "eizoudendenshi-v$($script:PrevVersion)") `
        -Destination (Join-Path $m "eizoudendenshi-v$($script:PrevVersion)") -Recurse -Force
    return $m
}

# --- Git cases (local fake origin, never the real remote) ----------------------

function Use-FakeOrigin {
    param([string]$CaseDir, [switch]$WithTag, [switch]$MismatchHead)
    $fake = Join-Path $CaseDir 'fake-origin.git'
    & git -C $RepoRoot init --bare $fake 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'fake origin init failed' }
    if ($MismatchHead) {
        & git -C $RepoRoot push $fake "HEAD^:refs/heads/main" 2>&1 | Out-Null
    }
    else {
        & git -C $RepoRoot push $fake "HEAD:refs/heads/main" 2>&1 | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw 'fake origin push failed' }
    if ($WithTag) {
        & git -C $RepoRoot --git-dir=$fake update-ref "refs/tags/$($script:Tag)" $script:HeadSha
        if ($LASTEXITCODE -ne 0) { throw 'fake origin tag creation failed' }
    }
    return $fake
}

function Invoke-GitCase {
    param([string]$Name, [switch]$WithTag, [switch]$MismatchHead, [string]$ExpectErrorPattern)
    $caseDir = New-CaseDir $Name
    New-FakeGh -CaseDir $caseDir -MirrorRoot $script:MirrorRoot
    $fake = Use-FakeOrigin -CaseDir $caseDir -WithTag:$WithTag -MismatchHead:$MismatchHead
    $origUrl = (& git -C $RepoRoot remote get-url origin 2>&1).Trim()
    $origMain = (& git -C $RepoRoot rev-parse refs/remotes/origin/main 2>&1).Trim()
    $swapped = $false
    try {
        & git -C $RepoRoot remote set-url origin $fake
        if ($LASTEXITCODE -ne 0) { throw 'origin url swap failed' }
        $swapped = $true
        Invoke-PublishChild -Name $Name -CaseDir $caseDir -ExpectErrorPattern $ExpectErrorPattern
    }
    finally {
        if ($swapped) { & git -C $RepoRoot remote set-url origin $origUrl | Out-Null }
        & git -C $RepoRoot rev-parse -q --verify "refs/tags/$($script:Tag)" 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { & git -C $RepoRoot tag -d $script:Tag 2>&1 | Out-Null }
        & git -C $RepoRoot update-ref refs/remotes/origin/main $origMain
    }
    $restored = ((& git -C $RepoRoot remote get-url origin 2>&1).Trim() -eq $origUrl)
    Check "${Name}: origin remote restored" $restored 'remote URL must be restored after the case'
}

# --- Dynamic suite -------------------------------------------------------------

function Dynamic-Suite {
    $script:Version = '9.9.9'
    $script:PrevVersion = '9.9.8'
    $script:TestRepo = 'GoRakuDo/entei'
    $script:Tag = "eizoudendenshi-v$($script:Version)"
    $script:RunDir = Join-Path $script:WorkRoot ("run-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $script:KeysDir = Join-Path $script:RunDir 'keys'
    $script:MirrorRoot = Join-Path $script:RunDir 'mirror'
    $script:FakeDir = Join-Path $script:RunDir 'fakes'
    $script:LogsDir = Join-Path $script:RunDir 'logs'
    foreach ($d in @($script:KeysDir, $script:MirrorRoot, $script:FakeDir, $script:LogsDir)) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
    }
    $script:KeyPath = Join-Path $script:KeysDir 'test.key'
    $script:PubPath = Join-Path $script:KeysDir 'test.pub'
    & $script:Minisign -G -W -p $script:PubPath -s $script:KeyPath 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'minisign key generation failed' }
    $script:PubKey = Get-Content -LiteralPath $script:PubPath | Where-Object { $_ -match '^RW[A-Za-z0-9+/]+$' } | Select-Object -First 1
    Check 'dynamic: test public key is a Minisign key' ($script:PubKey -match '^RW[A-Za-z0-9+/]+$') $script:PubKey
    $script:HeadSha = (& git -C $RepoRoot rev-parse HEAD 2>&1).Trim()
    $script:BasePath = (Split-Path $script:Minisign) + ';' + $env:PATH
    $script:ViewAssetNames = @(
        'eizouden-manifest.json', 'eizouden-manifest.json.minisig',
        'eizouden-windows-amd64.exe', 'eizouden-windows-amd64.exe.minisig',
        'eizouden-android-arm64', 'eizouden-android-arm64.minisig',
        'yt-dlp-windows-amd64.exe', 'yt-dlp-windows-amd64.exe.minisig',
        'ffmpeg-windows-amd64.zip', 'ffmpeg-windows-amd64.zip.minisig',
        'eizouden-bootstrap.sh', 'eizouden-bootstrap-helper.sh', 'eizouden-bootstrap.ps1'
    )
    $script:ListResponse = @(
        [pscustomobject]@{ tagName = "eizoudendenshi-v$($script:PrevVersion)"; publishedAt = '2026-08-04T01:00:00Z' },
        [pscustomobject]@{ tagName = 'eizoudendenshi-v9.9.7'; publishedAt = '2026-08-03T01:00:00Z' }
    )
    New-PrevReleaseFixture

    # --- P1: full pipeline (reuse -> build -> verify -> publish -> re-verify)
    $c = New-CaseDir 'P1'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot
    Invoke-PublishChild -Name 'P1 full pipeline' -CaseDir $c -ExtraArgs @('-SkipGitChecks') -ExpectSuccess
    $log = Get-GhLog $c
    Check 'P1: gh auth/list/create/view recorded' (
        $log -match 'CALL auth' -and $log -match 'CALL release list' -and
        $log -match "CREATE $($script:Tag) assets=13" -and $log -match 'CALL release view') $log
    $pubDir = Join-Path $script:MirrorRoot $script:Tag
    $pubFiles = @(Get-ChildItem -LiteralPath $pubDir -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    Check "P1: published mirror holds 13 assets" ($pubFiles.Count -eq 13) ($pubFiles -join ',')
    $pubMan = Get-Content -Raw -LiteralPath (Join-Path $pubDir 'eizouden-manifest.json') | ConvertFrom-Json
    Check 'P1: published manifest version/contract/artifacts' (
        $pubMan.version -eq $script:Version -and
        $pubMan.helperContract.version -eq 3 -and
        @($pubMan.artifacts).Count -eq 4) ($pubMan | ConvertTo-Json -Compress)
    $pubYt = @($pubMan.artifacts | Where-Object { $_.name -eq 'yt-dlp-windows-amd64.exe' })
    Check 'P1: helper bytes reused from previous release' ([string]$pubYt[0].sha256 -eq $script:FixtureYtSha) "got $($pubYt[0].sha256) want $($script:FixtureYtSha)"
    $ok = $true
    foreach ($f in @('eizouden-manifest.json', 'eizouden-windows-amd64.exe', 'eizouden-android-arm64', 'yt-dlp-windows-amd64.exe', 'ffmpeg-windows-amd64.zip')) {
        & $script:Minisign -V -m (Join-Path $pubDir $f) -P $script:PubKey 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { $ok = $false }
    }
    Check 'P1: published signatures verify' $ok 'manifest + 4 artifacts must verify against the test key'
    $boot = [System.IO.File]::ReadAllText((Join-Path $pubDir 'eizouden-bootstrap.ps1'))
    Check 'P1: bootstrap pinned, no placeholder' (
        $boot.Contains($script:PubKey) -and -not $boot.Contains('REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY')) 'distribution bootstrap must carry the pinned key'
    $p1out = Get-Content -Raw -LiteralPath (Join-Path $script:LogsDir 'P1 full pipeline.out.log') -ErrorAction SilentlyContinue
    Check 'P1: release URL printed only' (
        $p1out -match "release published: https://github.com/GoRakuDo/entei/releases/tag/$($script:Tag)" -and
        -not $p1out.Contains('test.key')) "output: $($p1out -replace '\s+', ' ')"

    # --- P2: -SkipPublish publishes nothing (-PreviousTag exercises the override)
    $c = New-CaseDir 'P2'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot
    Invoke-PublishChild -Name 'P2 SkipPublish' -CaseDir $c `
        -ExtraArgs @('-SkipGitChecks', '-SkipPublish', '-PreviousTag', "eizoudendenshi-v$($script:PrevVersion)") -ExpectSuccess
    $log = Get-GhLog $c
    Check 'P2: no release created' (-not $log.Contains('CREATE')) $log
    Check 'P2: -PreviousTag honored (no release list call)' (-not $log.Contains('CALL release list')) $log

    # --- P2.5: -Prerelease:$false publishes a formal (non-prerelease) release
    $c = New-CaseDir 'P2_5'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot -NotPrerelease
    Invoke-PublishChild -Name 'P2_5 FormalRelease' -CaseDir $c `
        -ExtraArgs @('-SkipGitChecks', '-Prerelease:$false') -ExpectSuccess
    $log = Get-GhLog $c
    Check 'P2.5: gh release create present' $log.Contains('CREATE') $log
    Check 'P2.5: --prerelease NOT passed for a formal release' (
        $log -notmatch '--prerelease'
    ) 'formal release must omit --prerelease'
    Check 'P2.5: isPrerelease=false verification passed' (
        $log.Contains('CALL release view') -and -not $log.Contains('isPrerelease=true')
    ) 'post-publish verification must accept isPrerelease=false'

    # --- P3: -HelpersFile skips helper reuse
    $c = New-CaseDir 'P3'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot
    $p3dir = Join-Path $c 'p3'
    New-Item -ItemType Directory -Force -Path $p3dir | Out-Null
    $p3yt = Join-Path $p3dir 'yt-dlp-windows-amd64.exe'
    [System.IO.File]::WriteAllText($p3yt, 'P3 supplied yt-dlp helper', $Utf8NoBom)
    $p3ff = Join-Path $p3dir 'ffmpeg-windows-amd64.zip'
    New-FakeArchive $p3ff 'ffmpeg.exe'
    $p3ytSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $p3yt).Hash.ToLowerInvariant()
    $p3ffSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $p3ff).Hash.ToLowerInvariant()
    $helpersJson = @{
        helpers = @(
            @{ key = 'yt-dlp'; required = $true; version = '2026.07.04'; artifactName = 'yt-dlp-windows-amd64.exe'; path = $p3yt },
            @{ key = 'ffmpeg'; required = $false; version = '5.1.2'; artifactName = 'ffmpeg-windows-amd64.zip'; path = $p3ff; archive = $true; expectedFile = 'ffmpeg.exe' }
        )
    }
    $helpersPath = Join-Path $p3dir 'helpers.json'
    [System.IO.File]::WriteAllText($helpersPath, ($helpersJson | ConvertTo-Json -Depth 6 -Compress), $Utf8NoBom)
    Invoke-PublishChild -Name 'P3 HelpersFile' -CaseDir $c `
        -ExtraArgs @('-SkipGitChecks', '-HelpersFile', $helpersPath) -ExpectSuccess
    $log = Get-GhLog $c
    Check 'P3: helper reuse skipped (no gh release list)' (-not $log.Contains('CALL release list')) $log
    $pubMan3 = Get-Content -Raw -LiteralPath (Join-Path (Join-Path $script:MirrorRoot $script:Tag) 'eizouden-manifest.json') | ConvertFrom-Json
    $m3yt = @($pubMan3.artifacts | Where-Object { $_.name -eq 'yt-dlp-windows-amd64.exe' })
    $m3ff = @($pubMan3.artifacts | Where-Object { $_.name -eq 'ffmpeg-windows-amd64.zip' })
    Check 'P3: supplied helper bytes used (not the previous release fixture)' (
        [string]$m3yt[0].sha256 -eq $p3ytSha -and [string]$m3ff[0].sha256 -eq $p3ffSha -and
        [string]$m3yt[0].sha256 -ne $script:FixtureYtSha) "yt $($m3yt[0].sha256) ff $($m3ff[0].sha256)"

    # --- P4: post-publish digest path (a) happy -- the fake gh reports a
    #       per-asset digest for every asset, so step 7 compares dist
    #       SHA-256 against GitHub's digests and (since all match)
    #       re-downloads nothing.
    $c = New-CaseDir 'P4'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot -ProvideDigests
    Invoke-PublishChild -Name 'P4 digest path (a) happy' -CaseDir $c -ExtraArgs @('-SkipGitChecks') -ExpectSuccess
    $p4out = Get-Content -Raw -LiteralPath (Join-Path $script:LogsDir 'P4 digest path (a) happy.out.log')
    $p4sp = $p4out -replace '\s+', ' '
    Check 'P4: digest path (a) taken' ($p4sp -match '13 assets matched GitHub digests') $p4sp
    Check 'P4: size path (b) not taken' (-not $p4sp.Contains('13 assets size-matched GitHub')) $p4sp
    Check 'P4: zero re-downloads of the new release' (-not $p4sp.Contains("publish: fetch $($script:Tag)/")) $p4sp
    Check 'P4: gh release view called exactly once' ((([regex]::Matches((Get-GhLog $c), 'CALL release view')).Count) -eq 1) (Get-GhLog $c)

    # --- P5: digest path (a) with one tampered digest. The fake gh
    #       reports a wrong digest for eizouden-windows-amd64.exe; step 7
    #       must re-fetch and re-verify exactly that asset (body + its
    #       .minisig via Assert-ReverifyAsset) and still succeed.
    $c = New-CaseDir 'P5'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot -ProvideDigests -TamperDigestAsset 'eizouden-windows-amd64.exe'
    Invoke-PublishChild -Name 'P5 digest mismatch' -CaseDir $c -ExtraArgs @('-SkipGitChecks') -ExpectSuccess
    $p5out = Get-Content -Raw -LiteralPath (Join-Path $script:LogsDir 'P5 digest mismatch.out.log')
    $p5sp = $p5out -replace '\s+', ' '
    Check 'P5: digest path (a) re-verified and passed' ($p5sp.Contains('13 assets matched GitHub digests')) $p5sp
    Check 'P5: tampered asset re-fetched (body + minisig)' (
        $p5sp.Contains("publish: fetch $($script:Tag)/eizouden-windows-amd64.exe (test mirror)") -and
        $p5sp.Contains("publish: fetch $($script:Tag)/eizouden-windows-amd64.exe.minisig (test mirror)")) $p5sp
    Check 'P5: no other asset re-downloaded' (
        (([regex]::Matches($p5sp, [regex]::Escape("publish: fetch $($script:Tag)/"))).Count) -eq 2) $p5sp

    # --- F1: invalid -Version
    $c = New-CaseDir 'F1'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot
    Invoke-PublishChild -Name 'F1 invalid version' -CaseDir $c -VersionArg 'not-a-version' `
        -ExpectErrorPattern 'expected semver'

    # --- F2: release tag already exists (local fake origin carries the tag)
    Invoke-GitCase -Name 'F2 tag exists' -WithTag -ExpectErrorPattern 'already exists'

    # --- F3: HEAD != origin/main (local fake origin main is HEAD^)
    Invoke-GitCase -Name 'F3 HEAD mismatch' -MismatchHead -ExpectErrorPattern 'origin/main'

    # --- F4: helper signature mismatch (tampered previous-release helper)
    $c = New-CaseDir 'F4'
    $caseMirror = Copy-CaseMirror $c
    New-FakeGh -CaseDir $c -MirrorRoot $caseMirror
    $ytPath = Join-Path $caseMirror "eizoudendenshi-v$($script:PrevVersion)\yt-dlp-windows-amd64.exe"
    $bytes = [System.IO.File]::ReadAllBytes($ytPath)
    $bytes[5] = $bytes[5] -bxor 0xFF
    [System.IO.File]::WriteAllBytes($ytPath, $bytes)
    Invoke-PublishChild -Name 'F4 helper signature mismatch' -CaseDir $c -MirrorOverride $caseMirror -ExtraArgs @('-SkipGitChecks') `
        -ExpectErrorPattern 'signature verification failed'
    Check 'F4: nothing published' (-not (Get-GhLog $c).Contains('CREATE')) (Get-GhLog $c)

    # --- F5: helper SHA-256 mismatch (re-signed tampered helper, stale manifest hash)
    $c = New-CaseDir 'F5'
    $caseMirror = Copy-CaseMirror $c
    New-FakeGh -CaseDir $c -MirrorRoot $caseMirror
    $ytPath = Join-Path $caseMirror "eizoudendenshi-v$($script:PrevVersion)\yt-dlp-windows-amd64.exe"
    $bytes = [System.IO.File]::ReadAllBytes($ytPath)
    $bytes[6] = $bytes[6] -bxor 0xFF
    [System.IO.File]::WriteAllBytes($ytPath, $bytes)
    & $script:Minisign -S -m $ytPath -s $script:KeyPath 2>&1 | Out-Null
    Invoke-PublishChild -Name 'F5 helper SHA-256 mismatch' -CaseDir $c -MirrorOverride $caseMirror -ExtraArgs @('-SkipGitChecks') `
        -ExpectErrorPattern 'SHA-256 mismatch'
    Check 'F5: nothing published' (-not (Get-GhLog $c).Contains('CREATE')) (Get-GhLog $c)

    # --- F6: tampered manifest detected at post-publish verification.
    #       The re-fetched manifest fails Minisign verification, so the
    #       publisher fails closed on the signature before the version
    #       comparison ("does not match requested") can even run.
    $c = New-CaseDir 'F6'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot -Mutation 'tamperVersion'
    Invoke-PublishChild -Name 'F6 manifest tampered' -CaseDir $c -ExtraArgs @('-SkipGitChecks') `
        -ExpectErrorPattern 'signature verification failed'

    # --- F7: minisign version too old (fake minisign on PATH)
    $c = New-CaseDir 'F7'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot
    $fakeMin = Join-Path $c 'fake-minisign'
    New-Item -ItemType Directory -Force -Path $fakeMin | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $fakeMin 'minisign.cmd'), "@echo off`r`necho minisign 0.11`r`n", $Utf8NoBom)
    Invoke-PublishChild -Name 'F7 minisign version' -CaseDir $c -ExtraArgs @('-SkipGitChecks') `
        -FakeMinisignDir $fakeMin -ExpectErrorPattern '0\.12'

    # --- F8: published asset count mismatch (canned view lists 12 assets)
    $c = New-CaseDir 'F8'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot -ViewAssets 12
    Invoke-PublishChild -Name 'F8 asset count mismatch' -CaseDir $c -ExtraArgs @('-SkipGitChecks') `
        -ExpectErrorPattern 'asset count'

    # --- F9: bootstrap placeholder detected at post-publish verification
    $c = New-CaseDir 'F9'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot -Mutation 'tamperBootstrapPlaceholder'
    Invoke-PublishChild -Name 'F9 placeholder bootstrap' -CaseDir $c -ExtraArgs @('-SkipGitChecks') `
        -ExpectErrorPattern 'placeholder'

    # --- F10: -SkipPublish without -PreviousTag/-HelpersFile must still
    #         resolve gh and fail closed with the clear helper-reuse
    #         message when `gh release list` finds no previous release
    #         (an unresolved gh would crash with a cryptic `& $null`
    #         PowerShell error instead)
    $c = New-CaseDir 'F10'
    New-FakeGh -CaseDir $c -MirrorRoot $script:MirrorRoot -ListResponse @()
    Invoke-PublishChild -Name 'F10 SkipPublish no previous' -CaseDir $c `
        -ExtraArgs @('-SkipGitChecks', '-SkipPublish') `
        -ExpectErrorPattern 'no previous eizoudendenshi-v release'
    $f10log = Get-GhLog $c
    Check 'F10: gh resolved and release list called' ($f10log -match 'CALL release list') $f10log
    Check 'F10: nothing published' (-not $f10log.Contains('CREATE')) $f10log

    # --- repo hygiene after the git cases
    $currentStatus = (& git -C $RepoRoot status --porcelain 2>&1 | Out-String).Trim()
    Check 'hygiene: git status unchanged' ($currentStatus -eq $script:BaselineStatus) "baseline: [$($script:BaselineStatus)] now: [$currentStatus]"
    & git -C $RepoRoot rev-parse -q --verify "refs/tags/$($script:Tag)" 2>&1 | Out-Null
    Check 'hygiene: no release tag left behind' ($LASTEXITCODE -ne 0) 'harness tag must be removed'
}

# --- Main -------------------------------------------------------------------

Write-Host 'EizouDendenshi one-shot release publisher test harness'
Write-Host "  repo: $RepoRoot"
Write-Host "  work: $WorkRoot"

$script:BaselineStatus = (& git -C $RepoRoot status --porcelain 2>&1 | Out-String).Trim()

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
$Results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

if (-not $Keep -and $script:RunDir) {
    Remove-Item -LiteralPath $script:RunDir -Recurse -Force
    Write-Host "cleaned: $($script:RunDir)"
}

if ($script:FailCount -gt 0) { exit 1 }
exit 0
