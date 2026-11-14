/**
 * tauri-bridge — desktop (Tauri) runtime detection + unified `tauri-plugin-modules` bridge.
 * ---------------------------------------------------------------------------
 * The Entei desktop app ships `plugins/tauri-plugin-modules` in-process; all
 * native modules (`ytdlp`, `torrent`, `jimaku`, `nadeshiko`, `yomitan`) resolve
 * and relay through `plugin:modules|*`:
 *
 * - `plugin:modules|stream_youtube` resolves the stream and hands back a
 *   loopback relay URL (`http://127.0.0.1:<port>/stream/<session>`) that the
 *   `<video>` element can play directly.
 * - `plugin:modules|add_torrent` / `get_torrent_status` / `select_torrent_files`
 *   drive the torrent session, and `select_torrent_files` returns the same
 *   kind of loopback relay URL for the chosen video/subtitle file.
 *
 * The standalone browser build has no Tauri runtime, so every entry point here
 * is guarded by `isTauri()` and fails without contacting an external service.
 * Nothing in this module touches storage; upstream URLs are not logged, and
 * only the relay URLs are handed to the media element.
 *
 * Every IPC call goes through `tracedInvoke`, so the trace journal records
 * each command with its duration and outcome instead of every wrapper
 * repeating that bookkeeping.
 * --------------------------------------------------------------------------- */

import { tracedInvoke } from '@/features/trace/trace-logger';
import type { ScreenshotResult } from '@/features/player/screenshot-capture';
import {
  parseSubtitle,
  type SubtitleCue,
  type SubtitleError,
  type SubtitleParseResult,
} from '@/features/player/subtitle-reader';
import {
  parseMediaFileName,
  type ParsedMediaName,
} from '@/features/player/filename-parser';
import { estimateMedianOffset } from '@/features/player/lazy-sync';
import type { JimakuEntry, JimakuFile } from '@/features/player/jimaku-client';
import type {
  NadeshikoContextOptions,
  NadeshikoSearchOptions,
  NadeshikoSearchPage,
  NadeshikoSegmentContextResponse,
  NadeshikoUserMe as NadeshikoUserMeContract,
} from '@/features/nadeshiko/nadeshiko-client';

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

/** AnkiConnect error kinds returned by `tauri-plugin-anki`. */
export type AnkiNativeErrorKind =
  | 'network'
  | 'api-key-required'
  | 'permission-denied'
  | 'server-error'
  | 'invalid-response';

/** Native connection states returned by `anki_check_connection`. */
export type AnkiNativeConnectionState =
  | 'connected'
  | 'unavailable'
  | 'api-key-required'
  | 'permission-denied'
  | 'unknown-error';

export interface AnkiNativeConnectionStatus {
  state: AnkiNativeConnectionState;
  endpoint: string;
  version: number | null;
  requireApiKey: boolean;
  decks: string[];
  models: string[];
  message: string | null;
  errorKind: AnkiNativeErrorKind | null;
}

/** Invoke one AnkiConnect action through the desktop plugin. */
export function ankiRequestDirect<T = unknown>(args: {
  endpoint?: string;
  action: string;
  version?: number;
  params?: Record<string, unknown>;
  key?: string;
}): Promise<T> {
  return invokePluginCommand<T>('plugin:anki|anki_request', args);
}

/** Run the native version / permission / deck / model connection flow. */
export async function ankiCheckConnectionDirect(
  endpoint?: string,
  key?: string,
): Promise<AnkiNativeConnectionStatus> {
  const raw = await invokePluginCommand<unknown>(
    'plugin:anki|anki_check_connection',
    { endpoint, key },
  );
  if (!isAnkiNativeConnectionStatus(raw)) {
    throw new Error('invalid Anki connection status reply');
  }
  return raw;
}

function isAnkiNativeConnectionStatus(
  value: unknown,
): value is AnkiNativeConnectionStatus {
  if (typeof value !== 'object' || value === null) return false;
  const status = value as Record<string, unknown>;
  const validStates: AnkiNativeConnectionState[] = [
    'connected',
    'unavailable',
    'api-key-required',
    'permission-denied',
    'unknown-error',
  ];
  const validErrorKinds: Array<AnkiNativeErrorKind | null> = [
    null,
    'network',
    'api-key-required',
    'permission-denied',
    'server-error',
    'invalid-response',
  ];
  const validStringArray = (items: unknown): items is string[] =>
    Array.isArray(items) && items.every((item) => typeof item === 'string');
  return (
    validStates.includes(status.state as AnkiNativeConnectionState) &&
    typeof status.endpoint === 'string' &&
    (typeof status.version === 'number' || status.version === null) &&
    typeof status.requireApiKey === 'boolean' &&
    validStringArray(status.decks) &&
    validStringArray(status.models) &&
    (typeof status.message === 'string' || status.message === null) &&
    validErrorKinds.includes(status.errorKind as AnkiNativeErrorKind | null)
  );
}

