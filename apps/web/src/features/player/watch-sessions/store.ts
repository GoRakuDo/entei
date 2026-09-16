import { openTrackerDB } from '@/features/player/tracker/db';
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

/** Persist or update a session. Failures are intentionally non-blocking. */
export async function putWatchSession(record: WatchSessionRecord): Promise<boolean> {
  return putRecord(record);
}

/** Read every session newest-first for the profile read model. */
export async function getAllWatchSessions(): Promise<WatchSessionRecord[]> {
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
        const records = (request.result as WatchSessionRecord[]) ?? [];
        resolve(records.sort((a, b) => b.startedAt - a.startedAt));
      };
      request.onerror = () => {
        resolve([]);
      };
    } catch {
      resolve([]);
    }
  });
}

export async function getWatchSessionsForMedia(
  mediaId: string,
): Promise<WatchSessionRecord[]> {
  const records = await getAllWatchSessions();
  return records.filter((record) => record.mediaId === mediaId);
}

/**
 * Append a sentence in the same read-modify-write transaction as the lookup.
 * This keeps concurrent export/pagehide writes from dropping mined text.
 */
export async function appendMinedSentence(
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
