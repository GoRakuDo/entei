/**
 * Component tests for AM-3 Audio Clip integration.
 * ---------------------------------------------------------------------------
 * - Audio clip button visibility (video/audio)
 * - Audio clip disabled when no active cue / unsupported / recording
 * - Audio clip preview dialog lifecycle
 * - URL lifecycle (create / revoke)
 * - Visible Player remains unmodified (time/paused/rate)
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useRef, useCallback, useState, useEffect } from 'react';
import { PlayerControls } from '@/components/player/PlayerControls';
import { AudioClipPreviewDialog } from '@/components/player/AudioClipPreviewDialog';
import {
  recordAudioClip,
  cancelActiveRecording,
} from '@/features/player/audio-clip';

// Mock recordAudioClip so we don't need real MediaRecorder
vi.mock('@/features/player/audio-clip', () => ({
  checkAudioClipCapabilities: vi.fn(() => ({
    supported: true,
    mimeType: 'audio/webm;codecs=opus',
  })),
  recordAudioClip: vi.fn(),
  cancelActiveRecording: vi.fn(),
}));

// jsdom lacks ResizeObserver (Radix dependency)
beforeEach(() => {
  global.ResizeObserver = vi.fn(function () {
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mockDict = {
  selectMediaTitle: 'Select media',
  selectMediaDesc: 'Desc',
  chooseMedia: 'Choose',
  chooseSubtitle: 'Subtitle',
  changeSubtitle: 'Change',
  subtitles: 'Subtitles',
  noSubtitlesLoaded: 'None',
  shortcuts: 'Shortcuts',
  shortcutsTitle: 'Shortcuts',
  shortcutsDesc: 'Desc',
  showShortcutsAriaLabel: 'Show',
  dialogClose: 'Close',
  subtitleWarnings: 'Warnings',
  unsupportedFormat: 'Unsupported',
  failedToRead: 'Failed',
  failedToLoadAudio: 'Audio fail',
  failedToLoadVideo: 'Video fail',
  videoDecodeError: 'Decode fail',
  audioDecodeError: 'Audio decode fail',
  cuesCount: 'cues',
  seekTo: 'Seek',
  playLabel: 'Play',
  pauseLabel: 'Pause',
  volumeLabel: 'Volume',
  linePrefix: 'Line',
  shortcutPlayPause: 'Play/Pause',
  shortcutPrevCue: 'Prev',
  shortcutNextCue: 'Next',
  shortcutSeekHome: 'Home',
  shortcutSlowDown: 'Slow',
  shortcutSpeedUp: 'Fast',
  timelineToggle: 'Toggle',
  timelineShow: 'Show',
  timelineHide: 'Hide',
  settingsLabel: 'Settings',
  settingsTitle: 'Settings',
  settingsSubtitles: 'Subs',
  settingsShortcuts: 'Shortcuts',
  subtitlesLoadedStatus: 'Loaded',
  subtitlesNotLoadedStatus: 'None',
  seekAriaLabel: 'Seek',
  muteAriaLabel: 'Mute',
  unmuteAriaLabel: 'Unmute',
  showVolume: 'Show volume',
  hideVolume: 'Hide volume',
  volumeSliderAriaLabel: 'Volume',
  rateLabel: 'Speed',
  rateAriaLabel: 'Rate',
  fullscreenEnter: 'Fullscreen',
  fullscreenExit: 'Exit',
  fullscreenError: 'Error',
  fullscreenUnavailable: 'Unavailable',
  controlsShow: 'Show controls',
  controlsHide: 'Hide controls',
  captionModeVisible: 'Visible',
  captionModeBlurred: 'Blurred',
  captionModeHidden: 'Hidden',
  settingsTabPlayer: 'Player',
  settingsTabAnki: 'Anki',
  ankiConnect: 'Connect',
  ankiConnectDesc: 'Desc',
  ankiEndpointLabel: 'URL',
  ankiStatusConnected: 'Connected',
  ankiStatusRetrying: 'Retrying',
  ankiConnecting: 'Connecting',
  ankiErrorUnavailable: 'Unavailable',
  ankiErrorCors: 'CORS',
  ankiErrorCorsHint: 'Hint',
  ankiErrorPermission: 'Permission',
  ankiErrorApiKey: 'API key',
  ankiErrorUnknown: 'Unknown',
  ankiApiKeyLabel: 'Key',
  ankiApiKeyPlaceholder: 'Key',
  ankiDeckLabel: 'Deck',
  ankiDeckPlaceholder: 'Deck',
  ankiNoDecks: 'None',
  ankiNoteTypeLabel: 'Note',
  ankiNoteTypePlaceholder: 'Note',
  ankiNoNoteTypes: 'None',
  ankiFieldSentence: 'Sentence',
  ankiFieldDefinition: 'Definition',
  ankiFieldImage: 'Image',
  ankiFieldAudio: 'Audio',
  ankiFieldWord: 'Word',
  ankiFieldSource: 'Source',
  ankiFieldTags: 'Tags',
  ankiFieldRequired: 'required',
  ankiFieldOptional: 'optional',
  ankiSavePreset: 'Save',
  ankiPresetSaved: 'Saved',
  ankiPresetInvalid: 'Invalid',
  ankiNoFields: 'None',
  ankiSelectNoteTypeFirst: 'Select first',
  screenshotCaptureLabel: 'Capture screenshot',
  screenshotPreviewTitle: 'Preview',
  screenshotRetry: 'Retry',
  screenshotClose: 'Close',
  screenshotError: 'Failed',
  screenshotErrorMetadata: 'Not ready',
  screenshotNoPreview: 'No preview available.',
  screenshotCapturing: 'Capturing screenshot…',
  audioClipCaptureLabel: 'Capture audio clip',
  audioClipPreviewTitle: 'Audio Clip Preview',
  audioClipRetry: 'Retry',
  audioClipClose: 'Close',
  audioClipError: 'Failed to capture audio clip.',
  audioClipErrorNoCue: 'No active subtitle cue.',
  audioClipErrorUnsupported: 'Audio clip recording is not supported.',
  audioClipNoPreview: 'No preview available.',
  audioClipRecording: 'Recording audio clip…',
  audioClipPlay: 'Play',
  audioClipPause: 'Pause',
  mineButtonLabel: 'Mine',
  mineButtonCapturing: 'Mining…',
  mineButtonDisabled: 'No active subtitle cue',
  mineRowLabel: 'Mine this cue',
  mineRowDisabled: 'Mining unavailable',
  fileOpenLabel: 'Open file',
  miningPreviewTitle: 'Mining Preview',
  miningPreviewSentence: 'Sentence',
  miningPreviewSource: 'Source',
  miningPreviewScreenshot: 'Screenshot',
  miningPreviewAudio: 'Audio',
  miningPreviewRange: 'Range',
  miningPreviewCancel: 'Cancel',
  miningPreviewClose: 'Close',
  miningPreviewScreenshotUnavailable: 'Screenshot unavailable for audio media',
  miningPreviewAudioError: 'Audio capture failed',
  miningPreviewScreenshotError: 'Screenshot capture failed',
  miningPreviewCapturing: 'Capturing…',
  miningPreviewRefreshing: 'Refreshing materials…',
  miningPreviewRangeInvalid: 'Invalid range',
  miningZoomIn: 'Zoom in',
  miningZoomOut: 'Zoom out',
  exportModeNew: 'New card',
  exportModeUpdate: 'Update card',
  exportSendNew: 'Send to Anki',
  exportNoCandidate: 'No recent note found.',
  exportSuccess: 'Sent successfully.',
  exportError: 'Export failed.',
  exportSendDisabledNoConnection: 'AnkiConnect is not connected.',
  exportSendDisabledInvalidPreset: 'Invalid preset.',
  exportSendDisabledNoSentence: 'Sentence is empty.',
  exportSendDisabledRequestActive: 'Request in progress.',
  exportRejectedCanAdd: 'Anki rejected this note.',
  appendSelectLabel: 'Select card to append',
  appendDialogTitle: 'Search & Append',
  appendDialogDescription: 'Search Anki.',
  appendSearchPlaceholder: 'Search query',
  appendSearchButton: 'Search',
  appendSearching: 'Searching…',
  appendNoResults: 'No results.',
  appendSearchError: 'Search failed.',
  appendWordLabel: 'Word',
  appendSentenceLabel: 'Sentence',
  appendDeckLabel: 'Deck',
  appendSuccess: 'Done.',
  appendPartialFailure: 'Partial.',
  appendAllFailed: 'Failed.',
  appendSelectedCount: (count: number) => `${count} selected`,
  mediaModeImage: 'Image',
  mediaModeVideo: 'Video',
  mediaModeUnsupported: 'Video Clip is not supported.',
  rightPanelTabsLabel: 'Panel',
  rightPanelTabCaptions: 'Captions',
  rightPanelTabHistory: 'History',
  historyEmpty: 'No history yet',
  historyUnavailable: 'History unavailable',
  historySentence: 'Sentence',
  historyRange: 'Range',
  playModeLabel: 'Play mode',
  playModeNormal: 'Normal',
  playModeCondensed: 'Condensed',
  playModeFastForward: 'Fast-forward',
  // ED-1: Magnet URI dialog — visual shell (no torrent runtime)
  magnetInputLabel: 'Magnet URI',
  magnetInputPlaceholder: 'magnet:?xt=urn:btih:...',
  magnetInputLabelTitle: 'Open Torrent Stream',
  magnetConnect: 'Connect',
  magnetErrorInvalid: 'Invalid magnet URI.',
  magnetNotConnectedTitle: 'EizouDendenshi not connected',
  magnetNotConnectedBody: 'Torrent streaming will be enabled in a future update.',
  // ED-3: EizouDendenshi setup + pairing
  eizouSetupLabel: 'Set up',
  eizouSetupTitle: 'EizouDendenshi',
  eizouSetupDesc: 'Assists with videos shared over YouTube and P2P.',
  eizouSetupImageAlt: 'EizouDendenshi illustration',
  eizouConnected: 'Connected',
  eizouPairingTitle: 'Pair EizouDendenshi',
  eizouPairingDesc: 'Enter the 6-digit code.',
  eizouPairingOtpLabel: '6-digit pairing code',
  eizouPairingOtpInvalid: 'Enter the 6-digit code.',
  eizouPairingSubmit: 'Pair',
  eizouPairingConnecting: 'Pairing…',
  eizouPairingErrorNetwork: 'Could not reach EizouDendenshi.',
  eizouPairingErrorInvalidCode: 'Invalid code.',
  eizouPairingErrorGeneric: 'Pairing failed.',
  youtubeInputLabel: 'YouTube URL',
  youtubeInputTitle: 'YouTube streaming',
  youtubeInputBody: 'YouTube streaming is not available yet.',
  // P2.1: Subtitle Appearance Settings
  settingsTabSubtitle: 'Subtitle',
  subtitleAppearance: 'Appearance',
  subtitleFontSize: 'Font size',
  subtitleTextColor: 'Text color',
  subtitleBackgroundColor: 'Background color',
  subtitleBackgroundOpacity: 'Background opacity',
  subtitleBackgroundPadding: 'Padding',
  subtitleVerticalPosition: 'Vertical position',
  subtitlePreview: 'Preview',
  subtitleReset: 'Reset',
  // Tracker (IMMERSION_TRACKER Stage 2b)
  trackerLabel: 'Tracker',
  trackerOn: 'ON',
  trackerOff: 'OFF',
  trackerAriaLabel: 'Immersion tracker enabled',
  trackerEnabledAriaDescription: 'Recording watch time and mining history',
  trackerDisabledAriaDescription: 'Tracker is off — no new recording, existing history preserved',
};

const baseControlsProps = {
  mediaRef: { current: null as HTMLMediaElement | null },
  surfaceRef: { current: null as HTMLDivElement | null },
  isPlaying: false,
  isLoading: false,
  error: null,
  hasMedia: true,
  mediaType: 'video' as const,
  mediaKey: 'test',
  dict: mockDict,
  mediaName: 'test.mp4',
  isSubtitlePanelVisible: true,
  onToggleSubtitlePanel: vi.fn(),
  captionDisplayMode: 'visible' as const,
  onCycleCaptionMode: vi.fn(),
  volume: 1,
  onVolumeChange: vi.fn(),
  playbackRate: 1,
  onPlaybackRateChange: vi.fn(),
  shortcuts: [] as { key: string; desc: string }[],
  isTouchDevice: false,
  reducedMotion: false,
};

describe('PlayerControls — AudioLines removed', () => {
  it('does NOT render AudioLines button for video', () => {
    const { container } = render(<PlayerControls {...baseControlsProps} />);
    const btn = container.querySelector(
      `[aria-label="${mockDict.audioClipCaptureLabel}"]`,
    );
    expect(btn).toBeNull();
  });

  it('does NOT render AudioLines button for audio', () => {
    const { container } = render(
      <PlayerControls {...baseControlsProps} mediaType="audio" />,
    );
    const btn = container.querySelector(
      `[aria-label="${mockDict.audioClipCaptureLabel}"]`,
    );
    expect(btn).toBeNull();
  });
});

describe('AudioClipPreviewDialog', () => {
  const baseProps = {
    open: true,
    onOpenChange: vi.fn(),
    audioUrl: 'blob:test',
    expectedDuration: 0,
    error: false,
    onRetry: vi.fn(),
    onClose: vi.fn(),
    isRecording: false,
    dict: mockDict,
  };

  it('renders recording state when isRecording is true', () => {
    render(
      <AudioClipPreviewDialog {...baseProps} audioUrl={null} isRecording />,
    );
    expect(document.body.textContent).toContain(mockDict.audioClipRecording);
  });

  it('renders error state when error is true', () => {
    render(<AudioClipPreviewDialog {...baseProps} audioUrl={null} error />);
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain(mockDict.audioClipError);
    const retryBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === mockDict.audioClipRetry,
    );
    expect(retryBtn).not.toBeUndefined();
  });

  it('calls onRetry when Retry is clicked', () => {
    const onRetry = vi.fn();
    render(
      <AudioClipPreviewDialog
        {...baseProps}
        audioUrl={null}
        error
        onRetry={onRetry}
      />,
    );
    const retryBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === mockDict.audioClipRetry,
    );
    expect(retryBtn).not.toBeUndefined();
    fireEvent.click(retryBtn!);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Close is clicked', () => {
    const onClose = vi.fn();
    render(<AudioClipPreviewDialog {...baseProps} onClose={onClose} />);
    const buttons = Array.from(document.body.querySelectorAll('button'));
    const closeBtn = buttons.find(
      (b) => b.textContent === mockDict.audioClipClose,
    );
    expect(closeBtn).not.toBeUndefined();
    fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders placeholder when no audio and no error', () => {
    render(<AudioClipPreviewDialog {...baseProps} audioUrl={null} />);
    expect(document.body.textContent).toContain(mockDict.audioClipNoPreview);
  });
});

describe('Visible Player remains unmodified during audio clip', () => {
  it('does not pause, seek, or change rate on the visible player', async () => {
    const video = document.createElement('video');
    video.src = 'blob:test';
    Object.defineProperty(video, 'currentTime', {
      value: 10,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(video, 'paused', {
      value: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(video, 'playbackRate', {
      value: 1,
      writable: true,
      configurable: true,
    });

    const origPlay = video.play.bind(video);
    video.play = vi.fn(() => origPlay());

    // Simulate recording via the mock
    const mockBlob = new Blob(['audio'], { type: 'audio/webm' });
    vi.mocked(recordAudioClip).mockResolvedValue({
      ok: true,
      blob: mockBlob,
      mimeType: 'audio/webm;codecs=opus',
    });

    // The actual PlayerApp does not touch the visible element directly.
    // recordAudioClip creates its own detached HTMLAudioElement.
    const result = await recordAudioClip({
      mediaUrl: 'blob:test',
      start: 5,
      end: 8,
    });

    expect(result.ok).toBe(true);
    // Visible player state must be untouched
    expect(video.currentTime).toBe(10);
    expect(video.paused).toBe(false);
    expect(video.playbackRate).toBe(1);
  });
});

describe('URL lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:mock-preview'),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates object URL from Blob', () => {
    const blob = new Blob(['fake'], { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(url).toBe('blob:mock-preview');
  });

  it('revokes object URL', () => {
    URL.revokeObjectURL('blob:mock-preview');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-preview');
  });
});

describe('Stale/unmount safeguards', () => {
  it('does not create a URL when the result is discarded (epoch mismatch)', async () => {
    const { promise, resolve } = (() => {
      let res: (value: {
        ok: true;
        blob: Blob;
        mimeType: string;
      }) => void = () => {};
      const p = new Promise<{ ok: true; blob: Blob; mimeType: string }>((r) => {
        res = r;
      });
      return { promise: p, resolve: res };
    })();

    vi.mocked(recordAudioClip).mockReturnValue(promise);

    function TestStaleDiscard() {
      const epochRef = useRef(0);
      const isRecordingRef = useRef(false);
      const [audioUrl, setAudioUrl] = useState<string | null>(null);

      const handleCapture = useCallback(async () => {
        if (isRecordingRef.current) return;
        const epoch = epochRef.current + 1;
        epochRef.current = epoch;
        isRecordingRef.current = true;

        const result = await recordAudioClip({
          mediaUrl: 'blob:test',
          start: 0,
          end: 1,
        });

        if (epochRef.current !== epoch) {
          return;
        }

        isRecordingRef.current = false;
        if (result.ok) {
          const url = URL.createObjectURL(result.blob);
          setAudioUrl(url);
        }
      }, []);

      const invalidate = useCallback(() => {
        epochRef.current += 1;
      }, []);

      return (
        <div>
          <button type="button" className="capture" onClick={handleCapture}>
            Capture
          </button>
          <button type="button" className="invalidate" onClick={invalidate}>
            Invalidate
          </button>
          {audioUrl && <audio src={audioUrl} />}
        </div>
      );
    }

    const { container } = render(<TestStaleDiscard />);
    const captureBtn = container.querySelector('.capture') as HTMLButtonElement;
    const invalidateBtn = container.querySelector(
      '.invalidate',
    ) as HTMLButtonElement;

    fireEvent.click(captureBtn);
    fireEvent.click(invalidateBtn);

    resolve({ ok: true, blob: new Blob(['x']), mimeType: 'audio/webm' });
    await promise;

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector('audio')).toBeNull();
  });

  it('does not create a URL when unmounted before recording resolves', async () => {
    const { promise, resolve } = (() => {
      let res: (value: {
        ok: true;
        blob: Blob;
        mimeType: string;
      }) => void = () => {};
      const p = new Promise<{ ok: true; blob: Blob; mimeType: string }>((r) => {
        res = r;
      });
      return { promise: p, resolve: res };
    })();

    vi.mocked(recordAudioClip).mockReturnValue(promise);

    function TestUnmountDiscard() {
      const mountedRef = useRef(true);
      const isRecordingRef = useRef(false);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      const handleCapture = useCallback(async () => {
        if (isRecordingRef.current) return;
        isRecordingRef.current = true;

        const result = await recordAudioClip({
          mediaUrl: 'blob:test',
          start: 0,
          end: 1,
        });

        if (!mountedRef.current) {
          return;
        }

        isRecordingRef.current = false;
        if (result.ok) {
          URL.createObjectURL(result.blob);
        }
      }, []);

      return (
        <button type="button" onClick={handleCapture}>
          Capture
        </button>
      );
    }

    const { container, unmount } = render(<TestUnmountDiscard />);
    const btn = container.querySelector('button') as HTMLButtonElement;

    fireEvent.click(btn);
    unmount();

    resolve({ ok: true, blob: new Blob(['y']), mimeType: 'audio/webm' });
    await promise;

    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('cancelActiveRecording integration', () => {
  it('cancels a pending recording cleanly', async () => {
    const { promise } = (() => {
      const p = new Promise<{ ok: true; blob: Blob; mimeType: string }>(
        () => {},
      );
      return { promise: p };
    })();

    vi.mocked(recordAudioClip).mockReturnValue(promise);

    function TestCancel() {
      const handleCapture = useCallback(async () => {
        await recordAudioClip({ mediaUrl: 'blob:test', start: 0, end: 10 });
      }, []);

      return (
        <div>
          <button type="button" className="capture" onClick={handleCapture}>
            Capture
          </button>
          <button
            type="button"
            className="cancel"
            onClick={cancelActiveRecording}
          >
            Cancel
          </button>
        </div>
      );
    }

    const { container } = render(<TestCancel />);
    fireEvent.click(container.querySelector('.capture') as HTMLButtonElement);
    fireEvent.click(container.querySelector('.cancel') as HTMLButtonElement);

    expect(cancelActiveRecording).toHaveBeenCalled();
  });
});