/** Search Jimaku entries for anime or dramas. */
export function jimakuSearchEntriesDirect(
  apiKey: string,
  query: string,
  anime: boolean,
): Promise<JimakuEntry[]> {
  return invokePluginCommand<JimakuEntry[]>(
    'plugin:modules|modules_jimaku_search_entries',
    { apiKey, query, anime },
  );
}

/** Search anime and dramas together, sorted and de-duplicated natively. */
export function jimakuSearchEntriesCombinedDirect(
  apiKey: string,
  query: string,
): Promise<JimakuEntry[]> {
  return invokePluginCommand<JimakuEntry[]>(
    'plugin:modules|modules_jimaku_search_entries_combined',
    { apiKey, query },
  );
}

/** List the subtitle files for a Jimaku entry. */
export function jimakuEntryFilesDirect(
  apiKey: string,
  entryId: number,
  episode?: number,
): Promise<JimakuFile[]> {
  return invokePluginCommand<JimakuFile[]>(
    'plugin:modules|modules_jimaku_entry_files',
    { apiKey, entryId, episode },
  );
}

/** Download one public Jimaku subtitle through the native HTTP client. */
export function jimakuDownloadSubtitleDirect(url: string): Promise<string> {
  return invokePluginCommand<string>(
    'plugin:modules|modules_jimaku_download_subtitle',
    { url },
  );
}

/** Search Nadeshiko segments through the native API client. */
export function nadeshikoSearchDirect(
  apiKey: string,
  query: string,
  options?: NadeshikoSearchOptions,
): Promise<NadeshikoSearchPage> {
  return invokePluginCommand<NadeshikoSearchPage>(
    'plugin:modules|modules_nadeshiko_search',
    { apiKey, query, options },
  );
}

/** Fetch the context around one Nadeshiko segment. */
export function nadeshikoSegmentContextDirect(
  apiKey: string,
  segmentId: string,
  options?: NadeshikoContextOptions,
): Promise<NadeshikoSegmentContextResponse> {
  return invokePluginCommand<NadeshikoSegmentContextResponse>(
    'plugin:modules|modules_nadeshiko_segment_context',
    { apiKey, segmentId, options },
  );
}

/** Fetch the Nadeshiko account and quota data through the native client. */
export function nadeshikoUserMeDirect(
  apiKey: string,
): Promise<NadeshikoUserMeContract> {
  return invokePluginCommand<NadeshikoUserMeContract>(
    'plugin:modules|modules_nadeshiko_user_me',
    { apiKey },
  );
}

/* ---------------------------------------------------------------------------
 * Yomitan dictionaries (native engine)
 * --------------------------------------------------------------------------
 * The dictionary database is Rust: `plugins/tauri-plugin-modules`
 * (SQLite at `app_data_dir/yomitan-dictionaries.db`) parses the ZIP, stores
 * every bank and answers the lookups. The web layer holds NO dictionary data —
 * no IndexedDB, no decompression, no bank conversion.
 *
 * Import takes a PATH, not bytes: the Rust importer streams the archive off
 * disk, so a multi-gigabyte dictionary costs no renderer memory, and a ZIP as a
 * JS number array over IPC would be both huge and slow. A WebView2 `File` has
 * no filesystem path, so the path comes from the native dialog plugin (the same
 * route `MediaPicker` uses for media).
 * ------------------------------------------------------------------------- */

/** One imported dictionary, as reported by the native engine (camelCase serde). */
export interface YomitanDictionarySummary {
  /** Stable FNV-1a identity of format+revision+title — what toggle/delete take. */
  id: string;
  title: string;
  /** Dictionary data format the archive declared (1 or 3). */
  format: number;
  revision: string;
  sequenced: boolean;
  author: string | null;
  url: string | null;
  description: string | null;
  /** First-import timestamp in epoch milliseconds. */
  createdAt: number;
  /** False → lookups skip this dictionary. */
  enabled: boolean;
  /**
   * True when this dictionary carries frequency metadata (`term_meta` rows in
   * the engine's `freq` mode). Only these are valid choices for the
   * "frequency sorting dictionary" setting — a plain word dictionary such as
   * JMdict has nothing to sort by.
   */
  hasFrequencyData: boolean;
}

/** One headword from the native engine (glossary is already-parsed JSON). */
export interface YomitanTermEntry {
  id: number;
  dictionaryId: string;
  expression: string;
  reading: string | null;
  definitionTags: string | null;
  rules: string | null;
  score: number;
  sequence: number;
  termTags: string | null;
  glossary: unknown;
}

/** One kanji entry from the native engine. */
export interface YomitanKanjiEntry {
  character: string;
  dictionaryId: string;
  onyomi: string | null;
  kunyomi: string | null;
  tags: string | null;
  meanings: string[];
  stats: Record<string, unknown> | null;
}

