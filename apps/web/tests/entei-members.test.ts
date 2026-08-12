import { describe, expect, it } from 'vitest';
import {
  computeTotal,
  sortByTotal,
  isStale,
  levelsUnchanged,
  parseCsvLine,
  parsePrice,
  extractChannelId,
} from '../../../members-supporter/lib.mjs';

// ---------------------------------------------------------------------------
// Thanks To members — pure pipeline logic (Stage 1, docs/THANKS_TO_MEMBERS.md)
// ---------------------------------------------------------------------------

const levels = [
  { id: 'level_1', name: 'Level 1', price: 15000, currency: 'IDR' },
  { id: 'level_2', name: 'Level 2', price: 49000, currency: 'IDR' },
];

describe('computeTotal', () => {
  it('sums level price × months for each level stay', () => {
    const months = [
      { level: 'level_1', memberTotalDurationMonths: 12 },
      { level: 'level_2', memberTotalDurationMonths: 3 },
    ];
    expect(computeTotal(months, levels)).toBe(12 * 15000 + 3 * 49000);
  });

  it('ignores unknown level IDs', () => {
    const months = [
      { level: 'level_1', memberTotalDurationMonths: 6 },
      { level: 'level_nonexistent', memberTotalDurationMonths: 9 },
    ];
    expect(computeTotal(months, levels)).toBe(6 * 15000);
  });

  it('returns 0 for empty / null input', () => {
    expect(computeTotal([], levels)).toBe(0);
    // @ts-expect-error — the script tolerates null/undefined input defensively
    expect(computeTotal(null, levels)).toBe(0);
    // @ts-expect-error — the script tolerates null/undefined input defensively
    expect(computeTotal(undefined, levels)).toBe(0);
  });
});

describe('sortByTotal', () => {
  it('sorts descending and does not mutate the input', () => {
    const input = [
      { displayName: 'low', total: 5 },
      { displayName: 'high', total: 50 },
      { displayName: 'mid', total: 25 },
    ];
    const sorted = sortByTotal(input);
    expect(sorted.map((m) => m.total)).toEqual([50, 25, 5]);
    expect(input.map((m) => m.total)).toEqual([5, 50, 25]); // original intact
  });
});

describe('isStale', () => {
  const now = Date.parse('2026-08-19T00:00:00Z');

  it('is stale when older than the max age', () => {
    const old = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(old, now, 7 * 24 * 60 * 60 * 1000)).toBe(true);
  });

  it('is fresh when within the max age', () => {
    const fresh = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(fresh, now, 7 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('treats missing / unparseable timestamps as stale', () => {
    expect(isStale(undefined, now)).toBe(true);
    expect(isStale('not-a-date', now)).toBe(true);
    expect(isStale(null, now)).toBe(true);
  });
});

describe('levelsUnchanged', () => {
  const cached = {
    levels: [
      { id: 'a', name: 'A', price: 5, currency: 'USD' },
      { id: 'b', name: 'B', price: 10, currency: 'USD' },
    ],
  };

  it('true when the fresh payload matches regardless of order', () => {
    const fresh = [
      { id: 'b', name: 'B', monthlyPrice: { value: 10, currency: 'USD' } },
      { id: 'a', name: 'A', monthlyPrice: { value: 5, currency: 'USD' } },
    ];
    expect(levelsUnchanged(cached, fresh)).toBe(true);
  });

  it('false when a price changed', () => {
    const fresh = [
      { id: 'a', name: 'A', monthlyPrice: { value: 6, currency: 'USD' } },
      { id: 'b', name: 'B', monthlyPrice: { value: 10, currency: 'USD' } },
    ];
    expect(levelsUnchanged(cached, fresh)).toBe(false);
  });

  it('false when a level was added or removed', () => {
    const added = [
      { id: 'a', name: 'A', monthlyPrice: { value: 5, currency: 'USD' } },
    ];
    expect(levelsUnchanged(cached, added)).toBe(false);
    expect(levelsUnchanged({ levels: [] }, added)).toBe(false);
  });
});

describe('parseCsvLine', () => {
  it('splits plain comma fields', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps commas inside double-quoted fields', () => {
    expect(parseCsvLine('a,"IDR 19,900",c')).toEqual(['a', 'IDR 19,900', 'c']);
  });

  it('handles escaped quotes inside quoted fields', () => {
    expect(parseCsvLine('"say ""hi""",b')).toEqual(['say "hi"', 'b']);
  });
});

describe('parsePrice', () => {
  it('parses currency + comma-grouped value', () => {
    expect(parsePrice('IDR 19,900')).toEqual({ currency: 'IDR', value: 19900 });
  });

  it('parses no-break space (U+00A0) between currency and value', () => {
    expect(parsePrice('IDR\u00A019,900')).toEqual({ currency: 'IDR', value: 19900 });
  });

  it('handles plain integer values without grouping', () => {
    expect(parsePrice('IDR 20000')).toEqual({ currency: 'IDR', value: 20000 });
  });

  it('returns null for unparseable input', () => {
    expect(parsePrice('gratis')).toBeNull();
    expect(parsePrice('')).toBeNull();
    expect(parsePrice(null as unknown as string)).toBeNull();
  });
});

describe('extractChannelId', () => {
  it('extracts UC id from a /channel/ URL', () => {
    expect(extractChannelId('https://www.youtube.com/channel/UCfFchxuoTj6ynJHzmickoTA'))
      .toBe('UCfFchxuoTj6ynJHzmickoTA');
  });

  it('returns null for URLs without a channel segment', () => {
    expect(extractChannelId('https://www.youtube.com/@yosiakefas')).toBeNull();
    expect(extractChannelId('')).toBeNull();
    expect(extractChannelId(null as unknown as string)).toBeNull();
  });
});
