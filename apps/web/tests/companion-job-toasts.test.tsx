/**
 * Companion job error + quality toast wiring tests.
 * ---------------------------------------------------------------------------
 * A. On companion job failure (phase 'error'):
 *    - every loading surface is cleared (companion loading overlay gone,
 *      start-buffering overlay stays hidden)
 *    - a single sonner toast "An error occurred. Please try again." fires
 *      (once per error, via notifyCompanionError with the fixed id)
 * B. Quality toast wiring (notifyQuality): fired once when the media URL
 *    surfaces (the "handed to the player" moment — speed playable early,
 *    quality at complete), with:
 *    - quality > 0 only (0/NA → no toast)
 *    - one toast per job (ref guard, no duplicate on re-renders)
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// --- Sonner toast spy (notifyQuality / notifyCompanionError) ---
const toastSpy = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: toastSpy,
}));

// --- Mocks for heavy dependencies (same pattern as companion-loading-overlay) ---
const mocks = vi.hoisted(() => ({
  runAnkiConnectionFlow: vi.fn(),
  ankiConnectClientCtor: vi.fn(),
  ankiExportClientCtor: vi.fn(),
}));

vi.mock('@/features/player/anki-connect', () => ({
  AnkiConnectClient: mocks.ankiConnectClientCtor,
  runAnkiConnectionFlow: mocks.runAnkiConnectionFlow,
  AnkiConnectError: class AnkiConnectError extends Error {
    state: string;
    constructor(m: string, s: string) {
      super(m);
      this.state = s;
    }
  },
}));

vi.mock('@/features/player/anki-export-client', () => ({
  AnkiExportClient: mocks.ankiExportClientCtor,
  blobToBase64: vi.fn(),
  generateMediaFilename: vi.fn(() => 'test_file.webm'),
}));

vi.mock('@/features/player/screenshot-capture', () => ({
  captureVideoFrame: vi.fn(),
}));

vi.mock('@/features/player/audio-clip', () => ({
  checkAudioClipCapabilities: vi.fn(() => ({
    supported: true,
    mimeType: 'audio/webm;codecs=opus',
  })),
  recordAudioClip: vi.fn(),
  cancelActiveRecording: vi.fn(),
}));

vi.mock('@/features/player/subtitle-interval', () => ({
  selectCueTextInRange: vi.fn(() => ''),
}));

vi.mock('@/features/player/preferences', () => ({
  readPlayerPreferences: vi.fn(() => ({
    volume: 1,
    playbackRate: 1,
    captionDisplayMode: 'visible',
  })),
  writePlayerPreferences: vi.fn(),
}));

vi.mock('@/features/player/media-url', () => ({
  createMediaUrl: vi.fn((file: File) => URL.createObjectURL(file)),
  revokeUrl: vi.fn(),
  MEDIA_ACCEPT: '.mp4,.webm',
  SUBTITLE_ACCEPT: '.srt,.vtt',
  classifyMediaFile: vi.fn(() => ({ kind: 'video' as const, ext: 'mp4' })),
  classifyMediaError: vi.fn(),
  isVideoFile: vi.fn(() => false),
  isAudioFile: vi.fn(() => false),
  isSubtitleFile: vi.fn(() => false),
  getFileExtension: vi.fn(() => 'mp4'),
}));

vi.mock('@/features/player/subtitle-reader', () => ({
  parseSubtitle: vi.fn(() => ({ cues: [], errors: [] })),
  findActiveCue: vi.fn(() => null),
}));

vi.mock('@/features/player/control-helpers', () => ({
  formatTime: vi.fn(
    (s: number) => `00:${Math.floor(s).toString().padStart(2, '0')}`,
  ),
  surfaceClickEffect: vi.fn(() => ({ setVisibility: null, togglePlay: false })),
  nextCaptionDisplayMode: vi.fn(),
  toggleMute: vi.fn(),
  clampSeek: vi.fn(),
  isFullscreenAvailable: vi.fn(() => false),
  isDocumentFullscreen: vi.fn(() => false),
  isControlTarget: vi.fn(() => false),
  BLUR_RESTORE_TIMEOUT_MS: 1000,
  PLAYBACK_RATES: [1],
}));

vi.mock('@/features/player/use-keyboard-shortcuts', () => ({
  useKeyboardShortcuts: vi.fn(),
}));

vi.mock('@/features/player/mining-preview', () => ({
  captureMiningScreenshot: vi.fn(),
  captureMiningAudio: vi.fn(),
  cancelMiningCapture: vi.fn(),
}));

vi.mock('@/features/player/mining-viewport', () => ({
  selectRangeFromCue: vi.fn(() => ({ start: 0, end: 1 })),
}));

vi.mock('@/features/player/anki-miner-preferences', () => ({
  readAnkiMinerPreferences: vi.fn(() => ({
    presetName: 'Default',
    ankiConnectUrl: 'http://127.0.0.1:8765',
    deck: 'Japanese',
    noteType: 'Basic',
    fields: {
      sentence: 'Front',
      definition: null,
      image: null,
      audio: null,
      word: null,
      source: null,
      tags: null,
    },
    exportMode: 'new',
  })),
  writeAnkiMinerPreferences: vi.fn(),
}));

vi.mock('@/features/player/mining-history', () => ({
  readHistory: vi.fn(() => []),
}));

vi.mock('@/features/player/mining-history-write', () => ({
  writeHistory: vi.fn(),
}));

vi.mock('@/features/player/video-clip', () => ({
  recordVideoClip: vi.fn(),
  checkVideoClipSupport: vi.fn(() => ({ supported: false })),
}));

vi.mock('@/components/player/PlayerControls', () => ({
  PlayerControls: vi.fn(() => null),
}));

vi.mock('@/components/player/ScreenshotPreviewDialog', () => ({
  ScreenshotPreviewDialog: vi.fn(() => null),
}));

vi.mock('@/components/player/AudioClipPreviewDialog', () => ({
  AudioClipPreviewDialog: vi.fn(() => null),
}));

vi.mock('@/components/player/MiningPreviewDialog', () => ({
  MiningPreviewDialog: vi.fn(() => null),
}));

vi.mock('@/components/player/AnkiAppendPanel', () => ({
  AnkiAppendPanel: vi.fn(() => null),
}));

vi.mock('@/components/player/SubtitlePanel', () => ({
  SubtitlePanel: vi.fn(() => null),
}));

vi.mock('@/components/player/SubtitleOverlay', () => ({
  SubtitleOverlay: vi.fn(() => null),
}));

vi.mock('@/components/player/VideoPlayer', () => ({
  VideoPlayer: vi.fn(() => null),
}));

vi.mock('@/components/player/MediaPicker', () => ({
  MediaPicker: vi.fn(() => null),
}));

vi.mock('@/components/player/RightPanel', () => ({
  RightPanel: vi.fn(() => null),
}));

vi.mock('@i18n/locale-events', () => ({
  LOCALE_CHANGE_EVENT: 'entei:locale-change',
}));

// Dict proxy reads the translation of a single key; returns '' otherwise.
// The mode labels are served separately so the quality-toast wiring tests
// can pin both en ("Speed"/"Quality") and ja ("スピード"/「画質」) forms.
let mockDictKey = '';
let mockDictValue = '';
let mockModeLabelSpeed = 'Speed';
let mockModeLabelQuality = 'Quality';
vi.mock('@i18n/index', () => ({
  getDictionary: vi.fn(() => ({
    hub: { systemLabel: '', lead: '' },
    player: { title: '', description: '', cta: '', },
    playerUI: new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'ytModeLabelSpeed') return mockModeLabelSpeed;
          if (prop === 'ytModeLabelQuality') return mockModeLabelQuality;
          return prop === mockDictKey ? mockDictValue : '';
        },
      },
    ),
    reader: { title: '', description: '', status: '' },
    privacy: { local: '' },
    nav: { backToGorakudo: '', backToHome: '', skipToMain: '' },
    language: { selectLabel: '' },
    playerPage: { title: '', lead: '', backToHome: '' },
    notFound: { title: '', lead: '', backToHome: '' },
  })),
}));

// --- Mock useCompanionJobSession to control phase/jobMediaUrl/quality ---
let mockJobSession = {};

function makeJobSession(overrides: Record<string, unknown>) {
  return {
    active: false,
    kind: null,
    phase: 'idle',
    progress: null,
    reason: null,
    errorCode: null,
    jobId: null,
    jobQuality: 0,
    jobMode: null,
    jobMediaUrl: null,
    subtitleUrl: null,
    jobTitle: null,
    beginJobSession: vi.fn(),
    cancelActiveJob: vi.fn(),
    endJobSession: vi.fn(),
    attachMediaElement: vi.fn(),
    setPlayIntent: vi.fn(),
    requestSeek: vi.fn(),
    ...overrides,
  };
}

vi.mock('@/features/player/use-companion-job-session', () => ({
  useCompanionJobSession: () => mockJobSession,
}));

// Import AFTER mocks
import PlayerApp from '@/components/player/PlayerApp';

beforeEach(() => {
  vi.useFakeTimers();
  mockJobSession = makeJobSession({});
  mockDictKey = '';
  mockDictValue = '';
  mockModeLabelSpeed = 'Speed';
  mockModeLabelQuality = 'Quality';
  toastSpy.info.mockReset();
  toastSpy.error.mockReset();

  mocks.runAnkiConnectionFlow.mockResolvedValue({
    decks: ['Japanese'],
    models: ['Basic'],
    requireApiKey: false,
  });

  window.matchMedia = vi.fn().mockImplementation((_query: string) => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));

  global.ResizeObserver = vi.fn(function () {
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

describe('Companion job error: loading cleared + toast', () => {
  it('clears the loading overlay and fires the error toast on phase error', async () => {
    mockDictKey = 'companionJobError';
    mockDictValue = 'An error occurred. Please try again.';
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'buffering',
      jobMediaUrl: null,
    });

    const { container, rerender } = render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Buffering with no media URL → companion loading overlay visible.
    expect(container.querySelector('.entei-companion-loading')).not.toBeNull();

    // The job fails: phase error, still active, no media URL.
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'error',
      reason: 'download failed',
      jobMediaUrl: null,
    });
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // (a) Loading cleared.
    expect(container.querySelector('.entei-companion-loading')).toBeNull();
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
    // (b) Error toast fired exactly once with the localized message, the
    // fixed dedupe id, and the Lucide icon (not Sonner's default circle).
    expect(toastSpy.error).toHaveBeenCalledTimes(1);
    const errCall = toastSpy.error.mock.calls[0] as [
      string,
      { id: string; icon: unknown },
    ];
    expect(errCall[0]).toBe('An error occurred. Please try again.');
    expect(errCall[1].id).toBe('eizouden-companion-error');
    expect(errCall[1].icon).toBeDefined();
  });

  it('does not fire duplicate toasts across re-renders of the same error', async () => {
    mockDictKey = 'companionJobError';
    mockDictValue = 'An error occurred. Please try again.';
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'error',
      jobMediaUrl: null,
    });

    const { rerender } = render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.error).toHaveBeenCalledTimes(1);

    // Same error phase on a re-render → no second toast.
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.error).toHaveBeenCalledTimes(1);
  });

  it('shows a centered failure fallback in the player frame on error (no black void)', async () => {
    mockDictKey = 'companionJobFailed';
    mockDictValue = 'The download failed. Please try a new URL or choose a file.';
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'error',
      jobMediaUrl: null,
    });

    const { container } = render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The player frame must show the failure copy (not a black void and
    // NOT a spinner — no loading overlay either).
    const fallback = container.querySelector('.entei-player-job-error');
    expect(fallback).not.toBeNull();
    expect(
      fallback!.querySelector('.entei-player-job-error-text')!.textContent,
    ).toBe('The download failed. Please try a new URL or choose a file.');
    expect(fallback!.querySelector('svg')).not.toBeNull(); // icon
    // No loading surfaces on error.
    expect(container.querySelector('.entei-companion-loading')).toBeNull();
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });

  it('hides the start-buffering overlay when the job errors while buffering', async () => {
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'buffering',
      jobMediaUrl: 'http://127.0.0.1:4322/v1/media/fixture?token=t',
    });

    const { container, rerender } = render(<PlayerApp />);

    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'error',
      jobMediaUrl: null,
    });
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Neither the pre-URL loading nor the start-buffering overlay remains.
    expect(container.querySelector('.entei-companion-loading')).toBeNull();
    expect(container.querySelector('.entei-start-buffering')).toBeNull();
  });
});

describe('Quality toast wiring (notifyQuality)', () => {
  it('speed mode: fires exactly once when the media URL surfaces (playable)', async () => {
    mockDictKey = 'ytModeToastFormat';
    mockDictValue = '{mode} Mode - {quality} will start playing';
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'buffering',
      jobMediaUrl: null,
      jobId: 'job-speed-1',
      jobQuality: 720,
      jobMode: 'speed',
    });

    const { rerender } = render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.info).not.toHaveBeenCalled();

    // playable → the media URL surfaces: quality toast fires once.
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'ready',
      jobMediaUrl: 'http://127.0.0.1:4322/v1/media/fixture?token=t',
      jobId: 'job-speed-1',
      jobQuality: 720,
      jobMode: 'speed',
    });
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.info).toHaveBeenCalledTimes(1);
    const infoCall = toastSpy.info.mock.calls[0] as [
      string,
      { id: string; icon: unknown },
    ];
    expect(infoCall[0]).toBe('Speed Mode - 720p will start playing');
    expect(infoCall[1].id).toBe('eizouden-quality720pSpeed');
    expect(infoCall[1].icon).toBeDefined(); // Lucide icon, not the default circle

    // Any subsequent render (same phase) must NOT fire a second toast.
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.info).toHaveBeenCalledTimes(1);
  });

  it('quality mode: fires once after completion (complete → ready)', async () => {
    mockDictKey = 'ytModeToastFormat';
    mockDictValue = '{mode} Mode - {quality} will start playing';
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'buffering',
      jobMediaUrl: null,
      jobId: 'job-quality-1',
      jobQuality: 1080,
      jobMode: 'quality',
    });

    const { rerender } = render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.info).not.toHaveBeenCalled();

    // quality mode reaches playable only at complete → the URL surfaces
    // then and the toast fires (same "handed to player" moment).
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'ready',
      jobMediaUrl: 'http://127.0.0.1:4322/v1/media/fixture?token=t',
      jobId: 'job-quality-1',
      jobQuality: 1080,
      jobMode: 'quality',
    });
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.info).toHaveBeenCalledTimes(1);
    const qCall = toastSpy.info.mock.calls[0] as [
      string,
      { id: string; icon: unknown },
    ];
    expect(qCall[0]).toBe('Quality Mode - 1080p will start playing');
    expect(qCall[1].id).toBe('eizouden-quality1080pQuality');
    expect(qCall[1].icon).toBeDefined();
  });

  it('naturalized id format: "Speed Mode - 360p segera diputar" / "Quality Mode - 1080p segera diputar"', async () => {
    mockDictKey = 'ytModeToastFormat';
    mockDictValue = '{mode} Mode - {quality} segera diputar';
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'ready',
      jobMediaUrl: 'http://127.0.0.1:4322/v1/media/fixture?token=t',
      jobId: 'job-id-speed-360',
      jobQuality: 360,
      jobMode: 'speed',
    });

    const { rerender } = render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const speedCall = toastSpy.info.mock.calls[0] as [string, { id: string }];
    expect(speedCall[0]).toBe('Speed Mode - 360p segera diputar');
    expect(speedCall[1].id).toBe('eizouden-quality360pSpeed');

    // Quality 1080p on the same format.
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'ready',
      jobMediaUrl: 'http://127.0.0.1:4322/v1/media/fixture?token=t',
      jobId: 'job-id-quality-1080',
      jobQuality: 1080,
      jobMode: 'quality',
    });
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const qualityCall = toastSpy.info.mock.calls[1] as [string, { id: string }];
    expect(qualityCall[0]).toBe('Quality Mode - 1080p segera diputar');
    expect(qualityCall[1].id).toBe('eizouden-quality1080pQuality');
  });

  it('ja naturalized format: "スピードモード - 360p をすぐに再生します" / "画質モード - 1080p をすぐに再生します"', async () => {
    mockDictKey = 'ytModeToastFormat';
    mockDictValue = '{mode}モード - {quality} をすぐに再生します';
    mockModeLabelSpeed = 'スピード';
    mockModeLabelQuality = '画質';
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'ready',
      jobMediaUrl: 'http://127.0.0.1:4322/v1/media/fixture?token=t',
      jobId: 'job-ja-speed-360',
      jobQuality: 360,
      jobMode: 'speed',
    });

    const { rerender } = render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const speedCall = toastSpy.info.mock.calls[0] as [string, { id: string }];
    expect(speedCall[0]).toBe('スピードモード - 360p をすぐに再生します');
    expect(speedCall[1].id).toBe('eizouden-quality360pスピード');

    // Quality 1080p on the same ja format.
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'ready',
      jobMediaUrl: 'http://127.0.0.1:4322/v1/media/fixture?token=t',
      jobId: 'job-ja-quality-1080',
      jobQuality: 1080,
      jobMode: 'quality',
    });
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const qualityCall = toastSpy.info.mock.calls[1] as [string, { id: string }];
    expect(qualityCall[0]).toBe('画質モード - 1080p をすぐに再生します');
    expect(qualityCall[1].id).toBe('eizouden-quality1080p画質');
  });

  it('does NOT fire when quality is unknown (0)', async () => {
    mockDictKey = 'ytModeToastFormat';
    mockDictValue = '{mode} Mode - {quality} will start playing';
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'ready',
      jobMediaUrl: 'http://127.0.0.1:4322/v1/media/fixture?token=t',
      jobId: 'job-noq-1',
      jobQuality: 0,
      jobMode: 'speed',
    });

    const { rerender } = render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.info).not.toHaveBeenCalled();

    // Even a re-render with no quality change stays silent.
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.info).not.toHaveBeenCalled();
  });

  it('does not fire twice across phase transitions of the same job', async () => {
    mockDictKey = 'ytModeToastFormat';
    mockDictValue = '{mode} Mode - {quality} will start playing';
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'ready',
      jobMediaUrl: 'http://127.0.0.1:4322/v1/media/fixture?token=t',
      jobId: 'job-once-1',
      jobQuality: 480,
      jobMode: 'speed',
    });

    const { rerender } = render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.info).toHaveBeenCalledTimes(1);

    // ready → playing transition of the SAME job: still one toast.
    mockJobSession = makeJobSession({
      active: true,
      kind: 'youtube',
      phase: 'playing',
      jobMediaUrl: 'http://127.0.0.1:4322/v1/media/fixture?token=t',
      jobId: 'job-once-1',
      jobQuality: 480,
      jobMode: 'speed',
    });
    rerender(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.info).toHaveBeenCalledTimes(1);
  });
});