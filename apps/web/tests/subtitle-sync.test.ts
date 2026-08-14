// SPDX-License-Identifier: Apache-2.0
// Worker contract tests for the subomatic subtitle-sync helpers. The Web
// Worker is mocked (instances captured) so we can drive onmessage/onerror;
// the client-side wrapper logic (job payload, progress relay, done/error/
// abort handling) is what is exercised here.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  syncSubtitleToAudio,
  syncSubtitleToReference,
} from '../src/features/player/subtitle-sync';

interface MockWorkerInstance {
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

let workers: MockWorkerInstance[] = [];

beforeEach(() => {
  workers = [];
  class MockWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { message?: string }) => void) | null = null;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() {
      workers.push(this as unknown as MockWorkerInstance);
    }
  }
  vi.stubGlobal('Worker', MockWorker);
});

function lastWorker(): MockWorkerInstance {
  const w = workers[workers.length - 1];
  if (!w) throw new Error('no worker created');
  return w;
}

function dispatchDone(w: MockWorkerInstance, result: string) {
  w.onmessage?.({ data: { type: 'done', result } });
}

function dispatchError(w: MockWorkerInstance, message: string) {
  w.onmessage?.({ data: { type: 'error', message } });
}

function dispatchProgress(w: MockWorkerInstance, stage: string, fraction: number) {
  w.onmessage?.({ data: { type: 'progress', stage, fraction } });
}

describe('syncSubtitleToAudio', () => {
  it('posts an audio-mode job with samples, sampleRate and options', async () => {
    const promise = syncSubtitleToAudio('SRT', 'srt', new Float32Array([1, 2]), 8000, {
      vad: 'energy',
      outFormat: 'vtt',
    });
    const w = lastWorker();
    const samples = new Float32Array([1, 2]);
    expect(w.postMessage).toHaveBeenCalledWith(
      {
        mode: 'audio',
        subText: 'SRT',
        subFormat: 'srt',
        samples,
        sampleRate: 8000,
        fps: 25,
        outFormat: 'vtt',
        vad: 'energy',
      },
      [samples.buffer],
    );
    dispatchDone(w, 'synced');
    await expect(promise).resolves.toBe('synced');
    expect(w.terminate).toHaveBeenCalled();
  });

  it('rejects with the worker error message and terminates', async () => {
    const promise = syncSubtitleToAudio('SRT', 'srt', new Float32Array([1]), 8000);
    const w = lastWorker();
    dispatchError(w, 'bad input');
    await expect(promise).rejects.toThrow('bad input');
    expect(w.terminate).toHaveBeenCalled();
  });

  it('relays progress messages and resolves only on done', async () => {
    const progress: Array<[string, number]> = [];
    const promise = syncSubtitleToAudio('S', 'srt', new Float32Array([1]), 8000, {
      onProgress: (stage, fraction) => progress.push([stage, fraction]),
    });
    const w = lastWorker();
    dispatchProgress(w, 'speech', 0.5);
    dispatchProgress(w, 'align', 0.25);
    await expect(
      Promise.race([promise.catch(() => 'rejected'), Promise.resolve('pending')]),
    ).resolves.toBe('pending');
    dispatchDone(w, 'done');
    await expect(promise).resolves.toBe('done');
    expect(progress).toEqual([
      ['speech', 0.5],
      ['align', 0.25],
    ]);
  });

  it('rejects with AbortError when the signal aborts', async () => {
    const controller = new AbortController();
    const promise = syncSubtitleToAudio('S', 'srt', new Float32Array([1]), 8000, {
      signal: controller.signal,
    });
    lastWorker();
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Subtitle sync aborted',
    });
  });

  it('falls back when Worker is unsupported', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(
      syncSubtitleToAudio('S', 'srt', new Float32Array([1]), 8000),
    ).rejects.toThrow('not supported');
  });
});

describe('syncSubtitleToReference', () => {
  it('posts a reference-mode job with both texts and default options', async () => {
    const promise = syncSubtitleToReference('SUB', 'srt', 'REF', 'vtt', {
      outFormat: 'ass',
    });
    const w = lastWorker();
    expect(w.postMessage).toHaveBeenCalledWith({
      mode: 'reference',
      subText: 'SUB',
      subFormat: 'srt',
      refText: 'REF',
      refFormat: 'vtt',
      fps: 25,
      outFormat: 'ass',
      vad: '',
    });
    dispatchDone(w, 're-timed');
    await expect(promise).resolves.toBe('re-timed');
  });

  it('rejects when the worker errors', async () => {
    const promise = syncSubtitleToReference('S', 'srt', 'R', 'srt');
    const w = lastWorker();
    dispatchError(w, 'reference parse failed');
    await expect(promise).rejects.toThrow('reference parse failed');
  });

  it('relays progress without resolving early', async () => {
    const progress: Array<[string, number]> = [];
    const promise = syncSubtitleToReference('S', 'srt', 'R', 'srt', {
      onProgress: (stage, fraction) => progress.push([stage, fraction]),
    });
    const w = lastWorker();
    dispatchProgress(w, 'align', 0.75);
    await expect(
      Promise.race([promise.catch(() => 'rejected'), Promise.resolve('pending')]),
    ).resolves.toBe('pending');
    dispatchDone(w, 'ok');
    await expect(promise).resolves.toBe('ok');
    expect(progress).toEqual([['align', 0.75]]);
  });
});
