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
> **Delivery is NOT complete:** HTTPS deployed Entei origin, Android Chrome
> growing-media progressive playback, audio listening/decode, and a
> Windows installer remain outstanding. The **ED-2C growing-media Range
> contract is PASSED on Windows and Termux loopback (2026-07-31)** —
> measured through real companion binaries (`503 + Retry-After` buffering,
> no fabricated bytes). **Windows Chrome growing-media progressive playback
> was MEASURED on 2026-07-31** (headless Chrome 151: `503` → media `error`
> code 4, no auto-retry, appending alone does not recover, explicit
> `load()`+`play()` gets `206` and plays to the end, post-reload seek
> works) — see
> [Windows Chrome measurement](#measured-in-windows-chrome-2026-07-31-growing-file).
> Android Chrome growing-media playback and yt-dlp/aria2 remain
> **unverified / unimplemented** and are not claimed.
> **The ED-2E buffering bridge is IMPLEMENTED (2026-07-31)** — companion
> `GET/HEAD /v1/media/status` (Origin + token gate, `no-store`, HEAD
> mirror, origin-gated OPTIONS preflight, metadata-only body:
> `state`/`available`/`total`/`headReady`/`retryAfter`; 11 Go tests) plus
> the Entei bridge controller + React hook (single-flight chained poll,
> epoch/AbortController cancellation, `max(Retry-After,1s)`→×2→30s backoff
> with progress reset, bounded failures → disconnected/error, 401/403 →
> re-pair, `complete`-gated explicit `src`/`load()`/`play()` with
> pendingSeek/play-intent preservation, media-error re-check with bounded
> explicit reset; all state page-memory only; 17 web tests) — see
> [ED-2E bridge contract](#ed-2e-buffering-bridge-contract-implemented-status-endpoint--bridge-controller)
> below. Source-dialog UX, buffering UI, `headReady` byte-level detection,
> and headed Windows Chrome / Android Chrome browser QA remain
> unimplemented / unrun.
> **The ED-2F YouTube local source job foundation is IMPLEMENTED
> (2026-07-31)** — `internal/youtube` strict URL validation + `internal/job`
> manager (pinned helper via `--ytdlp`, fixed argv + URL only — never a
> shell, 1080p cap, one active session → 409, cancel/timeout kill the
> process tree, private temp-dir lifecycle, metadata-only redacted
> responses) behind `POST/GET /v1/source/jobs(/{id})(/cancel)` with the
> same Origin + token gates; `/v1/media/status` and `/v1/media/fixture`
> surface the active job without changing the static fixture/grow
> contract. All Go tests green with `go test -race ./...` (fake helper).
> Real yt-dlp download QA, the user-facing YouTube URL input, cookies /
> saved profiles, and the production bridge remain unimplemented / unrun.
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
  - `GET/HEAD /v1/media/status` — metadata-only availability snapshot for
    the configured media source (`state`: `disabled`/`buffering`/
    `complete`/`error`, `available`, `total`, `headReady`, `retryAfter`),
    same Origin + token gate as `/v1/media/fixture`, `Cache-Control:
    no-store`, HEAD mirror, origin-gated OPTIONS preflight; never contains
    paths/filenames/tokens/pairing data (ED-2E; see
    [status endpoint](#statusprogress-endpoint-companion--implemented)).
    Surfaces the active YouTube job (ED-2F) when one exists.
  - `POST /v1/source/jobs` / `GET /v1/source/jobs/{id}` /
    `POST /v1/source/jobs/{id}/cancel` — ED-2F YouTube local-source job
    create/read/cancel (registered only with `--ytdlp`; metadata-only,
    URL redacted; one active session).
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

## ED-2C growing-media Range PoC (contract and Windows Chrome measured)

A media file that is **still growing** (e.g. a download in progress) has a
known final size plus a current available prefix. This PoC establishes the
explicit HTTP contract for that shape **without a downloader**: a
deterministic source abstraction simulates available bytes growing over
time, and the endpoint never fabricates data. It is implemented, tested,
and **measured on both Windows and Termux Android/arm64 loopback through
real companion binaries (2026-07-31)** — see
[measurement record](#measured-on-windows-and-termux-loopback-2026-07-31).
It is **measured in Windows Chrome** (2026-07-31 — see
[Windows Chrome measurement](#measured-in-windows-chrome-2026-07-31-growing-file));
it is **not** measured in Android Chrome yet (see gates below).

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

### Measured in Windows headless Chrome (2026-07-31, growing file)

Browser measurement of real growing-file progressive playback. The probe
page was served from the Entei dev-server origin `http://localhost:4321`
(development-only; the page and its service worker were removed after the
measurement) against the real companion binary on `127.0.0.1:4322`. The
fixture was a valid 4-second H.264/AAC faststart MP4 (161958 bytes total,
124479 bytes initially available = 77%); the video element used
`crossOrigin="anonymous"` with the capability token as a query parameter,
and pairing succeeded from `http://localhost:4321`. Browser: Windows
headless Chrome 151 (UA `HeadlessChrome/151.0.0.0`). Headed Windows Chrome
has not been separately measured.

| Step | Observed |
|---|---|
| `Range: bytes=0-` (fetch probe) | `503` + `Retry-After: 1`, JSON body `available: 124479 / total: 161958` |
| `video.load()` while 77% available | exactly one request (`Range: bytes=0-`) → `503` → `error` code 4 (`MEDIA_ELEMENT_ERROR: Format error`), `networkState` 3 (NETWORK_NO_SOURCE) |
| 30 s no-op observation | **no further requests — Chrome does not auto-retry media `503`s** (the `Retry-After` hint is not honored by the media stack) |
| file completed (tail appended), 12+ s observation | still `error` code 4, no request — **appending alone does not recover the element** |
| `currentTime = 1.5` while errored (duration NaN) | no request, no `seeked` event (the value is stored, nothing is fetched) |
| explicit `video.load()` + `play()` after completion | `206` → `loadedmetadata` (dur 4) → `seeked` → `canplay` → `playing` → played to the end |
| page reload, then seek to 1.5 s (file complete) | `206` → seek succeeded (`seeked`, playback OK) |

**Bridge implication (explicit):** Chrome's media element neither auto-retries
the growing-file `503` nor honors `Retry-After`; it fails once with `error`
code 4 and does not self-recover when the file completes. A production
bridge therefore **cannot rely on Chrome auto-retry**: it must show
buffering while the prefix is unavailable, retry with backoff based on the
`503` body's `available`/`total`, and **explicitly reset `src`/`load()`**
once a playable prefix is available.

All temporary probe pages, servers, binaries, fixtures, and Chrome profiles
were removed after the measurement.

### TOCTOU

`Available()` is snapshotted **once per request**; the served window is
derived from that snapshot and reads never cross it. Sources additionally
enforce the bound in `ReadAt` itself, and availability is monotonic
(append-only contract) — a concurrent writer cannot cause an unavailable
byte to be served. No disk paths appear in error responses or logs.

### Not implemented (PoC boundary)

- No downloader (yt-dlp / aria2 / ffmpeg are not installed, run, or
  called).
- Real-browser progressive playback (`<video>` behavior against a growing
  file) is **measured in Windows Chrome** (2026-07-31 — `503` → `error`
  code 4, no auto-retry, appending alone does not recover, explicit
  `load()`+`play()` gets `206` and plays, post-reload seek works);
  **Android Chrome** growing playback is **not** measured.
- The **production bridge is not implemented** and must not rely on Chrome
  auto-retry: it needs buffering + availability-based retry/backoff and an
  explicit `src`/`load()` reset once a playable prefix exists. The
  contract for that bridge is implemented below (companion status endpoint
  + Entei bridge controller; browser QA still pending).

## ED-2E buffering bridge contract (implemented: status endpoint + bridge controller)

**Implemented on 2026-07-31** — the companion status endpoint
(`internal/api/status.go`, `internal/api/status_test.go`) and the Entei
bridge controller + React hook
(`apps/web/src/features/player/companion-bridge.ts`,
`apps/web/src/features/player/use-companion-bridge.ts`,
`apps/web/tests/companion-bridge.test.ts`) exist and their automated tests
are green (Go 11, web 17). The full record (with the Windows Chrome
measurement evidence) is in
[`docs/EIZOU_DENDENSHI.md`](../../docs/EIZOU_DENDENSHI.md). It defines how
Entei reacts to a growing source safely, given the measured fact that
Chrome's media element does not auto-retry a growing-file `503` (fails once
with `error` code 4; only an explicit `load()`+`play()` recovers).

**Not implemented (intentional scope):** source-dialog UX (the fixture
integration is reachable only through an internal dev/QA entry — user-facing
Magnet/YouTube/source buttons stay non-functional), the `headReady`
byte-level moov check, yt-dlp/aria2, the production bridge/job-source, and
browser QA (headed Windows Chrome / Android Chrome gates below).

**Player fixture integration (implemented):** `useCompanionFixtureSession`
wires the bridge into PlayerApp — the media URL is surfaced only on the
`complete` gate (never while buffering), attached to the existing video
element ref, and the session ends on media switch/unmount; a session-status
banner (buffering progress / error / re-pair) shows only while a fixture
session is active, leaving local files, mining, Anki, and the tracker
untouched. All session state stays page-memory only.

### Status/progress endpoint (companion — implemented)

`GET /v1/media/status?token=<capability token>` — same Origin gate + token
gate as `/v1/media/fixture`. `200` JSON body carries metadata only:

```json
{"state":"buffering","available":124479,"total":161958,"headReady":false,"retryAfter":1}
```

- `state`: `disabled` (no source) / `buffering` (`available < total`) /
  `complete` (`available == total`) / `error` (fail-closed, generic — e.g.
  a static fixture file that cannot be opened).
- `available` / `total`: monotonic availability snapshot (same source as
  the 503 body in `internal/api/growing.go`); growing status never exceeds
  the known total.
- `headReady`: **informational only, never a `src` gate.** Whether the
  faststart MP4 moov + codec init lie fully inside the available prefix
  (byte-level check, no downloader). **Always `false` in the current
  implementation.** Separately, the 77%-available fixture still fails
  (`bytes=0-` → `503` → `error` code 4); for direct `<video>` the only safe
  readiness is `complete`.
- `retryAfter`: same hint as the current 503 responses (PoC `1`; present
  only while buffering).
- `Cache-Control: no-store`; HEAD mirrors GET; OPTIONS preflight
  (GET/HEAD/OPTIONS). Never includes paths, filenames, tokens, or pairing
  data. Token invalid → 401; Origin not allowed → 403 (existing gates).

### Bridge rules (Entei side — implemented)

- **Persistence:** token + session state (state/available/total/pendingSeek/
  phase) are page-memory only. Nothing goes to localStorage / IndexedDB /
  sessionStorage / cookies; a reload means re-pairing (existing contract).
  Bridge state never mixes into the existing persisted prefs
  (volume/playbackRate/layout).
- **Polling:** single in-flight poll (no parallel retries) via chained
  setTimeout + epoch/AbortController supersession (existing PlayerApp
  patterns). Interval = `max(Retry-After, 1s)` with exponential backoff
  (×2, cap 30s), reset to base when `available` advances. Failure/timeout
  caps (constants confirmed in QA) move to `error`.
- **Readiness transition:** only on `state == "complete"`: set `src`
  (token query), `load()`, wait `loadedmetadata`/`canplay`, apply a pending
  seek if any, then `play()` only when the user's intent was play.
- **User intent:** source submit implies play-from-0; pause during
  buffering suppresses auto-play; play during buffering restores it; seek
  during buffering (cue click) becomes a pending seek applied after
  `loadedmetadata`. Controls stay disabled while buffering (existing
  `isLoading || error` guard extended with `buffering`).
- **Disconnect / re-pair:** poll failure → `disconnected`, low-frequency
  retry (e.g. 5 s fixed), recovery → `buffering`; 401/403 → re-pair via the
  existing pairing UI, then the user re-submits the source. Companion death
  stops even playing media (session media lives in the companion process).
- **Boundary:** localhost companion source only. The permanent Streaming
  Video Integration exclusions (browser extension, site DOM, tab capture,
  LAN/public listeners, GoRakuDo proxy, persistent media cache) stay
  intact.

### QA gates (implementation time; not run in this task)

- **Go:** status endpoint unit + httptest (state transitions, secrets-not-
  leaked, HEAD mirror, preflight, 401/403, monotonic availability) added to
  the existing growing tests.
- **Polling:** fake status server tests — backoff sequence, zero parallel
  polls, cancel/epoch supersession, disconnect→re-pair.
- **Windows headed Chrome:** real companion + deterministic growing fixture
  (161958 total / 124479 initial), headed (not headless — unmeasured so
  far), manual-user QA: buffering UI → complete → auto load/play, seek
  intent, disconnect/re-pair, cancel. Any scripted/automated browser QA
  must follow the **PSMUX detached-session rule**: session
  `entei-qa-chrome-<short-id>`, `psmux new-session -d -s <name> -- pwsh
  -NoProfile -File <runner>` (returns immediately), progress via
  `psmux capture-pane -p -t <name>`, then `psmux kill-session -t <name>`
  and verify session absent / temp dir deleted / no leftover PIDs; the
  runner terminates only its own PIDs in try/finally. No persistent
  foreground processes from an agent terminal. Cleanup after: companion PID
  stopped, fixture and temporary Chrome profile removed.
- **Android Chrome:** Termux aarch64 + LAN dev origin
  (`--allow-origin`, development-only) + manual DevTools steps, same
  fixture scenario; parity with Windows (no auto-retry) is expected but
  unmeasured — the bridge design does not depend on it. Cleanup: stop
  companion PID, release wake lock, remove fixture.

### Open decisions

- Whether the PoC companion implements the `headReady` moov byte-level
  check or it arrives with the downloader-backed source.
- Polling constants (1 s base / 30 s cap / failure & elapsed caps) to be
  fixed during implementation QA.
- Whether audio sources (m4a etc.) share the contract (contract is
  media-generic; QA starts with video).
- A future `headReady`-based fast path (e.g. MSE) is unverified under the
  503 contract — out of scope.

## ED-2F YouTube local source jobs (companion foundation, implemented)

A minimal, production-oriented job boundary that will later feed the
already-tested status bridge: a localhost-only, exact-Origin + capability-
token-gated API to create / read / cancel a single YouTube download job.
**No GoRakuDo proxy, no browser/site integration, no cookies, no
yt-dlp/aria2 download QA in this phase.** The user-facing YouTube URL input
in Entei is intentionally NOT wired yet.

### Endpoints (registered only when `--ytdlp` is configured)

```
POST /v1/source/jobs                 — create a job; body {"url": "…"}
GET  /v1/source/jobs/{id}            — read a job's redacted state
POST /v1/source/jobs/{id}/cancel     — cancel and free the session
```

- Same gates as `/v1/media/*`: exact allowed Origin (missing/disallowed →
  403 without CORS headers) + capability token (missing/invalid → 401).
- One active session only: creating a second job → **409 conflict**. A
  terminal job (error/complete) stays current until explicitly cancelled —
  the failed session is observable via status and is freed only by cancel.
- Responses are **metadata-only**: `{id, state, error?, media:{available,
  total, headReady}}`. The URL, local paths, the helper command line, raw
  helper stderr, and any credential are never in responses or logs. Job
  ids are opaque random hex.

### Job state machine → status mapping

`queued → downloading → buffering → complete`, terminal `error` /
`cancelled`. `/v1/media/status` surfaces the active job: queued /
downloading / buffering → `buffering` (available = current bytes on disk,
total = 0 until the helper finishes); complete → `complete` (available =
total); error → `error`; cancelled → falls through to the configured
source (typically `disabled`). `/v1/media/fixture` serves the completed
job's media with the growing contract (200/206) and returns 503 buffering
while the job is downloading, or a generic 404 when the job errored.

### Helper contract

- Pinned via `--ytdlp <path>` (validated at startup); never derived from a
  request. Without the flag the job endpoints are honestly unregistered.
- Spawned with `exec.Command` and a **fixed argument vector** — the
  validated URL is the only user-derived value and is passed as its own
  final argv element. **No shell is ever involved.**
- Fixed deterministic policy: 1080p cap (`bv*[height<=1080]+ba/b[height
  <=1080]/b`), `--no-playlist`, direct output into the job's private temp
  dir. No quality selector, no user options.
- URL validation accepts only exact https YouTube host forms
  (`youtube.com` / `www` / `m` / `music` / `youtu.be`) with strict
  11-char video-id rules; everything else is rejected before spawn.
- Per-job timeout (`--job-timeout`, default 30m) and cancellation kill the
  helper process tree (process group / `taskkill /T`); the job is reaped
  (no zombies). All job files live in a private `entei-job-*` temp dir,
  removed on cancel/failure; a completed session keeps its media until the
  session is cancelled. User files are never touched.

### Subtitles boundary

**Not implemented in this phase.** No subtitle flags are passed; subtitle
availability is not queried. Querying/recording availability without a
user cookie, and any Japanese-subtitle selection, are deferred (they would
require parsing helper metadata output — a separate, safe/deterministic
step — and must be re-reviewed before being enabled).

### Tests

`internal/youtube` (URL validation), `internal/job` (manager: fixed-args no
injection, one-active conflict, cancel/cleanup with no zombie, timeout,
error redaction, growing-then-complete mapping, Close), `internal/api`
(jobs endpoints: gates, redaction, conflict, read/cancel, status/fixture
mapping) — all against a deterministic **fake helper executable** (no
network, no real yt-dlp). Run with `go test -race ./...`.

### Real-download QA record (2026-08-01, PSMUX detached session)

**Helper update (authorized, Python 3.11 only):** `python311 -m pip install
--upgrade yt-dlp` moved `2025.03.31 → 2026.07.04` (nothing else touched).
**The real-download QA then fully passed** against a short public test video:
job accepted (201), state `downloading → complete` with `available == total`
(474489 B), the fixed helper argv policy confirmed live (1080p-cap selector,
`--no-playlist`, URL as the final argv element, no shell — parent chain
`eizouden → wrapper → python`), `/v1/media/status` complete, `/v1/media/fixture`
**200 (474489 real bytes) and Range 206** (head + mid ranges), ffprobe of the
produced media (**AV1 320×240 + Opus, 19.028s** — the ffmpeg merge worked),
and **Chrome playback of the fixture-served media** (loadedmetadata/canplay/
playing, currentTime advancing, no error). Cancel verified for both a
completed job and a mid-download job: 200, session freed, GET-after 404,
**zero orphan helpers/ffmpeg**, job dir removed. Redaction sweep: zero
URL/token/path/stderr leaks. **A second real race was found and fixed**: a
mid-download cancel could leak the job dir because the dying helper tree
still held open media handles when `os.RemoveAll` ran — all cleanup paths
now use a bounded-retry removal (`removeAllBestEffort`, 5s), and the fake
helper's hold mode was strengthened to keep a media handle open with
regression tests (`TestNoJobTempDirLeakOnError`/`TestNoJobTempDirLeakOnCancel`).
Remaining gates: cookies/saved profiles, subtitles, Android/headed-Windows browser QA, and the production bridge connection.

### User-facing YouTube URL flow (implemented)

The YouTube entrance is now a real controlled dialog (URL input + submit)
gated on pairing: unpaired shows a pairing-needed notice with no input;
paired submits `POST /v1/source/jobs?token=…` (Origin/CORS natural),
surfaces generic localized errors (invalid / re-pair needed / one-active-job
conflict / companion unavailable), and on acceptance starts the existing
bridge session (`useCompanionJobSession`) which polls the job status and
loads the media only on `complete`. The banner's End button and media
switch cancel the job via `POST /v1/source/jobs/{id}/cancel` and end the
session. URL + token stay page-memory only (no storage/logs/URL
persistence); the raw URL is never shown — a generic localized session
label is used. `companion-fixture-entry.ts` (the test-only internal start
path) was removed.

### Common CLI + Termux helper bootstrap (implemented; device gates pending)

- **`eizouden cli`** (Go, common): two-option menu (`1. Get New Pairing
  Code` / `2. Service Status`) with an ANSI-colored version header only on
  a real terminal (plain otherwise); option 1 reuses the existing
  foreground server path (fresh pairing code, Ctrl+C stops); option 2
  reports core/yt-dlp/aria2/ffmpeg installed/version/readiness only —
  never paths, cookies, tokens, URLs, or job data. Invalid input
  re-prompts; EOF exits.
- **Windows launcher**: the bootstrap installs a user-private `eizouden.cmd`
  invoking the core's CLI mode with the exact private helper paths (no
  global PATH mutation).
- **Manifest helper contract v3**: the Windows artifact helpers map plus a
  compiled-in fixed Termux package map (`python-yt-dlp`/`aria2`/`ffmpeg`,
  minimum versions manifest-controlled). The Windows bootstrap accepts v2
  and v3; the helper-enabled Termux bootstrap
  (`termux-bootstrap-helper.sh`, emitted as `eizouden-bootstrap-helper.sh`)
  requires exactly v3, installs missing helpers only through the official
  Termux pkg repo, verifies executable commands + minimum versions before
  the signed core install, installs an app-private `eizouden` launcher at
  `$PREFIX/bin`, and launches the CLI. The v1 core-only Termux bootstrap is
  unchanged and remains backward compatible.
- **Status**: harness-verified (Termux 90/90, Windows 83/83, Go `-race`
  green). **Not verified**: the real Termux clean install + helper CLI gate
  on a device, and the Windows real-machine CLI/launcher manual gate.


### Progressive streaming fixes (rc.12 issues; implemented)

- **Kind-aware session label**: the companion session banner now shows the
  localized source kind (YouTube vs Torrent) — never a mislabeled
  "YouTube download" for a torrent.
- **Extension-governed MIME**: the selected file's extension sets the
  Content-Type on BOTH the progressive and completed media serves
  (ideo/mp4, ideo/webm, ideo/ogg, ideo/x-matroska for MKV) —
  no hardcoded ideo/mp4.
- **Structural safe-early predicate**: playable now requires a bounded
  structural parse of the VERIFIED prefix — MP4/ISO-BMFF needs complete
  ftyp+moov, a browser-decodeable stsd video codec (avc1/avc3/vp09/av01;
  hvc1/hev1 and unknown rejected) and a verified sample boundary;
  **Matroska/MKV is now ALSO eligible for early handoff** when the verified
  prefix contains the EBML header + Segment with a complete Tracks element
  proving a browser-decodeable video TrackEntry (V_MPEG4/ISO/AVC, V_VP9,
  V_AV1; HEVC/unknown/audio-only rejected) and a complete first Cluster
  whose video SimpleBlock/Block payload lies fully inside the verified
  prefix — the user-reported MKV audio-with-black-video case is addressed
  by only handing off when the video track structure is proven. No fixed
  byte threshold; malformed VINT/unknown-size/partial elements keep the
  job buffering honestly; complete MKV always serves with
  ideo/x-matroska; no arbitrary-MKV or random-seek claim.
- **Stream-not-ready copy**: for an active companion session, a generic
  media element error surfaces a localized "stream is not ready yet —
  waiting for more data" message unless the job is terminally errored; the
  bridge re-checks the status and re-applies the explicit src/load once
  the required verified prefix exists (bounded).

No promise is tied to "1 second": the earliest handoff is the first
verified prefix meeting the decoder-safe structure. Real browser/swarm
E2E (prefix-206 playback, MKV early-start limits) remains unmeasured.
### Remaining gates (not claimed)

Cookie / saved-profile handling, subtitles, Android/headed-Windows browser
QA, and the production bridge connection.

## ED-2G aria2 torrent job foundation (companion backend, implemented)

A production-oriented aria2 local-torrent job boundary that later shares
the existing status/media bridge. **No GoRakuDo proxy, no browser
WebTorrent, no extension/site integration, no LAN/public bind.**

### Endpoints (registered only when `--aria2` is configured)

```
POST /v1/source/torrents             — create; body {"magnet": "…"}
GET  /v1/source/torrents/{id}        — read redacted state
POST /v1/source/torrents/{id}/cancel — cancel + free the session
GET  /v1/source/torrents/{id}/files  — sanitized file listing (after download)
POST /v1/source/torrents/{id}/select — one video + optional subtitle
```

- Same exact-Origin + capability-token gates; OPTIONS preflight; `no-store`.
- **One active session across BOTH job kinds** (YouTube + torrent): creating
  a second while either is active → 409. A terminal (error/complete) job
  stays current until cancelled.
- Responses are **metadata-only**: opaque job ids, `state`, generic errors,
  and sanitized file metadata (`id`/`basename`/`extension`/`byteSize`/`kind`)
  — never absolute paths, the magnet, trackers, or raw aria2 stderr.

### Magnet validation

Only `magnet:?xt=urn:btih:` infohash magnets are accepted (40-hex or
32-base32), canonicalized to deterministic 40-lowercase-hex. **Safe `tr=`
announce trackers are preserved** (see the tracker policy below); `dn`, `xl`,
webseeds, and every other parameter are deliberately dropped. Everything
else — arbitrary URLs, file paths, malformed magnets — is rejected before
any spawn, and errors never echo the magnet or tracker data.

### Tracker policy (ED-2G, implemented 2026-08-02)

- At most **5** announce URLs are preserved; each must be at most 512 chars
  and match all of: scheme `udp`/`http`/`https` only; no userinfo, fragment,
  or raw path tricks; **hostname required** (any IP literal — public/private,
  v4/v6 — and `localhost` are rejected, covering loopback/unspecified/
  link-local); explicit ports must be 1–65535; pure ASCII with no whitespace/
  control characters; path empty or starting with `/` with no backslashes.
- **If ANY supplied tracker is unsafe the whole magnet is rejected** — unsafe
  trackers are never silently dropped (visible, fail-closed contract).
  Validation never performs DNS resolution.
- Canonical trackers are normalized (lowercase scheme/host), deduplicated,
  and emitted in deterministic sorted order as repeated `tr=` params; the
  whole canonical magnet (xt + trackers) stays **one final argv element** to
  aria2; the fixed args and no-shell contract are unchanged.
- `http` is allowed with a documented tradeoff: plaintext announce exposes
  the infohash and the user's IP to the tracker operator and on-path
  observers. Tracker data never appears in API snapshots, errors, logs, or
  docs output.
- **Privacy:** a tracker is a third-party endpoint. Once a torrent job
  actually runs, the user's IP is exposed to the tracker(s) and to torrent
  peers (PEX/DHT), and the tracker learns the infohash; the rest of the
  companion remains local-only. User consent for this exposure is a future
  UI phase.

### Helper contract

- Pinned via `--aria2 <path>` (validated at startup); never request-derived.
- Fixed safe argv: `--dir=<private job dir> --seed-time=0 --enable-rpc=false
  --check-integrity=true --summary-interval=0 --console-log-level=error
  --allow-overwrite=true --auto-file-renaming=false` + the canonicalized
  magnet as the final separate argv element. **No shell.**
- `--seed-time=0`: download only, never seed. Original source bytes only (no
  remux/transcode). All files stay in the private `entei-torrent-*` temp
  dir; cancellation/failure/session end kills the aria2 process tree and
  removes only owned job files — user files are never touched.

### File listing → selection → media bridge

After the download completes, the job lists + classifies the torrent files
against the Entei Player's native allowlists (video: mp4/webm/ogv/ogg/mkv/
m4v/avi; audio: mp3/wav/flac/aac/m4a/opus/m4b; subtitle: srt/vtt/ass only —
no PGS/XML). **If no eligible video exists, the job fails with a terminal
generic error.** `GET …/files` exposes the sanitized listing; `POST
…/select` enforces the **one video + one optional subtitle** contract and,
on success, makes the selected (fully downloaded) video the servable media.
**Nothing is served before a valid selection** — `/v1/media/status` reports
`buffering` (fixture 503) until then, then `complete` with
`available==total` and the fixture serving the selected file (206 Range).
Forward/growing playback during download is a documented **future testing
direction**; the initial scope is the complete-only gate matching the direct
video bridge.

### Tests

`internal/torrent` (magnet validation; manager: fixed argv/no injection,
one-active conflict, file-listing sanitization, selection restrictions /
no-eligible-video error, redaction, cancel/timeout/process cleanup + no
temp-dir leak) and `internal/api` (torrent endpoints: gates, redaction,
create/read/files/select/cancel, status/fixture mapping before/after
selection, **cross-job-kind conflict**, preflight) — all against a
deterministic fake aria2 helper (no swarm/network). `go test -race ./...`
green.


### Progressive streaming fixes (rc.12 issues; implemented)

- **Kind-aware session label**: the companion session banner now shows the
  localized source kind (YouTube vs Torrent) — never a mislabeled
  "YouTube download" for a torrent.
- **Extension-governed MIME**: the selected file's extension sets the
  Content-Type on BOTH the progressive and completed media serves
  (ideo/mp4, ideo/webm, ideo/ogg, ideo/x-matroska for MKV) —
  no hardcoded ideo/mp4.
- **Structural safe-early predicate**: playable now requires a bounded
  structural parse of the VERIFIED prefix — MP4/ISO-BMFF needs complete
  ftyp+moov, a browser-decodeable stsd video codec (avc1/avc3/vp09/av01;
  hvc1/hev1 and unknown rejected) and a verified sample boundary;
  **Matroska/MKV is now ALSO eligible for early handoff** when the verified
  prefix contains the EBML header + Segment with a complete Tracks element
  proving a browser-decodeable video TrackEntry (V_MPEG4/ISO/AVC, V_VP9,
  V_AV1; HEVC/unknown/audio-only rejected) and a complete first Cluster
  whose video SimpleBlock/Block payload lies fully inside the verified
  prefix — the user-reported MKV audio-with-black-video case is addressed
  by only handing off when the video track structure is proven. No fixed
  byte threshold; malformed VINT/unknown-size/partial elements keep the
  job buffering honestly; complete MKV always serves with
  ideo/x-matroska; no arbitrary-MKV or random-seek claim.
- **Stream-not-ready copy**: for an active companion session, a generic
  media element error surfaces a localized "stream is not ready yet —
  waiting for more data" message unless the job is terminally errored; the
  bridge re-checks the status and re-applies the explicit src/load once
  the required verified prefix exists (bounded).

No promise is tied to "1 second": the earliest handoff is the first
verified prefix meeting the decoder-safe structure. Real browser/swarm
E2E (prefix-206 playback, MKV early-start limits) remains unmeasured.
### Remaining gates (not claimed)

Real swarm/network download QA (PSMUX detached session only when later),
the user-facing torrent selection UI, forward/growing playback during
download, and Android/headed-Windows browser QA.

## ED-2D Windows x64 helper-enabled release + bootstrap (implemented)

A general Windows user runs one signed bootstrap that checks / downloads /
verifies / installs the Eizou core **and** its required helper artifacts
(yt-dlp, aria2, ffmpeg) into user-private storage.

### Release manifest evolution (canonical, signed, fail-closed)

- **v1 core-only contract is byte-for-byte unchanged** when no helper inputs
  are given — the Termux bootstrap still only accepts exactly
  `{"version":1,"minimumVersions":{}}` and refuses anything else (Termux
  stays helper-none). The Termux harness is still **66/66 green**.
- **v2 Windows helper contract** (only when `-HelpersFile` is passed):
  `helperContract.version = 2` with a `helpers` map declaring
  `{required, version, artifact[, archive, expectedFile]}` for `yt-dlp` /
  `aria2` / `ffmpeg`, plus one `artifacts` entry (target `windows/amd64`,
  `sha256`) per helper artifact. The Windows bootstrap only accepts version 2;
  a v1 core-only release is refused there (fails closed).
- **Artifact sourcing is explicit local input only**: `-HelpersFile` is a JSON
  file of explicit local artifact paths + target/name/version metadata. The
  release tool NEVER downloads vendor code; it validates (safe artifact
  names, non-empty files, versions, duplicate/unknown keys), copies, hashes,
  and Minisign-signs each helper artifact. End users fetch only from the
  signed Eizou release base.

### `scripts/windows-bootstrap.ps1` (new template)

- HTTPS-only release base URL (validated before any download; bounded
  HTTPS-only redirects/timeouts); pinned Minisign key placeholder fails
  closed; Windows x64 environment check; minisign is a required verifier
  prerequisite (no system-wide install).
- User-private install root `$env:LOCALAPPDATA\GoRakuDo\EizouDendenshi`
  (ACL restricted to the current user; atomic staging + replace).
- Per-artifact verification **before any replacement**: fetch artifact +
  detached `.minisig` → Minisign verify → SHA-256 against the signed
  manifest. Archives are extracted only after verification and only the exact
  expected filename is taken. Verified installs are reused by
  version+hash state (`helpers-state.json`); anything else (version mismatch,
  missing, tampered) is atomically replaced.
- The core is launched with explicit absolute `--ytdlp` / `--aria2` paths;
  ffmpeg reaches yt-dlp through a **process-scoped** PATH (prepending the
  private helpers dir — never a persistent system PATH change). No
  `Invoke-Expression` / remote script execution, no winget/choco/Python, no
  system PATH mutation.
- Unsafe artifact names, unknown/duplicate helper keys, wrong target, missing
  entries, and contract/version mismatches all fail closed before install;
  error output never reveals sensitive local paths or URLs (only safe
  artifact logical names).

### `scripts/test-windows-bootstrap.ps1` (new harness) — **51/51 green**

Synthetic helper-enabled Windows release (temporary fake helper executables
+ archives, temp Minisign key under `A:\Temp\opencode`, mirror-based
fetching): success install with absolute helper paths; verified-install
reuse; missing-helper auto-fetch; tampered manifest / helper artifact /
archive / missing signature / SHA mismatch all fail **before** replacement;
non-HTTPS URL and unpinned key fail closed; helper version mismatch triggers
replacement; unsafe artifact names / unknown helper keys / v1 contract
refused; no system PATH mutation; private temp cleanup.

### First-run verifier trust bootstrap (implemented)

A general Windows user with **no preinstalled minisign** can run the
published bootstrap: before any Eizou release artifact is downloaded, it
acquires ONLY the verifier safely:

- **Pinned source** (official jedisct1/minisign, hash-anchored):
  `https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip`
  SHA-256 `37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479`,
  member `minisign-win64/x86_64/minisign.exe`, expected version `0.12`.
- An already-present verifier is reused only if it is **explicitly supplied**
  (`-MinisignExe`, version-checked) or lives inside the Eizou private root
  and still matches its recorded SHA-256 + the version contract. **An
  arbitrary PATH executable is never trusted.**
- Otherwise the pinned ZIP is fetched (HTTPS-only bounded redirects /
  timeouts; harness-only local-mirror override), its SHA-256 verified
  **before** extraction, the exact expected member extracted, the version
  checked, and the verifier atomically installed into the private root
  (`tools\minisign.exe` + a verifier state file). No global install, no
  persistent PATH mutation, no unsigned fallback; failures at URL/hash /
  archive/version fail closed before any core/helper replacement, with
  errors containing only safe logical tool/artifact names.
- **rc.4 did not have this first-run verifier auto-setup** (it required a
  preinstalled minisign). **rc.5 was the first release carrying it, and its
  clean Windows gate FAILED** against the published `eizoudendenshi-v0.2.0-rc.5`
  bootstrap: on a genuine first run (no `EIZOU_WIN_MINISIGN_MIRROR` env),
  PowerShell's `$env:X -ne ''` is `$true` for an undefined `$null` variable,
  so the unguarded `Test-Path -LiteralPath $env:EIZOU_WIN_MINISIGN_MIRROR`
  threw a binding error at line 135 before any verifier acquisition (the
  harness always set the mirror env, so 70/70 did not cover it). The minimal
  fix (explicit `$null` guard before `Test-Path`) + a static regression
  check are applied in the repo; the harness is now **71/71**. The clean
  Windows gate must be re-run against a **fixed re-release (rc.6+)** — it is
  not claimed on rc.5.
- **Known design note (fixed for rc.6, not in rc.5):** archive helpers are
  extracted and now installed under their **strict runtime filename**
  (`aria2c.exe` / `ffmpeg.exe`) in the private `helpers\` runtime directory
  (the release artifact keeps its logical archive name for download/verify;
  `helpers-state.json` maps artifact/version/SHA → runtime name + runtime
  SHA; the core always receives the exact absolute runtime paths
  `--ytdlp <…>\yt-dlp-windows-amd64.exe` and `--aria2 <…>\aria2c.exe`, and
  the process-scoped PATH prepends the runtime dir that literally contains
  `ffmpeg.exe` for yt-dlp merge discovery). Malformed/legacy (rc.5
  archive-name) state is detected and replaced, never reused.
- **Second real bug found while building rc.6 (also fixed):** with
  `-OutFile`, `Invoke-WebRequest` returns `$null` in PowerShell 7, so the
  HTTPS-only redirect check after a production (no-mirror) download saw no
  response and every real fetch failed; the fetches now use `-PassThru`.
  The Windows harness is **81/81** including a true unset-env regression
  case (the real pinned official verifier fetch) and a deterministic
  download-unavailable case.
- **rc.6 is planned with these fixes; the clean real Windows gate is NOT
  claimed until a fixed re-release is gate-tested.**
- **rc.6 clean Windows gate: PASSED (measured 2026-08-02).** Against the
  published immutable `eizoudendenshi-v0.2.0-rc.6` GitHub assets (no local
  mirror, no preinstalled minisign on PATH, no mirror env, fresh private
  root): the true first run downloaded the official pinned verifier
  (Minisign 0.12), verified and private-installed manifest + core + all
  three helpers, and started the core with absolute runtime helper paths;
  installed versions matched the manifest contract (yt-dlp 2026.07.04,
  aria2 1.37.0, ffmpeg `2026-07-27-git-a757b708ae-essentials_build-www.gyan.dev`);
  helpers physically carry their runtime names (`aria2c.exe`, `ffmpeg.exe`;
  no archive-name executables at the root); a second invocation on the same
  root reused the verifier and helpers with no re-acquisition; no
  persistent PATH / global install changes; full cleanup verified.
- **Real ED-2G swarm QA (2026-08-02): blocked by peer/metadata timeout —
  NOT worked around.** Using the rc.6 bootstrap-installed private aria2
  (1.37.0; fixed argv verified live: `--seed-time=0 --enable-rpc=false
  --check-integrity=true --summary-interval=0 --console-log-level=error
  --allow-overwrite=true --auto-file-renaming=false
  --content-disposition-default-utf8=true` + the magnet as the final
  separate argv element, no shell), the authenticated torrent API accepted
  jobs (201) and reached `queued → downloading` for two safe public swarms
  (an archive.org public-domain film torrent and the official Debian
  netinst torrent — source class only), but **no bytes downloaded within
  the bounded windows (5–5.5 min each)** — at that time the canonical
  magnet carried no trackers (the ED-2G canonicalization stripped them by
  design), and neither swarm was reachable via DHT/PEX from this network —
  the documented peer/metadata-timeout failure class. The files/selection/complete/Range
  gates were therefore not reachable (not claimed); cancellation +
  cleanup were verified live (job dirs 0, aria2/core processes 0, session
  freed, temp root deleted, 4322 free).
- **Tracker-enabled real swarm QA (2026-08-02): peer/metadata timeout with
  a minimal swarm.** A safe tracker-bearing magnet (Big Buck Bunny, Blender
  Foundation CC-BY, 10-second 1080p clip on archive.org; two http trackers
  `bt1`/`bt2.archive.org:6969`) was accepted (201); the canonical magnet
  carried the preserved trackers as the final argv element, and aria2
  announced successfully (tracker HTTP 200, `Complete: 1` seeder) — but the
  single peer connection dropped without transferring metadata, so **0
  bytes** within the bounded window (the documented peer/metadata-timeout
  class; not worked around). A real minor defect was found and fixed: the
  fixed aria2 argv now sets `--dht-file-path=<job dir>/dht.dat` so the
  helper never writes a DHT cache into the user's home directory.
  Files/selection/complete/Range/playback gates remain unmeasured; the
  MKV sourcing plan (public-domain/official) is documented and untested.
- **Magnet UI implemented (ED-2G, React Player):** the Magnet button now opens
  a real torrent source dialog — pairing-gated (unpaired = pairing-needed
  only), required memory-only tracker-consent checkbox (IP exposure note),
  magnet create (POST /v1/source/torrents), redacted status polling,
  sanitized file listing with one-video + optional-subtitle selection
  (srt/vtt/ass only), selection submit, and job cancel on close/unmount.
  The bridge session was generalized with a source kind (youtube/torrent)
  routing the cancel endpoint. **Final E2E including real playback has NOT
  been run.**

### QA status

**PASS:** Torrent companion QA is accepted at this stage. The remaining
end-to-end verification is deferred and will cover the user-facing
Magnet/selection UI, forward/growing playback during download, and
Android/headed-Windows browser behavior together.

## Deferred boundaries (out of scope through ED-2B)

- yt-dlp / YouTube source handling
- aria2 / torrent / BitTorrent download engine
- Cookie storage and transmission
- Growing-media capture / real media URL plumbing (the ED-2C growing source
  is a no-downloader contract PoC — see
  [growing-media PoC](#ed-2c-growing-media-range-poc-contract-and-windows-chrome-measured);
  loopback + Windows Chrome PASSED 2026-07-31; no real downloader, no
  Android Chrome measurement, and no Entei-side integration)
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
  and a **Windows Chrome measurement PASS (2026-07-31 — see
  [Windows Chrome measurement](#measured-in-windows-chrome-2026-07-31-growing-file))**;
  **Android Chrome growing playback is not browser-measured**.
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

Android Chrome from `https://entei.gorakudo.org`, Android Chrome
growing-media progressive playback, and audio listening/decode remain
separate gates; Minisign
delivery itself is now proven on the Termux path (ED-2D Stage B,
2026-07-31). The growing-media Range **contract PASSED the Termux loopback
measurement on 2026-07-31** (see
[measurement record](#measured-on-windows-and-termux-loopback-2026-07-31));
**Windows Chrome** growing progressive playback was measured on 2026-07-31
(see
[Windows Chrome measurement](#measured-in-windows-chrome-2026-07-31-growing-file)),
while **Android Chrome** growing playback and the production bridge remain
unverified.

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

This verifies Android Chrome only for the temporary HTTP LAN dev origin
(static fixture). HTTPS
deployed Entei origin, Android Chrome growing-media progressive playback,
audio
listening/decode remain separate gates; Minisign delivery is proven on the
Termux path only (ED-2D Stage B, 2026-07-31). The growing-media Range
**contract PASSED the loopback measurements on 2026-07-31** (see
[measurement record](#measured-on-windows-and-termux-loopback-2026-07-31));
growing media is browser-measured **only in Windows Chrome** (2026-07-31 —
see
[Windows Chrome measurement](#measured-in-windows-chrome-2026-07-31-growing-file)),
not in Android Chrome.

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
origin, Android Chrome growing-media progressive playback, audio
listening/decode, and the Windows installer** (Windows Chrome growing-media
progressive playback was measured 2026-07-31 — see
[Windows Chrome measurement](#measured-in-windows-chrome-2026-07-31-growing-file)).

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
# Contract PoC — browser-measured in Windows Chrome (2026-07-31); Android
# Chrome and the bridge are not (see below).
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
[measurement record](#measured-on-windows-and-termux-loopback-2026-07-31)).
Windows Chrome growing-media progressive playback was **measured on
2026-07-31** (see
[Windows Chrome measurement](#measured-in-windows-chrome-2026-07-31-growing-file));
Android Chrome media behavior, the HTTPS deployed Entei origin, the bridge
implementation, audio listening/decode, and the Windows
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
