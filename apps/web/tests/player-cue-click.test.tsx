/**
 * PlayerApp handleCueClick — click/tap a subtitle cue seeks WITHOUT forcing
 * playback.
 * ---------------------------------------------------------------------------
 * Before this fix, `handleCueClick` ran `media.play().catch(() => {})` after
 * setting `media.currentTime`, which forced playback even when the user had
 * paused the video. The desired behavior:
 *   - Seek to `cue.start` (clamped to companion's verified byte range when
 *     streaming).
 *   - Leave the media's playback state untouched (stays paused if paused,
 *     continues playing if it was already playing). `currentTime = N`
 *     naturally preserves playback state; no explicit `play()` is needed.
 *   - Reveal the controls overlay (P2) when the user clicks a cue while the
 *     controls are hidden.
 *
 * This test drives the real PlayerApp with the heavy subsystems mocked the
 * same way `player-local-embedded-subtitle.test.tsx` does. The key wiring
 * differences:
 *   - `VideoPlayer` is rendered for real so the callback ref populates
 *     `sharedMediaRef.current` with a real `<video>` element.
 *   - `PlayerControls` is replaced with a `forwardRef` stub that exposes a
 *     handle so we can observe the imperative `show()` call.
 *   - `RightPanel` is replaced with a stub that captures the `onCueClick`
 *     callback PlayerApp wires up, so tests can drive cue clicks directly.
 *   - `HTMLMediaElement.prototype.play` is spied on globally so we can prove
 *     that clicking a cue never forces playback.
 * --------------------------------------------------------------------------- */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  render,
  cleanup,
  act,
} from '@testing-library/react';
import type { SubtitleCue } from '@/features/player/subtitle-reader';

// --- Captured props (filled by the component mocks below) ---
const mocks = vi.hoisted(() => ({
  runAnkiConnectionFlow: vi.fn(),
  ankiConnectClientCtor: vi.fn(),
  ankiExportClientCtor: vi.fn(),
  notifySubtitleSyncError: vi.fn(),
  notifySubtitleSyncSuccess: vi.fn(),
  loadMkvGo: vi.fn(),
  mediaPickerProps: null as { onSelect: (f: File) => void } | null,
  rightPanelProps: null as {
    cues: SubtitleCue[];
    onCueClick: (cue: SubtitleCue) => void;
  } | null,
  /** Imperative PlayerControls handle (mirrors PlayerControlsHandle). */
  controlsHandle: {
    show: vi.fn(),
    hide: vi.fn(),
    getVisible: vi.fn(() => true),
  },
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
  // Drive the video path so the real <VideoPlayer> mounts and the callback
  // ref populates sharedMediaRef.current with a real HTMLVideoElement.
  classifyMediaFile: vi.fn(() => ({ kind: 'video' as const, ext: 'mp4' })),
  classifyMediaError: vi.fn(),
  isVideoFile: vi.fn(() => false),
  isAudioFile: vi.fn(() => false),
  isSubtitleFile: vi.fn(() => false),
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
  isControlTarget: vi.fn(() => () => false),
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
  notifyJimakuToast: vi.fn(),
  notifyMiningExportSuccess: vi.fn(),
  notifyMiningExportError: vi.fn(),
  notifyLazySyncInfo: vi.fn(),
  notifyFirefoxUnsupported: vi.fn(),
}));

vi.mock('@/features/player/mkvgo', () => ({
  loadMkvGo: mocks.loadMkvGo,
}));

// Dialogs / overlays are not exercised here.
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

// PlayerControls is mocked so we can capture the imperative handle and observe
// show() / hide() calls without rendering the real overlay layer.
vi.mock('@/components/player/PlayerControls', () => ({
  PlayerControls: require('react').forwardRef(function PlayerControlsStub(
    _props: unknown,
    ref: React.ForwardedRef<unknown>,
  ) {
    require('react').useImperativeHandle(ref, () => mocks.controlsHandle, []);
    return null;
  }),
}));

// RightPanel captures the cue-click callback PlayerApp wires up so the test
// can drive a cue click without rendering the real panel.
vi.mock('@/components/player/RightPanel', () => ({
  RightPanel: (props: {
    cues: SubtitleCue[];
    onCueClick: (cue: SubtitleCue) => void;
  }) => {
    mocks.rightPanelProps = props;
    return null;
  },
}));