/**
 * Import one dictionary archive from an absolute path the user picked.
 *
 * Re-importing the same archive replaces that dictionary's banks in one
 * transaction and leaves it enabled. Rejects outside Tauri — the browser has no
 * dictionary engine to import into.
 */
export function yomitanImportDictionaryDirect(args: {
  zipPath: string;
}): Promise<YomitanDictionarySummary> {
  return invokePluginCommand<YomitanDictionarySummary>(
    'plugin:modules|yomitan_import_dictionary',
    { zipPath: args.zipPath },
  );
}

/**
 * Progress of a running dictionary import, as published by the native engine.
 *
 * The engine reports per BANK (the only whole-file boundaries a streamed ZIP
 * has): `percent` is the share of the archive's banks already written.
 */
export interface YomitanImportProgress {
  percent: number;
  current: number;
  total: number;
}

/** Event name the Rust importer publishes its progress on. */
export const YOMITAN_IMPORT_PROGRESS_EVENT =
  'modules://yomitan-import-progress';

/**
 * Coerce one raw event payload into progress, or null when it is not one.
 *
 * The payload crosses the IPC boundary untyped, and the percent is rendered as a
 * number and drives a bar width: a malformed one is dropped, not shown.
 */
export function parseYomitanImportProgress(
  raw: unknown,
): YomitanImportProgress | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { percent, current, total } = raw as Record<string, unknown>;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  return {
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    current: typeof current === 'number' ? current : 0,
    total: typeof total === 'number' ? total : 0,
  };
}

/**
 * Subscribe to the native dictionary import's progress.
 *
 * Returns the unsubscribe function, always — a browser (no engine, no events)
 * gets a no-op instead of a throw, so callers need no runtime check. The
 * subscription is lazy (`@tauri-apps/api/event` is imported on demand), and
 * unsubscribing before it resolves unlistens as soon as it does, so a settings
 * page opened and closed quickly leaves no live handler behind.
 */
export function onYomitanImportProgress(
  callback: (progress: YomitanImportProgress) => void,
): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<unknown>(YOMITAN_IMPORT_PROGRESS_EVENT, (event) => {
        const progress = parseYomitanImportProgress(event.payload);
        if (progress !== null) callback(progress);
      }),
    )
    .then((stop) => {
      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;
    })
    .catch(() => {
      // No event bridge (or a webview that blocks it): the list still works,
      // it just has no live percent to show.
    });
  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}

/** Every imported dictionary, newest import first. */
export function yomitanListDictionariesDirect(): Promise<
  YomitanDictionarySummary[]
> {
  return invokePluginCommand<YomitanDictionarySummary[]>(
    'plugin:modules|yomitan_list_dictionaries',
    {},
  );
}

/** Enable/disable one dictionary by id; lookups skip a disabled one. */
export function yomitanToggleDictionaryDirect(args: {
  id: string;
  enabled: boolean;
}): Promise<void> {
  return invokePluginCommand<void>('plugin:modules|yomitan_toggle_dictionary', {
    id: args.id,
    enabled: args.enabled,
  });
}

/** Delete one dictionary by id, together with every bank row it owns. */
export function yomitanDeleteDictionaryDirect(args: {
  id: string;
}): Promise<void> {
  return invokePluginCommand<void>('plugin:modules|yomitan_delete_dictionary', {
    id: args.id,
  });
}

/** Headwords matching `term` exactly, from enabled dictionaries, best first. */
export function yomitanFindTermsDirect(args: {
  term: string;
  limit?: number;
}): Promise<YomitanTermEntry[]> {
  return invokePluginCommand<YomitanTermEntry[]>(
    'plugin:modules|yomitan_find_terms',
    args.limit === undefined ? { term: args.term } : { term: args.term, limit: args.limit },
  );
}

/** The kanji entry for one character, or null when nothing has it. */
export function yomitanFindKanjiDirect(args: {
  character: string;
}): Promise<YomitanKanjiEntry | null> {
  return invokePluginCommand<YomitanKanjiEntry | null>(
    'plugin:modules|yomitan_find_kanji',
    { character: args.character },
  );
}

/** On-disk size of the dictionary database, in bytes, as the engine measures it. */
export interface YomitanStorageUsage {
  /** Bytes the database file and its WAL sidecars hold. */
  usage: number;
  /** Bytes the volume holding them still has available. */
  quota: number;
}

/**
 * Measure the dictionary database on disk.
 *
 * The browser's own storage estimate cannot see it: the banks live in a
 * Rust-owned SQLite file outside the renderer's origin, so
 * `navigator.storage.estimate()` reports 0 however many gigabytes were imported.
 */
export function yomitanGetStorageUsageDirect(): Promise<YomitanStorageUsage> {
  return invokePluginCommand<YomitanStorageUsage>(
    'plugin:modules|yomitan_get_storage_usage',
    {},
  );
}

