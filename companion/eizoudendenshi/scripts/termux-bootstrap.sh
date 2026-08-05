#!/data/data/com.termux/files/usr/bin/sh
#
# EizouDendenshi Termux bootstrap (ED-2D Stage A template)
#
# Verify and install the signed android/arm64 EizouDendenshi core release
# into Termux app-private storage, then print an install-complete message.
# The core is NOT auto-launched: a process started by the bootstrap does
# not own a usable console stdin, so the user runs `grkd-edds` manually
# from their own terminal (where stdin works). Nothing is installed before
# every available verification step has passed.
#
# Distribution contract (do not weaken):
#   - This template is distributed as a copy-paste command. It is NEVER
#     fetched over the network and piped into a shell (no curl|sh).
#   - The pinned Minisign public key below MUST be replaced with the real
#     release key before publishing. An unreplaced template fails closed.
#   - The release base URL is an explicit input (arg 1 or EIZOU_RELEASE_URL)
#     and MUST be https://. Nothing is downloaded before it is validated.
#   - Only verifier/download prerequisites are installed (minisign, curl,
#     coreutils from the official Termux repository). No source helpers
#     (python-yt-dlp / aria2 / ffmpeg) and no Android permission bypass are
#     performed by this template — that is later-stage work with its own
#     gates.
#   - Everything is downloaded into a private temp dir (mode 700, removed on
#     exit), the manifest signature, the artifact signature, and the
#     artifact SHA-256 are verified BEFORE any install step, and the
#     verified binary is atomically moved into Termux app-private storage.
#   - The manifest's helper minimum contract is a placeholder that FAILS
#     CLOSED: only exactly {"version":1,"minimumVersions":{}} is accepted.
#     A manifest with any other contract version or with non-empty
#     minimumVersions is refused before install, because this template
#     provisions no helpers.
#
# Usage:
#   sh eizouden-bootstrap.sh https://dl.example.org/eizouden/releases/0.2.0
#
# Harness-only environment overrides (never used in production; they relax
# ENVIRONMENT and SOURCE checks only — signature/SHA verification and
# fail-closed order are never relaxed):
#   EIZOU_TEST=1                  relax the Termux/aarch64 checks
#   EIZOU_BOOTSTRAP_SKIP_PKG=1    skip `pkg install` (prereqs must be on PATH)
#   EIZOU_MIRROR_DIR=<dir>        fetch files from a local directory instead
#                                 of the network (same verification path)
#   PREFIX=<path>                 app-private prefix (the harness supplies it)
set -eu

# --- Pinned release signing key (replace at release time) ---
PINNED_PUBKEY='REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY'

# --- Inputs ---
RELEASE_BASE_URL="${1:-${EIZOU_RELEASE_URL:-}}"

# --- Release contract constants (must match scripts/release.ps1) ---
MANIFEST_NAME='eizouden-manifest.json'
CORE_NAME='eizouden-android-arm64'
CORE_TARGET='android/arm64'
HELPER_CONTRACT_VERSION=1
INSTALL_DIR='var/lib/eizouden'          # under $PREFIX (Termux app-private)

# --- Harness-only overrides ---
TEST_MODE="${EIZOU_TEST:-0}"
SKIP_PKG="${EIZOU_BOOTSTRAP_SKIP_PKG:-0}"
MIRROR_DIR="${EIZOU_MIRROR_DIR:-}"

fail() {
    echo "EizouDendenshi bootstrap: ERROR: $*" >&2
    exit 1
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1
}

# 1. Input validation: the release base URL must be explicit and HTTPS.
validate_release_url() {
    [ -n "$RELEASE_BASE_URL" ] ||
        fail 'release base URL is required (arg 1 or EIZOU_RELEASE_URL)'
    case "$RELEASE_BASE_URL" in
        https://*) ;;
        *) fail 'release base URL must be https:// (refusing non-HTTPS download)' ;;
    esac
    rest="${RELEASE_BASE_URL#https://}"
    [ -n "$rest" ] || fail 'release base URL has no host'
    case "$rest" in
        *@*)  fail 'release base URL must not contain userinfo' ;;
        *'?'* | *'#'*) fail 'release base URL must not contain a query or fragment' ;;
        *' '*) fail 'release base URL must not contain whitespace' ;;
    esac
}

# 2. The pinned key must be a real Minisign key; an unreplaced template
#    placeholder fails closed before anything else runs. The placeholder is
#    detected by its REPLACE_ME marker (underscores cannot appear in a
#    base64 Minisign key), so substituting a real key can never trip this
#    branch.
validate_pinned_key() {
    case "$PINNED_PUBKEY" in
        '' | *REPLACE_ME*)
            fail 'template public key is not pinned; refusing to run an unpinned bootstrap' ;;
    esac
    # Minisign key prefixes observed in the wild: RWT (legacy Ed25519),
    # RWQ / RWR / RWS (0.12+ formats). Accept any RW-prefixed base64 key of
    # plausible length; minisign itself performs the cryptographic check.
    case "$PINNED_PUBKEY" in
        RW*) ;;
        *) fail 'pinned public key must be a Minisign RW... key' ;;
    esac
    rest="${PINNED_PUBKEY#RW}"
    case "$rest" in
        *[!A-Za-z0-9+/]*) fail 'pinned public key contains invalid characters' ;;
    esac
    n=${#PINNED_PUBKEY}
    [ "$n" -ge 42 ] && [ "$n" -le 80 ] ||
        fail 'pinned public key has an unexpected length'
}

