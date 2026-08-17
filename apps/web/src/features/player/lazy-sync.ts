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
// take the median. Works for any offset magnitude, any language, no text
// matching or quality gates needed.

import type { SubtitleCue } from './subtitle-reader';

/** Poll interval while LazySync is ON (docs §10.2: "数秒間隔"). */
export const LAZY_SYNC_POLL_INTERVAL_MS = 3000;

/** Offset is considered stable when consecutive estimates change by ≤ 50 ms. */
export const LAZY_SYNC_STABLE_THRESHOLD_MS = 50;

/** Upper bound for every waiting state (~12 min = 240 polls × 3 s):
 *  too few downloaded cues, too few matches, or an outlier offset that
 *  never resolves — give up instead of showing the state forever. */
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

/** Maximum number of pairs to sample. */
export const LAZY_SYNC_MAX_DRIFT_SAMPLES = 100;

/** Estimated offset with pair count metadata. */
export interface OffsetEstimate {
  offsetMs: number;
  peakCount: number;
  totalPairs: number;
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
 * - the median is 0 (already in sync)
 * - the median exceeds LAZY_SYNC_MAX_OFFSET_MS (1 hour, broken estimate)
 */
export function estimateOffsetFromNearestMedian(
  driftCues: readonly SubtitleCue[],
  refCues: readonly SubtitleCue[],
): OffsetEstimate | null {
  if (driftCues.length === 0 || refCues.length === 0) return null;

  // Rank-pair: k-th drift ↔ k-th ref. Sample to cap pair count.
  const maxPairs = Math.min(driftCues.length, refCues.length);
  const stride =
    maxPairs > LAZY_SYNC_MAX_DRIFT_SAMPLES
      ? Math.ceil(maxPairs / LAZY_SYNC_MAX_DRIFT_SAMPLES)
      : 1;

  const diffs: number[] = [];
  for (let i = 0; i < maxPairs; i += stride) {
    const diffMs = (refCues[i]!.start - driftCues[i]!.start) * 1000;
    diffs.push(diffMs);
  }

  if (diffs.length === 0) return null;

  // Median: sort and pick the middle value.
  diffs.sort((a, b) => a - b);
  const medianMs = diffs[Math.floor(diffs.length / 2)]!;

  // Reject 0 (already in sync) and extreme values (broken estimate).
  if (medianMs === 0 || !Number.isFinite(medianMs)) return null;
  if (Math.abs(medianMs) > LAZY_SYNC_MAX_OFFSET_MS) return null;

  return {
    offsetMs: medianMs,
    peakCount: diffs.length,
    totalPairs: diffs.length,
  };
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
