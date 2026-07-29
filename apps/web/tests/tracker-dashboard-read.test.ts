/**
 * Unit tests for tracker-dashboard-read.ts.
 * ---------------------------------------------------------------------------
 * Tests:
 *   - Empty DB returns empty model with available: true
 *   - DB unavailable (all getters throw) returns available: false
 *   - Today summary derived from daily store
 *   - Today summary empty when no daily record for today
 *   - Media list sorted by lastSeenDay descending, then displayName
 *   - Learning sets grouped under parent media
 *   - Media with no learning sets renders empty array
 *   - i+1 Moments: cells bucketed into 30-second ranges
 *   - i+1 Moments: separate signal counts per bucket
 *   - i+1 Moments: cells across multiple learning sets produce separate groups
 *   - i+1 Moments: empty cells produce empty moments array
 *   - Mining archive: newest-first sort via createdAt
 *   - Mining archive: invalid entries filtered out
 *   - Mining archive: empty archive returns empty array
 *   - Full integration: all blocks populated together
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTrackerDashboard } from '@/features/player/tracker/tracker-dashboard-read';
import * as db from '@/features/player/tracker/db';
import type {
  MediaRecord,
  LearningSetRecord,
  DailyAggregate,
  ExposureCell,
  MiningArchiveEntry,
} from '@/features/player/tracker/types';

/* ------------------------------------------------------------------------ */
/* Fake data helpers                                                         */
/* ------------------------------------------------------------------------ */

function makeMedia(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    mediaId: `media-${Math.random().toString(36).slice(2, 8)}`,
    displayName: 'video.webm',
    byteSize: 1024,
    mimeType: 'video/webm',
    firstSeenDay: '2026-07-01',
    lastSeenDay: '2026-07-29',
    totals: {
      foregroundWatchMs: 60000,
      mediaProgressMs: 55000,
      uniqueCoverageMs: 50000,
      effectiveExposureMs: 45000,
      subtitleExposureMs: 30000,
      condensedSkippedMs: 5000,
      fastForwardWallMs: 2000,
      fastForwardMediaMs: 6000,
      rateBuckets: { '1': 30000, '2': 30000 },
      manualBackwardSeekCount: 3,
      mineCount: 1,
    },
    ...overrides,
  };
}

function makeLearningSet(overrides: Partial<LearningSetRecord> = {}): LearningSetRecord {
  return {
    learningSetId: `ls-${Math.random().toString(36).slice(2, 8)}`,
    mediaId: 'media-1',
    subtitleId: 'sub-1',
    totals: {
      foregroundWatchMs: 60000,
      mediaProgressMs: 55000,
      uniqueCoverageMs: 50000,
      effectiveExposureMs: 45000,
      subtitleExposureMs: 30000,
      condensedSkippedMs: 5000,
      fastForwardWallMs: 2000,
      fastForwardMediaMs: 6000,
      rateBuckets: {},
      manualBackwardSeekCount: 3,
      mineCount: 1,
    },
    ...overrides,
  };
}

function makeDaily(overrides: Partial<DailyAggregate> = {}): DailyAggregate {
  return {
    localDay: '2026-07-29',
    foregroundWatchMs: 120000,
    mediaProgressMs: 110000,
    uniqueCoverageMs: 100000,
    effectiveExposureMs: 90000,
    subtitleExposureMs: 60000,
    condensedSkippedMs: 10000,
    fastForwardWallMs: 4000,
    fastForwardMediaMs: 12000,
    rateBuckets: {},
    manualBackwardSeekCount: 5,
    mineCount: 2,
    ...overrides,
  };
}

function makeCell(overrides: Partial<ExposureCell> = {}): ExposureCell {
  return {
    cellKey: 'ls-1:30',
    learningSetId: 'ls-1',
    roundedSecond: 30,
    foregroundWatchMs: 1000,
    effectiveExposureMs: 800,
    passCount: 1,
    lastSeenAt: Date.now(),
    hasCoverage: true,
    subtitleExposureMs: 500,
    pauseCount: 1,
    manualBackwardSeekCount: 0,
    mineCount: 0,
    ...overrides,
  };
}

