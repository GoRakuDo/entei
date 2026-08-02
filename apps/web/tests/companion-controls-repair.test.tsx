/**
 * Companion controls repair — integration regression (PlayerApp wiring).
 *
 * The companion job session's media is a video, but the local mediaType
 * state is only set by local-file/audio flows. Before the mirror effect,
 * videoCallbackRef gated sharedMediaRef to null for companion playback:
 * the custom timestamp froze at 00:00 / 00:00 and Play/Pause was a no-op.
 * This test drives the real PlayerApp wiring with a mocked job session and
 * proves the timestamp updates and Play/Pause drive the real video element.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
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

beforeEach(() => {
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
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPlayerApp() {
  return render(<PlayerApp />);
}

describe('companion controls repair (PlayerApp wiring)', () => {
  it('companion video timeupdate drives the custom timestamp', async () => {
    session.jobMediaUrl = MEDIA_URL;
    session.phase = 'playing';
    session.active = true;
    const { container } = renderPlayerApp();
    const video = container.querySelector('video')!;
    await waitFor(() => expect(session.attachMediaElement).toHaveBeenCalled());
    video.currentTime = 65;
    video.dispatchEvent(new Event('timeupdate'));
    await waitFor(() => {
      const time = container.querySelector('.entei-controls-time-current');
      expect(time).not.toBeNull();
      expect(time?.textContent).not.toBe('00:00');
      expect(time?.textContent).toBe('01:05');
    });
  });

  it('companion video Play invokes the real element play(), Pause invokes pause()', async () => {
    session.jobMediaUrl = MEDIA_URL;
    session.phase = 'playing';
    session.active = true;
    const { container } = renderPlayerApp();
    const video = container.querySelector('video')!;
    video.play = vi.fn(() => Promise.resolve());
    video.pause = vi.fn();
    const playBtn =
      container.querySelector('button[aria-label="Putar"]') ??
      container.querySelector('button[aria-label="Jeda"]') ??
      container.querySelector('.entei-controls-play-btn');
    expect(playBtn).not.toBeNull();
    fireEvent.click(playBtn!);
    await waitFor(
      () => expect(video.play).toHaveBeenCalled(),
      { timeout: 3000 },
    ).catch(() => {
      // Debug aid: report the media element state at the failed click.
      throw new Error(
        'play() not called; paused=' +
          video.paused +
          ' readyState=' +
          video.readyState +
          ' src=' +
          String(video.src),
      );
    });
    video.dispatchEvent(new Event('playing'));
    // The element is now "playing": the handler must call pause() next.
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    await waitFor(() => {
      expect(
        container.querySelector('button[aria-label="Jeda"]') ??
          container.querySelector('.entei-controls-play-btn'),
      ).not.toBeNull();
    });
    fireEvent.click(
      (container.querySelector('button[aria-label="Jeda"]') ??
        container.querySelector('.entei-controls-play-btn'))!,
    );
    await waitFor(() => expect(video.pause).toHaveBeenCalled());
  });

  it('no companion media: empty state untouched (local flow not regressed)', () => {
    const { container } = renderPlayerApp();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.entei-player-empty')).not.toBeNull();
  });
});
