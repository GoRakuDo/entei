/**
 * IMMERSION_TRACKER — Identity helpers for local media and subtitles.
 * ---------------------------------------------------------------------------
 * Stage 1: Browser-local only. No export/import portability.
 *
 * Identity scheme (from IMMERSION_TRACKER.md §5):
 *   mediaId     = SHA-256(installation-local salt + byte size + first 1MiB + last 1MiB)
 *   subtitleId  = SHA-256(subtitle file content)
 *   learningSetId = mediaId + ":" + subtitleId  (via types.ts makeLearningSetId)
 *   no-subtitle learningSetId = mediaId + ":no-subtitle"  (via types.ts noSubtitleLearningSetId)
 *
 * The installation-local salt is stored in the tracker's IndexedDB and never
 * leaves the browser. File whole-hash is avoided to prevent startup delay on
 * large videos.
 *
 * Learning-set ID helpers (noSubtitleLearningSetId, makeLearningSetId,
 * NO_SUBTITLE_ID) are defined in types.ts as the single source of truth.
 * This module re-exports them for convenience.
 * ---------------------------------------------------------------------------
 */

import { noSubtitleLearningSetId, makeLearningSetId } from './types';
import { openTrackerDB } from './db';

/* ------------------------------------------------------------------------ */
/* Re-export learning-set helpers from types.ts (single source of truth)    */
/* ------------------------------------------------------------------------ */

export { noSubtitleLearningSetId, makeLearningSetId };
export const NO_SUBTITLE_ID = 'no-subtitle' as const;

/* ------------------------------------------------------------------------ */
/* Salt management                                                          */
/* ------------------------------------------------------------------------ */

const SALT_KEY = 'installation-salt';
const SALT_STORE = 'meta';

/**
 * Get or create the installation-local salt.
 * Stored in IndexedDB so it persists across sessions but never leaves the device.
 * Returns null if IndexedDB is unavailable.
 *
 * Uses openTrackerDB() from db.ts as the single canonical DB initializer,
 * ensuring ALL stores are created on fresh install (not just meta).
 * Salt record: { key: 'installation-salt', value: '<uuid>' }
 */
export async function getOrCreateSalt(): Promise<string | null> {
  const db = await openTrackerDB();
  if (!db) return null;

  try {
    const tx = db.transaction(SALT_STORE, 'readwrite');
    const store = tx.objectStore(SALT_STORE);
    const getReq = store.get(SALT_KEY);

    return await new Promise<string | null>((resolve) => {
      getReq.onsuccess = () => {
        const record = getReq.result as
          | { key: string; value: string }
          | undefined;
        if (record && typeof record.value === 'string') {
          db.close();
          resolve(record.value);
          return;
        }
        // Generate new salt
        const salt = generateRandomSalt();
        store.put({ key: SALT_KEY, value: salt });
        tx.oncomplete = () => {
          db.close();
          resolve(salt);
        };
        tx.onerror = () => {
          db.close();
          resolve(null);
        };
      };

      getReq.onerror = () => {
        db.close();
        resolve(null);
      };
    });
  } catch {
    db.close();
    return null;
  }
}

/** Generate a random salt string. */
function generateRandomSalt(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for test environments
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/* ------------------------------------------------------------------------ */
/* Video sample fingerprint                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Compute a video sample fingerprint for a local file.
 *
 * Uses: installation-local salt + byte size + first 1MiB + last 1MiB
 * This avoids reading the entire file while being collision-resistant
 * for practical purposes.
 *
 * For files smaller than 2MiB, reads the entire file.
 * For files between 1MiB and 2MiB, reads first 1MiB + remaining bytes.
 */
export async function computeVideoFingerprint(
  file: File,
): Promise<string | null> {
  const salt = await getOrCreateSalt();
  if (salt === null) return null;

  try {
    const byteSize = file.size;
    const first1MiB = await readSlice(file, 0, 1024 * 1024);
    const last1MiB =
      byteSize > 1024 * 1024
        ? await readSlice(file, Math.max(0, byteSize - 1024 * 1024), byteSize)
        : new Uint8Array(0);

    // Combine salt + size bytes + first + last
    const sizeBytes = new Uint8Array(8);
    const view = new DataView(sizeBytes.buffer);
    view.setBigUint64(0, BigInt(byteSize));

    const combined = concatBytes([
      new TextEncoder().encode(salt),
      sizeBytes,
      first1MiB,
      last1MiB,
    ]);

    return hashSHA256(combined);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Subtitle digest                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Compute a subtitle file digest (full content hash).
 * Subtitle files are small enough to hash entirely.
 */
export async function computeSubtitleDigest(
  file: File,
): Promise<string | null> {
  try {
    const content = await readFileAsBytes(file);
    return hashSHA256(content);
  } catch {
    return null;
  }
}

/**
 * Compute a subtitle digest from raw text content.
 * Useful when the content is already loaded (e.g., from FileReader).
 */
export async function computeSubtitleDigestFromText(
  text: string,
): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  return hashSHA256(encoded);
}

/* ------------------------------------------------------------------------ */
/* Internal helpers                                                         */
/* ------------------------------------------------------------------------ */

/** Read a byte range from a File. */
async function readSlice(
  file: File,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const blob = file.slice(start, end);
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

/** Read entire File as bytes. */
async function readFileAsBytes(file: File): Promise<Uint8Array> {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

/** Concatenate multiple Uint8Arrays. */
function concatBytes(arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/** Hash a Uint8Array using SHA-256, returning hex string. */
async function hashSHA256(data: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && 'subtle' in crypto) {
    // Create a fresh ArrayBuffer from the data to satisfy strict BufferSource typing
    // (Uint8Array.buffer may return SharedArrayBuffer which is not assignable to ArrayBuffer)
    const arrayBuffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(arrayBuffer).set(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fallback: simple hash for test environments without crypto.subtle
  return fallbackHash(data);
}

/**
 * Simple fallback hash for test environments.
 * NOT cryptographically secure — only used when crypto.subtle is unavailable.
 */
function fallbackHash(data: Uint8Array): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!;
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
