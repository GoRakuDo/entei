# EizouDendenshi installer (Windows) — delegates to the signed bootstrap.
# URL is updated on each release (see docs/THANKS_TO_MEMBERS.md).
$url = "https://github.com/GoRakuDo/entei/releases/download/eizoudendenshi-v0.2.0-rc.69/eizouden-bootstrap.ps1"
$tmp = Join-Path $env:TEMP "eizouden-bootstrap.ps1"
Invoke-WebRequest $url -OutFile $tmp
pwsh -NoProfile -ExecutionPolicy Bypass -File $tmp
