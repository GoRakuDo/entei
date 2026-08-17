// SPDX-License-Identifier: Apache-2.0
// Pure-logic tests for LazySync (docs SUBTITLE_SYNC.md §10): rank-pairing
// median offset estimation and offset application.

import { describe, expect, it } from 'vitest';
import type { SubtitleCue } from '../src/features/player/subtitle-reader';
import {
  estimateOffsetFromNearestMedian,
  shiftCuesByOffset,
  LAZY_SYNC_MAX_OFFSET_MS,
  LAZY_SYNC_MAX_DRIFT_SAMPLES,
  LAZY_SYNC_STABLE_THRESHOLD_MS,
  LAZY_SYNC_MAX_WAIT_POLLS,
  LAZY_SYNC_POLL_INTERVAL_MS,
  LAZY_SYNC_MIN_REF_CUES,
  LAZY_SYNC_MIN_OFFSET_MS,
} from '../src/features/player/lazy-sync';

function cue(
  id: number,
  start: number,
  text: string,
  end?: number,
): SubtitleCue {
  return { id, start, end: end ?? start + 2, text };
}

describe('estimateOffsetFromNearestMedian', () => {
  it('detects a +1.5 s offset (basic case)', () => {
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5 + 1.5, `en-${i}`),
    );
    const est = estimateOffsetFromNearestMedian(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(1500);
    expect(est!.totalPairs).toBe(10);
  });

  it('detects a +8.5 s offset (language mismatch, any offset via rank pairing)', () => {
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 3, `ja-${i}`),
    );
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 3 + 8.5, `en-${i}`),
    );
    const est = estimateOffsetFromNearestMedian(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(8500);
  });

  it('detects a +180 s (3 min) offset', () => {
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5 + 180, `en-${i}`),
    );
    const est = estimateOffsetFromNearestMedian(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(180000);
  });

  it('resists outliers: some drift cues have random offset, median is correct', () => {
    // 10 cues at +5s, 2 cues randomly placed — median of 12 is still +5s
    const drift = Array.from({ length: 12 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    const ref = Array.from({ length: 12 }, (_, i) =>
      cue(i, i * 5 + 5, `en-${i}`),
    );
    // Scatter 2 drift cues to random positions (outliers)
    drift[0] = cue(0, 999, 'ja-0');
    drift[11] = cue(11, 1000, 'ja-11');
    const est = estimateOffsetFromNearestMedian(drift, ref);
    expect(est).not.toBeNull();
    // Rank pairing: drift[0]=999 ↔ ref[0]=5 → diff -994000, but median
    // of 12 diffs is still dominated by the 10 correct +5000 diffs.
    // Outliers at positions 0 and 11 produce extreme diffs, but the
    // median (index 5-6) picks from the correct cluster.
    expect(est!.offsetMs).toBe(5000);
  });

  it('drift sampling: 200 cues → pairs capped at 100 → correct estimate', () => {
    const drift = Array.from({ length: 200 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    const ref = Array.from({ length: 200 }, (_, i) =>
      cue(i, i * 5 + 2.5, `en-${i}`),
    );
    const est = estimateOffsetFromNearestMedian(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(2500);
    // 200 pairs, stride = ceil(200/100) = 2 → 100 sampled pairs
    expect(est!.totalPairs).toBe(100);
  });

  it('ref=16,315 × drift=83: stride=1 (full) → correct estimate', () => {
    const drift = Array.from({ length: 83 }, (_, i) =>
      cue(i, i * 0.45, `ja-${i}`),
    );
    const ref = Array.from({ length: 16315 }, (_, i) =>
      cue(i, i * 0.45 + 1.5, `en-${i}`),
    );
    const est = estimateOffsetFromNearestMedian(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(1500);
    // min(83, 16315) = 83 < 100 → stride 1 → 83 pairs
    expect(est!.totalPairs).toBe(83);
  });

  it('returns null when drift=0', () => {
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `en-${i}`),
    );
    expect(estimateOffsetFromNearestMedian([], ref)).toBeNull();
  });

  it('returns null when ref=0', () => {
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    expect(estimateOffsetFromNearestMedian(drift, [])).toBeNull();
  });

  it('returns null when both empty', () => {
    expect(estimateOffsetFromNearestMedian([], [])).toBeNull();
  });

  it('returns null when offset is 0 (already in sync)', () => {
    const cues = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `line-${i}`),
    );
    // Same cues → offset 0 → null
    expect(estimateOffsetFromNearestMedian(cues, cues)).toBeNull();
  });

  it('returns null when offset exceeds 1 hour (broken estimate)', () => {
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5 + 3700, `en-${i}`), // 3700 s > 3600 s (1 hour)
    );
    const est = estimateOffsetFromNearestMedian(drift, ref);
    expect(est).toBeNull();
  });

  it('detects a negative offset when the reference is earlier', () => {
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5 + 3, `ja-${i}`),
    );
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `en-${i}`),
    );
    const est = estimateOffsetFromNearestMedian(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(-3000);
  });

  it('works with only 1 cue on each side', () => {
    const drift = [cue(0, 10, 'ja-0')];
    const ref = [cue(0, 12.5, 'en-0')];
    const est = estimateOffsetFromNearestMedian(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(2500);
    expect(est!.totalPairs).toBe(1);
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
    expect(shifted).toHaveLength(2);
    expect(shifted[0]).toMatchObject({ start: 0, end: 1, text: 'early' });
    expect(shifted[1]).toMatchObject({ start: 18, end: 20, text: 'later' });
  });

  it('drops cues that collapse to non-positive length', () => {
    const collapsed = shiftCuesByOffset([cue(0, 1, 'early', 2)], -3000);
    expect(collapsed).toEqual([]);
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

  it('max wait bound is 240 polls = 12 min at the 3 s interval', () => {
    expect(LAZY_SYNC_MAX_WAIT_POLLS).toBe(240);
    expect(LAZY_SYNC_MAX_WAIT_POLLS * LAZY_SYNC_POLL_INTERVAL_MS).toBe(
      12 * 60 * 1000,
    );
  });

  it('first sync waits for ≥ 5 downloaded cues (docs §10 trigger)', () => {
    expect(LAZY_SYNC_MIN_REF_CUES).toBe(5);
  });

  it('offsets under 100 ms count as already in sync', () => {
    expect(LAZY_SYNC_MIN_OFFSET_MS).toBe(100);
  });

  it('max offset is 1 hour (3600000 ms)', () => {
    expect(LAZY_SYNC_MAX_OFFSET_MS).toBe(3600000);
  });

  it('max drift samples is 100', () => {
    expect(LAZY_SYNC_MAX_DRIFT_SAMPLES).toBe(100);
  });
});
