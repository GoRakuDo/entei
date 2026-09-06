// SPDX-License-Identifier: Apache-2.0
//
// LazySync — Magnet-only instant subtitle sync from the already-downloaded
// cue prefix (docs/SUBTITLE_SYNC.md §10). Pure logic only: prefix consensus
// inlier offset estimation and offset application. The polling loop that
// drives these helpers lives in PlayerApp (component state owns the timer,
// the toggle, and the toasts).
//
// Algorithm (prefix consensus inlier matching — RANSAC-style hypothesis
// voting + fine median): rank-pairing of the WHOLE track breaks as soon as
// the reference has extra cues (signs/telops/titles/lyrics) inserted
// mid-track, because every subsequent k-th pair shifts by 1, 2, 3… and the
// median becomes garbage. Instead we (1) sample the DL'd prefix, (2) vote on
// candidate offsets from early pairs, (3) score each candidate by how many
// drift cues find a matching ref cue within tolerance, and (4) take the
// median of the winning inlier set. Robust against extra cues, any
// magnitude, language-agnostic, no text matching or histogram gates.

import type { SubtitleCue } from './subtitle-reader';

/** Poll interval while LazySync is ON (docs §10.2: "数秒間隔"). */
export const LAZY_SYNC_POLL_INTERVAL_MS = 3000;

/** Offset is considered stable when consecutive estimates change by ≤ 50 ms. */
export const LAZY_SYNC_STABLE_THRESHOLD_MS = 50;

/** Upper bound for every waiting state (~12 min = 240 polls × 3 s): too few
 *  downloaded cues, or an estimate that never resolves (concentration check
 *  keeps refusing) — give up instead of showing the state forever. */
export const LAZY_SYNC_MAX_WAIT_POLLS = 240;

/** First-sync trigger: wait until the downloaded prefix holds at least this
 *  many cues before estimating an offset (docs §10: "DL 済み cue が十分な
 *  数（例: 5〜10 cue）に達したら"). */
export const LAZY_SYNC_MIN_REF_CUES = 5;

/** Offset threshold (ffsubsync --suppress-output-if-offset-less-than):
 *  an offset below this is sub-frame noise — the subtitle counts as already
 *  in sync, so no shift is applied. */
export const LAZY_SYNC_MIN_OFFSET_MS = 100;

/** Maximum offset: values beyond this are treated as broken estimates. */
export const LAZY_SYNC_MAX_OFFSET_MS = 3600000;

/** Maximum number of rank pairs to sample (rank-pairing era): min(drift,
 *  ref) above this was thinned with a stride, capping both the work and the
 *  influence of a long download prefix. The current algorithm uses fixed
 *  prefix sizes (N_DRIFT_MAX / N_REF_MAX) and does not stride-sample, but
 *  the constant is retained for historical reference (docs §10.3). */
export const LAZY_SYNC_MAX_PAIRS = 100;

/** Baseline half-width of the median-concentration band (docs §10.3, rank-
 *  pairing era): a diff counted as concentrated when |d − median| ≤
 *  max(this, |median| / 2). Retained for historical reference — the
 *  current prefix consensus algorithm uses an inlier-vote gate
 *  (maxInliers / N_DRIFT) instead. */
export const LAZY_SYNC_CONCENTRATION_BAND_MS = 2000;

/** Upper bound for the concentration band. Retained for historical reference
 *  (docs §10.3, rank-pairing era). The current algorithm does not use this
 *  constant. */
export const LAZY_SYNC_CONCENTRATION_BAND_MAX_MS = 2500;

/** Minimum fraction of cues (denominator: min(N_DRIFT, N_REF)) that must
 *  be inliers for the winning candidate (prefix consensus, docs §10.3 —
 *  2026-09 update): below this fraction no single offset is representative
 *  (e.g. ±1.5 s mixed cues where every cue is > tolerance from any
 *  candidate's target) and we refuse fail-closed. */
export const LAZY_SYNC_MIN_CONCENTRATION = 0.5;

/** Maximum number of drift cues considered by the consensus algorithm:
 *  the DL'd prefix (first N_DRIFT_MAX cues) is the voting population, so
 *  extra cues beyond this do not change the estimate. */
export const N_DRIFT_MAX = 30;

/** Maximum number of ref cues scanned as nearest-neighbor targets. Larger
 *  than N_DRIFT_MAX because the reference can legitimately hold many more
 *  cues per minute (signs, telops, lyrics) than the user dialogue track. */
export const N_REF_MAX = 60;

/** Maximum number of leading drift cues used to seed candidate offsets
 *  (cross-product with CANDIDATE_REF_MAX). The first 10 dialogue cues
 *  typically span a few minutes — enough surface area for a unique +
 *  large-offset estimate, small enough to keep the candidate map bounded. */
export const CANDIDATE_DRIFT_MAX = 10;

/** Maximum number of leading ref cues used to seed candidate offsets. */
export const CANDIDATE_REF_MAX = 20;

