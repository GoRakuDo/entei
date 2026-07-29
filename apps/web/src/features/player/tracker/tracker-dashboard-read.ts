/**
 * IMMERSION_TRACKER — Dashboard read model / selector.
 * ---------------------------------------------------------------------------
 * Stage 3A: Pure typed read model for the /tracker/ page.
 *
 * Reads from existing tracker IndexedDB APIs and derives a stable,
 * read-only model for exactly four dashboard blocks:
 *   1. Today summary — today's aggregate totals
 *   2. Media list — media parent records with learning sets grouped under each
 *   3. i+1 Moments — exposure cells grouped into 30-second buckets per media/LS
 *   4. Mining archive — newest-first successful archive entries
 *
 * Design:
 *   - Returns an empty model on unopened/empty/unavailable IndexedDB.
 *   - Never throws — all errors produce a typed fallback.
 *   - Never blocks player playback (async, non-destructive reads).
 *   - No writes, no deletion, no export/import, no old DB migration.
 * ---------------------------------------------------------------------------
 */

import {
  getAllMedia,
  getAllLearningSets,
  getAllDaily,
  getAllExposureCells,
  getAllMiningArchive,
} from './db';
import { getLocalDay } from './local-day';
import type {
  MediaRecord,
  LearningSetRecord,
  DailyAggregate,
  ExposureCell,
  MiningArchiveEntry,
  TimeTotals,
} from './types';

/* ------------------------------------------------------------------------ */
/* Dashboard read model types                                                */
/* ------------------------------------------------------------------------ */

/** Today's summary — derived from the daily store for the current local day. */
export interface TodaySummary {
  /** Local day key (YYYY-MM-DD). */
  localDay: string;
  foregroundWatchMs: number;
  mediaProgressMs: number;
  subtitleExposureMs: number;
  condensedSkippedMs: number;
  fastForwardWallMs: number;
  fastForwardMediaMs: number;
}

/** A learning set grouped under its parent media. */
export interface LearningSetItem {
  learningSetId: string;
  mediaId: string;
  subtitleId: string;
  totals: TimeTotals;
}

/** A media record with its learning sets nested underneath. */
export interface MediaWithLearningSets {
  media: MediaRecord;
  learningSets: LearningSetItem[];
}

/** One 30-second bucket within the i+1 Moments view. */
export interface MomentBucket {
  /** Bucket start second (0, 30, 60, …). */
  bucketStart: number;
  /** Bucket end second (exclusive). */
  bucketEnd: number;
  /** Aggregate foregroundWatchMs across all cells in this bucket. */
  foregroundWatchMs: number;
  /** Aggregate passCount (distinct contiguous passes). */
  passCount: number;
  /** Aggregate pauseCount (playing→paused transitions). */
  pauseCount: number;
  /** Aggregate manualBackwardSeekCount. */
  manualBackwardSeekCount: number;
  /** Aggregate mineCount (Anki export successes). */
  mineCount: number;
}

/** i+1 Moments for a single learning set, bucketed into 30-second ranges. */
export interface MomentGroup {
  mediaId: string;
  learningSetId: string;
  /** Duration of the media in seconds (max roundedSecond + 1, or 0). */
  mediaDurationSec: number;
  /** Buckets sorted by bucketStart ascending. */
  buckets: MomentBucket[];
}

/** A mining archive entry in the read model (newest-first). */
export interface ArchiveReadEntry {
  id: string;
  mediaId: string;
  learningSetId: string;
  displayName: string;
  rangeStart: number;
  rangeEnd: number;
  sentence: string;
  localDay: string;
  createdAt: number;
}

/** Full dashboard read model. */
export interface TrackerDashboardReadModel {
  /** Whether the tracker DB was accessible. */
  available: boolean;
  today: TodaySummary;
  mediaList: MediaWithLearningSets[];
  moments: MomentGroup[];
  archive: ArchiveReadEntry[];
}

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** 30-second bucket width in timeline seconds. */
const BUCKET_WIDTH = 30;

/* ------------------------------------------------------------------------ */
/* Today summary                                                             */
/* ------------------------------------------------------------------------ */