/** Shared traced IPC gateway for the Anki and module plugins. */
function invokePluginCommand<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (
    typeof window === 'undefined' ||
    typeof window.__TAURI_INTERNALS__?.invoke !== 'function'
  ) {
    return Promise.reject(new Error('tauri runtime unavailable'));
  }
  const definedArgs = Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined),
  );
  return tracedInvoke(command, definedArgs) as Promise<T>;
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
   * the desktop path. Absent when the video has no
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
  const raw = await invokePluginCommand<unknown>('plugin:modules|stream_youtube', {
    url,
    mode,
  });
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
  const raw = await invokePluginCommand<unknown>('plugin:modules|get_video_info', {
    url,
  });
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
  if (
    typeof value.subtitle_vtt_url === 'string' &&
    value.subtitle_vtt_url.length > 0
  ) {
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

/** Reply of `plugin:modules|add_torrent`. */
export interface DirectTorrentAdded {
  /** Plugin-level handle used by the status/select/cancel commands. */
  id: string;
  info_hash: string;
  name: string;
  /** Resolved file list. Empty only when the torrent reports no files. */
  files: DirectTorrentFile[];
}

/** Reply of `plugin:modules|get_torrent_status`. */
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

/** Reply of `plugin:modules|select_torrent_files`. */
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
export async function addTorrentDirect(
  magnetUri: string,
): Promise<DirectTorrentAdded> {
  const raw = await invokePluginCommand<unknown>('plugin:modules|add_torrent', {
    magnetUri,
  });
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
export async function getTorrentStatusDirect(
  id: string,
): Promise<DirectTorrentStatus> {
  const raw = await invokePluginCommand<unknown>('plugin:modules|get_torrent_status', {
    id,
  });
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
    progress_bytes:
      typeof value.progress_bytes === 'number' ? value.progress_bytes : 0,
    total_bytes: typeof value.total_bytes === 'number' ? value.total_bytes : 0,
    progress_percent:
      typeof value.progress_percent === 'number' ? value.progress_percent : 0,
    download_speed_mbps:
      typeof value.download_speed_mbps === 'number'
        ? value.download_speed_mbps
        : 0,
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
  const args: Record<string, unknown> = { id, videoIndex };
  if (typeof subtitleIndex === 'number') args.subtitleIndex = subtitleIndex;
  const raw = await invokePluginCommand<unknown>(
    'plugin:modules|select_torrent_files',
    args,
  );
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
    video_length:
      typeof value.video_length === 'number' ? value.video_length : 0,
    subtitle_url:
      typeof value.subtitle_url === 'string' && value.subtitle_url.length > 0
        ? value.subtitle_url
        : null,
    subtitle_name:
      typeof value.subtitle_name === 'string' ? value.subtitle_name : null,
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
  await invokePluginCommand<void>('plugin:modules|cancel_torrent', { id });
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

/** The native screenshot command is only trusted for the current local file. */
let mpvNativeActive = false;
/** Suppress HTML fallback while a native file is replacing the prior frame. */
let mpvNativeLoading = false;
/** Invalidates a capture if the source changes while its native IPC is pending. */
let mpvCaptureEpoch = 0;

/** Keep screenshot selection aligned with PlayerApp's native-render state. */
export function setMpvNativeActive(active: boolean): void {
  const nextActive = active && isTauri();
  if (nextActive !== mpvNativeActive) mpvCaptureEpoch += 1;
  mpvNativeActive = nextActive;
}

/** Mark the interval in which neither old native nor stale HTML frames are valid. */
export function setMpvNativeLoading(loading: boolean): void {
  const nextLoading = loading && isTauri();
  if (nextLoading !== mpvNativeLoading) mpvCaptureEpoch += 1;
  mpvNativeLoading = nextLoading;
}

/** Capture a JPEG from mpv, surfacing failures so the caller can use canvas. */
export async function mpvScreenshot(
  mode: 'video' | 'subtitles' = 'video',
): Promise<string> {
  if (!isTauri()) throw new Error('tauri runtime unavailable');
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function')
    throw new Error('tauri runtime unavailable');
  const result = await tracedInvoke('plugin:mpv|mpv_screenshot', { mode });
  if (
    typeof result !== 'string' ||
    !result.startsWith('data:image/jpeg;base64,')
  ) {
    throw new Error('invalid mpv screenshot reply');
  }
  return result;
}

/**
 * Capture a video frame, preferring the native renderer only while it owns the
 * current media. The canvas path remains the fallback for browser playback,
 * inactive mpv and any native command/decoding failure.
 */
export async function captureVideoFrameDirect(
  video?: HTMLVideoElement | null,
): Promise<ScreenshotResult> {
  const captureEpoch = mpvCaptureEpoch;
  if (isTauri() && mpvNativeLoading) {
    return {
      ok: false,
      error: {
        code: 'VIDEO_UNAVAILABLE',
        message: 'The native video frame is still loading.',
      },
    };
  }
  if (isTauri() && mpvNativeActive) {
    const captureEpoch = mpvCaptureEpoch;
    try {
      const dataUrl = await mpvScreenshot('video');
      const response = await fetch(dataUrl);
      if (!response.ok) throw new Error('failed to decode native screenshot');
      const blob = await response.blob();
      const { constrainScreenshotBlob } =
        await import('@/features/player/screenshot-capture');
      const constrainedBlob = await constrainScreenshotBlob(blob);
      if (
        captureEpoch !== mpvCaptureEpoch ||
        !mpvNativeActive ||
        mpvNativeLoading
      ) {
        return {
          ok: false,
          error: {
            code: 'VIDEO_UNAVAILABLE',
            message: 'The native video source changed during capture.',
          },
        };
      }
      return { ok: true, blob: constrainedBlob };
    } catch {
      // Native capture is best-effort; keep the existing browser route alive.
      if (
        captureEpoch !== mpvCaptureEpoch ||
        !mpvNativeActive ||
        mpvNativeLoading
      ) {
        return {
          ok: false,
          error: {
            code: 'VIDEO_UNAVAILABLE',
            message: 'The native video source changed during capture.',
          },
        };
      }
    }
  }
  const { captureVideoFrameCanvas } =
    await import('@/features/player/screenshot-capture');
  if (
    (isTauri() && mpvNativeLoading) ||
    captureEpoch !== mpvCaptureEpoch
  ) {
    return {
      ok: false,
      error: {
        code: 'VIDEO_UNAVAILABLE',
        message: 'The native video source changed during capture.',
      },
    };
  }
  const result = await captureVideoFrameCanvas(video);
  if (
    (isTauri() && mpvNativeLoading) ||
    captureEpoch !== mpvCaptureEpoch
  ) {
    return {
      ok: false,
      error: {
        code: 'VIDEO_UNAVAILABLE',
        message: 'The native video source changed during capture.',
      },
    };
  }
  return result;
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

/**
 * Move and resize the native video surface so the picture matches the HTML
 * media frame.
 *
 * The rectangle is in physical pixels relative to the Tauri window's client
 * area (the page multiplies its CSS-pixel rect by `devicePixelRatio`). The
 * plugin takes integers, so the values are rounded here: a fractional
 * argument is rejected by the IPC deserializer and the surface would then
 * silently stay where it was.
 *
 * A rectangle without area is a valid request — the media frame is gone (no
 * media, immersive mode exited), so the surface must be hidden instead of
 * resized to nothing. Values the plugin rejects anyway (a non-finite number
 * or a negative width/height) are dropped before the IPC call.
 */
export async function mpvSetBounds(
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  if (width < 0 || height < 0) return;
  await mpvInvoke('plugin:mpv|mpv_set_bounds', {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
}

/* ---------------------------------------------------------------------------
 * Native subtitle engine (`plugin:subtitles`)
 * ---------------------------------------------------------------------------
 * The desktop build ships `plugins/tauri-plugin-subtitles`, a line-by-line
 * Rust port of the three TypeScript helpers that used to run on the browser
 * main thread:
 *
 * - `subtitles_parse(content, format)` — SRT / VTT / ASS parsing.
 * - `subtitles_parse_filename(name)` — media file name → `{ title, episode }`.
 * - `subtitles_estimate_lazy_sync(ref_cues, drift_cues)` — LazySync offset.
 *
 * Inside Tauri the work runs on Rust's blocking thread pool (1–2 ms for a
 * 3 000-cue file) instead of the webview's JavaScript thread; outside Tauri
 * (the standalone browser build) the wrappers fall back to the TypeScript
 * implementation, so both builds keep the same behaviour.
 *
 * Every wrapper is fail-soft: a missing plugin, a rejected command or a
 * malformed reply falls back to the TypeScript path instead of breaking the
 * player. The plugin's replies are validated before they reach the UI, so a
 * broken native build degrades to "slow but correct" rather than to wrong
 * cues.
 * ------------------------------------------------------------------------- */

/**
 * Run one `plugin:subtitles` command.
 *
 * Unlike the mpv wrappers this REJECTS on failure: the caller has to see the
 * error to fall back to the TypeScript implementation.
 */
async function invokeSubtitlesPlugin(
  cmd: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') {
    throw new Error('tauri runtime unavailable');
  }
  // Traced: the journal records the command, its duration and its outcome.
  return tracedInvoke(cmd, args);
}

/** Shape check for one cue of a native parse result. */
function normalizeSubtitleCue(raw: unknown): SubtitleCue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const { id, start, end, text } = value;
  if (typeof id !== 'number' || !Number.isFinite(id)) return null;
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  if (typeof end !== 'number' || !Number.isFinite(end)) return null;
  if (typeof text !== 'string') return null;
  return { id, start, end, text };
}

/** Shape check for one validation error of a native parse result. */
function normalizeSubtitleError(raw: unknown): SubtitleError | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const { line, message } = value;
  if (typeof line !== 'number' || !Number.isFinite(line)) return null;
  if (typeof message !== 'string') return null;
  return { line, message };
}

/**
 * Shape check for the whole native parse result.
 *
 * Returns null when the reply does not match the contract — the caller then
 * uses the TypeScript parser instead of rendering half-parsed cues.
 */
function normalizeSubtitleParseResult(
  raw: unknown,
): SubtitleParseResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const { cues, errors, format } = value;
  if (!Array.isArray(cues) || !Array.isArray(errors)) return null;
  if (
    format !== null &&
    format !== 'srt' &&
    format !== 'vtt' &&
    format !== 'ass'
  ) {
    return null;
  }
  const parsedCues: SubtitleCue[] = [];
  for (const entry of cues) {
    const cue = normalizeSubtitleCue(entry);
    if (!cue) return null;
    parsedCues.push(cue);
  }
  const parsedErrors: SubtitleError[] = [];
  for (const entry of errors) {
    const error = normalizeSubtitleError(entry);
    if (!error) return null;
    parsedErrors.push(error);
  }
  return { cues: parsedCues, errors: parsedErrors, format };
}

/** Shape check for the native `{ title, episode }` reply. */
function normalizeParsedMediaName(raw: unknown): ParsedMediaName | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const { title, episode } = value;
  if (typeof title !== 'string') return null;
  if (
    episode !== null &&
    episode !== undefined &&
    typeof episode !== 'number'
  ) {
    return null;
  }
  return {
    title,
    episode:
      typeof episode === 'number' && Number.isFinite(episode) ? episode : null,
  };
}

/**
 * Parse a subtitle file (SRT / VTT / ASS) through the native plugin.
 *
 * Inside Tauri the parse runs on Rust's blocking pool; outside Tauri — or
 * when the plugin is missing / rejects / answers with a malformed reply — the
 * TypeScript parser takes over and produces the same cues.
 *
 * `format` is an optional hint (`srt` / `vtt` / `ass`) that overrides the
 * auto-detection. Note: the TypeScript fallback always auto-detects, so a
 * hint only takes effect on the native path.
 */
export async function parseSubtitleDirect(
  content: string,
  format?: string | null,
): Promise<SubtitleParseResult> {
  if (isTauri()) {
    try {
      const raw = await invokeSubtitlesPlugin(
        'plugin:subtitles|subtitles_parse',
        { content, format: format ?? null },
      );
      const parsed = normalizeSubtitleParseResult(raw);
      if (parsed) return parsed;
    } catch {
      // Native parser unavailable — the TypeScript parser takes over.
    }
  }
  return parseSubtitle(content);
}

/**
 * Extract `{ title, episode }` from a media file name through the native
 * plugin, falling back to the TypeScript parser outside Tauri.
 */
export async function parseMediaFilenameDirect(
  filename: string,
): Promise<ParsedMediaName> {
  if (isTauri()) {
    try {
      const raw = await invokeSubtitlesPlugin(
        'plugin:subtitles|subtitles_parse_filename',
        { name: filename },
      );
      const parsed = normalizeParsedMediaName(raw);
      if (parsed) return parsed;
    } catch {
      // Native parser unavailable — the TypeScript parser takes over.
    }
  }
  return parseMediaFileName(filename);
}

/**
 * Estimate the LazySync offset (reference − drift) between two subtitle
 * tracks, in **milliseconds**.
 *
 * The plugin reports the offset in seconds (the same unit as
 * `SubtitleCue.start`), so the value is converted here: the web layer works
 * in milliseconds (`LAZY_SYNC_MIN_OFFSET_MS`, `shiftCuesByOffset`).
 *
 * `null` means "no trustworthy estimate" (fail-closed) — the native estimator
 * refuses in the same situations as the TypeScript one (empty track, bimodal
 * split, offset beyond one hour).
 *
 * Note: the native path reports an offset below 100 ms as exactly 0 ms
 * ("already in sync"), while the TypeScript path reports the raw median.
 * Both stay below `LAZY_SYNC_MIN_OFFSET_MS`, so the Player treats them the
 * same way.
 */
export async function estimateLazySyncOffsetDirect(
  refCues: readonly SubtitleCue[],
  driftCues: readonly SubtitleCue[],
): Promise<number | null> {
  if (isTauri()) {
    try {
      const raw = await invokeSubtitlesPlugin(
        'plugin:subtitles|subtitles_estimate_lazy_sync',
        {
          refCues: refCues.map((cue) => ({
            id: cue.id,
            start: cue.start,
            end: cue.end,
            text: cue.text,
          })),
          driftCues: driftCues.map((cue) => ({
            id: cue.id,
            start: cue.start,
            end: cue.end,
            text: cue.text,
          })),
        },
      );
      // `null` is the plugin's fail-closed answer: no estimate at all.
      if (raw === null || raw === undefined) return null;
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        // Seconds → milliseconds (the web layer's unit).
        return Math.round(raw * 1000);
      }
      // Unexpected reply shape → the TypeScript estimator takes over.
    } catch {
      // Native estimator unavailable — the TypeScript estimator takes over.
    }
  }
  // The TypeScript estimator takes (drift, ref) — the opposite order of the
  // native command, which takes (ref, drift).
  return estimateMedianOffset(driftCues, refCues)?.offsetMs ?? null;
}

