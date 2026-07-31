# EizouDendenshi — ED-2B / ED-2C loopback companion PoC

> **Planned source home:** `Entei/companion/eizoudendenshi/`. This temporary
> standalone directory is the ED-2 PoC location and will move in ED-2D; it is
> not a separate product repository.

EizouDendenshi is the planned Windows / Termux localhost companion for
Entei (映像電伝師). **ED-2A** proved the safe local API / pairing
foundations. **ED-2B** adds a single-fixture byte-Range media endpoint to
prove the loopback CORS + Range path. Both stages are dependency-free Go
using only the standard library.

> **Status:** ED-2B PoC with the **ED-2C developer-origin override**
> (`--allow-origin`) implemented, plus **ED-2D Stage A release-delivery
> tooling** (release helper, Termux bootstrap template, automated test
> harness) — see [ED-2D Stage A](#ed-2d-stage-a-release-delivery-tooling).
> This is **not** a media server and is **not** integrated with Entei. A
> **manual Windows Chrome static-fixture verification was performed on
> 2026-07-31** (see [ED-2B verification](#ed-2b-verification-manual-windows-chrome));
> it is a manual browser check, **not** an automated Go test. Termux runtime
> smoke is also complete (see [ED-2C verification](#ed-2c-verification-termux-runtime)).
> Android Chrome LAN-origin browser QA is also complete (see
> [ED-2C verification](#ed-2c-verification-android-chrome-lan-origin)).
> **Delivery is NOT complete:** HTTPS deployed Entei origin, growing media
> progressive playback in a real browser, audio listening/decode, and a
> Windows installer remain outstanding. The **ED-2C growing-media Range
> contract is PASSED on Windows and Termux loopback (2026-07-31)** —
> measured through real companion binaries (`503 + Retry-After` buffering,
> no fabricated bytes); real-browser progressive playback is **not**
> verified and is not claimed.
> **ED-2D Stage B (clean-Termux device gate) PASSED on 2026-07-31** with
> the GitHub prerelease `eizoudendenshi-v0.2.0-rc.2` — see
> [Stage B verification](#stage-b-clean-termux-device-gate-passed-2026-07-31-rc2).
> The **rc.1** trial failed the fetch step (GitHub Release asset URLs answer
> `302`, and the rc.1 fetch did not follow redirects, so Minisign
> verification failed before install); the rc.2 fetch fixed it and passed
> the gate — rc.1 itself did not pass. The rc.2 **release-identity display
> bug** (manifest `0.2.0-rc.2` vs banner `EizouDendenshi ED-2B (0.2.0)`) is
> **fixed in the tooling and verified on device with `rc.3` (2026-07-31)**:
> `scripts/release.ps1` now injects the validated `-Version` into both
> binaries at link time, with Go + harness tests pinning the contract, and
> the `eizoudendenshi-v0.2.0-rc.3` bootstrap passed manifest/core Minisign
> verify, signed SHA-256, and app-private install, with the foreground
> banner showing `EizouDendenshi ED-2B (0.2.0-rc.3)` on
> `http://127.0.0.1:36441` — see
> [rc.3 verification](#release-identity-display-fix-verified-on-device-rc3-2026-07-31).

## ED-2A scope (retained)

- Go module using only the Go standard library (no third-party modules).
- Executable (`cmd/eizouden`) that binds **loopback only** (`--addr` flag,
  default `127.0.0.1:0`), prints the resolved bound address and a freshly
  generated 6-digit pairing code to the terminal.
- Pairing code and opaque capability token are generated with `crypto/rand`
  and live **only in process memory** — no files, storage, cookies, or logs.
- JSON HTTP API:
  - `GET /v1/health` — non-sensitive readiness/version data.
  - `POST /v1/pair` — accepts `{"code":"123456"}`, requires an allowed
    Origin, returns the capability token only on a correct code. The code is
    single-use and never echoed in errors.
  - `OPTIONS /v1/pair` — correct CORS preflight.
  - Unknown routes → 404; unknown methods → 405; all errors are non-secret.
- Strict CORS: only exactly `https://entei.gorakudo.org` and
  `http://localhost:4321`. No `*`. Disallowed Origin is rejected on state
  change without CORS headers. (ED-2C: a per-process `--allow-origin`
  development override may add further exact origins; see below. It never
  replaces this fixed set.)
- Loopback guard: `--addr` must be a **literal loopback IP** — IPv4
  `127.0.0.0/8` or IPv6 `::1` — with a valid numeric port (0–65535).
  Hostnames (including `localhost`), the empty host (`:port`, which binds
  all interfaces), wildcard/unspecified addresses, and non-loopback IPs are
  rejected at startup.

## ED-2B additions

- `--fixture <path>` flag: serves exactly one media file at
  `GET/HEAD /v1/media/fixture`. **No fixture → media endpoint is honestly
  disabled (generic 404)**; the endpoint never scans directories and never
  discloses local paths.
- The media endpoint requires **both**:
  1. an exact allowed Origin (`https://entei.gorakudo.org` or
     `http://localhost:4321`), and
  2. a valid capability token via the `token` **query parameter**.
- **Token-in-query limitation (explicit):** video elements cannot add
  `Authorization` / `Bearer` headers, so the PoC accepts the pairing token
  as a query parameter. This is PoC-only local-media capability — it is not
  a production credential transport. The token is never logged or echoed
  (validation is constant-time; errors are generic and secret-free).
- Byte Range semantics via the standard library (`http.ServeContent`):
  `206 Partial Content`, `Content-Range`, `Accept-Ranges: bytes`,
  `416` for unsatisfiable ranges. The file is streamed, never read fully
  into memory. Responses set `Cache-Control: no-store`; allowed
  cross-origin responses set exact `Access-Control-Allow-Origin`,
  `Vary: Origin`, and `Access-Control-Expose-Headers:
Content-Range, Accept-Ranges, Content-Length`.
- `OPTIONS /v1/media/fixture` preflight (GET/HEAD/OPTIONS), strictly
  origin-gated.
- Version bumped to `0.2.0`.

## ED-2C additions (developer-origin override)

- Repeatable `--allow-origin <origin>` flag: an explicit one-off development
  origin permitted by CORS **for this process only** — e.g. the LAN
  dev-server origin (`location.origin`) seen by Android Chrome during
  on-device DevTools QA, which is not in the fixed production/development
  allowlist.
- Each nonempty value must be an **exact HTTP(S) origin**: scheme `http` or
  `https` only, host required, optional numeric port; no userinfo, no path,
  query, or fragment, no wildcards. Values are normalized (lowercase scheme
  and host, default ports `:80`/`:443` dropped, whitespace trimmed) or
  rejected **before the listener starts**. Empty values are ignored.
- The fixed origins (`https://entei.gorakudo.org`, `http://localhost:4321`)
  always remain; the override only adds exact entries to the combined
  allowlist. The allowlist lives in process memory only — the setting is
  never persisted — and every CORS decision (health / pair / media /
  preflight) uses the combined exact set. The Origin header is echoed only
  when it exactly matches an allowlisted entry; there is no wildcard and no
  reflection.
- Allowed origins are never printed to the terminal or logs, and the
  capability token / pairing code are never logged. Errors stay generic.
- **Development-only override. Never use it for production, and never add
  its value to the built-in allowlist.** It exists for one-off QA origins;
  it must not become a release allowlist entry.

## ED-2C growing-media Range PoC (contract, not browser-verified)

A media file that is **still growing** (e.g. a download in progress) has a
known final size plus a current available prefix. This PoC establishes the
explicit HTTP contract for that shape **without a downloader**: a
deterministic source abstraction simulates available bytes growing over
time, and the endpoint never fabricates data. It is implemented, tested,
and **measured on both Windows and Termux Android/arm64 loopback through
real companion binaries (2026-07-31)** — see
[measurement record](#measured-on-windows-and-termux-loopback-2026-07-31).
It is **not** measured in a real browser yet (see gates below).

### Source abstraction (`internal/media`)

- `GrowingSource`: `Total()` (known final size) + `Available()` (current
  available bytes, `0 <= n <= Total`) + `ReadAt`, strictly bounded by the
  availability at call time.
- `MemSource`: deterministic in-memory fixture; `SetAvailable` advances
  availability (monotonic, append-only shape) with no downloader.
- `FileSource`: file-backed source for the CLI — the file's current size
  per `Stat` is the available length; `--grow-total` declares the final
  size. Writers must be append-only (no truncation / in-place rewrite).

### HTTP contract (`/v1/media/fixture` with `--grow-fixture`)

| Condition | Response |
|---|---|
| GET/HEAD, no usable Range, `Available == Total` | `200` full body, `Content-Length: Total` |
| GET/HEAD, no usable Range, `Available < Total` | `503` + `Retry-After: 1`, JSON body (below) |
| Range fully within `[0, Available)` | `206`, exact window, `Content-Range: bytes a-b/Total` |
| Range crossing or beyond `Available` (start `< Total`) | `503` + `Retry-After: 1`, JSON body (below) |
| Range starting at/after `Total` | `416`, `Content-Range: bytes */Total` (permanent only) |
| Suffix range (`bytes=-n`) while incomplete | `503` (suffix selects the final n bytes of the TOTAL representation) |
| Malformed / non-`bytes` / multi-range header | ignored (treated as no Range; multipart unsupported) |

503 body — metadata only, never paths or tokens:

```json
{"error":"buffering","available":100,"total":2048}
```

All responses carry `Cache-Control: no-store`, `Accept-Ranges: bytes`,
`Access-Control-Expose-Headers: Content-Range, Accept-Ranges,
Content-Length, Retry-After`. HEAD mirrors GET's status and headers with
an empty body.

### Why `503 + Retry-After` (tradeoff)

The alternatives were rejected as unsafe or ambiguous:

- **Truncated `206`** (serve only the available part of the window): the
  player silently treats the truncated body as the real file — corruption,
  not buffering. Banned.
- **`416` for not-yet-available ranges**: `416` means *permanently*
  unsatisfiable; clients and caches may treat it as final. Only
  `start >= Total` is permanent here, and that is the single `416` case.
- **`200` with the available prefix / zero-byte success**: falsely claims
  the representation is complete (`Content-Length < Total`). Banned.
- **Blocking the request until bytes arrive**: ties up a connection and a
  handler indefinitely; not an HTTP answer to "not yet". Banned.
- **`425 Too Early`**: wrong semantics (early-data) and poor support. Not
  used.

`503` + `Retry-After` is the standard "try again later" signal; the JSON
body carries `available`/`total` so a bridge can decide when a retry makes
sense (e.g. compute a backoff from progress). `Retry-After: 1` is a PoC
fixed default; a downloader-backed source can compute it later. No paths,
tokens, or pairing data ever appear.

### Measured on Windows and Termux loopback (2026-07-31)

The same deterministic growing-file scenario was run through the **actual
companion binaries** on **Windows loopback** and **Termux (Android/arm64)
loopback**. Fixture: total 200 bytes, initial available 100 bytes; the
token/origin gates were satisfied. Identical results on both platforms:

| Request | Response |
|---|---|
| `Range: bytes=0-49` | `206`, `Content-Range: bytes 0-49/200`, 50-byte body |
| `Range: bytes=0-150` (crossing availability) | `503`, `Retry-After: 1`, 50-byte JSON buffering body (no media bytes) |
| `Range: bytes=100-150` (wholly unavailable) | `503`, `Retry-After: 1` — **NOT `416`** |
| append file to 200; `Range: bytes=0-150` | `206`, `Content-Range: bytes 0-150/200`, 151-byte body |
| `Range: bytes=200-` | `416`, `Content-Range: bytes */200`, empty body |

Both temporary servers, binaries, and fixtures were removed afterwards,
and the Termux wake lock was released.

The Go test suite covers the full contract (boundary-exact-end, crossing,
wholly-unavailable, suffix, `416`-only-when-permanent, HEAD mirror,
invalid-Range ignore, secrets-not-leaked) plus a deterministic concurrent
availability-change test; `go test -race ./...` is green. The **`503`-vs-
`416` safety contract holds on device**: only `start >= Total` is `416`,
and a crossing or wholly-unavailable range is always an explicit retryable
`503` — never a truncated `206`, a zero-byte fake success, or a block.

### TOCTOU

`Available()` is snapshotted **once per request**; the served window is
derived from that snapshot and reads never cross it. Sources additionally
enforce the bound in `ReadAt` itself, and availability is monotonic
(append-only contract) — a concurrent writer cannot cause an unavailable
byte to be served. No disk paths appear in error responses or logs.

### Not implemented (PoC boundary)

- No downloader (yt-dlp / aria2 / ffmpeg are not installed, run, or
  called).
- Real-browser progressive playback (Chrome seek policy, `<video>`
  behavior against a growing file) and the production bridge are **not**
  implemented or measured — the loopback contract pass above does **not**
  extend to them. Separate Windows/Termux **browser** measurements are
  required before any gate completion is claimed.

## Deferred boundaries (out of scope through ED-2B)

- yt-dlp / YouTube source handling
- aria2 / torrent / BitTorrent download engine
- Cookie storage and transmission
- Growing-media capture / real media URL plumbing (the ED-2C growing source
  is a no-downloader contract PoC — see
  [growing-media PoC](#ed-2c-growing-media-range-poc-contract-not-browser-verified);
  loopback PASSED 2026-07-31; no real downloader and no Entei-side
  integration)
- Input OTP UI and any Entei browser integration
- Minisign installer / signing / distribution
- Production endpoint/port contract (only the `--addr` PoC control exists)

These are the ED-2C+ checkpoints. ED-2B deliberately builds none of them.

## ED-2B verification (manual Windows Chrome)

Performed manually via Chrome DevTools on 2026-07-31, from the Entei dev
page origin `http://localhost:4321/player/` against a temporary companion
bound to `127.0.0.1:4322` and a disposable ~3s 320x180 H.264/AAC MP4
fixture. This was a manual browser QA session, **not** an automated Go
test. Non-secret observed results:

- Pairing `POST /v1/pair` returned 200; the capability token was held in
  page memory only (never in console/logs).
- `fetch` with `Range: bytes=100-199` returned **206** with
  `Content-Range`, exact `Access-Control-Allow-Origin: http://localhost:4321`
  (no wildcard), `Vary: Origin`, `Cache-Control: no-store`, and exposed
  range headers; the 100-byte window was readable from the Entei origin.
- A detached `<video crossOrigin="anonymous">` loaded metadata at
  320x180 / ~3.0s and played muted (Range-based seeking observed in the
  network panel).
- `canvas.drawImage` + `toBlob` succeeded — **no `SecurityError`**
  (CORS-clean canvas confirmed).
- `captureStream()` exposed **1 video + 1 audio track**; `MediaRecorder`
  produced a non-empty `video/webm` blob.
- The companion process, the disposable fixture, and QA output files were
  removed afterwards; no listener was left on 4322.

### Outstanding gates (not claimed by this verification)

- **HTTPS deployed Entei origin** (`https://entei.gorakudo.org`) — QA used
  the local HTTP dev origin only.
- **Growing media** — the fixture was a static ~3s file; growing-file
  Range behavior has an ED-2C **contract measurement PASS on Windows and
  Termux loopback (2026-07-31 — see
  [measurement record](#measured-on-windows-and-termux-loopback-2026-07-31))**
  but is **not browser-measured**.
- **Audio listening / decode verification** — muted playback only; audio
  output was not listened to or decoded.
- **Minisign installer / delivery** — out of scope through ED-2C.

## ED-2C verification (Termux runtime)

Performed over passwordless SSH on 2026-07-31 against a Termux aarch64 device.
This verifies the native runtime and loopback API, not Android Chrome.

- Installed Termux `golang` and confirmed `go1.26.5 android/arm64`.
- Built the pure-Go companion as `CGO_ENABLED=0 GOOS=android GOARCH=arm64` and
  ran it on the device at `127.0.0.1:4322` with a disposable H.264/AAC fixture.
- Termux-local pairing returned a memory-only token; an authenticated
  `Range: bytes=100-199` media request returned `206`, the expected
  `Content-Range`, exact development Origin, and `Cache-Control: no-store`.
- The process was started in the background with a retained PID. After the
  smoke, the PID was stopped, wake lock released, and the device/local fixture
  and temporary binary were deleted.

Android Chrome from `https://entei.gorakudo.org`, growing media progressive
playback, and audio listening/decode remain separate gates; Minisign
delivery itself is now proven on the Termux path (ED-2D Stage B,
2026-07-31). The growing-media Range **contract PASSED the Termux loopback
measurement on 2026-07-31** (see
[measurement record](#measured-on-windows-and-termux-loopback-2026-07-31));
real-browser progressive-playback measurements are still required.

## ED-2C verification (Android Chrome LAN origin)

Performed manually on 2026-07-31 from Android Chrome at a temporary LAN dev
origin. The Termux companion bound only to the phone's `127.0.0.1:4322`; the
one-off process received that exact LAN origin through the development-only
`--allow-origin` flag. The fixed release allowlist was not changed.

- Pairing succeeded with `200 OK`; the token stayed in page memory only.
- `Range: bytes=100-199` returned `206` with exactly 100 bytes and
  `Content-Range: bytes 100-199/120760`.
- A detached, muted video loaded at 320x180.
- `canvas.drawImage` plus `toBlob` produced a 34,246-byte PNG without a
  `SecurityError`.
- `captureStream()` exposed one video and one audio track. `MediaRecorder`
  produced a non-empty 62,346-byte `video/webm;codecs=vp8,opus` Blob.
- The companion stayed backgrounded under a retained PID. Afterwards its PID
  was stopped, wake lock released, and the phone/local fixture and temporary
  binaries were deleted.

This verifies Android Chrome only for the temporary HTTP LAN dev origin. HTTPS
deployed Entei origin, growing media progressive playback, audio
listening/decode remain separate gates; Minisign delivery is proven on the
Termux path only (ED-2D Stage B, 2026-07-31). The growing-media Range
**contract PASSED the loopback measurements on 2026-07-31** (see
[measurement record](#measured-on-windows-and-termux-loopback-2026-07-31));
it is **not** browser-verified.

## General-user Termux setup (ED-2D)

General users install the Termux APK once, then run one documented bootstrap
command. They do **not** install Go: the bootstrap downloads the signed
`android/arm64` Eizou core binary. The end-to-end clean-Termux device gate
(Stage B) **passed on 2026-07-31 with `eizoudendenshi-v0.2.0-rc.2`** — see
[Stage B verification](#stage-b-clean-termux-device-gate-passed-2026-07-31-rc2).

**ED-2D Stage A ships the tooling for this** — see
[ED-2D Stage A](#ed-2d-stage-a-release-delivery-tooling) below. The Stage A
bootstrap template installs only the verifier/download prerequisites
(`curl`, `minisign`, `coreutils`) from the official Termux repository,
verifies a release manifest and the core asset with a Minisign public key
pinned inside the copied command, verifies SHA-256 against the signed
manifest, then installs the verified core into Termux app-private storage
(`$PREFIX/var/lib/eizouden`) and starts it in the foreground for pairing.

Future source helpers (`python-yt-dlp`, `aria2`, `ffmpeg`) are deliberately
**not** installed by this template. They belong to a later stage; a release
manifest that demands helpers (a `helperContract` this template does not
exactly support) is **refused before install (fail closed)**.

Android permission prompts cannot be silently bypassed. The Stage A template
does not request wake-lock; a future stage may ask for `termux-wake-lock`,
but the user must always approve wake-lock / unrestricted battery behavior
in Android when prompted.

The bootstrap must not use an unverified `curl | sh` remote script. It is a
plain copy-paste script containing the pinned Minisign public key; only
verified release files run after the verifier is installed.

## ED-2D Stage A (release-delivery tooling)

ED-2D Stage A implements the release-delivery pipeline. **It does not claim
delivery is complete** — see [Stage B gate](#stage-b-clean-termux-device-gate).

### `scripts/release.ps1` — build/release helper

- `build` verb: cross-builds `eizouden-windows-amd64.exe`
  (`windows/amd64`) and `eizouden-android-arm64` (`android/arm64`) with
  `CGO_ENABLED=0`, `-trimpath`, and `-ldflags "-s -w"`. The binaries keep
  the `api.Version` dev default (`0.2.0`).
- `release` verb: builds the binaries with the validated `-Version`
  **injected at link time** (`-ldflags -X
  eizoudendenshi/internal/api.Version=<semver>`) so both binaries report
  exactly the manifest version in the startup banner and `/v1/health`;
  additionally writes the single-line versioned manifest
  `eizouden-manifest.json` — `format`, `formatVersion`, `version`,
  `helperContract` (placeholder, fails closed: only contract v1 with zero
  helper requirements is accepted), and one `artifacts` entry per binary
  (`name`, `target`, lowercase `sha256`) — then creates detached Minisign
  signatures (`<file>.minisig`) for the manifest and every artifact, and
  emits a key-pinned `bootstrap.sh` copy when the public key file is given.
- The signing key is supplied **explicitly** via `-MinisignKeyPath` or the
  `EIZOUDEN_MINISIGN_KEY` environment variable; the public key file via
  `-PublicKeyFile` or `EIZOUDEN_MINISIGN_PUBKEY_FILE`. A release run without
  a key fails (no unsigned release). No secret material ever lives in the
  repository.

```powershell
# binaries only
powershell -File scripts/release.ps1 build -OutDir dist

# full release (manifest + detached signatures + pinned bootstrap copy)
powershell -File scripts/release.ps1 release -Version 0.2.0 -OutDir dist `
  -MinisignKeyPath C:\secrets\eizouden.minisign.key `
  -PublicKeyFile C:\secrets\eizouden.minisign.pub
```

### `scripts/termux-bootstrap.sh` — Termux bootstrap template

A plain POSIX sh template (distributed as a copy-paste command, **no
`curl | sh`**) that, in order: validates the explicit HTTPS release base URL
(non-HTTPS / userinfo / query / fragment are rejected), validates the pinned
Minisign public key (an unreplaced template placeholder fails closed),
validates the environment (real Termux prefix, Linux, aarch64, `pkg`
present), installs only `minisign`/`curl`/`coreutils` from the official
Termux repository, creates a private mode-700 temp dir (trapped for cleanup
on every exit), fetches and verifies the manifest signature, validates the
manifest (format, version, helper contract — fail closed, android/arm64
artifact), fetches and verifies the core signature, verifies SHA-256
against the signed manifest, atomically installs the verified core into
`$PREFIX/var/lib/eizouden`, removes the download cache, and finally `exec`s
the core in the foreground to print the pairing code.

The template ships with `PINNED_PUBKEY='REPLACE_ME_PINNED_MINISIGN_PUBLIC_KEY'`.
The release helper substitutes the real key into the distributed copy; the
unreplaced template refuses to run. Test-only hooks (`EIZOU_TEST`,
`EIZOU_BOOTSTRAP_SKIP_PKG`, `EIZOU_MIRROR_DIR`) exist solely for the test
harness and never relax signature/SHA-256 verification or install
permissions.

The production fetch follows redirects on purpose: GitHub Release asset
URLs answer `302` and redirect to the release CDN, so the curl invocation
uses `--location` with a bounded `--max-redirs 5` and `--proto-redir =https`
(no silent HTTPS→HTTP downgrade) while keeping `--fail`, the
connect/max-timeouts, and `--retry 2`. The **rc.1** clean-Termux trial
failed because the fetch saved the unfollowed 302 response; the harness
statically asserts this contract so it cannot regress.

### `scripts/test-release.ps1` — automated harness

Runs the whole pipeline against **temporary Minisign keys/material in
`A:\Temp\opencode` only** (never in the repo). It requires a POSIX `sh`
(git-bash) and a `minisign` binary (PATH, `A:\Temp\opencode\minisign-bin\…`,
or an auto-fetched official win64 build). Without either, dynamic cases are
explicitly conditioned out and static fail-closed checks still run.

- **Static checks** (always run): no pipe-to-shell, placeholder must be
  rejected, HTTPS-only URL validation, verify-before-install ordering,
  prerequisites limited to verifier/download tools, no privilege escalation,
  private temp dir + cleanup, app-private atomic install path, foreground
  pairing start, helper contract fails closed, redirect-following curl
  fetch (`--location`, bounded `--max-redirs`, `--proto-redir =https`) with
  `--fail`/timeout/retry retained, key via explicit arg/env only.
- **Dynamic cases** (sh + minisign available):
  - release helper: manifest format/contract/targets/SHA-256 fields and
    detached-signature verification; the release under test uses a
    test-only version (`9.9.9`);
  - plain `build` (no `-Version`): the built windows binary's startup
    banner keeps the dev default `0.2.0`;
  - **T1 success**: verified install → foreground start → real companion
    binary prints a 6-digit pairing code; installed bytes match the signed
    manifest; the startup banner reports the requested release version and
    agrees with the manifest version;
  - **T2/T3**: tampered manifest / tampered binary → signature verification
    failure **before install**;
  - **T4a/T4b**: missing core / manifest signature → failure before install;
  - **T5**: wrong architecture (no `android/arm64` artifact) → failure
    before install;
  - **T6**: unsafe (non-HTTPS) base URL → rejected before any download;
  - **T7**: unpinned template key → fail closed;
  - **T8**: unsupported helper contract → fail closed;
  - **T9**: non-Termux environment → rejected before install;
  - **T10**: SHA-256 mismatch with valid signatures → failure before install.
  - Every failure case also asserts: nonzero exit, nothing installed, and
    the private temp dir was cleaned up.

```powershell
powershell -File scripts/test-release.ps1        # all checks, temp keys
powershell -File scripts/test-release.ps1 -Keep  # keep the run dir for inspection
```

### Stage B clean-Termux device gate (PASSED 2026-07-31, rc.2)

**PASSED for Android / Termux arm64** on 2026-07-31 with the GitHub
prerelease `eizoudendenshi-v0.2.0-rc.2`, on a fresh Termux reinstall where
the bootstrap downloaded everything from the GitHub release. Observed
results:

- Manifest **Minisign verify PASS**; `android/arm64` core binary **Minisign
  verify PASS**; **SHA-256 against the signed manifest PASS**.
- The verified core installed at
  `/data/data/com.termux/files/usr/var/lib/eizouden/eizouden-android-arm64`
  and launched in the foreground, emitting the pairing code.
- Via SSH, installed bytes `6291752` and SHA-256
  `d4cf15b544cffbaf60b1f1a35b8d0751436ef6456edca3a31e921fd9f15046b7` were
  confirmed to match the GitHub asset digest; zero `eizouden-bootstrap`
  temp dirs were left behind.
- The rc.1 fetch defect (302 redirects not followed) is fixed by rc.2 —
  **rc.1 itself did not pass** (only the fail-closed ordering was proven
  there).

**Release-identity display bug — fixed in tooling, verified on device with
`rc.3` (2026-07-31):** the rc.2 manifest/release version was `0.2.0-rc.2`
while the binary banner printed `EizouDendenshi ED-2B (0.2.0)` (rc.2
predates version injection). `scripts/release.ps1` now injects the
validated `-Version` into both binaries at link time, Go tests pin the
`api.Version` dev default and the banner contract, and the test harness
asserts the startup banner reports the requested release version and
agrees with the manifest version. The **`eizoudendenshi-v0.2.0-rc.3`**
bootstrap verified this on device — see
[below](#release-identity-display-fix-verified-on-device-rc3-2026-07-31).
The rc.2 identity display mismatch is closed.

The harness still substitutes a Windows build for the android/arm64
artifact (so the real companion binary can be executed and observed in
tests; the real android/arm64 ELF install + exec is now covered by the
Stage B record above). Remaining delivery gates: **HTTPS deployed Entei
origin, growing media progressive playback in a real browser, audio
listening/decode, and the Windows installer**.

### Release-identity display fix verified on device (rc.3, 2026-07-31)

**PASSED on Android / Termux arm64** on 2026-07-31 with the GitHub
prerelease `eizoudendenshi-v0.2.0-rc.3`: the bootstrap passed the manifest
Minisign verify, the `android/arm64` core binary Minisign verify, and the
SHA-256 check against the signed manifest, then completed the app-private
install. The foreground banner showed
`EizouDendenshi ED-2B (0.2.0-rc.3) listening on
http://127.0.0.1:36441` — the banner version now **matches the manifest
version**, closing the rc.2 identity display mismatch (manifest
`0.2.0-rc.2` vs banner `EizouDendenshi ED-2B (0.2.0)`).

## Build and run

```sh
# run with an ephemeral loopback port (default)
go run ./cmd/eizouden

# or pin a port, with the ED-2B media fixture enabled
go run ./cmd/eizouden --addr 127.0.0.1:4322 --fixture /path/to/media.mp4

# ED-2C: additionally permit one explicit development origin for this
# process (Android Chrome LAN DevTools QA). Placeholder origin only —
# replace <lan-dev-origin> with the exact location.origin seen on-device.
go run ./cmd/eizouden --addr 127.0.0.1:4322 --fixture /path/to/media.mp4 \
  --allow-origin http://<lan-dev-origin>:4321

# ED-2C growing media: a file still being appended by another process.
# --grow-total declares the known final size; the file's current size is
# the source of truth for available bytes (writers must be append-only).
# Contract PoC only — not a browser-verified feature (see below).
go run ./cmd/eizouden --addr 127.0.0.1:4322 \
  --grow-fixture /path/to/growing.mp4 --grow-total 104857600
```

> **Port note:** the companion must **not** be bound to `127.0.0.1:4321` —
> that port is reserved for the Entei dev server origin
> (`http://localhost:4321`, the CORS-allowed browser origin). Examples
> below use `127.0.0.1:4322` as the companion's distinct loopback port.

On startup the terminal shows the resolved address, the pairing code, and
the media state:

```
EizouDendenshi ED-2B (0.2.0) listening on http://127.0.0.1:4322
Pairing code: 483920
Media fixture: enabled (media.mp4)
```

With `--grow-fixture`, the media line reports the known final size and the
current availability:

```
Media fixture: growing (total 104857600 bytes, available 409600)
```

The capability token is never printed or logged; it is returned once by
`POST /v1/pair` and kept in process memory.

## Test / cross-compile

```sh
gofmt -l .        # formatting check (must print nothing)
go test ./...     # unit + httptest API tests (ED-2A + ED-2B media suite + ED-2C origin override + growing-media contract)
go vet ./...      # static checks
```

Cross builds go through the release helper (see
[ED-2D Stage A](#ed-2d-stage-a-release-delivery-tooling)):

```powershell
powershell -File scripts/release.ps1 build -OutDir <temp-dir>   # windows/amd64 + android/arm64
```

The release-delivery test harness is `scripts/test-release.ps1` (all
checks pass 2026-07-31 with temporary Minisign keys in
`A:\Temp\opencode`). ED-2A cross-builds `windows/amd64` and
`android/arm64`. ED-2C verified the pure-Go `android/arm64` binary's Termux
loopback runtime. **ED-2D Stage B (clean-Termux device gate) PASSED
2026-07-31 with rc.2** (see
[Stage B verification](#stage-b-clean-termux-device-gate-passed-2026-07-31-rc2)).
The release-identity display fix was **verified on device with rc.3 on
2026-07-31** (see
[rc.3 verification](#release-identity-display-fix-verified-on-device-rc3-2026-07-31))
— the banner now reports the manifest version. The ED-2C growing-media
Range contract has a no-downloader PoC whose **Windows + Termux loopback
measurements PASSED on 2026-07-31** (see
[measurement record](#measured-on-windows-and-termux-loopback-2026-07-31));
Android Chrome media behavior, the HTTPS deployed Entei origin, growing
media progressive playback, audio listening/decode, and the Windows
installer remain later checkpoints.

## Layout

```
cmd/eizouden/        executable: flags, loopback guard, bootstrap, handoff
internal/api/        HTTP API: /v1/health, /v1/pair, /v1/media/fixture, CORS
internal/pairing/    crypto/rand pairing code + capability token
scripts/release.ps1        ED-2D Stage A: build/release helper (manifest + Minisign)
scripts/termux-bootstrap.sh ED-2D Stage A: Termux bootstrap template (pinned key)
scripts/test-release.ps1   ED-2D Stage A: automated release test harness
```
