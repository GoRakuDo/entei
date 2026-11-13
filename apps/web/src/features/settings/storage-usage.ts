/**
 * storage-usage — the browser's own storage meter, read-only.
 * ---------------------------------------------------------------------------
 * A settings page that imports dictionaries (hundreds of MB to >1 GB each) has
 * to answer "how much of my disk is this using?". The platform does not track
 * that itself and must not: the browser already counts every byte an origin
 * holds (IndexedDB, CacheStorage, OPFS) and `navigator.storage.estimate()` is
 * the only number that is true for all of them at once.
 *
 * Nothing here writes or evicts anything — it is a read plus the two pure
 * formatters the UI needs. The byte format is Yomitan's own (base 1000, one
 * decimal, `1.7GB`) so a learner comparing Entei against the extension sees the
 * same figure, not a 1024-based approximation.
 * ---------------------------------------------------------------------------
 */

/** One `navigator.storage.estimate()` reading, in bytes. */
export interface StorageUsageSnapshot {
  /** Bytes currently held by this origin. */
  usage: number;
  /** Bytes the browser is willing to give this origin (may be 0). */
  quota: number;
}

/** Byte units, base 1000 — identical labels to Yomitan's storage row. */
const BYTE_LABELS: readonly string[] = [' bytes', 'KB', 'MB', 'GB', 'TB'];

const BYTE_BASE = 1000;

/**
 * Read the origin's storage estimate.
 *
 * Returns `null` when the API is missing (older WebView, non-secure context) or
 * refuses: the row then shows an em dash instead of a fabricated number.
 */
export async function readStorageUsage(): Promise<StorageUsageSnapshot | null> {
  if (typeof navigator === 'undefined') return null;
  const storage: StorageManager | undefined = navigator.storage;
  if (storage === undefined || typeof storage.estimate !== 'function') {
    return null;
  }
  try {
    const estimate = await storage.estimate();
    return {
      usage: typeof estimate.usage === 'number' ? estimate.usage : 0,
      quota: typeof estimate.quota === 'number' ? estimate.quota : 0,
    };
  } catch {
    return null;
  }
}

/** Byte count → `1.7GB`. Below 1000 bytes the count stays whole. */
export function formatStorageBytes(bytes: number): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (value >= BYTE_BASE && unit < BYTE_LABELS.length - 1) {
    value /= BYTE_BASE;
    unit += 1;
  }
  const label = unit === 0 ? `${value}` : value.toFixed(1);
  return `${label}${BYTE_LABELS[unit]}`;
}

/**
 * Fill a `{used}` / `{total}` copy template from a snapshot.
 *
 * A missing snapshot renders as `—`: an unavailable meter must read as unknown,
 * never as "0 bytes used".
 */
export function formatStorageUsage(
  template: string,
  snapshot: StorageUsageSnapshot | null,
): string {
  const used = snapshot === null ? '—' : formatStorageBytes(snapshot.usage);
  const total = snapshot === null ? '—' : formatStorageBytes(snapshot.quota);
  return template
    .replace(/\{used\}/g, used)
    .replace(/\{total\}/g, total);
}