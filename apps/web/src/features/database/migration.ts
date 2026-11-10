/**
 * One-shot import of browser-era data into the embedded SQLite database.
 * ---------------------------------------------------------------------------
 * MODULE_ARCHITECTURE.md §11.4: on first desktop boot, the user data that used
 * to live in browser storage (localStorage for the timeline + profile,
 * IndexedDB for watch history / sessions / mining archive) is imported into the
 * embedded `entei.db` in a single transaction, after which SQLite is the single
 * source of truth on desktop.
 *
 * Safety properties:
 * - Desktop only. Outside Tauri this is a no-op (the browser build keeps its
 *   localStorage / IndexedDB stores).
 * - Idempotent. A `migration:v1:completed` flag in the key/value store gates the
 *   run, so it happens at most once per database file. `ensureDatabaseMigrated()`
 *   memoizes the promise so concurrent readers (feed, profile) share one run.
 * - Non-destructive. The browser stores are left in place as a read-only
 *   fallback; they are simply no longer read on desktop once the flag is set.
 *   Nothing is deleted, so a failed import loses nothing.
 * - Fail-soft. Any error (missing store, unreadable row) is swallowed and the
 *   flag is left unset, so a later boot can retry. The app still boots from the
 *   browser stores in the meantime.
 * ---------------------------------------------------------------------------
 */

import type { TimelineComment, TimelinePost } from '@/features/timeline/timeline-store';
import type { WatchHistoryRecord } from '@/features/player/watch-history/types';
import type { WatchSessionRecord } from '@/features/player/watch-sessions/types';
import {
  isTauri,
  dbKvGet,
  dbKvSet,
  dbMigrateV1,
  type DbMiningArchiveItem,
  type DbTimelinePost,
  type DbUserProfile,
  type DbWatchHistoryItem,
  type DbWatchSessionItem,
} from '@/features/player/tauri-bridge';
import { openTrackerDB } from '@/features/player/tracker/db';

/** Key/value flag marking a completed v1 import. */
const MIGRATION_FLAG = 'migration:v1:completed';

/** Where the liked-id array lives in the key/value store (matches timeline-store). */
const LIKED_IDS_KV_KEY = 'timeline:likedIds';

