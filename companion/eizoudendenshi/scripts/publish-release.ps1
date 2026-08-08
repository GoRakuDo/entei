# EizouDendenshi one-shot release publisher.
#
# Automates the rc.23-era manual publish procedure into one command:
#   pwsh scripts/publish-release.ps1 -Version 0.2.0-rc.24
#
# Flow (every step fails closed; nothing is published until everything
# local has been verified):
#   1. argument/key/tool validation: -Version semver shape, secret +
#      public key files exist (the secret key path/value is NEVER
#      printed), minisign resolves and reports 0.12 or newer, and
#      `gh` is authenticated (unless -SkipPublish).
#   2. git validation (skipped with -SkipGitChecks, the harness flag):
#      repo root, `git fetch origin`, HEAD must equal origin/main
#      (otherwise stop), the release tag must NOT already exist (tags
#      are immutable), uncommitted changes only warn.
#   3. Windows helper reuse: the latest published eizoudendenshi-v
#      release (or -PreviousTag) is fetched over bounded HTTPS-only
#      redirects (or -HarnessMirrorDir in harness mode): manifest +
#      minisig, verified with Minisign against the pinned public key,
#      then the two helper artifacts + minisigs, each signature verified
#      and SHA-256 checked against the previous signed manifest. A
#      helpers.json (UTF-8 no BOM, ConvertTo-Json -Depth 4 -Compress) is
#      written into the temp work root. No usable previous release fails
#      closed and demands -HelpersFile.
#   4. build: scripts/release.ps1 release -Version <v> -OutDir <dist>
#      -MinisignKeyPath <key> -PublicKeyFile <pub> -HelpersFile
#      <helpers.json>, with the minisign directory prepended to PATH for
#      the child (restored in finally). release.ps1 remains the source
#      of truth; it is never re-implemented here.
#   5. local verification of the dist: exactly the 13 release files,
#      manifest version matches, helper contract v3, 4 artifacts, the
#      manifest signature, every artifact signature + SHA-256 against
#      the signed manifest, and the three distribution bootstraps carry
#      the pinned RW... key with no placeholder left.
#   6. publish (skipped with -SkipPublish): gh release create
#      eizoudendenshi-v<v> <13 assets> --repo <repo> --target <HEAD
#      full sha> --title 'EizouDendenshi v<v>' --notes-file <notes>
#      --prerelease. Notes come from -NotesFile or a generated default.
#   7. post-publish verification: gh release view --json
#      tagName,isPrerelease,targetCommitish,assets must report the
#      prerelease at HEAD with exactly the 13 assets; then everything is
#      re-fetched into a fresh temp dir and re-verified (signatures +
#      SHA-256 + pinned bootstraps). Only the release URL is printed.
#   8. finally: every temp dir created by this script is removed.
#
# Safety contract:
#   - Every HTTPS fetch uses Invoke-WebRequest -MaximumRedirection 5
#     -UseBasicParsing -PassThru and rejects a final redirect target
#     that is not https:// (same policy as windows-bootstrap.ps1).
#   - The private key path/value, tokens, and magnet URIs are never
#     printed or logged. The final summary prints the release URL only.
#   - Harness overrides (existing pattern): -HarnessMirrorDir fetches
#     from a local directory instead of GitHub, EIZOU_PUBLISH_GH_BIN
#     replaces the gh executable, -SkipGitChecks skips step 2.

