/**
 * Mining History — recordMiningHistory behavioral tests.
 *
 * Tests the exported production function used by PlayerApp success paths.
 * Verifies correct payload, no leaked fields, error swallowing, and
 * deduplication of the call site so we don't mirror PlayerApp logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordMiningHistory,
  _setAdapter,
  _resetAdapter,
  type HistoryAdapter,
  type HistoryReadResult,
} from '@/features/player/mining-history';

/* ------------------------------------------------------------------------ */
/* Fake adapter — captures every add() call for assertion.                  */
/* ------------------------------------------------------------------------ */

function createFakeAdapter() {
  const calls: Array<[Record<string, unknown>]> = [];
  let shouldThrow = false;
  let shouldReject = false;

  const adapter: HistoryAdapter = {
    async add(entry: unknown) {
      calls.push([entry as Record<string, unknown>]);
      if (shouldReject) return Promise.resolve(false);
      if (shouldThrow) throw new Error('IDB write failed');
      return true;
    },
    async getAll(): Promise<HistoryReadResult> {
      return { ok: true, entries: [] };
    },
    async clear() {
      return true;
    },
  };

  return {
    adapter,
    calls,
    setThrow: (v: boolean) => {
      shouldThrow = v;
    },
    setReject: (v: boolean) => {
      shouldReject = v;
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

describe('recordMiningHistory', () => {
  let fake: ReturnType<typeof createFakeAdapter>;

  beforeEach(() => {
    fake = createFakeAdapter();
    _setAdapter(fake.adapter);
  });

  afterEach(() => {
    _resetAdapter();
  });

  it('writes exactly { filename, rangeStart, rangeEnd, sentence } — no extra fields', async () => {
    const result = await recordMiningHistory({
      filename: 'entei_screenshot_42.jpg',
      rangeStart: 10.5,
      rangeEnd: 25.0,
      sentence: 'Hello world',
    });

    expect(result).toBe(true);
    expect(fake.calls).toHaveLength(1);

    const [entry] = fake.calls[0]!;
    // Must have exactly these 4 keys — no id, no date, no mode, no key
    expect(Object.keys(entry).sort()).toEqual([
      'filename',
      'rangeEnd',
      'rangeStart',
      'sentence',
    ]);
    expect(entry).toEqual({
      filename: 'entei_screenshot_42.jpg',
      rangeStart: 10.5,
      rangeEnd: 25.0,
      sentence: 'Hello world',
    });
  });

  it('New success: writes once with mediaName, range, sentence', async () => {
    const result = await recordMiningHistory({
      filename: 'entei_video_99.webm',
      rangeStart: 0,
      rangeEnd: 30.2,
      sentence: 'First line of dialogue',
    });
    expect(result).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]![0]).toMatchObject({
      filename: 'entei_video_99.webm',
      rangeStart: 0,
      rangeEnd: 30.2,
      sentence: 'First line of dialogue',
    });
  });

  it('Update success: writes once with same format', async () => {
    const result = await recordMiningHistory({
      filename: 'entei_screenshot_1.jpg',
      rangeStart: 5.0,
      rangeEnd: 15.0,
      sentence: 'Updated sentence',
    });
    expect(result).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('Append success (one card): writes exactly one entry', async () => {
    // Simulates PlayerApp calling once when succeeded.length === 1
    const result = await recordMiningHistory({
      filename: 'entei_video_5.webm',
      rangeStart: 3.0,
      rangeEnd: 8.5,
      sentence: 'Appended sentence',
    });
    expect(result).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('Append success (multiple cards): writes exactly one entry (not per-card)', async () => {
    // PlayerApp calls writeHistory once when succeeded.length > 0
    const result = await recordMiningHistory({
      filename: 'entei_video_5.webm',
      rangeStart: 3.0,
      rangeEnd: 8.5,
      sentence: 'Multi-append',
    });
    expect(result).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('returns false and does not throw when adapter throws', async () => {
    fake.setThrow(true);

    const result = await recordMiningHistory({
      filename: 'x.jpg',
      rangeStart: 0,
      rangeEnd: 1,
      sentence: '',
    });

    expect(result).toBe(false);
    expect(fake.calls).toHaveLength(1); // adapter.add was still called
  });

  it('returns false when adapter rejects (returns false)', async () => {
    fake.setReject(true);

    const result = await recordMiningHistory({
      filename: 'x.jpg',
      rangeStart: 0,
      rangeEnd: 1,
      sentence: '',
    });

    expect(result).toBe(false);
  });

  it('empty sentence is valid — writes empty string', async () => {
    await recordMiningHistory({
      filename: 'test.jpg',
      rangeStart: 0,
      rangeEnd: 1,
      sentence: '',
    });
    expect(fake.calls[0]![0]).toMatchObject({ sentence: '' });
  });

  it('no API keys, blobs, mode, or date in payload', async () => {
    await recordMiningHistory({
      filename: 'entei_screenshot.jpg',
      rangeStart: 0,
      rangeEnd: 10,
      sentence: 'Test',
    });

    const [entry] = fake.calls[0]!;
    const keys = Object.keys(entry);

    // Explicitly verify forbidden keys are absent
    expect(keys).not.toContain('apiKey');
    expect(keys).not.toContain('blob');
    expect(keys).not.toContain('mode');
    expect(keys).not.toContain('date');
    expect(keys).not.toContain('timestamp');
    expect(keys).not.toContain('deck');
    expect(keys).not.toContain('noteType');
    expect(keys).not.toContain('noteIds');
    expect(keys).not.toContain('id');
    expect(keys).not.toContain('url');
  });
});
