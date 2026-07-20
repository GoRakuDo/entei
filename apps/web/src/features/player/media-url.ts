/**
 * Media URL Lifecycle Helpers
 * ---------------------------------------------------------------------------
 * Manages object URLs for local media files.
 *
 * Design:
 * - Creates object URLs from File objects.
 * - Revokes old URL when creating a new one (single-revoke guarantee).
 * - Component tracks the single active URL in a ref for unmount cleanup.
 * - Never persists raw File, path, or object URL to storage.
 * --------------------------------------------------------------------------- */

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
 */
export function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  const ext = getFileExtension(file);
  return ['mp4', 'webm', 'ogv', 'ogg', 'mkv'].includes(ext);
}

/**
 * Check if a file is an audio based on MIME type or extension.
 */
export function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  const ext = getFileExtension(file);
  return ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(ext);
}

/**
 * Check if a file is a subtitle based on MIME type or extension.
 */
export function isSubtitleFile(file: File): boolean {
  if (file.type === 'application/x-subrip' || file.type === 'text/vtt') {
    return true;
  }
  const ext = getFileExtension(file);
  return ['srt', 'vtt'].includes(ext);
}

/** Supported media file accept strings for file input. */
export const MEDIA_ACCEPT =
  'video/*,audio/*,.mp4,.webm,.ogv,.ogg,.mkv,.mp3,.wav,.flac,.aac,.m4a';

/** Supported subtitle file accept strings for file input. */
export const SUBTITLE_ACCEPT = '.srt,.vtt,text/vtt,application/x-subrip';
