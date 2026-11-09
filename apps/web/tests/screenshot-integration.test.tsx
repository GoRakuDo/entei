import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { PlayerControls } from '@/components/player/PlayerControls';
import { en } from '@/i18n/locales/en';
import { baseMockDict } from './base-mock-dict';

const controlsDict = { ...en.playerUI, ...baseMockDict };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('screenshot capture control entry', () => {
  it('exposes the screenshot action for a loaded video', () => {
    render(
      <PlayerControls
        mediaRef={{ current: null }}
        surfaceRef={{ current: null }}
        isPlaying={false}
        isLoading={false}
        error={null}
        hasMedia
        mediaType="video"
        mediaKey="screenshot-fixture"
        dict={controlsDict}
        mediaName="screenshot-fixture.mkv"
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
      />,
    );
    expect(screen.getByRole('button', { name: baseMockDict.mineButtonLabel })).toBeTruthy();
  });
});