/* ---------------------------------------------------------------------------
 * Embedded SQLite database (`plugin:database`)
 * ---------------------------------------------------------------------------
 * The desktop build ships `plugins/tauri-plugin-database`: a single embedded
 * SQLite file (`entei.db`) that is the source of truth for user data (timeline
 * posts + replies, watch history + sessions, mining archive, profile, and a
 * generic key/value store) on desktop. The standalone browser build has no
 * Tauri runtime and keeps its existing IndexedDB / localStorage stores; the
 * callers branch on `isTauri()` and every wrapper here REJECTS outside Tauri
 * (never a silent no-op) so the caller's fallback runs unchanged.
 *
 * All commands go through `tracedInvoke`. Database args carry user content
 * (post text, mined sentences, titles) — not credentials, tokens or URLs — so
 * the trace sanitizer's default clipping is the right treatment and none of the
 * magnet/URL redaction the torrent / yt-dlp wrappers rely on is needed here.
 * ------------------------------------------------------------------------- */

/** Mirror of the plugin's `TimelinePost` (serde camelCase). */
export interface DbTimelinePost {
  id: string;
  authorHandle: string;
  authorName: string;
  authorAvatar: string;
  content: string;
  /** Epoch milliseconds. */
  createdAt: number;
  likes: number;
  likedByMe: boolean;
  replyCount: number;
  parentId: string | null;
}

