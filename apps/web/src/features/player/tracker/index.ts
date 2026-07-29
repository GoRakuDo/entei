/**
 * IMMERSION_TRACKER — Public API re-exports.
 * ---------------------------------------------------------------------------
 * Stage 1: Infrastructure only. No React components or UI wiring.
 * ---------------------------------------------------------------------------
 */

// Types
export type {
  PlaybackMode,
  Segment,
  ExposureCell,
  MediaRecord,
  LearningSetRecord,
  MediaDailyAggregate,
  DailyAggregate,
  MiningArchiveEntry,
  TimeTotals,
  CellContribution,
  SegmentAccumulatorState,
} from './types';

export {
  cellKey,
  noSubtitleLearningSetId,
  makeLearningSetId,
  SEVEN_DAYS_MS,
  repetitionDecayFactor,
  roundToCell,
} from './types';

// Engine — pure logic
export {
  createAccumulatorState,
  emptyTotals,
  distributeSegmentToCells,
  applyContributions,
  isPauseTransition,
  createSegment,
  isManualBackwardSeek,
  mergeTotals,
  FAST_FORWARD_RATE,
} from './engine';

// Identity — fingerprint and digest
// Note: noSubtitleLearningSetId and makeLearningSetId are exported from types.ts
// as the single source of truth. Identity re-exports them for convenience.
export {
  getOrCreateSalt,
  computeVideoFingerprint,
  computeSubtitleDigest,
  computeSubtitleDigestFromText,
  NO_SUBTITLE_ID,
} from './identity';

// DB — IndexedDB adapter
export {
  openTrackerDB,
  getMedia,
  getAllMedia,
  putMedia,
  deleteMedia,
  getLearningSet,
  getAllLearningSets,
  putLearningSet,
  deleteLearningSet,
  getMediaDaily,
  getAllMediaDaily,
  putMediaDaily,
  deleteMediaDaily,
  getDaily,
  getAllDaily,
  putDaily,
  deleteDaily,
  getExposureCell,
  getAllExposureCells,
  putExposureCell,
  deleteExposureCell,
  getMiningArchiveEntry,
  getAllMiningArchive,
  putMiningArchiveEntry,
  deleteMiningArchiveEntry,
  getMeta,
  putMeta,
  clearExposureCellsForLearningSet,
  clearAllTrackerData,
  isTrackerDBReady,
} from './db';

// Old DB gate — safe deletion API
export {
  canDeleteOldDB,
  deleteOldMiningHistoryDB,
} from './old-db-gate';

// Tracker enabled state (Stage 2a)
export {
  isTrackerEnabled,
  setTrackerEnabled,
  flushCurrentSegment,
} from './tracker-enabled';

// Tracker runtime hook (Stage 2a)
export {
  useTrackerRuntime,
  type TrackerRuntimeState,
  type OnTrackerFlush,
  type UseTrackerRuntimeOptions,
} from './tracker-runtime';

// Mining archive write helper (Stage 2a)
export {
  recordTrackerMiningArchive,
  type RecordTrackerArchiveParams,
} from './tracker-archive-write';

// Mining archive read helper (Stage 3 — History panel)
export {
  getTrackerHistoryEntries,
  type TrackerHistoryEntry,
  type TrackerHistoryReadResult,
} from './tracker-archive-read';

// Flush persistence (Stage 2b)
export {
  flushTrackerData,
  type FlushContext,
} from './tracker-flush';

// Shared local-day helper (pure, no DB dependency)
export { getLocalDay } from './local-day';

// Dashboard read model (Stage 3A — /tracker/ page)
export {
  getTrackerDashboard,
  type TrackerDashboardReadModel,
  type TodaySummary,
  type MediaWithLearningSets,
  type LearningSetItem,
  type MomentGroup,
  type MomentBucket,
  type ArchiveReadEntry,
} from './tracker-dashboard-read';

// Dashboard React hook (Stage 3A — /tracker/ page)
export {
  useTrackerDashboard,
  type TrackerDashboardState,
  type TrackerDashboardPending,
  type TrackerDashboardReady,
  type TrackerDashboardUnavailable,
} from './useTrackerDashboard';