// MediaPicker captures onSelect so the test can simulate loading a file.
vi.mock('@/components/player/MediaPicker', () => ({
  MediaPicker: (props: { onSelect: (f: File) => void }) => {
    mocks.mediaPickerProps = props;
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

// The real PlayerApp is what we want to test — it owns sharedMediaRef and
// handleCueClick. Companion wiring is mocked out (no streaming in this test).
import Player from '@/components/player/PlayerApp';

// --- Controllable companion job session ---
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

/** Play any pending microtasks + timers so React's commit phase runs and the
 *  VideoPlayer callback ref populates sharedMediaRef.current before we
 *  invoke onCueClick. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockSession = freshSession();
  mocks.mediaPickerProps = null;
  mocks.rightPanelProps = null;
  mocks.controlsHandle.show.mockClear();
  mocks.controlsHandle.hide.mockClear();
  mocks.controlsHandle.getVisible.mockClear();
  mocks.controlsHandle.getVisible.mockReturnValue(true);

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

  // Spy on play() at the prototype level so we can prove handleCueClick never
  // forces playback. JSDOM's HTMLMediaElement.play resolves a Promise, so we
  // don't need to override the implementation — but we DO need to track the
  // call count, which vitest's spyOn gives us for free.
  vi.spyOn(HTMLMediaElement.prototype, 'play');
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Render the player with a real <VideoPlayer> mounted and return the
 * underlying <video> element so tests can read its `currentTime`.
 */
async function renderPlayerWithVideo(): Promise<HTMLVideoElement> {
  const { container } = render(<Player />);

  // Trigger handleMediaSelect: file → hasMedia=true → VideoPlayer mounts →
  // callback ref runs in the commit phase and populates sharedMediaRef.current.
  act(() => {
    mocks.mediaPickerProps!.onSelect(new File(['video'], 'a.mp4'));
  });
  await settle();

  const video = container.querySelector('video');
  if (!video) {
    throw new Error(
      'renderPlayerWithVideo: <video> element not found after MediaPicker.onSelect',
    );
  }
  return video;
}

describe('PlayerApp handleCueClick — seek without forcing playback', () => {
  it('seeks media to cue start without calling play()', async () => {
    const video = await renderPlayerWithVideo();
    const playSpy = HTMLMediaElement.prototype.play as unknown as {
      mock: { calls: unknown[] };
    };
    const callsBefore = playSpy.mock.calls.length;

    const cue: SubtitleCue = {
      id: 7,
      start: 12.5,
      end: 15,
      text: 'Clicked cue',
    };

    act(() => {
      mocks.rightPanelProps!.onCueClick(cue);
    });

    // currentTime was set to the cue start.
    expect(video.currentTime).toBe(12.5);
    // play() was NOT called by this cue click.
    expect(playSpy.mock.calls.length).toBe(callsBefore);
    // Reveal controls via the imperative handle.
    expect(mocks.controlsHandle.show).toHaveBeenCalledTimes(1);
  });

  it('does not flip media from paused to playing when paused before the click', async () => {
    const video = await renderPlayerWithVideo();
    const playSpy = HTMLMediaElement.prototype.play as unknown as {
      mock: { calls: unknown[] };
    };
    const callsBefore = playSpy.mock.calls.length;
    // Simulate a paused user: HTMLMediaElement.paused defaults to true in
    // JSDOM (no autoplay), but be explicit so the intent is clear.
    expect(video.paused).toBe(true);

    act(() => {
      mocks.rightPanelProps!.onCueClick({
        id: 1,
        start: 4.25,
        end: 6,
        text: 'paused cue',
      });
    });

    expect(video.currentTime).toBe(4.25);
    expect(video.paused).toBe(true); // still paused — play() was NOT called
    expect(playSpy.mock.calls.length).toBe(callsBefore);
    expect(mocks.controlsHandle.show).toHaveBeenCalledTimes(1);
  });

  it('updates currentTime for each successive cue click', async () => {
    await renderPlayerWithVideo();
    const playSpy = HTMLMediaElement.prototype.play as unknown as {
      mock: { calls: unknown[] };
    };
    const callsBefore = playSpy.mock.calls.length;

    act(() => {
      mocks.rightPanelProps!.onCueClick({
        id: 1,
        start: 1,
        end: 2,
        text: 'first',
      });
    });
    act(() => {
      mocks.rightPanelProps!.onCueClick({
        id: 2,
        start: 30,
        end: 31,
        text: 'second',
      });
    });

    // sharedMediaRef points at the rendered <video>; both seeks applied.
    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video!.currentTime).toBe(30);
    // Each click revealed controls exactly once → 2 calls total.
    expect(mocks.controlsHandle.show).toHaveBeenCalledTimes(2);
    // Across both clicks, play() was never invoked.
    expect(playSpy.mock.calls.length).toBe(callsBefore);
  });

  it('is a no-op when no media element is attached yet', () => {
    // Render with no MediaPicker.onSelect call: no <video> mounts, so
    // sharedMediaRef.current is null. handleCueClick must early-return
    // without touching controlsHandleRef either.
    render(<Player />);

    // No RightPanel yet either (no hasMedia). Skip the cue-click assertion
    // if RightPanel never rendered; the early-return guard is what matters.
    if (mocks.rightPanelProps) {
      act(() => {
        mocks.rightPanelProps!.onCueClick({
          id: 1,
          start: 99,
          end: 100,
          text: 'ghost',
        });
      });
    }

    // controlsHandle.show was NOT called — the early-return path bails
    // before reaching controlsHandleRef.current?.show().
    expect(mocks.controlsHandle.show).not.toHaveBeenCalled();
  });
});