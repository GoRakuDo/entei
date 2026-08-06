/**
 * ED-2E companion buffering bridge — page-memory source-session controller.
 * ---------------------------------------------------------------------------
 * Reacts to a growing localhost-companion source safely, per the committed
 * ED-2E design (docs/EIZOU_DENDENSHI.md, commit e38afdc). It polls the
 * companion's `/v1/media/status` endpoint, never assigns a still-growing URL
 * to a media element, and only hands the token-query media URL to the
 * element once the source reports `complete` — because Windows Chrome does
 * not auto-retry a growing-file `503` (fails once with `error` code 4; the
 * only recovery is an explicit `src`/`load()` reset once the file is
 * playable, which is `complete` for the direct-URL contract).
 *
 * Rules implemented:
 * - Single-flight chained status poll (setTimeout chain, no setInterval),
 *   epoch + AbortController supersession; source switch / unmount / cancel
 *   abort everything.
 * - Poll interval starts at max(Retry-After, base), exponential ×2, capped
 *   at maxPollMs; resets to base when `available` advances.
 * - Bounded failures: transient non-2xx failures → `error`; transport
 *   failures → `disconnected` with fixed-interval retries → `error` after a
 *   bounded number of polls or the total-wait cap.
 * - 401/403 → `rePairRequired` (terminal; re-pairing is a user action, not
 *   a retry).
 * - `complete` → explicit `src` assignment + `load()`, wait for
 *   metadata/canplay, apply the latest pending seek, then `play()` only if
 *   the user's intent was play.
 * - Media error after ready/playing re-checks status once: `complete` →
 *   explicit reset (bounded), `buffering` → back to buffering, 401/403 →
 *   re-pair.
 *
 * Privacy: every piece of state lives in page memory inside this object.
 * Nothing is written to localStorage, IndexedDB, sessionStorage, cookies,
 * URLs beyond the media element's own `src`, or any log.
 * ---------------------------------------------------------------------------
 */

export type CompanionBridgePhase =
  | 'idle'
  | 'buffering'
  | 'ready'
  | 'playing'
  | 'error'
  | 'disconnected'
  | 'rePairRequired';

/** Availability progress carried by buffering/ready phase updates. */
export interface CompanionBridgeProgress {
  available: number;
  total: number;
}

/** Extra per-phase info: latest progress snapshot and a generic reason. */
export interface CompanionBridgePhaseInfo {
  progress: CompanionBridgeProgress | null;
  reason: string | null;
}

/** Parsed body of `GET /v1/media/status`. */
export interface CompanionBridgeStatus {
  state: 'disabled' | 'buffering' | 'playable' | 'complete' | 'error';
  available: number;
  total: number;
  headReady: boolean;
  retryAfter?: number;
  /** Stable error code for frontend routing (e.g. "torrent_concurrency_limit"). */
  errorCode?: string;
}

/** Loopback companion connection: base URL + pairing capability token. */
export interface CompanionBridgeSource {
  /** e.g. "http://127.0.0.1:4322" — localhost companion only. */
  baseUrl: string;
  /** Capability token from pairing. The bridge holds it in memory only;
   *  persistence is the pairing controller's opaque localStorage
   *  envelope (see companion-pairing-store). */
  token: string;
}

/** Minimal media-element surface the bridge drives for the ready
 *  transition: src assignment → load → metadata/canplay → seek → play. */
export interface CompanionBridgeMedia {
  setSrc(url: string): void;
  load(): void;
  play(): Promise<void>;
  seekTo(seconds: number): void;
  currentTime(): number | undefined;
  onLoadedMetadata(cb: () => void): () => void;
  onCanPlay(cb: () => void): () => void;
  onSeeked(cb: () => void): () => void;
  onPlaying(cb: () => void): () => void;
  onError(cb: () => void): () => void;
}

export interface CompanionBridgeOptions {
  /** Injectable fetch; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Base poll interval (also the floor for Retry-After). */
  basePollMs?: number;
  /** Exponential backoff cap. */
  maxPollMs?: number;
  /** Fixed retry interval while disconnected. */
  disconnectedPollMs?: number;
  /** Per-request abort timeout. */
  requestTimeoutMs?: number;
  /** Consecutive transient (non-2xx) failures before `error`. */
  maxTransientFailures?: number;
  /** Disconnected polls before `error`. */
  maxDisconnectedPolls?: number;
  /** Total buffering wall-clock cap before `error`. */
  totalWaitMs?: number;
  /** How long to wait for the `seeked` event after a pending seek. */
  seekWaitMs?: number;
  /** Explicit media resets after ready before giving up on media errors. */
  maxMediaResets?: number;
}

