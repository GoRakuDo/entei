/**
 * Companion loading overlay — renders a spinner + text while the companion
 * bridge is buffering but the job media URL has not yet been surfaced.
 * ---------------------------------------------------------------------------
 * Verifies the entei-companion-loading element is present when
 * jobSession.active && !jobSession.jobMediaUrl, and absent otherwise.
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// --- Mocks for heavy dependencies (same pattern as player-layout-class) ---
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

vi.mock('@i18n/index', () => ({
  getDictionary: vi.fn(() => ({
    hub: { systemLabel: '', lead: '' },
    player: { title: '', description: '', cta: '', },
    playerUI: new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === 'companionPreparingVideo'
            ? 'Preparing video…'
            : '',
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

vi.mock('@i18n/types', () => ({
  LOCALE_CHANGE_EVENT: 'entei:locale-change',
}));

vi.mock('@i18n/locale-events', () => ({
  LOCALE_CHANGE_EVENT: 'entei:locale-change',
}));

// --- Mock useCompanionJobSession to control active/jobMediaUrl ---
let mockJobSession = {
  active: false,
  kind: null as string | null,
  phase: 'idle' as string,
  progress: null as { available: number; total: number } | null,
  reason: null as string | null,
  errorCode: null as string | null,
  jobMediaUrl: null as string | null,
  beginJobSession: vi.fn(),
  cancelActiveJob: vi.fn(),
  endJobSession: vi.fn(),
  attachMediaElement: vi.fn(),
  setPlayIntent: vi.fn(),
  requestSeek: vi.fn(),
};

vi.mock('@/features/player/use-companion-job-session', () => ({
  useCompanionJobSession: () => mockJobSession,
}));

// Import AFTER mocks
import PlayerApp from '@/components/player/PlayerApp';

beforeEach(() => {
  vi.useFakeTimers();
  mockJobSession = {
    active: false,
    kind: null,
    phase: 'idle',
    progress: null,
    reason: null,
    errorCode: null,
    jobMediaUrl: null,
    beginJobSession: vi.fn(),
    cancelActiveJob: vi.fn(),
    endJobSession: vi.fn(),
    attachMediaElement: vi.fn(),
    setPlayIntent: vi.fn(),
    requestSeek: vi.fn(),
  };

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

describe('Companion loading overlay', () => {
  it('renders when jobSession.active && jobMediaUrl is null', async () => {
    mockJobSession.active = true;
    mockJobSession.jobMediaUrl = null;
    mockJobSession.phase = 'buffering';

    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const overlay = container.querySelector('.entei-companion-loading');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('.entei-companion-loading-text')!.textContent).toBe(
      'Preparing video…',
    );
  });

  it('does not render when jobMediaUrl is present', async () => {
    mockJobSession.active = true;
    mockJobSession.jobMediaUrl = 'http://127.0.0.1:4322/stream/job123';
    mockJobSession.phase = 'ready';

    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(container.querySelector('.entei-companion-loading')).toBeNull();
  });

  it('does not render when jobSession is inactive', async () => {
    mockJobSession.active = false;
    mockJobSession.jobMediaUrl = null;

    const { container } = render(<PlayerApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(container.querySelector('.entei-companion-loading')).toBeNull();
  });
});
