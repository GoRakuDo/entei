/**
 * tauri-bridge — desktop (Tauri) runtime detection + yt-dlp plugin calls.
 * ---------------------------------------------------------------------------
 * The Entei desktop app ships `plugins/tauri-plugin-ytdlp` in-process, so it
 * needs neither the Go companion nor a capability token to play a YouTube
 * source: `plugin:ytdlp|stream_youtube` resolves the stream and hands back a
 * loopback relay URL (`http://127.0.0.1:<port>/stream/<session>`) that the
 * `<video>` element can play directly.
 *
 * The standalone browser build has no Tauri runtime, so every entry point here
 * is guarded by `isTauri()` and callers keep their companion path untouched.
 * Nothing in this module touches storage, and the upstream (tokenised) URLs
 * never reach this layer — only the relay URLs do.
 * --------------------------------------------------------------------------- */

/** Subset of Tauri v2's injected runtime internals that this module uses. */
interface TauriInternals {
  invoke: (
    cmd: string,
    args?: Record<string, unknown>,
    options?: unknown,
  ) => Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: Partial<TauriInternals>;
  }
}

/**
 * True when running inside the Tauri desktop webview.
 *
 * Tauri v2 injects `window.__TAURI_INTERNALS__` before the frontend boots, so
 * a plain presence check is enough (no user-agent sniffing).
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** yt-dlp stream kind understood by the plugin's format selector. */
export type YtdlpStreamMode = 'video' | 'audio';

/**
 * Mirror of the plugin's `StreamSource` struct (serde keeps Rust snake_case).
 */
export interface YtdlpStreamSource {
  /** Primary media URL (muxed stream, or the video-only stream). */
  url: string;
  /**
   * Every resolved URL in yt-dlp output order.
   *
   * - length 1 → single stream (muxed for video, audio-only for audio)
   * - length 2 → `[video, audio]`; a `<video>` pointed at `urls[0]` has no
   *   audio track.
   */
  urls: string[];
  mode: string;
  format_selector: string;
  /** `false` when the loopback relay could not bind and raw URLs were used. */
  relayed: boolean;
}

/** Mirror of the plugin's `VideoInfo` struct (serde keeps Rust snake_case). */
export interface YtdlpVideoInfo {
  id: string;
  title: string;
  uploader?: string;
  /** Duration in seconds; absent for live streams. */
  duration?: number;
  thumbnail?: string;
  is_live: boolean;
  /** Available subtitle languages (manual + automatic). */
  subtitles: string[];
}

/** Shape check for the IPC result so a malformed reply never reaches the player. */
function parseStreamSource(raw: unknown): YtdlpStreamSource | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const { url, urls, mode, format_selector: selector, relayed } = value;
  if (typeof url !== 'string' || url.length === 0) return null;
  if (!Array.isArray(urls) || urls.some((u) => typeof u !== 'string')) {
    return null;
  }
  return {
    url,
    urls: urls as string[],
    mode: typeof mode === 'string' ? mode : 'video',
    format_selector: typeof selector === 'string' ? selector : '',
    relayed: relayed === true,
  };
}

/**
 * Resolve a YouTube URL to a locally playable stream through the desktop
 * yt-dlp plugin.
 *
 * Throws when the runtime is not Tauri, when yt-dlp is missing/failing, or
 * when the plugin's reply does not match the contract. Callers map any throw
 * onto their own localized generic error — the plugin's raw message may name
 * the upstream URL, so it is never surfaced.
 */
export async function streamYouTubeDirect(
  url: string,
  mode: YtdlpStreamMode = 'video',
): Promise<YtdlpStreamSource> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') {
    throw new Error('tauri runtime unavailable');
  }
  const raw = await invoke('plugin:ytdlp|stream_youtube', { url, mode });
  const source = parseStreamSource(raw);
  if (!source) throw new Error('invalid stream source reply');
  return source;
}

/**
 * Fetch the video metadata (title / duration / subtitle languages) for a
 * YouTube URL through the desktop plugin.
 *
 * Optional by design: the player can mount `streamYouTubeDirect`'s URL on its
 * own, so callers treat a rejection here as "no title available" rather than a
 * playback failure. yt-dlp's raw message may name the upstream URL, so callers
 * must not surface it.
 */
export async function getVideoInfoDirect(url: string): Promise<YtdlpVideoInfo> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') {
    throw new Error('tauri runtime unavailable');
  }
  const raw = await invoke('plugin:ytdlp|get_video_info', { url });
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('invalid video info reply');
  }
  const value = raw as Record<string, unknown>;
  const title = value.title;
  if (typeof title !== 'string' || title.length === 0) {
    throw new Error('invalid video info reply');
  }
  const info: YtdlpVideoInfo = {
    id: typeof value.id === 'string' ? value.id : '',
    title,
    is_live: value.is_live === true,
    subtitles: Array.isArray(value.subtitles)
      ? (value.subtitles as unknown[]).filter(
          (lang): lang is string => typeof lang === 'string',
        )
      : [],
  };
  if (typeof value.uploader === 'string') info.uploader = value.uploader;
  if (typeof value.thumbnail === 'string') info.thumbnail = value.thumbnail;
  if (typeof value.duration === 'number') info.duration = value.duration;
  return info;
}
