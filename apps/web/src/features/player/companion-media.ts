// SPDX-License-Identifier: Apache-2.0
//
// Companion media helpers for subomatic subtitle sync (stage 2b):
// - Magnet sub-to-sub  → fetch the companion's subtitle text (fast, tens of KB)
// - Magnet sub-to-audio → fetch the companion's PCM (requires full DL)
// - DL progress helper over /v1/media/status

export interface MagnetSubtitle {
  text: string;
  format: string;
}

export interface MagnetPcm {
  samples: Float32Array;
  sampleRate: number;
}

export interface MediaStatus {
  state: string;
  available: number;
  total: number;
  headReady?: boolean;
  retryAfter?: number;
}

const COMPANION_ORIGIN = 'http://127.0.0.1:4322';

/** Clamp 0..100 DL percent from /v1/media/status. */
export function dlProgressPercent(status: MediaStatus): number {
  if (!status || status.total <= 0) return 0;
  return Math.min(100, Math.max(0, (status.available / status.total) * 100));
}

/**
 * Fetch a Magnet job's subtitle text (sub-to-sub). The subtitle file is
 * tiny and available as soon as the torrent metadata resolves, so this
 * does not wait for the media download.
 */
export async function fetchMagnetSubtitle(
  token: string,
  jobId: string,
  subtitleFileId: string,
): Promise<MagnetSubtitle> {
  const url =
    `${COMPANION_ORIGIN}/v1/source/torrents/${encodeURIComponent(jobId)}/subtitle` +
    `?token=${encodeURIComponent(token)}&file=${encodeURIComponent(subtitleFileId)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`companion subtitle fetch failed (${res.status})`);
  }
  const text = await res.text();
  // The companion serves VTT text; detect format from content type if
  // present, otherwise default to vtt.
  const ct = res.headers.get('content-type') ?? '';
  const format = ct.includes('srt') ? 'srt' : 'vtt';
  return { text, format };
}

/**
 * Fetch the completed media as 16 kHz mono f32 PCM (sub-to-audio).
 * Throws a BufferingError when the download is not finished yet.
 */
export class CompanionBufferingError extends Error {
  constructor(public available: number, public total: number) {
    super('companion media still buffering');
    this.name = 'CompanionBufferingError';
  }
}

export async function fetchMagnetPcm(
  token: string,
  opts: { signal?: AbortSignal } = {},
): Promise<MagnetPcm> {
  const url = `${COMPANION_ORIGIN}/v1/media/pcm?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    cache: 'no-store',
    signal: opts.signal,
  });
  if (res.status === 503) {
    let available = 0;
    let total = 0;
    try {
      const body = (await res.json()) as { available?: number; total?: number };
      available = body.available ?? 0;
      total = body.total ?? 0;
    } catch {
      // non-JSON body: leave totals unknown
    }
    throw new CompanionBufferingError(available, total);
  }
  if (!res.ok) {
    throw new Error(`companion PCM fetch failed (${res.status})`);
  }
  const sampleRate = Number(res.headers.get('x-sample-rate') ?? 16000);
  const buf = await res.arrayBuffer();
  const samples = new Float32Array(buf);
  return { samples, sampleRate: Number.isFinite(sampleRate) ? sampleRate : 16000 };
}

/** Read /v1/media/status (authorized) and return the progress snapshot. */
export async function fetchMediaStatus(
  token: string,
  opts: { signal?: AbortSignal } = {},
): Promise<MediaStatus> {
  const url = `${COMPANION_ORIGIN}/v1/media/status?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { cache: 'no-store', signal: opts.signal });
  if (!res.ok) {
    throw new Error(`companion status fetch failed (${res.status})`);
  }
  return (await res.json()) as MediaStatus;
}
