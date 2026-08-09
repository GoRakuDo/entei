/**
 * PlayerApp YouTube subtitle fetch — bounded retry (ED-2G).
 *
 * Regression for "Speed モードで字幕が出ない": in speed mode the .part
 * streams and the bridge reports 'ready' before the companion's subtitle
 * file exists on disk (yt-dlp writes it in parallel with the media), so
 * the first subtitle fetch can legitimately return 404 ("subtitle not
 * available"). PlayerApp must retry in a bounded loop instead of giving
 * up after one attempt.
 *
 * Drives the real PlayerApp with a mocked companion session and mocked
 * global fetch (companion-loading-overlay pattern):
 *   - first fetch 404 → 5 s later the retry succeeds → cue list fills
 *   - a permanently-404 companion → the retry stops at the 3-minute bound
 * ---------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { SubtitleCue } from '@/features/player/subtitle-reader';

// --- Mocked heavy dependencies (same pattern as companion-loading-overlay) ---
const mocks = vi.hoisted(() => ({
  runAnkiConnectionFlow: vi.fn(),
  ankiConnectClientCtor: vi.fn(),
  ankiExportClientCtor: vi.fn(),
  capturedSubtitle: null as SubtitleCue[] | null,
  capturedIsLoadingSubtitles: false,
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
      sentence: null,
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

// RightPanel is mocked but records the cues + loading props it receives so
// the tests can assert that a successful retry populated the player state.
vi.mock('@/components/player/RightPanel', () => ({
  RightPanel: vi.fn((props: { cues: SubtitleCue[]; isLoadingSubtitles: boolean }) => {
    mocks.capturedSubtitle = props.cues;
    mocks.capturedIsLoadingSubtitles = props.isLoadingSubtitles;
    return null;
  }),
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

vi.mock('@i18n/index', () => ({
  getDictionary: vi.fn(() => ({
    locale: { selectLabel: '' },
    player: { title: '', description: '', cta: '', status: '' },
    playerUI: {},
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

// The REAL subtitle reader is used: parseSubtitle runs on the fetched text.
import Player, {
  SUBTITLE_RETRY_INTERVAL_MS,
  SUBTITLE_RETRY_WINDOW_MS,
} from '@/components/player/PlayerApp';

// --- Controllable companion job session (loading-overlay pattern) ---
let mockSession: any;

vi.mock('@/features/player/use-companion-job-session', () => ({
  useCompanionJobSession: () => mockSession,
}));

const SUBTITLE_URL = 'http://127.0.0.1:4322/v1/source/jobs/abc/subtitle?token=t';
// A non-null media URL makes hasMedia true so the panel (RightPanel mock)
// renders and records the cues prop; the URL itself is never fetched.
const MEDIA_URL = 'http://127.0.0.1:4322/v1/media/fixture?token=t';
const VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:02.000',
  'こんにちは世界',
  '',
  '00:00:02.000 --> 00:00:04.000',
  '字幕リトライ成功',
].join('\n');

function freshSession() {
  return {
    active: false,
    kind: null as string | null,
    phase: 'idle' as string,
    progress: null as { available: number; total: number } | null,
    reason: null as string | null,
    errorCode: null as string | null,
    jobMediaUrl: null as string | null,
    subtitleUrl: null as string | null,
    beginJobSession: vi.fn(),
    cancelActiveJob: vi.fn(() => Promise.resolve()),
    endJobSession: vi.fn(),
    attachMediaElement: vi.fn(),
    setPlayIntent: vi.fn(),
    requestSeek: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockSession = freshSession();
  mocks.capturedSubtitle = null;
  mocks.capturedIsLoadingSubtitles = false;
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

describe('YouTube subtitle fetch — bounded retry in speed mode', () => {
  it('first fetch 404 → retries after 5 s → success fills the cue list', async () => {
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.subtitleUrl = SUBTITLE_URL;
    mockSession.jobMediaUrl = MEDIA_URL;

    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(new Response('subtitle not available', { status: 404 }))
      .mockResolvedValueOnce(new Response(VTT, { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    render(<Player />);

    // Attempt #1 fires immediately → 404 (file not written yet). While
    // the fetch is pending, the subtitle panel must show the loading
    // state (isLoadingSubtitles=true) instead of the empty picker.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(mocks.capturedSubtitle).toEqual([]);
    expect(mocks.capturedIsLoadingSubtitles).toBe(true);

    // One retry interval later the retry fires → 200 → cues are parsed
    // and stored; the loading state clears.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBTITLE_RETRY_INTERVAL_MS);
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(mocks.capturedSubtitle).not.toBeNull();
    expect(mocks.capturedIsLoadingSubtitles).toBe(false);
    const texts = mocks.capturedSubtitle!.map((c) => c.text);
    expect(texts).toContain('こんにちは世界');
    expect(texts).toContain('字幕リトライ成功');
  });

  it('a permanent 404 stops retrying at the 3-minute bound', async () => {
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'playing';
    mockSession.subtitleUrl = SUBTITLE_URL;
    mockSession.jobMediaUrl = MEDIA_URL;

    const fetchStub = vi.fn(() =>
      Promise.resolve(new Response('subtitle not available', { status: 404 })),
    );
    vi.stubGlobal('fetch', fetchStub);

    render(<Player />);

    // Advance well past the retry window in SUBTITLE_RETRY_INTERVAL_MS
    // steps; the loop must have given up by one interval after the
    // window closes. The loop bound is derived from the exported retry
    // constants so it stays correct when the window changes: step until
    // the accumulated elapsed time exceeds the window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    for (
      let i = 0;
      i * SUBTITLE_RETRY_INTERVAL_MS <= SUBTITLE_RETRY_WINDOW_MS;
      i++
    ) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SUBTITLE_RETRY_INTERVAL_MS);
      });
    }
    const totalCallsDone = fetchStub.mock.calls.length;

    // No new fetch may appear afterward, however long we wait (120
    // intervals = 10 minutes, far past the 3-minute window).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * SUBTITLE_RETRY_INTERVAL_MS);
    });
    const totalCallsAfter = fetchStub.mock.calls.length;
    expect(totalCallsAfter).toBe(totalCallsDone);
    expect(mocks.capturedSubtitle).toEqual([]);
    // Mimo BLOCKER (2026-08-09): after the retry deadline the loading
    // state must clear so the panel falls back to the ordinary empty
    // state — a video without subtitles must not show "Preparing
    // subtitles…" forever.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBTITLE_RETRY_INTERVAL_MS);
    });
    expect(mocks.capturedIsLoadingSubtitles).toBe(false);
  });

  it('retry deadline → loading clears and the empty state returns', async () => {
    mockSession.active = true;
    mockSession.kind = 'youtube';
    mockSession.phase = 'ready';
    mockSession.subtitleUrl = SUBTITLE_URL;
    mockSession.jobMediaUrl = MEDIA_URL;

    const fetchStub = vi.fn(() =>
      Promise.resolve(new Response('subtitle not available', { status: 404 })),
    );
    vi.stubGlobal('fetch', fetchStub);

    render(<Player />);

    // While retrying (before the deadline) the panel shows loading.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.capturedIsLoadingSubtitles).toBe(true);

    // Run past SUBTITLE_RETRY_WINDOW_MS in retry steps: the bounded loop
    // gives up at the deadline.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    for (
      let i = 0;
      i * SUBTITLE_RETRY_INTERVAL_MS <= SUBTITLE_RETRY_WINDOW_MS;
      i++
    ) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SUBTITLE_RETRY_INTERVAL_MS);
      });
    }

    // Deadline reached: loading cleared (empty state falls back), cues
    // stay empty (no subtitle): the video has no Japanese subtitle.
    expect(mocks.capturedIsLoadingSubtitles).toBe(false);
    expect(mocks.capturedSubtitle).toEqual([]);
  });
});