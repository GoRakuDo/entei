# EizouDendenshi installer (Windows) — delegates to the latest signed stable bootstrap.
# 最新の安定版（stable）リリースへ自動追従。バージョン固定なし・リリース毎の更新不要（2026-08-27）。
$ErrorActionPreference = "Stop"
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/GoRakuDo/entei/releases/latest" -Headers @{ "User-Agent" = "eizouden-installer" }
$tag = $rel.tag_name
if ($tag -cnotmatch "^eizoudendenshi-v[0-9]+\.[0-9]+\.[0-9]+$") { throw "unexpected release tag: $tag" }
$url = "https://github.com/GoRakuDo/entei/releases/download/$tag/eizouden-bootstrap.ps1"
$tmp = Join-Path $env:TEMP "eizouden-bootstrap.ps1"
Invoke-WebRequest $url -OutFile $tmp
pwsh -NoProfile -ExecutionPolicy Bypass -File $tmp
