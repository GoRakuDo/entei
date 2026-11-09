/**
 * Native torrent start-buffering overlay — "black screen wait".
 * ---------------------------------------------------------------------------
 * When the torrent relay URL is mounted but
 * no current frame is available yet (readyState < HAVE_CURRENT_DATA or a
 * `waiting` event) for more than 2 s, PlayerApp shows the "Preparing video…" overlay
 * — the same copy as the pre-URL loading overlay, at a larger responsive
 * size. The 2 s debounce prevents flashing for fast starts: a 1–2 s load
 * never shows the overlay at all.
 *
 * Clear condition is the first PAINTED frame. On rVFC browsers the 2 s
 * debounce re-check ignores readyState: only a presented frame with real
 * pixels (meta.width/height > 0) ends the wait, and showing the overlay
 * also requests that frame. loadeddata / canplay / playing only REQUEST a
 * frame callback; a 0x0 black frame keeps the overlay up. Without rVFC the
 * re-check uses HAVE_FUTURE_DATA (3) or active playback, and loadeddata /
 * canplay / PLAYING clear immediately. Once cleared the source is latched
 * in a ref, so a later 'waiting' or a session re-render
 * cannot resurrect the start overlay. The 3 s safety bound remains the
 * last resort for stalled/autoplay-blocked downloads: it is armed once at
 * the first arm (2 s debounce + 3 s = 5 s absolute), so fragmented
 * `waiting` events cannot postpone it.
 *
 * Drives the real PlayerApp with a mocked (controllable) torrent session and a
 * real <video> element (jsdom readyState = 0), advancing fake timers.
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import PlayerApp from '@/components/player/PlayerApp';

// --- Controllable native torrent session ---
let mockSession: {
  active: boolean;
  id: string | null;
  mediaUrl: string | null;
  beginSession: ReturnType<typeof vi.fn>;
  cancelActiveSession: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
  attachMediaElement: ReturnType<typeof vi.fn>;
};

vi.mock('@/features/player/use-torrent-session', () => ({
  useTorrentSession: () => mockSession,
}));

const MEDIA_URL = 'http://127.0.0.1:45678/stream/torrent-1';

/** Debounce before the start-buffering overlay appears (PlayerApp). */
const START_BUFFERING_DELAY_MS = 2000;
/** Absolute bound measured from the FIRST arm (debounce + 3 s). */
const START_BUFFERING_SAFETY_MS = START_BUFFERING_DELAY_MS + 3000;

function freshSession() {
  return {
    active: false,
    id: null as string | null,
    mediaUrl: null as string | null,
    beginSession: vi.fn(),
    cancelActiveSession: vi.fn(() => Promise.resolve()),
    endSession: vi.fn(),
    attachMediaElement: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockSession = freshSession();
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as typeof window.matchMedia);
  if (!('ResizeObserver' in window)) {
    (window as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // jsdom video elements never fire media events on their own; the fetch
  // stub keeps the subtitle/title polls from touching the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
  );
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Remove the rVFC prototype mocks so other suites see the plain jsdom
  // video element again.
  delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)
    .requestVideoFrameCallback;
  delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)
    .cancelVideoFrameCallback;
});

/**
 * Install requestVideoFrameCallback / cancelVideoFrameCallback on the
 * HTMLVideoElement prototype (= "Chromium-capable browser") for a single
 * test. The installed request mock records the pending frame callback so
 * a test can fire it manually with any VideoFrameCallbackMetadata
 * (e.g. width/height = 0 for a black frame; 1280/720 for a real one),
 * and the cancel mock records invocations for cleanup assertions. A new
 * registration replaces the pending callback, mirroring Chromium's
 * one-shot per-callback semantics.
 */
function installRVFCPrototype() {
  let callback: ((now: number, meta: unknown) => void) | null = null;
  let nextHandle = 1;
  const requestMock = vi.fn((cb: (now: number, meta: unknown) => void) => {
    callback = cb;
    return nextHandle++;
  });
  const cancelMock = vi.fn();
  const fire = (meta: unknown) => {
    const cb = callback;
    callback = null;
    if (cb) {
      cb(0, meta);
    }
  };
  (
    HTMLVideoElement.prototype as unknown as Record<string, unknown>
  ).requestVideoFrameCallback = requestMock;
  (
    HTMLVideoElement.prototype as unknown as Record<string, unknown>
  ).cancelVideoFrameCallback = cancelMock;
  return {
    fire,
    requestMock,
    cancelMock,
    hasRegisteredCallback: () => callback !== null,
  };
}

