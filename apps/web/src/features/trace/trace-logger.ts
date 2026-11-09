/**
 * trace-logger — the user-action → system-reaction journal (web side).
 * ---------------------------------------------------------------------------
 * Entei records *what the user did* and *how the system answered* so a bug
 * report can be replayed from a file instead of from memory. This module is
 * the single front door for that journal:
 *
 * - `trace(area, event, data?)` — explicit semantic events at the places that
 *   matter (`home` post published, `player` seek, `modules` toggle, …).
 * - `installTraceInstrumentation()` — installs the automatic layers once:
 *   - `ui`:  every click / key press on a control, with a readable label;
 *   - `ipc`: every Tauri command with duration and outcome;
 *   - `companion`: every HTTP call (method, path, status, duration);
 *   - `app`: boot, route, visibility, uncaught errors.
 *
 * Delivery:
 *
 * - inside Tauri the entries are batched (~0.8s) and appended by the Rust
 *   `trace_log` command to `<app_log_dir>/traces/trace-YYYY-MM-DD.log`
 *   (JSONL, 24h rolling retention — see `src-tauri/src/trace.rs`);
 * - in the standalone browser build there is no runtime to write files, so
 *   entries are kept in an in-memory ring buffer (`window.__enteiTrace`) and
 *   echoed to the console. Nothing here ever throws: a broken trace must
 *   never break playback.
 *
 * Privacy: every payload goes through `sanitize()`, which drops token-ish keys
 * (companion capability token, API keys, cookies) and rewrites `token=` inside
 * URLs. Trace files are local-only and never uploaded.
 * ---------------------------------------------------------------------------
 */

/** Which part of the app emitted an entry. */
export type TraceArea =
  | 'app'
  | 'home'
  | 'profile'
  | 'modules'
  | 'player'
  | 'audio'
  | 'ui'
  | 'ipc'
  | 'companion';

/** Structured payload attached to an entry (sanitized before it is sent). */
export type TraceData = Record<string, unknown>;

/** One journal line, exactly as the Rust side stores it. */
export interface TraceRecord {
  /** Event time, epoch milliseconds. */
  ts: number;
  /** Emitting area (`home`, `player`, `ipc`…). */
  area: TraceArea;
  /** Event name (`post_publish`, `seek`, `invoke_error`…). */
  event: string;
  /** Sanitized payload. */
  data: TraceData;
}

/** Tauri v2 IPC surface (injected before the frontend boots). */
interface TauriInternals {
  invoke: (
    cmd: string,
    args?: Record<string, unknown>,
    options?: unknown,
  ) => Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: Partial<TauriInternals>;
    /** Recent entries for the browser build (and for live debugging). */
    __enteiTrace?: {
      recent: () => TraceRecord[];
      pending: () => number;
      flush: () => Promise<void>;
    };
  }
}

/** Pending entries kept before the oldest ones are dropped. */
const MAX_PENDING = 500;
/** Recent entries kept in memory for inspection. */
const MAX_RECENT = 400;
/** Entries sent per IPC call. */
const BATCH_SIZE = 64;
/** Batch cadence. */
const FLUSH_INTERVAL_MS = 800;
/** Max characters kept per string value. */
const MAX_STRING = 300;
/** Max characters kept for a control label (aria-label/title can be a sentence). */
const MAX_LABEL = 60;
/** Hex characters kept from a magnet infohash (see `redactMagnet`). */
const SHORT_INFOHASH = 12;
/** Max keys/items kept per object/array. */
const MAX_ITEMS = 40;
/** Max nesting depth kept. */
const MAX_DEPTH = 4;
/** Keys whose values are never written to disk. */
const SECRET_KEY = /token|secret|password|passwd|apikey|api_key|authorization|cookie|credential|(?:^|_)key$/i;

/** Per-page-load session marker so interleaved sessions stay distinguishable. */
const SESSION_ID = createSessionId();

const pending: TraceRecord[] = [];
const recent: TraceRecord[] = [];

let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let droppedCount = 0;
let failedAttempts = 0;
let instrumentationInstalled = false;

/** Short random session id (`s1a2b3c4`) — not a secret, just a correlator. */
function createSessionId(): string {
  const random = Math.random().toString(36).slice(2, 6);
  return `s${Date.now().toString(36).slice(-4)}${random}`;
}

