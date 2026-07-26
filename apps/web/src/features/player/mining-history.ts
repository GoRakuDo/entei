/**
 * Mining History — IndexedDB persistence for successful Anki send records.
 * ---------------------------------------------------------------------------
 * Metadata-only, local-only. Each entry records ONE successful Anki export.
 * Writes are fire-and-forget: DB errors must never prevent Anki success.
 *
 * Schema v1:
 *   key:         auto-increment (determines chronological insertion order)
 *   id:          stable random string (public React key)
 *   filename:    string (media filename, e.g. "entei_screenshot_1234.jpg")
 *   rangeStart:  number (seconds, 1 decimal)
 *   rangeEnd:    number (seconds, 1 decimal)
 *   sentence:    string (mined subtitle/sentence text at time of send)
 *
 * Newest-first is guaranteed by reverse cursor traversal over the internal
 * auto-increment key. The public `id` is never used for sorting.
 * ---------------------------------------------------------------------------
 */

const DB_NAME = 'entei-mining-history';
// Keep the original v1 store intact. It sorted by random IDs, so v2 uses a
// separate auto-increment store rather than deleting a user's local records.
const DB_VERSION = 2;
const STORE_NAME = 'entries-v2';

/* ------------------------------------------------------------------------ */
/* Public types                                                             */
/* ------------------------------------------------------------------------ */

export interface MiningHistoryEntry {
  id: string;
  filename: string;
  rangeStart: number;
  rangeEnd: number;
  sentence: string;
}

/** Result of a history read — distinguishes empty from unavailable. */
export type HistoryReadResult =
  | { ok: true; entries: MiningHistoryEntry[] }
  | { ok: false; reason: 'unavailable' | 'error' };

/* ------------------------------------------------------------------------ */
/* Adapter pattern — allows tests to inject a fake backend.                 */
/* ------------------------------------------------------------------------ */

export interface HistoryAdapter {
  add(entry: Omit<MiningHistoryEntry, 'id'>): Promise<boolean>;
  getAll(): Promise<HistoryReadResult>;
  clear(): Promise<boolean>;
}

/* ------------------------------------------------------------------------ */
/* IndexedDB adapter (production)                                           */
/* ------------------------------------------------------------------------ */

function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDB(): Promise<IDBDatabase | null> {
  if (!isIndexedDBAvailable()) return Promise.resolve(null);

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, {
            keyPath: 'key',
            autoIncrement: true,
          });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Generate a stable random public id. */
function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for test environments without crypto.randomUUID
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Validate a raw record read from IDB before conversion. */
function isValidRecord(value: unknown): value is {
  key: number;
  id: string;
  filename: string;
  rangeStart: number;
  rangeEnd: number;
  sentence: string;
} {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === 'number' &&
    Number.isFinite(v.key) &&
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.filename === 'string' &&
    typeof v.rangeStart === 'number' &&
    Number.isFinite(v.rangeStart) &&
    typeof v.rangeEnd === 'number' &&
    Number.isFinite(v.rangeEnd) &&
    typeof v.sentence === 'string'
  );
}

/** Convert a validated IDB record to the public entry shape. */
function toPublicEntry(record: {
  id: string;
  filename: string;
  rangeStart: number;
  rangeEnd: number;
  sentence: string;
}): MiningHistoryEntry {
  return {
    id: record.id,
    filename: record.filename,
    rangeStart: record.rangeStart,
    rangeEnd: record.rangeEnd,
    sentence: record.sentence,
  };
}

const idbAdapter: HistoryAdapter = {
  async add(entry) {
    const db = await openDB();
    if (!db) return false;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.add({ ...entry, id: makeId() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  },

  async getAll() {
    const db = await openDB();
    if (!db) return { ok: false, reason: 'unavailable' as const };

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        // Reverse cursor for newest-first without client-side sort.
        const request = store.openCursor(null, 'prev');
        const results: MiningHistoryEntry[] = [];

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            if (isValidRecord(cursor.value)) {
              results.push(toPublicEntry(cursor.value));
            }
            cursor.continue();
          } else {
            resolve({ ok: true, entries: results });
          }
        };
        request.onerror = () =>
          resolve({ ok: false, reason: 'error' as const });
      } catch {
        resolve({ ok: false, reason: 'error' as const });
      }
    });
  },

  async clear() {
    const db = await openDB();
    if (!db) return false;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  },
};

/* ------------------------------------------------------------------------ */
/* Public-API level validation (defense in depth)                           */
/* ------------------------------------------------------------------------ */

function isValidPublicEntry(e: unknown): e is MiningHistoryEntry {
  if (typeof e !== 'object' || e === null) return false;
  const v = e as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.filename === 'string' &&
    typeof v.rangeStart === 'number' &&
    Number.isFinite(v.rangeStart) &&
    typeof v.rangeEnd === 'number' &&
    Number.isFinite(v.rangeEnd) &&
    typeof v.sentence === 'string'
  );
}

/* ------------------------------------------------------------------------ */
/* Active adapter management                                                */
/* ------------------------------------------------------------------------ */

let activeAdapter: HistoryAdapter = idbAdapter;

/** Switch the active adapter. For tests only. */
export function _setAdapter(adapter: HistoryAdapter): void {
  activeAdapter = adapter;
}

/** Reset to production adapter. */
export function _resetAdapter(): void {
  activeAdapter = idbAdapter;
}

/* ------------------------------------------------------------------------ */
/* Public API                                                               */
/* ------------------------------------------------------------------------ */

/** Write a single entry. Fire-and-forget: never throws. */
export async function addHistoryEntry(
  entry: Omit<MiningHistoryEntry, 'id'>,
): Promise<boolean> {
  try {
    return await activeAdapter.add(entry);
  } catch {
    return false;
  }
}

/** Read newest-first entries, distinguishing an empty DB from an unavailable one. */
export async function getAllHistoryEntries(): Promise<HistoryReadResult> {
  try {
    const result = await activeAdapter.getAll();
    if (!result.ok) return result;
    const valid = result.entries.filter(isValidPublicEntry);
    return { ok: true, entries: valid };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/** Clear all entries. */
export async function clearHistoryEntries(): Promise<boolean> {
  try {
    return await activeAdapter.clear();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* Record successful Anki send — called by PlayerApp after each mode.       */
/* ------------------------------------------------------------------------ */

export interface RecordSendParams {
  filename: string;
  rangeStart: number;
  rangeEnd: number;
  sentence: string;
}

/**
 * Record a successful Anki send into Mining History.
 * Fire-and-forget: errors are swallowed, never throws.
 * Returns true if the entry was written successfully.
 */
export async function recordMiningHistory(
  params: RecordSendParams,
): Promise<boolean> {
  try {
    return await addHistoryEntry(params);
  } catch {
    return false;
  }
}
