/**
 * IMMERSION_TRACKER — Shared types for the tracker engine and DB layer.
 * ---------------------------------------------------------------------------
 * Stage 1: Pure data-layer infrastructure. No React dependency.
 *
 * Naming follows the IMMERSION_TRACKER.md spec:
 * - 1-second cells via Math.round(currentTime)
 * - Repetition decay formula: 0.5^(N-1)
 * - 7-day per-cell reset via lastSeenAt
 * ---------------------------------------------------------------------------
 */

/* ------------------------------------------------------------------------ */
/* Playback mode (mirrors P2.1 modes relevant to tracking)                  */
/* ------------------------------------------------------------------------ */

export type PlaybackMode = 'normal' | 'condensed' | 'fast-forward';

/* ------------------------------------------------------------------------ */
/* Segment — one continuous playback stretch between two boundary events     */
/* ------------------------------------------------------------------------ */

/**
 * A segment represents one continuous playback stretch between two
 * boundary events (playing→paused, mode change, seek, subtitle change,
 * visibility change, pagehide, media change).
 */
export interface Segment {
  /** Wall-clock start (performance.now() or Date.now()) */
  wallStartMs: number;
  /** Wall-clock end */
  wallEndMs: number;
  /** media.currentTime at segment start */
  mediaStart: number;
  /** media.currentTime at segment end */
  mediaEnd: number;
  /** Playback rate during this segment */
  rate: number;
  /** Playback mode during this segment */
  mode: PlaybackMode;
  /** learningSetId at segment time */
  learningSetId: string;
}

/* ------------------------------------------------------------------------ */
/* Cell — one 1-second bucket in the exposure timeline                      */
/* ------------------------------------------------------------------------ */

/**
 * A cell represents one rounded second of media timeline.
 * Cells are sparse: only seconds that were actually touched are stored.
 */
export interface ExposureCell {
  /** learningSetId + roundedSecond as composite key */
  cellKey: string;
  /** learningSetId this cell belongs to */
  learningSetId: string;
  /** Math.round(media.currentTime) — timeline second */
  roundedSecond: number;
  /** Cumulative wall-clock ms spent on this cell */
  foregroundWatchMs: number;
  /** effectiveExposureMs after repetition decay */
  effectiveExposureMs: number;
  /** Number of distinct contiguous passes through this cell */
  passCount: number;
  /** When this cell was last seen (wall-clock timestamp) */
  lastSeenAt: number;
  /** Whether this cell has been covered by normal playback */
  hasCoverage: boolean;
  /** Wall-clock ms during subtitle cue presence */
  subtitleExposureMs: number;
  /** playing→paused transitions that occurred on this cell */
  pauseCount: number;
  /** Manual backward seek count */
  manualBackwardSeekCount: number;
  /** Anki export success count */
  mineCount: number;
}

/* ------------------------------------------------------------------------ */
/* Aggregated totals per learning set / media daily / daily                 */
/* ------------------------------------------------------------------------ */

export interface TimeTotals {
  foregroundWatchMs: number;
  mediaProgressMs: number;
  uniqueCoverageMs: number;
  effectiveExposureMs: number;
  subtitleExposureMs: number;
  condensedSkippedMs: number;
  fastForwardWallMs: number;
  fastForwardMediaMs: number;
  rateBuckets: Record<string, number>;
  manualBackwardSeekCount: number;
  mineCount: number;
}

/* ------------------------------------------------------------------------ */
/* Media record                                                             */
/* ------------------------------------------------------------------------ */

export interface MediaRecord {
  mediaId: string;
  displayName: string;
  byteSize: number;
  mimeType: string;
  firstSeenDay: string;
  lastSeenDay: string;
  totals: TimeTotals;
}

/* ------------------------------------------------------------------------ */
/* Learning set record                                                      */
/* ------------------------------------------------------------------------ */

export interface LearningSetRecord {
  learningSetId: string;
  mediaId: string;
  subtitleId: string;
  totals: TimeTotals;
}

/* ------------------------------------------------------------------------ */
/* Media daily aggregate                                                    */
/* ------------------------------------------------------------------------ */

