/**
 * PlayerApp module gate — MODULE_ARCHITECTURE.md §5.3 (phase 2-B).
 * ---------------------------------------------------------------------------
 * A disabled source module must not be reachable from the player: its
 * empty-state button disappears and its dialog cannot be opened. The local-file
 * picker is a built-in capability and must stay available in every case.
 *
 * Native module IPC is stubbed only when required — the real component must
 * prove enabled/disabled module visibility without a pairing dependency.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { act } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';

import PlayerApp from '@/components/player/PlayerApp';
import { MODULES_KEY } from '@/features/modules/modules-store';

function setModuleState(enabled: Record<string, boolean>) {
  localStorage.setItem(MODULES_KEY, JSON.stringify({ version: 1, enabled }));
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(min-width: 768px)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
  global.ResizeObserver = vi.fn(function () {
    return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  }) as unknown as typeof ResizeObserver;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('offline'))),
  );
});

afterEach(() => {
  localStorage.removeItem(MODULES_KEY);
  vi.unstubAllGlobals();
  cleanup();
});

describe('PlayerApp module gate', () => {
  it('shows both source buttons when the source modules are enabled', () => {
    render(<PlayerApp />);

    expect(
      document.querySelector('.entei-player-magnet-icon-btn'),
    ).not.toBeNull();
    expect(
      document.querySelector('.entei-player-youtube-icon-btn'),
    ).not.toBeNull();
  });

  it('hides the Magnet entry when the torrent module is disabled', () => {
    setModuleState({ torrent: false });
    render(<PlayerApp />);

    expect(document.querySelector('.entei-player-magnet-icon-btn')).toBeNull();
    expect(
      document.querySelector('.entei-player-youtube-icon-btn'),
    ).not.toBeNull();
  });

  it('hides the YouTube entry when the yt-dlp module is disabled', () => {
    setModuleState({ ytdlp: false });
    render(<PlayerApp />);

    expect(document.querySelector('.entei-player-youtube-icon-btn')).toBeNull();
    expect(
      document.querySelector('.entei-player-magnet-icon-btn'),
    ).not.toBeNull();
  });

  it('keeps the local-file picker when every source module is disabled', () => {
    setModuleState({ ytdlp: false, torrent: false });
    render(<PlayerApp />);

    expect(document.querySelector('.entei-player-magnet-icon-btn')).toBeNull();
    expect(document.querySelector('.entei-player-youtube-icon-btn')).toBeNull();
    expect(document.querySelector('.entei-player-empty-cta')).not.toBeNull();
  });

  it('renders the empty state as the local picker only with source modules disabled', () => {
    setModuleState({ ytdlp: false, torrent: false });
    render(<PlayerApp />);

    // The empty state core is the picker row: MediaPicker alone when every
    // module is off — the module slot contributes nothing.
    const pickers = document.querySelector('.entei-player-pickers');
    expect(pickers).not.toBeNull();
    expect(pickers!.querySelectorAll('button').length).toBe(1);

    // ED-3 setup section was removed from the player empty state entirely.
    expect(document.querySelector('.entei-eizou-section')).toBeNull();
  });

  it('renders one picker button per enabled module next to the local picker', () => {
    render(<PlayerApp />);

    const pickers = document.querySelector('.entei-player-pickers');
    expect(pickers).not.toBeNull();
    // MediaPicker + Magnet + YouTube.
    expect(pickers!.querySelectorAll('button').length).toBe(3);
  });

  it('suppresses the already-open Magnet dialog when torrent is disabled', () => {
    render(<PlayerApp />);

    const magnetButton = document.querySelector(
      '.entei-player-magnet-icon-btn',
    ) as HTMLElement;
    fireEvent.click(magnetButton);
    expect(document.querySelector('.entei-magnet-dialog')).not.toBeNull();

    // The user flips the module OFF on /modules/ in another tab.
    setModuleState({ torrent: false });
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: MODULES_KEY }));
    });

    expect(document.querySelector('.entei-magnet-dialog')).toBeNull();
    expect(document.querySelector('.entei-player-magnet-icon-btn')).toBeNull();
  });
});
