/**
 * Video Clip — browser-native silent WebM capture for mining ranges.
 * ---------------------------------------------------------------------------
 * Pure functions for capability detection, codec probing, range clamping,
 * and the recording lifecycle. Follows asbplayer's canvas → captureStream
 * → MediaRecorder approach (MIT notice below).
 *
 * Capability gate: local video only, canvas captureStream, MediaRecorder,
 * supported codec. Probe order: AV1 → VP8 → VP9 → generic WebM.
 *
 * Max clip range: 45 seconds, center-clamped. Encode watchdog: 60 seconds.
 * Frame capture: captureStream(0) + requestFrame() preferred, fixed FPS fallback.
 *
 * Cleanup is mandatory on every terminal path: recorder stop, stream track
 * stop, hidden video pause/src removal, timeout clearing, temporary Blob
 * URL revocation — on success, failure, cancel, media change, Dialog close,
 * and unmount.
 * --------------------------------------------------------------------------- */

// ---------------------------------------------------------------------------
// asbplayer MIT Notice (for reference logic)
// ---------------------------------------------------------------------------
// Copyright (c) 2023 asbplayer contributors
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum clip duration in seconds. Longer ranges are center-clamped. */
export const MAX_CLIP_DURATION_S = 45;

/** Encode watchdog timeout in seconds (not clip duration). */
export const ENCODE_WATCHDOG_MS = 60_000;

/** Canvas captureStream FPS when requestFrame fallback is needed. */
export const FALLBACK_FPS = 30;

