import { computeVideoFingerprint } from '../tracker/identity';
import { recordWatchHistory } from './store';
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
