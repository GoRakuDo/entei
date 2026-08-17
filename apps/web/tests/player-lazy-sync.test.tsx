/**
 * PlayerApp LazySync (Magnet) — toggle, offset estimation, apply, and
 * refinement (docs SUBTITLE_SYNC.md §10), plus the Magnet audio-mode
 * disable toast (§10.4).
 *
 * Drives the real PlayerApp with a mocked torrent job session and a routed
 * fetch stub:
 *   - /v1/source/jobs/...  → the user's drift subtitle (loaded via the
 *     standard auto-fetch effect, which sets subtitleTextRef)
 *   - /v1/source/torrents/ → the embedded subtitle (fetchMagnetSubtitle),
 *     served at +1.5 s so the estimated offset must be +1500 ms
 * ---------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import {
  LAZY_SYNC_POLL_INTERVAL_MS,
} from '@/features/player/lazy-sync';
import type { SubtitleCue } from '@/features/player/subtitle-reader';
import { readPlayerPreferences } from '@/features/player/preferences';

// --- Sonner toast spy ---
const toastSpy = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: toastSpy,
}));

// --- Mocked heavy dependencies (companion-subtitle-retry pattern) ---
const mocks = vi.hoisted(() => ({
  runAnkiConnectionFlow: vi.fn(),
  ankiConnectClientCtor: vi.fn(),
  ankiExportClientCtor: vi.fn(),
  capturedCues: null as SubtitleCue[] | null,
  capturedProps: {} as Record<string, unknown>,
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

// RightPanel mock records the props the tests need to drive the toggle and
// observe the applied cues.
vi.mock('@/components/player/RightPanel', () => ({
  RightPanel: vi.fn((props: {
    cues: SubtitleCue[];
    lazySyncOn?: boolean;
    onToggleLazySync?: () => void;
    isMagnet?: boolean;
  }) => {
    mocks.capturedCues = props.cues;
    mocks.capturedProps = props;
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
    player: { title: '', description: '', cta: '' },
    playerUI: {
      subtitleSyncLazyOn: 'LazySync enabled',
      subtitleSyncLazyOff: 'LazySync disabled',
      subtitleSyncLazyActive: "LazySync-Sub's Activated",
      subtitleSyncAudioUnavailable:
        'Audio-based sync is unavailable for Magnet. Use subtitle mode',
      subtitleSyncSuccess: 'Subtitle sync successful!',
      subtitleSyncNoSubtitle: 'No subtitle loaded',
      subtitleSyncNoReference: 'No base subtitle in this video, cannot sync',
    },
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

// The REAL subtitle reader + lazy-sync helpers run.
import Player from '@/components/player/PlayerApp';

// --- Controllable torrent job session ---
let mockSession: Record<string, unknown>;

vi.mock('@/features/player/use-companion-job-session', () => ({
  useCompanionJobSession: () => mockSession,
}));

// The auto-fetch (job subtitleUrl) serves the USER's drift subtitle; the
// LazySync fetch (fetchMagnetSubtitle, torrents endpoint) serves the
// embedded reference at +1.5 s.
const JOB_ID = 'torrent-1';
const TOKEN = 't';
const USER_SUBTITLE_URL = `http://127.0.0.1:4322/v1/source/jobs/${JOB_ID}/subtitle?token=${TOKEN}`;
const MEDIA_URL = 'http://127.0.0.1:4322/v1/media/fixture?token=t';

const USER_VTT = [
  'WEBVTT',
  '',
  '00:00:10.000 --> 00:00:12.000',
  'First line',
  '',
  '00:00:20.000 --> 00:00:22.000',
  'Second line',
  '',
  '00:00:30.000 --> 00:00:32.000',
  'Third line',
  '',
  '00:00:40.000 --> 00:00:42.000',
  'Fourth line',
  '',
  '00:00:50.000 --> 00:00:52.000',
  'Fifth line',
  '',
  '00:00:55.000 --> 00:00:57.000',
  'Sixth line',
].join('\n');

const EMBEDDED_VTT = [
  'WEBVTT',
  '',
  '00:00:11.500 --> 00:00:13.500',
  'First line',
  '',
  '00:00:21.500 --> 00:00:23.500',
  'Second line',
  '',
  '00:00:31.500 --> 00:00:33.500',
  'Third line',
  '',
  '00:00:41.500 --> 00:00:43.500',
  'Fourth line',
  '',
  '00:00:51.500 --> 00:00:53.500',
  'Fifth line',
  '',
  '00:00:56.500 --> 00:00:58.500',
  'Sixth line',
].join('\n');

/** Downloaded prefix with only 3 cues — under the first-sync gate. */
const EMBEDDED_SHORT_VTT = [
  'WEBVTT',
  '',
  '00:00:11.500 --> 00:00:13.500',
  'First line',
  '',
  '00:00:21.500 --> 00:00:23.500',
  'Second line',
  '',
  '00:00:31.500 --> 00:00:33.500',
  'Third line',
].join('\n');

