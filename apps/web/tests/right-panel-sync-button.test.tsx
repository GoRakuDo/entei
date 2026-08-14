import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RightPanel } from '@/components/player/RightPanel';
import { en } from '@i18n/locales/en';

const dict = en.playerUI;

function renderPanel(overrides: {
  onSyncSubtitle?: () => void;
  canSyncSubtitle?: boolean;
  isSyncingSubtitle?: boolean;
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
