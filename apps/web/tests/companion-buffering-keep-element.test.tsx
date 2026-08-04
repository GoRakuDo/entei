/**
 * Companion buffering keep-element — integration regression (PlayerApp).
 *
 * Mimo review BLOCKER regression: `keepElementOnError` must key on the
 * uncleared loadError, NOT on the bridge phase. The bridge's recovery
 * transition (buffering → ready) re-renders React; a phase-based condition
 * flipped to false at that exact moment, unmounting the video element
 * before the bridge's explicit src/load — the loadeddata that clears
 * loadError never fired and "Aliran belum siap" stuck.
 *
 * This drives the real PlayerApp with a mocked (controllable) job session:
 * while an active session has a loadError, the video element stays mounted
 * even after phase becomes 'ready'; loadeddata (bridge recovery) clears
 * the overlay and keeps the element. The legacy standalone error state
 * (element unmounted) is covered by video-player.test.tsx at the
 * component level.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import PlayerApp from '@/components/player/PlayerApp';

// Mock the companion job session hook: a controllable fake mirroring the
// real hook's full result shape (companion-controls-repair pattern).
const session = {
  jobMediaUrl: null as string | null,
  kind: null as string | null,
  phase: 'idle' as string,
  active: false,
  progress: null as { available: number; total: number } | null,
  reason: null as string | null,
  errorCode: null as string | null,
  beginJobSession: vi.fn(),
  cancelActiveJob: vi.fn(() => Promise.resolve()),
  endJobSession: vi.fn(),
  attachMediaElement: vi.fn(),
  setPlayIntent: vi.fn(),
  requestSeek: vi.fn(),
};
vi.mock('@/features/player/use-companion-job-session', () => ({
  useCompanionJobSession: () => session,
}));

const MEDIA_URL = 'http://127.0.0.1:4322/v1/media/fixture?token=tok123';

beforeEach(() => {
  // PlayerApp requires matchMedia + ResizeObserver (jsdom lacks them).
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
  session.jobMediaUrl = null;
  session.kind = null;
  session.phase = 'idle';
  session.active = false;
  session.progress = null;
  session.reason = null;
  session.errorCode = null;
  session.attachMediaElement.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('companion buffering — keep element across bridge recovery', () => {
  it('keeps the video element mounted while a loadError is pending, even after phase becomes ready', () => {
    session.jobMediaUrl = MEDIA_URL;
    session.phase = 'buffering';
    session.active = true;
    const { container, rerender } = render(<PlayerApp />);

    const video = container.querySelector('video');
    expect(video).not.toBeNull();

    // The browser fires an error for the initial 503: loadError surfaces,
    // and the element must stay mounted (overlay, not unmount).
    fireEvent.error(video!);
    expect(container.querySelector('.entei-player-error-state')).not.toBeNull();
    expect(container.querySelector('video')).not.toBeNull();

    // Bridge completes: phase transitions buffering → ready, React
    // re-renders. With keepElementOnError keyed on loadError (not phase),
    // the element must survive this re-render — the phase change alone
    // must not unmount it (Mimo BLOCKER regression).
    session.phase = 'ready';
    rerender(<PlayerApp />);
    expect(container.querySelector('video')).not.toBeNull();
    expect(container.querySelector('.entei-player-error-state')).not.toBeNull();

    // The bridge's explicit src/load recovery fires loadeddata: loadError
    // clears via handleLoaded and the overlay disappears — element stays.
    fireEvent.loadedData(container.querySelector('video')!);
    expect(container.querySelector('.entei-player-error-state')).toBeNull();
    expect(container.querySelector('video')).not.toBeNull();
  });
});
