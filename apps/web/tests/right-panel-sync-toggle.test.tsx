import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RightPanel } from '@/components/player/RightPanel';
import { en } from '@i18n/locales/en';

const dict = en.playerUI;

function renderPanel(overrides: {
  isMagnet?: boolean;
  lazySyncOn?: boolean;
  onToggleLazySync?: () => void;
  onSyncSubtitle?: () => void;
  canSyncSubtitle?: boolean;
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
      isMagnet={overrides.isMagnet}
      lazySyncOn={overrides.lazySyncOn}
      onToggleLazySync={overrides.onToggleLazySync}
    />,
  );
}

describe('RightPanel Magnet LazySync toggle', () => {
  it('renders an OFF toggle (normal look) when lazySyncOn is false', () => {
    renderPanel({ isMagnet: true, lazySyncOn: false, canSyncSubtitle: true });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncLazyOff,
    });
    expect(btn.getAttribute('aria-label')).toBe(dict.subtitleSyncLazyOff);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('title')).toBe(dict.subtitleSyncLazyOff);
    expect(btn.className).toContain('entei-subtitle-sync-button');
    expect(btn.className).not.toContain('entei-subtitle-sync-button--active');
    expect(btn.textContent).toContain(dict.subtitleSyncLazyOff);
    expect(btn.querySelector('svg')).not.toBeNull();
  });

  it('renders an ON toggle (active/colored class) when lazySyncOn is true', () => {
    renderPanel({ isMagnet: true, lazySyncOn: true, canSyncSubtitle: true });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncLazyOn,
    });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toContain('entei-subtitle-sync-button--active');
    expect(btn.textContent).toContain(dict.subtitleSyncLazyActive);
  });

  it('fires onToggleLazySync on click', () => {
    const onToggle = vi.fn();
    renderPanel({
      isMagnet: true,
      lazySyncOn: false,
      canSyncSubtitle: true,
      onToggleLazySync: onToggle,
    });
    fireEvent.click(
      screen.getByRole('button', { name: dict.subtitleSyncLazyOff }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('is disabled when no subtitle is loaded', () => {
    renderPanel({ isMagnet: true, lazySyncOn: false, canSyncSubtitle: false });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncLazyOff,
    });
    expect(btn.getAttribute('disabled')).not.toBeNull();
  });

  it('shows the static activated label (no typewriter) while on, even in flight', () => {
    renderPanel({
      isMagnet: true,
      lazySyncOn: true,
      canSyncSubtitle: true,
    });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncLazyOn,
    });
    expect(btn.querySelector('.entei-typewriter')).toBeNull();
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent).toContain(dict.subtitleSyncLazyActive);
  });

  it('keeps the colored toggle with the static label when on but not processing', () => {
    renderPanel({
      isMagnet: true,
      lazySyncOn: true,
      canSyncSubtitle: true,
    });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncLazyOn,
    });
    expect(btn.className).toContain('entei-subtitle-sync-button--active');
    expect(btn.querySelector('.entei-typewriter')).toBeNull();
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent).toContain(dict.subtitleSyncLazyActive);
  });
});

describe('RightPanel local media sync button stays classic', () => {
  it('renders the click-to-sync button (not a toggle) for local media', () => {
    const onSync = vi.fn();
    renderPanel({ canSyncSubtitle: true, onSyncSubtitle: onSync });
    const btn = screen.getByRole('button', {
      name: dict.subtitleSyncButtonLabel,
    });
    expect(btn.getAttribute('aria-pressed')).toBeNull();
    expect(btn.className).not.toContain('entei-subtitle-sync-button--active');
    expect(btn.textContent).toContain(dict.subtitleSyncButton);
    fireEvent.click(btn);
    expect(onSync).toHaveBeenCalledTimes(1);
  });
});
