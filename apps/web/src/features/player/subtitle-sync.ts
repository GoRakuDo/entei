// SPDX-License-Identifier: Apache-2.0
//
// Client-side wrapper around the subomatic subtitle-sync Web Worker.
// Decodes nothing here — the caller supplies mono f32 PCM (Web Audio API) or
// a reference subtitle — and returns the re-timed subtitle string.

import type {
  SubtitleSyncJob,
  SubtitleSyncWorkerMessage,
} from './subtitle-sync-types';

/** Bump when subtitle-sync.worker.js changes (public/ is served raw). */
// BUMP THIS when editing subtitle-sync.worker.js
const SUBTITLE_SYNC_WORKER_VERSION = 2;

export interface SubtitleSyncOptions {
  /** "energy" (fast) or "" / "earshot" (accurate, default) — audio mode only */
  vad?: string;
  /** output format extension; "" keeps the input's format */
  outFormat?: string;
  /** sub-to-audio progress: (stage, fraction) */
  onProgress?: (stage: string, fraction: number) => void;
  /** Abort the sync; the worker's result is ignored. */
  signal?: AbortSignal;
}

function postJob(
  job: SubtitleSyncJob,
  { vad, outFormat, onProgress, signal }: SubtitleSyncOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') {
      reject(new Error('Web Worker is not supported in this browser'));
      return;
    }
    // Cache-bust the worker: the raw JS lives in public/ and would otherwise
    // be cached across deploys, silently running an old WASM-init version.
    const worker = new Worker(`/wasm/subtitle-sync.worker.js?v=${SUBTITLE_SYNC_WORKER_VERSION}`, {
      type: 'module',
    });
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Subtitle sync aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<SubtitleSyncWorkerMessage>) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        onProgress?.(msg.stage, msg.fraction);
      } else if (msg.type === 'done') {
        cleanup();
        resolve(msg.result);
      } else {
        cleanup();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'Subtitle sync worker failed'));
    };
    const payload = {
      ...job,
      // Rust's check_fps rejects non-positive fps; default to 25 like the
      // worker when the caller did not provide a valid value.
      fps:
        job.fps != null && job.fps > 0 && Number.isFinite(job.fps)
          ? job.fps
          : 25,
      outFormat: outFormat ?? '',
      vad: vad ?? '',
    };
    // Transfer the PCM buffer instead of copying it (large audio input).
    if (job.samples) {
      worker.postMessage(payload, [job.samples.buffer]);
    } else {
      worker.postMessage(payload);
    }
  });
}

/**
 * Align a subtitle to speech in mono PCM samples (sub-to-audio).
 * The caller decodes audio via Web Audio API (`AudioContext.decodeAudioData`).
 */
export function syncSubtitleToAudio(
  subText: string,
  subFormat: string,
  samples: Float32Array,
  sampleRate: number,
  options: SubtitleSyncOptions = {},
): Promise<string> {
  return postJob(
    {
      mode: 'audio',
      subText,
      subFormat,
      samples,
      sampleRate,
    },
    options,
  );
}

/** Align a subtitle to a reference subtitle's timings (sub-to-sub). */
export function syncSubtitleToReference(
  subText: string,
  subFormat: string,
  refText: string,
  refFormat: string,
  options: SubtitleSyncOptions = {},
): Promise<string> {
  return postJob(
    {
      mode: 'reference',
      subText,
      subFormat,
      refText,
      refFormat,
    },
    options,
  );
}
