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
 *
 * Every IPC call goes through `tracedInvoke`, so the trace journal records
 * each command with its duration and outcome instead of every wrapper
 * repeating that bookkeeping.
 * --------------------------------------------------------------------------- */

import { tracedInvoke } from '@/features/trace/trace-logger';

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
  /**
   * Direct Japanese WebVTT URL published by YouTube, when one exists.
   *
   * The player fetches this itself to restore the YouTube subtitle pipeline on
   * the desktop path (no companion involvement). Absent when the video has no
   * Japanese track, which is not an error.
   */
  subtitle_vtt_url?: string | null;
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
  const raw = await tracedInvoke('plugin:ytdlp|stream_youtube', { url, mode });
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
  const raw = await tracedInvoke('plugin:ytdlp|get_video_info', { url });
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
  if (typeof value.subtitle_vtt_url === 'string' && value.subtitle_vtt_url.length > 0) {
    info.subtitle_vtt_url = value.subtitle_vtt_url;
  }
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
  /** Resolved file list. Empty only when the torrent reports no files. */
  files: DirectTorrentFile[];
}

/** Reply of `plugin:torrent|get_torrent_status`. */
export interface DirectTorrentStatus {
  id: string;
  info_hash: string;
  name: string;
  /** `metadata` (list only, nothing downloaded yet) | `initializing` | `live` |
   * `paused` | `error`. */
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
  /**
   * Matroska audio track number the plugin auto-selected (`--alang=ja,jpn`).
   * `null` for non-Matroska files or when the header was not readable yet.
   *
   * Currently informational: relay playback stays on the HTML element (mpv is
   * only attached to a local file with an absolute path, so no second audio
   * output is created), and Chromium does not expose MKV audio tracks to
   * JavaScript. The value is kept for diagnostics and for a future native
   * relay path.
   */
  selected_audio_track: number | null;
  /** Same for the subtitle track (`--slang=ja,jpn`); informational, see above. */
  selected_subtitle_track: number | null;
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
  // Traced: the journal records the command, its duration and its outcome.
  return tracedInvoke;
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
 * Resolve a magnet URI's metadata without starting any download.
 *
 * The plugin validates the URI, resolves the info dictionary only (a few KB —
 * no file is created and no piece is fetched) and returns the plugin torrent id
 * plus the file list. The download starts later, in `selectTorrentFilesDirect`,
 * restricted to the files the user picks.
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
 * Start the download for the chosen files and get loopback playback URLs.
 *
 * `videoIndex`/`subtitleIndex` are the `TorrentFile.index` values from the
 * plugin's file list. This is the only call that starts downloading: every
 * other file in the torrent stays untouched. The plugin waits (bounded) for the
 * video's first byte before answering, so the returned URL is safe to mount on
 * a `<video>`.
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
    selected_audio_track:
      typeof value.selected_audio_track === 'number'
        ? value.selected_audio_track
        : null,
    selected_subtitle_track:
      typeof value.selected_subtitle_track === 'number'
        ? value.selected_subtitle_track
        : null,
  };
}

/**
 * Remove a torrent from the in-process session.
 *
 * Best-effort by contract: the caller ignores a rejection (the session may
 * already be gone). The plugin deletes the streaming cache it wrote, so a
 * cancelled torrent leaves no partial data behind.
 */
export async function cancelTorrentDirect(id: string): Promise<void> {
  const invoke = tauriInvoke();
  await invoke('plugin:torrent|cancel_torrent', { id });
}