export interface CompanionBridgeCallbacks {
  onPhaseChange(
    phase: CompanionBridgePhase,
    info: CompanionBridgePhaseInfo,
  ): void;
}

export const BRIDGE_BASE_POLL_MS = 1_000;
export const BRIDGE_MAX_POLL_MS = 30_000;
export const BRIDGE_DISCONNECTED_POLL_MS = 5_000;
export const BRIDGE_REQUEST_TIMEOUT_MS = 5_000;
export const BRIDGE_MAX_TRANSIENT_FAILURES = 5;
export const BRIDGE_MAX_DISCONNECTED_POLLS = 6;
export const BRIDGE_TOTAL_WAIT_MS = 10 * 60 * 1_000;
export const BRIDGE_SEEK_WAIT_MS = 5_000;
export const BRIDGE_MAX_MEDIA_RESETS = 2;

type StatusFetchResult =
  | { kind: 'ok'; status: CompanionBridgeStatus }
  | { kind: 'auth' }
  | { kind: 'fail'; transport: boolean };

/** Media URL for the direct-URL contract (token as query parameter; video
 *  elements cannot set request headers — PoC contract). */
function mediaUrlFor(source: CompanionBridgeSource): string {
  return `${source.baseUrl}/v1/media/fixture?token=${encodeURIComponent(source.token)}`;
}

export class CompanionBridge {
  private readonly opts: Required<CompanionBridgeOptions>;
  private readonly callbacks: CompanionBridgeCallbacks;

  private phase: CompanionBridgePhase = 'idle';
  private epoch = 0;
  private source: CompanionBridgeSource | null = null;
  private media: CompanionBridgeMedia | null = null;
  private mediaUnsubs: Array<() => void> = [];

  private abortController: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;

  private progress: CompanionBridgeProgress | null = null;
  private lastAvailable: number | null = null;
  private backoffStep = 0;
  private transientFailures = 0;
  private disconnectedPolls = 0;
  private startedAt = 0;

  private intentPlay = true;
  private pendingSeek: number | null = null;
  private awaitingSeek = false;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  private mediaReadyFired = false;
  private mediaResets = 0;

  constructor(
    options: CompanionBridgeOptions = {},
    callbacks: CompanionBridgeCallbacks,
  ) {
    this.opts = {
      fetchFn: options.fetchFn ?? ((input, init) => fetch(input, init)),
      basePollMs: options.basePollMs ?? BRIDGE_BASE_POLL_MS,
      maxPollMs: options.maxPollMs ?? BRIDGE_MAX_POLL_MS,
      disconnectedPollMs:
        options.disconnectedPollMs ?? BRIDGE_DISCONNECTED_POLL_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? BRIDGE_REQUEST_TIMEOUT_MS,
      maxTransientFailures:
        options.maxTransientFailures ?? BRIDGE_MAX_TRANSIENT_FAILURES,
      maxDisconnectedPolls:
        options.maxDisconnectedPolls ?? BRIDGE_MAX_DISCONNECTED_POLLS,
      totalWaitMs: options.totalWaitMs ?? BRIDGE_TOTAL_WAIT_MS,
      seekWaitMs: options.seekWaitMs ?? BRIDGE_SEEK_WAIT_MS,
      maxMediaResets: options.maxMediaResets ?? BRIDGE_MAX_MEDIA_RESETS,
    };
    this.callbacks = callbacks;
  }

  get currentPhase(): CompanionBridgePhase {
    return this.phase;
  }

  /** Begin (or restart) a source session. Aborts any previous session.
   *  `media` may be null when no element is available yet; call
   *  `attachMedia` once one exists. */
  beginSession(
    source: CompanionBridgeSource,
    media: CompanionBridgeMedia | null = null,
  ): void {
    this.teardown();
    this.epoch += 1;
    this.source = source;
    this.media = media;
    this.progress = null;
    this.lastAvailable = null;
    this.backoffStep = 0;
    this.transientFailures = 0;
    this.disconnectedPolls = 0;
    this.intentPlay = true;
    this.pendingSeek = null;
    this.awaitingSeek = false;
    this.mediaReadyFired = false;
    this.mediaResets = 0;
    this.startedAt = Date.now();
    // Bind media listeners immediately so that error events during
    // buffering (e.g. from a503 before the verified prefix exists) are
    // caught and recovered. Previously bindMedia was only called from
    // startReadyTransition at the 'ready' phase, which meant errors
    // during the buffering phase were silently dropped.
    if (media !== null) {
      this.bindMedia(media);
    }
    this.setPhase('buffering');
    void this.poll();
  }

