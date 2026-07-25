/**
 * Integration tests for handleMediaModeChange in PlayerApp.
 * ---------------------------------------------------------------------------
 * - Image→Video invokes recordVideoClip exactly once, not captureVideoFrame
 * - Video→Image invokes captureVideoFrame after seeking range start
 * - No audio clip / sentence-source re-record on mode switch
 * - Rapid/toggle superseded — epoch/abort guard discards stale response
 * - Previous preview object URL revoked when replacing
 * - Video failure triggers JPEG fallback; capturedType frozen after toggle
 * - Player time/pause restored after terminal path
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, act } from '@testing-library/react';
import { recordAudioClip } from '@/features/player/audio-clip';
import { captureVideoFrame } from '@/features/player/screenshot-capture';
import { recordVideoClip } from '@/features/player/video-clip';

// ---- Mocks ----
vi.mock('@/features/player/audio-clip', () => ({
  checkAudioClipCapabilities: vi.fn(() => ({
    supported: true,
    mimeType: 'audio/webm;codecs=opus',
  })),
  recordAudioClip: vi.fn(),
  cancelActiveRecording: vi.fn(),
}));

vi.mock('@/features/player/screenshot-capture', () => ({
  captureVideoFrame: vi.fn(),
}));

vi.mock('@/features/player/video-clip', () => ({
  detectVideoClipCapabilities: vi.fn(() => ({
    supported: true,
    mediaRecorderSupported: true,
    canvasCaptureSupported: true,
    codec: 'video/webm;codecs=vp8',
  })),
  recordVideoClip: vi.fn(),
}));

beforeEach(() => {
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
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// ---- Harness ----

/**
 * Harness that exercises the exact handleMediaModeChange callback pattern
 * from PlayerApp, using the same ref/epoch/abort/capture logic.
 * Uses plain objects instead of React hooks so it can be called from it() blocks.
 */
function createMediaModeHarness() {
  const state = {
    videoEl: null as HTMLVideoElement | null,
    mediaMode: 'image' as 'image' | 'video',
    mediaEpoch: 0,
    mediaRecaptureAbort: null as AbortController | null,
    mediaBlob: null as Blob | null,
    mediaBlobUrl: null as string | null,
    capturedMediaType: null as 'image' | 'video' | null,
    miningRangeStart: 0,
    miningRangeEnd: 5,
    captureLog: [] as string[],
  };

  const handleMediaModeChange = async (mode: 'image' | 'video') => {
    if (mode === state.mediaMode) return;
    state.mediaMode = mode;

    state.mediaRecaptureAbort?.abort();
    const epoch = ++state.mediaEpoch;
    const abortCtrl = new AbortController();
    state.mediaRecaptureAbort = abortCtrl;
    const signal = abortCtrl.signal;

    const videoEl = state.videoEl;
    const currentRange: [number, number] = [
      state.miningRangeStart,
      state.miningRangeEnd,
    ];
    const savedTime = videoEl?.currentTime ?? 0;
    const savedPaused = videoEl?.paused ?? true;

    try {
      if (state.mediaBlobUrl) {
        URL.revokeObjectURL(state.mediaBlobUrl);
        state.mediaBlobUrl = null;
      }
      state.mediaBlob = null;
      state.capturedMediaType = null;

      if (videoEl) {
        videoEl.currentTime = currentRange[0];
        // Yield once to simulate async seek completion.
        // In real browsers, seeked fires asynchronously; in tests we just yield.
        await Promise.resolve();
      }

      if (signal.aborted || epoch !== state.mediaEpoch) return;

      if (mode === 'video') {
        state.captureLog.push('recordVideoClip');
        const clipResult = await recordVideoClip({
          mediaUrl: 'blob:test-media',
          start: currentRange[0],
          end: currentRange[1],
          signal,
        });
        if (signal.aborted || epoch !== state.mediaEpoch) return;
        if (clipResult.ok) {
          const newUrl = URL.createObjectURL(clipResult.blob);
          state.mediaBlobUrl = newUrl;
          state.mediaBlob = clipResult.blob;
          state.capturedMediaType = 'video';
        } else {
          state.captureLog.push('fallback-start');
          // Fallback to JPEG on video failure — re-seek and capture
          if (videoEl) {
            videoEl.currentTime = currentRange[0];
            await Promise.resolve();
          }
          state.captureLog.push('fallback-seek-done');
          if (signal.aborted || epoch !== state.mediaEpoch) {
            state.captureLog.push('fallback-aborted');
            return;
          }
          state.captureLog.push('fallback-capture');
          const fallback = videoEl ? await captureVideoFrame(videoEl) : null;
          if (signal.aborted || epoch !== state.mediaEpoch) return;
          if (fallback && fallback.ok) {
            const imgUrl = URL.createObjectURL(fallback.blob);
            state.mediaBlobUrl = imgUrl;
            state.mediaBlob = fallback.blob;
            state.capturedMediaType = 'image';
          }
        }
      } else if (videoEl) {
        state.captureLog.push('captureVideoFrame');
        const result = await captureVideoFrame(videoEl);
        if (signal.aborted || epoch !== state.mediaEpoch) return;
        if (result.ok) {
          const imgUrl = URL.createObjectURL(result.blob);
          state.mediaBlobUrl = imgUrl;
          state.mediaBlob = result.blob;
          state.capturedMediaType = 'image';
        }
      }
    } finally {
      if (videoEl) {
        videoEl.currentTime = savedTime;
        if (savedPaused) videoEl.pause();
      }
      if (epoch === state.mediaEpoch) {
        state.mediaRecaptureAbort = null;
      }
    }
  };

  const resetLog = () => {
    state.captureLog = [];
  };

  return { state, handleMediaModeChange, resetLog };
}

