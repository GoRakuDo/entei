/**
 * Audio Clip — AM-3 browser-native audio capture for active subtitle cues.
 * ---------------------------------------------------------------------------
 * Uses a detached HTMLAudioElement with the current local mediaUrl, matching
 * asbplayer's approach: set currentTime to cue start, record audio-only stream
 * with MediaRecorder, stop at cue end, release everything.
 *
 * Feature detection for MediaRecorder + captureStream/mozCaptureStream + audio
 * track. Unsupported/failure shows typed error — never fake success.
 *
 * Cleanup is mandatory on every terminal path: recorder stop, temporary audio
 * pause/remove src/load, all capture stream tracks stop, timers/listeners
 * removed, temporary audio object URL removed/revoked on close.
 *
 * Cancellation works during ALL phases (canplay wait, seek wait, pre-play,
 * active recording). An internal AbortController is created per recording so
 * `cancelActiveRecording()` works even before `activeSession` is set.
 * --------------------------------------------------------------------------- */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AudioClipErrorCode =
  | 'CAPABILITY_UNSUPPORTED'
  | 'NO_AUDIO_TRACK'
  | 'RECORDER_ERROR'
  | 'AUDIO_LOAD_ERROR'
  | 'STREAM_CAPTURE_FAILED'
  | 'RECORDING_CANCELLED'
  | 'RECORDING_TIMEOUT';

export interface AudioClipError {
  code: AudioClipErrorCode;
  message: string;
}

export type AudioClipResult =
  | { ok: true; blob: Blob; mimeType: string }
  | { ok: false; error: AudioClipError };

export interface AudioClipOptions {
  /** Local Blob URL of the media file. */
  mediaUrl: string;
  /** Cue start time in seconds. */
  start: number;
  /** Cue end time in seconds. */
  end: number;
  /** Playback rate (affects actual recording duration). */
  playbackRate?: number;
  /** Optional AbortSignal to cancel this specific recording without affecting others. */
  signal?: AbortSignal;
}

export interface AudioClipCapabilities {
  supported: boolean;
  /** The MIME type that will be used for recording, or null if none supported. */
  mimeType: string | null;
  /** Human-readable reason when unsupported. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// MIME preference — lightweight browser-native formats only
// ---------------------------------------------------------------------------

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
] as const;

/** Select the best supported MIME type for MediaRecorder. */
export function selectSupportedMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  // Fallback: let browser choose if it supports MediaRecorder at all
  return null;
}

/** Check whether this browser can perform audio clip recording. */
export function checkAudioClipCapabilities(): AudioClipCapabilities {
  if (typeof MediaRecorder === 'undefined') {
    return {
      supported: false,
      mimeType: null,
      reason: 'MediaRecorder is not supported in this browser.',
    };
  }

  // We need captureStream or mozCaptureStream on HTMLMediaElement
  const proto = HTMLMediaElement.prototype as unknown as {
    captureStream?: unknown;
    mozCaptureStream?: unknown;
  };
  const hasCaptureStream =
    typeof proto.captureStream === 'function' ||
    typeof proto.mozCaptureStream === 'function';

  if (!hasCaptureStream) {
    return {
      supported: false,
      mimeType: null,
      reason: 'Audio stream capture is not supported in this browser.',
    };
  }

  const mimeType = selectSupportedMimeType();
  if (!mimeType) {
    return {
      supported: false,
      mimeType: null,
      reason: 'No supported audio recording format found in this browser.',
    };
  }

  return { supported: true, mimeType, reason: null };
}

// ---------------------------------------------------------------------------
// Dependency injection interfaces (for testability)
// ---------------------------------------------------------------------------

export interface AudioElementFactory {
  createAudio(): HTMLAudioElement;
}

