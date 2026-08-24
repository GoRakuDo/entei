import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RightPanel } from '@/components/player/RightPanel';
import { en } from '@i18n/locales/en';

const dict = en.playerUI;

function renderPanel(overrides: {
  onSyncSubtitle?: () => void;
  canSyncSubtitle?: boolean;
  isSyncingSubtitle?: boolean;
  syncMode?: 'subtitle' | 'audio' | 'auto';
  hideSyncSubtitle?: boolean;
} = {}) {
  return render(
    <RightPanel
      visible
      dict={dict}
      cues={[]}
      activeCueId={null}
      onCueClick={vi.fn()}
      onSubtitleSelect={vi.fn()}
      subtitleAccept=".vtt,.srt"
      onSyncSubtitle={overrides.onSyncSubtitle}
      canSyncSubtitle={overrides.canSyncSubtitle}
      isSyncingSubtitle={overrides.isSyncingSubtitle}
      syncMode={overrides.syncMode}
      hideSyncSubtitle={overrides.hideSyncSubtitle}
    />,
  );
}

describe('RightPanel sync button', () => {
  it('renders the sync button with label + icon and is enabled by default', () => {
    renderPanel({ canSyncSubtitle: true });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncButtonLabel,
    });
    expect(btn.getAttribute('aria-label')).toBe(dict.subtitleSyncButtonLabel);
    expect(btn.getAttribute('title')).toBe(dict.subtitleSyncButton);
    expect(btn.textContent).toContain(dict.subtitleSyncButton);
    expect(btn.querySelector('svg')).not.toBeNull(); // RotateCwFadingClock icon
    expect(btn.getAttribute('disabled')).toBeNull();
  });

  it('fires onSyncSubtitle when clicked', () => {
    const onSync = vi.fn();
    renderPanel({ onSyncSubtitle: onSync, canSyncSubtitle: true });
    fireEvent.click(
      screen.getByRole('button', { name: dict.subtitleSyncButtonLabel }),
    );
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('disables when cannot sync (no subtitle text)', () => {
    renderPanel({ canSyncSubtitle: false });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncButtonLabel,
    });
    expect(btn.getAttribute('disabled')).not.toBeNull();
  });

  it('disables while syncing', () => {
    const onSync = vi.fn();
    renderPanel({ onSyncSubtitle: onSync, canSyncSubtitle: true, isSyncingSubtitle: true });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncButtonLabel,
    });
    expect(btn.getAttribute('disabled')).not.toBeNull();
    fireEvent.click(btn);
    expect(onSync).not.toHaveBeenCalled();
  });

  it('hides the sync button when hideSyncSubtitle is true', () => {
    renderPanel({ hideSyncSubtitle: true });
    expect(
      screen.queryByRole('button', { name: dict.subtitleSyncButtonLabel }),
    ).toBeNull();
  });
});

describe('RightPanel sync button — TypewriterLoading while sub-to-sub syncing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mock matchMedia to return no reduced-motion preference (the
    // TypewriterLoading animation then ticks with the fake timers).
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows TypewriterLoading inside the button while syncing in subtitle mode', async () => {
    renderPanel({
      canSyncSubtitle: true,
      isSyncingSubtitle: true,
      syncMode: 'subtitle',
    });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncButtonLabel,
    });

    // Icon + static label are replaced by the typewriter while syncing.
    const tw = btn.querySelector('.entei-typewriter--btn');
    expect(tw).not.toBeNull();
    expect(btn.querySelector('svg')).toBeNull();
    expect(btn.textContent).not.toContain(dict.subtitleSyncButton);

    // The typewriter types out "PROCESSING" (10 chars × 120ms delay).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * 11);
    });
    expect(tw!.textContent).toContain('PROCESSING');

    // Button stays disabled while syncing.
    expect(btn.getAttribute('disabled')).not.toBeNull();
  });

  it('keeps icon + label while syncing in audio mode', () => {
    renderPanel({
      canSyncSubtitle: true,
      isSyncingSubtitle: true,
      syncMode: 'audio',
    });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncButtonLabel,
    });

    // Audio sync keeps the regular icon + label (the DL-wait dialog
    // reports progress instead of the button).
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.querySelector('.entei-typewriter')).toBeNull();
    expect(btn.textContent).toContain(dict.subtitleSyncButton);
  });

  it('shows TypewriterLoading while syncing in auto mode', async () => {
    renderPanel({
      canSyncSubtitle: true,
      isSyncingSubtitle: true,
      syncMode: 'auto',
    });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncButtonLabel,
    });
    // Auto mode attempts sub-to-sub first — the typewriter is accurate
    // during that phase (the dialog takes over on audio fallback).
    expect(btn.querySelector('.entei-typewriter--btn')).not.toBeNull();
    expect(btn.querySelector('svg')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * 11);
    });
    expect(
      btn.querySelector('.entei-typewriter--btn')!.textContent,
    ).toContain('PROCESSING');
  });
});
