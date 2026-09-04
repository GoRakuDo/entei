/**
 * nadeshiko-client — api.nadeshiko.co BYOK fetch wrapper.
 * ---------------------------------------------------------------------------
 * Design: docs/NADESHIKO_INTEGRATION.md §2.
 * Conforms to: https://nadeshiko.co/docs/api/openapi.yaml (v2.4.12)
 *
 * - Browser-direct calls (CORS verified live: POST /v1/search and
 *   GET /v1/media/segments/{id}/context return `Access-Control-Allow-Origin: *`
 *   on both preflight and actual responses, so the browser can read them).
 * - `GET /v1/user/me` is the one endpoint whose actual response does NOT
 *   carry the ACAO header (preflight returns 200 with `allow: GET, HEAD` but
 *   no ACAO). Browser fetches of /user/me are CORS-blocked even on success
 *   and on 401. We surface that as a `network` error in the UI; we do NOT
 *   build a proxy.
 * - API key passed per-call; the module never stores it.
 * - 150 req / 60s rate limit per the spec (`quota.burst.max: 150, windowMs:
 *   60000` in the live /user/me response). The 429 body distinguishes
 *   RATE_LIMIT_EXCEEDED (per-minute) from QUOTA_EXCEEDED (monthly) via the
 *   `code` field.
 * - 5,000 req / month per the spec (`quota.limit: 5000` and the
 *   `X-Monthly-Quota-*` response headers).
 * - Errors: typed `NadeshikoErrorKind`. AbortSignal threaded everywhere.
 * - Defensive field parsing: spec is the source of truth for primary keys
 *   (`publicId`, `textJa.content`, `textEn.content`, `startTimeMs`,
 *   `includes.media[id].nameJa` / `nameEn` / `nameRomaji`). We try the
 *   spec names first; fallbacks for plausible alternates are kept as
 *   insurance against future renames.
 * ---------------------------------------------------------------------------
 */

const API_BASE = 'https://api.nadeshiko.co/v1';

/* ------------------------------------------------------------------------ */
/* Error model                                                              */
/* ------------------------------------------------------------------------ */

export type NadeshikoErrorKind =
  | 'invalid-key'
  | 'rate-limited'
  | 'quota-exceeded'
  | 'network'
  | 'invalid-response';