  /** Attach (or replace) the media element. Listeners are bound immediately
   *  (once — unbindMedia runs first, so there are never duplicates), so an
   *  error during the buffering phase — e.g. the browser firing an error
   *  from a 503 while the verified prefix is still growing — is caught and
   *  routed through the status re-check / explicit src-load recovery. If
   *  the source is already `ready`, the pending src/load transition runs
   *  right away. */
  attachMedia(media: CompanionBridgeMedia): void {
    this.media = media;
    this.bindMedia(media);
    if (this.phase === 'ready') {
      this.startReadyTransition();
    }
  }

  /** Cancel the session (user cancel, source switch, unmount): aborts any
   *  in-flight poll, clears all timers and listeners. */
  endSession(): void {
    this.teardown();
    this.epoch += 1;
    this.source = null;
    this.progress = null;
    this.pendingSeek = null;
    this.setPhase('idle');
  }

  /** Record the user's playback intent: false = stay paused when the
   *  source becomes ready (user pressed pause while buffering). */
  setPlayIntent(play: boolean): void {
    this.intentPlay = play;
  }

  /** Queue a seek to apply right after the ready transition, or apply it
   *  directly once playing. Latest call wins while buffering.
   *
   *  During playback (phase='playing'), seekTo is skipped when the requested
   *  value is within ±0.01s of the current currentTime. Setting the same
   *  value triggers Chrome's seeking event again (WPT/Chromium: even a
   *  same-value currentTime assignment re-fires 'seeking'), which loops
   *  back into requestSeek via the seeking listener — an infinite
   *  re-seek feedback loop that pins GPU Video Decode at 100%.
   *
   *  When currentTime() returns undefined (metadata not yet loaded), the
   *  guard is bypassed and seekTo executes. In phase='playing' this is
   *  unreachable (metadata must be loaded to play), but the fallback is
   *  kept defensively. */
  requestSeek(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (this.phase === 'playing') {
      const current = this.media?.currentTime();
      if (current != null && Math.abs(seconds - current) < 0.01) {
        return; // same-value seek: skip to prevent re-seek feedback loop
      }
      this.media?.seekTo(seconds);
      return;
    }
    if (this.phase === 'ready' && this.awaitingSeek) {
      this.media?.seekTo(seconds);
      return;
    }
    if (this.phase === 'buffering' || this.phase === 'ready') {
      this.pendingSeek = seconds; // latest wins; applied after loadedmetadata
    }
  }

  // --- polling ---

  private schedule(delayMs: number): void {
    if (
      this.phase === 'idle' ||
      this.phase === 'error' ||
      this.phase === 'rePairRequired'
    ) {
      return;
    }
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    // Single-flight guard: a scheduled poll while one is in flight is a
    // no-op (never a parallel request).
    if (this.inFlight || this.source === null) return;
    this.inFlight = true;
    const epoch = this.epoch;
    const ac = new AbortController();
    this.abortController = ac;
    const timeout = setTimeout(() => ac.abort(), this.opts.requestTimeoutMs);
    try {
      const result = await this.fetchStatus(ac.signal);
      if (epoch !== this.epoch) return; // superseded by begin/end
      this.applyStatus(result);
    } catch {
      // fetchStatus maps errors to results; this is defensive only.
      if (epoch === this.epoch) this.onTransientFailure(true);
    } finally {
      clearTimeout(timeout);
      if (this.abortController === ac) this.abortController = null;
      if (epoch === this.epoch) this.inFlight = false;
    }
  }

  private async fetchStatus(signal: AbortSignal): Promise<StatusFetchResult> {
    const src = this.source;
    if (src === null) return { kind: 'fail', transport: true };
    let res: Response;
    try {
      res = await this.opts.fetchFn(
        `${src.baseUrl}/v1/media/status?token=${encodeURIComponent(src.token)}`,
        { signal, cache: 'no-store' },
      );
    } catch {
      return { kind: 'fail', transport: true }; // network error / abort
    }
    if (res.status === 401 || res.status === 403) {
      return { kind: 'auth' };
    }
    if (!res.ok) {
      return { kind: 'fail', transport: false };
    }
    try {
      return this.parseStatus(JSON.parse(await res.text()));
    } catch {
      return { kind: 'fail', transport: false };
    }
  }