function deriveTodaySummary(dailies: DailyAggregate[]): TodaySummary {
  const localDay = getLocalDay();
  const today = dailies.find((d) => d.localDay === localDay);

  if (!today) {
    return {
      localDay,
      foregroundWatchMs: 0,
      mediaProgressMs: 0,
      subtitleExposureMs: 0,
      condensedSkippedMs: 0,
      fastForwardWallMs: 0,
      fastForwardMediaMs: 0,
    };
  }

  return {
    localDay: today.localDay,
    foregroundWatchMs: today.foregroundWatchMs,
    mediaProgressMs: today.mediaProgressMs,
    subtitleExposureMs: today.subtitleExposureMs,
    condensedSkippedMs: today.condensedSkippedMs,
    fastForwardWallMs: today.fastForwardWallMs,
    fastForwardMediaMs: today.fastForwardMediaMs,
  };
}

/* ------------------------------------------------------------------------ */
/* Media list                                                                */
/* ------------------------------------------------------------------------ */

function deriveMediaList(
  mediaRecords: MediaRecord[],
  learningSets: LearningSetRecord[],
): MediaWithLearningSets[] {
  // Index learning sets by mediaId
  const lsByMedia = new Map<string, LearningSetItem[]>();
  for (const ls of learningSets) {
    const list = lsByMedia.get(ls.mediaId) ?? [];
    list.push({
      learningSetId: ls.learningSetId,
      mediaId: ls.mediaId,
      subtitleId: ls.subtitleId,
      totals: ls.totals,
    });
    lsByMedia.set(ls.mediaId, list);
  }

  // Return media records sorted by lastSeenDay descending, then displayName.
  // Learning sets within each media are sorted by learningSetId for determinism.
  return mediaRecords
    .map((media) => ({
      media,
      learningSets: (lsByMedia.get(media.mediaId) ?? []).sort((a, b) =>
        a.learningSetId.localeCompare(b.learningSetId),
      ),
    }))
    .sort((a, b) => {
      const dayCmp = b.media.lastSeenDay.localeCompare(a.media.lastSeenDay);
      if (dayCmp !== 0) return dayCmp;
      return a.media.displayName.localeCompare(b.media.displayName);
    });
}

/* ------------------------------------------------------------------------ */
/* i+1 Moments — 30-second bucketing                                        */
/* ------------------------------------------------------------------------ */

/**
 * Derive 30-second moment buckets from exposure cells.
 *
 * Groups cells by learningSetId, then buckets by floor(roundedSecond / 30).
 * Each bucket retains separate signal counts (pass, pause, backward seek, mine)
 * — no single difficulty score is manufactured.
 */
function deriveMoments(cells: ExposureCell[]): MomentGroup[] {
  // Group cells by learningSetId
  const cellsByLS = new Map<string, ExposureCell[]>();
  for (const cell of cells) {
    const list = cellsByLS.get(cell.learningSetId) ?? [];
    list.push(cell);
    cellsByLS.set(cell.learningSetId, list);
  }

  // Build a mediaId lookup from cells' learningSetId prefix
  // learningSetId format: "mediaId:subtitleId" or "mediaId:no-subtitle"
  const mediaIdByLS = new Map<string, string>();
  for (const cell of cells) {
    if (!mediaIdByLS.has(cell.learningSetId)) {
      // Extract mediaId by finding which media record's mediaId is a prefix
      const colonIdx = cell.learningSetId.indexOf(':');
      const candidateMediaId =
        colonIdx >= 0 ? cell.learningSetId.slice(0, colonIdx) : cell.learningSetId;
      mediaIdByLS.set(cell.learningSetId, candidateMediaId);
    }
  }

  const groups: MomentGroup[] = [];

  for (const [lsId, lsCells] of cellsByLS) {
    const mediaId = mediaIdByLS.get(lsId) ?? '';

    // Determine media duration from max roundedSecond
    let maxSecond = 0;
    for (const c of lsCells) {
      if (c.roundedSecond > maxSecond) maxSecond = c.roundedSecond;
    }
    const mediaDurationSec = maxSecond + 1;

    // Bucket cells into 30-second ranges
    const bucketMap = new Map<number, MomentBucket>();
    for (const cell of lsCells) {
      const bucketStart = Math.floor(cell.roundedSecond / BUCKET_WIDTH) * BUCKET_WIDTH;
      const bucketEnd = bucketStart + BUCKET_WIDTH;

      let bucket = bucketMap.get(bucketStart);
      if (!bucket) {
        bucket = {
          bucketStart,
          bucketEnd,
          foregroundWatchMs: 0,
          passCount: 0,
          pauseCount: 0,
          manualBackwardSeekCount: 0,
          mineCount: 0,
        };
        bucketMap.set(bucketStart, bucket);
      }

      bucket.foregroundWatchMs += cell.foregroundWatchMs;
      bucket.passCount += cell.passCount;
      bucket.pauseCount += cell.pauseCount;
      bucket.manualBackwardSeekCount += cell.manualBackwardSeekCount;
      bucket.mineCount += cell.mineCount;
    }

    const buckets = Array.from(bucketMap.values()).sort(
      (a, b) => a.bucketStart - b.bucketStart,
    );

    groups.push({ mediaId, learningSetId: lsId, mediaDurationSec, buckets });
  }

  // Sort by mediaId, then learningSetId for stable output
  groups.sort((a, b) => {
    const mediaCmp = a.mediaId.localeCompare(b.mediaId);
    if (mediaCmp !== 0) return mediaCmp;
    return a.learningSetId.localeCompare(b.learningSetId);
  });

  return groups;
}

