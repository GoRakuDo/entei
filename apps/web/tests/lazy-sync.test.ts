// SPDX-License-Identifier: Apache-2.0
// Pure-logic tests for LazySync (docs SUBTITLE_SYNC.md §10): cue text
// pairing, constant-offset estimation, and offset application.

import { describe, expect, it } from 'vitest';
import type { SubtitleCue } from '../src/features/player/subtitle-reader';
import {
  estimateOffsetMs,
  matchCueOffsets,
  shiftCuesByOffset,
  LAZY_SYNC_MATCH_WINDOW_MS,
  LAZY_SYNC_STABLE_THRESHOLD_MS,
  LAZY_SYNC_MAX_WAIT_POLLS,
  LAZY_SYNC_POLL_INTERVAL_MS,
  LAZY_SYNC_MIN_REF_CUES,
  LAZY_SYNC_MIN_MATCHES,
  LAZY_SYNC_MIN_OFFSET_MS,
  LAZY_SYNC_MAX_OFFSET_MS,
} from '../src/features/player/lazy-sync';

function cue(
  id: number,
  start: number,
  text: string,
  end?: number,
): SubtitleCue {
  return { id, start, end: end ?? start + 2, text };
}

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

  it('pairs every cue in the same timeband and reports ref − drift', () => {
    const matches = matchCueOffsets(drift, ref);
    expect(matches).toHaveLength(4);
    for (const m of matches) {
      expect(m.diffMs).toBeCloseTo(1500, 6);
    }
  });

  it('pairs cues even when the texts differ (different language)', () => {
    const jaDrift = [
      cue(0, 10, 'こんにちは'),
      cue(1, 20, '世界'),
      cue(2, 30, 'ありがとう'),
    ];
    const enRef = [
      cue(0, 11.5, 'Hello'),
      cue(1, 21.5, 'World'),
      cue(2, 31.5, 'Thanks'),
    ];
    const matches = matchCueOffsets(jaDrift, enRef);
    expect(matches).toHaveLength(3);
    for (const m of matches) {
      expect(m.diffMs).toBeCloseTo(1500, 6);
    }
  });

  it('reports a negative offset when the reference is earlier', () => {
    const earlierRef = [
      cue(0, 8.5, 'First'),
      cue(1, 18.5, 'Second'),
      cue(2, 28.5, 'Third'),
    ];
    const matches = matchCueOffsets(drift, earlierRef);
    expect(matches).toHaveLength(3);
    for (const m of matches) {
      expect(m.diffMs).toBeCloseTo(-1500, 6);
    }
  });

  it('picks the nearest in-window drift cue over a farther one', () => {
    const matches = matchCueOffsets(
      [cue(0, 10, 'farther'), cue(1, 10.5, 'nearer')],
      [cue(0, 11, 'ref')],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      driftStartMs: 10500,
      refStartMs: 11000,
      diffMs: 500,
    });
  });

  it('does not pair cues outside the window', () => {
    expect(matchCueOffsets(drift, [cue(0, 60, 'nowhere near')])).toEqual([]);
    expect(
      matchCueOffsets([cue(0, 10, 'A'), cue(1, 100, 'B')], [cue(0, 60, 'C')]),
    ).toEqual([]);
  });

  it('pairs every cue of a dense track to its nearest drift cue, and the median converges to the true offset', () => {
    const driftDense = Array.from({ length: 10 }, (_, i) =>
      cue(i, 10 + i, `drift-${i}`),
    );
    const refDense = Array.from({ length: 10 }, (_, i) =>
      cue(i, 10.4 + i, `ref-${i}`),
    );
    const matches = matchCueOffsets(driftDense, refDense);
    expect(matches).toHaveLength(10);
    for (const m of matches) {
      expect(m.diffMs).toBeCloseTo(400, 6);
    }
    expect(estimateOffsetMs(matches)).toBeCloseTo(400, 6);
  });

  it('honors a custom windowMs', () => {
    const widePair = [cue(0, 10, 'A')];
    const farRef = [cue(0, 20, 'B')];
    // 10 s apart: outside the ±5 s default window.
    expect(matchCueOffsets(widePair, farRef)).toEqual([]);
    // Within a widened window the pair matches with diff = +10 s.
    const wide = matchCueOffsets(widePair, farRef, 12000);
    expect(wide).toHaveLength(1);
    expect(wide[0]!.diffMs).toBeCloseTo(10000, 6);
  });

  it('returns empty when either side has no cues', () => {
    expect(matchCueOffsets(drift, [])).toEqual([]);
    expect(matchCueOffsets([], ref)).toEqual([]);
  });

  it('a 2-cue reference yields fewer matches than the quality gate requires', () => {
    const matches = matchCueOffsets(
      [cue(0, 10, 'A'), cue(1, 20, 'B'), cue(2, 30, 'C')],
      [cue(0, 11.5, 'A'), cue(1, 21.5, 'B')],
    );
    expect(matches).toHaveLength(2);
    expect(matches.length).toBeLessThan(LAZY_SYNC_MIN_MATCHES);
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

  it('near-zero offsets fall under the already-in-sync threshold', () => {
    const matches = matchCueOffsets(
      [cue(0, 10, 'A'), cue(1, 20, 'B'), cue(2, 30, 'C')],
      [cue(0, 10.03, 'A'), cue(1, 20.03, 'B'), cue(2, 30.03, 'C')],
    );
    const offset = estimateOffsetMs(matches);
    expect(offset).not.toBeNull();
    expect(Math.abs(offset!)).toBeLessThan(LAZY_SYNC_MIN_OFFSET_MS);
  });

  it('outlier-scale estimates exceed the 60 s rejection bound', () => {
    // Direct construction: the ±5 s match window already caps every pair
    // difference below the bound, so only a widened window or a bad
    // estimate could produce such values — the gate is defense-in-depth.
    const offset = estimateOffsetMs([
      { driftStartMs: 0, refStartMs: 70000, diffMs: 70000 },
      { driftStartMs: 0, refStartMs: 70500, diffMs: 70500 },
      { driftStartMs: 0, refStartMs: 71000, diffMs: 71000 },
    ]);
    expect(offset).not.toBeNull();
    expect(Math.abs(offset!)).toBeGreaterThan(LAZY_SYNC_MAX_OFFSET_MS);
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

  it('match window is ±5 s per the time-proximity pairing default', () => {
    expect(LAZY_SYNC_MATCH_WINDOW_MS).toBe(5000);
  });

  it('max wait bound is 240 polls = 12 min at the 3 s interval', () => {
    expect(LAZY_SYNC_MAX_WAIT_POLLS).toBe(240);
    expect(LAZY_SYNC_MAX_WAIT_POLLS * LAZY_SYNC_POLL_INTERVAL_MS).toBe(
      12 * 60 * 1000,
    );
  });

  it('first sync waits for ≥ 5 downloaded cues (docs §10 trigger)', () => {
    expect(LAZY_SYNC_MIN_REF_CUES).toBe(5);
  });

  it('quality gate requires ≥ 3 matches (ffsubsync --skip-sync-on-low-quality)', () => {
    expect(LAZY_SYNC_MIN_MATCHES).toBe(3);
  });

  it('offsets under 100 ms count as already in sync (ffsubsync suppress-output-if-offset-less-than)', () => {
    expect(LAZY_SYNC_MIN_OFFSET_MS).toBe(100);
  });

  it('offsets over 60 s are rejected as outliers (ffsubsync --max-offset-seconds=60)', () => {
    expect(LAZY_SYNC_MAX_OFFSET_MS).toBe(60000);
    expect(LAZY_SYNC_MAX_OFFSET_MS).toBe(60 * 1000);
  });
});
