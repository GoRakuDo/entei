/**
 * IMMERSION_TRACKER — IndexedDB adapter for v1→v2 schema.
 * ---------------------------------------------------------------------------
 * Stage 1: Clean typed read/write APIs and deletion APIs.
 *
 * Schema v2 stores (bumped from v1 to fix meta store keyPath):
 *   media            — media file metadata and totals
 *   learning_sets    — per-subtitle-set aggregates
 *   media_daily      — per-media per-day aggregates
 *   daily            — daily aggregates (derived from media_daily)
 *   exposure_cells   — 1-second cells (sparse)
 *   mining_archive   — successful Anki export records
 *   meta             — installation-local salt and metadata (keyPath: 'key')
 *
 * Design:
 * - Write failures are fire-and-forget / non-blocking for playback semantics.
 * - Does not migrate old mining history (done separately).
 * - DB name: "immersion-tracker"
 * ---------------------------------------------------------------------------
 */

import type {
  MediaRecord,
  LearningSetRecord,
  MediaDailyAggregate,
  DailyAggregate,
  ExposureCell,
  MiningArchiveEntry,
} from './types';

/* ------------------------------------------------------------------------ */
/* Constants                                                                */
/* ------------------------------------------------------------------------ */

const DB_NAME = 'immersion-tracker';
const DB_VERSION = 2;

/* Store names — match IMMERSION_TRACKER.md §6 */
const STORE_MEDIA = 'media';
const STORE_LEARNING_SETS = 'learning_sets';
const STORE_MEDIA_DAILY = 'media_daily';
const STORE_DAILY = 'daily';
const STORE_EXPOSURE_CELLS = 'exposure_cells';
const STORE_MINING_ARCHIVE = 'mining_archive';
const STORE_META = 'meta';

/* ------------------------------------------------------------------------ */
/* IndexedDB availability check                                             */
/* ------------------------------------------------------------------------ */

function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* DB open / upgrade                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Open the immersion-tracker database.
 * Creates stores on first run (onupgradeneeded).
 * Bumps from v1→v2 to fix meta store keyPath.
 * Returns null if IndexedDB is unavailable or open fails.
 */
