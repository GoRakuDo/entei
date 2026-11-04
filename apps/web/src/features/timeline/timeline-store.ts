/**
 * Home timeline store — local-first community posts.
 * ---------------------------------------------------------------------------
 * Phase 1 of `docs/FREENET_SOCIAL_TIMELINE.md` ships the Home social timeline as
 * a UI-first surface: the feed renders seeded community posts plus whatever the
 * local user publishes, and everything the user writes stays on the device.
 *
 * Design:
 * - Only *user-created* posts are persisted (seed posts live in code so copy
 *   changes propagate); likes are persisted as post ids.
 * - Versioned key (`entei.timeline.v1`) and exception-safe: storage failures
 *   never throw to the caller — the in-memory feed stays usable.
 * - No network, no account, no media. Nothing leaves the browser.
 * ---------------------------------------------------------------------------
 */

/** localStorage key (versioned, matches the other Entei preference stores). */
export const TIMELINE_STORAGE_KEY = 'entei.timeline.v1';

/** Current schema version. Bump when the persisted shape changes. */
export const TIMELINE_SCHEMA_VERSION = 1;

/** Maximum characters per post (docs/FREENET_SOCIAL_TIMELINE.md §2.2.3). */
export const TIMELINE_POST_MAX_LENGTH = 360;

export interface TimelinePost {
  id: string;
  authorName: string;
  authorHandle: string;
  /** Bundled `/avatars/N.webp` path or a processed image data URL. */
  avatar: string;
  message: string;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
}