  private parseStatus(parsed: unknown): StatusFetchResult {
    if (typeof parsed !== 'object' || parsed === null) {
      return { kind: 'fail', transport: false };
    }
    const o = parsed as Record<string, unknown>;
    const state = o['state'];
    if (
      state !== 'disabled' &&
      state !== 'buffering' &&
      state !== 'complete' &&
      state !== 'playable' &&
      state !== 'error'
    ) {
      return { kind: 'fail', transport: false };
    }
    const available = o['available'];
    const total = o['total'];
    if (
      typeof available !== 'number' ||
      typeof total !== 'number' ||
      available < 0 ||
      total < 0
    ) {
      return { kind: 'fail', transport: false };
    }
    const retryAfter =
      typeof o['retryAfter'] === 'number' ? o['retryAfter'] : undefined;
    return {
      kind: 'ok',
      status: {
        state,
        available,
        total,
        headReady: o['headReady'] === true,
        retryAfter,
        errorCode: typeof o['errorCode'] === 'string' ? o['errorCode'] : undefined,
      },
    };
  }

  private applyStatus(result: StatusFetchResult): void {
    if (result.kind === 'auth') {
      // Terminal: re-pairing is a user action, never an automatic retry.
      this.setPhase('rePairRequired', 'companion requires re-pairing');
      return;
    }
    if (result.kind === 'fail') {
      this.onTransientFailure(result.transport);
      return;
    }
    switch (result.status.state) {
      case 'complete':
        // Skip src/load reset when already playing: the element is serving
        // data and seeking works fine. A src/load here would rewind to 00:00
        // and trigger a seek loop. Only reset from ready/buffering/etc.
        if (this.phase !== 'playing') {
          this.onComplete(result.status);
        } else {
          this.schedule(this.opts.maxPollMs);
        }
        return;
      case 'playable':
        // ED-2H: provisional streaming. Only hand the URL/load on the FIRST
        // playable sighting. While already ready/playing, keep polling to
        // detect completion / media-error recovery, but do NOT re-run
        // startReadyTransition — video.load() on every poll rewinds to 00:00
        // and stutters.
        if (this.phase !== 'ready' && this.phase !== 'playing') {
          this.onComplete(result.status);
        }
        this.schedule(this.opts.maxPollMs);
        return;
      case 'buffering':
        this.onBuffering(result.status);
        return;
      case 'error':
        this.setPhase('error', result.status.errorCode ?? 'source reported an error');
        return;
      case 'disabled':
        // A configured session should never see disabled; fail closed.
        this.setPhase('error', 'source disabled');
        return;
    }
  }

  private onTransientFailure(transport: boolean): void {
    if (
      this.phase === 'idle' ||
      this.phase === 'error' ||
      this.phase === 'rePairRequired'
    ) {
      return;
    }
    if (transport) {
      this.disconnectedPolls += 1;
      this.setPhase('disconnected');
      if (this.disconnectedPolls > this.opts.maxDisconnectedPolls) {
        this.setPhase('error', 'companion unreachable');
        return;
      }
      this.schedule(this.opts.disconnectedPollMs);
      return;
    }
    this.transientFailures += 1;
    if (this.transientFailures >= this.opts.maxTransientFailures) {
      this.setPhase('error', 'status polling failed repeatedly');
      return;
    }
    this.backoffStep += 1;
    this.schedule(this.nextDelay(undefined));
  }

  private onBuffering(status: CompanionBridgeStatus): void {
    this.progress = { available: status.available, total: status.total };
    const first = this.lastAvailable === null;
    const advanced = !first && status.available > this.lastAvailable!;
    if (first || advanced) {
      this.backoffStep = 0; // progress (or a fresh start) resets backoff
    } else {
      this.backoffStep += 1;
    }
    this.lastAvailable = status.available;
    this.transientFailures = 0;
    this.disconnectedPolls = 0;
    this.setPhase('buffering');
    if (Date.now() - this.startedAt > this.opts.totalWaitMs) {
      this.setPhase('error', 'buffering timed out');
      return;
    }
    this.schedule(this.nextDelay(status.retryAfter));
  }

  private onComplete(status: CompanionBridgeStatus): void {
    this.progress = { available: status.total, total: status.total };
    this.lastAvailable = status.total;
    this.setPhase('ready');
    this.startReadyTransition();
  }

  private nextDelay(retryAfterSeconds: number | undefined): number {
    const base = Math.max(
      retryAfterSeconds !== undefined && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : 0,
      this.opts.basePollMs,
    );
    return Math.min(base * 2 ** this.backoffStep, this.opts.maxPollMs);
  }

  // --- ready transition: explicit src reset → load → metadata → seek → play

  private startReadyTransition(): void {
    const media = this.media;
    const source = this.source;
    if (media === null || source === null) return;
    this.bindMedia(media);
    this.mediaReadyFired = false;
    // Direct-URL contract: only hand the element a URL once complete.
    media.setSrc(mediaUrlFor(source));
    media.load();
  }

