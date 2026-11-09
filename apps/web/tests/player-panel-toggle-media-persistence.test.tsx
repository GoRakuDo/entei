/**
 * Regression test — the right panel toggle must not remount the media.
 * ---------------------------------------------------------------------------
 * The desktop layout used to swap the whole layout branch when the right
 * panel was closed: the <video> element was unmounted and a new one was
 * created, so the browser had to re-fetch the media and the panel took
 * 1-2 seconds to reopen.
 *
 * The panel is now collapsed IN PLACE inside the (still mounted) panel group,
 * so the media element — and the group itself — must be the very same DOM
 * nodes before and after a close/open cycle.
 *
 * The mock matchMedia reports a desktop viewport (>=768px) so the desktop
 * resizable branch is the one under test.
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

// --- Capture callbacks from mocked PlayerControls ---
const capture = vi.hoisted(() => ({
  onMediaSelect: null as ((file: File) => void) | null,
  onToggleSubtitlePanel: null as (() => void) | null,
  isSubtitlePanelVisible: true,
}));

// --- Mocks for heavy dependencies ---
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

// --- Mock PlayerControls: render ONLY the panel toggle button ---
vi.mock('@/components/player/PlayerControls', () => ({
  PlayerControls: vi.fn((props: Record<string, unknown>) => {
    capture.onToggleSubtitlePanel = props.onToggleSubtitlePanel as () => void;
    const visible = props.isSubtitlePanelVisible as boolean;
    capture.isSubtitlePanelVisible = visible;

    return (
      <div className="entei-test-controls">
        <button
          type="button"
          className="entei-controls-timeline-btn"
          aria-pressed={visible}
          aria-label={visible ? 'Hide timeline' : 'Show timeline'}
          onClick={() => {
            (props.onToggleSubtitlePanel as () => void)?.();
          }}
        >
          Timeline
        </button>
      </div>
    );
  }),
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

// The media element is the thing that must survive the toggle: render a
// real <video> node so the test can compare node identity.
vi.mock('@/components/player/VideoPlayer', () => ({
  VideoPlayer: vi.fn(() => <video data-testid="player-video" />),
}));

vi.mock('@/components/player/MediaPicker', () => ({
  MediaPicker: vi.fn((props: Record<string, unknown>) => {
    if (typeof props.onSelect === 'function') {
      capture.onMediaSelect = props.onSelect as (file: File) => void;
    }
    return null;
  }),
}));

vi.mock('@/components/player/RightPanel', () => ({
  RightPanel: vi.fn((props: Record<string, unknown>) => {
    if (!props.visible) return null;
    return <div data-testid="right-panel">RightPanel</div>;
  }),
}));

vi.mock('@/i18n/index', () => ({
  getDictionary: vi.fn(() => ({
    hub: { systemLabel: '', lead: '' },
    player: { title: '', description: '', cta: '' },
    playerUI: new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === 'timelineHide'
            ? 'Hide timeline'
            : prop === 'timelineShow'
              ? 'Show timeline'
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

vi.mock('@/i18n/types', () => ({
  LOCALE_CHANGE_EVENT: 'entei:locale-change',
}));

vi.mock('@/i18n/locale-events', () => ({
  LOCALE_CHANGE_EVENT: 'entei:locale-change',
}));

// Import AFTER mocks
import PlayerApp from '@/components/player/PlayerApp';

beforeEach(() => {
  vi.useFakeTimers();
  capture.onMediaSelect = null;
  capture.onToggleSubtitlePanel = null;
  capture.isSubtitlePanelVisible = true;
  mocks.runAnkiConnectionFlow.mockReset();
  mocks.ankiConnectClientCtor.mockReset();
  mocks.ankiExportClientCtor.mockReset();
  mocks.ankiConnectClientCtor.mockImplementation(function () {
    return {};
  });

  // Mock matchMedia for DESKTOP (>= 768px)
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(min-width: 768px)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));

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

// Helper: load a fake media file via the captured MediaPicker callback
function loadMedia() {
  const file = new File(['fake'], 'test.mp4', { type: 'video/mp4' });
  act(() => {
    capture.onMediaSelect?.(file);
  });
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('PlayerApp — right panel toggle (desktop)', () => {
  it('keeps the media element and the panel group mounted across a close/open cycle', async () => {
    mocks.runAnkiConnectionFlow.mockResolvedValue({
      decks: ['Japanese'],
      models: ['Basic'],
      requireApiKey: false,
    });

    const { container } = render(<PlayerApp />);
    await flush();
    loadMedia();
    await flush();

    // The desktop resizable branch is the one under test.
    const group = container.querySelector('.entei-resizable-group');
    expect(group).not.toBeNull();

    const video = container.querySelector('[data-testid="player-video"]');
    expect(video).not.toBeNull();

    const surface = container.querySelector('.entei-player-surface');
    expect(surface).not.toBeNull();

    const timelineBtn = container.querySelector(
      '.entei-controls-timeline-btn',
    ) as HTMLButtonElement;
    expect(timelineBtn).not.toBeNull();

    // --- Close the panel ---
    fireEvent.click(timelineBtn);
    await flush();

    // Same DOM nodes: nothing was remounted.
    expect(container.querySelector('[data-testid="player-video"]')).toBe(video);
    expect(container.querySelector('.entei-resizable-group')).toBe(group);
    expect(container.querySelector('.entei-player-surface')).toBe(surface);
    expect(timelineBtn.getAttribute('aria-pressed')).toBe('false');

    // The resize handle is hidden while there is nothing to resize.
    const hiddenHandle = container.querySelector(
      '.entei-resizable-handle--hidden',
    );
    expect(hiddenHandle).not.toBeNull();

    // --- Open the panel again ---
    fireEvent.click(timelineBtn);
    await flush();

    // Still the very same nodes — the media element was never recreated.
    expect(container.querySelector('[data-testid="player-video"]')).toBe(video);
    expect(container.querySelector('.entei-resizable-group')).toBe(group);
    expect(container.querySelector('.entei-player-surface')).toBe(surface);
    expect(timelineBtn.getAttribute('aria-pressed')).toBe('true');
    expect(
      container.querySelector('.entei-resizable-handle--hidden'),
    ).toBeNull();
  });
});