function makeArchiveEntry(
  overrides: Partial<MiningArchiveEntry> = {},
): MiningArchiveEntry {
  return {
    id: `arch-${Math.random().toString(36).slice(2, 8)}`,
    mediaId: 'media-1',
    learningSetId: 'ls-1',
    displayName: 'video.webm',
    rangeStart: 10,
    rangeEnd: 20,
    sentence: 'Hello world',
    localDay: '2026-07-29',
    createdAt: Date.now(),
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

describe('tracker-dashboard-read', () => {
  let getAllMediaSpy: ReturnType<typeof vi.spyOn>;
  let getAllLearningSetsSpy: ReturnType<typeof vi.spyOn>;
  let getAllDailySpy: ReturnType<typeof vi.spyOn>;
  let getAllExposureCellsSpy: ReturnType<typeof vi.spyOn>;
  let getAllMiningArchiveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    getAllMediaSpy = vi.spyOn(db, 'getAllMedia');
    getAllLearningSetsSpy = vi.spyOn(db, 'getAllLearningSets');
    getAllDailySpy = vi.spyOn(db, 'getAllDaily');
    getAllExposureCellsSpy = vi.spyOn(db, 'getAllExposureCells');
    getAllMiningArchiveSpy = vi.spyOn(db, 'getAllMiningArchive');

    // Default: all stores empty
    getAllMediaSpy.mockResolvedValue([]);
    getAllLearningSetsSpy.mockResolvedValue([]);
    getAllDailySpy.mockResolvedValue([]);
    getAllExposureCellsSpy.mockResolvedValue([]);
    getAllMiningArchiveSpy.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ---------------------------------------------------------------------- */
  /* Empty / unavailable                                                     */
  /* ---------------------------------------------------------------------- */

  it('returns empty model with available: true when all stores are empty', async () => {
    const model = await getTrackerDashboard();
    expect(model.available).toBe(true);
    expect(model.today.foregroundWatchMs).toBe(0);
    expect(model.mediaList).toEqual([]);
    expect(model.moments).toEqual([]);
    expect(model.archive).toEqual([]);
  });

  it('returns available: false when any store throws', async () => {
    getAllMediaSpy.mockRejectedValue(new Error('IndexedDB unavailable'));

    const model = await getTrackerDashboard();
    expect(model.available).toBe(false);
    expect(model.mediaList).toEqual([]);
    expect(model.moments).toEqual([]);
    expect(model.archive).toEqual([]);
  });

  it('returns available: false when all stores throw', async () => {
    getAllMediaSpy.mockRejectedValue(new Error('DB closed'));
    getAllLearningSetsSpy.mockRejectedValue(new Error('DB closed'));
    getAllDailySpy.mockRejectedValue(new Error('DB closed'));
    getAllExposureCellsSpy.mockRejectedValue(new Error('DB closed'));
    getAllMiningArchiveSpy.mockRejectedValue(new Error('DB closed'));

    const model = await getTrackerDashboard();
    expect(model.available).toBe(false);
  });

  /* ---------------------------------------------------------------------- */
  /* Today summary                                                           */
  /* ---------------------------------------------------------------------- */

  it('derives today summary from daily store', async () => {
    const today = makeDaily({
      foregroundWatchMs: 300000,
      subtitleExposureMs: 120000,
    });
    getAllDailySpy.mockResolvedValue([today]);

    const model = await getTrackerDashboard();
    expect(model.today.foregroundWatchMs).toBe(300000);
    expect(model.today.subtitleExposureMs).toBe(120000);
  });

  it('today summary is zeroed when no daily record exists for today', async () => {
    const otherDay = makeDaily({
      localDay: '2026-06-01',
      foregroundWatchMs: 99999,
    });
    getAllDailySpy.mockResolvedValue([otherDay]);

    const model = await getTrackerDashboard();
    expect(model.today.foregroundWatchMs).toBe(0);
    expect(model.today.localDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /* ---------------------------------------------------------------------- */
  /* Media list                                                              */
  /* ---------------------------------------------------------------------- */

  it('media list sorted by lastSeenDay descending', async () => {
    const older = makeMedia({
      mediaId: 'm-old',
      displayName: 'older.webm',
      lastSeenDay: '2026-07-01',
    });
    const newer = makeMedia({
      mediaId: 'm-new',
      displayName: 'newer.webm',
      lastSeenDay: '2026-07-29',
    });
    getAllMediaSpy.mockResolvedValue([older, newer]);

    const model = await getTrackerDashboard();
    expect(model.mediaList).toHaveLength(2);
    expect(model.mediaList[0]!.media.mediaId).toBe('m-new');
    expect(model.mediaList[1]!.media.mediaId).toBe('m-old');
  });

  it('media list sorted by displayName when lastSeenDay is equal', async () => {
    const a = makeMedia({
      mediaId: 'm-b',
      displayName: 'b-video.webm',
      lastSeenDay: '2026-07-29',
    });
    const b = makeMedia({
      mediaId: 'm-a',
      displayName: 'a-video.webm',
      lastSeenDay: '2026-07-29',
    });
    getAllMediaSpy.mockResolvedValue([a, b]);

    const model = await getTrackerDashboard();
    expect(model.mediaList[0]!.media.mediaId).toBe('m-a');
    expect(model.mediaList[1]!.media.mediaId).toBe('m-b');
  });

  it('learning sets grouped under parent media', async () => {
    const media = makeMedia({ mediaId: 'm1' });
    const ls1 = makeLearningSet({
      learningSetId: 'm1:sub-a',
      mediaId: 'm1',
      subtitleId: 'sub-a',
    });
    const ls2 = makeLearningSet({
      learningSetId: 'm1:sub-b',
      mediaId: 'm1',
      subtitleId: 'sub-b',
    });
    getAllMediaSpy.mockResolvedValue([media]);
    getAllLearningSetsSpy.mockResolvedValue([ls1, ls2]);

    const model = await getTrackerDashboard();
    expect(model.mediaList).toHaveLength(1);
    expect(model.mediaList[0]!.learningSets).toHaveLength(2);
    expect(model.mediaList[0]!.learningSets.map((ls) => ls.subtitleId).sort()).toEqual([
      'sub-a',
      'sub-b',
    ]);
  });

  it('learning sets sorted by learningSetId deterministically', async () => {
    const media = makeMedia({ mediaId: 'm1' });
    // Insert in reverse order to verify sort
    const lsC = makeLearningSet({ learningSetId: 'm1:zzz', mediaId: 'm1', subtitleId: 'zzz' });
    const lsA = makeLearningSet({ learningSetId: 'm1:aaa', mediaId: 'm1', subtitleId: 'aaa' });
    const lsB = makeLearningSet({ learningSetId: 'm1:mmm', mediaId: 'm1', subtitleId: 'mmm' });
    getAllMediaSpy.mockResolvedValue([media]);
    getAllLearningSetsSpy.mockResolvedValue([lsC, lsA, lsB]);

    const model = await getTrackerDashboard();
    expect(model.mediaList[0]!.learningSets.map((ls) => ls.learningSetId)).toEqual([
      'm1:aaa',
      'm1:mmm',
      'm1:zzz',
    ]);
  });

  it('media with no learning sets has empty array', async () => {
    const media = makeMedia({ mediaId: 'm-orphan' });
    getAllMediaSpy.mockResolvedValue([media]);

    const model = await getTrackerDashboard();
    expect(model.mediaList).toHaveLength(1);
    expect(model.mediaList[0]!.learningSets).toEqual([]);
  });

  /* ---------------------------------------------------------------------- */
  /* i+1 Moments                                                             */
  /* ---------------------------------------------------------------------- */

  it('cells bucketed into 30-second ranges', async () => {
    const cell0 = makeCell({
      cellKey: 'ls-1:5',
      learningSetId: 'ls-1',
      roundedSecond: 5,
      foregroundWatchMs: 1000,
      passCount: 1,
      pauseCount: 0,
      manualBackwardSeekCount: 0,
      mineCount: 0,
    });
    const cell31 = makeCell({
      cellKey: 'ls-1:31',
      learningSetId: 'ls-1',
      roundedSecond: 31,
      foregroundWatchMs: 2000,
      passCount: 2,
      pauseCount: 1,
      manualBackwardSeekCount: 1,
      mineCount: 0,
    });
    const cell60 = makeCell({
      cellKey: 'ls-1:60',
      learningSetId: 'ls-1',
      roundedSecond: 60,
      foregroundWatchMs: 500,
      passCount: 1,
      pauseCount: 0,
      manualBackwardSeekCount: 0,
      mineCount: 1,
    });

    getAllExposureCellsSpy.mockResolvedValue([cell0, cell31, cell60]);

    const model = await getTrackerDashboard();
    expect(model.moments).toHaveLength(1);
    const group = model.moments[0]!;
    expect(group.buckets).toHaveLength(3);

    // Bucket 0-30
    expect(group.buckets[0]!.bucketStart).toBe(0);
    expect(group.buckets[0]!.bucketEnd).toBe(30);
    expect(group.buckets[0]!.foregroundWatchMs).toBe(1000);

    // Bucket 30-60
    expect(group.buckets[1]!.bucketStart).toBe(30);
    expect(group.buckets[1]!.bucketEnd).toBe(60);
    expect(group.buckets[1]!.foregroundWatchMs).toBe(2000);
    expect(group.buckets[1]!.pauseCount).toBe(1);
    expect(group.buckets[1]!.manualBackwardSeekCount).toBe(1);

    // Bucket 60-90
    expect(group.buckets[2]!.bucketStart).toBe(60);
    expect(group.buckets[2]!.bucketEnd).toBe(90);
    expect(group.buckets[2]!.mineCount).toBe(1);
  });

  it('cells in same bucket are aggregated', async () => {
    const cell1 = makeCell({
      cellKey: 'ls-1:10',
      learningSetId: 'ls-1',
      roundedSecond: 10,
      foregroundWatchMs: 1000,
      passCount: 1,
      pauseCount: 1,
      manualBackwardSeekCount: 0,
      mineCount: 0,
    });
    const cell2 = makeCell({
      cellKey: 'ls-1:15',
      learningSetId: 'ls-1',
      roundedSecond: 15,
      foregroundWatchMs: 2000,
      passCount: 1,
      pauseCount: 0,
      manualBackwardSeekCount: 2,
      mineCount: 1,
    });

    getAllExposureCellsSpy.mockResolvedValue([cell1, cell2]);

    const model = await getTrackerDashboard();
    const group = model.moments[0]!;
    expect(group.buckets).toHaveLength(1);
    expect(group.buckets[0]!.foregroundWatchMs).toBe(3000);
    expect(group.buckets[0]!.passCount).toBe(2);
    expect(group.buckets[0]!.pauseCount).toBe(1);
    expect(group.buckets[0]!.manualBackwardSeekCount).toBe(2);
    expect(group.buckets[0]!.mineCount).toBe(1);
  });

  it('cells across multiple learning sets produce separate groups', async () => {
    const cellA = makeCell({
      cellKey: 'ls-a:5',
      learningSetId: 'ls-a',
      roundedSecond: 5,
    });
    const cellB = makeCell({
      cellKey: 'ls-b:5',
      learningSetId: 'ls-b',
      roundedSecond: 5,
    });

    getAllExposureCellsSpy.mockResolvedValue([cellA, cellB]);

    const model = await getTrackerDashboard();
    expect(model.moments).toHaveLength(2);
    expect(model.moments[0]!.learningSetId).toBe('ls-a');
    expect(model.moments[1]!.learningSetId).toBe('ls-b');
  });

  it('empty cells produce empty moments array', async () => {
    getAllExposureCellsSpy.mockResolvedValue([]);

    const model = await getTrackerDashboard();
    expect(model.moments).toEqual([]);
  });

  it('mediaDurationSec derived from max roundedSecond + 1', async () => {
    const cell = makeCell({
      cellKey: 'ls-1:59',
      learningSetId: 'ls-1',
      roundedSecond: 59,
    });

    getAllExposureCellsSpy.mockResolvedValue([cell]);

    const model = await getTrackerDashboard();
    expect(model.moments[0]!.mediaDurationSec).toBe(60);
  });

  /* ---------------------------------------------------------------------- */
  /* Mining archive                                                           */
  /* ---------------------------------------------------------------------- */

  it('archive entries sorted newest-first by createdAt', async () => {
    const old = makeArchiveEntry({ id: 'old', createdAt: 1000, sentence: 'Old' });
    const mid = makeArchiveEntry({ id: 'mid', createdAt: 2000, sentence: 'Mid' });
    const recent = makeArchiveEntry({ id: 'recent', createdAt: 3000, sentence: 'Recent' });

    getAllMiningArchiveSpy.mockResolvedValue([old, mid, recent]);

    const model = await getTrackerDashboard();
    expect(model.archive).toHaveLength(3);
    expect(model.archive.map((e) => e.sentence)).toEqual(['Recent', 'Mid', 'Old']);
  });

  it('invalid archive entries filtered out', async () => {
    const good = makeArchiveEntry({ id: 'good', sentence: 'Valid' });
    const bad = {
      id: '',
      mediaId: 'x',
      learningSetId: 'x',
      displayName: 123,
      rangeStart: NaN,
      rangeEnd: null,
      sentence: 456,
      localDay: 'x',
      createdAt: 100,
    } as unknown as MiningArchiveEntry;

    getAllMiningArchiveSpy.mockResolvedValue([good, bad]);

    const model = await getTrackerDashboard();
    expect(model.archive).toHaveLength(1);
    expect(model.archive[0]!.id).toBe('good');
  });

  it('archive entries missing mediaId are filtered out', async () => {
    const entry = makeArchiveEntry({ id: 'no-media' });
    (entry as unknown as Record<string, unknown>).mediaId = '';

    getAllMiningArchiveSpy.mockResolvedValue([entry]);

    const model = await getTrackerDashboard();
    expect(model.archive).toHaveLength(0);
  });

  it('archive entries missing learningSetId are filtered out', async () => {
    const entry = makeArchiveEntry({ id: 'no-ls' });
    (entry as unknown as Record<string, unknown>).learningSetId = '';

    getAllMiningArchiveSpy.mockResolvedValue([entry]);

    const model = await getTrackerDashboard();
    expect(model.archive).toHaveLength(0);
  });

  it('archive entries missing localDay are filtered out', async () => {
    const entry = makeArchiveEntry({ id: 'no-day' });
    (entry as unknown as Record<string, unknown>).localDay = '';

    getAllMiningArchiveSpy.mockResolvedValue([entry]);

    const model = await getTrackerDashboard();
    expect(model.archive).toHaveLength(0);
  });

  it('empty archive returns empty array', async () => {
    getAllMiningArchiveSpy.mockResolvedValue([]);

    const model = await getTrackerDashboard();
    expect(model.archive).toEqual([]);
  });

  /* ---------------------------------------------------------------------- */
  /* Full integration                                                         */
  /* ---------------------------------------------------------------------- */

  it('all blocks populated together', async () => {
    const media = makeMedia({ mediaId: 'm1', displayName: 'anime.webm' });
    const ls = makeLearningSet({
      learningSetId: 'm1:sub',
      mediaId: 'm1',
      subtitleId: 'sub',
    });
    const daily = makeDaily({ localDay: '2026-07-29', foregroundWatchMs: 180000 });
    const cell = makeCell({
      cellKey: 'm1:sub:45',
      learningSetId: 'm1:sub',
      roundedSecond: 45,
    });
    const archive = makeArchiveEntry({
      id: 'a1',
      mediaId: 'm1',
      learningSetId: 'm1:sub',
      displayName: 'anime.webm',
    });

    getAllMediaSpy.mockResolvedValue([media]);
    getAllLearningSetsSpy.mockResolvedValue([ls]);
    getAllDailySpy.mockResolvedValue([daily]);
    getAllExposureCellsSpy.mockResolvedValue([cell]);
    getAllMiningArchiveSpy.mockResolvedValue([archive]);

    const model = await getTrackerDashboard();

    // Today
    expect(model.today.foregroundWatchMs).toBe(180000);

    // Media list
    expect(model.mediaList).toHaveLength(1);
    expect(model.mediaList[0]!.media.displayName).toBe('anime.webm');
    expect(model.mediaList[0]!.learningSets).toHaveLength(1);

    // Moments
    expect(model.moments).toHaveLength(1);
    expect(model.moments[0]!.learningSetId).toBe('m1:sub');

    // Archive
    expect(model.archive).toHaveLength(1);
    expect(model.archive[0]!.displayName).toBe('anime.webm');
  });
});