/** Tolerance for "closest ref cue" inlier matching: a drift cue d at
 *  driftSample with candidate offset c counts as an inlier when there
 *  exists a ref cue within this many seconds of (d.start + c). 0.5 s is
 *  tight enough to reject random bimodal hits (e.g. ±1.5 s mixed cues
 *  never reach a match — every cue is ≥ 1.5 s from any candidate target)
 *  and loose enough to absorb SRT/VTT timing jitter on real-world cues. */
export const MATCH_TOLERANCE_SEC = 0.5;

/** Round candidate offsets to this grid so near-identical hypotheses from
 *  multiple prefix pairs collapse to a single vote (25 ms = 1 frame at
 *  40 fps, well below human timing perception). */
const CANDIDATE_BIN_MS = 25;

/** Estimated offset with the number of inliers it was derived from. */
export interface OffsetEstimate {
  offsetMs: number;
  pairCount: number;
}

/**
 * Estimate the constant offset (ref − drift, ms) between the user subtitle
 * (drift) and the embedded track (ref) using prefix consensus inlier
 * matching.
 *
 * Algorithm (docs §10.3 — 2026-09 update, replaces rank-pairing median):
 *  1. Sample the DL'd prefix: driftSample = drift[0..N_DRIFT],
 *     refSample = ref[0..N_REF] (N_DRIFT ≤ N_DRIFT_MAX, N_REF ≤ N_REF_MAX).
 *  2. Seed candidate offsets from leading-pair cross-product
 *     (driftSample[0..10] × refSample[0..20]), binned to a 25 ms grid and
 *     capped at LAZY_SYNC_MAX_OFFSET_MS.
 *  3. For each candidate, scan every drift cue in driftSample, find the
 *     closest ref cue in refSample, and count it as an inlier when the
 *     error is ≤ MATCH_TOLERANCE_SEC. Record the exact (matchedRef.start
 *     − d.start) * 1000 for every inlier.
 *  4. Pick the candidate with the most inliers. Fail-closed if its support
 *     is ≤ LAZY_SYNC_MIN_CONCENTRATION of min(N_DRIFT, N_REF) — the inlier
 *     count is bounded by the smaller side, so the threshold denominator is
 *     too (e.g. ±1.5 s mixed cues → 0 inliers → 0/min(...) ≤ 0.5 → null;
 *     sparse ref prefix where N_REF=5 → 5/5 = 100% → pass even though
 *     N_DRIFT=30 would always refuse).
 *  5. Fine median of the winning inlier set is the returned offset. Median
 *     0 means "already in sync" (not null) so PlayerApp converges silently
 *     via its |offset| < LAZY_SYNC_MIN_OFFSET_MS branch; median beyond
 *     LAZY_SYNC_MAX_OFFSET_MS means a broken result and returns null.
 *
 * Returns null when:
 * - either side has no cues
 * - the winning candidate's support is ≤ 50% of min(N_DRIFT, N_REF)
 *   (bimodal split, broken reference, mid-track rank misalignment that
 *   puts every candidate below the threshold, etc.)
 * - the median offset exceeds 1 hour
 *
 * Robust against extra cues in the reference (the K-ON! failure mode that
 * motivated this rewrite): when the ref track has more cues than the user
 * track (signs, telops, titles, lyrics inserted mid-track), whole-track
 * rank pairing shifts every subsequent pair by 1, 2, 3… positions and the
 * median becomes garbage. Prefix consensus only looks at leading pairs to
 * seed candidates, then validates each candidate against the full prefix
 * — extra cues in ref become "no match" for the wrong candidates rather
 * than silently corrupting the diffs.
 */
