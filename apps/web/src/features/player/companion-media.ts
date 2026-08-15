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

/** Subtitle fetch bound: slightly longer than the companion's 30s
 *  SubtitleContent timeout, so a slow swarm fails cleanly on the web side
 *  instead of hanging the sync button indefinitely.
 *  Must stay > subtitleReadTimeout in engine_anacrolix.go. */
const MAGNET_SUBTITLE_TIMEOUT_MS = 35_000;

/** Clamp 0..100 DL percent from /v1/media/status. */
export function dlProgressPercent(status: MediaStatus): number {
  if (!status || status.total <= 0) return 0;
  return Math.min(100, Math.max(0, (status.available / status.total) * 100));
}

/**
 * Fetch a Magnet job's subtitle text (sub-to-sub reference). Pass the
 * selected subtitle file id, or an empty string to let the companion
 * auto-detect the torrent's embedded subtitle (the first .srt/.vtt/.ass).
 * The subtitle file is tiny and available as soon as the torrent metadata
 * resolves, so this does not wait for the media download. The companion
 * serves the selected subtitle (or auto-detects when none was selected), so
 * no file id travels in the URL — the selection state lives server-side.
 */
export async function fetchMagnetSubtitle(
  token: string,
  jobId: string,
  _subtitleFileId: string,
): Promise<MagnetSubtitle> {
  const url = `${COMPANION_ORIGIN}/v1/source/torrents/${encodeURIComponent(jobId)}/subtitle` +
    `?token=${encodeURIComponent(token)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(MAGNET_SUBTITLE_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout aborts the fetch with a TimeoutError DOMException
    // (not an Error subclass in every environment) when the companion does
    // not answer within the bound — surface a clear, user-facing message
    // instead of the raw abort.
    const name =
      typeof err === 'object' && err !== null && 'name' in err
        ? String((err as { name: unknown }).name)
        : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(
        'subtitle fetch timed out — subtitles may still be preparing; try again shortly',
      );
    }
    throw err;
  }
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
    // 404: the companion has no active media to convert (no Magnet session
    // with a selected file, no fixture, or ffmpeg disabled) — surface a
    // message instead of the raw status.
    throw new Error(
      res.status === 404
        ? 'voice-based sync is unavailable: no active media'
        : `companion PCM fetch failed (${res.status})`,
    );
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

export interface WaitForPlayableOptions {
  /** Poll interval in ms (default 1000). */
  intervalMs?: number;
  /** Hard timeout in ms (default 120000 = 2 min). */
  timeoutMs?: number;
  /** Abort signal — stops polling immediately (close / unmount). */
  signal?: AbortSignal;
  /** Optional per-poll progress callback (status snapshot). */
  onState?: (status: MediaStatus) => void;
}

export type PlayableWaitResult =
  | { ok: true; reason: 'playable' }
  | { ok: false; reason: 'error' | 'network' | 'timeout' | 'aborted' };

/** Sleep for ms, rejecting early when the abort signal fires. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll /v1/media/status until the active companion job becomes playable.
 *
 * The caller (Magnet / YouTube source dialog) must NOT hand the job to the
 * Player until this returns { ok: true } — otherwise the Player mounts a
 * media element over a still-preparing job and falls into the "Unduhan
 * gagal" error fallback. This wait stays inside the source modal so the
 * user sees the loading animation instead of an error stack.
 *
 * Resolution rules:
 *   - `playable` / `complete` state  → ok:true
 *   - `error` state                  → ok:false ('error')
 *   - fetch failures (companion down / panic) for 5 consecutive polls
 *                                     → ok:false ('network')
 *   - timeoutMs elapsed              → ok:false ('timeout')
 *   - signal aborted (close/unmount) → ok:false ('aborted')
 *
 * The token travels only in the query string (existing pattern) and never
 * in logs or error text (design §9).
 */
export async function waitForPlayable(
  token: string,
  opts: WaitForPlayableOptions = {},
): Promise<PlayableWaitResult> {
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxConsecutiveFailures = 5;
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;

  while (true) {
    if (Date.now() >= deadline) return { ok: false, reason: 'timeout' };
    let status: MediaStatus | null = null;
    let fetchFailed = false;
    try {
      status = await fetchMediaStatus(token, { signal: opts.signal });
      consecutiveFailures = 0;
    } catch {
      if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };
      fetchFailed = true;
    }
    if (!fetchFailed && status) {
      if (status.state === 'playable' || status.state === 'complete') {
        opts.onState?.(status);
        return { ok: true, reason: 'playable' };
      }
      if (status.state === 'error') return { ok: false, reason: 'error' };
      opts.onState?.(status);
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        return { ok: false, reason: 'network' };
      }
    }
    try {
      await sleep(intervalMs, opts.signal);
    } catch {
      return { ok: false, reason: 'aborted' };
    }
  }
}
