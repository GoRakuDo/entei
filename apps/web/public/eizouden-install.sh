#!/bin/sh
# EizouDendenshi installer (Termux) — delegates to the signed bootstrap.
# URL is updated on each release (see docs/THANKS_TO_MEMBERS.md).
set -eu
curl -fsSL https://github.com/GoRakuDo/entei/releases/download/eizoudendenshi-v0.2.0-rc.69/eizouden-bootstrap-helper.sh | bash
