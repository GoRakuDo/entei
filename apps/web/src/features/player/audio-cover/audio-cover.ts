import { parseBlob, selectCover } from 'music-metadata';

export interface AudioCoverResult {
  /** Metadata title, or the selected file name when tags are unavailable. */
  title: string;
  /** Short-lived object URL for the extracted image, when one is available. */
  coverUrl: string | null;
}

function fallbackResult(file: File): AudioCoverResult {
  return { title: file.name || 'Audio track', coverUrl: null };
}

function metadataTitle(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}

/**
 * Read an audio File in the browser and extract its title and preferred cover.
 *
 * Cover parsing is deliberately best-effort: callers can assign the audio
 * object URL before awaiting this function, so a parser/image failure never
 * blocks playback. The returned cover URL is display-only and must be revoked
 * by the caller when the media changes or the screen unmounts.
 */
export async function extractAudioCover(file: File): Promise<AudioCoverResult> {
  const fallback = fallbackResult(file);

  try {
    const metadata = await parseBlob(file);
    const title = metadataTitle(metadata.common.title, fallback.title);
    const picture = selectCover(metadata.common.picture);

    if (
      picture === null ||
      typeof picture.format !== 'string' ||
      !picture.format.startsWith('image/') ||
      picture.data.byteLength === 0
    ) {
      return { title, coverUrl: null };
    }

    // Copy into a plain ArrayBuffer so strict DOM typings accept the image
    // bytes even when music-metadata exposes a SharedArrayBuffer-capable view.
    const imageBytes = new Uint8Array(picture.data.byteLength);
    imageBytes.set(picture.data);
    const imageBlob = new Blob([imageBytes.buffer], { type: picture.format });
    return { title, coverUrl: URL.createObjectURL(imageBlob) };
  } catch {
    // Invalid tags, unsupported containers, and object-URL failures all use
    // the same non-blocking title-card fallback.
    return fallback;
  }
}

/** Release a display-only cover URL without affecting the source audio. */
export function revokeAudioCoverUrl(coverUrl: string | null): void {
  if (coverUrl === null) return;
  try {
    URL.revokeObjectURL(coverUrl);
  } catch {
    // Cleanup is best effort; browsers may already have released the URL.
  }
}