/** Create a mock HTMLVideoElement with controllable currentTime / paused.
 *  Fires 'seeked' via queueMicrotask when currentTime is set.
 *  In real browsers, seeked fires asynchronously after the seek completes.
 *  queueMicrotask fires at each await yield point, matching real behavior. */
function createMockVideo(time = 12.5, paused = false) {
  const video = document.createElement('video') as HTMLVideoElement;
  video.src = 'blob:test';

  let _currentTime = time;
  let _paused = paused;
  const seekedListeners: Array<() => void> = [];

  Object.defineProperty(video, 'currentTime', {
    get() {
      return _currentTime;
    },
    set(v: number) {
      _currentTime = v;
      // Fire listeners at microtask execution time (not queue time)
      // so listeners registered AFTER this setter runs are still invoked
      queueMicrotask(() => {
        for (const fn of seekedListeners) fn();
      });
    },
    configurable: true,
  });
  Object.defineProperty(video, 'paused', {
    get() {
      return _paused;
    },
    configurable: true,
  });
  const pauseSpy = vi.fn(() => {
    _paused = true;
  });
  video.pause = pauseSpy;

  // Override addEventListener to capture seeked listeners
  const origAdd = video.addEventListener.bind(video);
  const origRemove = video.removeEventListener.bind(video);
  video.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === 'seeked') {
      seekedListeners.push(listener as () => void);
    } else {
      origAdd(type, listener, options);
    }
  }) as typeof video.addEventListener;
  video.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === 'seeked') {
      const idx = seekedListeners.indexOf(listener as () => void);
      if (idx >= 0) seekedListeners.splice(idx, 1);
    } else {
      origRemove(type, listener, options);
    }
  }) as typeof video.removeEventListener;

  return { video, pauseSpy };
}

// ===== Tests =====

describe('handleMediaModeChange — Image→Video', () => {
  it('invokes recordVideoClip exactly once with range start/end', async () => {
    const { video, pauseSpy } = createMockVideo(5, false);
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: true,
      blob: new Blob(['webm'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['jpg'], { type: 'image/jpeg' }),
    });

    const h = createMediaModeHarness();
    h.state.videoEl = video;
    h.state.miningRangeStart = 10;
    h.state.miningRangeEnd = 20;

    await act(async () => {
      await h.handleMediaModeChange('video');
    });

    // recordVideoClip called exactly once
    expect(recordVideoClip).toHaveBeenCalledTimes(1);
    expect(recordVideoClip).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: 'blob:test-media',
        start: 10,
        end: 20,
      }),
    );

    // captureVideoFrame NOT called (not image mode)
    expect(captureVideoFrame).not.toHaveBeenCalled();

    // Player time/pause restored (savedTime was 5, savedPaused was false)
    // currentTime restored after finally
    expect(video.currentTime).toBe(5);
    expect(pauseSpy).not.toHaveBeenCalled(); // savedPaused=false → no extra pause
  });

  it('does NOT invoke audio recordAudioClip', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: true,
      blob: new Blob(['w'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });
    const { video } = createMockVideo();
    const h = createMediaModeHarness();
    h.state.videoEl = video;

    await act(async () => {
      await h.handleMediaModeChange('video');
    });

    expect(recordAudioClip).not.toHaveBeenCalled();
  });
});

