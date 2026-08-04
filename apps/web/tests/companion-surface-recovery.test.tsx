/**
 * Companion surface recovery — regression tests for the auto-hide deadlock.
 * ---------------------------------------------------------------------------
 * Magnet (companion session) playback streams media via jobMediaUrl only;
 * the local mediaUrl state stays null. Two related bugs made the controls
 * unrecoverable once the 2.5s auto-hide kicked in:
 *  1. PlayerApp.handleSurfaceClick gated on the local mediaUrl, so surface
 *     clicks were a no-op for every companion session.
 *  2. PlayerControls bound its pointermove handler to the controls layer
 *     itself, which has pointer-events: none while hidden — the handler
 *     could never fire again.
 * These tests drive the real PlayerApp (mocked companion session) through
 * the auto-hide timer and prove that a surface click and a surface
 * pointermove both restore the controls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import PlayerApp from '@/components/player/PlayerApp';

// Mock the companion job session hook: a controllable fake.
const session = {
  jobMediaUrl: null as string | null,
  phase: 'idle' as string,
  active: false,
  progress: null as { available: number; total: number } | null,
  beginJobSession: vi.fn(),
  endJobSession: vi.fn(),
  cancelActiveJob: vi.fn(() => Promise.resolve()),
  attachMediaElement: vi.fn(),
  requestSeek: vi.fn(),
  setPlayIntent: vi.fn(),
};
vi.mock('@/features/player/use-companion-job-session', () => ({
  useCompanionJobSession: () => session,
}));

const MEDIA_URL = 'http://127.0.0.1:4322/v1/media/fixture?token=tok123';
// The controls auto-hide after 2500ms of playback (PlayerControls).
const AUTO_HIDE_MS = 2500;

beforeEach(() => {
  // Fake timers so the auto-hide transition is driven deterministically
  // instead of waiting real 2.5s wall-clock time.
  vi.useFakeTimers();
  // PlayerApp requires matchMedia + ResizeObserver (jsdom lacks them).
  window.matchMedia = window.matchMedia ??
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
  session.jobMediaUrl = null;
  session.phase = 'idle';
  session.active = false;
  session.attachMediaElement.mockClear();
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

/** Render PlayerApp with an active companion job (jobMediaUrl only). */
async function renderCompanionPlayer() {
  session.jobMediaUrl = MEDIA_URL;
  session.phase = 'playing';
  session.active = true;
  const utils = render(<PlayerApp />);
  // Flush mount effects (bridge wiring, background connection) before the
  // test starts driving timers.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const video = utils.container.querySelector('video');
  if (video) {
    video.play = vi.fn(() => Promise.resolve());
  }
  return utils;
}

/** Start playback and wait out the 2.5s auto-hide timer. */
async function autoHideControls(container: HTMLElement) {
  const video = container.querySelector('video')!;
  fireEvent.play(video);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS + 100);
  });
}

describe('companion surface recovery (auto-hide deadlock)', () => {
  it('surface click restores auto-hidden controls (local mediaUrl is null)', async () => {
    const { container } = await renderCompanionPlayer();
    const surface = container.querySelector('.entei-player-surface')!;
    const layer = container.querySelector('.entei-controls-layer')!;
    expect(surface).not.toBeNull();
    expect(layer).not.toBeNull();

    await autoHideControls(container);
    expect(layer).toHaveClass('entei-controls-layer--hidden');

    // Regression gate: companion media has no local mediaUrl, so before
    // the fix this click hit the !mediaUrl early-return and was ignored.
    fireEvent.click(surface);
    expect(layer).not.toHaveClass('entei-controls-layer--hidden');
  });

  it('surface pointermove restores auto-hidden controls', async () => {
    const { container } = await renderCompanionPlayer();
    const surface = container.querySelector('.entei-player-surface')!;
    const layer = container.querySelector('.entei-controls-layer')!;

    await autoHideControls(container);
    expect(layer).toHaveClass('entei-controls-layer--hidden');

    // Regression gate: the pointermove listener must be bound to the
    // surface, not to the controls layer (pointer-events: none while
    // hidden), so a mouse move over the media area reveals the controls.
    fireEvent.pointerMove(surface);
    expect(layer).not.toHaveClass('entei-controls-layer--hidden');
  });
});
