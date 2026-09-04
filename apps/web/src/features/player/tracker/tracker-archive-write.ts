/**
 * IMMERSION_TRACKER — Mining archive write helper for Anki export.
 * ---------------------------------------------------------------------------
 * Stage 2a: Called by PlayerApp after a successful Anki export to also write
 * a record into the tracker's mining_archive store.
 *
 * Design:
 * - Only writes when tracker is enabled AND mediaId is available (local file).
 * - Fire-and-forget: never throws, never blocks Anki success.
 * - Uses the same MiningArchiveEntry type defined in tracker types.
 * - Keeps the old `entei-mining-history` writing path intact for compatibility.
 * ---------------------------------------------------------------------------
 */

import { isTrackerEnabled } from './tracker-enabled';
import { putMiningArchiveEntry } from './db';
import type { MiningArchiveEntry } from './types';

/* ------------------------------------------------------------------------ */
/* Public API                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Parameters for recording a mining archive entry in the tracker DB.
 */
export interface RecordTrackerArchiveParams {
  /** The computed mediaId (SHA-256 fingerprint). Null if not available. */
  mediaId: string | null;
  /** The computed subtitleId. Null if no subtitle. */
  subtitleId: string | null;
  /** The computed learningSetId. Null if not available. */
  learningSetId: string | null;
  /** Media display name (filename). */
  displayName: string;
  /** Subtitle range start (seconds). */
  rangeStart: number;
  /** Subtitle range end (seconds). */
  rangeEnd: number;
  /** The mined sentence text. */
  sentence: string;
}

/**
 * Record a successful Anki export into the tracker's mining_archive.
 *
 * This is the new authoritative write path for mining history records
 * within the tracker DB. The old `entei-mining-history` path is kept
 * for temporary compatibility but should eventually be removed.
 *
 * Fire-and-forget: never throws, never blocks the caller.
 * Returns true if the entry was written successfully.
 */
export async function recordTrackerMiningArchive(
  params: RecordTrackerArchiveParams,
): Promise<boolean> {
  // Gate: tracker must be enabled
  if (!isTrackerEnabled()) return false;

  // Gate: mediaId must be available (local file identity required)
  if (!params.mediaId || !params.learningSetId) return false;

  try {
    const localDay = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local tz

    const entry: MiningArchiveEntry = {
      id: generateStableId(),
      mediaId: params.mediaId,
      learningSetId: params.learningSetId,
      displayName: params.displayName,
      rangeStart: params.rangeStart,
      rangeEnd: params.rangeEnd,
      sentence: params.sentence,
      localDay,
      createdAt: Date.now(),
    };

    const ok = await putMiningArchiveEntry(entry);
    if (ok && typeof window !== 'undefined') {
      // Cross-component refresh signal — picked up by MiningHistoryPanel and
      // the /tracker/ dashboard. No payload needed; listeners just refetch.
      window.dispatchEvent(new CustomEvent('entei:tracker-archive-changed'));
    }
    return ok;
  } catch {
    // Fire-and-forget: never throw
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

/** Generate a stable random ID for the mining archive entry. */
function generateStableId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for test environments
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
