/**
 * Tests for IMMERSION_TRACKER Stage 2b — Flush persistence to IndexedDB.
 * ---------------------------------------------------------------------------
 * Required coverage (from user request):
 * - Flushing cells/totals writes the expected tracker DB records
 * - Repeated flush merges rather than overwrites incorrectly
 * - Local day aggregation works
 * - Learning-set totals and media totals both update
 * - WebTorrent exclusion still prevents writes (tested via tracker-runtime)
 * - Write failures are swallowed/non-fatal
 * - Old DB deletion helper still uncalled
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExposureCell, TimeTotals } from '@/features/player/tracker/types';
import { emptyTotals } from '@/features/player/tracker/engine';

/* ------------------------------------------------------------------------ */
/* Mock DB module                                                            */
/* ------------------------------------------------------------------------ */

// In-memory stores for the mock
const mockExposureCells = new Map<string, ExposureCell>();
const mockLearningSets = new Map<string, any>();
const mockMedia = new Map<string, any>();
const mockMediaDaily = new Map<string, any>();
const mockDaily = new Map<string, any>();

vi.mock('@/features/player/tracker/db', () => ({
  getExposureCell: vi.fn((key: string) =>
    Promise.resolve(mockExposureCells.get(key) ?? null),
  ),
  putExposureCell: vi.fn((cell: ExposureCell) => {
    mockExposureCells.set(cell.cellKey, cell);
    return Promise.resolve(true);
  }),
  getLearningSet: vi.fn((id: string) =>
    Promise.resolve(mockLearningSets.get(id) ?? null),
  ),
  putLearningSet: vi.fn((record: any) => {
    mockLearningSets.set(record.learningSetId, record);
    return Promise.resolve(true);
  }),
  getMedia: vi.fn((id: string) =>
    Promise.resolve(mockMedia.get(id) ?? null),
  ),
  putMedia: vi.fn((record: any) => {
    mockMedia.set(record.mediaId, record);
    return Promise.resolve(true);
  }),
  getMediaDaily: vi.fn((key: { learningSetId: string; localDay: string }) =>
    Promise.resolve(mockMediaDaily.get(`${key.learningSetId}:${key.localDay}`) ?? null),
  ),
  putMediaDaily: vi.fn((record: any) => {
    mockMediaDaily.set(`${record.learningSetId}:${record.localDay}`, record);
    return Promise.resolve(true);
  }),
  getDaily: vi.fn((localDay: string) =>
    Promise.resolve(mockDaily.get(localDay) ?? null),
  ),
  putDaily: vi.fn((record: any) => {
    mockDaily.set(record.localDay, record);
    return Promise.resolve(true);
  }),
}));

// Import after mock setup
const { flushTrackerData } = await import(
  '@/features/player/tracker/tracker-flush'
);
const { getLocalDay } = await import(
  '@/features/player/tracker/local-day'
);

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

function makeCell(
  learningSetId: string,
  roundedSecond: number,
  overrides: Partial<ExposureCell> = {},
): ExposureCell {
  const cellKey = `${learningSetId}:${roundedSecond}`;
  return {
    cellKey,
    learningSetId,
    roundedSecond,
    foregroundWatchMs: 5000,
    effectiveExposureMs: 5000,
    passCount: 1,
    lastSeenAt: Date.now(),
    hasCoverage: true,
    subtitleExposureMs: 0,
    pauseCount: 0,
    manualBackwardSeekCount: 0,
    mineCount: 0,
    ...overrides,
  };
}

function makeTotals(overrides: Partial<TimeTotals> = {}): TimeTotals {
  return {
    ...emptyTotals(),
    foregroundWatchMs: 10000,
    mediaProgressMs: 8000,
    effectiveExposureMs: 7500,
    ...overrides,
  };
}

const MEDIA_ID = 'abc123def456';
const LS_ID = `${MEDIA_ID}:sub789`;

/* ------------------------------------------------------------------------ */
/* Tests                                                                    */
/* ------------------------------------------------------------------------ */