/** Input for `dbCreateTimelinePost` (the Rust side owns `id` / counters). */
export interface DbTimelinePostInput {
  authorHandle: string;
  authorName: string;
  authorAvatar: string;
  content: string;
  createdAt: number;
  parentId: string | null;
}

/** Mirror of the plugin's `WatchHistoryItem` / `WatchHistoryInput`. */
export interface DbWatchHistoryItem {
  mediaId: string;
  title: string;
  titleNative: string | null;
  episode: number | null;
  source: string;
  watchedAt: number;
  duration: number | null;
  position: number | null;
  posterUrl: string | null;
  posterStatus: string | null;
  anilistId: number | null;
  /** TMDB ids are numeric; SQLite stores the integer (the web layer keeps a string). */
  tmdbId: number | null;
}

/** Input for `dbUpsertWatchHistory`, keyed by `mediaId`. */
export type DbWatchHistoryInput = DbWatchHistoryItem;

/** Mirror of the plugin's `WatchSessionItem`. */
export interface DbWatchSessionItem {
  id: string;
  mediaId: string;
  title: string;
  startTime: number;
  endTime: number;
  duration: number;
  cuesMined: number;
  minedSentences: string[];
}

/** Input for `dbSaveWatchSession`. `id` pins a stable per-sit-down identity. */
export interface DbWatchSessionInput {
  id?: string | null;
  mediaId: string;
  title: string;
  startTime: number;
  endTime: number;
  duration: number;
  cuesMined: number;
  minedSentences: string[];
}

