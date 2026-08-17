// SPDX-License-Identifier: Apache-2.0
//
// LazySync — Magnet-only instant subtitle sync from the already-downloaded
// cue prefix (docs/SUBTITLE_SYNC.md §10). Pure logic only: two-phase offset
// estimation and offset application. The polling loop that drives these
// helpers lives in PlayerApp (component state owns the timer, the toggle,
// and the toasts).
//
// Premise (docs §10.1-10.3): MKV subtitle clusters are interleaved in play
// order, so the companion can serve the cues of the downloaded prefix long
// before the whole download completes. The user's subtitle and the embedded
// track show the same lines at the same wall-clock times; their start-time
// differences are a near-constant offset. The estimate runs in two phases
// (user spec B):
//
//   1. TEXT MATCHING (priority): cues whose normalized text matches are
//      RANK-paired per line (the k-th occurrence of a line on one side ↔
//      the k-th occurrence on the other) and the histogram peak of their
//      start-time differences is the offset. Text is a strong
//      correspondence, so ANY offset magnitude is recoverable — a 10 s or
//      3-min drift syncs as well as a 1.5 s one. Requires the two tracks
//      to share a language.
//   2. TIME-BASED (fallback): RANK pairing by cue position (the k-th ref
//      cue ↔ the k-th drift cue — the tracks are the same content, so the
//      k-th cue of each is the same line). The rank diff IS the unwrapped
//      offset, so offsets of ANY magnitude are recovered — there is NO
//      envelope bound (spec B, 2026-08-17): rank pairing is order-based and
//      never wraps (unlike a temporally-nearest pairing). Residual risks
//      (documented + regression-tested): a rank that shifts mid-track on an
//      IRREGULAR track scatters the diffs → the margin gate refuses; on a
//      NEAR-REGULAR track (dialogue-style, e.g. ~3 s intervals) it can
//      instead shift every following diff by a whole gap and produce a
//      fake constant offset that clears both gates — as can a whole-track
//      one-line shift (first cue missing on one side). Future improvement:
//      detect misapplication after applying (re-check the shift and
//      auto-revert when it exceeds a threshold) — a wrong constant is
//      otherwise never self-corrected, since Magnet re-polls the unchanged
//      base cues silently.
//
// Text is only ever an aid; the fallback keeps the feature working when the
// tracks are in different languages. Text is never required to match for
// the fallback to run, so unrelated text never poisons the time-based path.

import type { SubtitleCue } from './subtitle-reader';

/** Poll interval while LazySync is ON (docs §10.2: "数秒間隔"). */
export const LAZY_SYNC_POLL_INTERVAL_MS = 3000;

/** Offset is considered stable when consecutive estimates change by ≤ 50 ms. */
export const LAZY_SYNC_STABLE_THRESHOLD_MS = 50;

/** Histogram bin width (docs §10.3: "ビン幅 LAZY_SYNC_HISTOGRAM_BIN_MS =
 *  500"). Start-time differences are rounded to this grid; the bin with the
 *  most pairs (the peak) is the estimated offset. 500 ms is coarser than
 *  the ±100 ms "already in sync" threshold but fine enough to separate
 *  adjacent lines (typically seconds apart). Note: the rounded grid means
 *  every estimate is a multiple of 500 ms — an offset of, say, 1200 ms is
 *  reported as 1000 ms, leaving a ±250 ms residual. That is per docs §10.3
 *  (review P2-2); the residual is well inside the ±100 ms "already in sync"
 *  band only when the estimate is exactly 0, which is the intended reading
 *  of that threshold. */
export const LAZY_SYNC_HISTOGRAM_BIN_MS = 500;

/** Ref-cue sampling stride (docs §10.3: "50 cue ごとに間引き"). The
 *  estimator takes one nearest-neighbor diff per sampled ref cue; sampling
 *  every Nth cue (from the first) bounds the pair count on long tracks
 *  without moving the peak. */
export const LAZY_SYNC_HISTOGRAM_SAMPLE_EVERY = 50;

