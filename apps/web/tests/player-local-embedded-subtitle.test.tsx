/**
 * Local embedded-subtitle sync (sub-to-sub-auto-ref) — PlayerApp wiring.
 *
 * With a local media file (mediaFileRef set via handleMediaSelect) and a
 * loaded subtitle but no reference subtitle, planSync returns
 * sub-to-sub-auto-ref and PlayerApp extracts the first embedded subtitle
 * track via mkvgo, then syncs the loaded subtitle against it as the
 * reference (syncSubtitleToReference).
 *
 * Drives the real PlayerApp with mocked mkvgo + subtitle-sync (and the
 * companion-loading-overlay mock set), capturing MediaPicker / RightPanel
 * props so tests can feed the exact handlers PlayerApp wires up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import type { SubtitleCue } from '@/features/player/subtitle-reader';

// --- Captured props (filled by the component mocks below) ---
const mocks = vi.hoisted(() => ({
  runAnkiConnectionFlow: vi.fn(),
  ankiConnectClientCtor: vi.fn(),
  ankiExportClientCtor: vi.fn(),
  notifySubtitleSyncError: vi.fn(),
  notifySubtitleSyncSuccess: vi.fn(),
  loadMkvGo: vi.fn(),
  syncSubtitleToAudio: vi.fn(),
  syncSubtitleToReference: vi.fn(),
  capturedCues: null as SubtitleCue[] | null,
  mediaPickerProps: null as { onSelect: (f: File) => void } | null,
  rightPanelProps: null as {
    onSyncSubtitle: () => void;
    onSubtitleSelect: (f: File) => void;
  } | null,
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
  createMediaUrl: vi.fn(() => 'blob:mock-media'),
  revokeUrl: vi.fn(),
  MEDIA_ACCEPT: '.mp4,.webm',
  SUBTITLE_ACCEPT: '.srt,.vtt',
  classifyMediaFile: vi.fn(() => ({ kind: 'video' as const, ext: 'mp4' })),
  classifyMediaError: vi.fn(),
  isVideoFile: vi.fn(() => false),
  isAudioFile: vi.fn(() => false),
  isSubtitleFile: vi.fn(() => true),
  getFileExtension: vi.fn(() => 'srt'),
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

vi.mock('@/features/player/eizouden-toast', () => ({
  notifyQuality: vi.fn(),
  notifyCompanionError: vi.fn(),
  notifySubtitleSyncError: mocks.notifySubtitleSyncError,
  notifySubtitleSyncSuccess: mocks.notifySubtitleSyncSuccess,
}));

// mkvgo is fully mocked: the wasm module never loads in tests.
vi.mock('@/features/player/mkvgo', () => ({
  loadMkvGo: mocks.loadMkvGo,
}));

// The subomatic engine is mocked; syncSubtitleToReference records its args
// and returns a canned WebVTT the real parseSubtitle can consume.
vi.mock('@/features/player/subtitle-sync', () => ({
  syncSubtitleToAudio: mocks.syncSubtitleToAudio,
  syncSubtitleToReference: mocks.syncSubtitleToReference,
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

vi.mock('@/components/player/SubtitleOverlay', () => ({
  SubtitleOverlay: vi.fn(() => null),
}));

vi.mock('@/components/player/VideoPlayer', () => ({
  VideoPlayer: vi.fn(() => null),
}));

// MediaPicker / RightPanel capture their props so tests can invoke the exact
// callbacks PlayerApp wires (onSelect → handleMediaSelect, onSubtitleSelect
// → handleSubtitleSelect, onSyncSubtitle → handleSyncSubtitle).
vi.mock('@/components/player/MediaPicker', () => ({
  MediaPicker: (props: { onSelect: (f: File) => void }) => {
    mocks.mediaPickerProps = props;
    return null;
  },
}));

vi.mock('@/components/player/RightPanel', () => ({
  RightPanel: (props: {
    cues: SubtitleCue[];
    onSubtitleSelect: (f: File) => void;
    onSyncSubtitle: () => void;
  }) => {
    mocks.capturedCues = props.cues;
    mocks.rightPanelProps = props;
    return null;
  },
}));

vi.mock('@i18n/index', () => ({
  getDictionary: vi.fn(() => ({
    locale: { selectLabel: '' },
    player: { title: '', description: '', cta: '' },
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

// The REAL subtitle reader is used: parseSubtitle runs on the synced output.
import Player from '@/components/player/PlayerApp';

// --- Controllable companion job session (local media → kind stays null) ---
let mockSession: any;

vi.mock('@/features/player/use-companion-job-session', () => ({
  useCompanionJobSession: () => mockSession,
}));

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

const LOADED_SUBTITLE = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:02.000',
  'こんにちは世界',
  '',
  '00:00:02.000 --> 00:00:04.000',
  '字幕テスト',
].join('\n');

const EMBEDDED_VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:02.000',
  'embedded line one',
  '',
  '00:00:02.500 --> 00:00:05.000',
  'embedded line two',
].join('\n');

const SYNCED_VTT = [
  'WEBVTT',
  '',
  '00:00:00.100 --> 00:00:02.100',
  'こんにちは世界',
  '',
  '00:00:02.100 --> 00:00:04.100',
  '字幕テスト',
].join('\n');

/** Let FileReader's onload (and React's re-render) settle between the
 *  subtitle select and the sync click, so subtitleTextRef is populated
 *  before handleSyncSubtitle reads it. */