export function openTrackerDB(): Promise<IDBDatabase | null> {
  if (!isIndexedDBAvailable()) return Promise.resolve(null);

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const prevVersion = event.oldVersion;

        // ---- v1 creation (fresh install) ----
        if (prevVersion < 1) {
          // media store — keyed by mediaId
          if (!db.objectStoreNames.contains(STORE_MEDIA)) {
            db.createObjectStore(STORE_MEDIA, { keyPath: 'mediaId' });
          }

          // learning_sets — keyed by learningSetId
          if (!db.objectStoreNames.contains(STORE_LEARNING_SETS)) {
            db.createObjectStore(STORE_LEARNING_SETS, {
              keyPath: 'learningSetId',
            });
          }

          // media_daily — keyed by composite: learningSetId + localDay
          if (!db.objectStoreNames.contains(STORE_MEDIA_DAILY)) {
            const store = db.createObjectStore(STORE_MEDIA_DAILY, {
              keyPath: 'key',
            });
            store.createIndex('byLearningSet', 'learningSetId', {
              unique: false,
            });
            store.createIndex('byDay', 'localDay', { unique: false });
          }

          // daily — keyed by localDay
          if (!db.objectStoreNames.contains(STORE_DAILY)) {
            db.createObjectStore(STORE_DAILY, { keyPath: 'localDay' });
          }

          // exposure_cells — keyed by cellKey
          if (!db.objectStoreNames.contains(STORE_EXPOSURE_CELLS)) {
            const store = db.createObjectStore(STORE_EXPOSURE_CELLS, {
              keyPath: 'cellKey',
            });
            store.createIndex('byLearningSet', 'learningSetId', {
              unique: false,
            });
          }

          // mining_archive — keyed by id
          if (!db.objectStoreNames.contains(STORE_MINING_ARCHIVE)) {
            const store = db.createObjectStore(STORE_MINING_ARCHIVE, {
              keyPath: 'id',
            });
            store.createIndex('byMediaId', 'mediaId', { unique: false });
            store.createIndex('byDay', 'localDay', { unique: false });
          }

          // meta — key-value store for salt etc.
          // v1: no keyPath (broken — putMeta/getMeta mismatched)
          // v2: fixed with keyPath: 'key'
          if (!db.objectStoreNames.contains(STORE_META)) {
            db.createObjectStore(STORE_META, { keyPath: 'key' });
          }
        }

        // ---- v1→v2 migration: fix meta store keyPath ----
        if (prevVersion >= 1 && prevVersion < 2) {
          // Delete the old keyless meta store and recreate with keyPath
          if (db.objectStoreNames.contains(STORE_META)) {
            db.deleteObjectStore(STORE_META);
          }
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Generic helpers                                                          */
/* ------------------------------------------------------------------------ */

/** Read a single record by key from a store. */
async function getByKey<T>(
  storeName: string,
  key: string,
): Promise<T | null> {
  const db = await openTrackerDB();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => {
        db.close();
        resolve(req.result as T | undefined ?? null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

/** Read all records from a store. */
async function getAll<T>(storeName: string): Promise<T[]> {
  const db = await openTrackerDB();
  if (!db) return [];

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        resolve((req.result as T[]) ?? []);
      };
      req.onerror = () => {
        db.close();
        resolve([]);
      };
    } catch {
      db.close();
      resolve([]);
    }
  });
}

/** Put (upsert) a record into a store. Fire-and-forget. */
async function put<T>(storeName: string, record: T): Promise<boolean> {
  const db = await openTrackerDB();
  if (!db) return false;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.put(record);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
      tx.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

/** Delete a single record by key. */
async function deleteByKey(storeName: string, key: string): Promise<boolean> {
  const db = await openTrackerDB();
  if (!db) return false;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.delete(key);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
      tx.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

/** Clear all records from a store. */
async function clearStore(storeName: string): Promise<boolean> {
  const db = await openTrackerDB();
  if (!db) return false;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
      tx.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Typed public API — Media                                                 */
/* ------------------------------------------------------------------------ */

export async function getMedia(mediaId: string): Promise<MediaRecord | null> {
  return getByKey<MediaRecord>(STORE_MEDIA, mediaId);
}

export async function getAllMedia(): Promise<MediaRecord[]> {
  return getAll<MediaRecord>(STORE_MEDIA);
}

export async function putMedia(record: MediaRecord): Promise<boolean> {
  return put(STORE_MEDIA, record);
}

export async function deleteMedia(mediaId: string): Promise<boolean> {
  return deleteByKey(STORE_MEDIA, mediaId);
}

/* ------------------------------------------------------------------------ */
/* Typed public API — Learning Sets                                         */
/* ------------------------------------------------------------------------ */

export async function getLearningSet(
  learningSetId: string,
): Promise<LearningSetRecord | null> {
  return getByKey<LearningSetRecord>(STORE_LEARNING_SETS, learningSetId);
}

export async function getAllLearningSets(): Promise<LearningSetRecord[]> {
  return getAll<LearningSetRecord>(STORE_LEARNING_SETS);
}

export async function putLearningSet(
  record: LearningSetRecord,
): Promise<boolean> {
  return put(STORE_LEARNING_SETS, record);
}

export async function deleteLearningSet(
  learningSetId: string,
): Promise<boolean> {
  return deleteByKey(STORE_LEARNING_SETS, learningSetId);
}

/* ------------------------------------------------------------------------ */
/* Typed public API — Media Daily                                           */
/* ------------------------------------------------------------------------ */

export interface MediaDailyKey {
  learningSetId: string;
  localDay: string;
}

function mediaDailyKey(key: MediaDailyKey): string {
  return `${key.learningSetId}:${key.localDay}`;
}

export async function getMediaDaily(
  key: MediaDailyKey,
): Promise<MediaDailyAggregate | null> {
  return getByKey<MediaDailyAggregate>(
    STORE_MEDIA_DAILY,
    mediaDailyKey(key),
  );
}

export async function getAllMediaDaily(): Promise<MediaDailyAggregate[]> {
  return getAll<MediaDailyAggregate>(STORE_MEDIA_DAILY);
}

export async function putMediaDaily(
  record: MediaDailyAggregate,
): Promise<boolean> {
  // Ensure the composite key is set
  const withKey = {
    ...record,
    key: mediaDailyKey({
      learningSetId: record.learningSetId,
      localDay: record.localDay,
    }),
  };
  return put(STORE_MEDIA_DAILY, withKey);
}

export async function deleteMediaDaily(key: MediaDailyKey): Promise<boolean> {
  return deleteByKey(STORE_MEDIA_DAILY, mediaDailyKey(key));
}

/* ------------------------------------------------------------------------ */
/* Typed public API — Daily                                                 */
/* ------------------------------------------------------------------------ */

export async function getDaily(
  localDay: string,
): Promise<DailyAggregate | null> {
  return getByKey<DailyAggregate>(STORE_DAILY, localDay);
}

export async function getAllDaily(): Promise<DailyAggregate[]> {
  return getAll<DailyAggregate>(STORE_DAILY);
}

export async function putDaily(record: DailyAggregate): Promise<boolean> {
  return put(STORE_DAILY, record);
}

export async function deleteDaily(localDay: string): Promise<boolean> {
  return deleteByKey(STORE_DAILY, localDay);
}

/* ------------------------------------------------------------------------ */
/* Typed public API — Exposure Cells                                        */
/* ------------------------------------------------------------------------ */

export async function getExposureCell(
  cellKey: string,
): Promise<ExposureCell | null> {
  return getByKey<ExposureCell>(STORE_EXPOSURE_CELLS, cellKey);
}

export async function getAllExposureCells(): Promise<ExposureCell[]> {
  return getAll<ExposureCell>(STORE_EXPOSURE_CELLS);
}

export async function putExposureCell(cell: ExposureCell): Promise<boolean> {
  return put(STORE_EXPOSURE_CELLS, cell);
}

export async function deleteExposureCell(cellKey: string): Promise<boolean> {
  return deleteByKey(STORE_EXPOSURE_CELLS, cellKey);
}

/* ------------------------------------------------------------------------ */
/* Typed public API — Mining Archive                                        */
/* ------------------------------------------------------------------------ */

export async function getMiningArchiveEntry(
  id: string,
): Promise<MiningArchiveEntry | null> {
  return getByKey<MiningArchiveEntry>(STORE_MINING_ARCHIVE, id);
}

export async function getAllMiningArchive(): Promise<MiningArchiveEntry[]> {
  return getAll<MiningArchiveEntry>(STORE_MINING_ARCHIVE);
}

export async function putMiningArchiveEntry(
  entry: MiningArchiveEntry,
): Promise<boolean> {
  return put(STORE_MINING_ARCHIVE, entry);
}

export async function deleteMiningArchiveEntry(id: string): Promise<boolean> {
  return deleteByKey(STORE_MINING_ARCHIVE, id);
}

/* ------------------------------------------------------------------------ */
/* Typed public API — Meta                                                  */
/* ------------------------------------------------------------------------ */

export async function getMeta(key: string): Promise<unknown> {
  return getByKey<unknown>(STORE_META, key);
}

/**
 * Put a meta key-value pair. The store uses keyPath: 'key',
 * so the record is { key, value } and lookups use the key field.
 */
export async function putMeta(key: string, value: unknown): Promise<boolean> {
  return put(STORE_META, { key, value });
}

/* ------------------------------------------------------------------------ */
/* Bulk deletion APIs                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Clear all exposure cells for a given learning set.
 * Uses the byLearningSet index for efficient lookup.
 */
export async function clearExposureCellsForLearningSet(
  learningSetId: string,
): Promise<boolean> {
  const db = await openTrackerDB();
  if (!db) return false;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_EXPOSURE_CELLS, 'readwrite');
      const store = tx.objectStore(STORE_EXPOSURE_CELLS);
      const index = store.index('byLearningSet');
      const request = index.openCursor(IDBKeyRange.only(learningSetId));

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
        // Resolution happens in oncomplete
      };

      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
      tx.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

/** Clear all data — nuclear option. Only clears tracker stores. */
export async function clearAllTrackerData(): Promise<boolean> {
  const stores = [
    STORE_MEDIA,
    STORE_LEARNING_SETS,
    STORE_MEDIA_DAILY,
    STORE_DAILY,
    STORE_EXPOSURE_CELLS,
    STORE_MINING_ARCHIVE,
  ];
  for (const store of stores) {
    await clearStore(store);
  }
  return true;
}

/* ------------------------------------------------------------------------ */
/* DB initialization check                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Check if the tracker DB is initialized and accessible.
 * Useful before attempting old DB deletion.
 */
export async function isTrackerDBReady(): Promise<boolean> {
  const db = await openTrackerDB();
  if (!db) return false;
  db.close();
  return true;
}