export interface NadeshikoError extends Error {
  kind: NadeshikoErrorKind;
  /** Retry-After seconds (rate-limited only; spec doesn't set this on quota). */
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
/* Response shapes (per OpenAPI v2.4.12)                                    */
/* ------------------------------------------------------------------------ */

export interface NadeshikoSegment {
  /** Stable identifier for `getSegmentContext` (= spec `Segment.publicId`). */
  id: string;
  /** 作品名 / anime-drama work name. */
  workName: string;
  /** セリフ / Japanese line. */
  line: string;
  /** English translation (may be empty for some entries). */
  englishTranslation?: string;
  /** Spanish translation (may be empty for some entries). */
  spanishTranslation?: string;
  /** Segment start time, seconds (derived from spec's `startTimeMs` / 1000). */
  timestampSeconds?: number;
  /** Raw timestamp display string (e.g. "01:23"). Derived if not provided. */
  timestampLabel?: string;
  /** Episode number this segment belongs to (0 for movies/specials). */
  episode?: number;
  /** Episode-relative position of the segment. */
  position?: number;
  /** Spec's `mediaPublicId` — the canonical id of the work. */
  mediaPublicId?: string;
  /** Highlighted Japanese line with `<mark>` tags, when returned from search. */
  highlightJa?: string;
  /** Highlighted English line with `<mark>` tags, when matched in this language. */
  highlightEn?: string;
  /** Media URLs from spec: image / audio / video. */
  urls?: {
    imageUrl?: string;
    audioUrl?: string;
    videoUrl?: string;
  };
}

export interface NadeshikoSegmentContextResponse {
  /** The list of segments around the target (the spec returns a flat
   *  segments[]; the first entry with `publicId === requestedId` is the
   *  centre, the rest are surrounding context). */
  center: NadeshikoSegment;
  /** Lines surrounding the target (does not include the target itself). */
  surrounding: NadeshikoSegment[];
}

/* ------------------------------------------------------------------------ */
/* Internal helpers                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Defensive field pickers — the spec is the source of truth, so we try the
 * spec names first and only fall back to plausible alternates for resilience
 * against future field renames.
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

/** Format startTimeMs (or seconds) into a `M:SS` / `H:MM:SS` display string. */
function formatTimestampLabel(
  startTimeMs?: number,
  seconds?: number,
): string | undefined {
  const total =
    typeof startTimeMs === 'number'
      ? Math.max(0, Math.floor(startTimeMs / 1000))
      : typeof seconds === 'number'
        ? Math.max(0, Math.floor(seconds))
        : undefined;
  if (total === undefined) return undefined;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Parse a Segment from the spec's flat structure. */
function normalizeSegment(
  raw: unknown,
  workNameByMediaId: Map<string, string> = new Map(),
): NadeshikoSegment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // Spec: publicId is required. Fall back to a couple of plausible names
  // for resilience, but the spec key is the primary path.
  const id = pickString(r, 'publicId', 'id', 'segmentId');
  if (!id) return null;

  // Spec nests text under textJa.content, textEn.content, textEs.content.
  const textJa = (r.textJa ?? {}) as Record<string, unknown>;
  const textEn = (r.textEn ?? {}) as Record<string, unknown>;
  const textEs = (r.textEs ?? {}) as Record<string, unknown>;
  const line = pickString(textJa, 'content', 'text') ?? '';
  const englishTranslation = pickString(textEn, 'content');
  const spanishTranslation = pickString(textEs, 'content');

  // startTimeMs is the spec's start-of-segment in ms (e.g. 2007255).
  const startTimeMs = pickNumber(r, 'startTimeMs', 'startTime');
  const timestampSeconds =
    typeof startTimeMs === 'number'
      ? startTimeMs / 1000
      : pickNumber(r, 'timestampSeconds', 'startSeconds');
  const timestampLabel = formatTimestampLabel(
    typeof startTimeMs === 'number' ? startTimeMs : undefined,
    timestampSeconds,
  );

  // workName comes from includes.media[mediaPublicId].nameJa || nameEn.
  const mediaPublicId = pickString(r, 'mediaPublicId');
  const workName = mediaPublicId
    ? (workNameByMediaId.get(mediaPublicId) ?? '')
    : '';

  const urls = r.urls as Record<string, unknown> | undefined;
  const seg: NadeshikoSegment = {
    id,
    workName,
    line,
    englishTranslation,
    spanishTranslation,
    timestampSeconds,
    timestampLabel,
  };
  if (typeof r.episode === 'number') seg.episode = r.episode;
  if (typeof r.position === 'number') seg.position = r.position;
  if (mediaPublicId) seg.mediaPublicId = mediaPublicId;
  const highlightJa = pickString(textJa, 'highlight');
  if (highlightJa) seg.highlightJa = highlightJa;
  const highlightEn = pickString(textEn, 'highlight');
  if (highlightEn) seg.highlightEn = highlightEn;
  if (urls && typeof urls === 'object') {
    seg.urls = {
      imageUrl: pickString(urls, 'imageUrl'),
      audioUrl: pickString(urls, 'audioUrl'),
      videoUrl: pickString(urls, 'videoUrl'),
    };
  }
  return seg;
}

/** Build a mediaPublicId → workName lookup from `includes.media`. */
function buildWorkNameMap(includes: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!includes || typeof includes !== 'object') return map;
  const obj = includes as Record<string, unknown>;
  const media = obj.media;
  if (!media || typeof media !== 'object') return map;
  for (const [publicId, raw] of Object.entries(
    media as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    // Prefer the Japanese name (matches what the spec describes as
    // "Original Japanese name of the media"), then English, then Romaji.
    const name = pickString(m, 'nameJa', 'nameEn', 'nameRomaji');
    if (name) map.set(publicId, name);
  }
  return map;
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
    // The spec's 429 body has `code: RATE_LIMIT_EXCEEDED` or `QUOTA_EXCEEDED`.
    // search + context endpoints carry ACAO so the body is readable; we
    // clone-then-parse to distinguish the two kinds. Anything we can't parse
    // (no body, non-JSON, unexpected shape) defaults to `rate-limited` since
    // that's the more common 60-second burst case.
    const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
    let kind: 'rate-limited' | 'quota-exceeded' = 'rate-limited';
    try {
      const body = (await res.clone().json()) as { code?: unknown } | null;
      if (body && typeof body === 'object' && body.code === 'QUOTA_EXCEEDED') {
        kind = 'quota-exceeded';
      }
    } catch {
      // No body or non-JSON — keep the default.
    }
    throw makeError(
      kind,
      kind === 'quota-exceeded'
        ? 'Monthly quota exceeded'
        : 'Rate limit exceeded',
      {
        status: 429,
        ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
      },
    );
  }