# 3. Environment: this is a Termux aarch64 bootstrap.
validate_environment() {
    if [ "$TEST_MODE" = 1 ]; then
        echo 'EizouDendenshi bootstrap: TEST MODE (EIZOU_TEST=1): Termux checks relaxed; verification unchanged' >&2
        [ -n "$PREFIX" ] || fail 'PREFIX is empty; test mode still requires an app-private prefix'
        return
    fi
    [ -n "${PREFIX:-}" ] || fail 'not running in Termux (PREFIX is unset)'
    [ "$PREFIX" = '/data/data/com.termux/files/usr' ] ||
        fail "PREFIX is not the standard Termux prefix ($PREFIX)"
    [ "$(uname -s)" = 'Linux' ] ||
        fail "not running on Linux/Termux (uname -s: $(uname -s))"
    case "$(uname -m)" in
        aarch64) ;;
        *) fail "unsupported architecture $(uname -m); EizouDendenshi android/arm64 requires aarch64 Termux" ;;
    esac
    require_cmd pkg || fail 'Termux package manager (pkg) not found'
}

# 4. Verifier/download prerequisites ONLY. Source helpers (python-yt-dlp,
#    aria2, ffmpeg) are deliberately not installed here; a manifest that
#    demands them is rejected earlier by the helper contract (fails closed).
ensure_prereqs() {
    if [ "$SKIP_PKG" = 1 ]; then
        require_cmd minisign || fail 'minisign not found (EIZOU_BOOTSTRAP_SKIP_PKG=1 requires it on PATH)'
        require_cmd curl || fail 'curl not found (EIZOU_BOOTSTRAP_SKIP_PKG=1 requires it on PATH)'
        require_cmd sha256sum || fail 'sha256sum not found (EIZOU_BOOTSTRAP_SKIP_PKG=1 requires it on PATH)'
        return
    fi
    missing=''
    require_cmd minisign || missing="$missing minisign"
    require_cmd curl || missing="$missing curl"
    require_cmd sha256sum || missing="$missing coreutils"
    if [ -n "$missing" ]; then
        echo "EizouDendenshi bootstrap: installing Termux prerequisites:$missing"
        pkg install -y minisign curl coreutils ||
            fail 'pkg install of verifier/download prerequisites failed'
    fi
    require_cmd minisign || fail 'minisign unavailable after install'
    require_cmd curl || fail 'curl unavailable after install'
    require_cmd sha256sum || fail 'sha256sum unavailable after install'
}

# 5. Private temp dir: mode 700 under the Termux app-private tmp, always
#    removed on exit (success or failure).
EIZOU_TMP=''
cleanup() {
    if [ -n "$EIZOU_TMP" ] && [ -d "$EIZOU_TMP" ]; then
        rm -rf -- "$EIZOU_TMP"
    fi
}
make_private_tmp() {
    base="${TMPDIR:-$PREFIX/tmp}"
    EIZOU_TMP="$(mktemp -d "${base}/eizouden-bootstrap.XXXXXX")" ||
        fail "cannot create private temp dir under ${base}"
    chmod 700 "$EIZOU_TMP" || fail 'cannot secure temp dir permissions'
    trap cleanup EXIT INT TERM
}

# Fetch one release file. Test mirror mode copies from EIZOU_MIRROR_DIR
# (harness only); production always uses curl over the validated HTTPS URL.
# GitHub Release asset URLs respond 302 and redirect to the release CDN, so
# --location is required: without it curl saves the redirect response body
# and every later verification step fails (hit live on the rc.1 Termux
# clean-install). --max-redirs 5 bounds the chain and --proto-redir =https
# keeps redirect targets HTTPS-only (no silent downgrade); --fail still
# rejects any final HTTP >= 400 response, so the fetch stays fail-closed.
fetch() {
    url="$1"
    dest="$2"
    if [ -n "$MIRROR_DIR" ]; then
        name="${url##*/}"
        cp "$MIRROR_DIR/$name" "$dest" || fail "download failed (test mirror): ${name} is missing"
    else
        curl -fsS --location --max-redirs 5 --proto-redir =https --connect-timeout 10 --max-time 60 --retry 2 -o "$dest" "$url" || fail "download failed: $url"
    fi
}

verify_minisign() {
    file="$1"
    key="$2"
    minisign -Vm "$file" -P "$key" >/dev/null 2>&1 ||
        fail "Minisign signature verification failed for $(basename "$file")"
}