/** 5 downloaded cues, but only 2 land inside the ±5 s match window —
 *  below the quality gate. */
const EMBEDDED_SPARSE_VTT = [
  'WEBVTT',
  '',
  '00:00:11.500 --> 00:00:13.500',
  'First line',
  '',
  '00:00:21.500 --> 00:00:23.500',
  'Second line',
  '',
  '00:01:30.000 --> 00:01:32.000',
  'Late line A',
  '',
  '00:01:40.000 --> 00:01:42.000',
  'Late line B',
  '',
  '00:01:50.000 --> 00:01:52.000',
  'Late line C',
].join('\n');

/** Embedded track runs only +50 ms ahead — already in sync. */
const EMBEDDED_IN_SYNC_VTT = [
  'WEBVTT',
  '',
  '00:00:10.050 --> 00:00:12.050',
  'First line',
  '',
  '00:00:20.050 --> 00:00:22.050',
  'Second line',
  '',
  '00:00:30.050 --> 00:00:32.050',
  'Third line',
  '',
  '00:00:40.050 --> 00:00:42.050',
  'Fourth line',
  '',
  '00:00:50.050 --> 00:00:52.050',
  'Fifth line',
  '',
  '00:00:55.050 --> 00:00:57.050',
  'Sixth line',
].join('\n');

function freshSession() {
  return {
    active: true,
    kind: 'torrent',
    phase: 'playing' as string,
    progress: null,
    reason: null,
    errorCode: null,
    jobMediaUrl: MEDIA_URL,
    subtitleUrl: USER_SUBTITLE_URL,
    token: TOKEN,
    jobId: JOB_ID,
    subtitleFileId: null,
    beginJobSession: vi.fn(),
    cancelActiveJob: vi.fn(() => Promise.resolve()),
    endJobSession: vi.fn(),
    attachMediaElement: vi.fn(),
    setPlayIntent: vi.fn(),
    requestSeek: vi.fn(),
  };
}