[CmdletBinding()]
param(
    [string]$Version = '',

    [string]$Repo = 'GoRakuDo/entei',

    [string]$NotesFile = '',

    [string]$MinisignExe = '',

    [string]$KeyPath = 'C:\Users\yosia\.eizoudendenshi\keys\eizouden.minisign.key',

    [string]$PublicKeyFile = 'C:\Users\yosia\.eizoudendenshi\keys\eizouden.minisign.pub',

    [string]$HelpersFile = '',

    [string]$PreviousTag = '',

    [string]$OutDir = '',

    [string]$HarnessMirrorDir = '',

    [string]$WorkRoot = '',

    [switch]$SkipPublish,

    [switch]$SkipGitChecks
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ReleasePs1 = Join-Path $PSScriptRoot 'release.ps1'

# Every step prints a line: a long silent hang is a bug in the tool, not a
# valid state. The first line is written immediately on launch.
[Console]::Out.WriteLine("publish: starting (version=$Version, repo=$Repo, skipPublish=$SkipPublish, skipGitChecks=$SkipGitChecks)")

$Placeholder = 'REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY'
$BootstrapAssets = @('eizouden-bootstrap.sh', 'eizouden-bootstrap-helper.sh', 'eizouden-bootstrap.ps1')

# --- temp work root ---------------------------------------------------------
$script:WorkRoot = if ($WorkRoot -eq '') {
    Join-Path ([System.IO.Path]::GetTempPath()) ("eizouden-publish-" + [Guid]::NewGuid().ToString('N'))
}
else {
    [System.IO.Path]::GetFullPath($WorkRoot)
}
New-Item -ItemType Directory -Force -Path $script:WorkRoot | Out-Null

function Get-Sha256Lower {
    param([string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

# Invoke-FetchFile fetches one release asset over bounded HTTPS-only
# redirects (or copies from -HarnessMirrorDir in harness mode).
function Invoke-FetchFile {
    param([string]$Tag, [string]$Name, [string]$DestDir)
    $dest = Join-Path $DestDir $Name
    if ($HarnessMirrorDir -ne '') {
        $src = Join-Path $HarnessMirrorDir (Join-Path $Tag $Name)
        if (-not (Test-Path -LiteralPath $src)) { throw "download failed (test mirror): $Tag/$Name is missing" }
        Copy-Item -LiteralPath $src -Destination $dest -Force
        return $dest
    }
    [Console]::Out.WriteLine("publish: fetch $Tag/$Name")
    $url = "https://github.com/$Repo/releases/download/$Tag/$Name"
    $resp = Invoke-WebRequest -Uri $url -OutFile $dest -MaximumRedirection 5 -TimeoutSec 90 -UseBasicParsing -PassThru
    if ($resp.BaseResponse.RequestMessage.RequestUri.Scheme -ne 'https') {
        throw "redirect target is not https:// for $Tag/$Name"
    }
    return $dest
}

# Invoke-Gh runs the gh executable (real or EIZOU_PUBLISH_GH_BIN fake)
# and returns its stdout; a non-zero exit fails closed.
function Invoke-Gh {
    param([string[]]$GhArgs)
    [Console]::Out.WriteLine("publish: gh $($GhArgs[0]) $($GhArgs[1]) (repo $Repo, $((@($GhArgs) | Where-Object { $_ -like 'http*' }).Count) url args)")
    $out = & $script:GhBin @GhArgs
    if ($LASTEXITCODE -ne 0) {
        throw "gh $($GhArgs -join ' ') failed (exit $LASTEXITCODE)"
    }
    return $out
}

# Assert-ReleaseDir verifies a full 13-file release dir: file set,
# manifest version/contract/artifacts, manifest signature, every
# artifact signature + SHA-256 against the signed manifest, and the
# pinned distribution bootstraps. Returns the expected asset names.
function Assert-ReleaseDir {
    param([string]$Dir, [string]$ExpectedVersion, [string]$What)
    $manPath = Join-Path $Dir 'eizouden-manifest.json'
    if (-not (Test-Path -LiteralPath $manPath)) { throw "${What}: missing eizouden-manifest.json" }
    $man = Get-Content -Raw -LiteralPath $manPath | ConvertFrom-Json
    if ($man.format -ne 'eizoudendenshi-release-manifest') { throw "${What}: manifest has an unknown format" }
    if ($man.formatVersion -ne 1) { throw "${What}: manifest format version is not supported" }
    if ([string]$man.version -ne $ExpectedVersion) {
        throw "${What}: manifest version '$($man.version)' does not match requested '$ExpectedVersion'"
    }
    if ([int]$man.helperContract.version -ne 3) {
        throw "${What}: manifest helper contract version is $($man.helperContract.version), expected 3"
    }
    $artifacts = @($man.artifacts)
    if ($artifacts.Count -ne 4) {
        throw "${What}: manifest declares $($artifacts.Count) artifacts, expected 4"
    }
    $expected = @('eizouden-manifest.json', 'eizouden-manifest.json.minisig')
    foreach ($a in $artifacts) {
        if ($a.name -notmatch '^[A-Za-z0-9._-]+$') { throw "${What}: unsafe artifact name '$($a.name)'" }
        $expected += $a.name
        $expected += "$($a.name).minisig"
    }
    $expected += $BootstrapAssets
    $files = @(Get-ChildItem -LiteralPath $Dir -File | ForEach-Object { $_.Name })
    if ($files.Count -ne 13) { throw "${What}: release dir has $($files.Count) files, expected 13" }
    foreach ($e in $expected) { if ($e -notin $files) { throw "${What}: missing release file $e" } }
    foreach ($f in $files) { if ($f -notin $expected) { throw "${What}: unexpected release file $f" } }

    & $script:Minisign -V -m $manPath -P $script:PinnedKey 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "${What}: manifest signature verification failed" }
    foreach ($a in $artifacts) {
        $p = Join-Path $Dir $a.name
        & $script:Minisign -V -m $p -P $script:PinnedKey 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "${What}: artifact signature verification failed for $($a.name)" }
        $got = Get-Sha256Lower $p
        if ($got -ne [string]$a.sha256) { throw "${What}: SHA-256 mismatch for $($a.name)" }
    }
    foreach ($b in $BootstrapAssets) {
        $text = [System.IO.File]::ReadAllText((Join-Path $Dir $b))
        if ($text.Contains($Placeholder)) { throw "${What}: $b still contains the pinned-key placeholder" }
        if (-not $text.Contains($script:PinnedKey)) { throw "${What}: $b does not carry the pinned public key" }
    }
    return $expected
}

try {
    # --- 1. argument / key / tool validation --------------------------------
    if ($Version -eq '') {
        throw 'missing -Version (semver, e.g. 0.2.0-rc.24)'
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
        throw "invalid -Version '$Version'; expected semver, e.g. 0.2.0-rc.24"
    }
    $Tag = "eizoudendenshi-v$Version"

    if (-not (Test-Path -LiteralPath $KeyPath)) {
        throw 'minisign secret key not found (pass -KeyPath); no unsigned release is produced (fails closed)'
    }
    if (-not (Test-Path -LiteralPath $PublicKeyFile)) {
        throw 'minisign public key file not found (pass -PublicKeyFile)'
    }
    $pubLine = Get-Content -LiteralPath $PublicKeyFile | Where-Object { $_ -match '^RW[A-Za-z0-9+/]+$' } | Select-Object -First 1
    if (-not $pubLine -or $pubLine.Length -lt 42 -or $pubLine.Length -gt 80) {
        throw 'no valid RW... Minisign public key line found in the public key file (fails closed)'
    }
    $script:PinnedKey = $pubLine

    if ($MinisignExe -ne '') {
        $script:Minisign = $MinisignExe
    }
    else {
        $onPath = Get-Command minisign -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($onPath) { $script:Minisign = $onPath.Source }
    }
    if (-not $script:Minisign -and (Test-Path -LiteralPath 'A:\Temp\opencode\minisign-bin\minisign-win64\x86_64\minisign.exe')) {
        $script:Minisign = 'A:\Temp\opencode\minisign-bin\minisign-win64\x86_64\minisign.exe'
    }
    if (-not $script:Minisign) {
        throw 'minisign not found (pass -MinisignExe, put minisign on PATH, or use the A:\Temp\opencode minisign-bin) (fails closed)'
    }
    if (-not (Test-Path -LiteralPath $script:Minisign)) { throw 'minisign executable not found (fails closed)' }
    $verOut = (& $script:Minisign -v 2>&1 | Out-String)
    if ($verOut -notmatch 'minisign[^\d]*(\d+)\.(\d+)') {
        throw 'cannot determine minisign version; minisign 0.12 or newer is required (fails closed)'
    }
    $vMaj = [int]$Matches[1]
    $vMin = [int]$Matches[2]
    if ($vMaj -lt 0 -or ($vMaj -eq 0 -and $vMin -lt 12)) {
        throw "minisign $vMaj.$vMin is too old; version 0.12 or newer is required (fails closed)"
    }
    $script:MinisignDir = Split-Path $script:Minisign

    # gh resolution always runs: helper reuse (step 3) invokes `gh
    # release list` even under -SkipPublish when neither -PreviousTag
    # nor -HelpersFile is given, so an unresolved $script:GhBin would
    # crash with a cryptic `& $null` error. Only the `gh auth status`
    # check stays gated on -SkipPublish (nothing is published, so no
    # authentication is required).
    $script:GhBin = $env:EIZOU_PUBLISH_GH_BIN
    if (-not $script:GhBin) {
        $ghCmd = Get-Command gh -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($ghCmd) { $script:GhBin = $ghCmd.Source }
    }
    if (-not $script:GhBin) {
        throw 'gh CLI not found (install GitHub CLI and run gh auth login) (fails closed)'
    }
    if (-not $SkipPublish) {
        & $script:GhBin auth status 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'gh is not authenticated (gh auth status failed); refusing to publish (fails closed)'
        }
    }
    Write-Host 'publish: 1/7 input validation passed'

    # --- 2. git validation (harness flag: -SkipGitChecks) -------------------
    if (-not $SkipGitChecks) {
        & git -C $RepoRoot rev-parse --show-toplevel 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'not inside a git repository (fails closed)' }
        & git -C $RepoRoot fetch origin --quiet 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'git fetch origin failed (fails closed)' }
        $head = (& git -C $RepoRoot rev-parse HEAD 2>&1).Trim()
        $originMain = (& git -C $RepoRoot rev-parse refs/remotes/origin/main 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'origin/main is missing; run git fetch origin (fails closed)' }
        if ($head -ne $originMain) {
            throw 'HEAD is not in sync with origin/main; refusing to publish (fails closed)'
        }
        & git -C $RepoRoot rev-parse -q --verify "refs/tags/$Tag" 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            throw "release tag $Tag already exists (tags are immutable); refusing to publish (fails closed)"
        }
        $porcelain = & git -C $RepoRoot status --porcelain
        if ($porcelain) {
            Write-Host 'publish: warning: uncommitted changes present; continuing (publish uses HEAD only)'
        }
        Write-Host 'publish: 2/7 git checks passed (HEAD == origin/main)'
    }
    else {
        Write-Host 'publish: 2/7 git checks skipped (-SkipGitChecks)'
    }

    # --- 3. Windows helper reuse --------------------------------------------
    $HelpersJsonPath = ''
    if ($HelpersFile -ne '') {
        $HelpersJsonPath = [System.IO.Path]::GetFullPath($HelpersFile)
        if (-not (Test-Path -LiteralPath $HelpersJsonPath)) {
            throw "helper inputs file not found (pass -HelpersFile)"
        }
        Write-Host 'publish: 3/7 helper reuse skipped (-HelpersFile given)'
    }
    else {
        $prevTag = $PreviousTag
        if ($prevTag -eq '') {
            $listOut = Invoke-Gh -GhArgs @('release', 'list', '--repo', $Repo, '--limit', '100', '--json', 'tagName,publishedAt')
            $releases = (($listOut -join "`n") | ConvertFrom-Json)
            $candidates = @($releases | Where-Object { $_.tagName -like 'eizoudendenshi-v*' } | Sort-Object publishedAt -Descending)
            if ($candidates.Count -eq 0) {
                throw 'no previous eizoudendenshi-v release found for helper reuse; pass -HelpersFile with the helper artifacts (fails closed)'
            }
            $prevTag = [string]$candidates[0].tagName
        }
        if ($prevTag -notmatch '^eizoudendenshi-v[0-9A-Za-z._-]+$') {
            throw "invalid previous release tag '$prevTag' (fails closed)"
        }
        Write-Host "publish: 3/7 helper reuse from $prevTag"

        $reuseDir = Join-Path $script:WorkRoot 'reuse'
        New-Item -ItemType Directory -Force -Path $reuseDir | Out-Null
        $manPath = Invoke-FetchFile -Tag $prevTag -Name 'eizouden-manifest.json' -DestDir $reuseDir
        Invoke-FetchFile -Tag $prevTag -Name 'eizouden-manifest.json.minisig' -DestDir $reuseDir | Out-Null
        & $script:Minisign -V -m $manPath -P $script:PinnedKey 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "previous release $prevTag manifest signature verification failed; pass -HelpersFile instead (fails closed)"
        }
        $prevMan = Get-Content -Raw -LiteralPath $manPath | ConvertFrom-Json
        if ([int]$prevMan.helperContract.version -lt 2 -or $null -eq $prevMan.helperContract.helpers) {
            throw "previous release $prevTag has no Windows helper contract (v1 core-only); pass -HelpersFile (fails closed)"
        }
        $specs = @()
        foreach ($key in @('yt-dlp', 'ffmpeg')) {
            $h = $prevMan.helperContract.helpers.$key
            if ($null -eq $h) {
                throw "previous release $prevTag has no helper '$key'; pass -HelpersFile (fails closed)"
            }
            $artifactName = [string]$h.artifact
            if ($artifactName -notmatch '^[A-Za-z0-9._-]+$') { throw "unsafe helper artifact name '$artifactName' (fails closed)" }
            $art = @($prevMan.artifacts | Where-Object { $_.name -eq $artifactName })
            if ($art.Count -eq 0) {
                throw "previous release $prevTag manifest has no artifact entry for helper '$artifactName'; pass -HelpersFile (fails closed)"
            }
            $file = Invoke-FetchFile -Tag $prevTag -Name $artifactName -DestDir $reuseDir
            Invoke-FetchFile -Tag $prevTag -Name "$artifactName.minisig" -DestDir $reuseDir | Out-Null
            & $script:Minisign -V -m $file -P $script:PinnedKey 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "helper signature verification failed for $artifactName from $prevTag; pass -HelpersFile instead (fails closed)"
            }
            $gotSha = Get-Sha256Lower $file
            if ($gotSha -ne [string]$art[0].sha256) {
                throw "helper SHA-256 mismatch for $artifactName from $prevTag; pass -HelpersFile instead (fails closed)"
            }
            $spec = [ordered]@{
                key          = $key
                required     = [bool]$h.required
                version      = [string]$h.version
                artifactName = $artifactName
                path         = $file
            }
            if ([bool]$h.archive) {
                $spec.archive = $true
                $spec.expectedFile = [string]$h.expectedFile
            }
            $specs += $spec
        }
        $HelpersJsonPath = Join-Path $script:WorkRoot 'helpers.json'
        $helpersJson = @{ helpers = @($specs) }
        [System.IO.File]::WriteAllText($HelpersJsonPath, ($helpersJson | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "publish: helper reuse verified ($($specs.Count) helpers; helpers.json written)"
    }

    # --- 4. build via release.ps1 (source of truth) --------------------------
    $DistDir = if ($OutDir -eq '') { Join-Path $script:WorkRoot 'dist' } else { [System.IO.Path]::GetFullPath($OutDir) }
    $oldPath = $env:PATH
    $env:PATH = $script:MinisignDir + ';' + $env:PATH
    try {
        & $ReleasePs1 release -Version $Version -OutDir $DistDir -MinisignKeyPath $KeyPath -PublicKeyFile $PublicKeyFile -HelpersFile $HelpersJsonPath
        if ($LASTEXITCODE -ne 0) {
            throw "release.ps1 failed (exit $LASTEXITCODE)"
        }
    }
    catch {
        throw "release.ps1 failed: $($_.Exception.Message)"
    }
    finally {
        $env:PATH = $oldPath
    }
    Write-Host 'publish: 4/7 build complete (release.ps1)'

    # --- 5. local verification ----------------------------------------------
    $ExpectedAssets = Assert-ReleaseDir -Dir $DistDir -ExpectedVersion $Version -What 'local verification failed'
    Write-Host "publish: 5/7 local verification passed ($($ExpectedAssets.Count) release assets)"

    # --- 6. publish -----------------------------------------------------------
    if (-not $SkipPublish) {
        $fullSha = (& git -C $RepoRoot rev-parse HEAD 2>&1).Trim()
        if ($fullSha -notmatch '^[0-9a-f]{40}$') { throw "cannot determine HEAD commit (fails closed)" }
        if ($NotesFile -ne '') {
            $notesPath = [System.IO.Path]::GetFullPath($NotesFile)
            if (-not (Test-Path -LiteralPath $notesPath)) { throw 'notes file not found (pass -NotesFile)' }
        }
        else {
            $notesPath = Join-Path $script:WorkRoot 'notes.md'
            $notes = @(
                "EizouDendenshi v$Version (prerelease)"
                ''
                'Automated release published by scripts/publish-release.ps1:'
                '- the windows/amd64 + android/arm64 cores, the Windows helpers (yt-dlp,'
                '  ffmpeg, reused from the previous release), and the distribution'
                '  bootstraps with the pinned Minisign public key are built and signed by'
                '  scripts/release.ps1;'
                '- the updater (CLI option 3) verifies the signed manifest, cores, and'
                '  helpers (Minisign + SHA-256 against the signed manifest) before a'
                '  bounded child apply, preserves the DPAPI/Termux credential and the'
                '  browser opaque token, prints an update-complete message prompting'
                '  the user to run `grkd-edds` manually (the CLI is not auto-relaunched),'
                '  without requiring Web re-pairing.'
                ''
                'E2E on a real user profile (live credential, browser persistence after'
                'update, Termux device update) remains unconfirmed for this release.'
            ) -join "`n"
            [System.IO.File]::WriteAllText($notesPath, $notes, (New-Object System.Text.UTF8Encoding($false)))
        }
        $assetPaths = @(Get-ChildItem -LiteralPath $DistDir -File | Sort-Object Name | ForEach-Object { $_.FullName })
        if ($assetPaths.Count -ne 13) { throw "cannot publish: dist has $($assetPaths.Count) files, expected 13 (fails closed)" }
        $createArgs = @('release', 'create', $Tag) + $assetPaths + @(
            '--repo', $Repo,
            '--target', $fullSha,
            '--title', "EizouDendenshi v$Version",
            '--notes-file', $notesPath,
            '--prerelease'
        )
        Invoke-Gh -GhArgs $createArgs | Out-Null
        Write-Host "publish: 6/7 GitHub prerelease created: $Tag"
    }
    else {
        Write-Host 'publish: 6/7 publish skipped (-SkipPublish)'
    }

    # --- 7. post-publish verification -----------------------------------------
    if (-not $SkipPublish) {
        $viewOut = Invoke-Gh -GhArgs @('release', 'view', $Tag, '--repo', $Repo, '--json', 'tagName,isPrerelease,targetCommitish,assets')
        $view = (($viewOut -join "`n") | ConvertFrom-Json)
        if ([string]$view.tagName -ne $Tag) {
            throw "post-publish verification failed: release tagName '$($view.tagName)' does not match '$Tag'"
        }
        if (-not [bool]$view.isPrerelease) {
            throw 'post-publish verification failed: release is not a prerelease'
        }
        if ([string]$view.targetCommitish -ne $fullSha) {
            throw "post-publish verification failed: release target commit '$($view.targetCommitish)' does not match HEAD '$fullSha'"
        }
        $viewNames = @($view.assets | ForEach-Object { $_.name })
        if ($viewNames.Count -ne $ExpectedAssets.Count) {
            throw "post-publish verification failed: release asset count is $($viewNames.Count), expected $($ExpectedAssets.Count)"
        }
        foreach ($e in $ExpectedAssets) { if ($e -notin $viewNames) { throw "post-publish verification failed: release is missing asset $e" } }
        foreach ($f in $viewNames) { if ($f -notin $ExpectedAssets) { throw "post-publish verification failed: unexpected release asset $f" } }

        $verifyDir = Join-Path $script:WorkRoot 'verify'
        New-Item -ItemType Directory -Force -Path $verifyDir | Out-Null
        foreach ($n in $ExpectedAssets) {
            Invoke-FetchFile -Tag $Tag -Name $n -DestDir $verifyDir | Out-Null
        }
        Assert-ReleaseDir -Dir $verifyDir -ExpectedVersion $Version -What 'post-publish verification failed' | Out-Null
        Write-Host 'publish: 7/7 post-publish verification passed (re-fetched and re-verified)'
    }
    else {
        Write-Host 'publish: 7/7 post-publish verification skipped (-SkipPublish)'
    }

    if ($SkipPublish) {
        [Console]::Out.WriteLine('publish skipped (-SkipPublish): no release was created')
    }
    else {
        [Console]::Out.WriteLine("release published: https://github.com/$Repo/releases/tag/$Tag")
    }
}
catch {
    [Console]::Error.WriteLine("publish aborted: $($_.Exception.Message)")
    exit 1
}
finally {
    if ($script:WorkRoot -and (Test-Path -LiteralPath $script:WorkRoot)) {
        Remove-Item -LiteralPath $script:WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
