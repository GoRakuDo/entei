import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { PlayerControls } from '@/components/player/PlayerControls';
import { en } from '@/i18n/locales/en';
import { baseMockDict } from './base-mock-dict';

const controlsDict = { ...en.playerUI, ...baseMockDict };

function renderControls(overrides: Partial<React.ComponentProps<typeof PlayerControls>> = {}) {
  return render(
    <PlayerControls
      mediaRef={{ current: null }}
      surfaceRef={{ current: null }}
      isPlaying={false}
      isLoading={false}
      error={null}
      hasMedia
      mediaType="video"
      mediaKey="mining-fixture"
      dict={controlsDict}
      mediaName="mining-fixture.mkv"
      isSubtitlePanelVisible
      onToggleSubtitlePanel={vi.fn()}
      captionDisplayMode="visible"
      onCycleCaptionMode={vi.fn()}
      volume={1}
      onVolumeChange={vi.fn()}
      playbackRate={1}
      onPlaybackRateChange={vi.fn()}
      onTogglePlayback={vi.fn()}
      isTouchDevice={false}
      reducedMotion={false}
      canMine
      onMine={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('mining control availability', () => {
  it('shows the mining action when a cue is available', () => {
    renderControls();
    expect(screen.getByRole('button', { name: baseMockDict.mineButtonLabel })).toBeTruthy();
  });

  it('disables mining while capture is active', () => {
    renderControls({ isMining: true });
    expect(screen.getByRole('button', { name: baseMockDict.mineButtonCapturing })).toBeDisabled();
  });
});
