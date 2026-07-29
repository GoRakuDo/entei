/**
 * IMMERSION_TRACKER — Pure engine for segment accumulation and cell distribution.
 * ---------------------------------------------------------------------------
 * Stage 1: Zero React dependency. Unit-testable pure logic.
 *
 * Responsibilities:
 * - Distribute a segment's wall-clock time across 1-second cells
 * - Separate foregroundWatchMs, mediaProgressMs, uniqueCoverageMs,
 *   effectiveExposureMs, subtitleExposureMs, condensedSkippedMs,
 *   fastForwardWallMs, fastForwardMediaMs
 * - Apply repetition decay: 0.5^(N-1)
 * - Per-session pass tracking: each playback session increments passCount
 *   once for each cell it touches (unless 7-day reset applies)
 * - 7-day per-cell reset based on lastSeenAt
 * - Seek exclusion from mediaProgressMs
 * - Pause transition counting: playing→paused only (buffering excluded)
 *
 * Per-session pass semantics:
 *   The caller must maintain a Set<string> of cell keys touched this session.
 *   On each segment, distributeSegmentToCells consults this set to determine
 *   isNewPass. applyContributions adds touched cells to the set.
 *   When cells are loaded from DB into a new session, the sessionSeenCells
 *   set starts empty, so the first segment touching a loaded cell will
 *   correctly increment passCount once for that session.
 * ---------------------------------------------------------------------------
 */

import type {
  Segment,
  ExposureCell,
  SegmentAccumulatorState,
  CellContribution,
  PlaybackMode,
  TimeTotals,
} from './types';
import {
  cellKey,
  roundToCell,
  repetitionDecayFactor,
  SEVEN_DAYS_MS,
} from './types';

/* ------------------------------------------------------------------------ */
/* Constants                                                                */
/* ------------------------------------------------------------------------ */

/** Fast-forward multiplier applied to audio-only gaps. */
export const FAST_FORWARD_RATE = 3;

/* ------------------------------------------------------------------------ */
/* Empty state factory                                                      */
/* ------------------------------------------------------------------------ */

/** Create a fresh accumulator state. */
export function createAccumulatorState(): SegmentAccumulatorState {
  return {
    cells: new Map(),
    totals: emptyTotals(),
  };
}

/** Create zero-filled totals. */
export function emptyTotals(): TimeTotals {
  return {
    foregroundWatchMs: 0,
    mediaProgressMs: 0,
    uniqueCoverageMs: 0,
    effectiveExposureMs: 0,
    subtitleExposureMs: 0,
    condensedSkippedMs: 0,
    fastForwardWallMs: 0,
    fastForwardMediaMs: 0,
    rateBuckets: {},
    manualBackwardSeekCount: 0,
    mineCount: 0,
  };
}

/* ------------------------------------------------------------------------ */
/* Segment → Cell distribution                                              */
/* ------------------------------------------------------------------------ */

/**
 * Compute the media overlap fraction within a rounded-second cell.
 * Returns a value in [0, 1] representing how much of the cell's 1-second
 * window is covered by the media range [mediaStart, mediaEnd].
 *
 * Example: media 4.3 → 5.7 spans cells 4, 5, 6.
 *   Cell 4: overlap = [4.3, 4.5] = 0.2s out of 1.0s → fraction 0.2
 *   Cell 5: overlap = [4.5, 5.5] = 1.0s out of 1.0s → fraction 1.0
 *   Cell 6: overlap = [5.5, 5.7] = 0.2s out of 1.0s → fraction 0.2
 */
function cellMediaOverlapFraction(
  cell: number,
  mediaStart: number,
  mediaEnd: number,
): number {
  const cellStart = cell - 0.5;
  const cellEnd = cell + 0.5;
  const overlapStart = Math.max(mediaStart, cellStart);
  const overlapEnd = Math.min(mediaEnd, cellEnd);
  if (overlapEnd <= overlapStart) return 0;
  return Math.min(1, (overlapEnd - overlapStart) / 1.0);
}

