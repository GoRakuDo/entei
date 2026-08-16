// SPDX-License-Identifier: Apache-2.0
// Pure-logic tests for LazySync (docs SUBTITLE_SYNC.md §10): cue text
// matching, constant-offset estimation, and offset application.

import { describe, expect, it } from 'vitest';
import type { SubtitleCue } from '../src/features/player/subtitle-reader';
import {
  estimateOffsetMs,
  matchCueOffsets,
  normalizeCueText,
  shiftCuesByOffset,
  LAZY_SYNC_STABLE_THRESHOLD_MS,
} from '../src/features/player/lazy-sync';

function cue(
  id: number,
  start: number,
  text: string,
  end?: number,
): SubtitleCue {
  return { id, start, end: end ?? start + 2, text };
}

describe('normalizeCueText', () => {
  it('folds case, whitespace and punctuation', () => {
    expect(normalizeCueText('  Hello, World!  ')).toBe('helloworld');
    expect(normalizeCueText('こんにちは、世界')).toBe('こんにちは世界');
    expect(normalizeCueText('fullwidth　space')).toBe('fullwidthspace');
  });

  it('returns empty for empty input', () => {
    expect(normalizeCueText('')).toBe('');
    expect(normalizeCueText('   ')).toBe('');
  });
});

describe('matchCueOffsets', () => {
  const drift = [
    cue(0, 10, 'First line'),
    cue(1, 20, 'Second line'),
    cue(2, 30, 'Repeated line'),
    cue(3, 40, 'Third line'),
  ];
  // Reference is 1.5 s ahead of the drift subtitle.
  const ref = [
    cue(0, 11.5, 'First line'),
    cue(1, 21.5, 'Second line'),
    cue(2, 31.5, 'Repeated line'),
    cue(3, 41.5, 'Third line'),
  ];

  it('pairs every text-matching cue and reports ref − drift', () => {
    const matches = matchCueOffsets(drift, ref);
    expect(matches).toHaveLength(4);
    for (const m of matches) {
      expect(m.diffMs).toBeCloseTo(1500, 6);
    }
  });

  it('does not match cues with different text', () => {
    const different = [
      cue(0, 11.5, 'Something else entirely'),
      cue(1, 21.5, 'Second line'),
    ];
    const matches = matchCueOffsets(drift, different);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.diffMs).toBeCloseTo(1500, 6);
  });

  it('consumes each reference cue at most once (repeated lines)', () => {
    const dupDrift = [
      cue(0, 10, 'Repeated line'),
      cue(1, 20, 'Repeated line'),
    ];
    const singleRef = [cue(0, 11.5, 'Repeated line')];
    const matches = matchCueOffsets(dupDrift, singleRef);
    expect(matches).toHaveLength(1);
  });

  it('returns empty when nothing matches', () => {
    expect(matchCueOffsets(drift, [])).toEqual([]);
    expect(
      matchCueOffsets([cue(0, 10, 'A')], [cue(0, 11, 'B')]),
    ).toEqual([]);
  });
});

describe('estimateOffsetMs', () => {
  it('returns null for no matches', () => {
    expect(estimateOffsetMs([])).toBeNull();
  });

  it('returns the single difference', () => {
    expect(estimateOffsetMs([{ driftStartMs: 0, refStartMs: 1200, diffMs: 1200 }])).toBe(1200);
  });

  it('returns the median of odd-length differences', () => {
    const matches = [
      { driftStartMs: 0, refStartMs: 0, diffMs: 1000 },
      { driftStartMs: 0, refStartMs: 0, diffMs: 2000 },
      { driftStartMs: 0, refStartMs: 0, diffMs: 3000 },
    ];
    expect(estimateOffsetMs(matches)).toBe(2000);
  });

  it('averages the middle pair for even-length differences', () => {
    const matches = [
      { driftStartMs: 0, refStartMs: 0, diffMs: 1000 },
      { driftStartMs: 0, refStartMs: 0, diffMs: 2000 },
      { driftStartMs: 0, refStartMs: 0, diffMs: 3000 },
      { driftStartMs: 0, refStartMs: 0, diffMs: 4000 },
    ];
    expect(estimateOffsetMs(matches)).toBe(2500);
  });

  it('is robust to outliers (median over mean)', () => {
    const matches = [
      { driftStartMs: 0, refStartMs: 0, diffMs: 1500 },
      { driftStartMs: 0, refStartMs: 0, diffMs: 1600 },
      { driftStartMs: 0, refStartMs: 0, diffMs: 1400 },
      { driftStartMs: 0, refStartMs: 0, diffMs: 720000 }, // stray bad match
    ];
    expect(estimateOffsetMs(matches)).toBeCloseTo(1550, 6);
  });
});

describe('shiftCuesByOffset', () => {
  const cues = [
    cue(0, 10, 'A', 12),
    cue(1, 20, 'B', 22),
    cue(2, 30, 'C', 32),
  ];

  it('shifts start and end by the offset', () => {
    const shifted = shiftCuesByOffset(cues, 1500);
    expect(shifted[0]).toMatchObject({ start: 11.5, end: 13.5, text: 'A' });
    expect(shifted[1]).toMatchObject({ start: 21.5, end: 23.5 });
  });

  it('shifts negatively and clamps starts to 0', () => {
    const shifted = shiftCuesByOffset(
      [cue(0, 1, 'early', 3), cue(1, 20, 'later', 22)],
      -2000,
    );
    // 'early' (1→−1) clamps its start to 0 but keeps a positive length;
    // 'later' shifts normally.
    expect(shifted).toHaveLength(2);
    expect(shifted[0]).toMatchObject({ start: 0, end: 1, text: 'early' });
    expect(shifted[1]).toMatchObject({ start: 18, end: 20, text: 'later' });
  });

  it('drops cues that collapse to non-positive length', () => {
    // start 1 end 2, offset −3 s → start clamps to 0, end clamps to 0,
    // end ≤ start → dropped.
    const collapsed = shiftCuesByOffset([cue(0, 1, 'early', 2)], -3000);
    expect(collapsed).toEqual([]);
    // start 1 end 3, offset −2.5 s → (0, 0.5) survives.
    const partial = shiftCuesByOffset([cue(0, 1, 'early', 3)], -2500);
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ start: 0 });
    expect(partial[0]!.end).toBeGreaterThan(0);
  });

  it('reindexes ids and preserves text', () => {
    const shifted = shiftCuesByOffset(cues, 500);
    expect(shifted.map((c) => c.id)).toEqual([0, 1, 2]);
    expect(shifted.map((c) => c.text)).toEqual(['A', 'B', 'C']);
  });

  it('returns equivalent cues unchanged for a zero offset', () => {
    const shifted = shiftCuesByOffset(cues, 0);
    expect(shifted.map((c) => c.start)).toEqual([10, 20, 30]);
  });
});

describe('LazySync constants', () => {
  it('stable threshold is 50 ms per docs §10.3', () => {
    expect(LAZY_SYNC_STABLE_THRESHOLD_MS).toBe(50);
  });
});