export function estimateMedianOffset(
  driftCues: readonly SubtitleCue[],
  refCues: readonly SubtitleCue[],
): OffsetEstimate | null {
  if (driftCues.length === 0 || refCues.length === 0) return null;

  // Sample the DL'd prefix.
  const N_DRIFT = Math.min(driftCues.length, N_DRIFT_MAX);
  const N_REF = Math.min(refCues.length, N_REF_MAX);
  const driftSample = driftCues.slice(0, N_DRIFT);
  const refSample = refCues.slice(0, N_REF);

  // Seed candidate offsets from leading-pair cross-product, binned to a
  // 25 ms grid (near-identical hypotheses collapse to a single vote).
  const candDriftLen = Math.min(CANDIDATE_DRIFT_MAX, N_DRIFT);
  const candRefLen = Math.min(CANDIDATE_REF_MAX, N_REF);
  // Map: bin index (round(diffMs / 25)) → representative offsetMs. Using
  // the binned ms value as both key and stored value keeps the candidate
  // aligned to the 25 ms grid used for voting — every vote for the same
  // bin is a vote for the same offset.
  const candidateMap = new Map<number, number>();
  for (let i = 0; i < candDriftLen; i += 1) {
    const driftStart = driftSample[i]!.start;
    for (let j = 0; j < candRefLen; j += 1) {
      const diffMs = (refSample[j]!.start - driftStart) * 1000;
      if (Math.abs(diffMs) > LAZY_SYNC_MAX_OFFSET_MS) continue;
      const bin = Math.round(diffMs / CANDIDATE_BIN_MS);
      if (!candidateMap.has(bin)) {
        candidateMap.set(bin, bin * CANDIDATE_BIN_MS);
      }
    }
  }
  // Defensive: candidateMap can only be empty when every leading pair has
  // an offset beyond LAZY_SYNC_MAX_OFFSET_MS, which requires an unrealistic
  // 1 h+ offset — driftSample cannot have N_DRIFT ≤ 0 because the guard at
  // the top rejects empty inputs. Kept for future refactors.
  if (candidateMap.size === 0) return null;

  // Score each candidate: for every drift cue, find the closest ref cue and
  // count it as an inlier when the error is ≤ MATCH_TOLERANCE_SEC. Record
  // the EXACT diff (matchedRef.start − d.start) * 1000 — the fine median of
  // these is the returned offset, so a single match that misses by 50 ms
  // pulls the median by 50 ms.
  let bestOffsetMs: number | null = null;
  let maxInliers = 0;
  let bestInlierDiffs: number[] = [];
  for (const offsetMs of candidateMap.values()) {
    const offsetSec = offsetMs / 1000;
    const inlierDiffs: number[] = [];
    for (const driftCue of driftSample) {
      const target = driftCue.start + offsetSec;
      let minError = Infinity;
      let matchedRefIdx = -1;
      for (let k = 0; k < refSample.length; k += 1) {
        const error = Math.abs(refSample[k]!.start - target);
        if (error < minError) {
          minError = error;
          matchedRefIdx = k;
        }
      }
      if (
        minError <= MATCH_TOLERANCE_SEC &&
        matchedRefIdx >= 0
      ) {
        const matchedRef = refSample[matchedRefIdx]!;
        inlierDiffs.push((matchedRef.start - driftCue.start) * 1000);
      }
    }
    if (inlierDiffs.length > maxInliers) {
      maxInliers = inlierDiffs.length;
      bestOffsetMs = offsetMs;
      bestInlierDiffs = inlierDiffs;
    }
  }

  // Fail-closed: no offset dominates → refuse.
  //
  // The denominator is min(N_DRIFT, N_REF) — the inlier count is bounded
  // by the smaller of the two sides, so the threshold is meaningful only
  // when also bounded by it. With N_DRIFT=30 and N_REF=5 (sparse ref DL'd
  // prefix), maxInliers can be at most 5 and 5/30 would always refuse
  // even when every ref cue has a clean match; min(30, 5) = 5 gives the
  // algorithm a chance to detect the offset from the cues it actually has.
  if (bestOffsetMs === null) return null;
  const concentrationDenom = Math.min(N_DRIFT, N_REF);
  if (maxInliers / concentrationDenom <= LAZY_SYNC_MIN_CONCENTRATION) {
    return null;
  }

  // Fine median from the best inlier set. The inlier diffs are integer ms,
  // Math.round keeps the median itself integer ms (matches PlayerApp's
  // |offset| < LAZY_SYNC_MIN_OFFSET_MS comparison).
  bestInlierDiffs.sort((a, b) => a - b);
  const medianMs = Math.round(
    bestInlierDiffs[Math.floor(bestInlierDiffs.length / 2)]!,
  );

  if (!Number.isFinite(medianMs)) return null;

  // Median 0 = already in sync: return an estimate (not null) so PlayerApp
  // converges silently via its |offset| < LAZY_SYNC_MIN_OFFSET_MS branch.
  if (medianMs === 0) {
    return { offsetMs: 0, pairCount: maxInliers };
  }

  // Extreme values are broken estimates.
  if (Math.abs(medianMs) > LAZY_SYNC_MAX_OFFSET_MS) return null;

  return { offsetMs: medianMs, pairCount: maxInliers };
}

/**
 * Apply a constant offset (ms) to cues: shift start/end, clamp negative
 * starts to 0, and drop cues that collapse to a non-positive length (the
 * same rule the parser uses). IDs are reindexed by position. The display is
 * always derived from the ORIGINAL base cues, so repeated applications never
 * accumulate drift.
 */
export function shiftCuesByOffset(
  cues: readonly SubtitleCue[],
  offsetMs: number,
): SubtitleCue[] {
  if (!Number.isFinite(offsetMs) || offsetMs === 0) {
    return cues.map((cue, id) => ({ ...cue, id }));
  }
  const offsetSec = offsetMs / 1000;
  const shifted: SubtitleCue[] = [];
  for (const cue of cues) {
    const start = Math.max(0, cue.start + offsetSec);
    const end = Math.max(start, cue.end + offsetSec);
    if (end <= start) continue;
    shifted.push({ ...cue, id: shifted.length, start, end });
  }
  return shifted;
}
