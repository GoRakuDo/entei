import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { PlayerControls } from '@/components/player/PlayerControls';
import { en } from '@/i18n/locales/en';
import { baseMockDict } from './base-mock-dict';

const controlsDict = { ...en.playerUI, ...baseMockDict };

function makeProps() {
  return {
    mediaRef: { current: null as HTMLMediaElement | null },
    surfaceRef: { current: null as HTMLDivElement | null },
    isPlaying: false,
    isLoading: false,
    error: null,
    hasMedia: true,
    mediaType: 'video' as const,
    mediaKey: 'video-fixture',
    dict: controlsDict,
    mediaName: 'fixture.mkv',
    isSubtitlePanelVisible: true,
    onToggleSubtitlePanel: vi.fn(),
    captionDisplayMode: 'visible' as const,
    onCycleCaptionMode: vi.fn(),
    volume: 1,
    onVolumeChange: vi.fn(),
    playbackRate: 1,
    onPlaybackRateChange: vi.fn(),
    onTogglePlayback: vi.fn(),
    isTouchDevice: false,
    reducedMotion: false,
  };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('video PlayerControls integration', () => {
  beforeEach(() => { document.documentElement.lang = 'en'; });

  it('opens the local file picker action and keeps playback actions available', () => {
    const onFileOpen = vi.fn();
    const { container } = render(<PlayerControls {...makeProps()} onFileOpen={onFileOpen} fileAccept=".mkv,.srt" fileOpenLabel={baseMockDict.fileOpenLabel} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe('.mkv,.srt');
    expect(screen.getByRole('button', { name: baseMockDict.playLabel })).toBeTruthy();
  });

  it('sets the currently selected source in the accessible controls chrome', () => {
    render(<PlayerControls {...makeProps()} />);
    expect(screen.getByText('fixture.mkv')).toBeTruthy();
  });
});
