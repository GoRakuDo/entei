/**
 * IMMERSION_TRACKER — Old Mining History DB deletion gate.
 * ---------------------------------------------------------------------------
 * Provides a safe API to delete the old `entei-mining-history` IndexedDB.
 *
 * SAFETY CONSTRAINTS (from IMMERSION_TRACKER.md §6.6):
 * - Must ONLY run after new tracker DB initialization succeeds
 * - Must require explicit just-in-time user reconfirmation
 * - Must NOT be invoked automatically anywhere
 * - Must verify tracker DB is ready before proceeding
 *
 * Usage:
 *   import { deleteOldMiningHistoryDB, canDeleteOldDB } from './tracker/old-db-gate';
 *
 *   // Check prerequisites
 *   const canDelete = await canDeleteOldDB();
 *
 *   // After user confirms, delete
 *   const result = await deleteOldMiningHistoryDB();
 * ---------------------------------------------------------------------------
 */

import { isTrackerDBReady } from './db';

/* ------------------------------------------------------------------------ */
/* Constants                                                                */
/* ------------------------------------------------------------------------ */

/** Old mining history DB name. Must match mining-history.ts DB_NAME exactly. */
const OLD_DB_NAME = 'entei-mining-history';

/* ------------------------------------------------------------------------ */
/* Prerequisite check                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Check if the old DB can be safely deleted.
 * Returns { ok: true } if prerequisites are met,
 * { ok: false, reason } otherwise.
 */
export async function canDeleteOldDB(): Promise<
  | { ok: true }
  | { ok: false; reason: 'tracker-not-ready' | 'idb-unavailable' | 'old-db-not-found' }
> {
  if (typeof indexedDB === 'undefined' || indexedDB === null) {
    return { ok: false, reason: 'idb-unavailable' };
  }

  // Must verify tracker DB is initialized first
  const trackerReady = await isTrackerDBReady();
  if (!trackerReady) {
    return { ok: false, reason: 'tracker-not-ready' };
  }

  // Check if old DB exists
  const oldDBExists = await checkOldDBExists();
  if (!oldDBExists) {
    return { ok: false, reason: 'old-db-not-found' };
  }

  return { ok: true };
}

/**
 * Check if the old mining history DB exists and has data.
 *
 * Opens WITHOUT version to avoid the version-mismatch trap:
 * - If old DB is at version 2 (current), opening with version 1 would be
 *   rejected by the browser or silently give version 2, making existence
 *   detection unreliable.
 * - Opening without version gives us the current version. If version is
 *   "0", the DB was just created by this call (didn't exist before).
 */
async function checkOldDBExists(): Promise<boolean> {
  if (typeof indexedDB === 'undefined' || indexedDB === null) return false;

  return new Promise((resolve) => {
    try {
      // Open WITHOUT version — this never triggers onupgradeneeded
      // and always opens the existing DB at its current version.
      const request = indexedDB.open(OLD_DB_NAME);

      let wasNewlyCreated = false;

      request.onupgradeneeded = () => {
        // Without a version arg, onupgradeneeded should not fire.
        // If it does (some browsers), treat as newly created.
        wasNewlyCreated = true;
      };

      request.onsuccess = () => {
        const db = request.result;
        const version = String(db.version);

        // version "0" means the DB was just created (empty).
        // Also handle the edge case where onupgradeneeded fired.
        if (version === '0' || wasNewlyCreated) {
          db.close();
          // Clean up the empty DB we just created
          indexedDB.deleteDatabase(OLD_DB_NAME);
          resolve(false);
          return;
        }

        // DB existed — check if it has any records
        try {
          const storeNames = Array.from(db.objectStoreNames);
          if (storeNames.length === 0) {
            db.close();
            resolve(false);
            return;
          }

          const storeName = storeNames[0]!;
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const countReq = store.count();

          countReq.onsuccess = () => {
            db.close();
            resolve(countReq.result > 0);
          };

          countReq.onerror = () => {
            db.close();
            resolve(false);
          };
        } catch {
          db.close();
          resolve(false);
        }
      };

      request.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Deletion                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Delete the old `entei-mining-history` IndexedDB.
 *
 * ⚠️ SAFETY: This function should only be called after:
 * 1. `canDeleteOldDB()` returns `{ ok: true }`
 * 2. The user has given explicit confirmation
 * 3. The new tracker DB is verified working
 *
 * Returns { ok: true } on success, { ok: false, reason } on failure.
 */
export async function deleteOldMiningHistoryDB(): Promise<
  | { ok: true }
  | { ok: false; reason: 'tracker-not-ready' | 'idb-unavailable' | 'delete-failed' }
> {
  if (typeof indexedDB === 'undefined' || indexedDB === null) {
    return { ok: false, reason: 'idb-unavailable' };
  }

  // Double-check tracker DB is ready (defense in depth)
  const trackerReady = await isTrackerDBReady();
  if (!trackerReady) {
    return { ok: false, reason: 'tracker-not-ready' };
  }

  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(OLD_DB_NAME);
      request.onsuccess = () => resolve({ ok: true });
      request.onerror = () => resolve({ ok: false, reason: 'delete-failed' });
      request.onblocked = () => resolve({ ok: false, reason: 'delete-failed' });
    } catch {
      resolve({ ok: false, reason: 'delete-failed' });
    }
  });
}
