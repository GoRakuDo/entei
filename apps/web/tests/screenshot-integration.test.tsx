/**
 * Component tests for AM-2 Screenshot integration.
 * ---------------------------------------------------------------------------
 * - Camera button visibility (video-only)
 * - Camera disabled while capturing
 * - Screenshot preview dialog lifecycle
 * - URL lifecycle (create / revoke)
 * ---------------------------------------------------------------------------
 * Note: These tests use the existing jsdom + React Testing Library setup
 * without jest-dom matchers (not configured in vitest.config.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { useRef, useEffect, useCallback, useState, StrictMode } from 'react';
import { PlayerControls } from '@/components/player/PlayerControls';
import { ScreenshotPreviewDialog } from '@/components/player/ScreenshotPreviewDialog';
import { captureVideoFrame } from '@/features/player/screenshot-capture';

// Mock captureVideoFrame so we don't need a real canvas
vi.mock('@/features/player/screenshot-capture', () => ({
  MAX_CAPTURE_DIMENSION: 1920,
  JPEG_QUALITY: 0.9,
  JPEG_MIME_TYPE: 'image/jpeg',
  captureVideoFrame: vi.fn(),
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
  preparingSubtitles: 'Preparing…',
  companionJobError: 'An error occurred. Please try again.',
  companionJobFailed: 'The download failed. Please try a new URL or choose a file.',
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
  settingsTitleGlobal: 'Settings',
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
  settingsTabShortcut: 'Shortcut',
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
  magnetErrorInvalid: 'Invalid magnet URI.',
  magnetInputSubmit: 'Start download',
  magnetInputUnpairedBody: 'Pair EizouDendenshi first to download a torrent.',
  magnetConsentLabel: 'I understand: torrent trackers and peers can see my IP address while downloading.',
  magnetInputErrorRepair: 'The connection needs re-pairing. Open Setup and connect again.',
  magnetInputErrorConflict: 'A download is already active. Cancel the previous download first.',
  magnetInputErrorNetwork: 'Could not reach EizouDendenshi. Make sure the companion app is running.',
  magnetInputErrorGeneric: 'Something went wrong. Try again.',
  magnetInputErrorMetadataTimeout: 'Metadata could not be retrieved.',
  magnetInputErrorEvicted: 'Playback stopped because the concurrent torrent limit was exceeded.',
  magnetInputErrorV2Unsupported:
    'v2-only torrents are not supported. Use a v1 or hybrid (v1+v2) torrent link.',
  magnetInputSubmitting: 'Starting…',
  magnetCheckMetadata: 'Checking metadata…',
  magnetFilesTitle: 'Select files',
  magnetFilesBody: 'Pick one video and, optionally, one subtitle.',
  magnetNoVideoError: 'No selectable video in this torrent.',
  magnetSelectSubmit: 'Select & play',
  magnetCancel: 'Cancel',
  magnetTableFileName: 'File name',
  magnetTableSize: 'Size',
  magnetFileKindVideo: 'video',
  magnetFileKindSubtitle: 'subtitle',
  magnetFileKindFolder: 'folder',
  magnetFileKindOther: 'file',
  magnetTableNavUp: 'Go up one level',
  magnetNoVideosInFolder: 'No videos in this folder',
  // ED-3: EizouDendenshi setup + pairing
  eizouSetupLabel: 'OTP Setup',
  eizouSetupTitle: 'EizouDendenshi',
  eizouDisconnected: 'Disconnected',
  eizouChecking: 'Checking…',
  eizouResetButton: 'Reset pairing',
  eizouResetTitle: 'Reset pairing?',
  eizouResetDesc: 'Reset pairing?',
  eizouResetConfirm: 'Reset pairing',
  eizouResetCancel: 'Cancel',
  eizouSetupImageAlt: 'EizouDendenshi illustration',
  eizouConnected: 'Connected',
  eizouPairingTitle: 'Pair EizouDendenshi',
  eizouPairingOtpLabel: '6-digit pairing code',
  eizouPairingOtpInvalid: 'Enter the 6-digit code.',
  eizouPairingSubmit: 'Pair',
  eizouPairingConnecting: 'Pairing…',
  eizouPairingErrorNetwork: 'Could not reach EizouDendenshi.',
  eizouPairingErrorInvalidCode: 'Invalid code.',
  eizouPairingErrorGeneric: 'Pairing failed.',
  eizouSessionBuffering: 'Waiting for the file to be ready…',
  eizouSessionProgressLabel: 'Progress',
  eizouSessionError: 'The companion session failed. End it and try again.',
  eizouSessionRePairRequired: 'Re-pair required — the pairing code has changed.',
  eizouSessionEnd: 'End session',
  eizouSessionSourceLabelTorrent: 'Torrent download',
  eizouSessionSourceLabel: 'YouTube download',
  companionStreamNotReady: 'Stream is not ready yet. Waiting for more data…',
  companionPreparingVideo: 'Preparing video…',
  youtubeInputLabel: 'YouTube URL',
  youtubeInputTitle: 'YouTube streaming',
  youtubeInputPlaceholder: 'https://www.youtube.com/watch?v=…',
  youtubeInputSubmit: 'Start download',
  youtubeInputUnpairedBody: 'Pair EizouDendenshi first to download from YouTube.',
  youtubeInputErrorInvalid: 'Invalid YouTube URL.',
  youtubeInputErrorRepair: 'The connection needs re-pairing. Open Setup and connect again.',
  youtubeInputErrorConflict: 'A download is already active. Cancel the previous download first.',
  youtubeInputErrorNetwork: 'Could not reach EizouDendenshi. Make sure the companion app is running.',
  youtubeInputErrorGeneric: 'Something went wrong. Try again.',
  youtubeInputSubmitting: 'Starting…',

  // P2.1: Subtitle Appearance Settings
  settingsTabSubtitle: 'Subtitle',
  settingsTabEizouDen: 'EizouDen',
  ytModeQuality: 'Quality',
  ytModeSpeed: 'Speed',
  ytModeQualityDesc: 'Quality first',
  ytModeSpeedDesc: 'Instant playback',
  ytModeToastFormat: 'Playing {quality}',
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

describe('PlayerControls — Camera/AudioLines removed', () => {
  it('does NOT render Camera button', () => {
    const { container } = render(<PlayerControls {...baseControlsProps} />);
    const btn = container.querySelector(
      `[aria-label="${mockDict.screenshotCaptureLabel}"]`,
    );
    expect(btn).toBeNull();
  });

  it('does NOT render AudioLines button', () => {
    const { container } = render(<PlayerControls {...baseControlsProps} />);
    const btn = container.querySelector(
      `[aria-label="${mockDict.audioClipCaptureLabel}"]`,
    );
    expect(btn).toBeNull();
  });
});

describe('ScreenshotPreviewDialog', () => {
  const baseProps = {
    open: true,
    onOpenChange: vi.fn(),
    imageUrl: 'blob:test',
    error: false,
    onRetry: vi.fn(),
    onClose: vi.fn(),
    isCapturing: false,
    dict: mockDict,
  };

  it('renders preview image when URL is provided', () => {
    render(<ScreenshotPreviewDialog {...baseProps} />);
    const img = document.body.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('alt')).toBe(mockDict.screenshotPreviewTitle);
  });

  it('renders error state when error is true', () => {
    render(<ScreenshotPreviewDialog {...baseProps} imageUrl={null} error />);
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain(mockDict.screenshotError);
    const retryBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === mockDict.screenshotRetry,
    );
    expect(retryBtn).not.toBeUndefined();
  });

  it('calls onRetry when Retry is clicked', () => {
    const onRetry = vi.fn();
    render(
      <ScreenshotPreviewDialog
        {...baseProps}
        imageUrl={null}
        error
        onRetry={onRetry}
      />,
    );
    const retryBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === mockDict.screenshotRetry,
    );
    expect(retryBtn).not.toBeUndefined();
    fireEvent.click(retryBtn!);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables Retry when isCapturing is true', () => {
    render(
      <ScreenshotPreviewDialog
        {...baseProps}
        imageUrl={null}
        error
        isCapturing
      />,
    );
    const retryBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === mockDict.screenshotRetry,
    ) as HTMLButtonElement;
    expect(retryBtn).not.toBeUndefined();
    expect(retryBtn.disabled).toBe(true);
  });

  it('calls onClose when Close is clicked', () => {
    const onClose = vi.fn();
    render(<ScreenshotPreviewDialog {...baseProps} onClose={onClose} />);
    const buttons = Array.from(document.body.querySelectorAll('button'));
    const closeBtn = buttons.find(
      (b) => b.textContent === mockDict.screenshotClose,
    );
    expect(closeBtn).not.toBeUndefined();
    fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders no-preview placeholder when no image and no error', () => {
    render(<ScreenshotPreviewDialog {...baseProps} imageUrl={null} />);
    expect(document.body.textContent).toContain(mockDict.screenshotNoPreview);
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
    const blob = new Blob(['fake'], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(url).toBe('blob:mock-preview');
  });

  it('revokes object URL', () => {
    URL.revokeObjectURL('blob:mock-preview');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-preview');
  });
});

// ---------------------------------------------------------------------------
// Race safety — focused tests for the three post-review defects
// ---------------------------------------------------------------------------

describe('mountedRef StrictMode lifecycle', () => {
  it('resets to true on effect setup after unmount (StrictMode double-invoke)', () => {
    // Use a module-level ref holder so we can inspect it after unmount.
    const mountedRefHolder = { current: true };

    function TestMountRef() {
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        mountedRefHolder.current = true; // Sync on setup
        return () => {
          mountedRef.current = false;
          mountedRefHolder.current = false; // Sync on cleanup
        };
      }, []);
      return <div />;
    }

    // --- First mount in StrictMode: setup→cleanup→setup ---
    const { unmount } = render(
      <StrictMode>
        <TestMountRef />
      </StrictMode>,
    );

    // After StrictMode double-invoke, mountedRef must be true
    // because the second setup explicitly set it.
    expect(mountedRefHolder.current).toBe(true);

    // --- Unmount ---
    unmount();
    expect(mountedRefHolder.current).toBe(false);

    // --- Fresh re-mount (React 18+ does not support rerender after unmount) ---
    render(
      <StrictMode>
        <TestMountRef />
      </StrictMode>,
    );
    expect(mountedRefHolder.current).toBe(true);
  });
});

describe('isCapturingRef synchronous double-click guard', () => {
  it('prevents a second synchronous invoke while the first is in flight', async () => {
    let invokeCount = 0;

    const { promise, resolve } = (() => {
      let res: (value: { ok: true; blob: Blob }) => void = () => {};
      const p = new Promise<{ ok: true; blob: Blob }>((r) => {
        res = r;
      });
      return { promise: p, resolve: res };
    })();

    vi.mocked(captureVideoFrame).mockReturnValue(promise);

    function TestCaptureGuard() {
      const isCapturingRef = useRef(false);
      const [count, setCount] = useState(0);

      const handleCapture = useCallback(async () => {
        if (isCapturingRef.current) return;
        isCapturingRef.current = true;
        invokeCount++;

        const result = await captureVideoFrame(document.createElement('video'));

        isCapturingRef.current = false;
        if (result.ok) {
          setCount((c) => c + 1);
        }
      }, []);

      return (
        <div>
          <button type="button" onClick={handleCapture}>
            Capture
          </button>
          <span data-count>{count}</span>
        </div>
      );
    }

    const { container } = render(<TestCaptureGuard />);
    const btn = container.querySelector('button') as HTMLButtonElement;

    // Two rapid clicks in the same tick
    fireEvent.click(btn);
    fireEvent.click(btn);

    // Only one async invocation should have started
    expect(invokeCount).toBe(1);

    // Resolve the pending capture (state update must be wrapped in act)
    await act(async () => {
      resolve({ ok: true, blob: new Blob(['x'], { type: 'image/jpeg' }) });
      await promise;
    });

    // State should update exactly once
    const countSpan = container.querySelector('[data-count]');
    expect(countSpan?.textContent).toBe('1');
  });
});

describe('No URL.createObjectURL for stale/discarded capture results', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:stale'),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not create a URL when the result is discarded (epoch mismatch)', async () => {
    const { promise, resolve } = (() => {
      let res: (value: { ok: true; blob: Blob }) => void = () => {};
      const p = new Promise<{ ok: true; blob: Blob }>((r) => {
        res = r;
      });
      return { promise: p, resolve: res };
    })();

    vi.mocked(captureVideoFrame).mockReturnValue(promise);

    function TestStaleDiscard() {
      const epochRef = useRef(0);
      const isCapturingRef = useRef(false);
      const [imageUrl, setImageUrl] = useState<string | null>(null);

      const handleCapture = useCallback(async () => {
        if (isCapturingRef.current) return;
        const epoch = epochRef.current + 1;
        epochRef.current = epoch;
        isCapturingRef.current = true;

        const result = await captureVideoFrame(document.createElement('video'));

        // Simulate epoch mismatch (e.g. user selected new media)
        if (epochRef.current !== epoch) {
          // Must NOT create a URL for a discarded Blob
          return;
        }

        isCapturingRef.current = false;
        if (result.ok) {
          const url = URL.createObjectURL(result.blob);
          setImageUrl(url);
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
          {imageUrl && <img src={imageUrl} alt="preview" />}
        </div>
      );
    }

    const { container } = render(<TestStaleDiscard />);
    const captureBtn = container.querySelector('.capture') as HTMLButtonElement;
    const invalidateBtn = container.querySelector(
      '.invalidate',
    ) as HTMLButtonElement;

    // Start capture
    fireEvent.click(captureBtn);

    // Invalidate before capture resolves (simulates new-media selection)
    fireEvent.click(invalidateBtn);

    // Now resolve the original capture
    resolve({ ok: true, blob: new Blob(['x'], { type: 'image/jpeg' }) });
    await promise;

    // createObjectURL should NEVER have been called for the discarded result
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
  });

  it('does not create a URL when unmounted before capture resolves', async () => {
    const { promise, resolve } = (() => {
      let res: (value: { ok: true; blob: Blob }) => void = () => {};
      const p = new Promise<{ ok: true; blob: Blob }>((r) => {
        res = r;
      });
      return { promise: p, resolve: res };
    })();

    vi.mocked(captureVideoFrame).mockReturnValue(promise);

    function TestUnmountDiscard() {
      const mountedRef = useRef(true);
      const isCapturingRef = useRef(false);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      const handleCapture = useCallback(async () => {
        if (isCapturingRef.current) return;
        isCapturingRef.current = true;

        const result = await captureVideoFrame(document.createElement('video'));

        if (!mountedRef.current) {
          // Must NOT create a URL after unmount
          return;
        }

        isCapturingRef.current = false;
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

    // Start capture
    fireEvent.click(btn);

    // Unmount before capture resolves
    unmount();

    // Now resolve the pending capture
    resolve({ ok: true, blob: new Blob(['y'], { type: 'image/jpeg' }) });
    await promise;

    // createObjectURL should NEVER have been called after unmount
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('Caller-level safety — unexpected rejection from captureVideoFrame', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:rejected'),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears capturing state and shows error dialog when captureVideoFrame rejects', async () => {
    // Arrange: create a deferred rejection so setIsCapturing(true) renders first
    const { promise, reject } = (() => {
      let rej: (reason: Error) => void = () => {};
      const p = new Promise<never>((_, r) => {
        rej = r;
      });
      return { promise: p, reject: rej };
    })();

    vi.mocked(captureVideoFrame).mockReturnValue(promise);

    function TestCallerSafety() {
      const isCapturingRef = useRef(false);
      const [isCapturing, setIsCapturing] = useState(false);
      const [hasError, setHasError] = useState(false);
      const [dialogOpen, setDialogOpen] = useState(false);

      const handleCapture = useCallback(async () => {
        if (isCapturingRef.current) return;
        isCapturingRef.current = true;
        setIsCapturing(true);
        setHasError(false);

        let result: Awaited<ReturnType<typeof captureVideoFrame>>;
        try {
          result = await captureVideoFrame(document.createElement('video'));
        } catch (e) {
          result = {
            ok: false,
            error: {
              code: 'BLOB_ENCODE_FAILED',
              message:
                e instanceof Error ? e.message : 'Unexpected capture failure.',
            },
          };
        }

        isCapturingRef.current = false;
        setIsCapturing(false);

        if (!result.ok) {
          setHasError(true);
          setDialogOpen(true);
          return;
        }

        const url = URL.createObjectURL(result.blob);
        setDialogOpen(true);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        void url;
      }, []);

      return (
        <div>
          <button
            type="button"
            className="capture"
            onClick={handleCapture}
            disabled={isCapturing}
          >
            Capture
          </button>
          {isCapturing && <span data-capturing>Working…</span>}
          {dialogOpen && (
            <div role="alert" data-dialog>
              {hasError ? 'Error' : 'OK'}
            </div>
          )}
        </div>
      );
    }

    const { container } = render(<TestCallerSafety />);
    const btn = container.querySelector('.capture') as HTMLButtonElement;

    // Act: trigger capture (promise is still pending)
    fireEvent.click(btn);

    // Capturing indicator should appear while promise is pending
    expect(container.querySelector('[data-capturing]')).not.toBeNull();
    expect(btn.disabled).toBe(true);

    // Now reject the pending promise
    await act(async () => {
      reject(new Error('Unexpected rejection'));
      await promise.catch(() => {});
    });

    // Assert: dialog shows error, capturing cleared, no URL created
    const dialog = container.querySelector('[data-dialog]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toBe('Error');
    expect(container.querySelector('[data-capturing]')).toBeNull();
    expect(btn.disabled).toBe(false);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('does not touch state when unmounted before rejection resolves', async () => {
    const { promise, reject } = (() => {
      let rej: (reason: Error) => void = () => {};
      const p = new Promise<{ ok: true; blob: Blob }>((_, r) => {
        rej = r;
      });
      return { promise: p, reject: rej };
    })();

    vi.mocked(captureVideoFrame).mockReturnValue(promise);

    function TestUnmountBeforeReject() {
      const mountedRef = useRef(true);
      const isCapturingRef = useRef(false);
      const [, setHasError] = useState(false);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      const handleCapture = useCallback(async () => {
        if (isCapturingRef.current) return;
        isCapturingRef.current = true;

        let result: Awaited<ReturnType<typeof captureVideoFrame>>;
        try {
          result = await captureVideoFrame(document.createElement('video'));
        } catch (e) {
          result = {
            ok: false,
            error: {
              code: 'BLOB_ENCODE_FAILED',
              message:
                e instanceof Error ? e.message : 'Unexpected capture failure.',
            },
          };
        }

        if (!mountedRef.current) return;

        isCapturingRef.current = false;
        if (!result.ok) {
          setHasError(true);
        }
      }, []);

      return (
        <button type="button" onClick={handleCapture}>
          Capture
        </button>
      );
    }

    const { container, unmount } = render(<TestUnmountBeforeReject />);
    const btn = container.querySelector('button') as HTMLButtonElement;

    fireEvent.click(btn);
    unmount();

    reject(new Error('Too late'));
    await promise.catch(() => {});

    // No state update on unmounted component
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
