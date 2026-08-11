/**
 * Behavioral tests for PlayerApp background AnkiConnect connection.
 * ---------------------------------------------------------------------------
 * - Render PlayerApp (mocked children) → runAnkiConnectionFlow called on mount
 * - Failure → advancing ~10s fires retry; no concurrent duplicate
 * - Unmount after failure → advancing timers: no retry, AbortSignal aborted
 * - Navigation settings events update subtitle appearance and Anki session state
 * - Background success → no retry scheduled
 * - API-key-required result leaves session null; no write client called
 * - No write actions invoked during background connection
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import {
  dispatchAnkiSessionCredentials,
  dispatchSubtitleSettingsChange,
} from '@/features/player/settings-bridge';

// --- Mocks for heavy dependencies (must use vi.hoisted for shared access) ---

const mocks = vi.hoisted(() => ({
  runAnkiConnectionFlow: vi.fn(),
  ankiConnectClientCtor: vi.fn(),
  ankiExportClientCtor: vi.fn(),
}));

// Capture callbacks from mocked child components for direct invocation
const capture = vi.hoisted(() => ({
  onMediaSelect: null as ((file: File) => void) | null,
  subtitleAppearance: null as {
    fontSize: number;
    textColor: string;
    backgroundColor: string;
    backgroundPadding: number;
    verticalPosition: number;
  } | null,
  miningPreviewProps: null as Record<string, unknown> | null,
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
    subtitleFontSize: 18,
    subtitleTextColor: 'oklch(98% 0 0deg)',
    subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
    subtitleBackgroundPadding: 8,
    subtitleVerticalPosition: 96,
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
  MiningPreviewDialog: vi.fn((props: Record<string, unknown>) => {
    capture.miningPreviewProps = props;
    return null;
  }),
}));

vi.mock('@/components/player/AnkiAppendPanel', () => ({
  AnkiAppendPanel: vi.fn(() => null),
}));

vi.mock('@/components/player/SubtitlePanel', () => ({
  SubtitlePanel: vi.fn(() => null),
}));

vi.mock('@/components/player/SubtitleOverlay', () => ({
  SubtitleOverlay: vi.fn((props: Record<string, unknown>) => {
    capture.subtitleAppearance = props.appearance as typeof capture.subtitleAppearance;
    return null;
  }),
}));

vi.mock('@/components/player/VideoPlayer', () => ({
  VideoPlayer: vi.fn(() => null),
}));

vi.mock('@/components/player/MediaPicker', () => ({
  MediaPicker: vi.fn((props: Record<string, unknown>) => {
    // Capture onSelect for triggering media load in tests
    if (typeof props.onSelect === 'function') {
      capture.onMediaSelect = props.onSelect as (file: File) => void;
    }
    return null;
  }),
}));

vi.mock('@i18n/index', () => ({
  getDictionary: vi.fn(() => ({
    hub: { systemLabel: '', lead: '' },
    player: { title: '', description: '', cta: '' },
    playerUI: new Proxy({}, {
      get: (_target, property) => {
        if (property === 'exportSendDisabledNoConnection') return 'no-connection';
        if (property === 'exportSendDisabledNoSentence') return 'no-sentence';
        if (property === 'exportSendDisabledInvalidPreset') return 'invalid-preset';
        return '';
      },
    }),
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

// Import after mocks are set up
import PlayerApp from '@/components/player/PlayerApp';

beforeEach(() => {
  vi.useFakeTimers();
  mocks.runAnkiConnectionFlow.mockReset();
  mocks.ankiConnectClientCtor.mockReset();
  mocks.ankiExportClientCtor.mockReset();
  mocks.ankiConnectClientCtor.mockImplementation(function () {
    return {};
  });
  capture.onMediaSelect = null;
  capture.subtitleAppearance = null;
  capture.miningPreviewProps = null;
  // JSDOM lacks matchMedia
  window.matchMedia =
    window.matchMedia ||
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  // JSDOM lacks ResizeObserver
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

describe('Background AnkiConnect connection — behavioral', () => {
  it('calls runAnkiConnectionFlow on mount without opening Settings', async () => {
    mocks.runAnkiConnectionFlow.mockResolvedValue({
      decks: ['Japanese'],
      models: ['Basic'],
      requireApiKey: false,
    });

    render(<PlayerApp />);

    // Flush microtasks so the async attemptBackgroundConnect runs
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mocks.runAnkiConnectionFlow).toHaveBeenCalledTimes(1);
    // AnkiConnectClient constructed with saved endpoint, no API key
    expect(mocks.ankiConnectClientCtor).toHaveBeenCalledWith(
      'http://127.0.0.1:8765',
      undefined,
    );
  });

  it('retries ~10s after failure, no concurrent duplicate', async () => {
    mocks.runAnkiConnectionFlow.mockRejectedValue(new Error('Network'));

    render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // First attempt fired
    expect(mocks.runAnkiConnectionFlow).toHaveBeenCalledTimes(1);

    // Advance 5s — should NOT have retried yet
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.runAnkiConnectionFlow).toHaveBeenCalledTimes(1);

    // Advance remaining 5s → retry fires
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.runAnkiConnectionFlow).toHaveBeenCalledTimes(2);
  });

  it('unmount after failure → no retry, AbortSignal aborted', async () => {
    let capturedSignal: AbortSignal | undefined;
    mocks.runAnkiConnectionFlow.mockImplementation(
      async (_client: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        throw new Error('Network');
      },
    );

    const { unmount } = render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mocks.runAnkiConnectionFlow).toHaveBeenCalledTimes(1);
    expect(capturedSignal).toBeDefined();

    unmount();

    // AbortSignal must be marked as aborted after unmount cleanup
    expect(capturedSignal!.aborted).toBe(true);

    // Advance timers — should NOT retry
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.runAnkiConnectionFlow).toHaveBeenCalledTimes(1);
  });

  it('navigation subtitle event updates overlay state without PlayerControls props', async () => {
    mocks.runAnkiConnectionFlow.mockResolvedValue({
      decks: [],
      models: [],
      requireApiKey: true,
    });

    render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      capture.onMediaSelect!(
        new File(['test'], 'test.mp4', { type: 'video/mp4' }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(capture.subtitleAppearance?.fontSize).toBe(18);

    await act(async () => {
      dispatchSubtitleSettingsChange({
        fontSize: 40,
        backgroundPadding: 48,
        verticalPosition: 100,
      });
    });

    expect(capture.subtitleAppearance).toMatchObject({
      fontSize: 40,
      backgroundPadding: 48,
      verticalPosition: 100,
    });
  });

  it('navigation credentials supersede stale background work and remain memory-only', async () => {
    let bgResolve!: (value: unknown) => void;
    mocks.runAnkiConnectionFlow.mockReturnValue(
      new Promise((resolve) => {
        bgResolve = resolve;
      }),
    );
    localStorage.clear();

    render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      capture.onMediaSelect!(
        new File(['test'], 'test.mp4', { type: 'video/mp4' }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(capture.miningPreviewProps?.exportDisabledReason).toBe('no-connection');

    await act(async () => {
      dispatchAnkiSessionCredentials({
        endpoint: 'http://settings-host:8765',
        apiKey: 'fixture-key',
      });
    });

    expect(capture.miningPreviewProps?.exportDisabledReason).toBe('no-sentence');
    expect(localStorage.getItem('entei.player.anki-miner.v1')).toBeNull();

    await act(async () => {
      bgResolve({
        decks: ['Japanese'],
        models: ['Basic'],
        requireApiKey: false,
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mocks.runAnkiConnectionFlow).toHaveBeenCalledTimes(1);

    await act(async () => {
      dispatchAnkiSessionCredentials(null);
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(capture.miningPreviewProps?.exportDisabledReason).toBe('no-sentence');
    expect(mocks.runAnkiConnectionFlow).toHaveBeenCalledTimes(2);
  });

  it('background success → no retry scheduled', async () => {
    mocks.runAnkiConnectionFlow.mockResolvedValue({
      decks: ['Japanese'],
      models: ['Basic'],
      requireApiKey: false,
    });

    render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mocks.runAnkiConnectionFlow).toHaveBeenCalledTimes(1);

    // Advance well past retry interval — no retry after success
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.runAnkiConnectionFlow).toHaveBeenCalledTimes(1);
  });

  it('API-key-required result leaves session unavailable; no write client', async () => {
    mocks.runAnkiConnectionFlow.mockResolvedValue({
      decks: [],
      models: [],
      requireApiKey: true,
    });

    render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Background flow was called
    expect(mocks.runAnkiConnectionFlow).toHaveBeenCalledTimes(1);
    // AnkiExportClient (write client) must NOT have been constructed
    expect(mocks.ankiExportClientCtor).not.toHaveBeenCalled();
  });

  it('no write/export actions invoked during background connection', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          result: { decks: ['Test'], models: ['Basic'], requireApiKey: false },
          error: null,
        }),
    } as unknown as Response);

    mocks.runAnkiConnectionFlow.mockResolvedValue({
      decks: ['Test'],
      models: ['Basic'],
      requireApiKey: false,
    });

    render(<PlayerApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // fetch may be called by the mock, but AnkiExportClient must not be
    expect(mocks.ankiExportClientCtor).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