/**
 * Distribute a segment's time across 1-second cells.
 *
 * Wall-clock allocation is proportional to media overlap within each cell,
 * not uniform across covered cells. This ensures that a segment crossing
 * 3 cells where only the middle one has full media coverage distributes
 * wall-clock time correctly.
 *
 * Rules from IMMERSION_TRACKER.md:
 * - 2x crossing 2 seconds in 1 second → proportional distribution
 * - Cell合计が実時間を超えない
 * - Seek exclusion: user seek jump not counted in mediaProgressMs
 * - Per-session pass dedupe: same cell touched once per session → one pass increment
 * - Repetition decay applied only to effectiveExposureMs
 * - Pause transition: playing→paused counted once per transition
 * - Buffering is NOT a pause transition
 * - 7-day reset: if lastSeenAt > 7 days ago, passCount resets
 *
 * @param segment - The playback segment
 * @param existingCells - Cells loaded from DB / accumulated this session
 * @param sessionSeenCells - Cell keys already touched this session (mutable set)
 * @param cueInterval - Optional subtitle cue interval for subtitleExposureMs
 */
export function distributeSegmentToCells(
  segment: Segment,
  existingCells: Map<string, ExposureCell>,
  sessionSeenCells: Set<string>,
  cueInterval?: { startMs: number; endMs: number },
): CellContribution[] {
  const wallClockMs = segment.wallEndMs - segment.wallStartMs;
  if (wallClockMs <= 0) return [];

  const startCell = roundToCell(segment.mediaStart);
  const endCell = roundToCell(segment.mediaEnd);
  const mediaDelta = Math.abs(segment.mediaEnd - segment.mediaStart) * 1000;
  const isSeek = mediaDelta > wallClockMs * 1.5 && wallClockMs < 500;

  // Determine if this is a condensed skip (programmatic seek)
  const isCondensedSkip = segment.mode === 'condensed' && isSeek;

  // Determine if this is a fast-forward segment
  const isFastForward = segment.mode === 'fast-forward';

  const contributions: CellContribution[] = [];
  const now = Date.now();

  if (startCell === endCell || startCell > endCell) {
    // Segment fits within a single cell or is backwards
    const rk = cellKey(segment.learningSetId, startCell);
    const existing = existingCells.get(rk);
    const lastSeen = existing?.lastSeenAt ?? 0;
    const is7DayReset = now - lastSeen > SEVEN_DAYS_MS;
    const cellIsNew = !existing || existing.passCount === 0;
    const isNewPass = cellIsNew || is7DayReset || !sessionSeenCells.has(rk);

    const subtitleMs = cueInterval
      ? computeSubtitleOverlap(
          segment.mediaStart,
          segment.mediaEnd,
          cueInterval.startMs / 1000,
          cueInterval.endMs / 1000,
          wallClockMs,
        )
      : 0;

    const ffWall = isFastForward ? wallClockMs : 0;
    const ffMedia = isFastForward ? mediaDelta : 0;

    contributions.push({
      roundedSecond: startCell,
      foregroundWatchMs: wallClockMs,
      effectiveExposureMs: wallClockMs * repetitionDecayFactor(
        (is7DayReset ? 0 : (existing?.passCount ?? 0)) + (isNewPass ? 1 : 0),
      ),
      hasCoverage: !isSeek,
      subtitleExposureMs: subtitleMs,
      condensedSkippedMs: isCondensedSkip ? mediaDelta : 0,
      fastForwardWallMs: ffWall,
      fastForwardMediaMs: ffMedia,
      isNewPass,
      hadPauseTransition: false,
    });
  } else {
    // Segment spans multiple cells — distribute proportionally to media overlap
    const cellsCovered = endCell - startCell + 1;

    // Compute total overlap weight across all covered cells
    let totalOverlapWeight = 0;
    const overlapWeights: number[] = [];
    for (let cell = startCell; cell <= endCell; cell++) {
      const w = cellMediaOverlapFraction(cell, segment.mediaStart, segment.mediaEnd);
      overlapWeights.push(w);
      totalOverlapWeight += w;
    }

    // Fallback: if no overlap (shouldn't happen), distribute uniformly
    if (totalOverlapWeight === 0) {
      for (let i = 0; i < cellsCovered; i++) {
        overlapWeights[i] = 1 / cellsCovered;
      }
      totalOverlapWeight = 1;
    }

    let consumedWallMs = 0;
    let idx = 0;
    for (let cell = startCell; cell <= endCell; cell++, idx++) {
      const rk = cellKey(segment.learningSetId, cell);
      const existing = existingCells.get(rk);
      const lastSeen = existing?.lastSeenAt ?? 0;
      const is7DayReset = now - lastSeen > SEVEN_DAYS_MS;
      const cellIsNew = !existing || existing.passCount === 0;
      const isNewPass = cellIsNew || is7DayReset || !sessionSeenCells.has(rk);

      // Proportional wall-clock based on media overlap
      const fraction = overlapWeights[idx]! / totalOverlapWeight;
      const isLastCell = cell === endCell;
      const cellWallMs = isLastCell
        ? Math.max(0, wallClockMs - consumedWallMs)
        : Math.round(wallClockMs * fraction);
      consumedWallMs += cellWallMs;

      // Media time within this cell
      const cellMediaStart = Math.max(segment.mediaStart, cell - 0.5);
      const cellMediaEnd = Math.min(segment.mediaEnd, cell + 0.5);
      const cellMediaDelta = Math.max(0, (cellMediaEnd - cellMediaStart) * 1000);

      const subtitleMs = cueInterval
        ? computeSubtitleOverlap(
            cellMediaStart,
            cellMediaEnd,
            cueInterval.startMs / 1000,
            cueInterval.endMs / 1000,
            cellWallMs,
          )
        : 0;

      const ffWall = isFastForward ? cellWallMs : 0;
      const ffMedia = isFastForward ? cellMediaDelta : 0;

      contributions.push({
        roundedSecond: cell,
        foregroundWatchMs: cellWallMs,
        effectiveExposureMs:
          cellWallMs * repetitionDecayFactor(
            (is7DayReset ? 0 : (existing?.passCount ?? 0)) + (isNewPass ? 1 : 0),
          ),
        hasCoverage: !isSeek,
        subtitleExposureMs: subtitleMs,
        condensedSkippedMs: isCondensedSkip ? cellMediaDelta : 0,
        fastForwardWallMs: ffWall,
        fastForwardMediaMs: ffMedia,
        isNewPass,
        hadPauseTransition: false,
      });
    }
  }

  return contributions;
}

