// SPDX-License-Identifier: Apache-2.0
//
// LazySync — Magnet-only instant subtitle sync from the already-downloaded
// cue prefix (docs/SUBTITLE_SYNC.md §10). Pure logic only: time-proximity
// cue pairing, constant-offset estimation, and offset application. The
// polling loop that drives these helpers lives in PlayerApp (component
// state owns the timer, the toggle, and the toasts).
//
// Premise (docs §10.1-10.3): MKV subtitle clusters are interleaved in play
// order, so the companion can serve the cues of the downloaded prefix long
// before the whole download completes. The user's subtitle and the embedded
// track show the same lines at the same wall-clock times; their start-time
// differences are a near-constant offset. Cues are paired by TIME PROXIMITY
// (the same timeband) instead of by text, so the two tracks do not need to
// share a language — only the constant offset needs to be smaller than the
// match window so the correct pair stays unambiguous. A few matched cues
// estimate the offset; more cues (as the download progresses) refine it.

import type { SubtitleCue } from './subtitle-reader';

/** Poll interval while LazySync is ON (docs §10.2: "数秒間隔"). */
export const LAZY_SYNC_POLL_INTERVAL_MS = 3000;

/** Offset is considered stable when consecutive estimates change by ≤ 50 ms. */
export const LAZY_SYNC_STABLE_THRESHOLD_MS = 50;

/** Cue-pairing window: a ref cue matches a drift cue only when their start
 *  times are within ±LAZY_SYNC_MATCH_WINDOW_MS. Tune this against the
 *  expected offset range and subtitle density: too small misses pairs when
 *  the offset is large, too large pairs cues from neighboring lines. */
export const LAZY_SYNC_MATCH_WINDOW_MS = 5000;

/** Upper bound for every waiting state (~12 min = 240 polls × 3 s):
 *  too few downloaded cues, too few matches, or an outlier offset that
 *  never resolves — give up instead of showing the state forever. */
export const LAZY_SYNC_MAX_WAIT_POLLS = 240;

/** First-sync trigger: wait until the downloaded prefix holds at least this
 *  many cues before estimating an offset (docs §10: "DL 済み cue が十分な
 *  数（例: 5〜10 cue）に達したら"). ffsubsync-style "wait for a usable
 *  sample" — an estimate from fewer cues is not trustworthy. */
export const LAZY_SYNC_MIN_REF_CUES = 5;

/** Quality gate (ffsubsync --skip-sync-on-low-quality): an offset is applied
 *  only when at least this many cue pairs matched. Fewer matches means the
 *  alignment is unreliable — wait for the download to yield more pairs
 *  instead of syncing on noise. */
export const LAZY_SYNC_MIN_MATCHES = 3;

/** Offset threshold (ffsubsync --suppress-output-if-offset-less-than):
 *  an offset below this is sub-frame noise — the subtitle counts as already
 *  in sync, so no shift is applied. */
export const LAZY_SYNC_MIN_OFFSET_MS = 100;

/** Offset upper bound (ffsubsync --max-offset-seconds=60): a drift larger
 *  than this is an abnormal alignment (wrong track / broken estimate), not
 *  a constant offset — it must never be applied. Note: the ±5 s match
 *  window already caps every paired difference below this, so today the
 *  bound is defense-in-depth against a widened window or a bad estimate. */
export const LAZY_SYNC_MAX_OFFSET_MS = 60000;

/** One time-paired cue pair with its start-time difference (ref − drift). */
export interface OffsetMatch {
  driftStartMs: number;
  refStartMs: number;
  diffMs: number;
}

/**
 * Pair each reference cue with the drift cue closest in start time and
 * return the start-time differences (ref − drift, in ms). Text is never
 * consulted, so the user subtitle and the embedded track may be in
 * different languages.
 *
 * Both arrays must be sorted by start time (the parser guarantees this).
 * For each ref cue the two candidates nearest in time are the drift cue at
 * the lower-bound position and the one just before it — any other cue is
 * strictly farther away. A monotonic pointer walks the drift array, making
 * the whole pass O(n + m). A pair is kept only when |ref − drift| ≤
 * windowMs; of the (at most two) in-window candidates the nearest one wins.
 * A drift cue may pair with more than one ref cue — the median offset
 * estimate shrugs off the resulting duplicates.
 */
export function matchCueOffsets(
  driftCues: readonly SubtitleCue[],
  refCues: readonly SubtitleCue[],
  windowMs: number = LAZY_SYNC_MATCH_WINDOW_MS,
): OffsetMatch[] {
  const matches: OffsetMatch[] = [];
  // First drift cue with start ≥ the current ref start; only moves forward.
  let lowerBound = 0;
  for (const ref of refCues) {
    while (
      lowerBound < driftCues.length &&
      driftCues[lowerBound]!.start < ref.start
    ) {
      lowerBound++;
    }
    let bestDiffMs: number | null = null;
    let bestIdx = -1;
    for (const idx of [lowerBound - 1, lowerBound]) {
      const drift = driftCues[idx];
      if (!drift) continue;
      const diffMs = (ref.start - drift.start) * 1000;
      if (Math.abs(diffMs) > windowMs) continue;
      if (bestDiffMs === null || Math.abs(diffMs) < Math.abs(bestDiffMs)) {
        bestDiffMs = diffMs;
        bestIdx = idx;
      }
    }
    if (bestDiffMs === null) continue;
    matches.push({
      driftStartMs: driftCues[bestIdx]!.start * 1000,
      refStartMs: ref.start * 1000,
      diffMs: bestDiffMs,
    });
  }
  return matches;
}

/**
 * Robust estimate of the constant offset (ref − drift, ms) as the median of
 * the matched differences — a form of the "複数 cue の平均" from docs §10.3,
 * chosen over the mean because the median shrugs off a handful of outliers
 * (a repeated line matched to the wrong occurrence, a cut segment, …).
 * Returns null when there are no matches.
 */
export function estimateOffsetMs(
  matches: readonly OffsetMatch[],
): number | null {
  if (matches.length === 0) return null;
  const sorted = matches
    .map((m) => m.diffMs)
    .sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
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
