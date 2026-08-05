#!/data/data/com.termux/files/usr/bin/sh
#
# EizouDendenshi Termux helper-enabled bootstrap (ED-2D/ED-2F/ED-2G)
#
# Verify and install the signed android/arm64 EizouDendenshi core release
# into Termux app-private storage, FIRST provisioning the source helpers
# (python-yt-dlp / ffmpeg) from the OFFICIAL Termux package
# repository when missing, then print an install-complete message. The
# common CLI is NOT auto-launched: an auto-started process does not own a
# usable console stdin, so the user runs `grkd-edds` manually from their
# own terminal (where stdin works). Nothing is installed before every
# available verification step has passed.
#
# Distribution contract (do not weaken):
#   - Never fetched over the network and piped into a shell (no curl|sh).
#   - The pinned Minisign public key below MUST be replaced at release time;
#     an unreplaced template fails closed.
#   - The release base URL is an explicit input and MUST be https://.
#   - The helper contract REQUIRES version 3 with the fixed `termux`
#     packages map (official Termux pkg names: python-yt-dlp, ffmpeg)
#     whose minimum versions are manifest-controlled. Helpers are installed
#     ONLY through the Termux package manager (never from Windows assets,
#     never from arbitrary manifest commands — the package/command map is a
#     compiled-in allowlist); there is no silent helper self-update (this
#     template installs once and verifies versions; it never re-runs on
#     later boots). Missing helpers or a version below the manifest minimum
#     fail closed BEFORE the core is installed.
#   - Manifest signature, artifact signature, and artifact SHA-256 are all
#     verified BEFORE the core install; the verified binary is atomically
#     moved into app-private storage; an app-private `eizouden` CLI launcher
#     is installed at $PREFIX/bin (user-controlled Termux prefix).
#   - The existing v1 core-only Termux bootstrap is unchanged and remains
#     backward compatible; this template refuses v1/v2 contracts.
#
# Usage:
#   sh eizouden-bootstrap-helper.sh https://dl.example.org/eizouden/releases/0.2.0
#
# Harness-only overrides (never used in production; they relax ENVIRONMENT
# and SOURCE checks only — signature/SHA verification, version verification,
# and fail-closed order are never relaxed):
#   EIZOU_TEST=1                  relax the Termux/aarch64 checks
#   EIZOU_BOOTSTRAP_SKIP_PKG=1    skip `pkg install` (helpers must be on PATH)
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
HELPER_CONTRACT_VERSION=3
INSTALL_DIR='var/lib/eizouden'          # under $PREFIX (Termux app-private)
LAUNCHER_NAME='grkd-edds'               # CLI launcher in $PREFIX/bin

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

validate_pinned_key() {
    case "$PINNED_PUBKEY" in
        '' | *REPLACE_ME*)
            fail 'template public key is not pinned; refusing to run an unpinned bootstrap' ;;
    esac
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
}

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

# Dotted-numeric version compare: $1 >= $2 (POSIX sh).
version_ge() {
    a="$1"
    b="$2"
    while [ -n "$a" ] || [ -n "$b" ]; do
        av="${a%%.*}"
        bv="${b%%.*}"
        [ -n "$av" ] || av=0
        [ -n "$bv" ] || bv=0
        case "$av" in (*[!0-9]*) av=0 ;; esac
        case "$bv" in (*[!0-9]*) bv=0 ;; esac
        if [ "$av" -gt "$bv" ] 2>/dev/null; then return 0; fi
        if [ "$av" -lt "$bv" ] 2>/dev/null; then return 1; fi
        a_new="${a#*.}"
        b_new="${b#*.}"
        [ "$a_new" = "$a" ] && a='' || a="$a_new"
        [ "$b_new" = "$b" ] && b='' || b="$b_new"
    done
    return 0
}

# helper_version returns the version string of an installed helper command.
helper_version() {
    name="$1"
    cmd="$2"
    case "$name" in
        yt-dlp)
            "$cmd" --version 2>/dev/null | head -n 1 | tr -d '[:space:]'
            ;;
        ffmpeg)
            "$cmd" -version 2>/dev/null | head -n 1 |
                while read -r _ _ ver _; do printf '%s' "$ver"; done
            ;;
    esac
}

# ensure_helpers installs the missing helpers through the OFFICIAL Termux
# package repository (fixed package names compiled into this template; the
# minimum versions come from the signed manifest) and verifies each
# executable command + version. Any failure fails closed BEFORE the core.
# Helpers are located ONLY within $PREFIX/bin (the Termux prefix), never
# from the system PATH — this prevents host helpers from leaking in.
ensure_helpers() {
    if [ "$SKIP_PKG" != 1 ]; then
        missing=''
        [ -f "$PREFIX/bin/yt-dlp" ] || missing="$missing python-yt-dlp"
        [ -f "$PREFIX/bin/ffmpeg" ] || missing="$missing ffmpeg"
        if [ -n "$missing" ]; then
            echo "EizouDendenshi bootstrap: installing Termux helpers:$missing"
            pkg install -y python-yt-dlp ffmpeg ||
                fail 'pkg install of helpers failed'
        fi
    fi
    verify_helper 'yt-dlp' 'yt-dlp' "$TERMUX_MIN_YTDLP"
    verify_helper 'ffmpeg' 'ffmpeg' "$TERMUX_MIN_FFMPEG"
}