/* ------------------------------------------------------------------------ */
/* Small readers for the legacy browser stores                              */
/* ------------------------------------------------------------------------ */

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function idbGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve) => {
    try {
      const request = db
        .transaction(storeName, 'readonly')
        .objectStore(storeName)
        .getAll();
      request.onsuccess = () => resolve((request.result as T[]) ?? []);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** Open the legacy mining-history DB read-only; null when unavailable. */
function openMiningHistoryDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const request = indexedDB.open('entei-mining-history', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Conversions (legacy shapes → SQLite rows)                                */
/* ------------------------------------------------------------------------ */

/** Derive a `@handle` from a display name (kept local to avoid an import cycle). */
function toHandle(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return `@${slug.length > 0 ? slug : 'entei'}`;
}

function timelinePostToDb(post: TimelinePost): DbTimelinePost {
  return {
    id: post.id,
    authorHandle: post.authorHandle,
    authorName: post.authorName,
    authorAvatar: post.avatar,
    content: post.message,
    createdAt: post.createdAt,
    likes: 0,
    likedByMe: false,
    replyCount: 0,
    parentId: null,
  };
}

/** A stored reply becomes a `timeline_posts` row carrying its parent id. */
function commentToDb(comment: TimelineComment): DbTimelinePost {
  return {
    id: comment.id,
    authorHandle: comment.author.handle,
    authorName: comment.author.name,
    authorAvatar: comment.author.avatar,
    content: comment.text,
    createdAt: comment.createdAt,
    likes: 0,
    likedByMe: false,
    replyCount: 0,
    parentId: comment.postId,
  };
}

/** TMDB id is a string in the browser record but an integer column in SQLite. */
function tmdbToDb(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function watchHistoryToDb(record: WatchHistoryRecord): DbWatchHistoryItem {
  return {
    mediaId: record.mediaId,
    title: record.title,
    titleNative: record.titleNative ?? null,
    episode: record.episode ?? null,
    source: record.source,
    watchedAt: record.watchedAt,
    duration: null,
    position: null,
    posterUrl: record.posterUrl ?? null,
    posterStatus: record.posterStatus ?? null,
    anilistId: record.anilistId ?? null,
    tmdbId: tmdbToDb(record.tmdbId),
  };
}

function watchSessionToDb(
  record: WatchSessionRecord,
  title: string,
): DbWatchSessionItem {
  return {
    id: record.sessionId,
    mediaId: record.mediaId,
    title,
    startTime: record.startedAt,
    endTime: record.endedAt,
    duration: record.watchMs,
    cuesMined: record.minedSentences.length,
    minedSentences: [...record.minedSentences],
  };
}

/**
 * Mining entries carry no timestamp (they were ordered by an auto-increment
 * key), so synthetic ascending times are assigned that preserve the original
 * newest-first ordering.
 */
function miningToDb(
  entry: { id: string; filename: string; rangeStart: number; rangeEnd: number; sentence: string },
  createdAt: number,
): DbMiningArchiveItem {
  return {
    id: entry.id,
    mediaFilename: entry.filename,
    createdAt,
    sentence: entry.sentence,
    word: null,
    rangeStart: entry.rangeStart,
    rangeEnd: entry.rangeEnd,
  };
}

/* ------------------------------------------------------------------------ */
/* The migration                                                            */
/* ------------------------------------------------------------------------ */

async function gatherAndImport(): Promise<boolean> {
  // --- localStorage: timeline + profile ---------------------------------
  const timeline = readJson<{ posts?: TimelinePost[]; likedIds?: string[]; comments?: TimelineComment[] }>(
    'entei.timeline.v1',
  );
  const posts: DbTimelinePost[] = [];
  const kv: Array<{ key: string; value: string }> = [];
  if (timeline) {
    for (const post of timeline.posts ?? []) {
      if (typeof post?.id === 'string') posts.push(timelinePostToDb(post));
    }
    for (const comment of timeline.comments ?? []) {
      if (typeof comment?.id === 'string' && typeof comment?.postId === 'string') {
        posts.push(commentToDb(comment));
      }
    }
    if (Array.isArray(timeline.likedIds)) {
      kv.push({
        key: LIKED_IDS_KV_KEY,
        value: JSON.stringify(timeline.likedIds),
      });
    }
  }

  const profileRow = readJson<{ name?: string; bio?: string; avatar?: string }>(
    'entei.profile.v1',
  );
  let profile: DbUserProfile | null = null;
  if (profileRow && typeof profileRow.name === 'string') {
    profile = {
      handle: toHandle(profileRow.name),
      displayName: profileRow.name,
      bio: typeof profileRow.bio === 'string' && profileRow.bio.length > 0 ? profileRow.bio : null,
      avatarUrl: typeof profileRow.avatar === 'string' ? profileRow.avatar : null,
      updatedAt: Date.now(),
    };
  }

  // --- IndexedDB: watch history + sessions (immersion-tracker) ----------
  const watchHistory: DbWatchHistoryItem[] = [];
  const watchSessions: DbWatchSessionItem[] = [];
  const trackerDb = await openTrackerDB();
  if (trackerDb) {
    const historyRecords = await idbGetAll<WatchHistoryRecord>(trackerDb, 'watch_history');
    const titleByMedia = new Map<string, string>();
    for (const record of historyRecords) {
      if (typeof record?.mediaId !== 'string') continue;
      watchHistory.push(watchHistoryToDb(record));
      titleByMedia.set(record.mediaId, record.title);
    }
    const sessionRecords = await idbGetAll<WatchSessionRecord>(trackerDb, 'watch_sessions');
    for (const record of sessionRecords) {
      if (typeof record?.sessionId !== 'string') continue;
      watchSessions.push(
        watchSessionToDb(record, titleByMedia.get(record.mediaId) ?? record.mediaId),
      );
    }
  }

  // --- IndexedDB: mining archive (entei-mining-history) -----------------
  const miningArchive: DbMiningArchiveItem[] = [];
  const miningDb = await openMiningHistoryDb();
  if (miningDb) {
    const entries = await idbGetAll<{
      id: string;
      filename: string;
      rangeStart: number;
      rangeEnd: number;
      sentence: string;
    }>(miningDb, 'entries-v2');
    const base = Date.now() - entries.length;
    entries.forEach((entry, index) => {
      if (typeof entry?.id !== 'string') return;
      miningArchive.push(miningToDb(entry, base + index));
    });
  }

  await dbMigrateV1({ posts, watchHistory, watchSessions, miningArchive, profile, kv });
  return true;
}

/**
 * Run the v1 import once. Safe to call repeatedly: the completion flag makes it
 * a no-op after the first success, and `ensureDatabaseMigrated` memoizes the
 * in-flight promise so concurrent callers share a single run.
 */
export async function runDatabaseMigrationV1(): Promise<void> {
  if (!isTauri()) return;
  try {
    const done = await dbKvGet(MIGRATION_FLAG);
    if (done === 'true') return;
    await gatherAndImport();
    await dbKvSet(MIGRATION_FLAG, 'true');
  } catch {
    // Fail-soft: leave the flag unset so a later boot can retry. The app keeps
    // running from the browser stores until the import succeeds.
  }
}

let migrationPromise: Promise<void> | null = null;

/**
 * Kick off (once) and await the v1 import. Store reads on desktop await this so
 * the very first render after a migration already sees the imported rows.
 */
export function ensureDatabaseMigrated(): Promise<void> {
  if (migrationPromise === null) {
    migrationPromise = runDatabaseMigrationV1().catch(() => {});
  }
  return migrationPromise;
}
