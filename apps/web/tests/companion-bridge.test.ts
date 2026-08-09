/**
 * ED-2E companion buffering bridge — controller behavior tests.
 * ---------------------------------------------------------------------------
 * Covers the committed design contract: single-flight chained polling,
 * fixed-interval buffering poll (1 s — avail>0 detection within ~1 s;
 * 2026-08-09 latency fix), exponential backoff for transient failures,
 * complete → explicit src/load/play transition with play + seek intent
 * preservation, 401/403 → re-pair (no retries), bounded
 * transient/disconnect failures, cancellation, and the media-error
 * re-check path.
 * --------------------------------------------------------------------------- */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_BASE_POLL_MS,
  BRIDGE_DISCONNECTED_POLL_MS,
  CompanionBridge,
  type CompanionBridgeMedia,
  type CompanionBridgeOptions,
  type CompanionBridgePhase,
  type CompanionBridgeSource,
} from '../src/features/player/companion-bridge';

const SOURCE: CompanionBridgeSource = {
  baseUrl: 'http://127.0.0.1:4322',
  token: 'tok123',
};

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const buffering = (available: number, total: number, retryAfter?: number) =>
  json({
    state: 'buffering',
    available,
    total,
    headReady: false,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  });

const complete = (total: number) =>
  json({ state: 'complete', available: total, total, headReady: false });

const playable = (available: number, total: number) =>
  json({ state: 'playable', available, total, headReady: false });

const authError = (status: 401 | 403) =>
  json({ error: 'unauthorized' }, status);

const serverError = () => json({ error: 'boom' }, 500);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FetchCall {
  url: string;
  signal: AbortSignal | null;
}

function makeFetcher(responses: Array<Response | Promise<Response>> = []) {
  const calls: FetchCall[] = [];
  const times: number[] = [];
  const queue: Array<Response | Promise<Response>> = [...responses];
  const fetchFn = vi.fn<typeof fetch>((input, init) => {
    calls.push({ url: String(input), signal: init?.signal ?? null });
    times.push(Date.now());
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new TypeError('no response queued'));
    }
    return Promise.resolve(next);
  });
  return { calls, times, fetchFn };
}

function makeMedia() {
  const listeners = new Map<string, Set<() => void>>();
  let _currentTime = 0;
  const on =
    (ev: string) =>
    (cb: () => void): (() => void) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      listeners.get(ev)!.add(cb);
      return () => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        listeners.get(ev)!.delete(cb);
      };
    };
  const media: CompanionBridgeMedia & { fire: (ev: string) => void; _setCurrentTime: (t: number) => void } = {
    setSrc: vi.fn(),
    load: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    seekTo: vi.fn(),
    currentTime: () => _currentTime,
    _setCurrentTime: (t: number) => { _currentTime = t; },
    onLoadedMetadata: on('loadedmetadata'),
    onCanPlay: on('canplay'),
    onSeeked: on('seeked'),
    onPlaying: on('playing'),
    onError: on('error'),
    fire(ev: string) {
      listeners.get(ev)?.forEach((cb) => cb());
    },
  };
  return media;
}

