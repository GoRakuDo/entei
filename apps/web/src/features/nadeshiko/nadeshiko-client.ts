/**
 * nadeshiko-client — api.nadeshiko.co BYOK fetch wrapper.
 * ---------------------------------------------------------------------------
 * Design: docs/NADESHIKO_INTEGRATION.md §2.
 *
 * - Browser-direct calls (CORS `Access-Control-Allow-Origin: *` verified).
 * - API key passed per-call; the module never stores it.
 * - 300 req / 60s rate limit; 429 carries Retry-After.
 * - Errors: typed `NadeshikoErrorKind`. AbortSignal threaded everywhere.
 * - Defensive field parsing — doc doesn't specify the response shape in
 *   full, so each field uses optional chaining + fallback.
 * ---------------------------------------------------------------------------
 */

const API_BASE = 'https://api.nadeshiko.co/v1';

/* ------------------------------------------------------------------------ */
/* Error model                                                              */
/* ------------------------------------------------------------------------ */

export type NadeshikoErrorKind =
  | 'invalid-key'
  | 'rate-limited'
  | 'network'
  | 'invalid-response';

export interface NadeshikoError extends Error {
  kind: NadeshikoErrorKind;
  /** Retry-After seconds (rate-limited only). */
  retryAfterSeconds?: number;
  /** HTTP status (for debugging; never includes the API key). */
  status?: number;
}

function makeError(
  kind: NadeshikoErrorKind,
  message: string,
  extras: { retryAfterSeconds?: number; status?: number } = {},
): NadeshikoError {
  const err = new Error(message) as NadeshikoError;
  err.kind = kind;
  err.name = 'NadeshikoError';
  if (extras.retryAfterSeconds !== undefined) {
    err.retryAfterSeconds = extras.retryAfterSeconds;
  }
  if (extras.status !== undefined) err.status = extras.status;
  return err;
}

/* ------------------------------------------------------------------------ */
/* Response shapes (defensive — see NADESHIKO_INTEGRATION.md §2)            */
/* ------------------------------------------------------------------------ */

export interface NadeshikoSegment {
  /** Stable identifier for `getSegmentContext`. */
  id: string;
  /** 作品名 / anime-drama work name. */
  workName: string;
  /** セリフ / source line / quote. */
  line: string;
  /** English translation (may be absent for some entries). */
  englishTranslation?: string;
  /** Subtitle timestamp in seconds (or `M:SS` string). */
  timestampSeconds?: number;
  /** Raw timestamp display string (e.g. "01:23"). */
  timestampLabel?: string;
}

export interface NadeshikoSegmentContext extends NadeshikoSegment {
  /** Lines preceding and following the match. */
  surrounding: NadeshikoSegment[];
}

export interface NadeshikoUserMe {
  remainingRequests?: number;
  monthlyLimit?: number;
  resetAt?: string;
}

/* ------------------------------------------------------------------------ */
/* Internal helpers                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Defensive field pickers — the doc does not pin exact field names, so we
 * try the most plausible variants first and fall back gracefully.
 */