async function flushMicrotasks() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.resolve();
  });
}

/** Probe result with one subtitle track (mkvgo shape). */
function subtitleProbe() {
  return {
    format: 'mkv' as const,
    info: { title: '', muxing_app: '', writing_app: '' },
    duration_ms: 10000,
    tracks: [
      {
        id: 7,
        type: 'subtitle' as const,
        codec: 'subrip',
        is_default: true,
        is_forced: false,
      },
    ],
    chapters: [],
    attachments: [],
    tags: [],
  };
}

beforeEach(() => {
  mockSession = freshSession();
  mocks.capturedCues = null;
  mocks.mediaPickerProps = null;
  mocks.rightPanelProps = null;
  mocks.notifySubtitleSyncError.mockClear();
  mocks.notifySubtitleSyncSuccess.mockClear();
  mocks.loadMkvGo.mockClear();
  mocks.syncSubtitleToReference.mockClear();
  mocks.syncSubtitleToAudio.mockClear();
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
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:mock-media'),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  vi.restoreAllMocks();
});

describe('local embedded-subtitle sync (sub-to-sub-auto-ref)', () => {
  it('extracts the embedded subtitle via mkvgo and syncs against it as the reference', async () => {
    const mkvgo = {
      probe: vi.fn(async (_input: File) => subtitleProbe()),
      extractSubtitleVTT: vi.fn(async (_input: Uint8Array, _id: number) =>
        EMBEDDED_VTT,
      ),
    };
    mocks.loadMkvGo.mockResolvedValue(mkvgo);
    mocks.syncSubtitleToReference.mockResolvedValue(SYNCED_VTT);

    render(<Player />);

    // Local media select → mediaFileRef + mediaUrl set (hasMedia).
    act(() => {
      mocks.mediaPickerProps!.onSelect(new File(['video'], 'a.mp4'));
    });
    // Load the working subtitle (FileReader is async).
    act(() => {
      mocks.rightPanelProps!.onSubtitleSelect(
        new File([LOADED_SUBTITLE], 'sub.vtt', { type: 'text/vtt' }),
      );
    });
    await flushMicrotasks();

    // Fire the sync button.
    act(() => {
      mocks.rightPanelProps!.onSyncSubtitle();
    });
    // FileReader's onload (subtitleTextRef) and the whole mkvgo sync chain
    // complete asynchronously — waitFor turns the event loop for both.
    await waitFor(() => {
      expect(mocks.loadMkvGo).toHaveBeenCalledTimes(1);
    });

    // mkvgo was loaded and probed the File; the embedded VTT became the
    // reference for sub-to-sub sync.
    expect(mocks.loadMkvGo).toHaveBeenCalledWith({
      wasmUrl: '/wasm/mkvgo.wasm',
      wasmExecUrl: '/wasm/wasm_exec.js',
    });
    expect(mkvgo.probe).toHaveBeenCalledTimes(1);
    const probeArgs = mkvgo.probe.mock.calls[0] as [File];
    expect(probeArgs[0]).toBeInstanceOf(File);
    expect(mkvgo.extractSubtitleVTT).toHaveBeenCalledTimes(1);
    const extractArgs = mkvgo.extractSubtitleVTT.mock.calls[0] as [
      Uint8Array,
      number,
    ];
    expect(extractArgs[1]).toBe(7); // track id
    expect(mocks.syncSubtitleToReference).toHaveBeenCalledTimes(1);
    const [subText, , refText] = mocks.syncSubtitleToReference.mock
      .calls[0] as [string, string, string];
    expect(subText).toBe(LOADED_SUBTITLE);
    expect(refText).toBe(EMBEDDED_VTT);

    // The synced result was applied to the panel cue list.
    await waitFor(() => {
      expect(mocks.capturedCues).not.toBeNull();
      expect(mocks.capturedCues!.map((c) => c.text)).toContain('こんにちは世界');
    });
    // The synced cues were applied → the success toast fired exactly once.
    expect(mocks.notifySubtitleSyncSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.notifySubtitleSyncError).not.toHaveBeenCalled();
  });

  it('toasts no-reference when the file has no embedded subtitle track', async () => {
    const mkvgo = {
      probe: vi.fn(async (_input: File) => ({
        ...subtitleProbe(),
        tracks: [
          {
            id: 1,
            type: 'video' as const,
            codec: 'h264',
            is_default: true,
            is_forced: false,
          },
        ],
      })),
      extractSubtitleVTT: vi.fn(async (_input: Uint8Array, _id: number) =>
        '',
      ),
    };
    mocks.loadMkvGo.mockResolvedValue(mkvgo);

    render(<Player />);
    act(() => {
      mocks.mediaPickerProps!.onSelect(new File(['video'], 'a.mp4'));
    });
    act(() => {
      mocks.rightPanelProps!.onSubtitleSelect(
        new File([LOADED_SUBTITLE], 'sub.vtt', { type: 'text/vtt' }),
      );
    });
    await flushMicrotasks();

    act(() => {
      mocks.rightPanelProps!.onSyncSubtitle();
    });
    await waitFor(() => {
      expect(mkvgo.probe).toHaveBeenCalledTimes(1);
    });

    expect(mkvgo.extractSubtitleVTT).not.toHaveBeenCalled();
    expect(mocks.syncSubtitleToReference).not.toHaveBeenCalled();
    expect(mocks.notifySubtitleSyncError).toHaveBeenCalledTimes(1);
  });

  it('toasts no-reference when mkvgo fails to load or extract', async () => {
    mocks.loadMkvGo.mockRejectedValue(new Error('wasm load failed'));

    render(<Player />);
    act(() => {
      mocks.mediaPickerProps!.onSelect(new File(['video'], 'a.mp4'));
    });
    act(() => {
      mocks.rightPanelProps!.onSubtitleSelect(
        new File([LOADED_SUBTITLE], 'sub.vtt', { type: 'text/vtt' }),
      );
    });
    await flushMicrotasks();

    act(() => {
      mocks.rightPanelProps!.onSyncSubtitle();
    });
    // Wait for the sync task to actually reach mkvgo (not just bail on a
    // missing subtitleTextRef), then assert the failure toast.
    await waitFor(() => {
      expect(mocks.loadMkvGo).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mocks.notifySubtitleSyncError).toHaveBeenCalledTimes(1);
    });

    expect(mocks.syncSubtitleToReference).not.toHaveBeenCalled();
  });

  it('passes a 13.4 GiB-class File straight to extractSubtitleVTT (Blob, no arrayBuffer)', async () => {
    // A 13.4 GiB MKV must not be read into memory via arrayBuffer():
    // extractSubtitleVTT takes the File/Blob itself and ranges over it.
    // Shadow the Blob size getter so the test never allocates the bytes.
    const file = new File(['video'], 'big.mkv');
    Object.defineProperty(file, 'size', { value: 13.4 * 2 ** 30 });
    // A Uint8Array input would mean an arrayBuffer() happened — fail the
    // test if PlayerApp ever builds one.
    const arrayBufferSpy = vi
      .spyOn(file, 'arrayBuffer')
      .mockRejectedValue(new Error('arrayBuffer must not be called'));
    const mkvgo = {
      probe: vi.fn(async (_input: File) => subtitleProbe()),
      extractSubtitleVTT: vi.fn(async (_input: Blob, _id: number) =>
        EMBEDDED_VTT,
      ),
    };
    mocks.loadMkvGo.mockResolvedValue({
      ...mkvgo,
    });
    mocks.syncSubtitleToReference.mockResolvedValue(SYNCED_VTT);

    render(<Player />);
    act(() => {
      mocks.mediaPickerProps!.onSelect(file);
    });
    act(() => {
      mocks.rightPanelProps!.onSubtitleSelect(
        new File([LOADED_SUBTITLE], 'sub.vtt', { type: 'text/vtt' }),
      );
    });
    await flushMicrotasks();

    act(() => {
      mocks.rightPanelProps!.onSyncSubtitle();
    });
    await waitFor(() => {
      expect(mkvgo.extractSubtitleVTT).toHaveBeenCalledTimes(1);
    });

    // The File (a Blob) was handed to extractSubtitleVTT untouched — no
    // arrayBuffer(), no size guard, no toast.
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    const extractArgs = mkvgo.extractSubtitleVTT.mock.calls[0] as [
      Blob,
      number,
    ];
    expect(extractArgs[0]).toBe(file);
    expect(extractArgs[0]).toBeInstanceOf(File);
    expect(extractArgs[1]).toBe(7); // track id from the probe
    expect(mocks.notifySubtitleSyncError).not.toHaveBeenCalled();
  });
});