function makeController(overrides: CompanionBridgeOptions = {}) {
  const phases: CompanionBridgePhase[] = [];
  const bridge = new CompanionBridge(overrides, {
    onPhaseChange: (p) => {
      phases.push(p);
    },
  });
  return { bridge, phases };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ED-2E companion bridge', () => {
  it('polls status at the fixed base interval while availability is static (no exponential backoff during buffering)', async () => {
    const { calls, times, fetchFn } = makeFetcher([
      buffering(100, 1000),
      buffering(100, 1000),
      buffering(100, 1000),
      buffering(100, 1000),
      buffering(100, 1000),
    ]);
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE);
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:4322/v1/media/status?token=tok123',
    );
    const t0 = times[0] ?? 0;

    // 2026-08-09 fix: buffering polls at the FIXED base interval — the old
    // exponential backoff (1→2→4→8→16→30 s) delayed "avail>0" detection by
    // up to 30 s even though the .part completes in seconds.
    await vi.advanceTimersByTimeAsync(BRIDGE_BASE_POLL_MS - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // t0 + 1000
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000); // +1000
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000); // +1000
    expect(calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1000); // +1000
    expect(calls).toHaveLength(5);

    const gaps = [1, 2, 3].map((i) => (times[i] ?? 0) - (times[i - 1] ?? 0));
    expect(gaps).toEqual([1000, 1000, 1000]);
    void t0;
  });

  it('keeps the base poll interval whether availability is static or advances', async () => {
    const { calls, times, fetchFn } = makeFetcher([
      buffering(100, 1000),
      buffering(200, 1000), // progress — still fixed interval
      buffering(200, 1000),
      buffering(300, 1000),
    ]);
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE);
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(calls).toHaveLength(3);
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBe(1000);

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(calls).toHaveLength(4);
  });

  it('ignores Retry-After during buffering (fixed fast poll wins)', async () => {
    // Retry-After was honored by the old backoff; buffering now polls at
    // the fixed base interval so the companion detects playable ~1 s after
    // it appears, regardless of the hint.
    const { times, fetchFn } = makeFetcher([
      buffering(100, 1000, 3), // Retry-After 3s — ignored
      buffering(100, 1000),
    ]);
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE);
    await flush();

    await vi.advanceTimersByTimeAsync(999);
    expect(times).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toHaveLength(2);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(1000);
  });

  it('detects avail>0 quickly: playable within ~2 s of a buffering start', async () => {
    // Companion job (Speed): .part completes a few seconds after the job
    // starts. With the fixed 1 s buffering poll, the bridge must surface
    // the media URL within ~2 s of the first poll.
    const { fetchFn } = makeFetcher([
      buffering(0, 1000),
      buffering(0, 1000),
      playable(300, 1000),
    ]);
    const media = makeMedia();
    const { bridge, phases } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();
    expect(bridge.currentPhase).toBe('buffering');

    await vi.advanceTimersByTimeAsync(1000); // 2nd poll: still buffering
    await flush();
    expect(bridge.currentPhase).toBe('buffering');

    await vi.advanceTimersByTimeAsync(1000); // 3rd poll: playable
    await flush();
    expect(bridge.currentPhase).toBe('ready');
    expect(phases).toContain('ready');
    expect(media.setSrc).toHaveBeenCalledWith(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );
    expect(media.load).toHaveBeenCalledTimes(1);
  });

  it('never runs parallel polls (single in-flight)', async () => {
    const slow = deferred<Response>();
    const { calls, fetchFn } = makeFetcher([slow.promise, buffering(100, 1000)]);
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE);
    await flush();

    expect(calls).toHaveLength(1); // first poll in flight

    // Advance far past any hypothetical retry: the in-flight guard must
    // keep the poll count at exactly one.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(calls).toHaveLength(1);

    slow.resolve(buffering(100, 1000));
    await flush();
    await vi.advanceTimersByTimeAsync(1000); // scheduled next poll
    await flush();
    expect(calls).toHaveLength(2); // next poll is a fresh request
  });

  it('transitions buffering → ready on complete, assigns token URL, stops polling', async () => {
    const { calls, fetchFn } = makeFetcher([
      buffering(100, 1000),
      complete(1000),
    ]);
    const media = makeMedia();
    const { bridge, phases } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(bridge.currentPhase).toBe('ready');
    expect(phases).toContain('ready');
    expect(media.setSrc).toHaveBeenCalledWith(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );
    expect(media.load).toHaveBeenCalledTimes(1);

    // Ready is terminal for polling: no further status requests.
    const callsAfterReady = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(callsAfterReady);
  });

  it('plays after loadedmetadata when the user intent is play', async () => {
    const { fetchFn } = makeFetcher([complete(1000)]);
    const media = makeMedia();
    const { bridge, phases } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();

    expect(bridge.currentPhase).toBe('ready');
    expect(media.play).not.toHaveBeenCalled();

    media.fire('loadedmetadata');
    expect(media.play).toHaveBeenCalledTimes(1);

    media.fire('playing');
    expect(bridge.currentPhase).toBe('playing');
    expect(phases).toContain('playing');
  });

  it('stays paused after loadedmetadata when the user paused while buffering', async () => {
    const { fetchFn } = makeFetcher([complete(1000)]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    bridge.setPlayIntent(false); // user pressed pause during buffering
    await flush();

    expect(bridge.currentPhase).toBe('ready');
    media.fire('loadedmetadata');
    expect(media.play).not.toHaveBeenCalled();
  });

  it('applies the latest pending seek after loadedmetadata, then plays after seeked', async () => {
    const { fetchFn } = makeFetcher([complete(1000)]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    bridge.requestSeek(1); // seek intent during buffering
    bridge.requestSeek(2); // latest wins
    await flush();

    expect(bridge.currentPhase).toBe('ready');
    media.fire('loadedmetadata');
    expect(media.seekTo).toHaveBeenCalledTimes(1);
    expect(media.seekTo).toHaveBeenCalledWith(2);
    expect(media.play).not.toHaveBeenCalled(); // wait for the seek to land

    media.fire('seeked');
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it('maps 401 and 403 to rePairRequired with no retries', async () => {
    for (const status of [401, 403] as const) {
      const { calls, fetchFn } = makeFetcher([authError(status)]);
      const { bridge, phases } = makeController({ fetchFn });
      bridge.beginSession(SOURCE);
      await flush();

      expect(bridge.currentPhase).toBe('rePairRequired');
      expect(phases).toContain('rePairRequired');
      const after = calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls.length).toBe(after); // no retries on auth failures
    }
  });

  it('endSession aborts the in-flight poll and stops all polling', async () => {
    const slow = deferred<Response>();
    const { calls, fetchFn } = makeFetcher([slow.promise]);
    const media = makeMedia();
    const { bridge, phases } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(false);

    bridge.endSession();
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(bridge.currentPhase).toBe('idle');
    expect(phases).toContain('idle');

    slow.resolve(buffering(100, 1000)); // settle the stale promise
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1); // nothing rescheduled
  });

  it('bounds transient non-2xx failures into error', async () => {
    const { calls, fetchFn } = makeFetcher([
      serverError(),
      serverError(),
      serverError(),
      serverError(),
      serverError(),
    ]);
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE);
    await flush();
    expect(bridge.currentPhase).toBe('buffering'); // before failures resolve

    await vi.advanceTimersByTimeAsync(40_000);
    expect(bridge.currentPhase).toBe('error');
    expect(calls).toHaveLength(5);
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(after);
  });

  it('transport failures → disconnected, then error after the bound', async () => {
    // Empty queue → every fetch rejects (transport failure).
    const { calls, fetchFn } = makeFetcher([]);
    const { bridge, phases } = makeController({ fetchFn });
    bridge.beginSession(SOURCE);
    await flush();

    expect(bridge.currentPhase).toBe('disconnected');
    expect(phases).toContain('disconnected');

    // Disconnected retries use the fixed 5s interval; after the bound → error.
    await vi.advanceTimersByTimeAsync(BRIDGE_DISCONNECTED_POLL_MS * 7);
    expect(bridge.currentPhase).toBe('error');
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(after);
  });

  it('buffering wall-clock cap moves to error', async () => {
    const many = Array.from({ length: 100 }, () => buffering(100, 1000));
    const { calls, fetchFn } = makeFetcher(many);
    const { bridge } = makeController({ fetchFn, totalWaitMs: 60_000 });
    bridge.beginSession(SOURCE);
    await flush();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(bridge.currentPhase).toBe('error');
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(after);
  });

  it('media error while ready: complete status → explicit reset, bounded, then error', async () => {
    // One response for the initial poll, then three for the media-error
    // re-checks (complete each time → two resets, then exhausted).
    const { fetchFn } = makeFetcher([
      complete(1000),
      complete(1000),
      complete(1000),
      complete(1000),
    ]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();
    expect(media.setSrc).toHaveBeenCalledTimes(1);

    // Media errors re-check status; while it reports complete the bridge
    // re-issues the explicit src/load reset (the measured recovery path).
    media.fire('error');
    await flush();
    expect(media.setSrc).toHaveBeenCalledTimes(2);
    expect(media.load).toHaveBeenCalledTimes(2);

    media.fire('error');
    await flush();
    expect(media.setSrc).toHaveBeenCalledTimes(3);

    // Third failure exhausts the bounded resets → error (no infinite loop).
    media.fire('error');
    await flush();
    expect(bridge.currentPhase).toBe('error');
    const setSrcMock = media.setSrc as unknown as { mock: { calls: unknown[] } };
    const after = setSrcMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(setSrcMock.mock.calls.length).toBe(after);
  });

  it('media error while ready: buffering status → back to buffering + polling resumes', async () => {
    const { calls, fetchFn } = makeFetcher([
      complete(1000),
      buffering(500, 1000), // status re-check result after the media error
      buffering(600, 1000),
    ]);
    const media = makeMedia();
    const { bridge, phases } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();
    expect(bridge.currentPhase).toBe('ready');

    media.fire('error');
    await flush();
    expect(bridge.currentPhase).toBe('buffering');
    expect(phases).toContain('buffering');

    // Polling resumed at the base interval.
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(calls.length).toBe(3);
  });

  it('media error while buffering: re-checks status; playable → ready + src/load', async () => {
    // Initial poll returns buffering; browser fires error from a 503;
    // error re-check returns playable → transition to ready + src/load.
    const { fetchFn } = makeFetcher([
      buffering(100, 1000),
      playable(200, 1000), // status re-check after the media error
    ]);
    const media = makeMedia();
    const { bridge, phases } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();
    expect(bridge.currentPhase).toBe('buffering');

    // Browser fires error from503 while bridge is buffering.
    media.fire('error');
    await flush();

    // The error re-check returned "playable" → bridge transitions to ready.
    expect(bridge.currentPhase).toBe('ready');
    expect(phases).toContain('ready');
    expect(media.setSrc).toHaveBeenCalledWith(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );
    expect(media.load).toHaveBeenCalledTimes(1);
  });

  it('media error while buffering: buffering status → stays buffering, polling resumes', async () => {
    const { calls, fetchFn } = makeFetcher([
      buffering(100, 1000),
      buffering(200, 1000), // status re-check still buffering
      buffering(300, 1000),
    ]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();
    expect(bridge.currentPhase).toBe('buffering');

    media.fire('error');
    await flush();
    // Still buffering — the error was transient (503 before prefix ready).
    expect(bridge.currentPhase).toBe('buffering');

    // Polling continues.
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(calls.length).toBe(3);
  });

  it('media error while ready: 401 re-check → rePairRequired', async () => {
    const { fetchFn } = makeFetcher([complete(1000), authError(401)]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();
    expect(bridge.currentPhase).toBe('ready');

    media.fire('error');
    await flush();
    expect(bridge.currentPhase).toBe('rePairRequired');
  });

  it('attachMedia after ready performs the pending src/load transition', async () => {
    const { fetchFn } = makeFetcher([complete(1000)]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE); // no media element yet
    await flush();

    expect(bridge.currentPhase).toBe('ready');
    expect(media.setSrc).not.toHaveBeenCalled();

    bridge.attachMedia(media);
    expect(media.setSrc).toHaveBeenCalledWith(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );
    expect(media.load).toHaveBeenCalledTimes(1);
  });

  it('attachMedia during buffering binds the error listener: initial 503 → playable → ready + src/load', async () => {
    // The element mounts while the bridge is still buffering (the player
    // surfaces the URL immediately). The browser fires an error from the
    // 503 before the prefix exists; attachMedia must have bound the error
    // listener so the re-check runs, keeps polling alive, and recovers
    // with an explicit src/load once the status turns playable.
    const { fetchFn } = makeFetcher([
      buffering(100, 1000),
      playable(300, 1000), // status re-check after the media error
    ]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE); // no element at begin
    await flush();
    expect(bridge.currentPhase).toBe('buffering');

    bridge.attachMedia(media); // element mounts during buffering
    media.fire('error'); // browser error from the 503
    await flush();

    expect(bridge.currentPhase).toBe('ready');
    expect(media.setSrc).toHaveBeenCalledWith(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );
    expect(media.load).toHaveBeenCalledTimes(1);
  });

  it('attachMedia binds the error listener exactly once (no duplicate re-checks)', async () => {
    // A single error event must trigger exactly one status re-check. A
    // duplicated listener would fire onMediaError twice → two fetches.
    const { calls, fetchFn } = makeFetcher([
      buffering(100, 1000),
      buffering(200, 1000), // re-check result
      buffering(300, 1000),
    ]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE);
    await flush();

    bridge.attachMedia(media);
    media.fire('error');
    await flush();

    // Initial poll + exactly one re-check: no duplicate listener.
    expect(calls).toHaveLength(2);
    expect(bridge.currentPhase).toBe('buffering');
  });

  it('transitions buffering → ready on "playable" (progressive streaming), keeps slow poll', async () => {
    const { calls, fetchFn } = makeFetcher([
      buffering(100, 1000),
      playable(200, 1000),
    ]);
    const media = makeMedia();
    const { bridge, phases } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(bridge.currentPhase).toBe('ready');
    expect(phases).toContain('ready');
    expect(media.setSrc).toHaveBeenCalledWith(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );
    expect(media.load).toHaveBeenCalledTimes(1);

    // Unlike complete, playable keeps a slow poll alive for full completion.
    const callsAfterReady = calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBeGreaterThan(callsAfterReady);
  });

  it('repeated "playable" while ready/playing does not re-run src/load', async () => {
    const { calls, fetchFn } = makeFetcher([
      playable(200, 1000),
      playable(400, 1000),
      playable(600, 1000),
    ]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();

    // First playable triggers the src/load transition.
    expect(bridge.currentPhase).toBe('ready');
    expect(media.setSrc).toHaveBeenCalledTimes(1);
    expect(media.load).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);

    // Second playable: keep polling but never reset the element.
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(calls).toHaveLength(2);
    expect(media.setSrc).toHaveBeenCalledTimes(1);
    expect(media.load).toHaveBeenCalledTimes(1);

    // Third playable confirms the pattern holds across multiple polls.
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(calls).toHaveLength(3);
    expect(media.setSrc).toHaveBeenCalledTimes(1);
    expect(media.load).toHaveBeenCalledTimes(1);
  });

  it('playable after media error recovery still allows src/load reset', async () => {
    const { fetchFn } = makeFetcher([
      complete(1000),
      playable(1000, 1000),
    ]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();
    expect(media.setSrc).toHaveBeenCalledTimes(1);

    // While ready, a media error re-check returns playable.
    // onMediaError must still be able to trigger startReadyTransition.
    media.fire('error');
    await flush();

    expect(bridge.currentPhase).toBe('ready');
    expect(media.setSrc).toHaveBeenCalledTimes(2);
    expect(media.load).toHaveBeenCalledTimes(2);
  });

  it('requestSeek skips seekTo when playing and currentTime matches (±0.01s)', async () => {
    const { fetchFn } = makeFetcher([complete(1000)]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();

    // Transition to playing.
    media.fire('loadedmetadata');
    media.fire('playing');
    expect(bridge.currentPhase).toBe('playing');

    // Set current time to 5.0 seconds.
    media._setCurrentTime(5.0);

    // requestSeek with the same value should be skipped.
    bridge.requestSeek(5.0);
    expect(media.seekTo).not.toHaveBeenCalled();

    // requestSeek with a different value should proceed.
    bridge.requestSeek(10.0);
    expect(media.seekTo).toHaveBeenCalledTimes(1);
    expect(media.seekTo).toHaveBeenCalledWith(10.0);
  });

  it('requestSeek allows seekTo when playing and currentTime is far from target', async () => {
    const { fetchFn } = makeFetcher([complete(1000)]);
    const media = makeMedia();
    const { bridge } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();

    media.fire('loadedmetadata');
    media.fire('playing');
    media._setCurrentTime(5.0);

    // requestSeek with a different value (> 0.01s away) should proceed.
    bridge.requestSeek(5.02); // exactly 0.02s away — should proceed
    expect(media.seekTo).toHaveBeenCalledTimes(1);
    expect(media.seekTo).toHaveBeenCalledWith(5.02);
  });

  it('complete during playing does not reset src/load (preserves position)', async () => {
    const { calls, fetchFn } = makeFetcher([
      complete(1000),
      complete(1000), // second poll: still complete
    ]);
    const media = makeMedia();
    const { bridge, phases } = makeController({ fetchFn });
    bridge.beginSession(SOURCE, media);
    await flush();

    // Transition to playing.
    media.fire('loadedmetadata');
    media.fire('playing');
    expect(bridge.currentPhase).toBe('playing');
    expect(media.setSrc).toHaveBeenCalledTimes(1);

    // Second poll returns complete while playing — should NOT re-set src/load.
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(media.setSrc).toHaveBeenCalledTimes(1); // no additional setSrc
    expect(media.load).toHaveBeenCalledTimes(1); // no additional load

    // Phase should remain 'playing'.
    expect(bridge.currentPhase).toBe('playing');
    void calls;
    void phases;
  });
});
