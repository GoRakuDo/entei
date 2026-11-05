/**
 * media-payload — player standard intake API (MODULE_ARCHITECTURE.md §3).
 * ---------------------------------------------------------------------------
 * The player (video + audio) must never know how a source was obtained. Every
 * source module (local file, yt-dlp, torrent, future community modules)
 * converts its result into one `EnteiMediaPayload` and hands it to the player.
 *
 * Design:
 * - Pure functions only: no DOM reads, no storage, no network. A module that
 *   already owns a `File` / job id can build the payload synchronously, which
 *   keeps the converters trivially unit-testable.
 * - `sourceId` is a stable, human-readable identity (`origin:id`) used for
 *   watch-history / tracker fingerprinting, never persisted with media bytes.
 * - Object URLs and `stream://` URLs are carried verbatim: this layer does not
 *   own their lifecycle (the producing module revokes what it created).
 * - `originModuleId` mirrors the module ids in `features/modules/modules-store`
 *   ('ytdlp' | 'torrent') plus 'local-file' for the built-in file picker.
 * --------------------------------------------------------------------------- */

import { isVideoFile } from '@/features/player/media-url';

/** Subtitle format the player's subtitle reader understands (P1.3a). */
export type EnteiMediaSubtitleFormat = 'vtt' | 'srt' | 'ass';

/** One selectable subtitle track attached to a media payload. */
export interface EnteiMediaSubtitleTrack {
  id: string;
  label: string;
  /** BCP-47-ish language tag ('ja', 'id', 'en', …). */
  language: string;
  /** Internal URL: `stream://…`, `blob:…`, or an inline data URL. */
  src: string;
  format: EnteiMediaSubtitleFormat;
}

/** Standard media payload accepted by PlayerApp / AudioPlayer. */
export interface EnteiMediaPayload {
  /** Unique playback-source identifier (`<originModuleId>:<local id>`). */
  sourceId: string;
  /** Playable URL (`stream://*`, `blob:*`, or a local file path). */
  mediaUrl: string;
  mediaType: 'video' | 'audio';
  title: string;
  /** Known duration in seconds; omitted while the source is still probing. */
  duration?: number;
  subtitles?: EnteiMediaSubtitleTrack[];
  posterUrl?: string;
  /** Producing module id ('local-file' | 'ytdlp' | 'torrent' | …). */
  originModuleId: string;
}

/** Built-in module ids that produce payloads (MODULE_ARCHITECTURE.md §2). */
export const LOCAL_FILE_MODULE_ID = 'local-file';
export const YTDLP_MODULE_ID = 'ytdlp';
export const TORRENT_MODULE_ID = 'torrent';

/**
 * YouTube thumbnail fallback used by the existing video/audio paths
 * (PlayerApp poster + audio-cover chain). Kept in one place so payload
 * producers agree on the same URL shape.
 */
export function youtubePosterUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/maxresdefault.jpg`;
}

/**
 * Convert a picked local file plus its object URL into a payload.
 * `objectUrl` is passed in (not created here) because the caller owns the
 * single-revoke lifecycle described in `media-url.ts`.
 *
 * `sourceId` is derived from the object URL, which the caller mints once per
 * pick: the identity is unique across picks and stable across repeated
 * conversions of the same pick. No module-level counter, so nothing here
 * carries state between calls.
 */
export function createLocalFilePayload(
  file: File,
  objectUrl: string,
): EnteiMediaPayload {
  return {
    sourceId: `${LOCAL_FILE_MODULE_ID}:${objectUrl}`,
    mediaUrl: objectUrl,
    mediaType: isVideoFile(file) ? 'video' : 'audio',
    title: file.name,
    originModuleId: LOCAL_FILE_MODULE_ID,
  };
}

/** Convert a resolved yt-dlp job into a payload. */
export function createYouTubePayload(
  jobId: string,
  title: string,
  mediaUrl: string,
  mediaType: 'video' | 'audio',
  videoId?: string,
): EnteiMediaPayload {
  const payload: EnteiMediaPayload = {
    sourceId: `${YTDLP_MODULE_ID}:${jobId}`,
    mediaUrl,
    mediaType,
    title,
    originModuleId: YTDLP_MODULE_ID,
  };
  if (videoId) payload.posterUrl = youtubePosterUrl(videoId);
  return payload;
}

/**
 * Convert a resolved torrent job into a payload. A torrent has no YouTube
 * video id, so a poster can only come from the torrent itself (file thumbnail,
 * extracted frame, …) and is passed in already resolved.
 */
export function createTorrentPayload(
  jobId: string,
  title: string,
  mediaUrl: string,
  posterUrl?: string,
): EnteiMediaPayload {
  const payload: EnteiMediaPayload = {
    sourceId: `${TORRENT_MODULE_ID}:${jobId}`,
    mediaUrl,
    mediaType: 'video',
    title,
    originModuleId: TORRENT_MODULE_ID,
  };
  if (posterUrl) payload.posterUrl = posterUrl;
  return payload;
}