/* ------------------------------------------------------------------------ */
/* Apply contributions to accumulator                                       */
/* ------------------------------------------------------------------------ */

/**
 * Apply cell contributions to the accumulator state.
 * Updates cells map, running totals, and marks cells as session-seen.
 *
 * @param sessionSeenCells - Mutable Set tracking cells touched this session.
 *                           Cells are added here so subsequent segments in the
 *                           same session don't double-increment passCount.
 */
export function applyContributions(
  state: SegmentAccumulatorState,
  contributions: CellContribution[],
  learningSetId: string,
  mode: PlaybackMode,
  isPausedTransition: boolean,
  sessionSeenCells: Set<string>,
): void {
  for (const c of contributions) {
    const rk = cellKey(learningSetId, c.roundedSecond);
    const existing = state.cells.get(rk);

    if (existing) {
      existing.foregroundWatchMs += c.foregroundWatchMs;
      existing.effectiveExposureMs += c.effectiveExposureMs;
      existing.subtitleExposureMs += c.subtitleExposureMs;
      existing.hasCoverage = existing.hasCoverage || c.hasCoverage;
      if (c.isNewPass) {
        existing.passCount += 1;
      }
      if (isPausedTransition) {
        existing.pauseCount += 1;
      }
      existing.lastSeenAt = Date.now();
    } else {
      state.cells.set(rk, {
        cellKey: rk,
        learningSetId,
        roundedSecond: c.roundedSecond,
        foregroundWatchMs: c.foregroundWatchMs,
        effectiveExposureMs: c.effectiveExposureMs,
        passCount: c.isNewPass ? 1 : 0,
        lastSeenAt: Date.now(),
        hasCoverage: c.hasCoverage,
        subtitleExposureMs: c.subtitleExposureMs,
        pauseCount: isPausedTransition ? 1 : 0,
        manualBackwardSeekCount: 0,
        mineCount: 0,
      });
    }

    // Mark as session-seen so subsequent segments don't double-increment
    sessionSeenCells.add(rk);

    // Update totals
    state.totals.foregroundWatchMs += c.foregroundWatchMs;
    state.totals.effectiveExposureMs += c.effectiveExposureMs;
    state.totals.subtitleExposureMs += c.subtitleExposureMs;
    state.totals.condensedSkippedMs += c.condensedSkippedMs;
    state.totals.fastForwardWallMs += c.fastForwardWallMs;
    state.totals.fastForwardMediaMs += c.fastForwardMediaMs;

    if (c.hasCoverage) {
      state.totals.uniqueCoverageMs += c.foregroundWatchMs;
    }

    // Media progress (seek excluded)
    if (!c.condensedSkippedMs && !c.fastForwardMediaMs) {
      state.totals.mediaProgressMs += c.foregroundWatchMs;
    }

    // Rate bucket
    const rateBucket = mode;
    state.totals.rateBuckets[rateBucket] =
      (state.totals.rateBuckets[rateBucket] ?? 0) + c.foregroundWatchMs;
  }
}

