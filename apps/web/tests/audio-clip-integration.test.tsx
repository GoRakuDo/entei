import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { PlayerControls } from '@/components/player/PlayerControls';
import { en } from '@/i18n/locales/en';
import { baseMockDict } from './base-mock-dict';

const controlsDict = { ...en.playerUI, ...baseMockDict };

const toast = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function renderControls() {
  return render(
    <PlayerControls
      mediaRef={{ current: null }}
      surfaceRef={{ current: null }}
      isPlaying={false}
      isLoading={false}
      error={null}
      hasMedia
      mediaType="audio"
      mediaKey="audio-fixture"
      dict={controlsDict}
      mediaName="fixture.m4a"
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
}

describe('audio PlayerControls integration', () => {
  beforeEach(() => { document.documentElement.lang = 'en'; });
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it('renders working audio controls and keeps Anki actions available', () => {
    const { container } = renderControls();
    expect(screen.getByRole('button', { name: baseMockDict.playLabel })).toBeTruthy();
    expect(screen.getByRole('button', { name: baseMockDict.mineButtonLabel })).toBeTruthy();
    expect(container.querySelector('.entei-controls-layer')).not.toBeNull();
  });

  it('keeps controls mounted and usable after a locale-change event', () => {
    renderControls();
    act(() => {
      window.dispatchEvent(new CustomEvent('entei:locale-change', {
        detail: { locale: 'ja' },
      }));
    });
    expect(screen.getByRole('button', { name: baseMockDict.playLabel })).toBeTruthy();
  });
});