describe('tracker-flush', () => {
  beforeEach(() => {
    mockExposureCells.clear();
    mockLearningSets.clear();
    mockMedia.clear();
    mockMediaDaily.clear();
    mockDaily.clear();
    vi.clearAllMocks();
  });

  /* -------------------------------------------------------------------- */
  /* getLocalDay                                                           */
  /* -------------------------------------------------------------------- */

  describe('getLocalDay', () => {
    it('returns YYYY-MM-DD format', () => {
      const day = getLocalDay();
      expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns a valid date', () => {
      const day = getLocalDay();
      const [y, m, d] = day.split('-').map(Number);
      expect(y).toBeGreaterThan(2020);
      expect(m).toBeGreaterThanOrEqual(1);
      expect(m).toBeLessThanOrEqual(12);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(31);
    });
  });

  /* -------------------------------------------------------------------- */
  /* Exposure cell writes                                                  */
  /* -------------------------------------------------------------------- */

  describe('flushTrackerData — exposure cells', () => {
    it('writes cells to the exposure_cells store', async () => {
      const cells = new Map<string, ExposureCell>();
      const cell = makeCell(LS_ID, 42);
      cells.set(cell.cellKey, cell);

      await flushTrackerData(cells, makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 1024,
        mimeType: 'video/mp4',
      });

      expect(mockExposureCells.size).toBe(1);
      const stored = mockExposureCells.get(cell.cellKey);
      expect(stored).toBeDefined();
      expect(stored!.foregroundWatchMs).toBe(5000);
      expect(stored!.roundedSecond).toBe(42);
    });

    it('writes multiple cells', async () => {
      const cells = new Map<string, ExposureCell>();
      const cell1 = makeCell(LS_ID, 5);
      const cell2 = makeCell(LS_ID, 6);
      const cell3 = makeCell(LS_ID, 7);
      cells.set(cell1.cellKey, cell1);
      cells.set(cell2.cellKey, cell2);
      cells.set(cell3.cellKey, cell3);

      await flushTrackerData(cells, makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      expect(mockExposureCells.size).toBe(3);
    });

    it('handles empty cells map gracefully', async () => {
      const cells = new Map<string, ExposureCell>();

      // Should not throw
      await flushTrackerData(cells, makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      expect(mockExposureCells.size).toBe(0);
    });
  });

  /* -------------------------------------------------------------------- */
  /* Repeated flush merges (not overwrites)                                */
  /* -------------------------------------------------------------------- */

  describe('flushTrackerData — merge correctness', () => {
    it('merges exposure cells additively across flushes', async () => {
      const cell = makeCell(LS_ID, 10, { foregroundWatchMs: 3000 });

      // First flush
      const cells1 = new Map<string, ExposureCell>();
      cells1.set(cell.cellKey, cell);
      await flushTrackerData(cells1, makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      expect(mockExposureCells.get(cell.cellKey)!.foregroundWatchMs).toBe(3000);

      // Second flush — same cell, different value
      const cell2 = makeCell(LS_ID, 10, { foregroundWatchMs: 2000 });
      const cells2 = new Map<string, ExposureCell>();
      cells2.set(cell2.cellKey, cell2);
      await flushTrackerData(cells2, makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      // Should be additive, not overwritten
      expect(mockExposureCells.get(cell.cellKey)!.foregroundWatchMs).toBe(5000);
    });

    it('merges learning set totals additively', async () => {
      const totals1 = makeTotals({ foregroundWatchMs: 3000 });
      const totals2 = makeTotals({ foregroundWatchMs: 2000 });

      await flushTrackerData(new Map(), totals1, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      await flushTrackerData(new Map(), totals2, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      const stored = mockLearningSets.get(LS_ID);
      expect(stored).toBeDefined();
      expect(stored.totals.foregroundWatchMs).toBe(5000);
    });

    it('merges media totals additively', async () => {
      const totals1 = makeTotals({ foregroundWatchMs: 4000 });
      const totals2 = makeTotals({ foregroundWatchMs: 6000 });

      await flushTrackerData(new Map(), totals1, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      await flushTrackerData(new Map(), totals2, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      const stored = mockMedia.get(MEDIA_ID);
      expect(stored).toBeDefined();
      expect(stored.totals.foregroundWatchMs).toBe(10000);
    });

    it('merges rate buckets additively', async () => {
      const totals1 = makeTotals({ rateBuckets: { normal: 1000, condensed: 500 } });
      const totals2 = makeTotals({ rateBuckets: { normal: 2000, 'fast-forward': 300 } });

      await flushTrackerData(new Map(), totals1, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      await flushTrackerData(new Map(), totals2, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      const stored = mockMedia.get(MEDIA_ID);
      expect(stored.totals.rateBuckets).toEqual({
        normal: 3000,
        condensed: 500,
        'fast-forward': 300,
      });
    });
  });

  /* -------------------------------------------------------------------- */
  /* Local day aggregation                                                 */
  /* -------------------------------------------------------------------- */

  describe('flushTrackerData — local day aggregation', () => {
    it('writes media_daily with correct local day key', async () => {
      const today = getLocalDay();

      await flushTrackerData(new Map(), makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      const key = `${LS_ID}:${today}`;
      expect(mockMediaDaily.has(key)).toBe(true);

      const stored = mockMediaDaily.get(key);
      expect(stored.localDay).toBe(today);
      expect(stored.foregroundWatchMs).toBe(10000);
    });

    it('writes daily with correct local day key', async () => {
      const today = getLocalDay();

      await flushTrackerData(new Map(), makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      expect(mockDaily.has(today)).toBe(true);
      const stored = mockDaily.get(today);
      expect(stored.foregroundWatchMs).toBe(10000);
    });

    it('merges media_daily additively for same day', async () => {
      const today = getLocalDay();
      const totals1 = makeTotals({ foregroundWatchMs: 3000 });
      const totals2 = makeTotals({ foregroundWatchMs: 7000 });

      await flushTrackerData(new Map(), totals1, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      await flushTrackerData(new Map(), totals2, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      const key = `${LS_ID}:${today}`;
      expect(mockMediaDaily.get(key).foregroundWatchMs).toBe(10000);
    });

    it('merges daily additively for same day', async () => {
      const today = getLocalDay();
      const totals1 = makeTotals({ foregroundWatchMs: 2000 });
      const totals2 = makeTotals({ foregroundWatchMs: 8000 });

      await flushTrackerData(new Map(), totals1, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      await flushTrackerData(new Map(), totals2, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      expect(mockDaily.get(today).foregroundWatchMs).toBe(10000);
    });
  });

  /* -------------------------------------------------------------------- */
  /* Learning-set and media parent totals                                  */
  /* -------------------------------------------------------------------- */

  describe('flushTrackerData — parent store totals', () => {
    it('creates learning set record with correct fields', async () => {
      await flushTrackerData(new Map(), makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      const stored = mockLearningSets.get(LS_ID);
      expect(stored).toBeDefined();
      expect(stored.learningSetId).toBe(LS_ID);
      expect(stored.mediaId).toBe(MEDIA_ID);
      expect(stored.subtitleId).toBe('sub789');
      expect(stored.totals.foregroundWatchMs).toBe(10000);
    });

    it('creates media record with correct fields', async () => {
      await flushTrackerData(new Map(), makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 1024,
        mimeType: 'video/mp4',
      });

      const stored = mockMedia.get(MEDIA_ID);
      expect(stored).toBeDefined();
      expect(stored.mediaId).toBe(MEDIA_ID);
      expect(stored.displayName).toBe('test.mp4');
      expect(stored.byteSize).toBe(1024);
      expect(stored.mimeType).toBe('video/mp4');
      expect(stored.firstSeenDay).toBe(getLocalDay());
      expect(stored.lastSeenDay).toBe(getLocalDay());
    });

    it('updates media displayName on subsequent flush', async () => {
      await flushTrackerData(new Map(), makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'old-name.mp4',
        byteSize: 0,
        mimeType: '',
      });

      await flushTrackerData(new Map(), makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'new-name.mp4',
        byteSize: 0,
        mimeType: '',
      });

      const stored = mockMedia.get(MEDIA_ID);
      expect(stored.displayName).toBe('new-name.mp4');
    });

    it('no-subtitle learningSetId extracts subtitleId as no-subtitle', async () => {
      const noSubLsId = `${MEDIA_ID}:no-subtitle`;

      await flushTrackerData(new Map(), makeTotals(), noSubLsId, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      const stored = mockLearningSets.get(noSubLsId);
      expect(stored.subtitleId).toBe('no-subtitle');
    });
  });

  /* -------------------------------------------------------------------- */
  /* Media daily flat field merge                                          */
  /* -------------------------------------------------------------------- */

  describe('flushTrackerData — media_daily field merge', () => {
    it('merges all flat fields additively', async () => {
      const totals1: TimeTotals = {
        foregroundWatchMs: 1000,
        mediaProgressMs: 800,
        uniqueCoverageMs: 600,
        effectiveExposureMs: 500,
        subtitleExposureMs: 300,
        condensedSkippedMs: 100,
        fastForwardWallMs: 50,
        fastForwardMediaMs: 40,
        rateBuckets: { normal: 900 },
        manualBackwardSeekCount: 2,
        mineCount: 1,
      };

      const totals2: TimeTotals = {
        foregroundWatchMs: 2000,
        mediaProgressMs: 1600,
        uniqueCoverageMs: 1200,
        effectiveExposureMs: 1000,
        subtitleExposureMs: 600,
        condensedSkippedMs: 200,
        fastForwardWallMs: 100,
        fastForwardMediaMs: 80,
        rateBuckets: { condensed: 1800 },
        manualBackwardSeekCount: 3,
        mineCount: 2,
      };

      await flushTrackerData(new Map(), totals1, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      await flushTrackerData(new Map(), totals2, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      const today = getLocalDay();
      const key = `${LS_ID}:${today}`;
      const stored = mockMediaDaily.get(key);

      expect(stored.foregroundWatchMs).toBe(3000);
      expect(stored.mediaProgressMs).toBe(2400);
      expect(stored.uniqueCoverageMs).toBe(1800);
      expect(stored.effectiveExposureMs).toBe(1500);
      expect(stored.subtitleExposureMs).toBe(900);
      expect(stored.condensedSkippedMs).toBe(300);
      expect(stored.fastForwardWallMs).toBe(150);
      expect(stored.fastForwardMediaMs).toBe(120);
      expect(stored.manualBackwardSeekCount).toBe(5);
      expect(stored.mineCount).toBe(3);
      expect(stored.rateBuckets).toEqual({ normal: 900, condensed: 1800 });
    });
  });

  /* -------------------------------------------------------------------- */
  /* Daily flat field merge                                                */
  /* -------------------------------------------------------------------- */

  describe('flushTrackerData — daily field merge', () => {
    it('merges all flat fields additively', async () => {
      const totals1: TimeTotals = {
        foregroundWatchMs: 5000,
        mediaProgressMs: 4000,
        uniqueCoverageMs: 3000,
        effectiveExposureMs: 2500,
        subtitleExposureMs: 1500,
        condensedSkippedMs: 500,
        fastForwardWallMs: 250,
        fastForwardMediaMs: 200,
        rateBuckets: { normal: 4500 },
        manualBackwardSeekCount: 1,
        mineCount: 0,
      };

      const totals2: TimeTotals = {
        foregroundWatchMs: 5000,
        mediaProgressMs: 4000,
        uniqueCoverageMs: 3000,
        effectiveExposureMs: 2500,
        subtitleExposureMs: 1500,
        condensedSkippedMs: 500,
        fastForwardWallMs: 250,
        fastForwardMediaMs: 200,
        rateBuckets: { normal: 4500 },
        manualBackwardSeekCount: 1,
        mineCount: 0,
      };

      await flushTrackerData(new Map(), totals1, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      await flushTrackerData(new Map(), totals2, LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      const today = getLocalDay();
      const stored = mockDaily.get(today);

      expect(stored.foregroundWatchMs).toBe(10000);
      expect(stored.mediaProgressMs).toBe(8000);
      expect(stored.uniqueCoverageMs).toBe(6000);
      expect(stored.effectiveExposureMs).toBe(5000);
      expect(stored.subtitleExposureMs).toBe(3000);
      expect(stored.condensedSkippedMs).toBe(1000);
      expect(stored.fastForwardWallMs).toBe(500);
      expect(stored.fastForwardMediaMs).toBe(400);
      expect(stored.manualBackwardSeekCount).toBe(2);
      expect(stored.mineCount).toBe(0);
      expect(stored.rateBuckets).toEqual({ normal: 9000 });
    });
  });

  /* -------------------------------------------------------------------- */
  /* Write failures are swallowed / non-fatal                              */
  /* -------------------------------------------------------------------- */

  describe('flushTrackerData — error swallowing', () => {
    it('does not throw when putExposureCell fails', async () => {
      const { putExposureCell } = await import('@/features/player/tracker/db');
      vi.mocked(putExposureCell).mockRejectedValueOnce(new Error('quota'));

      const cells = new Map<string, ExposureCell>();
      cells.set('key', makeCell(LS_ID, 5));

      // Should not throw
      await expect(
        flushTrackerData(cells, makeTotals(), LS_ID, {
          mediaId: MEDIA_ID,
          mediaName: 'test.mp4',
          byteSize: 0,
          mimeType: '',
        }),
      ).resolves.toBeUndefined();
    });

    it('does not throw when putLearningSet fails', async () => {
      const { putLearningSet } = await import('@/features/player/tracker/db');
      vi.mocked(putLearningSet).mockRejectedValueOnce(new Error('quota'));

      await expect(
        flushTrackerData(new Map(), makeTotals(), LS_ID, {
          mediaId: MEDIA_ID,
          mediaName: 'test.mp4',
          byteSize: 0,
          mimeType: '',
        }),
      ).resolves.toBeUndefined();
    });

    it('does not throw when putMedia fails', async () => {
      const { putMedia } = await import('@/features/player/tracker/db');
      vi.mocked(putMedia).mockRejectedValueOnce(new Error('quota'));

      await expect(
        flushTrackerData(new Map(), makeTotals(), LS_ID, {
          mediaId: MEDIA_ID,
          mediaName: 'test.mp4',
          byteSize: 0,
          mimeType: '',
        }),
      ).resolves.toBeUndefined();
    });

    it('does not throw when putMediaDaily fails', async () => {
      const { putMediaDaily } = await import('@/features/player/tracker/db');
      vi.mocked(putMediaDaily).mockRejectedValueOnce(new Error('quota'));

      await expect(
        flushTrackerData(new Map(), makeTotals(), LS_ID, {
          mediaId: MEDIA_ID,
          mediaName: 'test.mp4',
          byteSize: 0,
          mimeType: '',
        }),
      ).resolves.toBeUndefined();
    });

    it('does not throw when putDaily fails', async () => {
      const { putDaily } = await import('@/features/player/tracker/db');
      vi.mocked(putDaily).mockRejectedValueOnce(new Error('quota'));

      await expect(
        flushTrackerData(new Map(), makeTotals(), LS_ID, {
          mediaId: MEDIA_ID,
          mediaName: 'test.mp4',
          byteSize: 0,
          mimeType: '',
        }),
      ).resolves.toBeUndefined();
    });

    it('continues writing other stores when one fails', async () => {
      const { putExposureCell } = await import('@/features/player/tracker/db');
      vi.mocked(putExposureCell).mockRejectedValueOnce(new Error('quota'));

      const cells = new Map<string, ExposureCell>();
      cells.set('key', makeCell(LS_ID, 5));

      await flushTrackerData(cells, makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      // Parent stores should still be written (fire-and-forget)
      // The exposure cell write failed but parent stores proceed independently
      expect(mockLearningSets.has(LS_ID)).toBe(true);
      expect(mockMedia.has(MEDIA_ID)).toBe(true);
    });
  });

  /* -------------------------------------------------------------------- */
  /* Old DB deletion helper remains uncalled                               */
  /* -------------------------------------------------------------------- */

  describe('old DB deletion helper remains uncalled', () => {
    it('deleteOldMiningHistoryDB is not called by flushTrackerData', async () => {
      const oldDbMod = await import('@/features/player/tracker/old-db-gate');
      const spy = vi.spyOn(oldDbMod, 'deleteOldMiningHistoryDB');

      await flushTrackerData(new Map(), makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  /* -------------------------------------------------------------------- */
  /* WebTorrent exclusion (integration-level, not in flush itself)          */
  /* -------------------------------------------------------------------- */

  describe('WebTorrent exclusion', () => {
    it('flushTrackerData does not check isTrackerEnabled (caller must gate)', async () => {
      // The flush function itself does not check isTrackerEnabled —
      // that responsibility is in tracker-runtime.ts which skips
      // tracking entirely for torrent sources. The flush function
      // trusts its caller to provide valid data.
      //
      // This test verifies that flushTrackerData writes regardless
      // of tracker-enabled state (the gate is upstream).
      const cells = new Map<string, ExposureCell>();
      cells.set('key', makeCell(LS_ID, 5));

      await flushTrackerData(cells, makeTotals(), LS_ID, {
        mediaId: MEDIA_ID,
        mediaName: 'test.mp4',
        byteSize: 0,
        mimeType: '',
      });

      // Write happened (no isTrackerEnabled gate in flush)
      expect(mockExposureCells.size).toBe(1);
    });
  });
});
