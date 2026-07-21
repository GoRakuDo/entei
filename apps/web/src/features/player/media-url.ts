/**
 * Media URL Lifecycle & Admission Helpers
 * ---------------------------------------------------------------------------
 * Manages object URLs for local media files and defines the accepted
 * extension matrix (P1.2 — media admission parity with asbplayer).
 *
 * Design:
 * - Creates object URLs from File objects.
 * - Revokes old URL when creating a new one (single-revoke guarantee).
 * - Component tracks the single active URL in a ref for unmount cleanup.
 * - Never persists raw File, path, or object URL to storage.
 * - Extension matching is case-insensitive; MIME is a hint, never a hard gate.
 * --------------------------------------------------------------------------- */

// ---------------------------------------------------------------------------
// Typed extension sets (P1.2 source of truth)
// ---------------------------------------------------------------------------

/** Video extensions accepted by Entei. Superset of asbplayer + existing types. */
export const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'ogv',
  'ogg', // .ogg sometimes served as video container
  'mkv',
  'm4v', // asbplayer parity
  'avi', // asbplayer parity
]);

/** Audio extensions accepted by Entei. Superset of asbplayer + existing types. */
export const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'flac',
  'aac',
  'm4a',
  'opus', // asbplayer parity
  'm4b', // asbplayer parity (audiobook)
]);

/** Accepted subtitle extensions. P1.3a adds ASS. */
export const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'ass']);

// ---------------------------------------------------------------------------
// Media admission result types
// ---------------------------------------------------------------------------

export type MediaAdmittedKind = 'video' | 'audio';
export type MediaAdmissionResult =
  { kind: MediaAdmittedKind; ext: string } | { kind: 'rejected'; ext: string };

/**
 * Discriminate whether a file is an accepted video, audio, or rejected.
 * Extension matching is case-insensitive. MIME type is never a hard gate.
 */
export function classifyMediaFile(file: File): MediaAdmissionResult {
  const ext = getFileExtension(file);
  if (VIDEO_EXTENSIONS.has(ext)) return { kind: 'video', ext };
  if (AUDIO_EXTENSIONS.has(ext)) return { kind: 'audio', ext };
  return { kind: 'rejected', ext };
}

// ---------------------------------------------------------------------------
// Native error mapping (P1.2 — distinguish decode vs metadata vs generic)
// ---------------------------------------------------------------------------

/**
 * Map a native HTMLMediaElement error to a typed discrimination.
 * Returns null if no error.
 *
 * Uses numeric constants directly instead of `MediaError.MEDIA_ERR_*` statics
 * because jsdom (vitest environment) does not define the `MediaError` constructor.
 */
export function classifyMediaError(
  error: { code: number } | null,
  mediaType: 'video' | 'audio',
): {
  kind: 'decode' | 'network' | 'unknown';
  mediaType: 'video' | 'audio';
} | null {
  if (!error) return null;
  // MediaError codes: 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED
  switch (error.code) {
    case 3: // MEDIA_ERR_DECODE
      return { kind: 'decode', mediaType };
    case 2: // MEDIA_ERR_NETWORK
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return { kind: 'network', mediaType };
    default:
      return { kind: 'unknown', mediaType };
  }
}

/**
 * Map a classified native error to an i18n dictionary key.
 * The caller resolves the key via the locale dictionary.
 */
export function nativeErrorToDictKey(classified: {
  kind: 'decode' | 'network' | 'unknown';
  mediaType: 'video' | 'audio';
}): string {
  if (classified.mediaType === 'video') {
    return classified.kind === 'decode'
      ? 'videoDecodeError'
      : classified.kind === 'network'
        ? 'failedToLoadVideo'
        : 'failedToLoadVideo';
  }
  return classified.kind === 'decode'
    ? 'audioDecodeError'
    : classified.kind === 'network'
      ? 'failedToLoadAudio'
      : 'failedToLoadAudio';
}

// ---------------------------------------------------------------------------
// Object URL lifecycle
// ---------------------------------------------------------------------------

/**
 * Create an object URL from a File, revoking the previous URL if any.
 * Returns the new object URL string.
 */
export function createMediaUrl(file: File, previousUrl: string | null): string {
  if (previousUrl !== null) {
    revokeUrl(previousUrl);
  }
  return URL.createObjectURL(file);
}

/**
 * Safely revoke an object URL.
 * No-op if the URL is null. Silently ignores already-revoked URLs.
 */
export function revokeUrl(url: string | null): void {
  if (url === null) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // URL may already be revoked — silently ignore
  }
}

/**
 * Check if a URL is a valid object URL.
 */
export function isObjectUrl(url: string): boolean {
  return url.startsWith('blob:');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the file extension from a File object.
 * Returns lowercase extension without the dot (e.g., "mp4").
 */
export function getFileExtension(file: File): string {
  const name = file.name;
  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1) return '';
  return name.slice(lastDot + 1).toLowerCase();
}

/**
 * Check if a file is a video based on MIME type or extension.
 * MIME is a hint; extension is authoritative.
 */
export function isVideoFile(file: File): boolean {
  if (classifyMediaFile(file).kind === 'video') return true;
  if (file.type.startsWith('video/')) return true;
  return false;
}

/**
 * Check if a file is an audio based on MIME type or extension.
 * MIME is a hint; extension is authoritative.
 */
export function isAudioFile(file: File): boolean {
  if (classifyMediaFile(file).kind === 'audio') return true;
  if (file.type.startsWith('audio/')) return true;
  return false;
}

/**
 * Check if a file is a subtitle based on MIME type or extension.
 */
export function isSubtitleFile(file: File): boolean {
  if (
    file.type === 'application/x-subrip' ||
    file.type === 'text/vtt' ||
    file.type === 'text/x-ssa' ||
    file.type === 'application/x-ssa'
  ) {
    return true;
  }
  const ext = getFileExtension(file);
  return SUBTITLE_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Accept constants for file inputs
// ---------------------------------------------------------------------------

/** Supported media file accept string for file input. */
export const MEDIA_ACCEPT = [
  'video/*',
  'audio/*',
  ...Array.from(VIDEO_EXTENSIONS).map((e) => `.${e}`),
  ...Array.from(AUDIO_EXTENSIONS).map((e) => `.${e}`),
].join(',');

/** Supported subtitle file accept string for file input. */
export const SUBTITLE_ACCEPT = [
  ...Array.from(SUBTITLE_EXTENSIONS).map((e) => `.${e}`),
  'text/vtt',
  'application/x-subrip',
  'text/x-ssa',
  'application/x-ssa',
].join(',');
