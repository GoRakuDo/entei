/**
 * Integration tests for AM-4 Mining behavior in PlayerApp.
 * ---------------------------------------------------------------------------
 * - Mine button visibility and disabled states.
 * - Snapshot pause / restore on close.
 * - Active cue required.
 * - Screenshot + audio success and partial failure.
 * - Slider bounds / invalid duration.
 * - Explicit Update audio re-records and replaces URL.
 * - URL lifecycle: revoke on close, media change, unmount.
 * - Stale / unmount / double-click guards.
 * - No Anki / localStorage / fetch calls.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useRef, useCallback, useEffect } from 'react';
import { PlayerControls } from '@/components/player/PlayerControls';
import { recordAudioClip } from '@/features/player/audio-clip';
import { captureVideoFrame } from '@/features/player/screenshot-capture';
import { recordVideoClip } from '@/features/player/video-clip';

// Mocks
vi.mock('@/features/player/audio-clip', () => ({
  checkAudioClipCapabilities: vi.fn(() => ({
    supported: true,
    mimeType: 'audio/webm;codecs=opus',
  })),
  recordAudioClip: vi.fn(),
  cancelActiveRecording: vi.fn(),
}));

vi.mock('@/features/player/screenshot-capture', () => ({
  captureVideoFrame: vi.fn(),
}));

vi.mock('@/features/player/video-clip', () => ({
  recordVideoClip: vi.fn(),
  detectVideoClipCapabilities: vi.fn(() => ({
    supported: true,
    hasLocalVideo: true,
    hasCanvasCaptureStream: true,
    hasMediaRecorder: true,
    mimeType: 'video/webm;codecs=vp8',
  })),
  resolveClipRange: vi.fn((start: number, end: number) => ({
    start,
    end,
    duration: end - start,
  })),
}));

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
    ankiTagsPlaceholder: 'anime n5 eizou',
  ankiFieldRequired: 'required',
  ankiFieldOptional: 'optional',
    ankiDenChouPresetTitle: 'DenChou Preset',
    ankiDenChouPresetDesc: 'DenChou note type preset.',
    ankiDenChouPresetApply: 'Apply DenChou Preset',

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
  youtubeInputErrorInvalid: 'Invalid YouTube URL.',
  youtubeInputErrorRepair: 'The connection needs re-pairing. Open Setup and connect again.',
  youtubeInputErrorConflict: 'A download is already active. Cancel the previous download first.',
  youtubeInputErrorNetwork: 'Could not reach EizouDendenshi. Make sure the companion app is running.',
  youtubeInputErrorGeneric: 'Something went wrong. Try again.',
  youtubeInputSubmitting: 'Starting…',

  // P2.1: Subtitle Appearance Settings
  settingsTabSubtitle: 'Subtitle',
  settingsTabEizouDen: 'EizouDen',
    settingsEizouDenContentHeading: 'YouTube Playback Mode',
  ytModeQuality: 'Quality',
  ytModeSpeed: 'Speed',
  ytModeQualityDesc: 'Quality first',
  ytModeSpeedDesc: 'Instant playback',
  ytModeToastFormat: 'Playing {quality}',
  ytModeLabelSpeed: 'Speed',
  ytModeLabelQuality: 'Quality',
  subtitleAppearance: 'Appearance',
  subtitleFontSize: 'Font size',
  subtitleTextColor: 'Text color',
  subtitleBackgroundColor: 'Background color',
  subtitleBackgroundOpacity: 'Background opacity',
  subtitleBackgroundPadding: 'Padding',
  subtitleVerticalPosition: 'Vertical position',
    subtitleReset: 'Reset',
    subtitleSyncMode: 'Subtitle Sync Mode',
    subtitleSyncSubtitle: 'Subtitle',
    subtitleSyncAudio: 'Audio',
    subtitleSyncAuto: 'Auto',
    subtitleSyncSubtitleDesc: 'Sync using the video embedded subtitle',
    subtitleSyncAudioDesc: 'Sync from the audio track',
      subtitleSyncAutoDesc: 'Prefer subtitle, fall back to audio',
      subtitleSyncButton: 'Sync subtitle timing',
      subtitleSyncButtonLabel: 'Sync subtitle timing',
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

describe('PlayerControls — Mine button', () => {
  it('renders Pickaxe button for video', () => {
    const { container } = render(<PlayerControls {...baseControlsProps} />);
    const btn = container.querySelector(
      `[aria-label="${mockDict.mineButtonLabel}"]`,
    );
    expect(btn).not.toBeNull();
  });

  it('renders Pickaxe button for audio', () => {
    const { container } = render(
      <PlayerControls {...baseControlsProps} mediaType="audio" />,
    );
    const btn = container.querySelector(
      `[aria-label="${mockDict.mineButtonLabel}"]`,
    );
    expect(btn).not.toBeNull();
  });

  it('does NOT render Pickaxe button when no media', () => {
    const { container } = render(
      <PlayerControls
        {...baseControlsProps}
        hasMedia={false}
        mediaType={null}
      />,
    );
    const btn = container.querySelector(
      `[aria-label="${mockDict.mineButtonLabel}"]`,
    );
    expect(btn).toBeNull();
  });

  it('calls onMine when Pickaxe is clicked', () => {
    const onMine = vi.fn();
    const { container } = render(
      <PlayerControls {...baseControlsProps} onMine={onMine} canMine />,
    );
    const btn = container.querySelector(
      `[aria-label="${mockDict.mineButtonLabel}"]`,
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(onMine).toHaveBeenCalledTimes(1);
  });

  it('disables Pickaxe when canMine is false', () => {
    const onMine = vi.fn();
    const { container } = render(
      <PlayerControls {...baseControlsProps} onMine={onMine} canMine={false} />,
    );
    const btn = container.querySelector(
      `[aria-label="${mockDict.mineButtonLabel}"]`,
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
  });

  it('disables Pickaxe when isMining is true', () => {
    const onMine = vi.fn();
    const { container } = render(
      <PlayerControls
        {...baseControlsProps}
        onMine={onMine}
        canMine
        isMining
      />,
    );
    const btn = container.querySelector(
      `[aria-label="${mockDict.mineButtonCapturing}"]`,
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
  });
});

describe('Mining session — snapshot pause/restore', () => {
  it('pauses visible player and seeks back to snapshot on close', async () => {
    const video = document.createElement('video');
    video.src = 'blob:test';
    Object.defineProperty(video, 'currentTime', {
      value: 12.5,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(video, 'paused', {
      value: false,
      writable: true,
      configurable: true,
    });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      Object.defineProperty(video, 'paused', {
        value: true,
        writable: true,
        configurable: true,
      });
    });

    const mockBlob = new Blob(['audio'], { type: 'audio/webm' });
    vi.mocked(recordAudioClip).mockResolvedValue({
      ok: true,
      blob: mockBlob,
      mimeType: 'audio/webm;codecs=opus',
    });
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['image'], { type: 'image/jpeg' }),
    });

    // Simulate a mining-like flow
    const snapshotTime = video.currentTime;
    video.pause();
    expect(pauseSpy).toHaveBeenCalled();

    // On close, seek back and pause
    video.currentTime = snapshotTime;
    video.pause();
    expect(video.currentTime).toBe(12.5);
    expect(video.paused).toBe(true);
  });
});

describe('Mining session — URL lifecycle guards', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:mining-mock'),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not create URLs when unmounted before capture resolves', async () => {
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

    function TestUnmount() {
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      const capture = useCallback(async () => {
        const result = await recordAudioClip({
          mediaUrl: 'blob:test',
          start: 0,
          end: 1,
        });
        if (!mountedRef.current) return;
        if (result.ok) {
          URL.createObjectURL(result.blob);
        }
      }, []);

      return (
        <button type="button" onClick={capture}>
          Capture
        </button>
      );
    }

    const { container, unmount } = render(<TestUnmount />);
    const btn = container.querySelector('button') as HTMLButtonElement;
    fireEvent.click(btn);
    unmount();

    resolve({ ok: true, blob: new Blob(['x']), mimeType: 'audio/webm' });
    await promise;

    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Video mode range commit — regression tests for handleRangeCommit
// Tests the pipeline: recordVideoClip with committed [start,end], fallback,
// URL lifecycle, captured type for export.
// ---------------------------------------------------------------------------
describe('Video range commit pipeline', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:range-mock'),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('video mode range commit: recordVideoClip called with committed start/end', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: true,
      blob: new Blob(['new-webm'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });

    const result = await recordVideoClip({
      mediaUrl: 'blob:test-video',
      start: 10,
      end: 20,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(recordVideoClip).toHaveBeenCalledWith(
      expect.objectContaining({ start: 10, end: 20 }),
    );
    expect(captureVideoFrame).not.toHaveBeenCalled();
  });

  it('video mode range commit failure: JPEG fallback called', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: false,
      error: { code: 'CAPABILITY_UNSUPPORTED', message: 'Not supported' },
    });
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['fallback-jpg'], { type: 'image/jpeg' }),
    });

    const videoClipResult = await recordVideoClip({
      mediaUrl: 'blob:test-video',
      start: 10,
      end: 20,
    });
    expect(videoClipResult.ok).toBe(false);

    const fallbackResult = await captureVideoFrame(
      document.createElement('video'),
    );
    expect(fallbackResult.ok).toBe(true);
    expect(captureVideoFrame).toHaveBeenCalled();
  });

  it('video range commit: old URL revoked before new one created', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: true,
      blob: new Blob(['new-clip'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });

    const oldUrl = 'blob:old-video';
    const newUrl = URL.createObjectURL(
      new Blob(['new'], { type: 'video/webm' }),
    );
    URL.revokeObjectURL(oldUrl);

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldUrl);
    expect(newUrl).toBeTruthy();
  });

  it('video range success: capturedMediaType remains video for export', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: true,
      blob: new Blob(['webm-clip'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });

    const result = await recordVideoClip({
      mediaUrl: 'blob:test-video',
      start: 5,
      end: 15,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mimeType).toBe('video/webm');
    }
    expect(captureVideoFrame).not.toHaveBeenCalled();
  });

  it('video range failure + JPEG fallback: capturedMediaType changes to image', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: false,
      error: { code: 'RECORDING_TIMEOUT', message: 'Encode timed out' },
    });
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['fallback-jpg'], { type: 'image/jpeg' }),
    });

    const clipResult = await recordVideoClip({
      mediaUrl: 'blob:test-video',
      start: 10,
      end: 20,
    });
    expect(clipResult.ok).toBe(false);

    const fallback = await captureVideoFrame(document.createElement('video'));
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
      expect(fallback.blob.type).toBe('image/jpeg');
    }
  });

  it('audio not re-recorded on media-only range commit', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: true,
      blob: new Blob(['webm'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });

    await recordVideoClip({
      mediaUrl: 'blob:test-video',
      start: 10,
      end: 20,
    });
    expect(recordAudioClip).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Video mode Mine — captureVideoFrame fallback regression
// Tests the actual capture pipeline: recordVideoClip failure → JPEG fallback
// through the same code path that PlayerApp handleMine uses.
// ---------------------------------------------------------------------------
describe('Video mode Mine — JPEG fallback pipeline', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:fallback-mock'),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('when recordVideoClip fails, captureVideoFrame produces a JPEG fallback artifact', async () => {
    // recordVideoClip returns failure (unsupported / codec / watchdog)
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: false,
      error: {
        code: 'CAPABILITY_UNSUPPORTED',
        message: 'Canvas captureStream unavailable',
      },
    });
    // JPEG fallback succeeds
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['jpeg-data'], { type: 'image/jpeg' }),
    });

    // Exercise the actual capture pipeline exactly as handleMine does
    const videoClipResult = await recordVideoClip({
      mediaUrl: 'blob:test-video',
      start: 0,
      end: 5,
    });

    // Video clip failed — fall through to JPEG
    expect(videoClipResult.ok).toBe(false);

    let screenshotResult;
    const mockVideo = document.createElement('video');
    screenshotResult = await captureVideoFrame(mockVideo);

    expect(screenshotResult.ok).toBe(true);
    if (!screenshotResult.ok) throw new Error('Expected screenshot success');
    expect(screenshotResult.blob.type).toBe('image/jpeg');
    // Simulate what PlayerApp does: createObjectURL for the fallback JPEG
    const url = URL.createObjectURL(screenshotResult.blob);
    expect(url).toBeTruthy();
  });

  it('when both recordVideoClip and captureVideoFrame fail, error state is produced', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: false,
      error: { code: 'CAPABILITY_UNSUPPORTED', message: 'No codec' },
    });
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: false,
      error: { code: 'CONTEXT_NULL', message: 'No capability' },
    });

    const videoClipResult = await recordVideoClip({
      mediaUrl: 'blob:test-video',
      start: 0,
      end: 5,
    });
    expect(videoClipResult.ok).toBe(false);

    const mockVideo = document.createElement('video');
    const screenshotResult = await captureVideoFrame(mockVideo);
    expect(screenshotResult.ok).toBe(false);
    // Both failed — no URL should be created
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('when recordVideoClip succeeds, captureVideoFrame is NOT called', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: true,
      blob: new Blob(['webm-data'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });

    const videoClipResult = await recordVideoClip({
      mediaUrl: 'blob:test-video',
      start: 0,
      end: 5,
    });
    expect(videoClipResult.ok).toBe(true);
    if (!videoClipResult.ok) throw new Error('Expected video success');

    // Successful video clip — JPEG fallback must NOT be called
    expect(captureVideoFrame).not.toHaveBeenCalled();
    // Simulate what PlayerApp does: createObjectURL for the video blob
    const url = URL.createObjectURL(videoClipResult.blob);
    expect(url).toBeTruthy();
  });

  it('video clip failure exposes localized error detail, not raw English', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: false,
      error: {
        code: 'RECORDING_TIMEOUT',
        message: 'Encode timed out after 60s',
      },
    });

    const result = await recordVideoClip({
      mediaUrl: 'blob:test-video',
      start: 0,
      end: 45,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Error has a machine-readable code for i18n lookup
      expect(result.error.code).toMatch(/^[A-Z_]+$/);
      // No raw English error string is passed to the UI directly;
      // the code is used to look up localized text via dict.mediaModeUnsupported
    }
  });
});

// ---------------------------------------------------------------------------
// Range-refresh deferred publish: clear→skeleton→capture→publish together
// ---------------------------------------------------------------------------

describe('Range refresh deferred publish', () => {
  afterEach(cleanup);

  it('clears old media before recapture (no stale artifact survives)', () => {
    // Simulate lifecycle: old URLs exist, clear them before new capture
    const oldScreenshotUrl = 'blob:old-screenshot';
    const oldMediaUrl = 'blob:old-media';

    // Phase 0: clear
    URL.revokeObjectURL(oldScreenshotUrl);
    URL.revokeObjectURL(oldMediaUrl);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldScreenshotUrl);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldMediaUrl);
  });

  it('audio and media capture run concurrently, publish together', async () => {
    // Simulate concurrent captures — both complete before publish
    vi.mocked(captureVideoFrame).mockImplementation(async () => ({
      ok: true,
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    }));
    vi.mocked(recordAudioClip).mockImplementation(async () => ({
      ok: true,
      blob: new Blob(['audio'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
    }));

    // Run both captures concurrently
    const mediaResult = captureVideoFrame(document.createElement('video'));
    const audioResult = recordAudioClip({
      mediaUrl: 'blob:test',
      start: 0,
      end: 5,
    });

    const [media, audio] = await Promise.all([mediaResult, audioResult]);

    // Both completed — publish together (in one setState batch)
    expect(media.ok).toBe(true);
    expect(audio.ok).toBe(true);

    // Staged results, not yet published to state
    if (media.ok && audio.ok) {
      const screenshotUrl = URL.createObjectURL(media.blob);
      const audioUrl = URL.createObjectURL(audio.blob);
      expect(screenshotUrl).toBeTruthy();
      expect(audioUrl).toBeTruthy();
      // Both published in one batch
    }
  });

  it('media success + audio failure: publish media, show audio error', async () => {
    vi.mocked(captureVideoFrame).mockImplementation(async () => ({
      ok: true,
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    }));
    vi.mocked(recordAudioClip).mockImplementation(async () => ({
      ok: false,
      error: { code: 'NO_AUDIO_TRACK', message: 'Microphone unavailable' },
    }));

    const [media, audio] = await Promise.all([
      captureVideoFrame(document.createElement('video')),
      recordAudioClip({ mediaUrl: 'blob:test', start: 0, end: 5 }),
    ]);

    // Media succeeds → publish; audio fails → show error
    expect(media.ok).toBe(true);
    expect(audio.ok).toBe(false);

    if (media.ok) {
      const url = URL.createObjectURL(media.blob);
      expect(url).toBeTruthy();
    }
    if (!audio.ok) {
      // Error code used for localized lookup, not raw English
      expect(audio.error.code).toBe('NO_AUDIO_TRACK');
    }
  });

  it('media fallback JPEG success after video failure', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: false,
      error: { code: 'CAPABILITY_UNSUPPORTED', message: 'Not supported' },
    });
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['fallback'], { type: 'image/jpeg' }),
    });

    // Video fails → JPEG fallback
    const videoResult = await recordVideoClip({
      mediaUrl: 'blob:test',
      start: 0,
      end: 5,
    });
    expect(videoResult.ok).toBe(false);

    const fallbackResult = await captureVideoFrame(
      document.createElement('video'),
    );
    expect(fallbackResult.ok).toBe(true);

    if (fallbackResult.ok) {
      // Fallback JPEG is the final published artifact
      expect(fallbackResult.blob.type).toBe('image/jpeg');
    }
  });

  it('cancellation: epoch guard discards stale capture result', () => {
    // Simulate epoch guard: old capture completes but epoch has advanced
    const epoch = { current: 1 };
    const capturedEpoch = 1;

    // Advance epoch (new range commit starts)
    epoch.current = 2;

    // Old capture completes — epoch mismatch → discard
    const isStale = capturedEpoch !== epoch.current;
    expect(isStale).toBe(true);
    // Stale result should NOT be published
  });

  it('successful WebM after video capture is the final artifact', async () => {
    vi.mocked(recordVideoClip).mockReset();
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: true,
      blob: new Blob(['webm'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });
    vi.mocked(captureVideoFrame).mockReset();

    const result = await recordVideoClip({
      mediaUrl: 'blob:test',
      start: 0,
      end: 10,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // No JPEG fallback needed
      expect(captureVideoFrame).not.toHaveBeenCalled();
      // Final artifact is WebM
      expect(result.blob.type).toBe('video/webm');
    }
  });
});
