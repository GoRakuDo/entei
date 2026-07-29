/**
 * IMMERSION_TRACKER — Mining archive read helper for History panel.
 * ---------------------------------------------------------------------------
 * Stage 3: Lightweight read path for the RightPanel History tab.
 *
 * Reads from the tracker's `mining_archive` store and returns entries
 * in the same shape as the old `mining-history.ts` HistoryReadResult,
 * so MiningHistoryPanel can switch sources with minimal change.
 *
 * Design:
 * - Newest-first via createdAt timestamp (descending).
 * - Entries without createdAt (pre-timestamp records) sort to the end.
 * - Returns { ok: false, reason } when tracker DB is unavailable.
 * - No analytics, charts, or /tracker/ page — list only.
 * ---------------------------------------------------------------------------
 */

import { getAllMiningArchive } from './db';
import type { MiningArchiveEntry } from './types';

/* ------------------------------------------------------------------------ */
/* Public types — mirror mining-history.ts shapes for compatibility          */
/* ------------------------------------------------------------------------ */

/** A single history entry in the shape the panel component expects. */
export interface TrackerHistoryEntry {
  id: string;
  filename: string;
  rangeStart: number;
  rangeEnd: number;
  sentence: string;
}

/** Result of a history read — distinguishes empty from unavailable. */
export type TrackerHistoryReadResult =
  | { ok: true; entries: TrackerHistoryEntry[] }
  | { ok: false; reason: 'unavailable' | 'error' };

/* ------------------------------------------------------------------------ */
/* Validation                                                               */
/* ------------------------------------------------------------------------ */

/** Validate a raw MiningArchiveEntry from the DB. */
function isValidEntry(entry: MiningArchiveEntry): boolean {
  return (
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    typeof entry.displayName === 'string' &&
    typeof entry.rangeStart === 'number' &&
    Number.isFinite(entry.rangeStart) &&
    typeof entry.rangeEnd === 'number' &&
    Number.isFinite(entry.rangeEnd) &&
    typeof entry.sentence === 'string'
  );
}

/* ------------------------------------------------------------------------ */
/* Public API                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Read mining archive entries from the tracker DB, newest-first.
 *
 * Maps tracker `MiningArchiveEntry` to the lightweight shape expected
 * by MiningHistoryPanel: { id, filename, rangeStart, rangeEnd, sentence }.
 *
 * Returns { ok: false, reason } if the tracker DB is unavailable or errors.
 * Never throws.
 */
export async function getTrackerHistoryEntries(): Promise<TrackerHistoryReadResult> {
  try {
    const raw = await getAllMiningArchive();

    // Filter invalid entries
    const valid = raw.filter(isValidEntry);

    // Map to panel-compatible shape, preserving createdAt for sort
    const mapped = valid.map((e) => ({
      id: e.id,
      filename: e.displayName,
      rangeStart: e.rangeStart,
      rangeEnd: e.rangeEnd,
      sentence: e.sentence,
      createdAt: e.createdAt ?? 0,
    }));

    // Sort newest-first (entries without createdAt sort to end)
    mapped.sort((a, b) => b.createdAt - a.createdAt);

    // Strip createdAt — panel doesn't need it
    const entries: TrackerHistoryEntry[] = mapped.map(
      ({ createdAt: _createdAt, ...rest }) => rest,
    );

    return { ok: true, entries };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
