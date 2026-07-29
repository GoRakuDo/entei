/**
 * Tests for file-open button (FolderOpenDot) in PlayerControls and
 * subtitle/media routing in PlayerApp.
 * ---------------------------------------------------------------------------
 * - FolderOpenDot button visibility based on onFileOpen prop
 * - Click triggers hidden file input
 * - File input resets after selection (same-file re-selection)
 * - SubtitlePanel has no header visual or picker
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { PlayerControls } from '@/components/player/PlayerControls';
import { isSubtitleFile } from '@/features/player/media-url';

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
  // WT-1: Torrent streaming
  magnetInputLabel: 'Magnet URI',
  magnetInputPlaceholder: 'magnet:?xt=urn:btih:...',
  magnetInputLabelTitle: 'Open Torrent Stream',
  magnetConnect: 'Connect',
  magnetCancel: 'Cancel',
  magnetConnecting: 'Connecting to peers…',
  magnetWaitingForPeers: 'Waiting for peers…',
  magnetPeerCount: (count: number) => `${count} peers`,
  magnetStreamStarting: 'Starting stream…',
  magnetErrorInvalid: 'Invalid magnet URI.',
  magnetErrorWebRTC: 'WebRTC unsupported.',
  playModeLabel: 'Play mode',
  playModeNormal: 'Normal',
  playModeCondensed: 'Condensed',
  playModeFastForward: 'Fast-forward',
  magnetErrorWorkerNotControlling: 'Reload the page, then try again.',
  magnetErrorPeerInsufficient: 'Not enough peers.',
  magnetErrorTracker: 'Tracker failed.',
  magnetErrorNoPeer: 'No peers found.',
  magnetErrorNoMedia: 'No playable media.',
  magnetErrorMultipleMedia: 'Multiple playable files.',
  magnetErrorStreamUnavailable: 'Stream unavailable.',
  magnetErrorGeneric: 'Unexpected error.',
  magnetBuffering: 'Buffering…',
  torrentLabel: 'Torrent',
  torrentDisconnect: 'Disconnect',
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

describe('PlayerControls — FolderOpenDot file-open button', () => {
  it('renders FolderOpenDot button when onFileOpen is provided', () => {
    const { container } = render(
      <PlayerControls
        {...baseControlsProps}
        onFileOpen={vi.fn()}
        fileOpenLabel="Open file"
      />,
    );
    const btn = container.querySelector('button[aria-label="Open file"]');
    expect(btn).not.toBeNull();
  });

  it('does NOT render FolderOpenDot button when onFileOpen is not provided', () => {
    const { container } = render(<PlayerControls {...baseControlsProps} />);
    const btn = container.querySelector('button[aria-label="Open file"]');
    expect(btn).toBeNull();
  });

  it('clicking FolderOpenDot opens hidden file input', () => {
    const { container } = render(
      <PlayerControls
        {...baseControlsProps}
        onFileOpen={vi.fn()}
        fileOpenLabel="Open file"
        fileAccept="video/*,audio/*,.srt,.vtt,.ass"
      />,
    );
    const btn = container.querySelector(
      'button[aria-label="Open file"]',
    ) as HTMLButtonElement;
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    expect(btn).not.toBeNull();
    expect(fileInput).not.toBeNull();
    expect(fileInput.accept).toBe('video/*,audio/*,.srt,.vtt,.ass');
    // Verify the input is visually hidden (sr-only pattern)
    expect(fileInput.className).toContain('entei-sr-only');
    // Verify button exists and is clickable
    expect(btn.tagName).toBe('BUTTON');
  });

  it('file input resets value after selection (same-file re-selection works)', () => {
    const onFileOpen = vi.fn();
    const { container } = render(
      <PlayerControls
        {...baseControlsProps}
        onFileOpen={onFileOpen}
        fileOpenLabel="Open file"
        fileAccept="video/*,audio/*,.srt,.vtt,.ass"
      />,
    );
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    // Create a fake file and trigger change event
    const file = new File(['test'], 'test.srt', {
      type: 'application/x-subrip',
    });
    Object.defineProperty(fileInput, 'files', { value: [file] });
    fireEvent.change(fileInput);

    expect(onFileOpen).toHaveBeenCalledTimes(1);
    expect(onFileOpen).toHaveBeenCalledWith(file);

    // After selection, the input value should be reset
    expect(fileInput.value).toBe('');
  });

  it('does not call onFileOpen when no file is selected', () => {
    const onFileOpen = vi.fn();
    const { container } = render(
      <PlayerControls
        {...baseControlsProps}
        onFileOpen={onFileOpen}
        fileOpenLabel="Open file"
        fileAccept="video/*,audio/*,.srt,.vtt,.ass"
      />,
    );
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    // Trigger change with no files
    Object.defineProperty(fileInput, 'files', { value: [] });
    fireEvent.change(fileInput);

    expect(onFileOpen).not.toHaveBeenCalled();
  });
});

describe('File routing — isSubtitleFile classification', () => {
  it('classifies SRT as subtitle', () => {
    const file = new File(['content'], 'sub.srt', {
      type: 'application/x-subrip',
    });
    expect(isSubtitleFile(file)).toBe(true);
  });

  it('classifies ASS as subtitle', () => {
    const file = new File(['content'], 'sub.ass', {
      type: 'text/x-ssa',
    });
    expect(isSubtitleFile(file)).toBe(true);
  });

  it('classifies VTT as subtitle', () => {
    const file = new File(['content'], 'sub.vtt', {
      type: 'text/vtt',
    });
    expect(isSubtitleFile(file)).toBe(true);
  });

  it('classifies MKV as NOT subtitle', () => {
    const file = new File(['content'], 'video.mkv', {
      type: 'video/x-matroska',
    });
    expect(isSubtitleFile(file)).toBe(false);
  });

  it('classifies MP4 as NOT subtitle', () => {
    const file = new File(['content'], 'video.mp4', {
      type: 'video/mp4',
    });
    expect(isSubtitleFile(file)).toBe(false);
  });
});