  private bindMedia(media: CompanionBridgeMedia): void {
    this.unbindMedia();
    this.mediaUnsubs.push(
      media.onLoadedMetadata(() => this.onMediaMetadataReady()),
      media.onCanPlay(() => this.onMediaMetadataReady()),
      media.onSeeked(() => this.onMediaSeeked()),
      media.onPlaying(() => {
        if (this.phase === 'ready') this.setPhase('playing');
      }),
      media.onError(() => void this.onMediaError()),
    );
  }

  private unbindMedia(): void {
    for (const un of this.mediaUnsubs) un();
    this.mediaUnsubs = [];
  }

  private onMediaMetadataReady(): void {
    if (this.phase !== 'ready' || this.mediaReadyFired) return;
    this.mediaReadyFired = true;
    this.consumePendingSeekAndPlay();
  }

  private consumePendingSeekAndPlay(): void {
    const media = this.media;
    if (media === null) return;
    if (this.pendingSeek !== null) {
      const t = this.pendingSeek;
      this.pendingSeek = null;
      this.awaitingSeek = true;
      media.seekTo(t);
      this.seekTimer = setTimeout(() => {
        this.seekTimer = null;
        if (!this.awaitingSeek) return;
        this.awaitingSeek = false;
        this.maybePlay(); // bounded: never wait on seeked forever
      }, this.opts.seekWaitMs);
      return;
    }
    this.maybePlay();
  }

  private onMediaSeeked(): void {
    if (!this.awaitingSeek) return;
    this.awaitingSeek = false;
    if (this.seekTimer !== null) {
      clearTimeout(this.seekTimer);
      this.seekTimer = null;
    }
    this.maybePlay();
  }

  private maybePlay(): void {
    const media = this.media;
    if (media === null || this.phase !== 'ready') return;
    if (!this.intentPlay) return; // user paused while buffering: stay paused
    media.play().catch(() => {
      // Autoplay-policy rejections surface through the element's own
      // events; the phase stays `ready` so the user can resume manually.
    });
  }

  private async onMediaError(): Promise<void> {
    if (
      this.phase !== 'ready' &&
      this.phase !== 'playing' &&
      this.phase !== 'buffering'
    ) {
      return;
    }
    // Re-check the source status exactly once (never an open retry loop).
    // This handles the case where the browser fired an error from a503
    // response (no verified prefix yet) while the bridge was still
    // buffering — the recovery is to wait for "playable" and reload.
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), this.opts.requestTimeoutMs);
    let result: StatusFetchResult;
    try {
      result = await this.fetchStatus(ac.signal);
    } finally {
      clearTimeout(timeout);
    }
    if (
      this.phase !== 'ready' &&
      this.phase !== 'playing' &&
      this.phase !== 'buffering'
    ) {
      return;
    }
    if (result.kind === 'auth') {
      this.setPhase('rePairRequired', 'companion requires re-pairing');
      return;
    }
    if (result.kind === 'fail') {
      this.setPhase('error', 'media failed; status unreachable');
      return;
    }
    const status = result.status;
    if (status.state === 'complete' || status.state === 'playable') {
      if (this.mediaResets < this.opts.maxMediaResets) {
        this.mediaResets += 1;
        // Transition to 'ready' if we were still buffering (e.g. the
        // browser fired an error from a503 before the prefix existed,
        // but the source is now playable). startReadyTransition assumes
        // phase is already 'ready', so set it first.
        if (this.phase !== 'ready' && this.phase !== 'playing') {
          this.onComplete(status);
          return;
        }
        // Explicit src/load reset — the measured recovery path.
        this.startReadyTransition();
        return;
      }
      this.setPhase('error', 'media reset exhausted');
      return;
    }
    if (status.state === 'buffering') {
      this.lastAvailable = status.available;
      this.backoffStep = 0;
      this.transientFailures = 0;
      this.disconnectedPolls = 0;
      this.progress = { available: status.available, total: status.total };
      this.setPhase('buffering');
      this.schedule(this.nextDelay(status.retryAfter));
      return;
    }
    this.setPhase('error', 'source reported an error after media failure');
  }

  private setPhase(
    phase: CompanionBridgePhase,
    reason: string | null = null,
  ): void {
    this.phase = phase;
    this.callbacks.onPhaseChange(phase, { progress: this.progress, reason });
  }

  private teardown(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.seekTimer !== null) {
      clearTimeout(this.seekTimer);
      this.seekTimer = null;
    }
    if (this.abortController !== null) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.unbindMedia();
    this.media = null;
    this.inFlight = false;
  }
}