verify_helper() {
    name="$1"
    cmd="$2"
    minimum="$3"
    # Only look within $PREFIX/bin (not system PATH) to prevent host leaks.
    [ -f "$PREFIX/bin/$cmd" ] ||
        fail "helper $name not found (command $cmd missing from $PREFIX/bin)"
    ver="$(helper_version "$name" "$PREFIX/bin/$cmd")"
    [ -n "$ver" ] || fail "helper $name version check failed"
    if version_ge "$ver" "$minimum"; then
        echo "EizouDendenshi bootstrap: helper $name version $ver (minimum $minimum) OK"
    else
        fail "helper $name version $ver is below the manifest minimum $minimum"
    fi
}

# Manifest contract validation: helper contract MUST be version 3 with the
# fixed Termux packages map; the minimums are manifest-controlled.
validate_manifest() {
    mf="$1"
    grep -qF '"format":"eizoudendenshi-release-manifest"' "$mf" ||
        fail 'manifest has an unknown format'
    grep -qF '"formatVersion":1' "$mf" ||
        fail 'manifest format version is not supported (fails closed)'
    grep -qF '"termux":{"packages":' "$mf" ||
        fail 'manifest has no Termux packages map (helper contract is not the v3 Termux contract; fails closed)'
    grep -qF '"version":3,' "$mf" ||
        fail 'manifest helper contract version is not exactly 3 (fails closed; a core-only v1 or a Windows-only v2 release is refused here)'
    grep -qE '"version":"[0-9]+\.[0-9]+\.[0-9]+' "$mf" ||
        fail 'manifest version is not a valid semver'
    # The two fixed Termux package entries must be present verbatim.
    grep -qF '"yt-dlp":{"package":"python-yt-dlp","command":"yt-dlp","minimum":"' "$mf" ||
        fail 'manifest Termux package entry for yt-dlp is missing or unsafe (fails closed)'
    grep -qF '"ffmpeg":{"package":"ffmpeg","command":"ffmpeg","minimum":"' "$mf" ||
        fail 'manifest Termux package entry for ffmpeg is missing or unsafe (fails closed)'
    TERMUX_MIN_YTDLP="$(sed -n 's#.*"yt-dlp":{"package":"python-yt-dlp","command":"yt-dlp","minimum":"\([^"]*\)".*#\1#p' "$mf" | head -n 1)"
    TERMUX_MIN_FFMPEG="$(sed -n 's#.*"ffmpeg":{"package":"ffmpeg","command":"ffmpeg","minimum":"\([^"]*\)".*#\1#p' "$mf" | head -n 1)"
    [ -n "$TERMUX_MIN_YTDLP" ] && [ -n "$TERMUX_MIN_FFMPEG" ] ||
        fail 'manifest Termux minimum versions missing (fails closed)'
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

install_verified_core() {
    install_root="$PREFIX/$INSTALL_DIR"
    mkdir -p "$install_root" || fail "cannot create install directory $install_root"
    chmod 700 "$install_root" || fail 'cannot secure install directory permissions'
    mv -f "$EIZOU_TMP/$CORE_NAME" "$install_root/$CORE_NAME" ||
        fail 'cannot install verified core'
    chmod 700 "$install_root/$CORE_NAME" || fail 'cannot set core binary permissions'
    sync
}

# App-private CLI launcher `grkd-edds` at $PREFIX/bin (user-controlled
# Termux prefix, already on PATH; no profile edit). A legacy `eizouden`
# launcher from an older bootstrap is removed (cleanup; the common command
# is grkd-edds).
install_launcher() {
    launcher="$PREFIX/bin/grkd-edds"
    mkdir -p "$PREFIX/bin" || fail 'cannot create launcher directory'
    printf '%s\n' \
        '#!/data/data/com.termux/files/usr/bin/sh' \
        "exec \"$PREFIX/$INSTALL_DIR/$CORE_NAME\" cli \"\$@\"" > "$launcher" ||
        fail 'cannot write the CLI launcher'
    chmod 700 "$launcher" || fail 'cannot set launcher permissions'
    if [ -e "$PREFIX/bin/eizouden" ]; then
        rm -f -- "$PREFIX/bin/eizouden" || fail 'cannot remove the legacy eizouden launcher'
    fi
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

    echo 'EizouDendenshi bootstrap: validating manifest (v3 Termux helper contract, android/arm64 artifact)'
    validate_manifest "$EIZOU_TMP/$MANIFEST_NAME"

    echo 'EizouDendenshi bootstrap: provisioning + verifying Termux helpers'
    ensure_helpers

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
    install_launcher

    rm -rf -- "$EIZOU_TMP"

    echo "EizouDendenshi bootstrap: verified EizouDendenshi ${MANIFEST_VERSION} installed at ${PREFIX}/${INSTALL_DIR}/${CORE_NAME}"
    # Install complete: the common CLI is NOT auto-launched (an
    # auto-started process does not own a usable console stdin); the user
    # runs `grkd-edds` manually from their own terminal.
    echo ''
    echo -e "\033[1;32mInstallation complete! Run \`grkd-edds\` in the terminal to start.\033[0m"
    exit 0
}

main "$@"
