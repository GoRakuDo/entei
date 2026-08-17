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
 *     served at +1.5 s so the estimated offset must be +1500 ms.
 * Both tracks are 101 cues so that the histogram's 50-cue sampling (ref
 * indices 0/50/100) yields 3 sampled refs that each sit 1.5 s after a
 * corresponding user cue — a 3-pair peak that clears the quality gate.
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

// --- Fixtures -----------------------------------------------------------
// The user subtitle is the FULL track (101 cues at 10, 15, …, 510 s; 5 s
// spacing) and the embedded track is the same content at +1.5 s. The
// estimator samples every 50th ref cue (indices 0, 50, 100 → 11.5, 261.5,
// 511.5 s), each of which sits exactly 1.5 s after a user cue (10, 260,
// 510 s) — a 3-pair peak at +1500 ms that clears LAZY_SYNC_MIN_PEAK_COUNT
// and the margin gate.

function vttTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `00:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

function vttFromStarts(
  starts: number[],
  textFor: (start: number, index: number) => string = (start) => `line ${start}`,
): string {
  return [
    'WEBVTT',
    '',
    ...starts.flatMap((start, i) => [
      `${vttTime(start)} --> ${vttTime(start + 2)}`,
      textFor(start, i),
      '',
    ]),
  ].join('\n');
}

const USER_CUE_COUNT = 101;
const USER_STARTS = Array.from({ length: USER_CUE_COUNT }, (_, i) => 10 + 5 * i);
const USER_SHIFTED_STARTS = USER_STARTS.map((s) => s + 1.5);

const USER_VTT = vttFromStarts(USER_STARTS);
const EMBEDDED_VTT = vttFromStarts(USER_SHIFTED_STARTS);

/** Downloaded prefix with only 3 cues — under the first-sync gate. */
const EMBEDDED_SHORT_VTT = vttFromStarts([11.5, 12.5, 13.5]);

/** 5 downloaded cues: the full-vote sampling (5 < 50 → stride 1) ranks all
 *  5 cues, but each lands in a different time-difference bin — a 1-pair
 *  peak, below the 3-pair quality gate. */
const EMBEDDED_SPARSE_VTT = vttFromStarts([11.5, 21.5, 97.7, 163.4, 254.9]);

/** Embedded track runs only +50 ms ahead — already in sync. */
const EMBEDDED_IN_SYNC_VTT = vttFromStarts(USER_STARTS.map((s) => s + 0.05));

// Text-matching fixtures: the embedded track shares the user subtitle's
// texts verbatim but drifts +10 s — beyond half the 5 s user cue spacing,
// so only the text-matching phase can recover the offset.
const USER_TEXT_MATCH_VTT = vttFromStarts(
  USER_STARTS,
  (_start, i) => `text ${i}`,
);
const EMBEDDED_TEXT_MATCH_VTT = vttFromStarts(
  USER_STARTS.map((s) => s + 10),
  (_start, i) => `text ${i}`,
);

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
  it('toggle ON → estimates +1.5 s from embedded cues → applies silently (no success toast)', async () => {
    const fetchStub = routedFetch();
    vi.stubGlobal('fetch', fetchStub);
    render(<Player />);

    // The auto-fetch loads the user's full drift subtitle (10…110 s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      ...USER_STARTS,
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
      ...USER_SHIFTED_STARTS,
    ]);

    // Second poll: offset unchanged → stable → no success toast (Magnet
    // LazySync runs silently).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(toastSpy.success).not.toHaveBeenCalled();

    // Later polls keep refining silently: still no success toast, no cue
    // churn.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(fetchStub).toHaveBeenCalledTimes(4);
    expect(toastSpy.success).not.toHaveBeenCalled();
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      ...USER_SHIFTED_STARTS,
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
      ...USER_SHIFTED_STARTS,
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
      ...USER_STARTS,
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
      ...USER_STARTS,
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
      ...USER_STARTS,
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
      ...USER_STARTS,
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
      ...USER_STARTS,
    ]);
  });

  it('quality gate: peak histogram bin holds < 3 pairs → wait, offset not applied', async () => {
    const fetchStub = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/source/torrents/')) {
        // 5 downloaded cues: full-vote sampling (5 < 50 → stride 1) ranks
        // all 5, but each diff lands in its own bin — a 1-pair peak, below
        // LAZY_SYNC_MIN_PEAK_COUNT.
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
    // Peak of 1 pair < LAZY_SYNC_MIN_PEAK_COUNT → quality gate: wait,
    // no apply.
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      ...USER_STARTS,
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

  it('already in sync: |offset| < 100 ms → cues untouched, no success toast', async () => {
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
    // First poll: offset 50 ms < 100 ms → already synced: no shift applied
    // and no success toast (Magnet runs silently).
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      ...USER_STARTS,
    ]);
    expect(toastSpy.success).not.toHaveBeenCalled();

    // Later polls re-check and stay silent, display untouched.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(toastSpy.success).not.toHaveBeenCalled();
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      ...USER_STARTS,
    ]);
  });

  it('text matching runs first and recovers a +10 s drift (priority, spec B)', async () => {
    // The embedded track shares the user subtitle's texts but starts +10 s
    // later. Text matching runs FIRST (spec B) and wins with a 101-pair
    // peak at +10 s — the time-based fallback would also estimate +10 s on
    // this 5 s-spaced track (no envelope bound), but the text phase takes
    // priority.
    const fetchStub = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/source/torrents/')) {
        return Promise.resolve(
          new Response(EMBEDDED_TEXT_MATCH_VTT, { status: 200 }),
        );
      }
      return Promise.resolve(new Response(USER_TEXT_MATCH_VTT, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchStub);
    render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual([
      ...USER_STARTS,
    ]);

    act(() => {
      (mocks.capturedProps.onToggleLazySync as () => void)();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // First poll: text phase pairs all 101 cues at +10 s → applied.
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual(
      USER_STARTS.map((s) => s + 10),
    );
    expect(toastSpy.success).not.toHaveBeenCalled();

    // Second poll: offset unchanged → stable → display untouched.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LAZY_SYNC_POLL_INTERVAL_MS);
    });
    expect(mocks.capturedCues!.map((c) => c.start)).toEqual(
      USER_STARTS.map((s) => s + 10),
    );
    expect(toastSpy.success).not.toHaveBeenCalled();
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