/* ---------------------------------------------------------------------------
 * mpv native engine (`plugin:mpv`)
 * ---------------------------------------------------------------------------
 * The desktop build ships `plugins/tauri-plugin-mpv`, which drives libmpv
 * in-process as the media renderer for a **local file with an absolute path**
 * (`vo=gpu-next`, native audio, and on Windows `wid=<HWND>` so it paints into
 * the Tauri window). Entei's HTML/CSS controls stay the only control surface
 * (`osc=no` / `osd-level=0`); the HTML `<video>` is muted and kept as the
 * timing/transport shim, while every transport event below is mirrored into
 * the native engine.
 *
 * Relay streams (torrent / YouTube loopback URLs) are deliberately NOT loaded
 * into mpv: mpv owns a native audio output, so attaching it to a stream the
 * HTML element already plays would double every sound.
 *
 * Contract shared by all six wrappers:
 * - outside Tauri (the standalone browser build) they resolve immediately and
 *   never touch the IPC bridge — no throw, no console noise;
 * - a rejection is swallowed: libmpv may be missing on the machine, and a
 *   missing native engine must never break HTML playback.
 * ------------------------------------------------------------------------- */

/**
 * Run one `plugin:mpv` command, best-effort.
 *
 * Deliberately silent on failure: the web layer is the source of truth for
 * playback state, so a missing/erroring mpv is a degraded mirror, not a user
 * facing error.
 */
async function mpvInvoke(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<void> {
  if (!isTauri()) return;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') return;
  try {
    await tracedInvoke(cmd, args);
  } catch {
    // Native engine unavailable or rejected the command — HTML playback stands.
  }
}

/* --- Absolute local paths --------------------------------------------------
 * Tauri v2's WebView2 does NOT expose an absolute path on the standard HTML
 * `File` object (tauri-apps/tauri#11156, wry#87), so a `Pilih Media` pick can
 * only reach mpv through the native `tauri://drag-drop` event, which carries
 * absolute paths. `file.path` is still honoured for runtimes that expose it.
 * Paths stay in module memory only: never persisted, traced or logged.
 * ------------------------------------------------------------------------- */

type FileWithPath = File & { path?: unknown };

/** Native drop paths are only meaningful for the drop that just happened. */
export const DROP_PATH_TTL_MS = 2000;
let lastDropPaths: string[] = [];
let lastDropAt = 0;

/** Basename of a Windows, UNC or POSIX path, compared case-insensitively. */
function pathBasename(path: string): string {
  const normalized = path.replace(/[\\/]+/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

/**
 * Pure resolver: pick the absolute path belonging to `file` from a native
 * drop list. A single dropped path is accepted even when the basename does not
 * match, so a renamed or oddly encoded file name never blocks direct playback.
 */
export function matchPhysicalPath(
  file: File,
  paths: readonly string[],
  now: number,
  droppedAt: number,
): string | null {
  if (paths.length === 0 || now - droppedAt > DROP_PATH_TTL_MS) return null;
  const name = file.name.toLowerCase();
  const exact = paths.find((path) => pathBasename(path) === name);
  if (exact) return exact;
  return paths.length === 1 ? (paths[0] ?? null) : null;
}

/**
 * Subscribe to Tauri's native drag-drop event. Returns an unsubscribe fn.
 * A no-op outside Tauri, so the standalone browser build never loads the
 * event bridge at runtime.
 */
export function installTauriDragDropPaths(): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const off = await listen<{ paths?: unknown }>(
        'tauri://drag-drop',
        (event) => {
          const paths = event.payload?.paths;
          if (!Array.isArray(paths)) return;
          lastDropPaths = paths.filter(
            (entry): entry is string =>
              typeof entry === 'string' && entry.length > 0,
          );
          lastDropAt = Date.now();
        },
      );
      if (disposed) off();
      else unlisten = off;
    } catch {
      // No event bridge (e.g. a bare WebView2 host): `File.path` remains the
      // only resolver, and HTML `blob:` playback keeps working unchanged.
    }
  })();
  return () => {
    disposed = true;
    unlisten?.();
    lastDropPaths = [];
    lastDropAt = 0;
  };
}

/** Resolve the absolute path of a picked/dropped local `File`, else null. */
export function resolvePhysicalPath(file: File): string | null {
  if (!isTauri()) return null;
  const direct = (file as FileWithPath).path;
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct;
  }
  return matchPhysicalPath(file, lastDropPaths, Date.now(), lastDropAt);
}

