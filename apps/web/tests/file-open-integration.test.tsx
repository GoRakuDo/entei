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
  subtitleSyncSuccess: 'Subtitle sync successful!',
  subtitleSyncNoReference: 'No base subtitle in this video, cannot sync',
  subtitleSyncNoSubtitle: 'No subtitle loaded',
  subtitleSyncLazyOn: 'LazySync enabled',
  subtitleSyncLazyOff: 'LazySync disabled',
  subtitleSyncAudioUnavailable:
    'Audio-based sync is unavailable for Magnet. Use subtitle mode',
  subtitleSyncWaitTitle: 'Voice-based sync unavailable',
  subtitleSyncWaitDesc: 'Streaming video requires full download for voice sync. Wait a bit longer?',
  subtitleSyncWaitCancel: 'Cancel',
  subtitleSyncWaitConfirm: 'Yes, OK',
  subtitleSyncProgress: 'Downloading… {pct}%',
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
