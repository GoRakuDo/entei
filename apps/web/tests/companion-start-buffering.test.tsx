/**
 * Companion start-buffering overlay — "black screen wait" (B).
 * ---------------------------------------------------------------------------
 * When the companion job media URL is surfaced (video element mounted) but
 * playback cannot start yet (readyState < HAVE_FUTURE_DATA or a `waiting`
 * event) for more than 1 s, PlayerApp shows the "Preparing video…" overlay
 * — the same copy as the pre-URL loading overlay, at a larger responsive
 * size. The 1 s debounce prevents flashing for fast starts.
 *
 * Clear condition is the PLAYING event, not canplay (2026-08-09): canplay
 * only means the element has data to start, while the first decoded frame
 * can still be a moment away — leaving a bare black 00:00/00:00 frame
 * after the overlay left. Playing fires when the picture actually
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
});

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

  it('stays visible after canplay alone (playing is what clears it)', async () => {
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

  it('hides the overlay once playing fires (first frame on screen)', async () => {
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
});