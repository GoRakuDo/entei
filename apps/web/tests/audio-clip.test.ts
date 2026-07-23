/**
 * Unit tests for AM-3 audio-clip.ts
 * ---------------------------------------------------------------------------
 * Tests MIME preference, capability detection, recording lifecycle,
 * cancellation, cleanup, and error transitions.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  selectSupportedMimeType,
  checkAudioClipCapabilities,
  recordAudioClip,
  cancelActiveRecording,
  type AudioElementFactory,
  type MediaRecorderFactory,
  type TimerService,
} from '@/features/player/audio-clip';

// jsdom lacks MediaRecorder and BlobEvent
class MockBlobEvent extends Event {
  data: Blob;
  constructor(type: string, init: { data: Blob }) {
    super(type);
    this.data = init.data;
  }
}

function stubMediaRecorder(
  supported: boolean | ((mime: string) => boolean) = true,
) {
  const cls = vi.fn(function (
    this: MediaRecorder,
    _stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
    (this as unknown as Record<string, unknown>).state = 'inactive';
    (this as unknown as Record<string, unknown>).mimeType =
      options?.mimeType ?? '';
  }) as unknown as typeof MediaRecorder;

  cls.isTypeSupported = vi.fn((mime: string) => {
    if (typeof supported === 'function') return supported(mime);
    return supported;
  });

  Object.defineProperty(window, 'MediaRecorder', {
    value: cls,
    writable: true,
    configurable: true,
  });

  return cls;
}

function restoreMediaRecorder() {
  // @ts-expect-error — remove stub
  delete window.MediaRecorder;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAudio(
  opts: {
    canPlayImmediately?: boolean;
    playRejects?: boolean;
  } = {},
): HTMLAudioElement {
  const audio = document.createElement('audio');
  Object.defineProperty(audio, 'readyState', {
    value: opts.canPlayImmediately
      ? HTMLMediaElement.HAVE_FUTURE_DATA
      : HTMLMediaElement.HAVE_NOTHING,
    configurable: true,
  });
  Object.defineProperty(audio, 'error', {
    value: null,
    configurable: true,
  });

  // Mock currentTime to fire seeked event for tests
  let currentTimeValue = 0;
  Object.defineProperty(audio, 'currentTime', {
    get() {
      return currentTimeValue;
    },
    set(value: number) {
      currentTimeValue = value;
      // Fire seeked asynchronously to simulate real behavior
      queueMicrotask(() => {
        audio.dispatchEvent(new Event('seeked'));
      });
    },
    configurable: true,
  });

  // captureStream / mozCaptureStream
  const mockTracks = [
    { kind: 'audio', enabled: true, stop: vi.fn() },
  ] as unknown as MediaStreamTrack[];
  const mockStream = {
    getAudioTracks: () => mockTracks,
    getVideoTracks: () => [],
    getTracks: () => mockTracks,
  } as unknown as MediaStream;

  Object.defineProperty(audio, 'captureStream', {
    value: vi.fn(() => mockStream),
    configurable: true,
  });

  const origPlay = audio.play.bind(audio);
  audio.play = vi.fn(() => {
    if (opts.playRejects) {
      return Promise.reject(new Error('Play failed'));
    }
    // jsdom's HTMLAudioElement.play() returns undefined instead of a Promise.
    // Wrap it so .catch() is always available in production code.
    const result = origPlay();
    return result instanceof Promise ? result : Promise.resolve(result);
  });

  return audio;
}

function createMockMediaRecorder(): MediaRecorder {
  let state = 'inactive';
  const listeners: Record<string, EventListener[]> = {};

  const recorder = {
    state,
    start() {
      state = 'recording';
      (recorder as unknown as Record<string, unknown>).state = state;
    },
    stop() {
      if (state === 'inactive') return;
      state = 'inactive';
      (recorder as unknown as Record<string, unknown>).state = state;
      const handlers = listeners['stop'] ?? [];
      for (const h of handlers) {
        h(new Event('stop'));
      }
    },
    addEventListener(type: string, handler: EventListener) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    },
    removeEventListener(type: string, handler: EventListener) {
      const arr = listeners[type] ?? [];
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatchEvent(e: Event) {
      const handlers = listeners[e.type] ?? [];
      for (const h of handlers) h(e);
      return true;
    },
    ondataavailable: null as ((e: BlobEvent) => void) | null,
    onerror: null as ((e: Event) => void) | null,
    onstop: null as ((e: Event) => void) | null,
  } as unknown as MediaRecorder;

  return recorder;
}

function createMockRecorderFactory(
  recorder?: MediaRecorder,
): MediaRecorderFactory {
  return {
    createRecorder() {
      return recorder ?? createMockMediaRecorder();
    },
  };
}

function createMockAudioFactory(audio?: HTMLAudioElement): AudioElementFactory {
  return {
    createAudio() {
      return audio ?? createMockAudio({ canPlayImmediately: true });
    },
  };
}

function createMockTimer(): TimerService {
  let idCounter = 0;
  const timers = new Map<number, number>();
  return {
    setTimeout(cb, ms) {
      idCounter++;
      const id = window.setTimeout(cb, ms);
      timers.set(idCounter, id);
      return id;
    },
    clearTimeout(id) {
      window.clearTimeout(id);
      timers.delete(id);
    },
  };
}

class MockMediaStream {
  private tracks: MediaStreamTrack[] = [];

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }

  getTracks(): MediaStreamTrack[] {
    return [...this.tracks];
  }

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
  }

  removeTrack(track: MediaStreamTrack): void {
    const idx = this.tracks.indexOf(track);
    if (idx >= 0) this.tracks.splice(idx, 1);
  }
}

// Ensure captureStream exists once for the whole test file.
// We never remove it; tests that need to simulate its absence
// temporarily replace it and restore in a finally block.
beforeAll(() => {
  const proto = HTMLMediaElement.prototype as unknown as {
    captureStream?: () => MediaStream;
  };
  if (typeof proto.captureStream !== 'function') {
    proto.captureStream = function () {
      return new MediaStream();
    };
  }
  // Replace the global MediaStream with our mock that accepts any tracks
  Object.defineProperty(window, 'MediaStream', {
    value: MockMediaStream,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cancelActiveRecording();
  restoreMediaRecorder();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// MIME / Capability tests
// ---------------------------------------------------------------------------

describe('selectSupportedMimeType', () => {
  beforeAll(() => {
    stubMediaRecorder(true);
  });

  it('returns null when MediaRecorder is undefined', () => {
    restoreMediaRecorder();
    expect(selectSupportedMimeType()).toBeNull();
  });

  it('prefers audio/webm;codecs=opus when supported', () => {
    stubMediaRecorder(true);
    const cls = window.MediaRecorder as unknown as {
      isTypeSupported: (m: string) => boolean;
    };
    cls.isTypeSupported = vi.fn(
      (mime: string) => mime === 'audio/webm;codecs=opus',
    );
    expect(selectSupportedMimeType()).toBe('audio/webm;codecs=opus');
  });

  it('falls back to audio/ogg;codecs=opus', () => {
    stubMediaRecorder(true);
    const cls = window.MediaRecorder as unknown as {
      isTypeSupported: (m: string) => boolean;
    };
    cls.isTypeSupported = vi.fn(
      (mime: string) => mime === 'audio/ogg;codecs=opus',
    );
    expect(selectSupportedMimeType()).toBe('audio/ogg;codecs=opus');
  });

  it('returns null when no candidate is supported', () => {
    stubMediaRecorder(true);
    const cls = window.MediaRecorder as unknown as {
      isTypeSupported: (m: string) => boolean;
    };
    cls.isTypeSupported = vi.fn(() => false);
    expect(selectSupportedMimeType()).toBeNull();
  });
});

describe('checkAudioClipCapabilities', () => {
  it('returns unsupported when MediaRecorder is missing', () => {
    restoreMediaRecorder();
    const caps = checkAudioClipCapabilities();
    expect(caps.supported).toBe(false);
    expect(caps.mimeType).toBeNull();
    expect(caps.reason).toContain('MediaRecorder');
  });

  it('returns unsupported when captureStream APIs are missing', () => {
    stubMediaRecorder(true);
    const proto = HTMLMediaElement.prototype as unknown as {
      captureStream?: unknown;
      mozCaptureStream?: unknown;
    };
    const orig = proto.captureStream;
    try {
      delete proto.captureStream;
      delete proto.mozCaptureStream;
      const caps = checkAudioClipCapabilities();
      expect(caps.supported).toBe(false);
      expect(caps.reason).toContain('capture');
    } finally {
      proto.captureStream = orig;
    }
  });

  it('returns unsupported when no MIME type is supported', () => {
    stubMediaRecorder(false);
    const caps = checkAudioClipCapabilities();
    expect(caps.supported).toBe(false);
    expect(caps.reason).toContain('format');
  });

  it('returns supported with mimeType when all APIs available', () => {
    stubMediaRecorder((mime: string) => mime === 'audio/webm;codecs=opus');
    const caps = checkAudioClipCapabilities();
    expect(caps.supported).toBe(true);
    expect(caps.mimeType).toBe('audio/webm;codecs=opus');
    expect(caps.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Recording lifecycle tests
// ---------------------------------------------------------------------------

describe('recordAudioClip', () => {
  beforeAll(() => {
    stubMediaRecorder(true);
  });

  it('returns CAPABILITY_UNSUPPORTED when MediaRecorder missing', async () => {
    restoreMediaRecorder();
    const result = await recordAudioClip({
      mediaUrl: 'blob:test',
      start: 1,
      end: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CAPABILITY_UNSUPPORTED');
    }
  });

  it('returns RECORDING_CANCELLED for zero/negative duration', async () => {
    stubMediaRecorder(true);
    const result = await recordAudioClip({
      mediaUrl: 'blob:test',
      start: 5,
      end: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('RECORDING_CANCELLED');
    }
  });

  it('records and returns a Blob on successful completion', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: true });
    const mockRecorder = createMockMediaRecorder();
    const mockTimer = createMockTimer();

    const resultPromise = recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 0.1 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: createMockRecorderFactory(mockRecorder),
        timer: mockTimer,
      },
    );

    // Allow the async function to continue past its async setup
    // (canplay, seeked, play) so event listeners are registered before we dispatch.
    await new Promise((r) => setTimeout(r, 0));

    // Simulate dataavailable then stop
    const blob = new Blob(['audio-data'], { type: 'audio/webm' });
    mockRecorder.dispatchEvent(
      new MockBlobEvent('dataavailable', { data: blob }),
    );
    mockRecorder.stop();

    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The blob type reflects the selected MIME type from capabilities
      expect(result.mimeType).toBe('audio/webm;codecs=opus');
    }
  });

  it('calls captureStream exactly once per recording', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: true });
    const captureStreamSpy = vi.fn(() => {
      const mockTracks = [
        { kind: 'audio', enabled: true, stop: vi.fn() },
      ] as unknown as MediaStreamTrack[];
      return {
        getAudioTracks: () => mockTracks,
        getVideoTracks: () => [],
        getTracks: () => mockTracks,
      } as unknown as MediaStream;
    });
    Object.defineProperty(mockAudio, 'captureStream', {
      value: captureStreamSpy,
      configurable: true,
    });

    const mockRecorder = createMockMediaRecorder();
    const resultPromise = recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 0.05 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: createMockRecorderFactory(mockRecorder),
        timer: createMockTimer(),
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    const blob = new Blob(['x'], { type: 'audio/webm' });
    mockRecorder.dispatchEvent(
      new MockBlobEvent('dataavailable', { data: blob }),
    );
    mockRecorder.stop();

    const result = await resultPromise;
    if (!result.ok) {
      console.log('DEBUG error:', result.error);
    }
    expect(result.ok).toBe(true);
    expect(captureStreamSpy).toHaveBeenCalledTimes(1);
  });

  it('cleans up tracks and audio on completion', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: true });
    const mockStream = (
      mockAudio as unknown as { captureStream: () => MediaStream }
    ).captureStream();
    const mockTracks = mockStream.getAudioTracks();
    const trackStops = mockTracks.map((t) => vi.spyOn(t, 'stop'));
    const audioPauseSpy = vi.spyOn(mockAudio, 'pause');

    const mockRecorder = createMockMediaRecorder();
    const mockTimer = createMockTimer();

    const resultPromise = recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 0.05 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: createMockRecorderFactory(mockRecorder),
        timer: mockTimer,
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    const blob = new Blob(['x'], { type: 'audio/webm' });
    mockRecorder.dispatchEvent(
      new MockBlobEvent('dataavailable', { data: blob }),
    );
    mockRecorder.stop();

    await resultPromise;

    // Tracks should be stopped
    for (const spy of trackStops) {
      expect(spy).toHaveBeenCalled();
    }
    // Audio should be paused and src removed
    expect(audioPauseSpy).toHaveBeenCalled();
    expect(mockAudio.getAttribute('src')).toBeNull();
  });

  it('returns RECORDER_ERROR when recorder throws on creation', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: true });
    const mockTimer = createMockTimer();

    const result = await recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 0.1 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: {
          createRecorder() {
            throw new Error('Cannot create recorder');
          },
        },
        timer: mockTimer,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('RECORDER_ERROR');
    }
  });

  it('returns AUDIO_LOAD_ERROR when audio fails to load', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: false });
    const mockTimer = createMockTimer();

    const resultPromise = recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 0.1 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        timer: mockTimer,
      },
    );

    // Fire error on the audio element
    mockAudio.dispatchEvent(new Event('error'));

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AUDIO_LOAD_ERROR');
    }
  });

  it('returns AUDIO_LOAD_ERROR when audio play() rejects and cleans up', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({
      canPlayImmediately: true,
      playRejects: true,
    });
    const mockRecorder = createMockMediaRecorder();
    const recorderStartSpy = vi.spyOn(mockRecorder, 'start');
    const mockTimer = createMockTimer();

    const result = await recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 0.1 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: createMockRecorderFactory(mockRecorder),
        timer: mockTimer,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AUDIO_LOAD_ERROR');
    }
    // Recorder should NOT have been started because play() rejected first
    expect(recorderStartSpy).not.toHaveBeenCalled();
  });

  it('sets currentTime to cue start before starting recorder', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: true });
    const mockRecorder = createMockMediaRecorder();

    const resultPromise = recordAudioClip(
      { mediaUrl: 'blob:test', start: 5, end: 5.05 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: createMockRecorderFactory(mockRecorder),
        timer: createMockTimer(),
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    const blob = new Blob(['x'], { type: 'audio/webm' });
    mockRecorder.dispatchEvent(
      new MockBlobEvent('dataavailable', { data: blob }),
    );
    mockRecorder.stop();

    const result = await resultPromise;
    if (!result.ok) {
      console.log('DEBUG error:', result.error);
    }
    expect(result.ok).toBe(true);
    expect(mockAudio.currentTime).toBe(5);
  });

  it('returns RECORDING_CANCELLED when cancelActiveRecording is called', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: true });
    const mockRecorder = createMockMediaRecorder();
    const mockTimer = createMockTimer();

    const resultPromise = recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 10 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: createMockRecorderFactory(mockRecorder),
        timer: mockTimer,
      },
    );

    // Wait for the async function to set up the active session
    await new Promise((r) => setTimeout(r, 0));

    // Cancel immediately while recording is in flight
    cancelActiveRecording();

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('RECORDING_CANCELLED');
    }
  });

  it('uses injected timer service for cancellation cleanup', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: true });
    const mockRecorder = createMockMediaRecorder();
    const mockTimer = createMockTimer();
    const clearTimeoutSpy = vi.spyOn(mockTimer, 'clearTimeout');

    const resultPromise = recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 10 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: createMockRecorderFactory(mockRecorder),
        timer: mockTimer,
      },
    );

    await new Promise((r) => setTimeout(r, 0));
    cancelActiveRecording();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('RECORDING_CANCELLED');
    }
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('returns STREAM_CAPTURE_FAILED when no audio tracks exist', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: true });
    // Override captureStream to return empty audio tracks
    const emptyStream = {
      getAudioTracks: () => [],
      getVideoTracks: () => [],
      getTracks: () => [],
    } as unknown as MediaStream;
    Object.defineProperty(mockAudio, 'captureStream', {
      value: vi.fn(() => emptyStream),
      configurable: true,
    });

    const mockTimer = createMockTimer();

    const result = await recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 0.1 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        timer: mockTimer,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STREAM_CAPTURE_FAILED');
    }
  });

  it('returns STREAM_CAPTURE_FAILED when all audio tracks are disabled', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: true });
    const disabledTracks = [
      { kind: 'audio', enabled: false, stop: vi.fn() },
    ] as unknown as MediaStreamTrack[];
    const mockStream = {
      getAudioTracks: () => disabledTracks,
      getVideoTracks: () => [],
      getTracks: () => disabledTracks,
    } as unknown as MediaStream;
    Object.defineProperty(mockAudio, 'captureStream', {
      value: vi.fn(() => mockStream),
      configurable: true,
    });

    const result = await recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 0.1 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: createMockRecorderFactory(createMockMediaRecorder()),
        timer: createMockTimer(),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STREAM_CAPTURE_FAILED');
    }
    // Verify disabled tracks were cleaned up
    expect(disabledTracks[0]!.stop).toHaveBeenCalled();
  });

  it('returns RECORDER_ERROR when no chunks are received', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: true });
    const mockRecorder = createMockMediaRecorder();
    const mockTimer = createMockTimer();

    const resultPromise = recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 0.05 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: createMockRecorderFactory(mockRecorder),
        timer: mockTimer,
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    // Stop without any dataavailable events
    mockRecorder.stop();

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('RECORDER_ERROR');
      expect(result.error.message).toContain('No audio data');
    }
  });

  it('allows a new recording after normal completion without interference', async () => {
    stubMediaRecorder(true);
    const mockAudio = createMockAudio({ canPlayImmediately: true });
    const mockRecorder = createMockMediaRecorder();

    // First recording
    const result1Promise = recordAudioClip(
      { mediaUrl: 'blob:test', start: 0, end: 0.05 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: createMockRecorderFactory(mockRecorder),
        timer: createMockTimer(),
      },
    );

    await new Promise((r) => setTimeout(r, 0));
    const blob = new Blob(['x'], { type: 'audio/webm' });
    mockRecorder.dispatchEvent(
      new MockBlobEvent('dataavailable', { data: blob }),
    );
    mockRecorder.stop();

    const result1 = await result1Promise;
    expect(result1.ok).toBe(true);

    // Second recording should start cleanly without interference from stale session
    const mockRecorder2 = createMockMediaRecorder();
    const result2Promise = recordAudioClip(
      { mediaUrl: 'blob:test', start: 1, end: 1.05 },
      {
        audioFactory: createMockAudioFactory(mockAudio),
        recorderFactory: createMockRecorderFactory(mockRecorder2),
        timer: createMockTimer(),
      },
    );

    await new Promise((r) => setTimeout(r, 0));
    mockRecorder2.dispatchEvent(
      new MockBlobEvent('dataavailable', { data: blob }),
    );
    mockRecorder2.stop();

    const result2 = await result2Promise;
    expect(result2.ok).toBe(true);
  });
});

describe('cancelActiveRecording', () => {
  it('is safe to call when no recording is active', () => {
    expect(() => cancelActiveRecording()).not.toThrow();
  });
});