export interface TimelineState {
  schemaVersion: typeof TIMELINE_SCHEMA_VERSION;
  /** Posts created on this device, newest first. */
  posts: TimelinePost[];
  /** Ids of posts the user liked (seeds and local posts alike). */
  likedIds: string[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Timestamp base for the seeded feed, captured once per page load. */
const SEED_BASE = Date.now();

/**
 * Seeded community posts so the feed is alive on first load. Timestamps are
 * relative to page load, so the feed never shows a stale "3 years ago".
 */
export const TIMELINE_SEED_POSTS: readonly TimelinePost[] = [
  {
    id: 'seed-1',
    authorName: 'Kitsune-A9K2',
    authorHandle: '@kitsune_a9k2',
    avatar: '/avatars/3.webp',
    message:
      '「葬送のフリーレン」1話を字幕なしで通しで観た。まだ7割くらいしか拾えないけど、先週より確実に聞こえる単語が増えてる気がする。',
    createdAt: SEED_BASE - 4 * MINUTE,
  },
  {
    id: 'seed-2',
    authorName: 'Yuki-H2M8',
    authorHandle: '@yuki_h2m8',
    avatar: '/avatars/7.webp',
    message:
      '今日の採掘：たった今 Anki に放り込んだ「手を焼く」が、次のエピソードで早速出てきた。こういう瞬間が一番うれしい。',
    createdAt: SEED_BASE - 38 * MINUTE,
  },
  {
    id: 'seed-3',
    authorName: 'Sora-T4P1',
    authorHandle: '@sora_t4p1',
    avatar: '/avatars/11.webp',
    message:
      '通勤中の音声イマージョン、30分だけでも1か月続けたら耳が変わる。地味だけど一番コスパがいい学習法だと思う。',
    createdAt: SEED_BASE - 3 * HOUR,
  },
  {
    id: 'seed-4',
    authorName: 'Ren-K7C5',
    authorHandle: '@ren_k7c5',
    avatar: '/avatars/14.webp',
    message:
      'Nadeshiko で例文を探すと、自分では絶対に選ばない言い回しに出会える。i+1 の幅が広がる感じがして好き。',
    createdAt: SEED_BASE - 2 * DAY,
  },
];

export const EMPTY_TIMELINE_STATE: TimelineState = {
  schemaVersion: TIMELINE_SCHEMA_VERSION,
  posts: [],
  likedIds: [],
};

function isTimelinePost(value: unknown): value is TimelinePost {
  if (typeof value !== 'object' || value === null) return false;
  const post = value as Record<string, unknown>;
  return (
    typeof post.id === 'string' &&
    post.id.length > 0 &&
    typeof post.authorName === 'string' &&
    typeof post.authorHandle === 'string' &&
    typeof post.avatar === 'string' &&
    typeof post.message === 'string' &&
    post.message.length <= TIMELINE_POST_MAX_LENGTH &&
    typeof post.createdAt === 'number' &&
    Number.isFinite(post.createdAt)
  );
}

function parseTimelineState(value: unknown): TimelineState | null {
  if (typeof value !== 'object' || value === null) return null;
  const state = value as Record<string, unknown>;
  if (state.schemaVersion !== TIMELINE_SCHEMA_VERSION) return null;
  if (!Array.isArray(state.posts) || !Array.isArray(state.likedIds)) {
    return null;
  }
  // Resilient: a single corrupted post must not discard the whole feed.
  const posts = state.posts.filter(isTimelinePost);
  const likedIds = state.likedIds.filter(
    (id): id is string => typeof id === 'string',
  );
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    posts,
    likedIds,
  };
}

/** Read the persisted timeline state; falls back to empty on any failure. */
export function readTimelineState(): TimelineState {
  try {
    const raw = localStorage.getItem(TIMELINE_STORAGE_KEY);
    if (raw === null) return { ...EMPTY_TIMELINE_STATE, posts: [], likedIds: [] };
    const parsed = parseTimelineState(JSON.parse(raw) as unknown);
    if (parsed === null) {
      return { ...EMPTY_TIMELINE_STATE, posts: [], likedIds: [] };
    }
    return parsed;
  } catch {
    return { ...EMPTY_TIMELINE_STATE, posts: [], likedIds: [] };
  }
}

/** Persist the timeline state; storage failures are safe to ignore here. */
export function writeTimelineState(state: TimelineState): void {
  const parsed = parseTimelineState(state);
  if (parsed === null) return;
  try {
    localStorage.setItem(TIMELINE_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Storage may be unavailable or full; keep the in-memory feed usable.
  }
}

/** Trim and clamp a draft message to the post limit. */
export function clampTimelineMessage(value: string): string {
  return value.trim().slice(0, TIMELINE_POST_MAX_LENGTH);
}

let postCounter = 0;

/** Build a new local post from the composer draft and the device profile. */
export function createTimelinePost(
  message: string,
  author: { name: string; handle: string; avatar: string },
  now: number = Date.now(),
): TimelinePost | null {
  const text = clampTimelineMessage(message);
  if (text.length === 0) return null;
  postCounter += 1;
  return {
    id: `local-${now.toString(36)}-${postCounter}`,
    authorName: author.name,
    authorHandle: author.handle,
    avatar: author.avatar,
    message: text,
    createdAt: now,
  };
}

/** Derive a display handle from the local profile name (`@kitsune_a9k2`). */
export function deriveHandle(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return `@${slug.length > 0 ? slug : 'entei'}`;
}

/** Merge seed posts with local posts, newest first. */
export function mergeTimelinePosts(
  localPosts: readonly TimelinePost[],
): TimelinePost[] {
  return [...localPosts, ...TIMELINE_SEED_POSTS].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
}

const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();

function relativeTimeFormatter(locale: string): Intl.RelativeTimeFormat {
  const cached = relativeTimeFormatters.get(locale);
  if (cached !== undefined) return cached;
  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: 'auto',
    style: 'narrow',
  });
  relativeTimeFormatters.set(locale, formatter);
  return formatter;
}

/**
 * Localized "time ago" label via the platform `Intl.RelativeTimeFormat`, so no
 * translation keys are needed for the unit names.
 */
export function formatRelativeTime(
  createdAt: number,
  now: number,
  locale: string,
): string {
  const diff = createdAt - now;
  const abs = Math.abs(diff);
  let formatter: Intl.RelativeTimeFormat;
  try {
    formatter = relativeTimeFormatter(locale);
  } catch {
    formatter = relativeTimeFormatter('id');
  }

  if (abs < MINUTE) return formatter.format(0, 'second');
  if (abs < HOUR) return formatter.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return formatter.format(Math.round(diff / HOUR), 'hour');
  return formatter.format(Math.round(diff / DAY), 'day');
}
