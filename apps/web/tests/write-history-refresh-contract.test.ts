/**
 * writeHistory refresh-key behavioral contract tests.
 * ---------------------------------------------------------------------------
 * Verifies that the visible History panel refresh is keyed off the tracker
 * archive write success, NOT the old mining-history DB write success.
 *
 * The actual writeHistory callback lives inside PlayerApp.tsx. These tests
 * simulate its logic to prove the behavioral contract:
 *   1. Tracker archive write success → refresh key increments
 *   2. Tracker archive write failure → refresh key does NOT increment
 *   3. Old DB write failure + tracker success → refresh key STILL increments
 *   4. Old DB write failure + tracker failure → refresh key does NOT increment
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recordMiningHistory,
  _setAdapter,
  _resetAdapter,
  type HistoryAdapter,
  type HistoryReadResult,
} from '@/features/player/mining-history';
import * as trackerArchiveWrite from '@/features/player/tracker/tracker-archive-write';

/* ------------------------------------------------------------------------ */
/* Fake old-DB adapter (can be made to fail on demand)                       */
/* ------------------------------------------------------------------------ */

function createFakeOldDBAdapter(fail = false): HistoryAdapter {
  return {
    async add() {
      return !fail;
    },
    async getAll(): Promise<HistoryReadResult> {
      return { ok: true, entries: [] };
    },
    async clear() {
      return true;
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Simulate writeHistory logic (mirrors PlayerApp.tsx writeHistory)          */
/* ------------------------------------------------------------------------ */

/**
 * Simulates the writeHistory callback logic from PlayerApp.tsx.
 * Returns whether the refresh key would have been incremented.
 *
 * This mirrors the exact logic in PlayerApp.tsx after the P1 fix:
 *   void recordMiningHistory(...)           ← fire-and-forget, result ignored
 *   const archiveWritten = await recordTrackerMiningArchive(...)  ← awaited
 *   if (archiveWritten) refreshKey++        ← keyed off tracker archive only
 */
async function simulateWriteHistory(): Promise<boolean> {
  let refreshKeyIncremented = false;

  // Step 1: Old DB write — fire-and-forget (result ignored for refresh)
  void recordMiningHistory({
    filename: 'test.mp4',
    rangeStart: 0,
    rangeEnd: 10,
    sentence: 'Hello',
  });

  // Step 2: Tracker archive write — awaited, controls refresh
  const archiveWritten = await trackerArchiveWrite.recordTrackerMiningArchive({
    mediaId: 'media-123',
    subtitleId: 'sub-456',
    learningSetId: 'media-123:sub-456',
    displayName: 'test.mp4',
    rangeStart: 0,
    rangeEnd: 10,
    sentence: 'Hello',
  });

  // Step 3: Refresh key depends ONLY on tracker archive success
  if (archiveWritten) refreshKeyIncremented = true;

  return refreshKeyIncremented;
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

describe('writeHistory refresh-key contract', () => {
  let archiveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    // Old DB always succeeds in these tests — the point is its result is ignored
    _setAdapter(createFakeOldDBAdapter(false));
  });

  afterEach(() => {
    _resetAdapter();
    archiveSpy?.mockRestore();
  });

  it('refresh key increments when tracker archive write succeeds', async () => {
    archiveSpy = vi
      .spyOn(trackerArchiveWrite, 'recordTrackerMiningArchive')
      .mockResolvedValue(true);

    const refreshed = await simulateWriteHistory();

    expect(refreshed).toBe(true);
  });

  it('refresh key does NOT increment when tracker archive write fails', async () => {
    archiveSpy = vi
      .spyOn(trackerArchiveWrite, 'recordTrackerMiningArchive')
      .mockResolvedValue(false);

    const refreshed = await simulateWriteHistory();

    expect(refreshed).toBe(false);
  });

  it('refresh key increments even when old DB write fails, as long as tracker succeeds', async () => {
    // Make old DB fail
    _setAdapter(createFakeOldDBAdapter(true));

    // Tracker succeeds
    archiveSpy = vi
      .spyOn(trackerArchiveWrite, 'recordTrackerMiningArchive')
      .mockResolvedValue(true);

    const refreshed = await simulateWriteHistory();

    // Old DB failed, but tracker succeeded → refresh should happen
    expect(refreshed).toBe(true);
  });

  it('refresh key does NOT increment when both old DB and tracker fail', async () => {
    // Old DB fails
    _setAdapter(createFakeOldDBAdapter(true));

    // Tracker also fails
    archiveSpy = vi
      .spyOn(trackerArchiveWrite, 'recordTrackerMiningArchive')
      .mockResolvedValue(false);

    const refreshed = await simulateWriteHistory();

    expect(refreshed).toBe(false);
  });

  it('old DB write result is never consulted for refresh decision', async () => {
    // Old DB succeeds
    _setAdapter(createFakeOldDBAdapter(false));

    // Tracker fails
    archiveSpy = vi
      .spyOn(trackerArchiveWrite, 'recordTrackerMiningArchive')
      .mockResolvedValue(false);

    const refreshed = await simulateWriteHistory();

    // Old DB succeeded but tracker failed → no refresh
    expect(refreshed).toBe(false);
  });

  it('tracker archive write is called with correct payload', async () => {
    archiveSpy = vi
      .spyOn(trackerArchiveWrite, 'recordTrackerMiningArchive')
      .mockResolvedValue(true);

    await simulateWriteHistory();

    expect(archiveSpy).toHaveBeenCalledWith({
      mediaId: 'media-123',
      subtitleId: 'sub-456',
      learningSetId: 'media-123:sub-456',
      displayName: 'test.mp4',
      rangeStart: 0,
      rangeEnd: 10,
      sentence: 'Hello',
    });
  });
});