export interface MediaDailyAggregate {
  mediaId: string;
  learningSetId: string;
  localDay: string;
  foregroundWatchMs: number;
  mediaProgressMs: number;
  uniqueCoverageMs: number;
  effectiveExposureMs: number;
  subtitleExposureMs: number;
  condensedSkippedMs: number;
  fastForwardWallMs: number;
  fastForwardMediaMs: number;
  rateBuckets: Record<string, number>;
  manualBackwardSeekCount: number;
  mineCount: number;
}

/* ------------------------------------------------------------------------ */
/* Daily aggregate                                                          */
/* ------------------------------------------------------------------------ */

export interface DailyAggregate {
  localDay: string;
  foregroundWatchMs: number;
  mediaProgressMs: number;
  uniqueCoverageMs: number;
  effectiveExposureMs: number;
  subtitleExposureMs: number;
  condensedSkippedMs: number;
  fastForwardWallMs: number;
  fastForwardMediaMs: number;
  rateBuckets: Record<string, number>;
  manualBackwardSeekCount: number;
  mineCount: number;
}

/* ------------------------------------------------------------------------ */
/* Mining archive entry                                                     */
/* ------------------------------------------------------------------------ */

export interface MiningArchiveEntry {
  id: string;
  mediaId: string;
  learningSetId: string;
  displayName: string;
  rangeStart: number;
  rangeEnd: number;
  sentence: string;
  localDay: string;
  /** Wall-clock timestamp (Date.now()) at write time. Used for newest-first sorting. */
  createdAt: number;
}

/* ------------------------------------------------------------------------ */
/* Cell distribution result — output of distributeSegmentToCells            */
/* ------------------------------------------------------------------------ */

export interface CellContribution {
  roundedSecond: number;
  /** Wall-clock ms to add to this cell's foregroundWatchMs */
  foregroundWatchMs: number;
  /** Wall-clock ms weighted by repetition decay */
  effectiveExposureMs: number;
  /** Whether this cell has coverage */
  hasCoverage: boolean;
  /** Wall-clock ms where subtitle was present */
  subtitleExposureMs: number;
  /** Whether this was a condensed skip gap */
  condensedSkippedMs: number;
  /** Fast-forward wall-clock ms */
  fastForwardWallMs: number;
  /** Fast-forward media timeline ms */
  fastForwardMediaMs: number;
  /** Whether this cell's passCount should increment */
  isNewPass: boolean;
  /** Whether a pause transition occurred on this cell */
  hadPauseTransition: boolean;
}

/* ------------------------------------------------------------------------ */
/* Segment accumulator state — passed through the tracking lifecycle        */
/* ------------------------------------------------------------------------ */

export interface SegmentAccumulatorState {
  /** Cells accumulated this session, keyed by cellKey */
  cells: Map<string, ExposureCell>;
  /** Running totals for the current learning set */
  totals: TimeTotals;
}

/* ------------------------------------------------------------------------ */
/* Cell key helpers                                                         */
/* ------------------------------------------------------------------------ */

/** Create a composite cell key from learningSetId + rounded second. */
export function cellKey(learningSetId: string, roundedSecond: number): string {
  return `${learningSetId}:${roundedSecond}`;
}

/** Create a no-subtitle learning set ID from a mediaId. */
export function noSubtitleLearningSetId(mediaId: string): string {
  return `${mediaId}:no-subtitle`;
}

/** Create a learning set ID from mediaId + subtitleId. */
export function makeLearningSetId(
  mediaId: string,
  subtitleId: string,
): string {
  return `${mediaId}:${subtitleId}`;
}

/* ------------------------------------------------------------------------ */
/* 7-day reset constant                                                     */
/* ------------------------------------------------------------------------ */

/** 7 days in milliseconds. */
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------------ */
/* Repetition decay formula                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Calculate repetition decay factor.
 * 1st pass: 1.0, 2nd pass: 0.5, 3rd pass: 0.25, Nth: 0.5^(N-1)
 */
export function repetitionDecayFactor(passCount: number): number {
  if (passCount <= 0) return 0;
  return Math.pow(0.5, passCount - 1);
}

/* ------------------------------------------------------------------------ */
/* Rounding boundary                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Round media currentTime to nearest 1-second cell.
 * 12.49 → 12, 12.50 → 13 (standard Math.round).
 */
export function roundToCell(currentTime: number): number {
  return Math.round(currentTime);
}
