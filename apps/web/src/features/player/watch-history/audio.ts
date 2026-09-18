import { computeVideoFingerprint } from '../tracker/identity';
import { getAllWatchHistory, recordWatchHistory } from './store';
import type {
  PosterResolution,
  WatchHistoryInput,
  WatchHistoryRecord,
} from './types';

/** Maximum decoded jacket image size persisted in a local history record. */
export const AUDIO_POSTER_MAX_BYTES = 200 * 1024;

const AUDIO_POSTER_MIME_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

export interface AudioPosterInput {
  /** MIME type from the M4B picture metadata (music-metadata `format`). */
  format: string;
  /** Embedded jacket bytes. */
  data: Uint8Array | ArrayBuffer;
}

export interface AudioWatchHistoryOptions {
  /** The Tracker fingerprint, never the audio file name. */
  mediaId: string;
  /** The selected audio file name used when metadata has no title. */
  fileName: string;
  /** M4B metadata title, when present. */
  metadataTitle?: string | null;
  /** The selected embedded jacket, if metadata exposed one. */
  poster?: AudioPosterInput | null;
}

function normalizeTitle(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

function encodeBase64(data: Uint8Array): string | null {
  if (typeof btoa !== 'function') return null;

  let binary = '';
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    const end = Math.min(offset + 0x8000, data.length);
    for (let index = offset; index < end; index += 1) {
      binary += String.fromCharCode(data[index]!);
    }
  }

  try {
    return btoa(binary);
  } catch {
    return null;
  }
}

/** Convert an embedded jacket into a reload-safe, bounded data URL. */
export function createAudioPosterResolution(
  poster: AudioPosterInput | null | undefined,
): PosterResolution {
  if (!poster || typeof poster.format !== 'string') {
    return { posterUrl: null, posterStatus: 'none' };
  }

  const format = poster.format.trim().toLowerCase();
  if (!AUDIO_POSTER_MIME_TYPES.has(format)) {
    return { posterUrl: null, posterStatus: 'none' };
  }

  const data = toBytes(poster.data);
  if (!data || data.byteLength === 0 || data.byteLength > AUDIO_POSTER_MAX_BYTES) {
    return { posterUrl: null, posterStatus: 'none' };
  }

  const encoded = encodeBase64(data);
  if (!encoded) return { posterUrl: null, posterStatus: 'none' };

  return {
    posterUrl: `data:${format};base64,${encoded}`,
    posterStatus: 'ready',
  };
}

/** Build the exact history input consumed by the shared watch-history upsert. */
export function createAudioWatchHistoryInput(
  options: AudioWatchHistoryOptions,
): WatchHistoryInput {
  const metadataTitle = normalizeTitle(options.metadataTitle);
  const fileName = normalizeTitle(options.fileName);
  const title = metadataTitle || fileName;
  const poster = createAudioPosterResolution(options.poster);

  return {
    mediaId: options.mediaId,
    title,
    titleNative: null,
    episode: null,
    source: 'audio',
    anilistId: null,
    tmdbId: null,
    posterUrl: poster.posterUrl,
    posterStatus: poster.posterStatus,
  };
}

/**
 * Compute an audio identity with the existing Tracker fingerprint contract.
 * The Tracker samples file bytes and includes its installation-local salt; no
 * filename-only identity is introduced for audio.
 */
export function computeAudioMediaId(file: File): Promise<string | null> {
  return computeVideoFingerprint(file);
}

/** Upsert an audio record in the existing watch_history object store. */
export function recordAudioWatchHistory(
  options: AudioWatchHistoryOptions,
): Promise<WatchHistoryRecord | null> {
  return recordWatchHistory(createAudioWatchHistoryInput(options));
}

/**
 * Read the cached audio record for an already-fingerprinted file.
 *
 * Only `title` and the reload-safe `posterUrl` are consumed for the cover
 * cache, so a plain store read is enough; unlike `resolvePoster` there is no
 * network resolution and no side effect.
 */
export async function getAudioWatchHistoryRecord(
  mediaId: string,
): Promise<WatchHistoryRecord | null> {
  if (!mediaId) return null;
  const records = await getAllWatchHistory();
  return records.find((record) => record.mediaId === mediaId) ?? null;
}

/**
 * Convert the short-lived cover object URL produced by `extractAudioCover`
 * into the reload-safe poster input expected by `recordAudioWatchHistory`.
 *
 * Best effort: a missing or already-revoked URL, a non-image blob, or a read
 * failure returns `null`, which records a title card instead of an image.
 */
export async function createAudioPosterFromCoverUrl(
  coverUrl: string | null,
): Promise<AudioPosterInput | null> {
  if (!coverUrl) return null;
  try {
    const response = await fetch(coverUrl);
    const blob = await response.blob();
    if (blob.size === 0 || !blob.type.startsWith('image/')) return null;
    return { format: blob.type, data: await blob.arrayBuffer() };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Playback position resume                                                  */
/* -------------------------------------------------------------------------- */

/** Namespace for local-only playback positions, keyed by the Tracker mediaId. */
const AUDIO_PROGRESS_PREFIX = 'entei:audio-progress:';

/** Positions at or below this point are treated as "not started" and dropped. */
const AUDIO_PROGRESS_MIN_SECONDS = 1;

function audioProgressKey(mediaId: string): string {
  return `${AUDIO_PROGRESS_PREFIX}${mediaId}`;
}

function audioProgressStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Some privacy modes throw on access; resume is best effort.
    return null;
  }
}

/**
 * Read the saved playback position (seconds) for a mediaId.
 * Returns null when nothing usable is stored: missing, malformed, or at the
 * very start of the track. Never stores or returns a file path or URL.
 */
export function readAudioProgress(mediaId: string): number | null {
  if (!mediaId) return null;
  const storage = audioProgressStorage();
  if (storage === null) return null;
  try {
    const raw = storage.getItem(audioProgressKey(mediaId));
    if (raw === null) return null;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < AUDIO_PROGRESS_MIN_SECONDS) {
      return null;
    }
    return seconds;
  } catch {
    return null;
  }
}

/** Persist the last playback position; ignores non-finite/start positions. */
export function writeAudioProgress(mediaId: string, seconds: number): void {
  if (
    !mediaId ||
    !Number.isFinite(seconds) ||
    seconds < AUDIO_PROGRESS_MIN_SECONDS
  ) {
    return;
  }
  const storage = audioProgressStorage();
  if (storage === null) return;
  try {
    storage.setItem(audioProgressKey(mediaId), String(seconds));
  } catch {
    // Storage may be full or blocked (private mode); resume is best effort.
  }
}

/** Drop the saved position so the next open starts from the beginning. */
export function clearAudioProgress(mediaId: string): void {
  if (!mediaId) return;
  const storage = audioProgressStorage();
  if (storage === null) return;
  try {
    storage.removeItem(audioProgressKey(mediaId));
  } catch {
    // Best effort.
  }
}