describe('native torrent start-buffering overlay (black-screen wait)', () => {
  it('shows the overlay when readyState < 2 persists for over 2 s', async () => {
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    // jsdom: readyState = 0 < HAVE_CURRENT_DATA(2).
    expect((video as HTMLVideoElement).readyState).toBeLessThan(2);

    // Before the 2 s debounce: no overlay yet (a 1–2 s load stays silent).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS - 1);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();

    // 2 s reached with data still missing: overlay appears.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const overlay = container.querySelector('.entei-start-buffering');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('.entei-typewriter--start')).not.toBeNull();
    expect(
      overlay!.querySelector('.entei-start-buffering-text'),
    ).not.toBeNull();
  });

  it('stays visible on canplay without current-frame data (playing clears it on non-rVFC browsers)', async () => {
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    const video = container.querySelector('video');
    expect(video).not.toBeNull();

    // jsdom keeps readyState at 0, so this synthetic canplay carries no
    // current-frame data: the overlay must stay (the black gap is still
    // guarded). Only a playing event clears it on non-rVFC browsers —
    // see the tests below for canplay WITH a current frame.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.canPlay(video!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS - 500);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // Only the actual playing event clears it (picture visible now).
    await act(async () => {
      video!.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('hides the overlay once playing fires (non-rVFC fallback)', async () => {
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    // Overlay appears after 2 s of no data.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // playing clears it.
    const video = container.querySelector('video');
    await act(async () => {
      video!.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('does NOT show when no torrent relay URL is active', async () => {
    mockSession.active = false;
    mockSession.id = null;
    mockSession.mediaUrl = null;
    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('does NOT show when the torrent session is inactive', async () => {
    mockSession.active = false;
    mockSession.id = null;
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('hides the overlay when the element errors', async () => {
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    // Overlay appears after 2 s of no data.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // The video element errors → overlay must clear (no lingering).
    const video = container.querySelector('video');
    fireEvent.error(video!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('hides the overlay after the 3 s safety bound (no playing)', async () => {
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // Still visible before the bound elapses…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_SAFETY_MS - START_BUFFERING_DELAY_MS - 1);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // …and gone at the 3 s safety bound even though playing never fired.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('stays hidden after the 3 s safety bound — a later waiting event does NOT re-arm it', async () => {
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    // Overlay appears after 2 s of no data…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // …and is force-cleared at the 3 s safety bound.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();

    // A later 'waiting' event must NOT re-arm the overlay: the job never
    // plays (autoplay blocked), and the controls must stay usable — no
    // perpetual re-showing loop.
    const video = container.querySelector('video');
    fireEvent.waiting(video!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('fragmented waiting every 500 ms cannot postpone the 2 s + 3 s bound', async () => {
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);
    const video = container.querySelector('video') as HTMLVideoElement;

    // Fire `waiting` INSIDE the 2 s debounce repeatedly. The old code
    // cleared both timers on every call, so the debounce never settled and
    // the safety bound was never even armed.
    const stall = async (ms: number) => {
      fireEvent.waiting(video);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    await stall(500); // t=500
    await stall(500); // t=1000 — debounce has not fired yet
    await stall(500); // t=1500 — still no overlay
    expect(container.querySelector('.entei-start-buffering')).toBeNull();

    await stall(500); // t=2000 — debounce fires from the first arm
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    await stall(500); // t=2500
    await stall(500); // t=3000
    await stall(500); // t=3500
    await stall(500); // t=4000
    await stall(999); // t=4999 — still inside the bound
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // The absolute 2 s + 3 s bound fires at t=5000, NOT at
    // 5000 + (number of stalls × 500 ms).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();

    // Latched: after the bound the source never re-arms, even after the
    // stalls stop and another `waiting` arrives.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await stall(2000);
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('renders only ONE overlay when both start- and seek-buffering are armed', async () => {
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    // Start buffering arms on mount (readyState 0): overlay after 2 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // Force the seek-buffering path on top: fire seeking with
    // readyState still below HAVE_FUTURE_DATA; after its own 1 s delay
    // both states are true, but only one overlay is rendered.
    const video = container.querySelector('video');
    fireEvent.seeking(video!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const loaders = container.querySelectorAll('.entei-player-buffering-overlay');
    expect(loaders.length).toBe(1);
    // The visible loader is the seek-buffering one — the start overlay
    // is suppressed by the mutual exclusion.
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('rVFC browser: playing alone does NOT clear — the first painted frame does', async () => {
    const rvfc = installRVFCPrototype();
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    // Overlay appears after 2 s of no data.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // playing fires (audio started) but no frame is painted yet — the
    // overlay MUST stay: the black picture is exactly the case rVFC
    // guards (audio-first interleave).
    const video = container.querySelector('video');
    video!.dispatchEvent(new Event('playing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();
    expect(rvfc.hasRegisteredCallback()).toBe(true);

    // The first frame with real pixels is painted → the rVFC callback
    // fires with width/height metadata → cleared.
    act(() => {
      rvfc.fire({ width: 1280, height: 720 });
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('rVFC browser: a black frame (0x0 metadata) does NOT clear — the next real frame does', async () => {
    const rvfc = installRVFCPrototype();
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // playing → rVFC registered.
    const video = container.querySelector('video');
    video!.dispatchEvent(new Event('playing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rvfc.hasRegisteredCallback()).toBe(true);

    // Chromium can present a black/empty frame before the first real
    // video sample: width/height = 0. The overlay must STAY and the
    // NEXT frame must be requested (one-shot re-registration).
    act(() => {
      rvfc.fire({ width: 0, height: 0 });
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();
    expect(rvfc.hasRegisteredCallback()).toBe(true); // re-registered
    // debounce + playing + black-frame re-registration
    expect(rvfc.requestMock).toHaveBeenCalledTimes(3);

    // The next frame has real pixels → cleared.
    act(() => {
      rvfc.fire({ width: 1280, height: 720 });
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('rVFC browser: loadeddata with a current frame waits for a real painted frame, even while paused', async () => {
    const rvfc = installRVFCPrototype();
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);
    const video = container.querySelector('video') as HTMLVideoElement;

    // The .part has no data yet: the overlay is up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // HAVE_CURRENT_DATA arrives while the element is STILL PAUSED (the
    // torrent src/load recovery path). Clearing here would bypass the
    // black-frame guard: rVFC browsers must only REQUEST the frame.
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: 2,
    });
    expect(video.paused).toBe(true);
    await act(async () => {
      fireEvent.loadedData(video);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();
    expect(rvfc.hasRegisteredCallback()).toBe(true);
    // debounce registration + loadeddata re-registration
    expect(rvfc.requestMock).toHaveBeenCalledTimes(2);

    // Chromium presents a 0x0 black frame first (audio-first interleave):
    // the overlay stays and the NEXT frame is requested.
    act(() => {
      rvfc.fire({ width: 0, height: 0 });
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();
    expect(rvfc.hasRegisteredCallback()).toBe(true);
    // + black-frame re-registration
    expect(rvfc.requestMock).toHaveBeenCalledTimes(3);

    // Real pixels clear immediately — no 'playing' event, still paused.
    act(() => {
      rvfc.fire({ width: 1280, height: 720 });
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
    expect(video.paused).toBe(true);

    // Latched for this source: a later 'waiting' must not resurrect it.
    fireEvent.waiting(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('rVFC browser: canplay with a current frame also defers to the painted frame', async () => {
    const rvfc = installRVFCPrototype();
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);
    const video = container.querySelector('video') as HTMLVideoElement;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: 3,
    });
    await act(async () => {
      fireEvent.canPlay(video);
    });
    // Still no clear: canplay is not proof of presented pixels.
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();
    expect(rvfc.hasRegisteredCallback()).toBe(true);

    act(() => {
      rvfc.fire({ width: 1920, height: 1080 });
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('rVFC browser: re-registers on each playing transition (later frames caught)', async () => {
    const rvfc = installRVFCPrototype();
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    const video = container.querySelector('video');

    // The 2 s debounce already registered once; each playing transition
    // re-registers (and cancels the stale handle) to catch later frames.
    video!.dispatchEvent(new Event('playing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rvfc.hasRegisteredCallback()).toBe(true);
    expect(rvfc.requestMock).toHaveBeenCalledTimes(2);

    // A second playing transition (seek/stall-recover) re-registers,
    // cancelling the stale handle first.
    video!.dispatchEvent(new Event('playing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rvfc.requestMock).toHaveBeenCalledTimes(3);
    expect(rvfc.cancelMock).toHaveBeenCalledTimes(2);
  });

  it('rVFC browser: switching jobs cancels the pending frame callback (cleanup)', async () => {
    const rvfc = installRVFCPrototype();
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { rerender } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    const video = document.querySelector('video');
    video!.dispatchEvent(new Event('playing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rvfc.hasRegisteredCallback()).toBe(true);
    // The playing re-registration above already cancelled the debounce
    // registration; isolate the cleanup cancellation for this assertion.
    rvfc.cancelMock.mockClear();

    // New job media URL → effect cleanup must cancel the stale rVFC
    // handle (the old source is being torn down).
    mockSession.mediaUrl = 'http://127.0.0.1:45678/stream/torrent-other';
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rvfc.cancelMock).toHaveBeenCalled();
  });

  // The next two cases exercise the non-rVFC fallback: with no frame
  // metadata, HAVE_CURRENT_DATA / playing are the best available signals.
  // rVFC browsers defer the clear to a painted frame (see the tests above).
  it('hides the overlay immediately on loadeddata with a current frame, even while paused', async () => {
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);
    const video = container.querySelector('video') as HTMLVideoElement;

    // 2 s debounce with no frame: the overlay is up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // The torrent relay src/load lands the first frame. jsdom has no media
    // pipeline, so mirror HAVE_CURRENT_DATA explicitly; the element stays
    // paused (no 'playing' event is fired at all).
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: 2,
    });
    expect(video.paused).toBe(true);
    await act(async () => {
      fireEvent.loadedData(video);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();

    // A later 'waiting' must not resurrect the overlay while that frame
    // is still the current one.
    fireEvent.waiting(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('hides on canplay with a current frame and does not re-arm on effect re-run', async () => {
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container, rerender } = render(<PlayerApp />);
    const video = container.querySelector('video') as HTMLVideoElement;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: 3,
    });
    await act(async () => {
      fireEvent.canPlay(video);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();

    // A session re-render re-runs the effect (cleanup + re-attach). With a
    // current frame present the fresh effect must not arm the 2 s timer —
    // previously the paused element re-armed and the overlay came back.
    mockSession.active = false;
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('keeps the source latch across session re-renders — a later waiting never resurrects the overlay', async () => {
    const rvfc = installRVFCPrototype();
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container, rerender } = render(<PlayerApp />);
    const video = container.querySelector('video') as HTMLVideoElement;

    // The overlay is up while the .part has no playable frame.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // playing -> rVFC -> the first REAL frame clears (and latches this source).
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      rvfc.fire({ width: 1280, height: 720 });
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();

    // active session re-render re-runs the effect (cleanup + re-attach). The old
    // in-effect `let` latch reset to false here; drop readyState back to 0
    // so ONLY a source-scoped latch can suppress re-arming.
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: 0,
    });
    mockSession.active = true;
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.waiting(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
    expect(rvfc.hasRegisteredCallback()).toBe(false);
  });

  it('rVFC browser: loadeddata BEFORE the 2 s debounce still guards the black frame until real pixels', async () => {
    const rvfc = installRVFCPrototype();
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);
    const video = container.querySelector('video') as HTMLVideoElement;

    // A PAUSED element reports HAVE_CURRENT_DATA within the debounce
    // window, but no real pixels have been presented yet (audio-first
    // .part: readyState is not proof of a painted frame on rVFC browsers).
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: 2,
    });
    expect(video.paused).toBe(true);
    await act(async () => {
      fireEvent.loadedData(video);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();

    // The 2 s re-check must ignore readyState and show the overlay, then
    // wait for the first painted frame via rVFC.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS - 300);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();
    expect(rvfc.hasRegisteredCallback()).toBe(true);

    // A 0x0 black frame keeps the overlay up...
    act(() => {
      rvfc.fire({ width: 0, height: 0 });
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // ...and real pixels clear it immediately, still paused.
    act(() => {
      rvfc.fire({ width: 1280, height: 720 });
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
    expect(video.paused).toBe(true);
  });

  it('non-rVFC: a silent HAVE_CURRENT_DATA jump does not suppress the 2 s debounce', async () => {
    mockSession.active = true;
    mockSession.id = 'torrent-1';
    mockSession.mediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);
    const video = container.querySelector('video') as HTMLVideoElement;

    // readyState changes without any loadeddata/canplay/playing event:
    // HAVE_CURRENT_DATA alone is not enough for the non-rVFC fallback.
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: 2,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_BUFFERING_DELAY_MS);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // HAVE_FUTURE_DATA or a real playing transition ends the wait.
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });
});
