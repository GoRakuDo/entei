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
> (`--allow-origin`) implemented. This is **not** a media server and is
> **not** integrated with Entei. A **manual Windows Chrome static-fixture
> verification was performed on 2026-07-31** (see
> [ED-2B verification](#ed-2b-verification-manual-windows-chrome)); it is a
> manual browser check, **not** an automated Go test. Termux runtime smoke is
> also complete (see [ED-2C verification](#ed-2c-verification-termux-runtime)).
> Android Chrome LAN-origin browser QA is also complete (see
> [ED-2C verification](#ed-2c-verification-android-chrome-lan-origin)). HTTPS
> deployed Entei origin, growing media, audio listening/decode, and Minisign
> delivery remain outstanding gates.

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

## Deferred boundaries (out of scope through ED-2B)

- yt-dlp / YouTube source handling
- aria2 / torrent / BitTorrent download engine
- Cookie storage and transmission
- Growing-media capture / real media URL plumbing (only a static fixture is
  served; there is no growing file, no Entei-side integration)
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
  Range behavior is ED-2C+ work.
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

Android Chrome from `https://entei.gorakudo.org`, growing media, and Minisign
delivery remain separate gates.

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
deployed Entei origin, growing media, audio listening/decode, and Minisign
delivery remain separate gates.

## Planned general-user Termux setup (ED-2D)

General users install the Termux APK once, then run one documented bootstrap
command. They do **not** install Go: the bootstrap downloads the signed
`android/arm64` Eizou core binary.

The bootstrap will install `curl` and `minisign` from the official Termux
repository, verify a release manifest and core asset using a public key pinned
in the copied command, then install the verified core into Termux app-private
storage and start it for pairing.

Future source helpers are automatic too: `python-yt-dlp`, `aria2`, and `ffmpeg`
will be installed from the official Termux repository and checked against
minimum compatible versions. They are deliberately not frozen release assets;
the Minisign-fixed Eizou core remains the compatibility control point.

Android permission prompts cannot be silently bypassed. The bootstrap can ask
for `termux-wake-lock`, but the user must approve wake-lock / unrestricted
battery behavior in Android when prompted.

The bootstrap must not use an unverified `curl | sh` remote script. It will be
distributed as a short copy-paste command containing the pinned Minisign public
key; only verified release files run after the verifier is installed.

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

The capability token is never printed or logged; it is returned once by
`POST /v1/pair` and kept in process memory.

## Test / cross-compile

```sh
gofmt -l .        # formatting check (must print nothing)
go test ./...     # unit + httptest API tests (ED-2A + ED-2B media suite + ED-2C origin override)
go vet ./...      # static checks

CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o ed2b-win-amd64.exe ./cmd/eizouden
CGO_ENABLED=0 GOOS=android GOARCH=arm64 go build -o ed2b-android-arm64  ./cmd/eizouden
```

ED-2A cross-builds `windows/amd64` and `android/arm64`. ED-2C verified the
pure-Go `android/arm64` binary's Termux loopback runtime; Android Chrome media
behavior remains a later checkpoint.

## Layout

```
cmd/eizouden/        executable: flags, loopback guard, bootstrap, handoff
internal/api/        HTTP API: /v1/health, /v1/pair, /v1/media/fixture, CORS
internal/pairing/    crypto/rand pairing code + capability token
```
