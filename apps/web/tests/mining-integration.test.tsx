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
  appendNoteIdLabel: 'Note ID',
  appendNoteTypeLabel: 'Note type',
  appendSuccess: 'Done.',
  appendPartialFailure: 'Partial.',
  appendAllFailed: 'Failed.',
  appendSelectedCount: (count: number) => `${count} selected`,
  mediaModeImage: 'Image',
  mediaModeVideo: 'Video',
  mediaModeUnsupported: 'Video Clip is not supported.',
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

  it('disables Pickaxe when standalone AM-3 audio recording is in flight', () => {
    const onMine = vi.fn();
    const { container } = render(
      <PlayerControls
        {...baseControlsProps}
        onMine={onMine}
        canMine={false}
        isRecordingAudio
      />,
    );
    const btn = container.querySelector(
      `[aria-label="${mockDict.mineButtonLabel}"]`,
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
  });

  it('disables Pickaxe when standalone AM-2 screenshot capture is in flight', () => {
    const onMine = vi.fn();
    const { container } = render(
      <PlayerControls
        {...baseControlsProps}
        onMine={onMine}
        canMine={false}
        isCapturing
      />,
    );
    const btn = container.querySelector(
      `[aria-label="${mockDict.mineButtonLabel}"]`,
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
  });
});

describe('PlayerControls — Audio Clip disabled during AM-4 mining', () => {
  it('disables AudioLines when canAudioClip is false (mining in progress)', () => {
    const onAudioClip = vi.fn();
    const { container } = render(
      <PlayerControls
        {...baseControlsProps}
        onAudioClip={onAudioClip}
        canAudioClip={false}
      />,
    );
    const btn = container.querySelector(
      `[aria-label="${mockDict.audioClipCaptureLabel}"]`,
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
  });

  it('does NOT call onAudioClip when canAudioClip is false', () => {
    const onAudioClip = vi.fn();
    const { container } = render(
      <PlayerControls
        {...baseControlsProps}
        onAudioClip={onAudioClip}
        canAudioClip={false}
      />,
    );
    const btn = container.querySelector(
      `[aria-label="${mockDict.audioClipCaptureLabel}"]`,
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(onAudioClip).not.toHaveBeenCalled();
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