/** Mirror of the plugin's `MiningArchiveItem`. */
export interface DbMiningArchiveItem {
  id: string;
  mediaFilename: string;
  createdAt: number;
  sentence: string;
  word: string | null;
  rangeStart: number | null;
  rangeEnd: number | null;
}

/** Input for `dbSaveMiningCard` (the Rust side owns `id`). */
export interface DbMiningArchiveInput {
  mediaFilename: string;
  createdAt: number;
  sentence: string;
  word: string | null;
  rangeStart: number | null;
  rangeEnd: number | null;
}

/** Mirror of the plugin's `UserProfile` / `UserProfileInput`. */
export interface DbUserProfile {
  handle: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  updatedAt: number;
}

/** Input for `dbUpsertProfile`. */
export type DbUserProfileInput = DbUserProfile;

/** One key/value pair of the generic settings store. */
export interface DbKvEntry {
  key: string;
  value: string;
}

/** Batch payload for the one-shot `dbMigrateV1` import. */
export interface DbMigrationPayloadV1 {
  posts: DbTimelinePost[];
  watchHistory: DbWatchHistoryItem[];
  watchSessions: DbWatchSessionItem[];
  miningArchive: DbMiningArchiveItem[];
  profile: DbUserProfile | null;
  kv: DbKvEntry[];
}

/** Run one `plugin:database` command; rejects outside Tauri. */
async function invokeDatabaseCommand<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!isTauri()) throw new Error('tauri runtime unavailable');
  return (await tracedInvoke(`plugin:database|${command}`, args)) as T;
}

