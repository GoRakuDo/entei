/**
 * Companion start-buffering overlay — "black screen wait" (B).
 * ---------------------------------------------------------------------------
 * When the companion job media URL is surfaced (video element mounted) but
 * playback cannot start yet (readyState < HAVE_FUTURE_DATA or a `waiting`
 * event) for more than 1 s, PlayerApp shows the "Preparing video…" overlay
 * — the same copy as the pre-URL loading overlay, at a larger responsive
 * size. The 1 s debounce prevents flashing for fast starts.
 *
 * Clear condition is the first painted frame (rVFC on Chromium, PLAYING
 * on other browsers), not canplay (2026-08-09): canplay only means the
 * element has data to start, while the first decoded frame can still be
 * a moment away — leaving a bare black 00:00/00:00 frame after the
 * overlay left. The rVFC/playing event fires when the picture actually
 * appears, so the overlay guards the black gap exactly. The 15 s safety
 * bound still hides it for stalled/autoplay-blocked downloads.
 *
 * Drives the real PlayerApp with a mocked (controllable) job session and a
 * real <video> element (jsdom readyState = 0), advancing fake timers.
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import PlayerApp from '@/components/player/PlayerApp';

// --- Controllable companion job session (companion-loading-overlay pattern) ---
let mockSession: {
  active: boolean;
  kind: string | null;
  phase: string;
  progress: { available: number; total: number } | null;
  reason: string | null;
  errorCode: string | null;
  jobMediaUrl: string | null;
  beginJobSession: ReturnType<typeof vi.fn>;
  cancelActiveJob: ReturnType<typeof vi.fn>;
  endJobSession: ReturnType<typeof vi.fn>;
  attachMediaElement: ReturnType<typeof vi.fn>;
  setPlayIntent: ReturnType<typeof vi.fn>;
  requestSeek: ReturnType<typeof vi.fn>;
};

vi.mock('@/features/player/use-companion-job-session', () => ({
  useCompanionJobSession: () => mockSession,
}));

const MEDIA_URL = 'http://127.0.0.1:4322/v1/media/fixture?token=tok123';

function freshSession() {
  return {
    active: false,
    kind: null as string | null,
    phase: 'idle' as string,
    progress: null as { available: number; total: number } | null,
    reason: null as string | null,
    errorCode: null as string | null,
    jobMediaUrl: null as string | null,
    beginJobSession: vi.fn(),
    cancelActiveJob: vi.fn(() => Promise.resolve()),
    endJobSession: vi.fn(),
    attachMediaElement: vi.fn(),
    setPlayIntent: vi.fn(),
    requestSeek: vi.fn(),
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

describe('companion start-buffering overlay (black-screen wait)', () => {
  it('shows the overlay when readyState < 2 persists for over 1 s', async () => {
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.jobMediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    // jsdom: readyState = 0 < HAVE_FUTURE_DATA(2).
    expect((video as HTMLVideoElement).readyState).toBeLessThan(2);

    // Before the 1 s debounce: no overlay yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();

    // 1 s reached with data still missing: overlay appears.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const overlay = container.querySelector('.entei-start-buffering');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('.entei-typewriter--start')).not.toBeNull();
    expect(
      overlay!.querySelector('.entei-companion-loading-text--start'),
    ).not.toBeNull();
  });

  it('stays visible after canplay alone (playing clears it on non-rVFC browsers)', async () => {
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.jobMediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    const video = container.querySelector('video');
    expect(video).not.toBeNull();

    // Data arrives (canplay) before the debounce elapses, but playback
    // has NOT started: the overlay must NOT clear on canplay — the first
    // frame is not on screen yet, so the black gap stays guarded.
    // (jsdom has no requestVideoFrameCallback, so this runs the 'playing'
    // fallback — see the rVFC suites below for the frame-based clear.)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.canPlay(video!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // Only the actual playing event clears it (picture visible now).
    video!.dispatchEvent(new Event('playing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('hides the overlay once playing fires (non-rVFC fallback)', async () => {
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.jobMediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    // Overlay appears after 1 s of no data.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // playing clears it.
    const video = container.querySelector('video');
    video!.dispatchEvent(new Event('playing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('does NOT show when the job media URL is not surfaced', async () => {
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'buffering';
    mockSession.jobMediaUrl = null;
    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('does NOT show when the job session is inactive', async () => {
    mockSession.active = false;
    mockSession.jobMediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('hides the overlay when the element errors', async () => {
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.jobMediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    // Overlay appears after 1 s of no data.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
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

  it('hides the overlay after the 15 s safety bound (no playing)', async () => {
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.jobMediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // Still visible before the bound elapses…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14999);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // …and gone at 15 s even though playing never fired.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('stays hidden after the 15 s safety bound — a later waiting event does NOT re-arm it', async () => {
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.jobMediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    // Overlay appears after 1 s of no data…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(container.querySelector('.entei-start-buffering')).not.toBeNull();

    // …and is force-cleared at the 15 s safety bound.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
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

  it('renders only ONE overlay when both start- and seek-buffering are armed', async () => {
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.jobMediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    // Start buffering arms on mount (readyState 0): overlay after 1 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
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
    const loaders = container.querySelectorAll('.entei-companion-loading');
    expect(loaders.length).toBe(1);
    // The visible loader is the seek-buffering one — the start overlay
    // is suppressed by the mutual exclusion.
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('rVFC browser: playing alone does NOT clear — the first painted frame does', async () => {
    const rvfc = installRVFCPrototype();
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.jobMediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    // Overlay appears after 1 s of no data.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
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
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.jobMediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
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
    expect(rvfc.requestMock).toHaveBeenCalledTimes(2);

    // The next frame has real pixels → cleared.
    act(() => {
      rvfc.fire({ width: 1280, height: 720 });
    });
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('rVFC browser: re-registers on each playing transition (later frames caught)', async () => {
    const rvfc = installRVFCPrototype();
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.jobMediaUrl = MEDIA_URL;
    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const video = container.querySelector('video');

    // First playing: rVFC registered (not fired).
    video!.dispatchEvent(new Event('playing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rvfc.hasRegisteredCallback()).toBe(true);
    expect(rvfc.requestMock).toHaveBeenCalledTimes(1);

    // A second playing transition (seek/stall-recover) re-registers,
    // cancelling the stale handle first.
    video!.dispatchEvent(new Event('playing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rvfc.requestMock).toHaveBeenCalledTimes(2);
    expect(rvfc.cancelMock).toHaveBeenCalledTimes(1);
  });

  it('rVFC browser: switching jobs cancels the pending frame callback (cleanup)', async () => {
    const rvfc = installRVFCPrototype();
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.jobMediaUrl = MEDIA_URL;
    const { rerender } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const video = document.querySelector('video');
    video!.dispatchEvent(new Event('playing'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rvfc.hasRegisteredCallback()).toBe(true);
    expect(rvfc.cancelMock).not.toHaveBeenCalled();

    // New job media URL → effect cleanup must cancel the stale rVFC
    // handle (the old source is being torn down).
    mockSession.jobMediaUrl = 'http://127.0.0.1:4322/v1/media/fixture?token=other';
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rvfc.cancelMock).toHaveBeenCalled();
  });
});