/** Route the fetch stub: subtitle auto-fetch vs fetchMagnetSubtitle. */
function routedFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/source/torrents/')) {
      return Promise.resolve(new Response(EMBEDDED_VTT, { status: 200 }));
    }
    if (url.includes('/v1/source/jobs/')) {
      return Promise.resolve(new Response(USER_VTT, { status: 200 }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockSession = freshSession();
  mocks.capturedCues = null;
  mocks.capturedProps = {};
  toastSpy.info.mockClear();
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
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

describe('Magnet LazySync flow (docs §10)', () => {
  it('toggle ON → estimates +1.5 s from embedded cues → applies → success toast', async () => {
    const fetchStub = routedFetch();
    vi.stubGlobal('fetch', fetchStub);
    render(<Player />);

    // The auto-fetch loads the user's drift subtitle (10/20/30 s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      10, 20, 30, 40, 50, 55,
    ]);

    // Toggle ON: toast + the polling loop starts.
    act(() => {
      (mocks.capturedProps.onToggleLazySync as () => void)();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy.info).toHaveBeenCalledWith(
      'LazySync enabled',
      expect.anything(),
    );
    expect(mocks.capturedProps.lazySyncOn).toBe(true);

    // First poll: fetch embedded cues → match → offset +1500 ms applied.
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      11.5, 21.5, 31.5, 41.5, 51.5, 56.5,
    ]);

    // Second poll: offset unchanged → stable → success toast (once).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(toastSpy.success).toHaveBeenCalledWith(
      'Subtitle sync successful!',
      expect.anything(),
    );

    // Later polls keep refining silently: no duplicate success toast, no
    // cue churn.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(fetchStub).toHaveBeenCalledTimes(4);
    expect(toastSpy.success).toHaveBeenCalledTimes(1);
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      11.5, 21.5, 31.5, 41.5, 51.5, 56.5,
    ]);
  });

  it('toggle OFF stops polling and toasts disabled; display keeps the shifted cues', async () => {
    const fetchStub = routedFetch();
    vi.stubGlobal('fetch', fetchStub);
    render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      (mocks.capturedProps.onToggleLazySync as () => void)();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterApply = fetchStub.mock.calls.length;
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      11.5, 21.5, 31.5, 41.5, 51.5, 56.5,
    ]);

    // OFF: toast, loop aborts, and no further fetches happen.
    act(() => {
      (mocks.capturedProps.onToggleLazySync as () => void)();
    });
    expect(toastSpy.info).toHaveBeenLastCalledWith(
      'LazySync disabled',
      expect.anything(),
    );
    expect(mocks.capturedProps.lazySyncOn).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(fetchStub.mock.calls.length).toBe(callsAfterApply);
  });

  it('waits (no apply) while the embedded subtitle serves 0 cues', async () => {
    const fetchStub = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/source/torrents/')) {
        // Subtitle not downloaded yet — serve an empty VTT (0 cues).
        return Promise.resolve(new Response('WEBVTT\n', { status: 200 }));
      }
      return Promise.resolve(new Response(USER_VTT, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchStub);
    render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      (mocks.capturedProps.onToggleLazySync as () => void)();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 0 cue → no offset applied, still processing, display unchanged.
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      10, 20, 30, 40, 50, 55,
    ]);
    expect(toastSpy.success).not.toHaveBeenCalled();
  });

  it('404 (no embedded subtitle track) → immediate error toast + stop, no waiting', async () => {
    const fetchStub = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/source/torrents/')) {
        // No embedded subtitle track in the torrent (permanent).
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      return Promise.resolve(new Response(USER_VTT, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchStub);
    render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);

    act(() => {
      (mocks.capturedProps.onToggleLazySync as () => void)();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The first poll sees the 404 → immediate error toast, toggle stops,
    // and the polling loop does not keep running.
    expect(toastSpy.error).toHaveBeenCalledWith(
      'No base subtitle in this video, cannot sync',
      expect.anything(),
    );
    expect(mocks.capturedProps.lazySyncOn).toBe(false);
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      10, 20, 30, 40, 50, 55,
    ]);

    // No further polls after the stop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(fetchStub.mock.calls.length).toBe(2);
  });

  it('503 (cues pending) → keeps waiting; polls continue and the toggle stays on', async () => {
    const fetchStub = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/source/torrents/')) {
        // Track exists but the DL'd prefix has no cues yet (temporary).
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'cues_pending' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(USER_VTT, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchStub);
    render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      (mocks.capturedProps.onToggleLazySync as () => void)();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // First poll: 503 → waiting state, no apply, no error, still on.
    expect(mocks.capturedProps.lazySyncOn).toBe(true);
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      10, 20, 30, 40, 50, 55,
    ]);
    expect(toastSpy.error).not.toHaveBeenCalled();

    // Subsequent polls keep fetching (the wait is bounded, not stopped).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(fetchStub.mock.calls.length).toBeGreaterThan(2);
    expect(mocks.capturedProps.lazySyncOn).toBe(true);
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it('first-sync gate: downloaded prefix with < 5 cues → wait, no apply', async () => {
    const fetchStub = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/source/torrents/')) {
        // Downloaded prefix holds only 3 cues — under LAZY_SYNC_MIN_REF_CUES.
        return Promise.resolve(
          new Response(EMBEDDED_SHORT_VTT, { status: 200 }),
        );
      }
      return Promise.resolve(new Response(USER_VTT, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchStub);
    render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      (mocks.capturedProps.onToggleLazySync as () => void)();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 3 < 5 ref cues → waiting state: no apply, no toast, still on.
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      10, 20, 30, 40, 50, 55,
    ]);
    expect(toastSpy.success).not.toHaveBeenCalled();
    expect(toastSpy.error).not.toHaveBeenCalled();
    expect(mocks.capturedProps.lazySyncOn).toBe(true);

    // The wait is bounded, not a dead end: polls keep fetching.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(fetchStub.mock.calls.length).toBeGreaterThan(2);
    expect(mocks.capturedProps.lazySyncOn).toBe(true);
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      10, 20, 30, 40, 50, 55,
    ]);
  });

  it('quality gate: < 3 matched cue pairs → wait, offset not applied', async () => {
    const fetchStub = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/source/torrents/')) {
        // 5 downloaded cues but only 2 land inside the ±5 s match window.
        return Promise.resolve(
          new Response(EMBEDDED_SPARSE_VTT, { status: 200 }),
        );
      }
      return Promise.resolve(new Response(USER_VTT, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchStub);
    render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      (mocks.capturedProps.onToggleLazySync as () => void)();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 2 matches < LAZY_SYNC_MIN_MATCHES → quality gate: wait, no apply.
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      10, 20, 30, 40, 50, 55,
    ]);
    expect(toastSpy.success).not.toHaveBeenCalled();
    expect(toastSpy.error).not.toHaveBeenCalled();
    expect(mocks.capturedProps.lazySyncOn).toBe(true);

    // Waiting, not stopped: polling continues for more cues.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(fetchStub.mock.calls.length).toBeGreaterThan(2);
    expect(mocks.capturedProps.lazySyncOn).toBe(true);
  });

  it('already in sync: |offset| < 100 ms → cues untouched, success toast once', async () => {
    const fetchStub = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/source/torrents/')) {
        // Embedded track runs only +50 ms ahead of the user subtitle.
        return Promise.resolve(
          new Response(EMBEDDED_IN_SYNC_VTT, { status: 200 }),
        );
      }
      return Promise.resolve(new Response(USER_VTT, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchStub);
    render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      (mocks.capturedProps.onToggleLazySync as () => void)();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // First poll: offset 50 ms < 100 ms → already synced: no shift applied,
    // but the success toast fires right away.
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      10, 20, 30, 40, 50, 55,
    ]);
    expect(toastSpy.success).toHaveBeenCalledWith(
      'Subtitle sync successful!',
      expect.anything(),
    );

    // Later polls re-check and keep the single toast, display untouched.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(toastSpy.success).toHaveBeenCalledTimes(1);
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      10, 20, 30, 40, 50, 55,
    ]);
  });
});

describe('Magnet + audio mode (docs §10.4)', () => {
  it('clicking the toggle in audio mode shows the unavailable toast and stays off', async () => {
    vi.mocked(readPlayerPreferences).mockReturnValue({
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'visible',
      subtitleFontSize: 32,
      subtitleTextColor: '#ffffff',
      subtitleBackgroundColor: 'rgba(0,0,0,0.75)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
      subtitleSyncMode: 'audio',
    });
    const fetchStub = routedFetch();
    vi.stubGlobal('fetch', fetchStub);
    render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      (mocks.capturedProps.onToggleLazySync as () => void)();
    });
    expect(toastSpy.error).toHaveBeenCalledWith(
      'Audio-based sync is unavailable for Magnet. Use subtitle mode',
      expect.anything(),
    );
    // Toggle did not engage: no polling fetches beyond the auto-fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(mocks.capturedProps.lazySyncOn).toBe(false);
  });
});