export const defaultAudioFactory: AudioElementFactory = {
  createAudio() {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    return audio;
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
// Internal recording state
// ---------------------------------------------------------------------------

interface RecordingSession {
  audio: HTMLAudioElement;
  recorder: MediaRecorder;
  stream: MediaStream;
  sourceStream: MediaStream;
  chunks: Blob[];
  timerId: number;
  timer: TimerService;
  mimeType: string;
  onStop?: () => void;
}

let activeSession: RecordingSession | null = null;

/** Internal AbortController for the current recording.
 *  Allows `cancelActiveRecording()` to abort during canplay/seek phases
 *  before `activeSession` is constructed. */
let currentRecordingAbortController: AbortController | null = null;

function setCurrentRecordingAbortController(
  controller: AbortController | null,
): void {
  currentRecordingAbortController = controller;
}

/** Cancel any in-flight recording and clean up all resources. */
export function cancelActiveRecording(): void {
  // Phase 1: early-phase cancellation (canplay/seek/pre-play)
  const controller = currentRecordingAbortController;
  if (controller) {
    controller.abort();
    // The abort handler in recordAudioClip handles cleanup and Promise rejection.
    // Do NOT clear currentRecordingAbortController here;
    // the recordAudioClip finally block clears it.
  }

  // Phase 2: recording-phase cancellation via activeSession
  const session = activeSession;
  if (!session) return;

  // Notify caller FIRST so it can mark finished before recorder.stop()
  // fires the onStop handler that would otherwise resolve with empty chunks.
  session.onStop?.();

  // Stop recorder
  try {
    if (session.recorder.state !== 'inactive') {
      session.recorder.stop();
    }
  } catch {
    // Ignore — recorder may already be stopped
  }

  // Stop all tracks on both streams
  for (const track of session.sourceStream.getTracks()) {
    track.stop();
  }
  for (const track of session.stream.getTracks()) {
    track.stop();
  }

  // Pause and unload temporary audio
  try {
    session.audio.pause();
  } catch {
    // ignore
  }
  session.audio.removeAttribute('src');
  session.audio.load();

  // Clear timer using the injected timer service stored in the session
  session.timer.clearTimeout(session.timerId);

  // Clear activeSession only if it's still this session
  if (activeSession === session) {
    activeSession = null;
  }
}

// ---------------------------------------------------------------------------
// Stream helper: build audio-only stream from an already-captured source stream
// ---------------------------------------------------------------------------

function buildAudioOnlyStream(sourceStream: MediaStream): MediaStream {
  const audioTracks = sourceStream.getAudioTracks();
  if (audioTracks.length === 0) {
    // Clean up tracks before throwing
    for (const track of sourceStream.getTracks()) {
      track.stop();
    }
    throw new Error('No audio track available in captured stream');
  }

  // Build a clean audio-only stream from enabled tracks
  const audioOnlyStream = new MediaStream();
  for (const track of audioTracks) {
    if (track.enabled) {
      audioOnlyStream.addTrack(track);
    } else {
      track.stop();
    }
  }

  // Stop any video tracks on the source stream
  for (const track of sourceStream.getVideoTracks()) {
    track.stop();
  }

  // Reject if all audio tracks were disabled
  if (audioOnlyStream.getAudioTracks().length === 0) {
    for (const track of audioOnlyStream.getTracks()) {
      track.stop();
    }
    throw new Error('All audio tracks are disabled');
  }

  return audioOnlyStream;
}

// ---------------------------------------------------------------------------
// Core recording function
// ---------------------------------------------------------------------------

/**
 * Mutable state that tracks resources as they are created.
 * Used by abort handler to clean up whatever exists at cancellation time.
 */
interface RecordingLifecycle {
  audio: HTMLAudioElement;
  timerId: number | null;
  sourceStream: MediaStream | null;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  /** Remove the abort listener. */
  removeAbortListener: (() => void) | null;
  aborted: boolean;
  /** Reject function for the currently awaiting phase Promise. */
  rejectPhase?: ((reason: Error) => void) | null;
}

function makeRecordingLifecycle(audio: HTMLAudioElement): RecordingLifecycle {
  return {
    audio,
    timerId: null,
    sourceStream: null,
    stream: null,
    recorder: null,
    removeAbortListener: null,
    aborted: false,
  };
}

function fullCleanup(lifecycle: RecordingLifecycle, timer: TimerService): void {
  if (lifecycle.timerId !== null) {
    timer.clearTimeout(lifecycle.timerId);
    lifecycle.timerId = null;
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
  if (lifecycle.sourceStream) {
    for (const track of lifecycle.sourceStream.getTracks()) track.stop();
  }
  try {
    lifecycle.audio.pause();
  } catch {
    // ignore
  }
  lifecycle.audio.removeAttribute('src');
  lifecycle.audio.load();
  if (lifecycle.removeAbortListener) {
    lifecycle.removeAbortListener();
    lifecycle.removeAbortListener = null;
  }
}

/**
 * Record an audio clip from `start` to `end` seconds using a detached
 * HTMLAudioElement. The visible player is never touched.
 *
 * Returns a Promise that resolves when recording finishes or rejects on
 * catastrophic internal error (should not happen — typed result is preferred).
 */
export async function recordAudioClip(
  options: AudioClipOptions,
  deps: {
    audioFactory?: AudioElementFactory;
    recorderFactory?: MediaRecorderFactory;
    timer?: TimerService;
  } = {},
): Promise<AudioClipResult> {
  const { mediaUrl, start, end, playbackRate = 1, signal } = options;
  const audioFactory = deps.audioFactory ?? defaultAudioFactory;
  const recorderFactory = deps.recorderFactory ?? defaultMediaRecorderFactory;
  const timer = deps.timer ?? defaultTimerService;

  // Cancel any prior recording BEFORE creating our controller,
  // so we don't accidentally abort the fresh controller we're about to make.
  cancelActiveRecording();

  // Create an internal AbortController so `cancelActiveRecording()` can
  // abort during canplay/seek phases before `activeSession` exists.
  const internalController = new AbortController();
  setCurrentRecordingAbortController(internalController);

  // Wire external signal to internal controller
  let externalCleanup: (() => void) | null = null;
  if (signal) {
    if (signal.aborted) {
      internalController.abort();
    } else {
      const onExternalAbort = () => internalController.abort();
      signal.addEventListener('abort', onExternalAbort);
      externalCleanup = () =>
        signal.removeEventListener('abort', onExternalAbort);
    }
  }

  // Use internal signal for all lifecycle cancellation checks
  const effectiveSignal = internalController.signal;

  try {
    return await recordAudioClipInternal(
      { mediaUrl, start, end, playbackRate },
      { audioFactory, recorderFactory, timer },
      effectiveSignal,
    );
  } finally {
    if (externalCleanup) externalCleanup();
    // Identity-aware cleanup: only clear the global if it still points to
    // this invocation's controller. Prevents a slow "finally" from recording
    // A from clearing a newer controller set by recording B.
    if (currentRecordingAbortController === internalController) {
      setCurrentRecordingAbortController(null);
    }
  }
}

/** Internal implementation — does not manage the AbortController wrapper. */
async function recordAudioClipInternal(
  options: Omit<AudioClipOptions, 'signal'>,
  deps: {
    audioFactory: AudioElementFactory;
    recorderFactory: MediaRecorderFactory;
    timer: TimerService;
  },
  signal: AbortSignal,
): Promise<AudioClipResult> {
  const { mediaUrl, start, end, playbackRate = 1 } = options;
  const { audioFactory, recorderFactory, timer } = deps;

  // Early abort check
  if (signal.aborted) {
    return {
      ok: false,
      error: {
        code: 'RECORDING_CANCELLED',
        message: 'Recording was cancelled before it started.',
      },
    };
  }

  // Capability guard
  const caps = checkAudioClipCapabilities();
  if (!caps.supported || !caps.mimeType) {
    return {
      ok: false,
      error: {
        code: 'CAPABILITY_UNSUPPORTED',
        message: caps.reason ?? 'Audio clip recording is not supported.',
      },
    };
  }
  const mimeType = caps.mimeType;

  const durationMs = ((end - start) / playbackRate) * 1000;
  if (durationMs <= 0) {
    return {
      ok: false,
      error: {
        code: 'RECORDING_CANCELLED',
        message: 'Invalid cue duration (end must be after start).',
      },
    };
  }

  const audio = audioFactory.createAudio();
  audio.src = mediaUrl;
  audio.playbackRate = playbackRate;

  const lifecycle = makeRecordingLifecycle(audio);

  // Register abort listener at the TOP so cancellation works during
  // canplay wait, seek wait, pre-play, and active recording.
  if (signal) {
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
    signal.addEventListener('abort', onAbort);
    lifecycle.removeAbortListener = () => {
      signal.removeEventListener('abort', onAbort);
    };
  }

  // Helper: check abort after any await and return early
  const checkAborted = (): AudioClipResult | null => {
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

  // Wait for audio to be ready to seek
  try {
    await new Promise<void>((resolve, reject) => {
      lifecycle.rejectPhase = reject;
      if (lifecycle.aborted) {
        lifecycle.rejectPhase = null;
        reject(new Error('Cancelled'));
        return;
      }
      const onCanPlay = () => {
        cleanupLocal();
        resolve();
      };
      const onError = () => {
        cleanupLocal();
        reject(
          new Error(
            audio.error?.message ?? 'Failed to load audio for clipping',
          ),
        );
      };
      const t0 = timer.setTimeout(() => {
        cleanupLocal();
        if (lifecycle.aborted) {
          reject(new Error('Cancelled'));
          return;
        }
        reject(new Error('Audio load timeout'));
      }, 5000);
      lifecycle.timerId = t0;

      const cleanupLocal = () => {
        lifecycle.rejectPhase = null;
        timer.clearTimeout(t0);
        lifecycle.timerId = null;
        audio.removeEventListener('canplay', onCanPlay);
        audio.removeEventListener('error', onError);
      };

      audio.addEventListener('canplay', onCanPlay);
      audio.addEventListener('error', onError);

      // If already ready, resolve immediately
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
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
        code: 'AUDIO_LOAD_ERROR',
        message:
          e instanceof Error ? e.message : 'Failed to load audio for clipping.',
      },
    };
  }

  const afterCanplay = checkAborted();
  if (afterCanplay) return afterCanplay;

  // Seek to start and wait for seeked event
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
        cleanupLocal();
        resolve();
      };
      const seekTimeout = timer.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupLocal();
        if (lifecycle.aborted) {
          reject(new Error('Cancelled'));
          return;
        }
        reject(new Error('Seek timeout'));
      }, 3000);
      lifecycle.timerId = seekTimeout;

      const cleanupLocal = () => {
        lifecycle.rejectPhase = null;
        timer.clearTimeout(seekTimeout);
        lifecycle.timerId = null;
        audio.removeEventListener('seeked', onSeeked);
      };

      audio.addEventListener('seeked', onSeeked);
      audio.currentTime = start;

      // Edge case: if already at exact position, may not fire seeked
      if (Math.abs(audio.currentTime - start) < 0.001) {
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
        code: 'AUDIO_LOAD_ERROR',
        message:
          e instanceof Error ? e.message : 'Failed to seek to cue start.',
      },
    };
  }

  const afterSeek = checkAborted();
  if (afterSeek) return afterSeek;

  // Capture source stream ONCE
  let sourceStream: MediaStream;
  try {
    const experimental = audio as unknown as {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    if (typeof experimental.captureStream === 'function') {
      sourceStream = experimental.captureStream();
    } else if (typeof experimental.mozCaptureStream === 'function') {
      sourceStream = experimental.mozCaptureStream();
    } else {
      throw new Error('Stream capture API unavailable');
    }
  } catch (e) {
    fullCleanup(lifecycle, timer);
    return {
      ok: false,
      error: {
        code: 'STREAM_CAPTURE_FAILED',
        message:
          e instanceof Error ? e.message : 'Failed to capture audio stream.',
      },
    };
  }

  lifecycle.sourceStream = sourceStream;

  const afterCapture = checkAborted();
  if (afterCapture) return afterCapture;

  // Build audio-only stream from the captured source stream
  let stream: MediaStream;
  try {
    stream = buildAudioOnlyStream(sourceStream);
  } catch (e) {
    fullCleanup(lifecycle, timer);
    return {
      ok: false,
      error: {
        code: 'STREAM_CAPTURE_FAILED',
        message:
          e instanceof Error ? e.message : 'Failed to build audio-only stream.',
      },
    };
  }

  lifecycle.stream = stream;

  const afterBuild = checkAborted();
  if (afterBuild) return afterBuild;

  // Create recorder
  let recorder: MediaRecorder;
  try {
    recorder = recorderFactory.createRecorder(stream, {
      mimeType,
    });
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

  // Start playback BEFORE entering the Promise lifecycle
  try {
    await audio.play();
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
        code: 'AUDIO_LOAD_ERROR',
        message: 'Failed to start audio playback for recording.',
      },
    };
  }

  const afterPlay = checkAborted();
  if (afterPlay) return afterPlay;

  // Recording lifecycle
  return new Promise<AudioClipResult>((resolve) => {
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
      cleanupSession();

      if (activeSession === session) {
        activeSession = null;
      }

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
            message: 'No audio data was recorded.',
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

    // Stop recording after cue duration (+ small buffer for timing safety)
    const timerId = timer.setTimeout(() => {
      if (finished) return;
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch {
        // May already be stopped
        onStop();
      }
    }, durationMs + 100);

    lifecycle.timerId = timerId;

    function cleanupSession() {
      timer.clearTimeout(timerId);
      recorder.removeEventListener('dataavailable', onDataAvailable);
      recorder.removeEventListener('error', onError);
      recorder.removeEventListener('stop', onStop);

      for (const track of stream.getTracks()) track.stop();
      for (const track of sourceStream.getTracks()) track.stop();

      try {
        audio.pause();
      } catch {
        // ignore
      }
      audio.removeAttribute('src');
      audio.load();

      if (lifecycle.removeAbortListener) {
        lifecycle.removeAbortListener();
        lifecycle.removeAbortListener = null;
      }
    }

    const session: RecordingSession = {
      audio,
      recorder,
      stream,
      sourceStream,
      chunks,
      timerId,
      timer,
      mimeType,
      onStop: () => {
        if (finished) return;
        finished = true;
        cleanupSession();
        if (activeSession === session) {
          activeSession = null;
        }
        resolve({
          ok: false,
          error: {
            code: 'RECORDING_CANCELLED',
            message: 'Recording was cancelled.',
          },
        });
      },
    };

    activeSession = session;
  });
}
