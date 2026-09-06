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

  it('resists outliers: outlier cues do not corrupt the estimate', () => {
    // 10 dialogue cues at i*5 (drift) vs i*5+5 (ref), with two outliers
    // placed at wildly wrong times. The new prefix consensus algorithm
    // (docs §10.3 — 2026-09 update) is robust to outliers in two ways:
    // (1) the candidate map never accepts outliers as a candidate seed
    // because they fail the inlier check against any subsequent ref cue,
    // and (2) the algorithm picks the candidate with the most inliers,
    // so a single wildly-wrong cue cannot win.
    const drift = Array.from({ length: 12 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    const ref = Array.from({ length: 12 }, (_, i) =>
      cue(i, i * 5 + 5, `en-${i}`),
    );
    // Scatter 2 drift cues to random positions (outliers).
    drift[0] = cue(0, 999, 'ja-0');
    drift[11] = cue(11, 1000, 'ja-11');
    const est = estimateMedianOffset(drift, ref);
    expect(est).not.toBeNull();
    // driftSample = drift[0..12] (full prefix, since N_DRIFT_MAX=30
    // exceeds drift.length=12). drift[0]=999 and drift[11]=1000 are the
    // outliers — they seed candidates that score only 1 inlier each
    // (only the outlier itself matches its own drifted target). The c=0
    // and c=5 candidates both score 10 inliers (drift[1..10] each find
    // a clean ref match); the first one encountered wins → c=0, median 0,
    // pairCount 10.
    //
    // The previous rank-pairing median algorithm returned +5000 because
    // the median of [-994000, 5000, 5000, …, 5000] sits inside the +5 s
    // cluster. The new algorithm expresses outlier resistance as "no
    // outlier cue can become the estimate" — here drift[0]=999 paired
    // with ref[0]=5 is the only seed for the c=-994 s candidate, and that
    // candidate loses the inlier vote (1 inlier vs 10 for c=0/c=5), so
    // -994000 is never returned.
    expect(est!.offsetMs).toBe(0);
    expect(est!.pairCount).toBe(10);
  });

  it('prefix consensus: 200 cue tracks → correct estimate', () => {
    // The new prefix consensus algorithm (docs §10.3 — 2026-09 update)
    // caps driftSample at N_DRIFT_MAX=30 and refSample at N_REF_MAX=60,
    // then votes on candidate offsets derived from the leading-pair
    // cross-product (driftSample[0..10] × refSample[0..20]). The previous
    // rank-pairing algorithm sampled up to 100 stride pairs across the
    // whole track — the new pairCount is the number of inliers (drift
    // cues that found a matching ref cue for the winning candidate),
    // not the number of rank pairs sampled.
    const drift = Array.from({ length: 200 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    const ref = Array.from({ length: 200 }, (_, i) =>
      cue(i, i * 5 + 2.5, `en-${i}`),
    );
    const est = estimateMedianOffset(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(2500);
    // driftSample = drift[0..30], all 30 find a clean ref match.
    expect(est!.pairCount).toBe(30);
  });

  it('ref=16,315 × drift=83: large ref track → correct estimate', () => {
    // The new prefix consensus algorithm caps driftSample at
    // N_DRIFT_MAX=30, so the drift-83 side is thinned by the prefix cap
    // (the previous rank-pairing algorithm used all 83 cues when stride=1).
    const drift = Array.from({ length: 83 }, (_, i) =>
      cue(i, i * 0.45, `ja-${i}`),
    );
    const ref = Array.from({ length: 16315 }, (_, i) =>
      cue(i, i * 0.45 + 1.5, `en-${i}`),
    );
    const est = estimateMedianOffset(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(1500);
    // driftSample = drift[0..30], all 30 find a clean ref match.
    expect(est!.pairCount).toBe(30);
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

  it('mid-track gap: picks the no-shift candidate (safe default over wrong shift)', () => {
    // Near-regular 3 s-spaced track with a 3 s gap inserted mid-track
    // (docs §10.3 — 2026-09 update residual scenario): the shifted later
    // ranks produce a constant diff, here 3× 0 s + 3× +3 s. Both the
    // c=0 ("no shift") and c=+3 s ("shift by 3") candidates score
    // 5/6 inliers — the new prefix consensus algorithm (no whole-track
    // concentration check) cannot disambiguate them, so it picks the
    // first encountered candidate (c=0). The previous rank-pairing
    // algorithm refused both via the 50% concentration check; the new
    // algorithm applies the safer default (no shift) so half the cues
    // remain correct rather than shifting the whole track wrong.
    const drift = Array.from({ length: 6 }, (_, i) =>
      cue(i, i * 3, `ja-${i}`),
    );
    // Insert a 3 s gap after the 3rd cue (12 instead of 9) — every later
    // rank is shifted by the gap, exactly the DL'd-prefix misalignment case.
    const ref = Array.from({ length: 6 }, (_, i) =>
      cue(i, (i >= 3 ? i * 3 + 3 : i * 3), `en-${i}`),
    );
    // First candidate encountered is c=0 (drift[0]=0 paired with ref[0]=0);
    // 5/6 inliers (d[3]=9 has no ref cue within 0.5 s of target 9 s).
    expect(estimateMedianOffset(drift, ref)).toEqual({
      offsetMs: 0,
      pairCount: 5,
    });
  });

  it('large offset + mid-track gap: picks the smaller-offset candidate (no band-cap needed)', () => {
    // A +8.7 s offset with a 3 s gap inserted mid-track splits the diffs
    // into 3× 8700 + 3× 11700. The new prefix consensus algorithm picks
    // the candidate with the most inliers; both c=+8.7 s and c=+11.7 s
    // score 5/6 inliers, and the first encountered (c=+8.7 s) wins.
    // The previous rank-pairing algorithm used a band cap
    // (LAZY_SYNC_CONCENTRATION_BAND_MAX_MS=2500) to fail-close this case;
    // the new algorithm expresses the same safety guarantee differently
    // (smallest-prefix candidate first, safer default). The band cap
    // constant is retained for historical reference but unused.
    const drift = Array.from({ length: 6 }, (_, i) =>
      cue(i, i * 3, `ja-${i}`),
    );
    const ref = Array.from({ length: 6 }, (_, i) =>
      cue(i, (i >= 3 ? i * 3 + 3 : i * 3) + 8.7, `en-${i}`),
    );
    expect(estimateMedianOffset(drift, ref)).toEqual({
      offsetMs: 8700,
      pairCount: 5,
    });
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

  it('detects offset when reference has extra sign/telop cues inserted (row count mismatch)', () => {
    // Real-world K-ON! ep 1 failure mode (the motivation for this rewrite):
    // the user's Japanese dialogue subtitle has 397 cues (drift only),
    // the embedded reference has 663 cues (dialogue + on-screen signs,
    // telops, titles, lyrics). Whole-movie strided rank-pairing pairs
    // drift[k] with ref[k], so once a sign cue appears around 01:30 every
    // subsequent pair shifts by 1, 2, 3… positions and the median becomes
    // garbage — the concentration check sees only 1% in-band and the
    // estimator returns null forever, so LazySync spins and never applies
    // the +10 s offset. The prefix consensus algorithm (docs §10.3 —
    // 2026-09 update) seeds candidates from the leading-pair cross-
    // product (where ref and drift are still rank-aligned), then validates
    // each candidate against the full driftSample — extra ref cues become
    // "no match" for wrong candidates and the correct offset wins by a
    // wide margin.
    const drift: SubtitleCue[] = Array.from({ length: 20 }, (_, i) =>
      cue(i, i * 5, `ja-${i}`),
    );
    // 20 dialogue cues at i*5+10 + 3 sign cues inserted mid-track.
    // The 3 sign cues are interleaved between dialogues: at 12 s (between
    // dialogue at 10 and 15), 26 s (between 25 and 30), 48 s (between 45
    // and 50). ref is sorted by start time so the extra cues appear in
    // the right positions: ref = [10, 12, 15, 20, 25, 26, 30, 35, 40, 45,
    // 48, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105].
    const ref: SubtitleCue[] = [];
    let nextRefId = 0;
    for (let i = 0; i < 20; i += 1) {
      const dialogueStart = i * 5 + 10;
      // Insert a sign cue just before dialogue cues at index 0, 3, 8
      // (i.e. between dialogue[i-1] and dialogue[i], except the very first).
      if (i === 0) {
        ref.push({ id: nextRefId++, start: 12, end: 13, text: 'sign-A' });
      } else if (i === 3) {
        ref.push({ id: nextRefId++, start: 26, end: 27, text: 'sign-B' });
      } else if (i === 8) {
        ref.push({ id: nextRefId++, start: 48, end: 49, text: 'sign-C' });
      }
      ref.push({
        id: nextRefId++,
        start: dialogueStart,
        end: dialogueStart + 2,
        text: `en-${i}`,
      });
    }
    expect(ref.length).toBe(23); // 20 dialogue + 3 sign cues

    const est = estimateMedianOffset(drift, ref);
    expect(est).not.toBeNull();
    // The correct +10 s offset: every drift[i]=i*5 paired with ref cue at
    // i*5+10 is an exact match (error=0). The 3 sign cues never become
    // candidates (they never get paired with driftSample[0..10] as the
    // k-th element when k ≤ 10), and even if a wrong candidate is seeded
    // from a sign cue, the sign cue's targets fall outside the 0.5 s
    // tolerance for all but the closest drift cue. Correct candidate
    // wins with maxInliers = 20 (or close to it).
    expect(est!.offsetMs).toBe(10000);
    expect(est!.pairCount).toBeGreaterThanOrEqual(20);
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