function pickString(value: unknown, ...keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickNumber(value: unknown, ...keys: string[]): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function normalizeSegment(raw: unknown): NadeshikoSegment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const id =
    pickString(r, 'id', 'segmentPublicId', 'segmentId', 'publicId') ?? '';
  const workName =
    pickString(r, 'workName', 'work', 'title', 'workTitle', 'mediaTitle') ?? '';
  const line =
    pickString(r, 'line', 'text', 'content', 'quote', 'segment') ?? '';
  if (!id && !line) return null;

  const englishTranslation = pickString(
    r,
    'englishTranslation',
    'english',
    'translation',
    'en',
  );

  const ts = pickNumber(r, 'timestamp', 'start', 'startTime', 'time');
  const timestampLabel = pickString(
    r,
    'timestampLabel',
    'timeLabel',
    'displayTime',
  );

  return {
    id,
    workName,
    line,
    englishTranslation,
    timestampSeconds: ts,
    timestampLabel,
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  // HTTP-date form
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000);
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

/* ------------------------------------------------------------------------ */
/* Core request helper                                                     */
/* ------------------------------------------------------------------------ */

async function apiRequest(
  apiKey: string,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${apiKey}`,
      },
      signal,
    });
  } catch {
    throw makeError('network', 'Network error contacting Nadeshiko API');
  }

  if (res.status === 401 || res.status === 403) {
    throw makeError('invalid-key', `Auth failed (${res.status})`, {
      status: res.status,
    });
  }

  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
    throw makeError(
      'rate-limited',
      'Rate limit exceeded',
      { status: 429, ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}) },
    );
  }

  if (!res.ok) {
    throw makeError(
      'network',
      `Nadeshiko API error ${res.status}`,
      { status: res.status },
    );
  }

  try {
    return await res.json();
  } catch {
    throw makeError('invalid-response', 'Malformed JSON response');
  }
}

/* ------------------------------------------------------------------------ */
/* Public API                                                               */
/* ------------------------------------------------------------------------ */

export interface NadeshikoSearchOptions {
  /** Max results (1-50; default 10). */
  take?: number;
  /** Sort mode (default RELEVANCE). */
  mode?: 'RELEVANCE' | 'TIME_ASC' | 'TIME_DESC' | 'RANDOM';
  /** Exact-match phrase (default false). */
  exactMatch?: boolean;
}

export async function searchNadeshikoSegments(
  apiKey: string,
  query: string,
  options: NadeshikoSearchOptions = {},
  signal?: AbortSignal,
): Promise<NadeshikoSegment[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const body = {
    query: trimmed,
    exactMatch: options.exactMatch ?? false,
    take: options.take ?? 10,
    mode: options.mode ?? 'RELEVANCE',
    cursor: null,
  };

  const data = await apiRequest(
    apiKey,
    '/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    signal,
  );

  // Response: doc says results with workName/line/translation/timestamp/id.
  // Try a few common shapes: {results: []} / {items: []} / {segments: []} / array.
  let rawList: unknown[] = [];
  if (Array.isArray(data)) {
    rawList = data;
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['results', 'items', 'segments', 'data']) {
      const candidate = obj[key];
      if (Array.isArray(candidate)) {
        rawList = candidate;
        break;
      }
    }
  }

  return rawList
    .map((r) => normalizeSegment(r))
    .filter((s): s is NadeshikoSegment => s !== null);
}

export async function getNadeshikoSegmentContext(
  apiKey: string,
  segmentId: string,
  signal?: AbortSignal,
): Promise<NadeshikoSegmentContext> {
  const data = await apiRequest(
    apiKey,
    `/media/segments/${encodeURIComponent(segmentId)}/context`,
    { method: 'GET' },
    signal,
  );

  // Same shape flexibility for the centre + surrounding list.
  const obj = (data ?? {}) as Record<string, unknown>;
  const center = normalizeSegment(obj.segment ?? obj.target ?? obj);
  const surroundingRaw = Array.isArray(obj.context)
    ? obj.context
    : Array.isArray(obj.surrounding)
      ? obj.surrounding
      : [];
  const surrounding = surroundingRaw
    .map((s) => normalizeSegment(s))
    .filter((s): s is NadeshikoSegment => s !== null);

  if (center) {
    return { ...center, surrounding };
  }

  // No center → synthesise a placeholder from whatever the API returned.
  return {
    id: segmentId,
    workName: '',
    line: '',
    surrounding,
  };
}

export async function getNadeshikoUserMe(
  apiKey: string,
  signal?: AbortSignal,
): Promise<NadeshikoUserMe> {
  const data = (await apiRequest(
    apiKey,
    '/user/me',
    { method: 'GET' },
    signal,
  )) as Record<string, unknown>;

  return {
    remainingRequests: pickNumber(
      data,
      'remainingRequests',
      'remaining',
      'remainingCount',
      'quotaRemaining',
    ),
    monthlyLimit: pickNumber(
      data,
      'monthlyLimit',
      'limit',
      'monthlyQuota',
    ),
    resetAt: pickString(data, 'resetAt', 'reset', 'resetsAt'),
  };
}