  if (!res.ok) {
    throw makeError('network', `Nadeshiko API error ${res.status}`, {
      status: res.status,
    });
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

export type SearchSortMode =
  'RELEVANCE' | 'ASC' | 'DESC' | 'TIME_ASC' | 'TIME_DESC' | 'RANDOM';

export interface NadeshikoSearchOptions {
  /** Max results (1-50; default 10 per spec). */
  take?: number;
  /** Sort mode (default RELEVANCE per spec). */
  mode?: SearchSortMode;
  /** Seed for deterministic RANDOM mode. Ignored unless mode === 'RANDOM'. */
  seed?: number;
  /** Exact-match phrase (default false per spec). */
  exactMatch?: boolean;
  /** Opaque cursor for pagination. Default undefined (first page). */
  cursor?: string;
  /** Include expansions (currently only `media`). */
  include?: 'media'[];
}

export async function searchNadeshikoSegments(
  apiKey: string,
  query: string,
  options: NadeshikoSearchOptions = {},
  signal?: AbortSignal,
): Promise<NadeshikoSegment[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  // Spec: `query` is an object — omit to do a queryless browse, set
  // `search` for the query string, optionally set `exactMatch: true`.
  // Note: the OLD client sent `{query: trimmed, exactMatch, take, mode,
  // cursor: null}` as a flat object, which the server accepted loosely
  // but the v2.4.12 spec requires the nested shape below.
  const body: Record<string, unknown> = {
    query: {
      search: trimmed,
      ...(options.exactMatch !== undefined
        ? { exactMatch: options.exactMatch }
        : {}),
    },
    take: options.take ?? 10,
    sort: {
      mode: options.mode ?? 'RELEVANCE',
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    },
  };
  if (options.cursor !== undefined) body.cursor = options.cursor;
  if (options.include && options.include.length > 0) {
    body.include = options.include;
  }

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

  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  const segments = obj.segments;
  if (!Array.isArray(segments)) return [];

  const workNameByMediaId = buildWorkNameMap(obj.includes);

  return segments
    .map((s) => normalizeSegment(s, workNameByMediaId))
    .filter((s): s is NadeshikoSegment => s !== null);
}

export async function getNadeshikoSegmentContext(
  apiKey: string,
  segmentId: string,
  signal?: AbortSignal,
  options: { take?: number } = {},
): Promise<NadeshikoSegmentContextResponse> {
  // The spec accepts `include[]` (array form) and `take` (1-30, default 3).
  // We default to including media so the centre + surrounding can be
  // labelled with the work name without a second round-trip. The endpoint
  // takes the segment's own publicId; the centre of the returned window
  // is the segment whose publicId matches.
  const qs = new URLSearchParams({ include: 'media' });
  if (options.take !== undefined) qs.set('take', String(options.take));
  const data = await apiRequest(
    apiKey,
    `/media/segments/${encodeURIComponent(segmentId)}/context?${qs.toString()}`,
    { method: 'GET' },
    signal,
  );

  if (!data || typeof data !== 'object') {
    return {
      center: { id: segmentId, workName: '', line: '' },
      surrounding: [],
    };
  }
  const obj = data as Record<string, unknown>;
  const segments = obj.segments;
  const workNameByMediaId = buildWorkNameMap(obj.includes);

  // Spec returns a flat list. The centre is the entry with publicId ===
  // segmentId; surrounding is the rest, ordered as the server returned
  // them. We don't try to re-order to before/after — the UI shows them
  // in the API's order, which already separates them by time.
  const all = Array.isArray(segments)
    ? segments
        .map((s) => normalizeSegment(s, workNameByMediaId))
        .filter((s): s is NadeshikoSegment => s !== null)
    : [];

  const centerIdx = all.findIndex((s) => s.id === segmentId);
  if (centerIdx === -1) {
    // Spec returned segments but none matched. Synthesise a placeholder
    // from the first entry so the UI has something to display. The rest
    // go into surrounding — slice(1) drops the first entry which we
    // already used as the centre fallback, preserving the
    // "surrounding does not include the target itself" contract.
    const fallback = all[0] ?? { id: segmentId, workName: '', line: '' };
    return { center: fallback, surrounding: all.slice(1) };
  }
  const center = all[centerIdx]!;
  const surrounding = [...all.slice(0, centerIdx), ...all.slice(centerIdx + 1)];
  return { center, surrounding };
}