/** Small-prefix sampling stride (review P2-1): while the downloaded prefix
 *  is short, sample every 10th ref cue instead of every 50th. With the 50
 *  stride, the peak could hold at most ⌈N/50⌉ pairs, so the 3-pair quality
 *  gate needed ≥ 101 downloaded cues (≈ 15-18 min of a typical track);
 *  the smaller stride lets a short prefix clear the gate much sooner. */
export const LAZY_SYNC_HISTOGRAM_SAMPLE_EVERY_SMALL = 10;

/** Prefix length below which the small sampling stride applies (P2-1). */
export const LAZY_SYNC_HISTOGRAM_SMALL_REF_THRESHOLD = 100;

/** Margin gate (review P1-2): an estimate is trusted only when the peak bin
 *  holds at least this many times as many pairs as the second-largest bin.
 *  A mixed track with half the lines at +1.5 s and half at −1.5 s produces
 *  two equal peaks, and a dense track's noise band produces many near-equal
 *  bins — both fail the gate and are refused (fail-closed → keep waiting)
 *  instead of being applied. */
export const LAZY_SYNC_PEAK_MARGIN = 2;

/** Upper bound for every waiting state (~12 min = 240 polls × 3 s):
 *  too few downloaded cues, too few matches, or an outlier offset that
 *  never resolves — give up instead of showing the state forever. */
export const LAZY_SYNC_MAX_WAIT_POLLS = 240;

/** First-sync trigger: wait until the downloaded prefix holds at least this
 *  many cues before estimating an offset (docs §10: "DL 済み cue が十分な
 *  数（例: 5〜10 cue）に達したら"). ffsubsync-style "wait for a usable
 *  sample" — an estimate from fewer cues is not trustworthy. */
export const LAZY_SYNC_MIN_REF_CUES = 5;

/** Quality gate (ffsubsync --skip-sync-on-low-quality, docs §10.3): an
 *  offset is applied only when the peak bin holds at least this many cue
 *  pairs. Correlated lines pile into one bin at the true offset; scattered
 *  noise spreads across bins, so a weak peak means the alignment is not yet
 *  trustworthy — wait for the download to yield more pairs instead of
 *  syncing on noise. */
export const LAZY_SYNC_MIN_PEAK_COUNT = 3;

/** Offset threshold (ffsubsync --suppress-output-if-offset-less-than):
 *  an offset below this is sub-frame noise — the subtitle counts as already
 *  in sync, so no shift is applied. */
export const LAZY_SYNC_MIN_OFFSET_MS = 100;

/** Histogram peak: the estimated constant offset (ref − drift, ms) and the
 *  pair counts behind it. `peakCount` feeds the caller's quality gate —
 *  a peak holding fewer than LAZY_SYNC_MIN_PEAK_COUNT pairs is noise.
 *  `totalPairs` reports how many pairs were aggregated (after ref sampling),
 *  so callers can see how much evidence the peak sits on. */
export interface OffsetEstimate {
  offsetMs: number;
  peakCount: number;
  totalPairs: number;
}

/**
 * Fold cue text into a comparable key: case + whitespace + punctuation
 * insensitive. The parser already stripped HTML/ASS tags and collapsed
 * whitespace, so this only handles the remaining cosmetic variance between
 * the user's file and the embedded track (ケース・句読点・全角半角).
 */