/** True when running inside the Tauri desktop webview. */
function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.__TAURI_INTERNALS__?.invoke === 'function'
  );
}

/** The injected `invoke`, or null outside Tauri. */
function tauriInvoke(): TauriInternals['invoke'] | null {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

/** Clip a string to the trace cap, marking the cut. */
function clipString(value: string): string {
  if (value.length <= MAX_STRING) return value;
  return `${value.slice(0, MAX_STRING)}…`;
}

/** Clip a control label: `aria-label`/`title` can hold a whole subtitle line. */
function clipLabel(value: string): string {
  if (value.length <= MAX_LABEL) return value;
  return `${value.slice(0, MAX_LABEL)}…`;
}

/**
 * Sanitize every `magnet:` URI inside a string.
 *
 * A magnet URI carries more than the torrent: `tr=` can hold a private tracker
 * passkey (`https://user:PASSKEY@tracker/announce`), `dn=` the release name and
 * the infohash the identity of the swarm. Rule #1771 keeps exactly one piece of
 * torrent detail in the logs — the 12-hex short infohash — so every parameter
 * value is replaced with `[redacted]` and `xt=urn:btih:<hash>` is shortened.
 */
function redactMagnet(text: string): string {
  return text.replace(/magnet:\?[^\s"'<>]+/gi, (match) => {
    const body = match.slice('magnet:?'.length);
    const params = body.split('&').map((param) => {
      // `&amp;` survives HTML escaping in a message; treat it as a separator.
      const cleaned = param.replace(/^amp;/i, '');
      const eq = cleaned.indexOf('=');
      const key = (eq === -1 ? cleaned : cleaned.slice(0, eq)).toLowerCase();
      const value = eq === -1 ? '' : cleaned.slice(eq + 1);
      if (key === 'xt') {
        const infohash = value.replace(/^urn:btih:/i, '');
        return `xt=urn:btih:${infohash.slice(0, SHORT_INFOHASH)}`;
      }
      return key.length > 0 ? `${key}=[redacted]` : '[redacted]';
    });
    return `magnet:?${params.join('&')}`;
  });
}

/** Rewrite `token=…`/magnet parameters inside a URL or message. */
function redactInline(text: string): string {
  return redactMagnet(text).replace(
    /((?:token|key|apikey|api_key|password|secret)=)[^&\s"']+/gi,
    '$1[redacted]',
  );
}

/**
 * Make a payload safe to persist: secrets removed, strings clipped, depth and
 * breadth bounded. Never throws — an unserializable value becomes a string.
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return clipString(redactInline(value));
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return value.toString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: clipString(redactInline(value.message)),
    };
  }
  if (typeof Event !== 'undefined' && value instanceof Event) {
    return { type: value.type };
  }
  if (depth >= MAX_DEPTH) return '[depth]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitize(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`[+${value.length - MAX_ITEMS}]`);
    return items;
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const [key, item] of Object.entries(source)) {
      if (SECRET_KEY.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      if (kept >= MAX_ITEMS) {
        out['…'] = 'truncated';
        break;
      }
      out[key] = sanitize(item, depth + 1);
      kept += 1;
    }
    return out;
  }

  return String(value);
}

/** Sanitize a whole payload object (the entry's `data`). */
function sanitizeData(data: TraceData | undefined): TraceData {
  if (!data) return {};
  const clean = sanitize(data);
  const base: TraceData =
    typeof clean === 'object' && clean !== null && !Array.isArray(clean)
      ? (clean as TraceData)
      : { value: clean };
  base.sid = SESSION_ID;
  return base;
}

/** Route → area, used when an automatic layer has no better context. */
export function routeArea(): TraceArea {
  if (typeof location === 'undefined') return 'app';
  const path = location.pathname;
  if (path.startsWith('/player')) return 'player';
  if (path.startsWith('/audio-player')) return 'audio';
  if (path.startsWith('/profile')) return 'profile';
  if (path.startsWith('/modules')) return 'modules';
  return 'home';
}

/** Push one entry into the in-memory ring and the send queue. */
function enqueue(record: TraceRecord): void {
  recent.push(record);
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);

  pending.push(record);
  if (pending.length > MAX_PENDING) {
    const overflow = pending.length - MAX_PENDING;
    pending.splice(0, overflow);
    droppedCount += overflow;
  }

  scheduleFlush();
}

/** Start the batch timer on the first entry (idle pages run no timer). */
function scheduleFlush(): void {
  if (flushTimer !== null) return;
  if (typeof setInterval !== 'function') return;
  flushTimer = setInterval(() => {
    void flushTrace();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Record one semantic event.
 *
 * `trace('player', 'seek', { from: 12.4, to: 88.1 })`
 */
export function trace(area: TraceArea, event: string, data?: TraceData): void {
  try {
    enqueue({
      ts: Date.now(),
      area,
      event: clipString(event),
      data: sanitizeData(data),
    });
  } catch {
    // Tracing must never break the caller.
  }
}

/** Record a failure with its error object (message is sanitized). */
export function traceError(
  area: TraceArea,
  event: string,
  error: unknown,
  data?: TraceData,
): void {
  try {
    trace(area, event, { ...data, error: sanitize(error) });
  } catch {
    // ignore
  }
}

/** Time a promise-returning operation and record its duration + outcome. */
export async function traceSpan<T>(
  area: TraceArea,
  event: string,
  operation: () => Promise<T>,
  data?: TraceData,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    trace(area, event, { ...data, ok: true, ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    traceError(area, event, error, { ...data, ok: false, ms: Date.now() - startedAt });
    throw error;
  }
}

/**
 * Send the queued entries.
 *
 * Inside Tauri the batch is appended by `trace_log`; outside Tauri (or when the
 * command fails) the entries stay in the in-memory ring and are echoed to the
 * console, so the browser build still has a usable journal.
 */
export async function flushTrace(): Promise<void> {
  if (flushing || pending.length === 0) return;
  flushing = true;
  const batch = pending.splice(0, BATCH_SIZE);
  try {
    const invoke = tauriInvoke();
    if (invoke === null) {
      // Browser build: no runtime to write files. The entries stay in the
      // in-memory ring (`window.__enteiTrace.recent()`), and one summary line
      // keeps the console readable instead of dumping every payload.
      if (typeof console !== 'undefined') {
        console.debug(`[entei-trace] ${batch.length} entries (see __enteiTrace)`);
      }
      return;
    }
    await invoke('trace_log', { entries: batch });
    failedAttempts = 0;
  } catch {
    failedAttempts += 1;
    // Put the batch back once; after repeated failures drop it rather than
    // grow the queue forever (the console echo below is the fallback).
    if (failedAttempts <= 2) {
      pending.unshift(...batch);
      if (pending.length > MAX_PENDING) {
        droppedCount += pending.length - MAX_PENDING;
        pending.splice(MAX_PENDING);
      }
    } else if (typeof console !== 'undefined') {
      console.debug(`[entei-trace] dropped ${batch.length} entries (writer failed)`);
    }
  } finally {
    flushing = false;
  }
}

/** Recent entries (newest last) — used by tests and live debugging. */
export function getTraceRecent(): readonly TraceRecord[] {
  return recent;
}

/** Number of entries still waiting to be written (tests). */
export function getTracePendingCount(): number {
  return pending.length;
}

/** Entries dropped because the queue overflowed (diagnostics). */
export function getTraceDroppedCount(): number {
  return droppedCount;
}

/** Drop everything in memory (tests only — the files are untouched). */
export function resetTraceState(): void {
  // The batch timer belongs to the queue being dropped: without this a reset
  // leaves an interval running against an empty queue (and keeps the process
  // awake in the test runner).
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  pending.length = 0;
  recent.length = 0;
  droppedCount = 0;
  failedAttempts = 0;
}

/* ---------------------------------------------------------------------------
 * Automatic layers
 * ---------------------------------------------------------------------------
 * Explicit `trace()` calls describe intent; these layers catch everything the
 * explicit calls cannot reach (a control nobody instrumented, a command that
 * hangs, a request that 403s). Each layer is installed once and is fully
 * defensive: a failure inside the layer never reaches the page.
 * ------------------------------------------------------------------------- */

/** Readable label for a clicked/focused element. */
function describeElement(element: Element): {
  label: string;
  tag: string;
  id: string;
} {
  const tag = element.tagName.toLowerCase();
  const id = element.id ?? '';
  const explicit = element.getAttribute('data-trace');
  const aria = element.getAttribute('aria-label');
  const title = element.getAttribute('title');
  const role = element.getAttribute('role') ?? '';
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  // Every source is clipped: `aria-label`/`title` on a subtitle block holds the
  // whole cue text, and a trace file is not the place for it.
  const label = clipLabel(
    explicit ||
      aria ||
      title ||
      (text.length > 0 ? text.slice(0, MAX_LABEL) : '') ||
      (role ? `${tag}[role=${role}]` : tag),
  );
  return { label, tag, id };
}

/** True when the target accepts text, where key logging would leak content. */
function isEditableTarget(target: Element | null): boolean {
  if (!target) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.getAttribute('contenteditable') === 'true';
}

/** Nearest interesting ancestor of a click target. */
function findInteractive(target: Element | null): Element | null {
  let node: Element | null = target;
  while (node && node !== document.body) {
    if (node.hasAttribute('data-trace')) return node;
    const tag = node.tagName.toLowerCase();
    if (
      tag === 'button' ||
      tag === 'a' ||
      tag === 'summary' ||
      tag === 'label' ||
      tag === 'input' ||
      tag === 'select'
    ) {
      return node;
    }
    const role = node.getAttribute('role');
    if (
      role === 'button' ||
      role === 'tab' ||
      role === 'switch' ||
      role === 'menuitem' ||
      role === 'option' ||
      role === 'checkbox' ||
      role === 'radio' ||
      role === 'slider'
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Strip the query string and origin so a trace line stays short and safe. */
function describeUrl(raw: string): string {
  try {
    const url = new URL(raw, location.origin);
    const sameOrigin = url.origin === location.origin;
    const local =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    const where = sameOrigin || local ? url.pathname : `${url.host}${url.pathname}`;
    return redactInline(where);
  } catch {
    return redactInline(clipString(raw));
  }
}

/**
 * Companion polling cadence (`waitForPlayable`, torrent status) fires the same
 * request every second for minutes. Re-logging each one would bury the real
 * events, so an unchanged (method, path, status) is recorded at most once per
 * this interval — while a status change is always recorded.
 */
const HTTP_TRACE_INTERVAL_MS = 5_000;
/** Upper bound for the poll-throttle map (long sessions open many job paths). */
const HTTP_TRACE_KEYS = 100;
const httpTraceSeen = new Map<string, { at: number; status: number }>();

/**
 * True when this response is worth a line (first, changed, or heartbeat).
 *
 * Exported for the unit test that pins the "polling must not flood the file"
 * contract; it is not part of the app-facing API.
 */
export function shouldTraceHttp(
  key: string,
  status: number,
  now: number,
): boolean {
  const last = httpTraceSeen.get(key);
  if (last === undefined || last.status !== status) {
    if (httpTraceSeen.size >= HTTP_TRACE_KEYS) httpTraceSeen.clear();
    httpTraceSeen.set(key, { at: now, status });
    return true;
  }
  if (now - last.at < HTTP_TRACE_INTERVAL_MS) return false;
  httpTraceSeen.set(key, { at: now, status });
  return true;
}

/** Wrap `window.fetch` so every companion/local request is journalled. */
function installFetchTracing(): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  const original = window.fetch;
  if ((original as { __enteiTraced?: boolean }).__enteiTraced) return;

  const wrapped = function tracedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const startedAt = Date.now();
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method = (init?.method ?? (input as Request)?.method ?? 'GET').toUpperCase();
    const path = describeUrl(url);
    return original.call(window, input as RequestInfo, init).then(
      (response) => {
        if (shouldTraceHttp(`${method} ${path}`, response.status, Date.now())) {
          trace('companion', 'http', {
            method,
            path,
            status: response.status,
            ok: response.ok,
            ms: Date.now() - startedAt,
          });
        }
        return response;
      },
      (error: unknown) => {
        // A failed request is never routine: always recorded.
        traceError('companion', 'http_failed', error, {
          method,
          path,
          ms: Date.now() - startedAt,
        });
        throw error;
      },
    );
  };
  (wrapped as { __enteiTraced?: boolean }).__enteiTraced = true;
  window.fetch = wrapped as typeof window.fetch;
}

/**
 * Run one Tauri command and journal it.
 *
 * Tauri v2 installs `__TAURI_INTERNALS__.invoke` via `Object.defineProperty`
 * (non-writable, non-configurable), so it cannot be monkey-patched from the
 * page. Every IPC call goes through this helper instead: `tauri-bridge.ts` is
 * the app's single gateway to the plugins, so one indirection covers every
 * command.
 *
 * Rejects exactly like the raw `invoke` (including when the runtime is
 * missing), so callers keep their existing error handling.
 */
export function tracedInvoke(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const invoke = tauriInvoke();
  if (invoke === null) {
    return Promise.reject(new Error('tauri runtime unavailable'));
  }
  const startedAt = Date.now();
  // Command args can hold a URL/path. `sanitize` runs `redactMagnet` over every
  // string, so `add_torrent`'s `magnetUri` loses its passkey-bearing trackers
  // and full infohash before it can reach the log file (Rule #1771).
  const cleanArgs = sanitize(args ?? null);
  return invoke(cmd, args).then(
    (result) => {
      trace('ipc', 'invoke', {
        cmd,
        ok: true,
        ms: Date.now() - startedAt,
        args: cleanArgs,
      });
      return result;
    },
    (error: unknown) => {
      traceError('ipc', 'invoke_error', error, {
        cmd,
        ms: Date.now() - startedAt,
        args: cleanArgs,
      });
      throw error;
    },
  );
}

/** Journal every click on a control, plus keyboard input outside text fields. */
function installUserInputTracing(): void {
  if (typeof document === 'undefined') return;

  document.addEventListener(
    'click',
    (event) => {
      try {
        const element = findInteractive(event.target as Element | null);
        if (!element) return;
        const { label, tag, id } = describeElement(element);
        trace('ui', 'click', { label, tag, id, route: location.pathname });
      } catch {
        // ignore
      }
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      try {
        // Text fields are excluded: the key itself is content, not intent.
        if (isEditableTarget(event.target as Element | null)) return;
        const key = event.key;
        if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') {
          return;
        }
        const element = findInteractive(event.target as Element | null);
        trace('ui', 'key', {
          key,
          ctrl: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          meta: event.metaKey,
          on: element ? describeElement(element).label : null,
          route: location.pathname,
        });
      } catch {
        // ignore
      }
    },
    true,
  );

  // Detail views (Home post thread, settings dialogs) are not routes, so the
  // URL alone does not tell where the user was: log navigation intent too.
  window.addEventListener('popstate', () => {
    trace('app', 'popstate', { path: location.pathname });
  });
}

/** Journal boot, visibility changes and uncaught errors. */
function installLifecycleTracing(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('pagehide', () => {
    trace('app', 'pagehide', { path: location.pathname });
    void flushTrace();
  });

  document.addEventListener('visibilitychange', () => {
    trace('app', 'visibility', {
      state: document.visibilityState,
      path: location.pathname,
    });
    if (document.visibilityState === 'hidden') void flushTrace();
  });

  window.addEventListener('error', (event) => {
    traceError('app', 'window_error', event.error ?? event.message, {
      source: event.filename ?? null,
      line: event.lineno ?? null,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    traceError('app', 'unhandled_rejection', event.reason);
  });

  trace('app', 'boot', {
    path: location.pathname,
    tauri: isTauriRuntime(),
    locale: document.documentElement.lang,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    userAgent: navigator.userAgent,
  });
}

/**
 * Install every automatic layer once.
 *
 * Called from `src/scripts/trace-boot.ts`, which both layouts load, so Home,
 * Player, Audio Player, Profile and Modules are all covered without each page
 * remembering to do it.
 */
export function installTraceInstrumentation(): void {
  if (instrumentationInstalled) return;
  instrumentationInstalled = true;
  try {
    installLifecycleTracing();
    installUserInputTracing();
    installFetchTracing();
    if (typeof window !== 'undefined') {
      window.__enteiTrace = {
        recent: () => [...recent],
        pending: () => pending.length,
        flush: flushTrace,
      };
    }
  } catch (error) {
    traceError('app', 'instrumentation_failed', error);
  }
}
