// SPDX-License-Identifier: Apache-2.0
// Pure-logic tests for LazySync (docs SUBTITLE_SYNC.md §10): all-pair
// start-time-difference histogram peak estimation and offset application.

import { describe, expect, it } from 'vitest';
import type { SubtitleCue } from '../src/features/player/subtitle-reader';
import {
  estimateOffsetFromHistogram,
  normalizeCueText,
  shiftCuesByOffset,
  LAZY_SYNC_HISTOGRAM_BIN_MS,
  LAZY_SYNC_HISTOGRAM_SAMPLE_EVERY,
  LAZY_SYNC_HISTOGRAM_SAMPLE_EVERY_SMALL,
  LAZY_SYNC_HISTOGRAM_SMALL_REF_THRESHOLD,
  LAZY_SYNC_MIN_PEAK_COUNT,
  LAZY_SYNC_PEAK_MARGIN,
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

describe('normalizeCueText', () => {
  it('folds case, whitespace, punctuation and full-width spaces', () => {
    expect(normalizeCueText('Hello, world!')).toBe('helloworld');
    expect(normalizeCueText('hello  world')).toBe('helloworld');
    expect(normalizeCueText('　全角　スペース　')).toBe('全角スペース');
    expect(normalizeCueText('Second—line…')).toBe('secondline');
    expect(normalizeCueText('!!!')).toBe('');
  });
});

describe('text matching phase (user spec B)', () => {
  it('detects a +10 s drift via text (beyond the time-based envelope)', () => {
    const drift = [
      cue(0, 10, 'First line'),
      cue(1, 20, 'Second line'),
      cue(2, 30, 'Third line'),
    ];
    const ref = [
      cue(0, 20, 'First line'),
      cue(1, 30, 'Second line'),
      cue(2, 40, 'Third line'),
    ];
    const est = estimateOffsetFromHistogram(drift, ref);
    expect(est).not.toBeNull();
    expect(est).toEqual({ offsetMs: 10000, peakCount: 3, totalPairs: 3 });
  });

  it('detects a +3 min drift via text (any magnitude)', () => {
    const drift = [
      cue(0, 10, 'First line'),
      cue(1, 20, 'Second line'),
      cue(2, 30, 'Third line'),
    ];
    const ref = [
      cue(0, 190, 'First line'),
      cue(1, 200, 'Second line'),
      cue(2, 210, 'Third line'),
    ];
    const est = estimateOffsetFromHistogram(drift, ref);
    expect(est).not.toBeNull();
    expect(est).toEqual({ offsetMs: 180000, peakCount: 3, totalPairs: 3 });
  });

  it('detects a +1.5 s drift via text', () => {
    const drift = [
      cue(0, 10, 'First line'),
      cue(1, 20, 'Second line'),
      cue(2, 30, 'Third line'),
    ];
    const ref = [
      cue(0, 11.5, 'First line'),
      cue(1, 21.5, 'Second line'),
      cue(2, 31.5, 'Third line'),
    ];
    const est = estimateOffsetFromHistogram(drift, ref);
    expect(est).toEqual({ offsetMs: 1500, peakCount: 3, totalPairs: 3 });
  });

  it('tolerates case / whitespace / punctuation variance', () => {
    const drift = [
      cue(0, 10, 'Hello, world!'),
      cue(1, 20, 'Second—line…'),
      cue(2, 30, 'Third'),
    ];
    const ref = [
      cue(0, 11.5, 'hello  world'),
      cue(1, 21.5, 'second line'),
      cue(2, 31.5, 'third'),
    ];
    const est = estimateOffsetFromHistogram(drift, ref);
    expect(est).toEqual({ offsetMs: 1500, peakCount: 3, totalPairs: 3 });
  });

  it('rank-pairs repeated lines (k-th ↔ k-th), recovering a large offset', () => {
    // "repeat" recurs every 30 s on both sides with a +20 s offset — larger
    // than half the 30 s interval. A temporally-nearest pairing would latch
    // every ref occurrence onto the NEXT occurrence and misreport -10 s
    // (review P1-2); rank pairing keeps each k-th occurrence paired with
    // its true counterpart → the true +20 s.
    const drift = [
      cue(0, 0, 'repeat'),
      cue(1, 30, 'repeat'),
      cue(2, 60, 'repeat'),
      cue(3, 90, 'repeat'),
      cue(4, 100, 'unique a'),
      cue(5, 130, 'unique b'),
    ];
    const ref = [
      cue(0, 20, 'repeat'),
      cue(1, 50, 'repeat'),
      cue(2, 80, 'repeat'),
      cue(3, 110, 'repeat'),
      cue(4, 120, 'unique a'),
      cue(5, 150, 'unique b'),
    ];
    const est = estimateOffsetFromHistogram(drift, ref);
    expect(est).toEqual({ offsetMs: 20000, peakCount: 6, totalPairs: 6 });
  });

  it('never misapplies on a heavy repeated-line + large-offset track (review P1-2 repro)', () => {
    // The review's reproduction: "repeat" every 30 s × 11 + 2 unique
    // lines, offset +20 s. Rank pairing recovers the true +20 s instead of
    // the -10 s that a temporally-nearest pairing would report.
    const drift: SubtitleCue[] = [];
    const ref: SubtitleCue[] = [];
    for (let k = 0; k < 11; k++) {
      drift.push(cue(k, k * 30, 'repeat'));
      ref.push(cue(k, k * 30 + 20, 'repeat'));
    }
    drift.push(cue(100, 335, 'unique a'));
    drift.push(cue(101, 365, 'unique b'));
    ref.push(cue(100, 355, 'unique a'));
    ref.push(cue(101, 385, 'unique b'));
    const est = estimateOffsetFromHistogram(drift, ref);
    expect(est).not.toBeNull();
    expect(est).toEqual({ offsetMs: 20000, peakCount: 13, totalPairs: 13 });
  });

  it('a missing mid-occurrence scatters the ranks → fail-closed, not misapplied', () => {
    // The drift track lost one middle "repeat" (0, 60 instead of 0, 30,
    // 60): ranks shift after it, the text diffs scatter (+20 s and -10 s)
    // and no trustworthy text peak forms. The fallback yields a single
    // pair (peakCount 1) — below the caller's quality gate. Never a wrong
    // sharp estimate.
    const drift = [
      cue(0, 0, 'repeat'),
      cue(1, 60, 'repeat'),
      cue(2, 90, 'unique'),
    ];
    const ref = [
      cue(0, 20, 'repeat'),
      cue(1, 50, 'repeat'),
      cue(2, 80, 'repeat'),
      cue(3, 110, 'unique'),
    ];
    const est = estimateOffsetFromHistogram(drift, ref);
    expect(est).not.toBeNull();
    expect(est!.peakCount).toBeLessThan(LAZY_SYNC_MIN_PEAK_COUNT);
  });

  it('falls back to time-based pairing when the text peak is weak (< 3)', () => {
    // Only 2 text matches → text peak 2 < LAZY_SYNC_MIN_PEAK_COUNT → the
    // fallback runs and samples a single ref (stride 10 for 3 cues).
    const drift = [
      cue(0, 10, 'match'),
      cue(1, 20, 'match'),
      cue(2, 30, 'unique-a'),
    ];
    const ref = [
      cue(0, 11.5, 'match'),
      cue(1, 21.5, 'match'),
      cue(2, 31.5, 'unique-b'),
    ];
    const est = estimateOffsetFromHistogram(drift, ref);
    expect(est).toEqual({ offsetMs: 1500, peakCount: 1, totalPairs: 1 });
  });

  it('falls back to time-based pairing when the languages differ', () => {
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
    const est = estimateOffsetFromHistogram(jaDrift, enRef);
    // No text pair → the nearest-neighbor fallback detects +1.5 s within
    // its envelope.
    expect(est).toEqual({ offsetMs: 1500, peakCount: 1, totalPairs: 1 });
  });
});

describe('estimateOffsetFromHistogram', () => {
  // Build a uniform 1:1 track pair. The time-based fallback uses RANK
  // pairing (k-th ref cue ↔ k-th drift cue), so any offset is revealed as
  // its unwrapped value; the ENVELOPE check then accepts only offsets
  // smaller than half the drift gap. These fixtures keep the offset inside
  // the envelope so the estimate is adopted.
  function uniform(
    count: number,
    spacingSec: number,
    offsetSec: number,
    prefix: string,
  ): SubtitleCue[] {
    return Array.from({ length: count }, (_, i) =>
      cue(i, i * spacingSec + offsetSec, `${prefix}-${i}`),
    );
  }

  it('detects a +1.5 s offset on a low-density 1:1 track', () => {
    const est = estimateOffsetFromHistogram(
      uniform(1000, 7.2, 0, 'd'),
      uniform(1000, 7.2, 1.5, 'r'),
    );
    expect(est).not.toBeNull();
    expect(est).toEqual({ offsetMs: 1500, peakCount: 20, totalPairs: 20 });
  });

  it('detects the same offset when the texts differ (different language)', () => {
    const est = estimateOffsetFromHistogram(
      uniform(1000, 7.2, 0, 'こんにちは'),
      uniform(1000, 7.2, 1.5, 'Hello'),
    );
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(1500);
    expect(est!.peakCount).toBe(20);
  });

  it('reports a negative offset when the reference is earlier', () => {
    const est = estimateOffsetFromHistogram(
      uniform(1000, 7.2, 0, 'd'),
      uniform(1000, 7.2, -1.5, 'r'),
    );
    expect(est).not.toBeNull();
    expect(est).toEqual({ offsetMs: -1500, peakCount: 20, totalPairs: 20 });
  });

  it('detects a +10 s offset when the drift spacing allows it', () => {
    // 200 drift cues over 2 h (36 s apart) → +10 s < gap/2 = 18 s, so the
    // fallback's envelope check accepts the rank-pairing estimate.
    const est = estimateOffsetFromHistogram(
      uniform(200, 36, 0, 'd'),
      uniform(200, 36, 10, 'r'),
    );
    expect(est).not.toBeNull();
    expect(est).toEqual({ offsetMs: 10000, peakCount: 4, totalPairs: 4 });
  });

  it('keeps the aligned-prefix peak; extra far-apart ref cues never pollute it', () => {
    // Drift: 150 cues (positions 0-149). Ref: positions 0-100 aligned at
    // +1.5 s; positions 101-149 are unrelated cues minutes away. Rank
    // pairing samples positions 0/50/100 (stride 50) and simply never
    // touches the far cues → the true +1.5 s peak holds.
    const drift = Array.from({ length: 150 }, (_, i) =>
      cue(i, i * 7.2, `drift-${i}`),
    );
    const ref = Array.from({ length: 150 }, (_, i) =>
      cue(i, i < 101 ? i * 7.2 + 1.5 : 5000 + i, `ref-${i}`),
    );
    const est = estimateOffsetFromHistogram(drift, ref);
    expect(est).not.toBeNull();
    expect(est).toEqual({ offsetMs: 1500, peakCount: 3, totalPairs: 3 });
  });

  it('shrinks the sample stride on a short prefix (review P2-1)', () => {
    // 50 refs < LAZY_SYNC_HISTOGRAM_SMALL_REF_THRESHOLD → stride 10 →
    // indices 0, 10, 20, 30, 40 = 5 pairs. The old fixed 50-stride would
    // have sampled only index 0 (1 pair, peak 1 < gate 3).
    const est = estimateOffsetFromHistogram(
      uniform(50, 10, 0, 'd'),
      uniform(50, 10, 1.5, 'r'),
    );
    expect(est).not.toBeNull();
    expect(est).toEqual({ offsetMs: 1500, peakCount: 5, totalPairs: 5 });
  });

  it('snaps the peak to the 500 ms bin grid', () => {
    const drift3 = uniform(3, 10, 10, 'd');
    // 1.4 s and 1.6 s both live in the [1250, 1750) bin → peak center 1500.
    expect(estimateOffsetFromHistogram(drift3, uniform(3, 10, 11.4, 'r'))!.offsetMs).toBe(1500);
    expect(estimateOffsetFromHistogram(drift3, uniform(3, 10, 11.6, 'r'))!.offsetMs).toBe(1500);
    // 2.4 s → bin 5 → center 2500.
    expect(estimateOffsetFromHistogram(drift3, uniform(3, 10, 12.4, 'r'))!.offsetMs).toBe(2500);
  });

  it('returns null when either side has no cues', () => {
    const drift3 = uniform(3, 10, 10, 'd');
    const ref3 = uniform(3, 10, 11.5, 'r');
    expect(estimateOffsetFromHistogram(drift3, [])).toBeNull();
    expect(estimateOffsetFromHistogram([], ref3)).toBeNull();
    expect(estimateOffsetFromHistogram([], [])).toBeNull();
  });

  it('near-zero offsets fall under the already-in-sync threshold', () => {
    const est = estimateOffsetFromHistogram(
      uniform(3, 10, 10, 'd'),
      uniform(3, 10, 10.03, 'r'),
    );
    expect(est).not.toBeNull();
    // 30 ms → bin 0 → offset 0.
    expect(est!.offsetMs).toBe(0);
    expect(Math.abs(est!.offsetMs)).toBeLessThan(LAZY_SYNC_MIN_OFFSET_MS);
  });
});

describe('time-based fallback envelope (review P1-1 / P2-1)', () => {
  const uniform = (
    count: number,
    spacing: number,
    offset: number,
    prefix: string,
  ): SubtitleCue[] =>
    Array.from({ length: count }, (_, i) =>
      cue(i, i * spacing + offset, `${prefix}-${i}`),
    );

  it('refuses a 40 s-spaced +30 s drift instead of misapplying -10 s (P1-1 repro)', () => {
    // 120 cues @ 40 s, offset +30 s (≥ gap/2 = 20 s), different language.
    // A nearest-pairing would wrap every diff to -10 s and misapply it;
    // rank pairing reveals the true +30 s and the envelope check refuses
    // it (fail-closed → keep waiting).
    const est = estimateOffsetFromHistogram(
      uniform(120, 40, 0, 'd'),
      uniform(120, 40, 30, 'r'),
    );
    expect(est).toBeNull();
  });

  it('refuses a +10 s drift on 5 s spacing instead of silent "in sync" (P2-1)', () => {
    // δ = 10 s is a whole multiple of the 5 s gap (δ ≡ 0 mod gap): a
    // nearest-pairing would wrap every diff to exactly 0 → bin 0 → the
    // "already in sync" path with the subtitle still 10 s off. Rank
    // pairing reveals +10 s and the envelope check refuses it.
    const est = estimateOffsetFromHistogram(
      uniform(120, 5, 0, 'd'),
      uniform(120, 5, 10, 'r'),
    );
    expect(est).toBeNull();
  });

  it('still reports a genuine in-sync track as offset 0', () => {
    const est = estimateOffsetFromHistogram(
      uniform(120, 5, 0, 'd'),
      uniform(120, 5, 0.05, 'r'),
    );
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBe(0);
    expect(est!.peakCount).toBe(3);
  });

  it('succeeds with ≥ 3 sampled pairs inside the envelope (fallback)', () => {
    // 120 cues @ 7.2 s, +1.5 s, different language → 3 sampled rank pairs,
    // peak 3 ≥ the quality gate, |1.5 s| < gap/2 → adopted.
    const est = estimateOffsetFromHistogram(
      uniform(120, 7.2, 0, 'd'),
      uniform(120, 7.2, 1.5, 'r'),
    );
    expect(est).toEqual({ offsetMs: 1500, peakCount: 3, totalPairs: 3 });
  });
});

describe('dense-track regression (review P1-1 / P2-4)', () => {
  // A dense embedded track (16000 cues at 0.45 s over 2 h) against a sparse
  // 1000-cue user subtitle. With the old all-pairs histogram this built an
  // accidental-coincidence background that rivaled the true peak and was
  // misapplied 50/50; the current pairing (text-first, rank-pairing
  // fallback) must never misapply.
  const DRIFT_COUNT = 1000;
  const DRIFT_SPACING = 7.2;
  const REF_COUNT = 16000;
  const REF_SPACING = 0.45;
  const drift = Array.from({ length: DRIFT_COUNT }, (_, i) =>
    cue(i, i * DRIFT_SPACING, `drift-${i}`),
  );
  const denseRef = (offsetSec: number): SubtitleCue[] =>
    Array.from({ length: REF_COUNT }, (_, i) =>
      cue(i, i * REF_SPACING + offsetSec, `ref-${i}`),
    );

  it('does not misapply a +10 s drift on a dense track', () => {
    const est = estimateOffsetFromHistogram(drift, denseRef(10));
    // Acceptance per review: correct offset OR not applied — never a wrong
    // estimate. (Measured behavior: the flat noise band fails the margin
    // gate → null → the caller keeps waiting.)
    if (est !== null) {
      expect(Math.abs(est.offsetMs - 10000)).toBeLessThanOrEqual(
        LAZY_SYNC_HISTOGRAM_BIN_MS,
      );
    }
  });

  it('does not misapply a +25 min drift on a dense track', () => {
    const est = estimateOffsetFromHistogram(drift, denseRef(1500));
    if (est !== null) {
      expect(Math.abs(est.offsetMs - 1500000)).toBeLessThanOrEqual(
        LAZY_SYNC_HISTOGRAM_BIN_MS,
      );
    }
  });
});

describe('margin gate (review P1-2)', () => {
  const drift = Array.from({ length: 1000 }, (_, i) =>
    cue(i, i * 7.2, `drift-${i}`),
  );

  it('refuses a ±1.5 s mix (two equal peaks, fail-closed)', () => {
    // Half the lines at +1.5 s and half at −1.5 s form two equal peaks;
    // peakCount < 2 × second → refused, so the caller keeps waiting
    // instead of applying an ambiguous offset.
    const ref = Array.from({ length: 1000 }, (_, i) =>
      cue(i, i * 7.2 + (i < 500 ? 1.5 : -1.5), `ref-${i}`),
    );
    expect(estimateOffsetFromHistogram(drift, ref)).toBeNull();
  });

  it('still reports a weak single-pair peak when nothing correlates', () => {
    // Unrelated refs minutes away: the fallback's rank pair lands at a
    // far-apart difference — the envelope check refuses it (|offset| ≥
    // gap/2 → null, fail-closed). Either way the caller never applies a
    // wrong estimate: null, or a peak below the quality gate.
    const ref = Array.from({ length: 3 }, (_, i) =>
      cue(i, 1000 + i * 1000, `ref-${i}`),
    );
    const drift3 = [cue(0, 10, 'A'), cue(1, 20, 'B'), cue(2, 30, 'C')];
    const est = estimateOffsetFromHistogram(drift3, ref);
    expect(est === null || est.peakCount < LAZY_SYNC_MIN_PEAK_COUNT).toBe(
      true,
    );
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

  it('histogram bin width is 500 ms per docs §10.3', () => {
    expect(LAZY_SYNC_HISTOGRAM_BIN_MS).toBe(500);
  });

  it('ref cues are sampled every 50th per docs §10.3', () => {
    expect(LAZY_SYNC_HISTOGRAM_SAMPLE_EVERY).toBe(50);
  });

  it('short prefixes use a tighter stride 10 (review P2-1)', () => {
    expect(LAZY_SYNC_HISTOGRAM_SAMPLE_EVERY_SMALL).toBe(10);
    expect(LAZY_SYNC_HISTOGRAM_SMALL_REF_THRESHOLD).toBe(100);
  });

  it('margin gate is 2× (review P1-2)', () => {
    expect(LAZY_SYNC_PEAK_MARGIN).toBe(2);
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

  it('quality gate requires ≥ 3 pairs in the peak bin (ffsubsync --skip-sync-on-low-quality)', () => {
    expect(LAZY_SYNC_MIN_PEAK_COUNT).toBe(3);
  });

  it('offsets under 100 ms count as already in sync (ffsubsync suppress-output-if-offset-less-than)', () => {
    expect(LAZY_SYNC_MIN_OFFSET_MS).toBe(100);
  });
});
