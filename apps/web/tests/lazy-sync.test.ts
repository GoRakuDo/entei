// SPDX-License-Identifier: Apache-2.0
// Pure-logic tests for LazySync (docs SUBTITLE_SYNC.md §10): rank-pairing
// median offset estimation and offset application.

import { describe, expect, it } from 'vitest';
import type { SubtitleCue } from '../src/features/player/subtitle-reader';
import {
  estimateMedianOffset,
  shiftCuesByOffset,
  LAZY_SYNC_MAX_OFFSET_MS,
  LAZY_SYNC_MAX_PAIRS,
  LAZY_SYNC_CONCENTRATION_BAND_MS,
  LAZY_SYNC_CONCENTRATION_BAND_MAX_MS,
  LAZY_SYNC_MIN_CONCENTRATION,
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

describe('estimateMedianOffset', () => {
  it('detects a +1.5 s offset (basic case)', () => {
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5 + 1.5, `en-${i}`),
    );
    const est = estimateMedianOffset(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(1500);
    expect(est!.pairCount).toBe(10);
  });

  it('detects a +8.5 s offset (language mismatch, any offset via rank pairing)', () => {
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 3, `ja-${i}`),
    );
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 3 + 8.5, `en-${i}`),
    );
    const est = estimateMedianOffset(drift, ref);
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
    const est = estimateMedianOffset(drift, ref);
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
    const est = estimateMedianOffset(drift, ref);
    expect(est).not.toBeNull();
    // Rank pairing: drift[0]=999 ↔ ref[0]=5 → diff -994000, but median
    // of 12 diffs is still dominated by the 10 correct +5000 diffs.
    // Outliers at positions 0 and 11 produce extreme diffs, but the
    // median (index 5-6) picks from the correct cluster.
    expect(est!.offsetMs).toBe(5000);
  });

  it('pair cap: 200 cues → 100 sampled pairs → correct estimate', () => {
    const drift = Array.from({ length: 200 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    const ref = Array.from({ length: 200 }, (_, i) =>
      cue(i, i * 5 + 2.5, `en-${i}`),
    );
    const est = estimateMedianOffset(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(2500);
    // 200 pairs, stride = ceil(200/100) = 2 → 100 sampled pairs
    expect(est!.pairCount).toBe(100);
  });

  it('ref=16,315 × drift=83: stride=1 (full) → correct estimate', () => {
    const drift = Array.from({ length: 83 }, (_, i) =>
      cue(i, i * 0.45, `ja-${i}`),
    );
    const ref = Array.from({ length: 16315 }, (_, i) =>
      cue(i, i * 0.45 + 1.5, `en-${i}`),
    );
    const est = estimateMedianOffset(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(1500);
    // min(83, 16315) = 83 < 100 → stride 1 → 83 pairs
    expect(est!.pairCount).toBe(83);
  });

  it('returns null when drift=0', () => {
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `en-${i}`),
    );
    expect(estimateMedianOffset([], ref)).toBeNull();
  });

  it('returns null when ref=0', () => {
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    expect(estimateMedianOffset(drift, [])).toBeNull();
  });

  it('returns null when both empty', () => {
    expect(estimateMedianOffset([], [])).toBeNull();
  });

  it('already in sync: median 0 returns an estimate with offset 0 (not null)', () => {
    const cues = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `line-${i}`),
    );
    // Same cues → every diff is 0 → median 0 → an estimate, NOT null:
    // PlayerApp treats |offset| < 100 ms as "already in sync" and converges
    // silently. Returning null here made it wait out the 12-min bound and
    // toast "字幕が読み込まれていません" on perfectly synced subtitles.
    expect(estimateMedianOffset(cues, cues)).toEqual({
      offsetMs: 0,
      pairCount: 10,
    });
  });

  it('fail-closed: ±1.5 s mixed diffs (bimodal) → null', () => {
    // 5 pairs at −1.5 s and 5 at +1.5 s: the median (+1.5 s) sits inside
    // max(2000, 750) = 2000 ms of only the +1.5 s cluster → 5/10 = 50% of
    // the diffs, which is not > 50% — no single offset dominates, refuse.
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5 + 10, `ja-${i}`),
    );
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5 + 10 + (i < 5 ? -1.5 : 1.5), `en-${i}`),
    );
    expect(estimateMedianOffset(drift, ref)).toBeNull();
  });

  it('fail-closed: mid-track gap (rank misalignment) → null', () => {
    // Near-regular 3 s-spaced track with a 3 s gap inserted mid-track (docs
    // §10.3 residual risk): the shifted later ranks produce a constant diff,
    // here 3× 0 s + 3× +3 s. The median (+3 s) represents only half of the
    // pairs → refused instead of applying the wrong +3 s shift.
    const drift = Array.from({ length: 6 }, (_, i) =>
      cue(i, i * 3, `ja-${i}`),
    );
    // Insert a 3 s gap after the 3rd cue (12 instead of 9) — every later
    // rank is shifted by the gap, exactly the DL'd-prefix misalignment case.
    const ref = Array.from({ length: 6 }, (_, i) =>
      cue(i, (i >= 3 ? i * 3 + 3 : i * 3), `en-${i}`),
    );
    expect(estimateMedianOffset(drift, ref)).toBeNull();
  });

  it('fail-closed: large offset + mid-track gap (band cap) → null', () => {
    // The band scales with |median| (|median| / 2); without the cap a large
    // offset would widen it enough to swallow the mid-track gap. Here a
    // +8.7 s offset with a 3 s gap inserted mid-track splits the diffs into
    // 3× 8700 + 3× 11700. The capped band (min(max(2000, 11700/2), 2500) =
    // 2500) keeps the far cluster out → 3/6 = 50% → refused fail-closed.
    const drift = Array.from({ length: 6 }, (_, i) =>
      cue(i, i * 3, `ja-${i}`),
    );
    const ref = Array.from({ length: 6 }, (_, i) =>
      cue(i, (i >= 3 ? i * 3 + 3 : i * 3) + 8.7, `en-${i}`),
    );
    expect(estimateMedianOffset(drift, ref)).toBeNull();
  });

  it('returns null when offset exceeds 1 hour (broken estimate)', () => {
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5 + 3700, `en-${i}`), // 3700 s > 3600 s (1 hour)
    );
    const est = estimateMedianOffset(drift, ref);
    expect(est).toBeNull();
  });

  it('detects a negative offset when the reference is earlier', () => {
    const drift = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5 + 3, `ja-${i}`),
    );
    const ref = Array.from({ length: 10 }, (_, i) =>
      cue(i, i * 5, `en-${i}`),
    );
    const est = estimateMedianOffset(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(-3000);
  });

  it('works with only 1 cue on each side', () => {
    const drift = [cue(0, 10, 'ja-0')];
    const ref = [cue(0, 12.5, 'en-0')];
    const est = estimateMedianOffset(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(2500);
    expect(est!.pairCount).toBe(1);
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

  it('max pair cap is 100', () => {
    expect(LAZY_SYNC_MAX_PAIRS).toBe(100);
  });

  it('concentration band baseline is 2000 ms (docs §10.3)', () => {
    expect(LAZY_SYNC_CONCENTRATION_BAND_MS).toBe(2000);
  });

  it('concentration band cap is 2500 ms (3 s mid-track gaps stay fail-closed at large offsets)', () => {
    expect(LAZY_SYNC_CONCENTRATION_BAND_MAX_MS).toBe(2500);
  });

  it('concentration requires > 50% of diffs inside the band (fail-closed)', () => {
    expect(LAZY_SYNC_MIN_CONCENTRATION).toBe(0.5);
  });
});