/** Codec probe order per VIDEO_CLIP.md §3.1. */
export const VIDEO_CODEC_CANDIDATES = [
  'video/webm;codecs=av1',
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/webm',
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VideoClipErrorCode =
  | 'CAPABILITY_UNSUPPORTED'
  | 'CANVAS_CAPTURE_UNSUPPORTED'
  | 'CODEC_UNSUPPORTED'
  | 'VIDEO_LOAD_ERROR'
  | 'SEEK_ERROR'
  | 'FRAME_CAPTURE_FAILED'
  | 'RECORDER_ERROR'
  | 'RECORDING_CANCELLED'
  | 'RECORDING_TIMEOUT'
  | 'STREAM_CAPTURE_FAILED'
  | 'MEDIA_ERROR';

export interface VideoClipError {
  code: VideoClipErrorCode;
  message: string;
}

export type VideoClipResult =
  | { ok: true; blob: Blob; mimeType: string }
  | { ok: false; error: VideoClipError };

export interface VideoClipOptions {
  /** Local Blob URL of the video file. */
  mediaUrl: string;
  /** Clip start time in seconds. */
  start: number;
  /** Clip end time in seconds. */
  end: number;
  /** Playback rate (affects actual recording duration). */
  playbackRate?: number;
  /** Optional AbortSignal to cancel this recording. */
  signal?: AbortSignal;
}

export interface VideoClipCapabilities {
  supported: boolean;
  mimeType: string | null;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Pure functions — capability detection, codec, range
// ---------------------------------------------------------------------------

/** Check if the browser supports canvas captureStream. */
export function hasCanvasCaptureStream(): boolean {
  const proto = HTMLCanvasElement.prototype as unknown as {
    captureStream?: (fps?: number) => MediaStream;
    mozCaptureStream?: (fps?: number) => MediaStream;
  };
  return (
    typeof proto.captureStream === 'function' ||
    typeof proto.mozCaptureStream === 'function'
  );
}

/** Check if MediaRecorder is available. */
export function hasMediaRecorder(): boolean {
  return typeof MediaRecorder !== 'undefined';
}

/** Probe codecs in priority order, return first supported. */
export function selectVideoCodec(): string | null {
  if (!hasMediaRecorder()) return null;
  for (const codec of VIDEO_CODEC_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(codec)) return codec;
  }
  return null;
}

/** Full video clip capability check. */
export function checkVideoClipCapabilities(): VideoClipCapabilities {
  if (!hasMediaRecorder()) {
    return {
      supported: false,
      mimeType: null,
      reason: 'MediaRecorder is not supported in this browser.',
    };
  }
  if (!hasCanvasCaptureStream()) {
    return {
      supported: false,
      mimeType: null,
      reason: 'Canvas captureStream is not supported in this browser.',
    };
  }
  const mimeType = selectVideoCodec();
  if (!mimeType) {
    return {
      supported: false,
      mimeType: null,
      reason: 'No supported WebM video codec found in this browser.',
    };
  }
  return { supported: true, mimeType, reason: null };
}

/** Check if local video media is available for Video Clip. */
export function isLocalVideoMedia(mediaType: string): boolean {
  return mediaType === 'video';
}

/**
 * Resolve the effective clip range, center-clamped to MAX_CLIP_DURATION_S.
 * If the range is within limits, returns [start, end] unchanged.
 * If it exceeds, returns a 45-second window centered on the original midpoint.
 */
export function resolveClipRange(
  start: number,
  end: number,
): { start: number; end: number } {
  const duration = end - start;
  if (duration <= 0) return { start, end };
  if (duration <= MAX_CLIP_DURATION_S) return { start, end };

  const center = (start + end) / 2;
  const halfMax = MAX_CLIP_DURATION_S / 2;
  return {
    start: Math.max(0, center - halfMax),
    end: center + halfMax,
  };
}

// ---------------------------------------------------------------------------
// Dependency injection interfaces (for testability)
// ---------------------------------------------------------------------------

export interface VideoElementFactory {
  createVideo(): HTMLVideoElement;
}

export const defaultVideoFactory: VideoElementFactory = {
  createVideo() {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    return video;
  },
};

export interface CanvasFactory {
  createCanvas(width: number, height: number): HTMLCanvasElement;
}

export const defaultCanvasFactory: CanvasFactory = {
  createCanvas(width: number, height: number) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
};

export interface MediaRecorderFactory {
  createRecorder(
    stream: MediaStream,
    options?: MediaRecorderOptions,
  ): MediaRecorder;
}

export const defaultMediaRecorderFactory: MediaRecorderFactory = {
  createRecorder(stream, options) {
    return new MediaRecorder(stream, options);
  },
};

export interface TimerService {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const defaultTimerService: TimerService = {
  setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

// ---------------------------------------------------------------------------
// Internal lifecycle
// ---------------------------------------------------------------------------

interface ClipRecordingLifecycle {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  timerId: number | null;
  watchdogId: number | null;
  frameTimerId: number | null;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  removeAbortListener: (() => void) | null;
  externalCleanup: (() => void) | null;
  aborted: boolean;
  rejectPhase?: ((reason: Error) => void) | null;
}

function fullCleanup(
  lifecycle: ClipRecordingLifecycle,
  timer: TimerService,
): void {
  if (lifecycle.timerId !== null) {
    timer.clearTimeout(lifecycle.timerId);
    lifecycle.timerId = null;
  }
  if (lifecycle.watchdogId !== null) {
    timer.clearTimeout(lifecycle.watchdogId);
    lifecycle.watchdogId = null;
  }
  if (lifecycle.frameTimerId !== null) {
    timer.clearTimeout(lifecycle.frameTimerId);
    lifecycle.frameTimerId = null;
  }
  if (lifecycle.recorder && lifecycle.recorder.state !== 'inactive') {
    try {
      lifecycle.recorder.stop();
    } catch {
      // ignore
    }
  }
  if (lifecycle.stream) {
    for (const track of lifecycle.stream.getTracks()) track.stop();
  }
  try {
    lifecycle.video.pause();
  } catch {
    // ignore
  }
  lifecycle.video.removeAttribute('src');
  lifecycle.video.load();
  if (lifecycle.removeAbortListener) {
    lifecycle.removeAbortListener();
    lifecycle.removeAbortListener = null;
  }
  if (lifecycle.externalCleanup) {
    lifecycle.externalCleanup();
    lifecycle.externalCleanup = null;
  }
}

/**
 * Record a silent WebM clip from `start` to `end` seconds using a detached
 * HTMLVideoElement. The visible player is never touched.
 */
export async function recordVideoClip(
  options: VideoClipOptions,
  deps: {
    videoFactory?: VideoElementFactory;
    canvasFactory?: CanvasFactory;
    recorderFactory?: MediaRecorderFactory;
    timer?: TimerService;
  } = {},
): Promise<VideoClipResult> {
  const { mediaUrl, start, end, playbackRate = 1, signal } = options;
  const videoFactory = deps.videoFactory ?? defaultVideoFactory;
  const canvasFactory = deps.canvasFactory ?? defaultCanvasFactory;
  const recorderFactory = deps.recorderFactory ?? defaultMediaRecorderFactory;
  const timer = deps.timer ?? defaultTimerService;

  // Resolve clip range
  const resolved = resolveClipRange(start, end);
  const clipDurationMs =
    ((resolved.end - resolved.start) / playbackRate) * 1000;

  if (clipDurationMs <= 0) {
    return {
      ok: false,
      error: {
        code: 'RECORDING_CANCELLED',
        message: 'Invalid clip duration (end must be after start).',
      },
    };
  }

  // Early abort check
  if (signal?.aborted) {
    return {
      ok: false,
      error: {
        code: 'RECORDING_CANCELLED',
        message: 'Recording was cancelled before it started.',
      },
    };
  }

  // Capability check
  const caps = checkVideoClipCapabilities();
  if (!caps.supported || !caps.mimeType) {
    return {
      ok: false,
      error: {
        code: 'CAPABILITY_UNSUPPORTED',
        message: caps.reason ?? 'Video clip recording is not supported.',
      },
    };
  }
  const mimeType = caps.mimeType;

  // Create detached video
  const video = videoFactory.createVideo();
  video.src = mediaUrl;
  video.playbackRate = playbackRate;

  // Create canvas
  const canvas = canvasFactory.createCanvas(1, 1);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    video.removeAttribute('src');
    video.load();
    return {
      ok: false,
      error: {
        code: 'CANVAS_CAPTURE_UNSUPPORTED',
        message: 'Could not obtain 2D rendering context from canvas.',
      },
    };
  }

  // Internal abort
  const internalController = new AbortController();
  let externalCleanup: (() => void) | null = null;
  if (signal) {
    const onExternalAbort = () => internalController.abort();
    signal.addEventListener('abort', onExternalAbort);
    externalCleanup = () =>
      signal.removeEventListener('abort', onExternalAbort);
  }
  const effectiveSignal = internalController.signal;

  const lifecycle: ClipRecordingLifecycle = {
    video,
    canvas,
    ctx,
    timerId: null,
    watchdogId: null,
    frameTimerId: null,
    stream: null,
    recorder: null,
    removeAbortListener: null,
    aborted: false,
    externalCleanup,
  };

  if (effectiveSignal) {
    const onAbort = () => {
      if (lifecycle.aborted) return;
      lifecycle.aborted = true;
      if (lifecycle.rejectPhase) {
        lifecycle.rejectPhase(new Error('Cancelled'));
        lifecycle.rejectPhase = null;
      } else {
        fullCleanup(lifecycle, timer);
      }
    };
    effectiveSignal.addEventListener('abort', onAbort);
    lifecycle.removeAbortListener = () => {
      effectiveSignal.removeEventListener('abort', onAbort);
    };
  }

  const checkAborted = (): VideoClipResult | null => {
    if (lifecycle.aborted) {
      fullCleanup(lifecycle, timer);
      return {
        ok: false,
        error: {
          code: 'RECORDING_CANCELLED',
          message: 'Recording was cancelled.',
        },
      };
    }
    return null;
  };

  try {
    // Wait for video ready to seek
    await new Promise<void>((resolve, reject) => {
      lifecycle.rejectPhase = reject;
      if (lifecycle.aborted) {
        lifecycle.rejectPhase = null;
        reject(new Error('Cancelled'));
        return;
      }
      const cleanupLocal = () => {
        lifecycle.rejectPhase = null;
        timer.clearTimeout(t0);
        lifecycle.timerId = null;
        video.removeEventListener('canplay', onCanPlay);
        video.removeEventListener('error', onError);
      };
      const onCanPlay = () => {
        cleanupLocal();
        resolve();
      };
      const onError = () => {
        cleanupLocal();
        reject(
          new Error(
            video.error?.message ?? 'Failed to load video for clipping',
          ),
        );
      };
      const t0 = timer.setTimeout(() => {
        cleanupLocal();
        if (lifecycle.aborted) {
          reject(new Error('Cancelled'));
          return;
        }
        reject(new Error('Video load timeout'));
      }, 5000);
      lifecycle.timerId = t0;
      video.addEventListener('canplay', onCanPlay);
      video.addEventListener('error', onError);
      if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        onCanPlay();
      }
    });
  } catch (e) {
    fullCleanup(lifecycle, timer);
    if (lifecycle.aborted) {
      return {
        ok: false,
        error: {
          code: 'RECORDING_CANCELLED',
          message: 'Recording was cancelled.',
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'VIDEO_LOAD_ERROR',
        message:
          e instanceof Error ? e.message : 'Failed to load video for clipping.',
      },
    };
  }

  const afterCanplay = checkAborted();
  if (afterCanplay) return afterCanplay;

  // Clamp range against actual loaded video duration
  const videoDuration = video.duration;
  if (Number.isFinite(videoDuration) && videoDuration > 0) {
    resolved.end = Math.min(resolved.end, videoDuration);
    if (resolved.end <= resolved.start) {
      fullCleanup(lifecycle, timer);
      return {
        ok: false,
        error: {
          code: 'SEEK_ERROR',
          message: `Clip range exceeds video duration (${videoDuration.toFixed(1)}s).`,
        },
      };
    }
  }

  // Set canvas to video dimensions
  try {
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
  } catch {
    fullCleanup(lifecycle, timer);
    return {
      ok: false,
      error: {
        code: 'FRAME_CAPTURE_FAILED',
        message: 'Failed to set canvas dimensions.',
      },
    };
  }

  // Seek to clip start
  try {
    await new Promise<void>((resolve, reject) => {
      lifecycle.rejectPhase = reject;
      if (lifecycle.aborted) {
        lifecycle.rejectPhase = null;
        reject(new Error('Cancelled'));
        return;
      }
      let settled = false;
      const onSeeked = () => {
        if (settled) return;
        settled = true;
        timer.clearTimeout(seekTimeout);
        lifecycle.timerId = null;
        video.removeEventListener('seeked', onSeeked);
        lifecycle.rejectPhase = null;
        resolve();
      };
      const seekTimeout = timer.setTimeout(() => {
        if (settled) return;
        settled = true;
        video.removeEventListener('seeked', onSeeked);
        lifecycle.rejectPhase = null;
        lifecycle.timerId = null;
        if (lifecycle.aborted) {
          reject(new Error('Cancelled'));
          return;
        }
        reject(new Error('Seek timeout'));
      }, 3000);
      lifecycle.timerId = seekTimeout;
      video.addEventListener('seeked', onSeeked);
      video.currentTime = resolved.start;
      if (Math.abs(video.currentTime - resolved.start) < 0.001) {
        onSeeked();
      }
    });
  } catch (e) {
    fullCleanup(lifecycle, timer);
    if (lifecycle.aborted) {
      return {
        ok: false,
        error: {
          code: 'RECORDING_CANCELLED',
          message: 'Recording was cancelled.',
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'SEEK_ERROR',
        message:
          e instanceof Error ? e.message : 'Failed to seek to clip start.',
      },
    };
  }

  const afterSeek = checkAborted();
  if (afterSeek) return afterSeek;

  // Build canvas stream
  let stream: MediaStream;
  try {
    const canvasExp = canvas as unknown as {
      captureStream?: (fps?: number) => MediaStream;
      mozCaptureStream?: (fps?: number) => MediaStream;
    };
    if (typeof canvasExp.captureStream === 'function') {
      stream = canvasExp.captureStream(0);
    } else if (typeof canvasExp.mozCaptureStream === 'function') {
      stream = canvasExp.mozCaptureStream(0);
    } else {
      throw new Error('Canvas captureStream unavailable');
    }
  } catch (e) {
    fullCleanup(lifecycle, timer);
    return {
      ok: false,
      error: {
        code: 'STREAM_CAPTURE_FAILED',
        message:
          e instanceof Error ? e.message : 'Failed to capture canvas stream.',
      },
    };
  }

  lifecycle.stream = stream;

  const afterStream = checkAborted();
  if (afterStream) return afterStream;

  // Create recorder
  let recorder: MediaRecorder;
  try {
    recorder = recorderFactory.createRecorder(stream, { mimeType });
  } catch (e) {
    fullCleanup(lifecycle, timer);
    return {
      ok: false,
      error: {
        code: 'RECORDER_ERROR',
        message:
          e instanceof Error ? e.message : 'Failed to create MediaRecorder.',
      },
    };
  }
  lifecycle.recorder = recorder;

  const afterRecorder = checkAborted();
  if (afterRecorder) return afterRecorder;

  // Check if requestFrame is available on the video track
  const videoTrack = stream.getVideoTracks()[0];
  const hasRequestFrame =
    typeof (videoTrack as unknown as { requestFrame?: () => void })
      .requestFrame === 'function';

  // Start playback
  try {
    await video.play();
  } catch {
    fullCleanup(lifecycle, timer);
    if (lifecycle.aborted) {
      return {
        ok: false,
        error: {
          code: 'RECORDING_CANCELLED',
          message: 'Recording was cancelled.',
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'VIDEO_LOAD_ERROR',
        message: 'Failed to start video playback for recording.',
      },
    };
  }

  const afterPlay = checkAborted();
  if (afterPlay) return afterPlay;

  // Recording lifecycle — draw frames and capture
  return new Promise<VideoClipResult>((resolve) => {
    const chunks: Blob[] = [];
    let finished = false;
    let recorderError: Error | null = null;

    const onDataAvailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const onError = (e: Event) => {
      recorderError = new Error(
        (e as ErrorEvent).message ?? 'MediaRecorder error',
      );
    };

    const onStop = () => {
      if (finished) return;
      finished = true;
      cleanupRecording();
      if (lifecycle.aborted) {
        resolve({
          ok: false,
          error: {
            code: 'RECORDING_CANCELLED',
            message: 'Recording was cancelled.',
          },
        });
        return;
      }
      if (recorderError) {
        resolve({
          ok: false,
          error: {
            code: 'RECORDER_ERROR',
            message: recorderError.message,
          },
        });
        return;
      }
      if (chunks.length === 0) {
        resolve({
          ok: false,
          error: {
            code: 'RECORDER_ERROR',
            message: 'No video data was recorded.',
          },
        });
        return;
      }
      const blob = new Blob(chunks, { type: mimeType });
      resolve({ ok: true, blob, mimeType });
    };

    recorder.addEventListener('dataavailable', onDataAvailable);
    recorder.addEventListener('error', onError);
    recorder.addEventListener('stop', onStop);

    recorder.start();

    // Frame capture loop — use recursive setTimeout for testability
    const drawAndCaptureFrame = () => {
      if (finished || lifecycle.aborted) return;
      try {
        if (video.ended || video.paused) return;
        lifecycle.ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (hasRequestFrame) {
          (
            videoTrack as unknown as { requestFrame: () => void }
          ).requestFrame();
          // Schedule next frame via rAF when requestFrame is available
          if (!finished && !lifecycle.aborted) {
            requestAnimationFrame(drawAndCaptureFrame);
          }
        }
      } catch {
        // Frame draw failure is non-fatal; skip frame
      }
    };

    if (!hasRequestFrame) {
      // Fixed FPS fallback: recursive setTimeout
      const frameIntervalMs = 1000 / FALLBACK_FPS;
      const scheduleFrame = () => {
        if (finished || lifecycle.aborted) return;
        drawAndCaptureFrame();
        const nextId = timer.setTimeout(scheduleFrame, frameIntervalMs);
        lifecycle.frameTimerId = nextId;
      };
      const firstId = timer.setTimeout(scheduleFrame, frameIntervalMs);
      lifecycle.frameTimerId = firstId;
    } else {
      // requestFrame loop
      requestAnimationFrame(drawAndCaptureFrame);
    }

    // Encode watchdog — 60 seconds
    const watchdogId = timer.setTimeout(() => {
      if (finished) return;
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch {
        onStop();
      }
    }, ENCODE_WATCHDOG_MS);
    lifecycle.watchdogId = watchdogId;

    // Stop recording after clip duration (+ buffer)
    const stopTimerId = timer.setTimeout(() => {
      if (finished) return;
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch {
        onStop();
      }
    }, clipDurationMs + 100);
    lifecycle.timerId = stopTimerId;

    function cleanupRecording() {
      timer.clearTimeout(stopTimerId);
      lifecycle.timerId = null;
      timer.clearTimeout(watchdogId);
      lifecycle.watchdogId = null;
      // Clear frame timer if we created one (fallback FPS path)
      if (lifecycle.frameTimerId !== null) {
        timer.clearTimeout(lifecycle.frameTimerId);
        lifecycle.frameTimerId = null;
      }
      recorder.removeEventListener('dataavailable', onDataAvailable);
      recorder.removeEventListener('error', onError);
      recorder.removeEventListener('stop', onStop);
      if (lifecycle.stream) {
        for (const track of lifecycle.stream.getTracks()) track.stop();
      }
      try {
        video.pause();
      } catch {
        // ignore
      }
      video.removeAttribute('src');
      video.load();
      if (lifecycle.removeAbortListener) {
        lifecycle.removeAbortListener();
        lifecycle.removeAbortListener = null;
      }
    }
  });
}
