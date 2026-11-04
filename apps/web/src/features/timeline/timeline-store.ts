/**
 * Home timeline store — local-first community posts.
 * ---------------------------------------------------------------------------
 * Phase 1 of `docs/FREENET_SOCIAL_TIMELINE.md` ships the Home social timeline as
 * a UI-first surface: the feed renders seeded community posts plus whatever the
 * local user publishes, and everything the user writes stays on the device.
 *
 * Design:
 * - Only *user-created* posts and replies are persisted (seed posts and seed
 *   replies live in code so copy changes propagate); likes are persisted as post
 *   ids.
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

/** A post or comment author as rendered in the feed. */
export interface TimelineAuthor {
  name: string;
  handle: string;
  /** Bundled `/avatars/N.webp` path or a processed image data URL. */
  avatar: string;
}

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

/** A reply on a post's detail view (phase 1.5 comments thread). */
export interface TimelineComment {
  id: string;
  /** Id of the post this reply belongs to. */
  postId: string;
  author: TimelineAuthor;
  text: string;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
}

export interface TimelineState {
  schemaVersion: typeof TIMELINE_SCHEMA_VERSION;
  /** Posts created on this device, newest first. */
  posts: TimelinePost[];
  /** Ids of posts the user liked (seeds and local posts alike). */
  likedIds: string[];
  /** Replies written on this device, oldest first per post. */
  comments: TimelineComment[];
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

/**
 * Baseline like counts for the seeded posts, so the feed shows plausible
 * engagement instead of a wall of zeroes. Only the *seeds* carry a baseline:
 * a post written on this device starts at 0 and grows by the user's own like.
 */
export const TIMELINE_SEED_LIKE_COUNTS: Readonly<Record<string, number>> = {
  'seed-1': 5,
  'seed-2': 12,
  'seed-3': 42,
  'seed-4': 8,
};

/**
 * Seeded replies so the thread views feel alive on first load. Timestamps are
 * relative to page load, like the seed posts, so a thread never shows a stale
 * "2 years ago" on a reply either.
 */
export const TIMELINE_SEED_COMMENTS: readonly TimelineComment[] = [
  {
    id: 'seed-c1',
    postId: 'seed-1',
    author: { name: 'Yuki-H2M8', handle: '@yuki_h2m8', avatar: '/avatars/7.webp' },
    text: '7割拾えてたら十分すごい！フリーレンは話す速度がわりとゆっくりなので、通しで観るのは正解だと思う。',
    createdAt: SEED_BASE - 3 * MINUTE,
  },
  {
    id: 'seed-c2',
    postId: 'seed-1',
    author: { name: 'Ren-K7C5', handle: '@ren_k7c5', avatar: '/avatars/14.webp' },
    text: '同じ話を字幕あり→なしで2周すると、2周目で一気に聞こえる量が増える気がします。',
    createdAt: SEED_BASE - 2 * MINUTE,
  },
  {
    id: 'seed-c3',
    postId: 'seed-2',
    author: { name: 'Sora-T4P1', handle: '@sora_t4p1', avatar: '/avatars/11.webp' },
    text: '採掘した表現が翌話で出てくるの、本当に嬉しいですよね。脳が「必要だ」と判定した証拠。',
    createdAt: SEED_BASE - 30 * MINUTE,
  },
  {
    id: 'seed-c4',
    postId: 'seed-2',
    author: { name: 'Kitsune-A9K2', handle: '@kitsune_a9k2', avatar: '/avatars/3.webp' },
    text: '「手を焼く」いい表現ですね。自分も次の視聴で意識して拾ってみます。',
    createdAt: SEED_BASE - 20 * MINUTE,
  },
  {
    id: 'seed-c5',
    postId: 'seed-3',
    author: { name: 'Ren-K7C5', handle: '@ren_k7c5', avatar: '/avatars/14.webp' },
    text: '通勤イマージョン、継続のハードルが低いのが強いですよね。自分は駅までの往復だけやってます。',
    createdAt: SEED_BASE - 2 * HOUR,
  },
  {
    id: 'seed-c6',
    postId: 'seed-4',
    author: { name: 'Yuki-H2M8', handle: '@yuki_h2m8', avatar: '/avatars/7.webp' },
    text: 'Nadeshiko の例文は語彙の幅が広がるので、採掘前の下見にちょうどいいですよね。',
    createdAt: SEED_BASE - 1 * DAY,
  },
];

export const EMPTY_TIMELINE_STATE: TimelineState = {
  schemaVersion: TIMELINE_SCHEMA_VERSION,
  posts: [],
  likedIds: [],
  comments: [],
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

function isTimelineAuthor(value: unknown): value is TimelineAuthor {
  if (typeof value !== 'object' || value === null) return false;
  const author = value as Record<string, unknown>;
  return (
    typeof author.name === 'string' &&
    typeof author.handle === 'string' &&
    typeof author.avatar === 'string'
  );
}

function isTimelineComment(value: unknown): value is TimelineComment {
  if (typeof value !== 'object' || value === null) return false;
  const comment = value as Record<string, unknown>;
  return (
    typeof comment.id === 'string' &&
    comment.id.length > 0 &&
    typeof comment.postId === 'string' &&
    comment.postId.length > 0 &&
    isTimelineAuthor(comment.author) &&
    typeof comment.text === 'string' &&
    comment.text.length > 0 &&
    comment.text.length <= TIMELINE_POST_MAX_LENGTH &&
    typeof comment.createdAt === 'number' &&
    Number.isFinite(comment.createdAt)
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
  // `comments` joined the schema in phase 1.5; a payload written before it
  // existed is still valid and simply has no replies yet.
  const comments = Array.isArray(state.comments)
    ? state.comments.filter(isTimelineComment)
    : [];
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    posts,
    likedIds,
    comments,
  };
}

/** Fresh empty state (a new object each call, so callers cannot share it). */
function emptyTimelineState(): TimelineState {
  return { schemaVersion: TIMELINE_SCHEMA_VERSION, posts: [], likedIds: [], comments: [] };
}

/** Read the persisted timeline state; falls back to empty on any failure. */
export function readTimelineState(): TimelineState {
  try {
    const raw = localStorage.getItem(TIMELINE_STORAGE_KEY);
    if (raw === null) return emptyTimelineState();
    const parsed = parseTimelineState(JSON.parse(raw) as unknown);
    if (parsed === null) return emptyTimelineState();
    return parsed;
  } catch {
    return emptyTimelineState();
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

/** Trim and clamp a reply draft to the same limit as a post. */
export function clampTimelineComment(value: string): string {
  return clampTimelineMessage(value);
}

let postCounter = 0;
let commentCounter = 0;

/** Build a new local reply for `postId`, or null when the draft is empty. */
export function createTimelineComment(
  postId: string,
  text: string,
  author: TimelineAuthor,
  now: number = Date.now(),
): TimelineComment | null {
  const body = clampTimelineComment(text);
  if (body.length === 0) return null;
  commentCounter += 1;
  return {
    id: `reply-${now.toString(36)}-${commentCounter}`,
    postId,
    author: { name: author.name, handle: author.handle, avatar: author.avatar },
    text: body,
    createdAt: now,
  };
}

/**
 * Every reply on `postId`, oldest first — the reading order of a thread.
 *
 * Local replies are merged with the seeded ones and sorted by `createdAt`, so a
 * reply written on this device slots into the conversation by its real time
 * instead of always landing at the bottom.
 */
export function mergeTimelineComments(
  localComments: readonly TimelineComment[],
  postId: string,
): TimelineComment[] {
  return [...localComments, ...TIMELINE_SEED_COMMENTS]
    .filter((comment) => comment.postId === postId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Reply count for a post, seeds included (used by the action row). */
export function countTimelineComments(
  localComments: readonly TimelineComment[],
  postId: string,
): number {
  return mergeTimelineComments(localComments, postId).length;
}

/**
 * Displayed like count: the seed baseline (0 for local posts) plus this
 * device's own like. The count is derived, never persisted, so the stored
 * `likedIds` stays the single source of truth for the pressed state.
 */
export function countTimelineLikes(postId: string, liked: boolean): number {
  const base = TIMELINE_SEED_LIKE_COUNTS[postId] ?? 0;
  return base + (liked ? 1 : 0);
}

/**
 * Compact metric label for the action counts: `0` renders nothing (an empty
 * label keeps the action row quiet), 1–999 renders the number, thousands and
 * millions collapse to one decimal with `K` / `M` and a stripped `.0`.
 */
export function formatMetricCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  const compact = (value: number): string =>
    value.toFixed(1).replace(/\.0$/, '');
  if (count < 1_000) return String(Math.round(count));
  const thousands = count / 1_000;
  // `999_999` rounds to `1000.0K`, which reads as a broken label; it rolls
  // over to `1M` instead.
  if (thousands < 999.95) return `${compact(thousands)}K`;
  return `${compact(count / 1_000_000)}M`;
}

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

/**
 * Merge seed posts with local posts, newest first.
 *
 * The feed order is *always* strictly sorted by `createdAt` descending, so a
 * post written on this device slots in by its real timestamp instead of by
 * array position (a device post from yesterday belongs below today's seeds).
 * `Array.prototype.sort` is stable, so posts that share a timestamp keep their
 * insertion order — local posts first, seeds after.
 */
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