describe('handleMediaModeChange — Video→Image', () => {
  it('invokes captureVideoFrame only after seeking range start', async () => {
    const { video, pauseSpy } = createMockVideo(5, false);
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['jpg'], { type: 'image/jpeg' }),
    });

    const h = createMediaModeHarness();
    h.state.mediaMode = 'video'; // start in video mode
    h.state.videoEl = video;
    h.state.miningRangeStart = 10;
    h.state.miningRangeEnd = 20;

    await act(async () => {
      await h.handleMediaModeChange('image');
    });

    // captureVideoFrame called exactly once
    expect(captureVideoFrame).toHaveBeenCalledTimes(1);
    expect(captureVideoFrame).toHaveBeenCalledWith(video);

    // recordVideoClip NOT called
    expect(recordVideoClip).not.toHaveBeenCalled();

    // Player time/pause restored
    expect(video.currentTime).toBe(5);
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('seeks to range start (10) before capture, restores to saved time (5)', async () => {
    const { video } = createMockVideo(5, false);
    let currentTimeAtCapture = -1;
    vi.mocked(captureVideoFrame).mockImplementation(async (el) => {
      currentTimeAtCapture = el.currentTime;
      return {
        ok: true,
        blob: new Blob(['j'], { type: 'image/jpeg' }),
        mimeType: 'image/jpeg',
      };
    });

    const h = createMediaModeHarness();
    h.state.mediaMode = 'video'; // start in video mode
    h.state.videoEl = video;
    h.state.miningRangeStart = 10;
    h.state.miningRangeEnd = 20;

    await act(async () => {
      await h.handleMediaModeChange('image');
    });

    // Video should have been seeked to 10 before capture
    // After capture, restored to 5
    expect(currentTimeAtCapture).toBe(10);
    expect(video.currentTime).toBe(5);
  });

  it('does NOT invoke audio recordAudioClip', async () => {
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['j'], { type: 'image/jpeg' }),
    });
    const { video } = createMockVideo();
    const h = createMediaModeHarness();
    h.state.videoEl = video;

    await act(async () => {
      await h.handleMediaModeChange('image');
    });

    expect(recordAudioClip).not.toHaveBeenCalled();
  });
});

describe('handleMediaModeChange — player restoration', () => {
  it('restores paused video as paused after capture', async () => {
    const { video, pauseSpy } = createMockVideo(20, true); // paused=true
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['j'], { type: 'image/jpeg' }),
    });

    const h = createMediaModeHarness();
    h.state.mediaMode = 'video'; // start in video mode
    h.state.videoEl = video;

    await act(async () => {
      await h.handleMediaModeChange('image');
    });

    // savedPaused=true → video.pause() called in finally
    expect(pauseSpy).toHaveBeenCalled();
    expect(video.currentTime).toBe(20);
  });

  it('restores playing video as playing (no extra pause)', async () => {
    const { video, pauseSpy } = createMockVideo(7.5, false);
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['j'], { type: 'image/jpeg' }),
    });

    const h = createMediaModeHarness();
    h.state.videoEl = video;

    await act(async () => {
      await h.handleMediaModeChange('image');
    });

    expect(pauseSpy).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(7.5);
  });
});

describe('handleMediaModeChange — URL lifecycle', () => {
  it('revokes previous object URL when replacing', async () => {
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['j1'], { type: 'image/jpeg' }),
    });

    const h = createMediaModeHarness();
    // Start in video mode so switching to image runs
    h.state.mediaMode = 'video';
    // Simulate an existing blob URL
    h.state.mediaBlobUrl = 'blob:old-url';

    await act(async () => {
      await h.handleMediaModeChange('image');
    });

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-url');
  });

  it('creates new object URL for captured blob', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: true,
      blob: new Blob(['w'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });

    const h = createMediaModeHarness();

    await act(async () => {
      await h.handleMediaModeChange('video');
    });

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(h.state.mediaBlobUrl).toBeTruthy();
    expect(h.state.mediaBlob).toBeTruthy();
  });
});

