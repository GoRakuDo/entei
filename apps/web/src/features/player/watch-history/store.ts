import { openTrackerDB } from '@/features/player/tracker/db';
import { resolvePoster } from './poster-resolver';
import type {
  PosterResolution,
  WatchHistoryInput,
  WatchHistoryRecord,
} from './types';

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
        db.close();
        resolve(true);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
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
  } finally {
    db.close();
  }
}

/** Read watch history newest-first. It never performs network resolution. */
export async function getAllWatchHistory(): Promise<WatchHistoryRecord[]> {
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
  } finally {
    db.close();
  }
}

/** Apply a resolved poster to an existing record without any list-time fetch. */
export async function updateWatchHistoryPoster(
  mediaId: string,
  resolution: PosterResolution,
): Promise<WatchHistoryRecord | null> {
  const current = await getWatchHistoryRecord(mediaId);
  if (!current) return null;
  const updated = {
    ...current,
    posterUrl: resolution.posterUrl,
    posterStatus: resolution.posterStatus,
    titleNative: current.titleNative ?? resolution.titleNative ?? null,
  } satisfies WatchHistoryRecord;
  return (await putRecord(updated)) ? updated : null;
}

/**
 * Upsert at the first qualifying progress point. The pending state is written
 * before the single record-time resolver runs, then transitioned to ready/none.
 * A profile render only reads the cached result.
 */
export async function recordWatchHistory(
  input: WatchHistoryInput,
): Promise<WatchHistoryRecord | null> {
  if (!input.mediaId || !input.title || !isIndexedDBAvailable()) return null;

  const pending: WatchHistoryRecord = {
    ...input,
    titleNative: input.titleNative ?? null,
    watchedAt: Date.now(),
    posterUrl: null,
    posterStatus: 'pending',
  };
  if (!(await putRecord(pending))) return null;

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
