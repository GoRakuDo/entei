#!/bin/sh
# EizouDendenshi installer (Termux) — delegates to the latest signed stable bootstrap.
# 最新の安定版（stable）リリースへ自動追従。バージョン固定なし・リリース毎の更新不要（2026-08-27）。
set -eu
tag=$(curl -fsSL https://api.github.com/repos/GoRakuDo/entei/releases/latest | sed -n "s/.*\"tag_name\": *\"\([^\"]*\)\".*/\1/p" | head -1)
printf "%s" "$tag" | grep -Eq "^eizoudendenshi-v[0-9]+\.[0-9]+\.[0-9]+$" \
  || { echo "unexpected release tag: $tag" >&2; exit 1; }
curl -fsSL "https://github.com/GoRakuDo/entei/releases/download/$tag/eizouden-bootstrap-helper.sh" | bash
