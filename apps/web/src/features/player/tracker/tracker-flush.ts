/**
 * IMMERSION_TRACKER — Flush accumulated cells/totals to IndexedDB.
 * ---------------------------------------------------------------------------
 * Stage 2b: Real persistence for runtime tracking aggregates.
 *
 * This module implements the actual DB writes that the tracker runtime
 * flush callback triggers. All writes are fire-and-forget — failures
 * are swallowed and never block playback or Anki export.
 *
 * Persistence targets (per flush):
 *   exposure_cells — merge each cell additively with existing DB record
 *   learning_sets  — merge totals additively with existing DB record
 *   media          — merge totals additively, update displayName/lastSeenDay
 *   media_daily    — merge flat fields additively for current local day
 *   daily          — merge flat fields additively for current local day
 * ---------------------------------------------------------------------------
 */

import {
  getExposureCell,
  putExposureCell,
  getLearningSet,
  putLearningSet,
  getMedia,
  putMedia,
  getMediaDaily,
  putMediaDaily,
  getDaily,
  putDaily,
} from './db';
import type {
  ExposureCell,
  TimeTotals,
  LearningSetRecord,
  MediaRecord,
  MediaDailyAggregate,
  DailyAggregate,
} from './types';
import { mergeTotals } from './engine';

/* ------------------------------------------------------------------------ */
/* Public types                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Context for a flush operation — media identity and metadata not available
 * in the accumulator but needed for parent-store records.
 */
export interface FlushContext {
  /** Computed mediaId (SHA-256 fingerprint). Required for parent stores. */
  mediaId: string;
  /** Latest display name (filename). */
  mediaName: string;
  /** File byte size (0 if unavailable). */
  byteSize: number;
  /** MIME type string (empty if unavailable). */
  mimeType: string;
}

/* ------------------------------------------------------------------------ */
/* Local day helper                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Get the current local day as YYYY-MM-DD.
 * Uses 'en-CA' locale which produces ISO date format.
 * This is the canonical local-day key for media_daily and daily stores.
 */
export function getLocalDay(): string {
  return new Date().toLocaleDateString('en-CA');
}

/* ------------------------------------------------------------------------ */
/* Exposure cell merge                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Merge a single exposure cell with its existing DB record (if any).
 * All numeric fields are additive. passCount increments by 1 per new pass.
 * lastSeenAt takes the maximum of existing and new.
 */
async function mergeExposureCell(cell: ExposureCell): Promise<boolean> {
  const existing = await getExposureCell(cell.cellKey);

  if (existing) {
    const merged: ExposureCell = {
      ...existing,
      foregroundWatchMs: existing.foregroundWatchMs + cell.foregroundWatchMs,
      effectiveExposureMs:
        existing.effectiveExposureMs + cell.effectiveExposureMs,
      subtitleExposureMs:
        existing.subtitleExposureMs + cell.subtitleExposureMs,
      hasCoverage: existing.hasCoverage || cell.hasCoverage,
      passCount: existing.passCount + cell.passCount,
      pauseCount: existing.pauseCount + cell.pauseCount,
      manualBackwardSeekCount:
        existing.manualBackwardSeekCount + cell.manualBackwardSeekCount,
      mineCount: existing.mineCount + cell.mineCount,
      lastSeenAt: Math.max(existing.lastSeenAt, cell.lastSeenAt),
    };
    return putExposureCell(merged);
  }

  return putExposureCell(cell);
}

/* ------------------------------------------------------------------------ */
/* Parent store merges                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Merge learning set totals. Additive merge of TimeTotals.
 */
async function flushLearningSet(
  learningSetId: string,
  mediaId: string,
  subtitleId: string,
  totals: TimeTotals,
): Promise<void> {
  const existing = await getLearningSet(learningSetId);

  if (existing) {
    existing.totals = mergeTotals(existing.totals, totals);
    await putLearningSet(existing);
  } else {
    const record: LearningSetRecord = {
      learningSetId,
      mediaId,
      subtitleId,
      totals: { ...totals },
    };
    await putLearningSet(record);
  }
}

/**
 * Merge media totals. Additive merge of TimeTotals.
 * Updates displayName to latest filename and lastSeenDay to today.
 */
async function flushMedia(
  mediaId: string,
  ctx: FlushContext,
  totals: TimeTotals,
): Promise<void> {
  const localDay = getLocalDay();
  const existing = await getMedia(mediaId);

  if (existing) {
    existing.totals = mergeTotals(existing.totals, totals);
    existing.displayName = ctx.mediaName;
    existing.lastSeenDay = localDay;
    await putMedia(existing);
  } else {
    const record: MediaRecord = {
      mediaId,
      displayName: ctx.mediaName,
      byteSize: ctx.byteSize,
      mimeType: ctx.mimeType,
      firstSeenDay: localDay,
      lastSeenDay: localDay,
      totals: { ...totals },
    };
    await putMedia(record);
  }
}

/**
 * Merge media_daily flat fields. Each numeric field is additive.
 * Rate buckets are merged additively.
 */
