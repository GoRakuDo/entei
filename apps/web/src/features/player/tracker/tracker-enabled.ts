/**
 * IMMERSION_TRACKER — Enabled state persistence.
 * ---------------------------------------------------------------------------
 * Stage 2a: Non-visual toggle logic for tracker ON/OFF.
 *
 * Design (from IMMERSION_TRACKER.md §7):
 * - Tracker is default ON when key is missing or corrupt.
 * - OFF state is persisted in localStorage so it survives reload.
 * - OFF stops new recording only; existing data is not deleted.
 * - Toggle OFF flushes current segment, toggle ON starts a new one.
 * - No UI switch yet — read/write helpers only for future UI.
 * ---------------------------------------------------------------------------
 */

import type { SegmentAccumulatorState } from './types';

/* ------------------------------------------------------------------------ */
/* Constants                                                                */
/* ------------------------------------------------------------------------ */

/** localStorage key for tracker enabled state. */
const TRACKER_PREF_KEY = 'entei.tracker.enabled';

/** Schema version — bump when shape changes. */
const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------------ */
/* Internal types                                                           */
/* ------------------------------------------------------------------------ */

interface TrackerEnabledData {
  schemaVersion: number;
  enabled: boolean;
}

/* ------------------------------------------------------------------------ */
/* Public API                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Read whether the tracker is enabled.
 * Returns true (default ON) when key is missing, corrupt, or localStorage
 * throws. Only an explicit `false` value disables tracking.
 */
export function isTrackerEnabled(): boolean {
  try {
    const raw = localStorage.getItem(TRACKER_PREF_KEY);
    if (raw === null) return true; // default ON

    const parsed: unknown = JSON.parse(raw);
    if (!isValidTrackerEnabledData(parsed)) return true; // corrupt → default ON

    return parsed.enabled;
  } catch {
    // localStorage unavailable or JSON corrupted → default ON
    return true;
  }
}

/**
 * Persist the tracker enabled state.
 * Silently ignores storage failures (private browsing, quota, etc.).
 */
export function setTrackerEnabled(enabled: boolean): void {
  try {
    const data: TrackerEnabledData = {
      schemaVersion: SCHEMA_VERSION,
      enabled,
    };
    localStorage.setItem(TRACKER_PREF_KEY, JSON.stringify(data));
  } catch {
    // Storage failure is non-fatal
  }
}

/* ------------------------------------------------------------------------ */
/* Flush helper                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Flush the current accumulator state to the provided callback.
 * Used when toggling tracker OFF — the caller passes its current cells and
 * totals so they can be persisted before stopping collection.
 *
 * @param state - Current accumulator state (may be empty if nothing accumulated)
 * @param onFlush - Callback to persist the flushed cells and totals
 * @returns The flushed state for reference
 */
export async function flushCurrentSegment(
  state: SegmentAccumulatorState,
  onFlush: (cells: Map<string, import('./types').ExposureCell>, totals: import('./types').TimeTotals) => Promise<void>,
): Promise<SegmentAccumulatorState> {
  if (state.cells.size > 0) {
    try {
      await onFlush(state.cells, state.totals);
    } catch {
      // Flush failure must not throw — tracker is fire-and-forget
    }
  }
  return state;
}

/* ------------------------------------------------------------------------ */
/* Validation                                                               */
/* ------------------------------------------------------------------------ */

function isValidTrackerEnabledData(value: unknown): value is TrackerEnabledData {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof obj.enabled !== 'boolean') return false;
  return true;
}