/* ------------------------------------------------------------------------ */
/* Pause transition detection                                               */
/* ------------------------------------------------------------------------ */

/**
 * Detect a playing→paused transition.
 * Buffering is NOT a pause transition.
 *
 * @param wasPlaying - Previous playing state
 * @param isPlaying - Current playing state
 * @param isBuffering - Whether media is currently buffering
 * @returns true only on a genuine playing→paused transition
 */
export function isPauseTransition(
  wasPlaying: boolean,
  isPlaying: boolean,
  isBuffering: boolean,
): boolean {
  return wasPlaying && !isPlaying && !isBuffering;
}

/* ------------------------------------------------------------------------ */
/* Segment finalization helpers                                             */
/* ------------------------------------------------------------------------ */

/**
 * Create a segment from boundary events.
 * Caller is responsible for tracking wallStart/mediaStart when playback begins.
 */
export function createSegment(
  wallStartMs: number,
  wallEndMs: number,
  mediaStart: number,
  mediaEnd: number,
  rate: number,
  mode: PlaybackMode,
  learningSetId: string,
): Segment {
  return {
    wallStartMs,
    wallEndMs,
    mediaStart,
    mediaEnd,
    rate,
    mode,
    learningSetId,
  };
}

/* ------------------------------------------------------------------------ */
/* Subtitle overlap computation                                             */
/* ------------------------------------------------------------------------ */

/**
 * Compute how much wall-clock time overlaps with a subtitle cue interval.
 * Uses proportional overlap based on media time range.
 */
function computeSubtitleOverlap(
  mediaStart: number,
  mediaEnd: number,
  cueStart: number,
  cueEnd: number,
  wallClockMs: number,
): number {
  const overlapStart = Math.max(mediaStart, cueStart);
  const overlapEnd = Math.min(mediaEnd, cueEnd);
  if (overlapEnd <= overlapStart) return 0;

  const totalRange = Math.abs(mediaEnd - mediaStart);
  if (totalRange === 0) return 0;

  const overlapRange = overlapEnd - overlapStart;
  return (overlapRange / totalRange) * wallClockMs;
}

/* ------------------------------------------------------------------------ */
/* Manual backward seek tracking                                            */
/* ------------------------------------------------------------------------ */

/**
 * Detect a manual backward seek.
 * Returns true if the media jumped backward (user seek, not programmatic).
 */
export function isManualBackwardSeek(
  prevMediaTime: number,
  newMediaTime: number,
  wallClockDeltaMs: number,
): boolean {
  const mediaDelta = newMediaTime - prevMediaTime;
  // Media went backward by more than 0.5s, and it wasn't a normal playback
  return mediaDelta < -0.5 && mediaDelta * 1000 < -wallClockDeltaMs;
}

/* ------------------------------------------------------------------------ */
/* Merge helpers                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Merge two TimeTotals additively.
 * Useful when combining per-cell or per-day aggregates.
 */
export function mergeTotals(a: TimeTotals, b: TimeTotals): TimeTotals {
  const rateBuckets: Record<string, number> = { ...a.rateBuckets };
  for (const [key, val] of Object.entries(b.rateBuckets)) {
    rateBuckets[key] = (rateBuckets[key] ?? 0) + val;
  }
  return {
    foregroundWatchMs: a.foregroundWatchMs + b.foregroundWatchMs,
    mediaProgressMs: a.mediaProgressMs + b.mediaProgressMs,
    uniqueCoverageMs: a.uniqueCoverageMs + b.uniqueCoverageMs,
    effectiveExposureMs: a.effectiveExposureMs + b.effectiveExposureMs,
    subtitleExposureMs: a.subtitleExposureMs + b.subtitleExposureMs,
    condensedSkippedMs: a.condensedSkippedMs + b.condensedSkippedMs,
    fastForwardWallMs: a.fastForwardWallMs + b.fastForwardWallMs,
    fastForwardMediaMs: a.fastForwardMediaMs + b.fastForwardMediaMs,
    rateBuckets,
    manualBackwardSeekCount:
      a.manualBackwardSeekCount + b.manualBackwardSeekCount,
    mineCount: a.mineCount + b.mineCount,
  };
}