async function flushMediaDaily(
  mediaId: string,
  learningSetId: string,
  totals: TimeTotals,
): Promise<void> {
  const localDay = getLocalDay();
  const existing = await getMediaDaily({ learningSetId, localDay });

  if (existing) {
    existing.foregroundWatchMs += totals.foregroundWatchMs;
    existing.mediaProgressMs += totals.mediaProgressMs;
    existing.uniqueCoverageMs += totals.uniqueCoverageMs;
    existing.effectiveExposureMs += totals.effectiveExposureMs;
    existing.subtitleExposureMs += totals.subtitleExposureMs;
    existing.condensedSkippedMs += totals.condensedSkippedMs;
    existing.fastForwardWallMs += totals.fastForwardWallMs;
    existing.fastForwardMediaMs += totals.fastForwardMediaMs;
    existing.manualBackwardSeekCount += totals.manualBackwardSeekCount;
    existing.mineCount += totals.mineCount;
    for (const [key, val] of Object.entries(totals.rateBuckets)) {
      existing.rateBuckets[key] = (existing.rateBuckets[key] ?? 0) + val;
    }
    await putMediaDaily(existing);
  } else {
    const record: MediaDailyAggregate = {
      mediaId,
      learningSetId,
      localDay,
      foregroundWatchMs: totals.foregroundWatchMs,
      mediaProgressMs: totals.mediaProgressMs,
      uniqueCoverageMs: totals.uniqueCoverageMs,
      effectiveExposureMs: totals.effectiveExposureMs,
      subtitleExposureMs: totals.subtitleExposureMs,
      condensedSkippedMs: totals.condensedSkippedMs,
      fastForwardWallMs: totals.fastForwardWallMs,
      fastForwardMediaMs: totals.fastForwardMediaMs,
      rateBuckets: { ...totals.rateBuckets },
      manualBackwardSeekCount: totals.manualBackwardSeekCount,
      mineCount: totals.mineCount,
    };
    await putMediaDaily(record);
  }
}

/**
 * Merge daily flat fields. Each numeric field is additive.
 * Rate buckets are merged additively.
 */
async function flushDaily(totals: TimeTotals): Promise<void> {
  const localDay = getLocalDay();
  const existing = await getDaily(localDay);

  if (existing) {
    existing.foregroundWatchMs += totals.foregroundWatchMs;
    existing.mediaProgressMs += totals.mediaProgressMs;
    existing.uniqueCoverageMs += totals.uniqueCoverageMs;
    existing.effectiveExposureMs += totals.effectiveExposureMs;
    existing.subtitleExposureMs += totals.subtitleExposureMs;
    existing.condensedSkippedMs += totals.condensedSkippedMs;
    existing.fastForwardWallMs += totals.fastForwardWallMs;
    existing.fastForwardMediaMs += totals.fastForwardMediaMs;
    existing.manualBackwardSeekCount += totals.manualBackwardSeekCount;
    existing.mineCount += totals.mineCount;
    for (const [key, val] of Object.entries(totals.rateBuckets)) {
      existing.rateBuckets[key] = (existing.rateBuckets[key] ?? 0) + val;
    }
    await putDaily(existing);
  } else {
    const record: DailyAggregate = {
      localDay,
      foregroundWatchMs: totals.foregroundWatchMs,
      mediaProgressMs: totals.mediaProgressMs,
      uniqueCoverageMs: totals.uniqueCoverageMs,
      effectiveExposureMs: totals.effectiveExposureMs,
      subtitleExposureMs: totals.subtitleExposureMs,
      condensedSkippedMs: totals.condensedSkippedMs,
      fastForwardWallMs: totals.fastForwardWallMs,
      fastForwardMediaMs: totals.fastForwardMediaMs,
      rateBuckets: { ...totals.rateBuckets },
      manualBackwardSeekCount: totals.manualBackwardSeekCount,
      mineCount: totals.mineCount,
    };
    await putDaily(record);
  }
}

/* ------------------------------------------------------------------------ */
/* Public API — complete flush                                              */
/* ------------------------------------------------------------------------ */

/**
 * Complete flush: cells + learning set + media + media_daily + daily.
 *
 * This is the callback wired to trackerRuntime.onFlush.
 * All writes are fire-and-forget — failures are swallowed and never
 * block playback or Anki export.
 *
 * @param cells - Accumulated exposure cells from the current session
 * @param totals - Accumulated time totals from the current session
 * @param learningSetId - Current learning set identity
 * @param ctx - Media identity and metadata
 */
export async function flushTrackerData(
  cells: Map<string, ExposureCell>,
  totals: TimeTotals,
  learningSetId: string,
  ctx: FlushContext,
): Promise<void> {
  // Cells are always flushed (they carry learningSetId internally)
  // Fire-and-forget: don't block parent store writes
  const cellWrites: Promise<boolean>[] = [];
  for (const cell of cells.values()) {
    cellWrites.push(
      mergeExposureCell(cell).catch(() => false),
    );
  }
  // Let cell writes settle independently
  void Promise.all(cellWrites).catch(() => {});

  // Extract subtitleId from learningSetId
  // Format: "mediaId:subtitleId" or "mediaId:no-subtitle"
  const subtitleId = learningSetId.slice(ctx.mediaId.length + 1) || 'no-subtitle';

  // All parent-store writes are fire-and-forget
  void Promise.all([
    flushLearningSet(learningSetId, ctx.mediaId, subtitleId, totals).catch(
      () => {},
    ),
    flushMedia(ctx.mediaId, ctx, totals).catch(() => {}),
    flushMediaDaily(ctx.mediaId, learningSetId, totals).catch(() => {}),
    flushDaily(totals).catch(() => {}),
  ]).catch(() => {});
}
