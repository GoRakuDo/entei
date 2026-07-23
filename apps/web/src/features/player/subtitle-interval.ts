/**
 * Subtitle interval selection — ASB-style overlap rule for mining range.
 * ---------------------------------------------------------------------------
 * Reference: asbplayer `common/util/util.ts:319-349` defines subtitle
 * interval inclusion: ignore zero-length cues; include a cue only if its
 * overlap with [start, end] is at least half of the cue's own duration;
 * join non-blank text with `\n`.
 *
 * This is an independent Entei implementation — not a copy.
 * --------------------------------------------------------------------------- */

import type { SubtitleCue } from './subtitle-reader';

/**
 * Compute the overlap duration between a cue and a [start, end] range.
 * Returns 0 if there is no overlap.
 */
function overlapDuration(
  cueStart: number,
  cueEnd: number,
  rangeStart: number,
  rangeEnd: number,
): number {
  const overlapStart = Math.max(cueStart, rangeStart);
  const overlapEnd = Math.min(cueEnd, rangeEnd);
  return Math.max(0, overlapEnd - overlapStart);
}

/**
 * Select cues that overlap [rangeStart, rangeEnd] with at least 50% of
 * their own duration. Zero-length cues are ignored. Returns the joined
 * non-blank text of qualifying cues, separated by `\n`.
 *
 * @param cues       All subtitle cues (assumed sorted by start time)
 * @param rangeStart Range start in seconds
 * @param rangeEnd   Range end in seconds
 * @returns Joined non-blank cue text, or empty string if none qualify
 */
export function selectCueTextInRange(
  cues: readonly SubtitleCue[],
  rangeStart: number,
  rangeEnd: number,
): string {
  if (
    !Number.isFinite(rangeStart) ||
    !Number.isFinite(rangeEnd) ||
    rangeStart >= rangeEnd
  ) {
    return '';
  }

  const texts: string[] = [];

  for (const cue of cues) {
    // Skip zero-length cues
    const cueDuration = cue.end - cue.start;
    if (cueDuration <= 0) continue;

    const overlap = overlapDuration(cue.start, cue.end, rangeStart, rangeEnd);

    // Include only if overlap >= 50% of the cue's own duration
    if (overlap >= cueDuration / 2) {
      const trimmed = cue.text.trim();
      if (trimmed.length > 0) {
        texts.push(trimmed);
      }
    }
  }

  return texts.join('\n');
}
