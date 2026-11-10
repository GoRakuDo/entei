import { openTrackerDB } from '@/features/player/tracker/db';
import {
  isTauri,
  dbGetWatchSessions,
  dbSaveWatchSession,
  dbGetWatchHistory,
  dbUpsertWatchHistory,
  type DbWatchSessionItem,
} from '@/features/player/tauri-bridge';
import type { WatchSessionRecord } from './types';

const STORE_NAME = 'watch_sessions';

function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Generate the stable identity for one player session. */
export function createWatchSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `watch-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/* ------------------------------------------------------------------------ */
/* SQLite backend (desktop Tauri)                                           */
/* ------------------------------------------------------------------------ */
/*
 * On desktop the embedded SQLite `watch_sessions` table is the source of truth.
 * Two schema differences are bridged here so the caller (PlayerApp) needs no
 * changes:
 * - `watch_sessions.media_id` is a FOREIGN KEY to `watch_history.media_id`, but
 *   a session can start before its history row exists. `ensureHistoryAndGetTitle`
 *   upserts a stub history row when absent, so the FK is always satisfied.
 * - the web record carries no `title` (and SQLite has no `episode` column), so
 *   the title is resolved from the media's history row and `episode` is not
 *   persisted on the session.
 * `sessionId` is passed as the row `id`, so re-saving a session as it progresses
 * (start → media attach → mined sentence → end) upserts ONE row instead of
 * multiplying rows for a single sit-down.
 */

function dbToSession(row: DbWatchSessionItem): WatchSessionRecord {
  return {
    sessionId: row.id,
    mediaId: row.mediaId,
    startedAt: row.startTime,
    endedAt: row.endTime,
    watchMs: row.duration,
    episode: null,
    minedSentences: row.minedSentences,
  };
}

/** Ensure a parent `watch_history` row exists (FK) and return its title. */
async function ensureHistoryAndGetTitle(mediaId: string): Promise<string> {
  try {
    const rows = await dbGetWatchHistory({ limit: 500 });
    const existing = rows.find((item) => item.mediaId === mediaId);
    if (existing) return existing.title || mediaId;
    await dbUpsertWatchHistory({
      mediaId,
      title: mediaId,
      titleNative: null,
      episode: null,
      source: 'local',
      watchedAt: Date.now(),
      duration: null,
      position: null,
      posterUrl: null,
      posterStatus: null,
      anilistId: null,
      tmdbId: null,
    });
  } catch {
    // History lookup/upsert is best-effort; the session save reports its own
    // failure if the FK still cannot be satisfied.
  }
  return mediaId;
}

async function putSessionDb(record: WatchSessionRecord): Promise<boolean> {
  try {
    const title = await ensureHistoryAndGetTitle(record.mediaId);
    await dbSaveWatchSession({
      id: record.sessionId,
      mediaId: record.mediaId,
      title,
      startTime: record.startedAt,
      endTime: record.endedAt,
      duration: record.watchMs,
      cuesMined: record.minedSentences.length,
      minedSentences: [...record.minedSentences],
    });
    return true;
  } catch {
    return false;
  }
}

async function appendMinedDb(
  sessionId: string,
  sentence: string,
): Promise<WatchSessionRecord | null> {
  const normalized = sentence.trim();
  if (!sessionId || !normalized) return null;
  try {
    const all = await dbGetWatchSessions();
    const row = all.find((item) => item.id === sessionId);
    if (!row) return null;
    const updated: DbWatchSessionItem = {
      ...row,
      cuesMined: row.cuesMined + 1,
      minedSentences: [...row.minedSentences, normalized],
    };
    await dbSaveWatchSession({
      id: updated.id,
      mediaId: updated.mediaId,
      title: updated.title,
      startTime: updated.startTime,
      endTime: updated.endTime,
      duration: updated.duration,
      cuesMined: updated.cuesMined,
      minedSentences: updated.minedSentences,
    });
    return dbToSession(updated);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* IndexedDB backend (browser)                                              */
/* ------------------------------------------------------------------------ */

async function putRecord(record: WatchSessionRecord): Promise<boolean> {
  if (!isIndexedDBAvailable()) return false;
  const db = await openTrackerDB();
  if (!db) return false;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => {
        resolve(true);
      };
      tx.onerror = tx.onabort = () => {
        resolve(false);
      };
    } catch {
      resolve(false);
    }
  });
}

/** Read every qualifying session newest-first for the profile read model. */
async function getAllSessionsIdb(): Promise<WatchSessionRecord[]> {
  if (!isIndexedDBAvailable()) return [];
  const db = await openTrackerDB();
  if (!db) return [];

  return new Promise((resolve) => {
    try {
      const request = db
        .transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME)
        .getAll();
      request.onsuccess = () => {
        const records = ((request.result as WatchSessionRecord[]) ?? [])
          .filter((record) => record.watchMs > 0 || record.minedSentences.length > 0)
          .sort((a, b) => b.startedAt - a.startedAt);
        resolve(records);
      };
      request.onerror = () => {
        resolve([]);
      };
    } catch {
      resolve([]);
    }
  });
}

async function appendMinedSentenceIdb(
  sessionId: string,
  sentence: string,
): Promise<WatchSessionRecord | null> {
  const normalized = sentence.trim();
  if (!sessionId || !normalized || !isIndexedDBAvailable()) return null;
  const db = await openTrackerDB();
  if (!db) return null;

  return new Promise((resolve) => {
    let updated: WatchSessionRecord | null = null;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(sessionId);
      request.onsuccess = () => {
        const current = request.result as WatchSessionRecord | undefined;
        if (!current) return;
        updated = {
          ...current,
          minedSentences: [...current.minedSentences, normalized],
        };
        store.put(updated);
      };
      tx.oncomplete = () => {
        resolve(updated);
      };
      tx.onerror = tx.onabort = () => {
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Public API — backend selected by `isTauri()`                             */
/* ------------------------------------------------------------------------ */

/** Persist or update a session. Failures are intentionally non-blocking. */
export async function putWatchSession(record: WatchSessionRecord): Promise<boolean> {
  return isTauri() ? putSessionDb(record) : putRecord(record);
}

/** Read every qualifying session newest-first for the profile read model. */
export async function getAllWatchSessions(): Promise<WatchSessionRecord[]> {
  if (isTauri()) {
    try {
      return (await dbGetWatchSessions())
        .map(dbToSession)
        .filter((record) => record.watchMs > 0 || record.minedSentences.length > 0)
        .sort((a, b) => b.startedAt - a.startedAt);
    } catch {
      return [];
    }
  }
  return getAllSessionsIdb();
}

export async function getWatchSessionsForMedia(
  mediaId: string,
): Promise<WatchSessionRecord[]> {
  if (isTauri()) {
    try {
      return (await dbGetWatchSessions(mediaId))
        .map(dbToSession)
        .filter((record) => record.watchMs > 0 || record.minedSentences.length > 0)
        .sort((a, b) => b.startedAt - a.startedAt);
    } catch {
      return [];
    }
  }
  const records = await getAllSessionsIdb();
  return records.filter((record) => record.mediaId === mediaId);
}

/**
 * Append a sentence to a session's mined list. On desktop the read-modify-write
 * runs against SQLite; callers (PlayerApp) already serialize concurrent appends
 * through a pending-mutation chain, so the last write wins correctly.
 */
export async function appendMinedSentence(
  sessionId: string,
  sentence: string,
): Promise<WatchSessionRecord | null> {
  if (isTauri()) return appendMinedDb(sessionId, sentence);
  return appendMinedSentenceIdb(sessionId, sentence);
}
