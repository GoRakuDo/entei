// SPDX-License-Identifier: Apache-2.0
//
// LazySync — Magnet-only instant subtitle sync from the already-downloaded
// cue prefix (docs/SUBTITLE_SYNC.md §10). Pure logic only: text matching,
// constant-offset estimation, and offset application. The polling loop that
// drives these helpers lives in PlayerApp (component state owns the timer,
// the toggle, and the toasts).
//
// Premise (docs §10.1-10.3): MKV subtitle clusters are interleaved in play
// order, so the companion can serve the cues of the downloaded prefix long
// before the whole download completes. The user's subtitle and the embedded
// track are the same lines; their start-time differences are a near-constant
// offset. A few matched cues estimate it; more cues (as the download
// progresses) refine it.

import type { SubtitleCue } from './subtitle-reader';

/** Poll interval while LazySync is ON (docs §10.2: "数秒間隔"). */
export const LAZY_SYNC_POLL_INTERVAL_MS = 3000;

/** Offset is considered stable when consecutive estimates change by ≤ 50 ms. */
export const LAZY_SYNC_STABLE_THRESHOLD_MS = 50;

/** Upper bound for the 0-cue waiting state (~3 min): if the embedded
 *  subtitle never yields a cue by then, give up instead of showing the
 *  PROCESSING typewriter forever. */
export const LAZY_SYNC_MAX_WAIT_POLLS = 60;

/** Upper bound for "reference cues exist but none match the user subtitle"
 *  (~18 s): the embedded track is a different language / different lines —
 *  a constant-offset estimate is impossible, so stop. */
export const LAZY_SYNC_MAX_NO_MATCH_POLLS = 6;

/** One text-matched cue pair with its start-time difference (ref − drift). */
export interface OffsetMatch {
  driftStartMs: number;
  refStartMs: number;
  diffMs: number;
}

/**
 * Fold cue text into a comparable key: case + whitespace + punctuation
 * insensitive. The parser already stripped HTML/ASS tags and collapsed
 * whitespace, so this only handles the remaining cosmetic variance between
 * the user's file and the embedded track (ケース・句読点・全角半角).
 */
export function normalizeCueText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u3000\s]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

/**
 * Greedily pair drift cues with reference cues by normalized text and return
 * the start-time differences (ref − drift, in ms). Each reference cue is
 * consumed at most once, so repeated lines in the user file cannot all latch
 * onto the same reference cue. No span bound: a text match is already a
 * strong correspondence, and the offset may legitimately be large.
 */
export function matchCueOffsets(
  driftCues: readonly SubtitleCue[],
  refCues: readonly SubtitleCue[],
): OffsetMatch[] {
  const usedRef = new Set<number>();
  const matches: OffsetMatch[] = [];
  for (const drift of driftCues) {
    const key = normalizeCueText(drift.text);
    if (key.length === 0) continue;
    for (let i = 0; i < refCues.length; i++) {
      const ref = refCues[i];
      if (!ref || usedRef.has(i)) continue;
      if (normalizeCueText(ref.text) === key) {
        usedRef.add(i);
        matches.push({
          driftStartMs: drift.start * 1000,
          refStartMs: ref.start * 1000,
          diffMs: (ref.start - drift.start) * 1000,
        });
        break;
      }
    }
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