/** List top-level posts (newest first) or, with `parentId`, that post's replies. */
export function dbGetTimelinePosts(
  opts: { limit?: number; offset?: number; parentId?: string | null } = {},
): Promise<DbTimelinePost[]> {
  const args: Record<string, unknown> = {};
  if (opts.limit !== undefined) args.limit = opts.limit;
  if (opts.offset !== undefined) args.offset = opts.offset;
  if (opts.parentId != null) args.parentId = opts.parentId;
  return invokeDatabaseCommand<DbTimelinePost[]>('db_get_timeline_posts', args);
}

/** Create a post or reply; the plugin generates and returns the row with its id. */
export function dbCreateTimelinePost(
  post: DbTimelinePostInput,
): Promise<DbTimelinePost> {
  return invokeDatabaseCommand<DbTimelinePost>('db_create_timeline_post', {
    post,
  });
}

/** Toggle the caller's like on one post and return the updated row. */
export function dbToggleLikePost(id: string): Promise<DbTimelinePost> {
  return invokeDatabaseCommand<DbTimelinePost>('db_toggle_like_post', { id });
}

/** Read watch history newest-first. */
export function dbGetWatchHistory(
  opts: { limit?: number; offset?: number } = {},
): Promise<DbWatchHistoryItem[]> {
  const args: Record<string, unknown> = {};
  if (opts.limit !== undefined) args.limit = opts.limit;
  if (opts.offset !== undefined) args.offset = opts.offset;
  return invokeDatabaseCommand<DbWatchHistoryItem[]>(
    'db_get_watch_history',
    args,
  );
}

/** Insert or update one watch-history entry keyed by `mediaId`. */
export function dbUpsertWatchHistory(
  item: DbWatchHistoryInput,
): Promise<void> {
  return invokeDatabaseCommand<void>('db_upsert_watch_history', { item });
}

/** Read watch sessions, optionally filtered to one media, newest first. */
export function dbGetWatchSessions(
  mediaId?: string | null,
): Promise<DbWatchSessionItem[]> {
  return invokeDatabaseCommand<DbWatchSessionItem[]>(
    'db_get_watch_sessions',
    mediaId ? { mediaId } : {},
  );
}

/** Persist or update a viewing session (upserts on a stable `id` when given). */
export function dbSaveWatchSession(session: DbWatchSessionInput): Promise<void> {
  return invokeDatabaseCommand<void>('db_save_watch_session', { session });
}

/** Read the mining archive newest-first. */
export function dbGetMiningArchive(
  opts: { limit?: number; offset?: number } = {},
): Promise<DbMiningArchiveItem[]> {
  const args: Record<string, unknown> = {};
  if (opts.limit !== undefined) args.limit = opts.limit;
  if (opts.offset !== undefined) args.offset = opts.offset;
  return invokeDatabaseCommand<DbMiningArchiveItem[]>(
    'db_get_mining_archive',
    args,
  );
}

/** Append one mined card to the archive. */
export function dbSaveMiningCard(card: DbMiningArchiveInput): Promise<void> {
  return invokeDatabaseCommand<void>('db_save_mining_card', { card });
}

/** Read the single-user profile row, or null when none exists yet. */
export function dbGetProfile(): Promise<DbUserProfile | null> {
  return invokeDatabaseCommand<DbUserProfile | null>('db_get_profile', {});
}

/** Upsert the single-user profile row. */
export function dbUpsertProfile(
  profile: DbUserProfileInput,
): Promise<DbUserProfile> {
  return invokeDatabaseCommand<DbUserProfile>('db_upsert_profile', { profile });
}

/** Read one key from the generic key/value store (null when absent). */
export function dbKvGet(key: string): Promise<string | null> {
  return invokeDatabaseCommand<string | null>('db_kv_get', { key });
}

/** Write one key to the generic key/value store. */
export function dbKvSet(key: string, value: string): Promise<void> {
  return invokeDatabaseCommand<void>('db_kv_set', { key, value });
}

/** One-shot batch import of the browser-exported data (single transaction). */
export function dbMigrateV1(payload: DbMigrationPayloadV1): Promise<void> {
  return invokeDatabaseCommand<void>('db_migrate_v1', { payload });
}

/**
 * Open an external URL in the user's default system browser.
 * Outside Tauri, falls back to `window.open(url, '_blank', 'noopener,noreferrer')`.
 */
export async function openExternalUrlDirect(url: string): Promise<void> {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return;
  }
  if (!isTauri()) {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    return;
  }
  await tracedInvoke('open_external_url', { url });
}

/**
 * Race a promise with an AbortSignal so desktop Tauri IPC calls abort
 * consistently with web fetch callers when a request is cancelled.
 */
export function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort);
    promise.then(
      (res) => {
        cleanup();
        resolve(res);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}