export function normalizeCueText(text: string): string {
  return text
    .normalize('NFKC') // 全角英数・全角スペースを半角に揃える
    .toLowerCase()
    .replace(/[\u3000\s]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

/**
 * Find the histogram peak (max bin) and its runner-up, then apply the
 * MARGIN GATE (review P1-2): a peak that does not hold ≥
 * LAZY_SYNC_PEAK_MARGIN × the second-largest bin's pairs is an ambiguous
 * alignment (two equal peaks from a ± mix, or a flat noise band) — refuse
 * it so the caller keeps waiting instead of applying a guess. Returns null
 * when there are no pairs at all. Shared by both estimation phases.
 */
function pickPeak(
  bins: Map<number, number>,
  totalPairs: number,
): OffsetEstimate | null {
  if (totalPairs === 0) return null;
  let peakBin = 0;
  let peakCount = 0;
  let secondCount = 0;
  for (const [bin, count] of bins) {
    if (count > peakCount) {
      secondCount = peakCount;
      peakCount = count;
      peakBin = bin;
    } else if (count > secondCount) {
      secondCount = count;
    }
  }
  if (peakCount < LAZY_SYNC_PEAK_MARGIN * secondCount) return null;
  return {
    offsetMs: peakBin * LAZY_SYNC_HISTOGRAM_BIN_MS,
    peakCount,
    totalPairs,
  };
}

/**
 * Phase 1 (priority, user spec B): estimate the offset from TEXT-MATCHED
 * cue pairs. Drift cues are indexed by normalized text; every reference
 * cue whose normalized text appears in the index RANK-PAIRS with the
 * drift occurrence of the same rank (the k-th ref occurrence of a line ↔
 * the k-th drift occurrence of that line — all-pairs ではない, one pair
 * per ref occurrence). For the same content the k-th occurrence is the
 * same line, so the pair's start-time difference (ref − drift, ms) is the
 * true offset regardless of its magnitude — a repeated line can never
 * latch onto a *different* occurrence the way a temporally-nearest pairing
 * does once the offset exceeds half the occurrence interval (review
 * P1-2). The differences are bucketed into a
 * LAZY_SYNC_HISTOGRAM_BIN_MS-wide histogram; the peak bin (with the margin
 * gate) is the offset.
 *
 * Because text is a strong correspondence, no time window bounds the
 * differences — offsets of ANY magnitude are recovered. Returns null when
 * no text-matched pairs exist (different languages, or every text
 * normalizes to empty). The orchestrator only adopts this result when the
 * peak holds ≥ LAZY_SYNC_MIN_PEAK_COUNT pairs; a weaker peak falls through
 * to the time-based phase. Rank pairing stops at the shorter side, so
 * extra occurrences at either end are simply dropped; an INTERLEAVED extra
 * shifts the ranks and scatters the diffs → no peak → null (fail-closed,
 * safer than a wrong estimate).
 */
function estimateOffsetFromTextMatching(
  driftCues: readonly SubtitleCue[],
  refCues: readonly SubtitleCue[],
): OffsetEstimate | null {
  // Index drift cues by normalized text. Cues are pushed in array order, so
  // each list stays sorted by start time (the parser guarantees it).
  const driftByText = new Map<string, SubtitleCue[]>();
  for (const drift of driftCues) {
    const key = normalizeCueText(drift.text);
    if (key.length === 0) continue;
    const list = driftByText.get(key);
    if (list === undefined) driftByText.set(key, [drift]);
    else list.push(drift);
  }
  if (driftByText.size === 0) return null;

  const bins = new Map<number, number>();
  let totalPairs = 0;
  // Per-text-group occurrence rank of each ref cue, consumed while
  // iterating (drift lists stay sorted because driftCues is sorted and
  // cues are pushed in order).
  const refRankByText = new Map<string, number>();
  for (const ref of refCues) {
    const key = normalizeCueText(ref.text);
    if (key.length === 0) continue;
    const candidates = driftByText.get(key);
    if (candidates === undefined) continue;
    const k = refRankByText.get(key) ?? 0;
    refRankByText.set(key, k + 1);
    if (k >= candidates.length) continue; // extra ref occurrence → dropped
    const drift = candidates[k]!;
    const diffMs = (ref.start - drift.start) * 1000;
    // Round to the bin grid so the bin index doubles as the bin center in
    // bin units: diff 1500 → bin 3 → offset 3 × 500 = 1500.
    const bin = Math.round(diffMs / LAZY_SYNC_HISTOGRAM_BIN_MS);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
    totalPairs++;
  }
  return pickPeak(bins, totalPairs);
}

/**
 * Phase 2 (fallback): estimate the offset from TIME-BASED RANK pairing —
 * language-independent, used when text matching yielded no trustworthy
 * peak. Ref cues are sampled with a stride that shrinks on short prefixes
 * (P2-1); each sampled ref cue at position p is paired with the drift cue
 * at the same position p (the two tracks are the same content, so position
 * p is the same line). The pair's start-time difference is bucketed into
 * the histogram; the peak bin (with the margin gate) is the offset.
 *
 * Why rank, not nearest-neighbor (review P1-1): with a regular track and
 * an offset larger than half the cue gap, the temporally-nearest pairing
 * makes every ref cue latch onto the *next* line and all differences wrap
 * into one sharp "δ mod gap" value that passes the margin gate and gets
 * misapplied. Rank pairing is ORDER-based (the k-th cue pairs with the
 * k-th cue), so it never wraps — the diff is the true (unwrapped) offset
 * at any magnitude.
 *
 * NO ENVELOPE CHECK (spec B, 2026-08-17): an earlier version refused
 * offsets ≥ half the median drift-cue gap, which blocked a real
 * language-mismatch case (+8.7 s on ~3 s cue spacing — the pairing was
 * correct but the envelope said "too large"). The envelope is removed: the
 * MARGIN GATE is the remaining guard against misalignment, and its
 * protection is conditional on the track shape. A rank that shifts
 * MID-track on an IRREGULAR track makes the diffs scatter across bins →
 * the margin gate refuses (fail-closed). On a NEAR-REGULAR track
 * (dialogue-style, e.g. ~3 s intervals), a mid-track insertion instead
 * shifts every following diff by a whole gap — a CONSTANT offset, so the
 * margin gate can pass it (pinned by a regression test). The same holds
 * for a whole-track one-line shift (e.g., the first cue missing on one
 * side). These residual misapplications are documented and regression-
 * tested, and are a future improvement target: MISAPPLICATION DETECTION —
 * after applying, re-check the resulting shift and auto-revert when it
 * exceeds a threshold. A wrong constant is otherwise never self-corrected
 * (Magnet shows no success toast and keeps polling the unchanged base
 * cues), so a silent misapplication would persist. This remains strictly
 * better than the nearest-neighbor wrap, which misapplied silently.
 */
function estimateOffsetFromRankPairing(
  driftCues: readonly SubtitleCue[],
  refCues: readonly SubtitleCue[],
): OffsetEstimate | null {
  const stride =
    refCues.length < LAZY_SYNC_HISTOGRAM_SMALL_REF_THRESHOLD
      ? LAZY_SYNC_HISTOGRAM_SAMPLE_EVERY_SMALL
      : LAZY_SYNC_HISTOGRAM_SAMPLE_EVERY;

  const bins = new Map<number, number>();
  let totalPairs = 0;
  for (
    let p = 0;
    p < refCues.length && p < driftCues.length;
    p += stride
  ) {
    const diffMs = (refCues[p]!.start - driftCues[p]!.start) * 1000;
    const bin = Math.round(diffMs / LAZY_SYNC_HISTOGRAM_BIN_MS);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
    totalPairs++;
  }
  const est = pickPeak(bins, totalPairs);
  if (est === null) return null;
  return est;
}

/**
 * Estimate the constant offset (ref − drift, ms) between the user subtitle
 * (drift) and the embedded track (ref). TEXT MATCHING runs first — it
 * recovers offsets of any magnitude, but needs the two tracks to share a
 * language. When its peak holds fewer than LAZY_SYNC_MIN_PEAK_COUNT pairs
 * (or the margin gate refused it), the TIME-BASED rank-pairing fallback
 * takes over — any language, offsets of any magnitude (no envelope bound,
 * spec B). Returns null when neither phase yields a trustworthy estimate
 * (fail-closed — the caller keeps waiting).
 *
 * The caller additionally requires the returned peakCount ≥
 * LAZY_SYNC_MIN_PEAK_COUNT before applying (weak peaks are ignored).
 */
export function estimateOffsetFromHistogram(
  driftCues: readonly SubtitleCue[],
  refCues: readonly SubtitleCue[],
): OffsetEstimate | null {
  if (driftCues.length === 0 || refCues.length === 0) return null;

  // Phase 1 (priority): text matching — any offset magnitude, but needs a
  // shared language and a peak of ≥ LAZY_SYNC_MIN_PEAK_COUNT pairs.
  const textEst = estimateOffsetFromTextMatching(driftCues, refCues);
  if (textEst !== null && textEst.peakCount >= LAZY_SYNC_MIN_PEAK_COUNT) {
    return textEst;
  }

  // Phase 2 (fallback): time-based rank pairing — any language, any offset
  // magnitude (no envelope bound, spec B; the margin gate guards against
  // rank misalignment).
  return estimateOffsetFromRankPairing(driftCues, refCues);
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