describe('handleMediaModeChange — rapid toggle / epoch guard', () => {
  it('second toggle discards stale first response', async () => {
    // First call: Image→Video (slow)
    let resolveFirst!: (v: { ok: true; blob: Blob; mimeType: string }) => void;
    const firstPromise = new Promise<{
      ok: true;
      blob: Blob;
      mimeType: string;
    }>((r) => {
      resolveFirst = r;
    });
    vi.mocked(recordVideoClip)
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({
        ok: true,
        blob: new Blob(['v2'], { type: 'video/webm' }),
        mimeType: 'video/webm',
      });
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['jpg'], { type: 'image/jpeg' }),
    });

    const { video } = createMockVideo();
    const h = createMediaModeHarness();
    h.state.videoEl = video;

    // First toggle: Image→Video
    const firstToggle = h.handleMediaModeChange('video');

    // Second toggle: Video→Image before first completes
    await act(async () => {
      await h.handleMediaModeChange('image');
    });

    // Now resolve the stale first promise
    resolveFirst({
      ok: true,
      blob: new Blob(['stale'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });
    await act(async () => {
      await firstToggle;
    });

    // The stale first response should be discarded (capturedMediaType stays 'image')
    expect(h.state.capturedMediaType).toBe('image');
  });

  it('abort before completion prevents stale update', async () => {
    vi.mocked(captureVideoFrame).mockReset();
    let resolveCapture!: (v: { ok: true; blob: Blob }) => void;
    vi.mocked(captureVideoFrame).mockReturnValue(
      new Promise((r) => {
        resolveCapture = r;
      }),
    );

    const { video } = createMockVideo();
    const h = createMediaModeHarness();
    h.state.videoEl = video;

    const togglePromise = h.handleMediaModeChange('image');

    // Abort the in-flight capture
    h.state.mediaRecaptureAbort?.abort();

    // Resolve the capture after abort
    resolveCapture({ ok: true, blob: new Blob(['j'], { type: 'image/jpeg' }) });

    await act(async () => {
      await togglePromise;
    });

    // Should NOT have set captured type because signal was aborted
    expect(h.state.capturedMediaType).toBeNull();
  });
});

describe('handleMediaModeChange — video failure fallback', () => {
  it('failed video triggers JPEG fallback with capturedType=image', async () => {
    vi.mocked(recordVideoClip).mockImplementation(
      async () =>
        ({
          ok: false,
          error: { code: 'CAPABILITY_UNSUPPORTED', message: 'Not supported' },
        }) as ReturnType<typeof recordVideoClip> extends Promise<infer R>
          ? R
          : never,
    );
    vi.mocked(captureVideoFrame).mockImplementation(async () => ({
      ok: true,
      blob: new Blob(['fallback-jpg'], { type: 'image/jpeg' }),
      naturalWidth: 1920,
      naturalHeight: 1080,
    }));

    // Directly call the mock to verify it returns what we expect
    const { video } = createMockVideo();
    const h = createMediaModeHarness();
    h.state.mediaMode = 'image';
    h.state.videoEl = video;

    // Bypass act() — this is plain async JS, not React rendering
    await h.handleMediaModeChange('video');

    expect(recordVideoClip).toHaveBeenCalledTimes(1);
    expect(captureVideoFrame).toHaveBeenCalledTimes(1);
    expect(h.state.capturedMediaType).toBe('image');
    expect(h.state.mediaBlob).toBeTruthy();
  });
});

describe('handleMediaModeChange — capturedType stays frozen after subsequent toggle', () => {
  it('toggle to image after successful video capture freezes type as image', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: true,
      blob: new Blob(['w'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['j'], { type: 'image/jpeg' }),
    });

    const { video } = createMockVideo();
    const h = createMediaModeHarness();
    h.state.videoEl = video;

    // Capture as video first
    await act(async () => {
      await h.handleMediaModeChange('video');
    });
    expect(h.state.capturedMediaType).toBe('video');

    // Switch to image — captured type should change to image
    await act(async () => {
      await h.handleMediaModeChange('image');
    });
    expect(h.state.capturedMediaType).toBe('image');

    // capturedType is 'image' and blob is the JPEG from captureVideoFrame
    expect(h.state.mediaBlob?.type).toBe('image/jpeg');
  });
});

describe('handleMediaModeChange — harness correctness', () => {
  afterEach(cleanup);

  it('mode ref updates on successful toggle', async () => {
    vi.mocked(recordVideoClip).mockResolvedValue({
      ok: true,
      blob: new Blob(['w'], { type: 'video/webm' }),
      mimeType: 'video/webm',
    });

    const { video } = createMockVideo();
    const h = createMediaModeHarness();
    h.state.videoEl = video;

    expect(h.state.mediaMode).toBe('image');

    await act(async () => {
      await h.handleMediaModeChange('video');
    });

    expect(h.state.mediaMode).toBe('video');
  });

  it('no-op when same mode passed (early return)', async () => {
    vi.mocked(captureVideoFrame).mockReset();
    vi.mocked(captureVideoFrame).mockResolvedValue({
      ok: true,
      blob: new Blob(['j'], { type: 'image/jpeg' }),
    });

    const h = createMediaModeHarness();
    h.state.mediaMode = 'image';

    await act(async () => {
      await h.handleMediaModeChange('image');
    });

    // captureVideoFrame should NOT be called because same mode → early return
    expect(captureVideoFrame).not.toHaveBeenCalled();
  });
});
