// SPDX-License-Identifier: Apache-2.0
//
// LazySync — Magnet-only instant subtitle sync from the already-downloaded
// cue prefix (docs/SUBTITLE_SYNC.md §10). Pure logic only: rank-pairing
// median offset estimation and offset application. The polling loop that
// drives these helpers lives in PlayerApp (component state owns the timer,
// the toggle, and the toasts).
//
// Algorithm (rank-pairing median): pair the k-th drift cue with the k-th
// ref cue (order-based, offset-agnostic), collect time differences, and
// take the median. A concentration check refuses estimates where no single
// offset dominates (bimodal / mid-track-misaligned splits), and a median of
// exactly 0 counts as already in sync. Works for any offset magnitude, any
// language, no text matching or histogram gates needed.

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

/** Maximum number of rank pairs to sample: min(drift, ref) above this is
 *  thinned with a stride, capping both the work and the influence of a
 *  long download prefix. */
export const LAZY_SYNC_MAX_PAIRS = 100;

/** Baseline half-width of the median-concentration band (docs §10.3): a
 *  diff counts as concentrated when |d − median| ≤ max(this, |median| / 2). */
export const LAZY_SYNC_CONCENTRATION_BAND_MS = 2000;

/** Upper bound for the concentration band. Without it, the band grows
 *  proportionally with |median| and at large offsets swallows mid-track gaps
 *  (e.g. +8.7 s offset + 3 s gap → both clusters land inside the band → wrong
 *  shift applied). Kept below the smallest gap we want to reject fail-closed
 *  (3 s): 2500 < 3000. */
export const LAZY_SYNC_CONCENTRATION_BAND_MAX_MS = 2500;

/** Minimum fraction of diffs that must sit inside the concentration band.
 *  A split that does not clear this (e.g. ±1.5 s mixed cues) is refused
 *  fail-closed instead of trusting a median that represents no single
 *  cluster. */
export const LAZY_SYNC_MIN_CONCENTRATION = 0.5;

/** Estimated offset with the number of rank pairs it was derived from. */
export interface OffsetEstimate {
  offsetMs: number;
  pairCount: number;
}

/**
 * Estimate the constant offset (ref − drift, ms) between the user subtitle
 * (drift) and the embedded track (ref) using rank-pairing median.
 *
 * Pair the k-th drift cue with the k-th ref cue (order-based). The median
 * of all time differences is the offset — robust to outliers, language-
 * agnostic, works for any offset magnitude (no wrapping unlike nearest-
 * neighbor pairing).
 *
 * Returns null when:
 * - either side has no cues
 * - the diffs are not concentrated around the median (≤ 50% lie within
 *   max(2000 ms, |median| / 2), capped at 2500 ms, of it): a bimodal split
 *   (e.g. ±1.5 s mixed cues) or a mid-track rank misalignment means no single
 *   offset is representative — refuse fail-closed instead of applying a wrong
 *   shift
 * - the median exceeds LAZY_SYNC_MAX_OFFSET_MS (1 hour, broken estimate)
 *
 * A median of exactly 0 is NOT null: it means the tracks are already in
 * sync, and the caller's |offset| < LAZY_SYNC_MIN_OFFSET_MS branch converges
 * silently. (Returning null here made PlayerApp wait out the 12-min bound
 * and toast "字幕が読み込まれていません" on perfectly synced subtitles.)
 */
export function estimateMedianOffset(
  driftCues: readonly SubtitleCue[],
  refCues: readonly SubtitleCue[],
): OffsetEstimate | null {
  if (driftCues.length === 0 || refCues.length === 0) return null;

  // Rank-pair: k-th drift ↔ k-th ref. Sample to cap pair count.
  const maxPairs = Math.min(driftCues.length, refCues.length);
  const stride =
    maxPairs > LAZY_SYNC_MAX_PAIRS
      ? Math.ceil(maxPairs / LAZY_SYNC_MAX_PAIRS)
      : 1;

  const diffs: number[] = [];
  for (let i = 0; i < maxPairs; i += stride) {
    const diffMs = (refCues[i]!.start - driftCues[i]!.start) * 1000;
    diffs.push(diffMs);
  }

  // Defensive guard (currently unreachable: both arrays are non-empty and
  // stride ≥ 1 guarantee at least one pair). Kept for future refactors.
  if (diffs.length === 0) return null;

  // Median: sort and pick the middle value.
  diffs.sort((a, b) => a - b);
  const medianMs = diffs[Math.floor(diffs.length / 2)]!;

  if (!Number.isFinite(medianMs)) return null;

  // Concentration check (fail-closed): the majority of the diffs must sit
  // inside a band around the median. A bimodal split (two offset clusters,
  // e.g. ±1.5 s mixed cues, or a mid-track insertion shifting the later
  // ranks by a gap) leaves ≤ 50% inside the band — no single offset is
  // representative, so refuse instead of applying a wrong constant shift.
  const bandMs = Math.min(
    Math.max(
      LAZY_SYNC_CONCENTRATION_BAND_MS,
      Math.abs(medianMs) / 2,
    ),
    LAZY_SYNC_CONCENTRATION_BAND_MAX_MS,
  );
  let inBand = 0;
  for (const diffMs of diffs) {
    if (Math.abs(diffMs - medianMs) <= bandMs) inBand += 1;
  }
  if (inBand / diffs.length <= LAZY_SYNC_MIN_CONCENTRATION) return null;

  // Median 0 = already in sync: return an estimate (not null) so PlayerApp
  // converges silently via its |offset| < LAZY_SYNC_MIN_OFFSET_MS branch.
  if (medianMs === 0) {
    return { offsetMs: 0, pairCount: diffs.length };
  }

  // Extreme values are broken estimates.
  if (Math.abs(medianMs) > LAZY_SYNC_MAX_OFFSET_MS) return null;

  return { offsetMs: medianMs, pairCount: diffs.length };
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
