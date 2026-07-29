/**
 * Unit tests for tracker-archive-read.ts.
 * ---------------------------------------------------------------------------
 * - Newest-first ordering via createdAt timestamp
 * - Entries without createdAt sort to the end
 * - displayName → filename mapping
 * - Invalid entries filtered out
 * - DB unavailable / error handling
 * - Old DB deletion helper still uncalled
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTrackerHistoryEntries } from '@/features/player/tracker/tracker-archive-read';
import * as db from '@/features/player/tracker/db';
import * as oldDbGate from '@/features/player/tracker/old-db-gate';
import type { MiningArchiveEntry } from '@/features/player/tracker/types';

/* ------------------------------------------------------------------------ */
/* Fake data helpers                                                        */
/* ------------------------------------------------------------------------ */

function makeEntry(overrides: Partial<MiningArchiveEntry> = {}): MiningArchiveEntry {
  return {
    id: `id-${Math.random().toString(36).slice(2, 8)}`,
    mediaId: 'media-1',
    learningSetId: 'ls-1',
    displayName: 'video.webm',
    rangeStart: 0,
    rangeEnd: 10,
    sentence: 'Hello',
    localDay: '2026-07-29',
    createdAt: Date.now(),
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

describe('tracker-archive-read', () => {
  let getAllSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    getAllSpy = vi.spyOn(db, 'getAllMiningArchive');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array when no entries exist', async () => {
    getAllSpy.mockResolvedValue([]);

    const result = await getTrackerHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([]);
  });

  it('returns entries sorted newest-first by createdAt', async () => {
    const older = makeEntry({
      id: 'old',
      sentence: 'Older',
      createdAt: 1000,
    });
    const newer = makeEntry({
      id: 'new',
      sentence: 'Newer',
      createdAt: 3000,
    });
    const middle = makeEntry({
      id: 'mid',
      sentence: 'Middle',
      createdAt: 2000,
    });

    // Deliberately out of order
    getAllSpy.mockResolvedValue([older, newer, middle]);

    const result = await getTrackerHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.sentence)).toEqual([
      'Newer',
      'Middle',
      'Older',
    ]);
  });

  it('entries without createdAt sort to the end', async () => {
    const withTs = makeEntry({
      id: 'with-ts',
      sentence: 'With timestamp',
      createdAt: 5000,
    });
    // Simulate old record without createdAt
    const withoutTs = makeEntry({
      id: 'no-ts',
      sentence: 'No timestamp',
    });
    delete (withoutTs as unknown as Record<string, unknown>).createdAt;

    getAllSpy.mockResolvedValue([withoutTs, withTs]);

    const result = await getTrackerHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.sentence)).toEqual([
      'With timestamp',
      'No timestamp',
    ]);
  });

  it('maps displayName to filename', async () => {
    getAllSpy.mockResolvedValue([
      makeEntry({ id: '1', displayName: 'my_video.mp4' }),
    ]);

    const result = await getTrackerHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]!.filename).toBe('my_video.mp4');
  });

  it('preserves rangeStart, rangeEnd, sentence, id', async () => {
    getAllSpy.mockResolvedValue([
      makeEntry({
        id: 'test-id',
        rangeStart: 5.5,
        rangeEnd: 12.3,
        sentence: 'Test sentence',
      }),
    ]);

    const result = await getTrackerHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]).toEqual({
      id: 'test-id',
      filename: 'video.webm',
      rangeStart: 5.5,
      rangeEnd: 12.3,
      sentence: 'Test sentence',
    });
  });

  it('filters out invalid entries', async () => {
    const good = makeEntry({ id: 'good', sentence: 'Valid' });
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

    getAllSpy.mockResolvedValue([good, bad]);

    const result = await getTrackerHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe('good');
  });

  it('returns unavailable when getAllMiningArchive returns empty (DB not ready)', async () => {
    // getAllMiningArchive returns [] when DB is unavailable
    getAllSpy.mockResolvedValue([]);

    const result = await getTrackerHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([]);
  });

  it('returns error when getAllMiningArchive throws', async () => {
    getAllSpy.mockRejectedValue(new Error('DB open failed'));

    const result = await getTrackerHistoryEntries();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('error');
  });

  it('does not include createdAt in the returned entries', async () => {
    getAllSpy.mockResolvedValue([
      makeEntry({ id: '1', createdAt: 9999 }),
    ]);

    const result = await getTrackerHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = Object.keys(result.entries[0]!);
    expect(keys).not.toContain('createdAt');
    expect(keys.sort()).toEqual([
      'filename',
      'id',
      'rangeEnd',
      'rangeStart',
      'sentence',
    ]);
  });

  it('old DB deletion helper is never called', async () => {
    const canDeleteSpy = vi.spyOn(oldDbGate, 'canDeleteOldDB');
    const deleteSpy = vi.spyOn(oldDbGate, 'deleteOldMiningHistoryDB');

    getAllSpy.mockResolvedValue([]);

    await getTrackerHistoryEntries();

    expect(canDeleteSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});
