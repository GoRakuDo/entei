/**
 * tauri-bridge — desktop (Tauri) runtime detection + direct source plugins.
 * ---------------------------------------------------------------------------
 * The Entei desktop app ships `plugins/tauri-plugin-ytdlp` and
 * `plugins/tauri-plugin-torrent` in-process, so it needs neither the Go
 * companion nor a capability token to play a YouTube or magnet source:
 *
 * - `plugin:ytdlp|stream_youtube` resolves the stream and hands back a
 *   loopback relay URL (`http://127.0.0.1:<port>/stream/<session>`) that the
 *   `<video>` element can play directly.
 * - `plugin:torrent|add_torrent` / `get_torrent_status` / `select_torrent_files`
 *   drive the torrent session, and `select_torrent_files` returns the same
 *   kind of loopback relay URL for the chosen video/subtitle file.
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

/** One file inside a torrent (mirror of the plugin's `TorrentFile`). */
export interface DirectTorrentFile {
  /** Metadata file index — what `select_torrent_files` expects. */
  index: number;
  /** Path relative to the torrent root ("Show/Episode 01.mkv"). */
  path: string;
  length: number;
}

/** Reply of `plugin:torrent|add_torrent`. */
export interface DirectTorrentAdded {
  /** Plugin-level handle used by the status/select/cancel commands. */
  id: string;
  info_hash: string;
  name: string;
  /** Empty when metadata was not resolved within the plugin's timeout. */
  files: DirectTorrentFile[];
}

/** Reply of `plugin:torrent|get_torrent_status`. */
export interface DirectTorrentStatus {
  id: string;
  info_hash: string;
  name: string;
  /** `initializing` | `live` | `paused` | `error`. */
  state: string;
  progress_bytes: number;
  total_bytes: number;
  progress_percent: number;
  download_speed_mbps: number;
  peers_live: number;
  finished: boolean;
  playable: boolean;
  error: string | null;
  files: DirectTorrentFile[];
}

/** Reply of `plugin:torrent|select_torrent_files`. */
export interface DirectTorrentSelection {
  /** Loopback relay URL for the selected video. */
  video_url: string;
  /** Basename of the selected video (display name). */
  video_name: string;
  video_length: number;
  /** Loopback relay URL for the selected subtitle file, when chosen. */
  subtitle_url: string | null;
  subtitle_name: string | null;
}

/** Read the injected `invoke`, or throw when the runtime is not Tauri. */
function tauriInvoke(): (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') {
    throw new Error('tauri runtime unavailable');
  }
  return invoke;
}

/** Shape check for a torrent file list so malformed replies never reach the UI. */
function parseTorrentFiles(raw: unknown): DirectTorrentFile[] {
  if (!Array.isArray(raw)) return [];
  const files: DirectTorrentFile[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = entry as Record<string, unknown>;
    if (
      typeof value.index !== 'number' ||
      typeof value.path !== 'string' ||
      value.path.length === 0 ||
      typeof value.length !== 'number'
    ) {
      continue;
    }
    files.push({ index: value.index, path: value.path, length: value.length });
  }
  return files;
}

/**
 * Add a magnet URI to the in-process torrent session.
 *
 * The plugin validates the URI, waits (bounded) for metadata and returns the
 * plugin torrent id plus whatever file list it resolved. An empty `files`
 * array is legitimate: the caller polls `getTorrentStatusDirect` until the
 * metadata arrives.
 */
export async function addTorrentDirect(magnetUri: string): Promise<DirectTorrentAdded> {
  const invoke = tauriInvoke();
  const raw = await invoke('plugin:torrent|add_torrent', { magnetUri });
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('invalid add torrent reply');
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error('invalid add torrent reply');
  }
  return {
    id: value.id,
    info_hash: typeof value.info_hash === 'string' ? value.info_hash : '',
    name: typeof value.name === 'string' ? value.name : '',
    files: parseTorrentFiles(value.files),
  };
}

/** Poll one torrent's progress, state and file list. */
export async function getTorrentStatusDirect(id: string): Promise<DirectTorrentStatus> {
  const invoke = tauriInvoke();
  const raw = await invoke('plugin:torrent|get_torrent_status', { id });
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('invalid torrent status reply');
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.state !== 'string') {
    throw new Error('invalid torrent status reply');
  }
  return {
    id: typeof value.id === 'string' ? value.id : id,
    info_hash: typeof value.info_hash === 'string' ? value.info_hash : '',
    name: typeof value.name === 'string' ? value.name : '',
    state: value.state,
    progress_bytes: typeof value.progress_bytes === 'number' ? value.progress_bytes : 0,
    total_bytes: typeof value.total_bytes === 'number' ? value.total_bytes : 0,
    progress_percent:
      typeof value.progress_percent === 'number' ? value.progress_percent : 0,
    download_speed_mbps:
      typeof value.download_speed_mbps === 'number' ? value.download_speed_mbps : 0,
    peers_live: typeof value.peers_live === 'number' ? value.peers_live : 0,
    finished: value.finished === true,
    playable: value.playable === true,
    error: typeof value.error === 'string' ? value.error : null,
    files: parseTorrentFiles(value.files),
  };
}

/**
 * Restrict the torrent to the chosen files and get loopback playback URLs.
 *
 * `videoIndex`/`subtitleIndex` are the `TorrentFile.index` values from the
 * plugin's file list. The plugin waits (bounded) for the video's first byte
 * before answering, so the returned URL is safe to mount on a `<video>`.
 */
export async function selectTorrentFilesDirect(
  id: string,
  videoIndex: number,
  subtitleIndex?: number | null,
): Promise<DirectTorrentSelection> {
  const invoke = tauriInvoke();
  const args: Record<string, unknown> = { id, videoIndex };
  if (typeof subtitleIndex === 'number') args.subtitleIndex = subtitleIndex;
  const raw = await invoke('plugin:torrent|select_torrent_files', args);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('invalid torrent selection reply');
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.video_url !== 'string' || value.video_url.length === 0) {
    throw new Error('invalid torrent selection reply');
  }
  return {
    video_url: value.video_url,
    video_name: typeof value.video_name === 'string' ? value.video_name : '',
    video_length: typeof value.video_length === 'number' ? value.video_length : 0,
    subtitle_url:
      typeof value.subtitle_url === 'string' && value.subtitle_url.length > 0
        ? value.subtitle_url
        : null,
    subtitle_name: typeof value.subtitle_name === 'string' ? value.subtitle_name : null,
  };
}

/**
 * Remove a torrent from the in-process session.
 *
 * Best-effort by contract: the caller ignores a rejection (the session may
 * already be gone). Downloaded files are kept on disk by the plugin.
 */
export async function cancelTorrentDirect(id: string): Promise<void> {
  const invoke = tauriInvoke();
  await invoke('plugin:torrent|cancel_torrent', { id });
}