# 6. Manifest contract validation (fails closed on any deviation). The
#    manifest is single-line canonical JSON written by scripts/release.ps1;
#    the exact-substring checks below are the parse contract.
validate_manifest() {
    mf="$1"
    grep -qF '"format":"eizoudendenshi-release-manifest"' "$mf" ||
        fail 'manifest has an unknown format'
    grep -qF '"formatVersion":1' "$mf" ||
        fail 'manifest format version is not supported (fails closed)'
    grep -qF '"helperContract":{"version":1,"minimumVersions":{}}' "$mf" ||
        fail 'manifest helper contract is not supported by this bootstrap (fails closed; helpers are not provisioned by this template)'
    grep -qE '"version":"[0-9]+\.[0-9]+\.[0-9]+' "$mf" ||
        fail 'manifest version is not a valid semver'
    # Greedy extraction: assumes the android/arm64 artifact appears exactly
    # once or last in the single-line manifest, as guaranteed by
    # scripts/release.ps1; a fail-closed release-format contract (any other
    # layout is refused by the checks below).
    entry="$(sed -n 's#.*{"name":"\([^"]*\)","target":"android/arm64","sha256":"\([0-9a-f]\{64\}\)"}.*#\1 \2#p' "$mf" | head -n 1)"
    name="${entry%% *}"
    sha="${entry##* }"
    [ -n "$name" ] && [ -n "$sha" ] ||
        fail 'manifest has no android/arm64 artifact (wrong architecture or missing entry)'
    [ "$name" = "$CORE_NAME" ] ||
        fail "manifest android/arm64 artifact name is not $CORE_NAME (fails closed)"
    MANIFEST_SHA="$sha"
    MANIFEST_VERSION="$(grep -o '"version":"[^"]*"' "$mf" | head -n 1 | sed 's/"version":"//; s/"$//')"
    [ -n "$MANIFEST_VERSION" ] || fail 'manifest version missing'
}

# 7. Install: the verified core is atomically moved (same filesystem) into
#    Termux app-private storage. This is the FIRST write to the install
#    location; every earlier step has failed closed on any discrepancy.
install_verified_core() {
    install_root="$PREFIX/$INSTALL_DIR"
    mkdir -p "$install_root" || fail "cannot create install directory $install_root"
    chmod 700 "$install_root" || fail 'cannot secure install directory permissions'
    mv -f "$EIZOU_TMP/$CORE_NAME" "$install_root/$CORE_NAME" ||
        fail 'cannot install verified core'
    chmod 700 "$install_root/$CORE_NAME" || fail 'cannot set core binary permissions'
    sync
}

main() {
    validate_release_url
    validate_pinned_key
    validate_environment
    ensure_prereqs
    make_private_tmp

    echo "EizouDendenshi bootstrap: fetching release manifest from ${RELEASE_BASE_URL}"
    fetch "$RELEASE_BASE_URL/$MANIFEST_NAME" "$EIZOU_TMP/$MANIFEST_NAME"
    fetch "$RELEASE_BASE_URL/$MANIFEST_NAME.minisig" "$EIZOU_TMP/$MANIFEST_NAME.minisig"

    echo 'EizouDendenshi bootstrap: verifying manifest Minisign signature'
    verify_minisign "$EIZOU_TMP/$MANIFEST_NAME" "$PINNED_PUBKEY"

    echo 'EizouDendenshi bootstrap: validating manifest (format, version, helper contract, android/arm64 artifact)'
    validate_manifest "$EIZOU_TMP/$MANIFEST_NAME"

    echo "EizouDendenshi bootstrap: fetching core ${CORE_NAME} (${CORE_TARGET})"
    fetch "$RELEASE_BASE_URL/$CORE_NAME" "$EIZOU_TMP/$CORE_NAME"
    fetch "$RELEASE_BASE_URL/$CORE_NAME.minisig" "$EIZOU_TMP/$CORE_NAME.minisig"

    echo 'EizouDendenshi bootstrap: verifying core Minisign signature'
    verify_minisign "$EIZOU_TMP/$CORE_NAME" "$PINNED_PUBKEY"

    echo 'EizouDendenshi bootstrap: verifying SHA-256 against the signed manifest'
    printf '%s  %s\n' "$MANIFEST_SHA" "$EIZOU_TMP/$CORE_NAME" |
        sha256sum -c - >/dev/null 2>&1 ||
        fail 'SHA-256 mismatch: downloaded core does not match the signed manifest'

    install_verified_core

    # The download cache is no longer needed: it is explicitly removed
    # here (the primary path); the EXIT trap remains as a safety net.
    rm -rf -- "$EIZOU_TMP"

    echo "EizouDendenshi bootstrap: verified EizouDendenshi ${MANIFEST_VERSION} installed at ${PREFIX}/${INSTALL_DIR}/${CORE_NAME}"
    # Install complete: the core is NOT auto-launched (an auto-started
    # process does not own a usable console stdin); the user runs
    # `grkd-edds` manually from their own terminal.
    echo ''
    echo -e "\033[1;32mInstallation complete! Run \`grkd-edds\` in the terminal to start.\033[0m"
}

main "$@"
