import { openTrackerDB } from '@/features/player/tracker/db';
import { resolvePoster } from './poster-resolver';
import type {
  PosterResolution,
  WatchHistoryInput,
  WatchHistoryRecord,
  WatchHistoryPosterStatus,
  WatchHistorySource,
} from './types';
import {
  isTauri,
  dbGetWatchHistory,
  dbUpsertWatchHistory,
  type DbWatchHistoryItem,
} from '@/features/player/tauri-bridge';

const STORE_NAME = 'watch_history';

function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function putRecord(record: WatchHistoryRecord): Promise<boolean> {
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

async function getWatchHistoryRecord(
  mediaId: string,
): Promise<WatchHistoryRecord | null> {
  if (!isIndexedDBAvailable()) return null;
  const db = await openTrackerDB();
  if (!db) return null;
  try {
    return (
      (await requestResult<WatchHistoryRecord | undefined>(
        db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(mediaId),
      )) ?? null
    );
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* SQLite backend (desktop Tauri)                                           */
/* ------------------------------------------------------------------------ */
/*
 * On desktop the embedded SQLite `watch_history` table is the source of truth.
 * The web `WatchHistoryRecord` has no `duration` / `position` fields yet (those
 * columns exist for a future resume feature), so they are written as NULL and
 * dropped on read. `tmdbId` is a string in the web record but an integer column
 * in SQLite; TMDB ids are numeric, so a non-numeric value degrades to NULL
 * rather than corrupting the row.
 */

/** TMDB id: web keeps a string, SQLite an integer. */
function tmdbToDb(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordToDb(record: WatchHistoryRecord): DbWatchHistoryItem {
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

function dbToRecord(row: DbWatchHistoryItem): WatchHistoryRecord {
  return {
    mediaId: row.mediaId,
    title: row.title,
    titleNative: row.titleNative ?? null,
    episode: row.episode ?? null,
    source: row.source as WatchHistorySource,
    watchedAt: row.watchedAt,
    anilistId: row.anilistId ?? null,
    tmdbId: row.tmdbId === null ? null : String(row.tmdbId),
    posterUrl: row.posterUrl ?? null,
    posterStatus: (row.posterStatus as WatchHistoryPosterStatus) ?? 'none',
  };
}

/** There is no get-by-id command, so read a page and find the media. */
async function dbReadRecord(mediaId: string): Promise<WatchHistoryRecord | null> {
  try {
    const rows = await dbGetWatchHistory({ limit: 500 });
    const row = rows.find((item) => item.mediaId === mediaId);
    return row ? dbToRecord(row) : null;
  } catch {
    return null;
  }
}

async function dbWriteRecord(record: WatchHistoryRecord): Promise<boolean> {
  try {
    await dbUpsertWatchHistory(recordToDb(record));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* Public API — backend selected by `isTauri()`                             */
/* ------------------------------------------------------------------------ */

/** Read watch history newest-first. It never performs network resolution. */
export async function getAllWatchHistory(): Promise<WatchHistoryRecord[]> {
  if (isTauri()) {
    try {
      // SQLite returns newest-first already; keep the contract explicit.
      return (await dbGetWatchHistory({ limit: 500 }))
        .map(dbToRecord)
        .sort((a, b) => b.watchedAt - a.watchedAt);
    } catch {
      return [];
    }
  }
  if (!isIndexedDBAvailable()) return [];
  const db = await openTrackerDB();
  if (!db) return [];
  try {
    const records = await requestResult<WatchHistoryRecord[]>(
      db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll(),
    );
    return records.sort((a, b) => b.watchedAt - a.watchedAt);
  } catch {
    return [];
  }
}

/** Apply a resolved poster to an existing record without any list-time fetch. */
export async function updateWatchHistoryPoster(
  mediaId: string,
  resolution: PosterResolution,
): Promise<WatchHistoryRecord | null> {
  const current = isTauri()
    ? await dbReadRecord(mediaId)
    : await getWatchHistoryRecord(mediaId);
  if (!current) return null;
  const updated = {
    ...current,
    posterUrl: resolution.posterUrl,
    posterStatus: resolution.posterStatus,
    titleNative: current.titleNative ?? resolution.titleNative ?? null,
  } satisfies WatchHistoryRecord;
  const ok = isTauri()
    ? await dbWriteRecord(updated)
    : await putRecord(updated);
  return ok ? updated : null;
}

/**
 * Upsert at the first qualifying progress point. The pending state is written
 * before the single record-time resolver runs, then transitioned to ready/none.
 * A profile render only reads the cached result.
 *
 * Backend is SQLite on desktop Tauri, IndexedDB in the browser; the poster
 * resolution flow is shared by both so neither path diverges.
 */
export async function recordWatchHistory(
  input: WatchHistoryInput,
): Promise<WatchHistoryRecord | null> {
  if (!input.mediaId || !input.title) return null;
  if (!isTauri() && !isIndexedDBAvailable()) return null;

  const hasRecordTimePoster =
    input.posterStatus !== undefined && input.posterUrl !== undefined;
  const pending: WatchHistoryRecord = {
    ...input,
    titleNative: input.titleNative ?? null,
    watchedAt: Date.now(),
    posterUrl: input.posterUrl ?? null,
    posterStatus: hasRecordTimePoster
      ? (input.posterStatus ?? 'none')
      : 'pending',
  };
  const written = isTauri()
    ? await dbWriteRecord(pending)
    : await putRecord(pending);
  if (!written) return null;

  // YouTube posters are deterministic and supplied by the player at the
  // qualifying progress point. Do not invoke the anime/drama resolver for
  // them, and keep the poster URL fixed at record time.
  if (hasRecordTimePoster) return pending;

  let resolution: PosterResolution;
  try {
    resolution = await resolvePoster({
      title: input.title,
      anilistId: input.anilistId,
      tmdbId: input.tmdbId,
    });
  } catch {
    resolution = { posterUrl: null, posterStatus: 'none' };
  }
  return updateWatchHistoryPoster(input.mediaId, resolution);
}