/* ------------------------------------------------------------------------ */
/* Mining archive — newest-first                                             */
/* ------------------------------------------------------------------------ */

function deriveArchive(entries: MiningArchiveEntry[]): ArchiveReadEntry[] {
  return entries
    .filter(
      (e) =>
        typeof e.id === 'string' &&
        e.id.length > 0 &&
        typeof e.mediaId === 'string' &&
        e.mediaId.length > 0 &&
        typeof e.learningSetId === 'string' &&
        e.learningSetId.length > 0 &&
        typeof e.displayName === 'string' &&
        typeof e.rangeStart === 'number' &&
        Number.isFinite(e.rangeStart) &&
        typeof e.rangeEnd === 'number' &&
        Number.isFinite(e.rangeEnd) &&
        typeof e.sentence === 'string' &&
        typeof e.localDay === 'string' &&
        e.localDay.length > 0,
    )
    .map((e) => ({
      id: e.id,
      mediaId: e.mediaId,
      learningSetId: e.learningSetId,
      displayName: e.displayName,
      rangeStart: e.rangeStart,
      rangeEnd: e.rangeEnd,
      sentence: e.sentence,
      localDay: e.localDay,
      createdAt: e.createdAt ?? 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/* ------------------------------------------------------------------------ */
/* Empty model                                                               */
/* ------------------------------------------------------------------------ */

function emptyModel(): TrackerDashboardReadModel {
  return {
    available: false,
    today: {
      localDay: getLocalDay(),
      foregroundWatchMs: 0,
      mediaProgressMs: 0,
      subtitleExposureMs: 0,
      condensedSkippedMs: 0,
      fastForwardWallMs: 0,
      fastForwardMediaMs: 0,
    },
    mediaList: [],
    moments: [],
    archive: [],
  };
}

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Read the full tracker dashboard model from IndexedDB.
 *
 * Returns a stable typed read model that can feed UI components directly.
 * On unavailable/empty/unopened DB, returns an empty model with
 * `available: false` — never throws.
 *
 * No writes, no mutation, no player interference.
 */
export async function getTrackerDashboard(): Promise<TrackerDashboardReadModel> {
  try {
    const [mediaRecords, learningSets, dailies, cells, archiveRaw] =
      await Promise.all([
        getAllMedia(),
        getAllLearningSets(),
        getAllDaily(),
        getAllExposureCells(),
        getAllMiningArchive(),
      ]);

    // If all stores are empty, the DB is either uninitialized or fresh.
    // Distinguish: if getAllMedia returns [], treat as empty but available.
    const model: TrackerDashboardReadModel = {
      available: true,
      today: deriveTodaySummary(dailies),
      mediaList: deriveMediaList(mediaRecords, learningSets),
      moments: deriveMoments(cells),
      archive: deriveArchive(archiveRaw),
    };

    return model;
  } catch {
    return emptyModel();
  }
}
