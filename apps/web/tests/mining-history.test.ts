/**
 * Unit tests for mining-history.ts adapter and public API.
 * ---------------------------------------------------------------------------
 * - add / getAll / clear through injectable adapter
 * - newest-first order
 * - invalid records ignored at public-API validation layer
 * - unavailable signal distinct from empty
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  addHistoryEntry,
  getAllHistoryEntries,
  clearHistoryEntries,
  _setAdapter,
  _resetAdapter,
  type HistoryAdapter,
  type MiningHistoryEntry,
} from '@/features/player/mining-history';

function createMemoryAdapter(): HistoryAdapter {
  let nextKey = 1;
  const entries: Array<
    Omit<MiningHistoryEntry, 'id'> & { key: number; id: string }
  > = [];
  return {
    async add(entry) {
      entries.unshift({ ...entry, key: nextKey++, id: `test-id-${nextKey}` });
      return true;
    },
    async getAll() {
      return {
        ok: true,
        entries: entries.map((e) => ({
          id: e.id,
          filename: e.filename,
          rangeStart: e.rangeStart,
          rangeEnd: e.rangeEnd,
          sentence: e.sentence,
        })),
      };
    },
    async clear() {
      entries.length = 0;
      nextKey = 1;
      return true;
    },
  };
}

function createUnavailableAdapter(): HistoryAdapter {
  return {
    async add() {
      return false;
    },
    async getAll() {
      return { ok: false, reason: 'unavailable' as const };
    },
    async clear() {
      return false;
    },
  };
}

describe('mining-history', () => {
  beforeEach(() => {
    _resetAdapter();
  });

  afterEach(() => {
    _resetAdapter();
  });

  it('adds an entry and reads it back', async () => {
    const adapter = createMemoryAdapter();
    _setAdapter(adapter);

    const ok = await addHistoryEntry({
      filename: 'test.jpg',
      rangeStart: 1.0,
      rangeEnd: 2.0,
      sentence: 'Hello',
    });
    expect(ok).toBe(true);

    const result = await getAllHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.filename).toBe('test.jpg');
    expect(result.entries[0]!.rangeStart).toBe(1.0);
    expect(result.entries[0]!.rangeEnd).toBe(2.0);
    expect(result.entries[0]!.sentence).toBe('Hello');
    expect(typeof result.entries[0]!.id).toBe('string');
  });

  it('reads newest-first order', async () => {
    const adapter = createMemoryAdapter();
    _setAdapter(adapter);

    await addHistoryEntry({
      filename: 'a.jpg',
      rangeStart: 0,
      rangeEnd: 1,
      sentence: 'A',
    });
    await addHistoryEntry({
      filename: 'b.jpg',
      rangeStart: 1,
      rangeEnd: 2,
      sentence: 'B',
    });
    await addHistoryEntry({
      filename: 'c.jpg',
      rangeStart: 2,
      rangeEnd: 3,
      sentence: 'C',
    });

    const result = await getAllHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.sentence)).toEqual(['C', 'B', 'A']);
  });

  it('ignores invalid records returned by adapter', async () => {
    const badAdapter: HistoryAdapter = {
      async add() {
        return true;
      },
      async getAll() {
        return {
          ok: true,
          entries: [
            {
              id: '1',
              filename: 'good.jpg',
              rangeStart: 0,
              rangeEnd: 1,
              sentence: 'Good',
            } as MiningHistoryEntry,
            {
              id: '',
              filename: 123,
              rangeStart: NaN,
              rangeEnd: null,
              sentence: 456,
            } as unknown as MiningHistoryEntry,
            {
              id: '3',
              filename: 'also-good.jpg',
              rangeStart: 2,
              rangeEnd: 3,
              sentence: 'Also good',
            } as MiningHistoryEntry,
          ],
        };
      },
      async clear() {
        return true;
      },
    };
    _setAdapter(badAdapter);

    const result = await getAllHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.sentence).toBe('Good');
    expect(result.entries[1]!.sentence).toBe('Also good');
  });

  it('distinguishes unavailable from empty', async () => {
    const adapter = createUnavailableAdapter();
    _setAdapter(adapter);

    const result = await getAllHistoryEntries();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
  });

  it('returns empty array when adapter has no entries', async () => {
    const adapter = createMemoryAdapter();
    _setAdapter(adapter);

    const result = await getAllHistoryEntries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([]);
  });

  it('clears all entries', async () => {
    const adapter = createMemoryAdapter();
    _setAdapter(adapter);

    await addHistoryEntry({
      filename: 'a.jpg',
      rangeStart: 0,
      rangeEnd: 1,
      sentence: 'A',
    });
    let result = await getAllHistoryEntries();
    expect(result.ok && result.entries.length).toBe(1);

    const cleared = await clearHistoryEntries();
    expect(cleared).toBe(true);

    result = await getAllHistoryEntries();
    expect(result.ok && result.entries.length).toBe(0);
  });
});
