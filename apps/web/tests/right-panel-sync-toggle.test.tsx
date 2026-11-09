import { describe, expect, it, vi } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { RightPanel } from '@/components/player/RightPanel';
import { en } from '@i18n/locales/en';

const dict = en.playerUI;

function renderPanel(overrides: {
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
    />,
  );
}

describe('RightPanel subtitle sync button', () => {
  it('renders the click-to-sync button for native torrent and local media', () => {
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