/** Run one `plugin:mpv` command that returns a value, or null on any failure. */
async function mpvInvokeValue(cmd: string): Promise<unknown> {
  if (!isTauri()) return null;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') return null;
  try {
    return await tracedInvoke(cmd);
  } catch {
    return null;
  }
}

/**
 * Native engine position (`time-pos`) in seconds.
 *
 * `null` outside Tauri, when libmpv is missing, or while the engine has no
 * file open. Used only while mpv is the native renderer: WebView2 cannot
 * decode every source libmpv can (HEVC 4:4:4 10-bit, FLAC in MKV), so the
 * element's `timeupdate` may never arrive and the native clock has to drive
 * the subtitles, seek bar and tracker instead.
 */
export async function mpvGetTime(): Promise<number | null> {
  const value = await mpvInvokeValue('plugin:mpv|mpv_get_time');
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Native engine media duration (`duration`) in seconds, or null. */
export async function mpvGetDuration(): Promise<number | null> {
  const value = await mpvInvokeValue('plugin:mpv|mpv_get_duration');
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * True when a Player source URL is something libmpv can resolve by itself.
 *
 * Local file picks reach the Player as `blob:` object URLs. mpv cannot open
 * those, and a failed `loadfile … replace` still clears the engine's current
 * file and track state — so such sources are never mirrored. Relay URLs
 * (`http(s)://`) and absolute file paths (`Z:\Anime\...`, UNC, POSIX) stay
 * eligible; the latter is what a native desktop pick hands to `mpvLoad`.
 */
export function isMpvResolvableSource(url: string): boolean {
  if (!url) return false;
  return !url.startsWith('blob:');
}

/**
 * Load a source into the native engine (`loadfile <url> replace`).
 *
 * Only an absolute local path is ever loaded by the Player: relay streams stay
 * on the HTML element so mpv cannot add a second audio output. The `blob:`
 * guard remains because an object URL is never resolvable by mpv.
 */
export async function mpvLoad(url: string): Promise<void> {
  if (!isMpvResolvableSource(url)) return;
  await mpvInvoke('plugin:mpv|mpv_load', { url });
}

/** Resume native playback (`pause = no`). */
export async function mpvPlay(): Promise<void> {
  await mpvInvoke('plugin:mpv|mpv_play');
}

/** Pause native playback (`pause = yes`). */
export async function mpvPause(): Promise<void> {
  await mpvInvoke('plugin:mpv|mpv_pause');
}

/** Absolute seek in seconds; non-finite targets are dropped before the IPC. */
export async function mpvSeek(seconds: number): Promise<void> {
  if (!Number.isFinite(seconds)) return;
  await mpvInvoke('plugin:mpv|mpv_seek', { seconds });
}

/**
 * Subtitle offset in seconds (negative = earlier). Decimal precision is kept
 * as-is: the plugin formats it for `sub-delay` without rounding here.
 */
export async function mpvSetSubDelay(seconds: number): Promise<void> {
  if (!Number.isFinite(seconds)) return;
  await mpvInvoke('plugin:mpv|mpv_set_sub_delay', { seconds });
}

/**
 * Select the audio/subtitle track by mpv track id (`aid` / `sid`).
 *
 * An absent or empty value is sent as `null` so the plugin leaves that track
 * untouched (it skips `None`), which keeps the engine's auto-selection intact
 * when only one of the two is known.
 *
 * Note: the Player currently loads only local files into mpv and never switches
 * their tracks, so this wrapper has no call site in the app. It stays part of
 * the plugin's command surface (and its contract test) for a future native
 * relay path.
 */
export async function mpvSetTracks(
  aid?: string | null,
  sid?: string | null,
): Promise<void> {
  await mpvInvoke('plugin:mpv|mpv_set_tracks', {
    aid: aid || null,
    sid: sid || null,
  });
}
