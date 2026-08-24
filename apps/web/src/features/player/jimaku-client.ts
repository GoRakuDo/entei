/**
 * jimaku-client — jimaku.cc API fetch wrapper (read-only).
 * ---------------------------------------------------------------------------
 * Design: docs/JIMAKU_SUBS.md §3. All API endpoints use the Authorization
 * header with the API key (no Bearer prefix). Subtitle downloads are public
 * (CORS *).
 *
 * Privacy (§9): the API key is NEVER included in logs, URLs, or error
 * messages. 429 is mapped to 'rate-limit' (auto-load toasts, no retry —
 * §2.2.7); 401 → 'auth'; empty results → 'empty'.
 * ---------------------------------------------------------------------------
 */

export interface JimakuEntry {
  id: number;
  name: string;
  english_name?: string;
  japanese_name?: string;
  flags: {
    anime: boolean;
    adult?: boolean;
    movie?: boolean;
    external?: boolean;
    unverified?: boolean;
  };
}

export interface JimakuFile {
  url: string;
  name: string;
  size: number;
  last_modified: string;
}

export type JimakuSearchError =
  | 'auth'
  | 'not-found'
  | 'rate-limit'
  | 'network'
  | 'empty';

export type JimakuResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: JimakuSearchError };

const API_BASE = 'https://jimaku.cc/api';

/** Perform an authenticated GET; maps HTTP status to a JimakuSearchError. */
async function apiGet(
  apiKey: string,
  path: string,
  signal?: AbortSignal,
): Promise<JimakuResult<unknown>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: apiKey },
      signal,
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'auth' };
  if (res.status === 404) return { ok: false, error: 'not-found' };
  if (res.status === 429) return { ok: false, error: 'rate-limit' };
  if (!res.ok) return { ok: false, error: 'network' };
  try {
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/**
 * Search entries (fuzzy romaji match). anime=true → anime only,
 * anime=false → dramas (live action) only (design §3.3).
 */
export async function searchJimakuEntries(
  apiKey: string,
  query: string,
  anime: boolean,
  signal?: AbortSignal,
): Promise<JimakuResult<JimakuEntry[]>> {
  const q = encodeURIComponent(query.trim());
  const result = await apiGet(
    apiKey,
    `/entries/search?query=${q}&anime=${anime ? 'true' : 'false'}`,
    signal,
  );
  if (!result.ok) return result;
  const entries = result.data as JimakuEntry[];
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, error: 'empty' };
  }
  return { ok: true, data: entries };
}

/** Get the subtitle files for an entry (optionally for one episode). */
export async function getJimakuEntryFiles(
  apiKey: string,
  entryId: number,
  episode?: number,
  signal?: AbortSignal,
): Promise<JimakuResult<JimakuFile[]>> {
  const ep = episode !== undefined ? `?episode=${episode}` : '';
  const result = await apiGet(apiKey, `/entries/${entryId}/files${ep}`, signal);
  if (!result.ok) return result;
  const files = result.data as JimakuFile[];
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: 'empty' };
  }
  return { ok: true, data: files };
}

/** Download a subtitle file body (public endpoint, no auth required). */
export async function downloadJimakuSubtitle(
  url: string,
  signal?: AbortSignal,
): Promise<JimakuResult<string>> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (res.status === 404) return { ok: false, error: 'not-found' };
  if (!res.ok) return { ok: false, error: 'network' };
  try {
    const text = await res.text();
    return { ok: true, data: text };
  } catch {
    return { ok: false, error: 'network' };
  }
}
