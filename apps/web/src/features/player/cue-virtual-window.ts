/**
 * cue-virtual-window — pure virtual-window math for the subtitle cue list.
 * ---------------------------------------------------------------------------
 * The Player's subtitle panel can hold thousands of cues (a 2 h film easily
 * reaches 2 000–3 000 lines). Rendering every row at once costs tens of
 * thousands of DOM nodes, so the panel takes seconds to mount — and to
 * remount every time the user switches to the Context tab and back.
 *
 * This module owns the index → pixel bookkeeping that lets the panel mount
 * only the rows near the viewport:
 *
 *   - `buildCueOffsets` turns the cue list into a prefix-sum array of row
 *     offsets. Rows whose height has been measured use the real value; the
 *     rest fall back to an estimate (the running average of what has been
 *     measured so far), so the scrollbar stays close to the truth.
 *   - `computeCueVirtualWindow` maps a scroll offset + viewport height to
 *     the half-open index range that has to be mounted.
 *   - `computeCueSpacers` turns that range into the padding that replaces
 *     the unmounted rows.
 *
 * Everything here is pure: no DOM, no React. The DOM side (measuring rows,
 * tracking the scroll position, scrolling to a cue) lives in
 * `use-cue-virtual-list.ts`.
 *
 * LazySync contract (docs SUBTITLE_SYNC.md §10):
 *   This module NEVER mutates the cue array — it only reads its length and
 *   indexes into it. `shiftCuesByOffset` (LazySync) re-indexes cue ids and
 *   drops cues that collapse to a non-positive length, and
 *   `shiftCuesBySubDelay` (native engine) rewrites every timestamp while
 *   preserving the ids. Callers must therefore treat the cue array as
 *   read-only and invalidate any id-keyed cache when the array changes.
 * ---------------------------------------------------------------------------
 */

/** Row height used for cues that have not been measured yet (px). */
export const CUE_ROW_FALLBACK_HEIGHT = 46;

/** Extra rows mounted above and below the visible band. */
export const CUE_ROW_OVERSCAN = 8;

/** Minimal shape the offset builder needs from a cue. */
export interface CueIndexSource {
  readonly id: number;
}

/** Half-open index range of the mounted rows. */
export interface CueVirtualWindow {
  /** First mounted cue index (inclusive). */
  startIndex: number;
  /** Last mounted cue index (exclusive). */
  endIndex: number;
}

/** Pixel spacers that replace the unmounted rows. */
export interface CueSpacers {
  /** Padding above the first mounted row. */
  top: number;
  /** Padding below the last mounted row. */
  bottom: number;
}

/**
 * Prefix sums of the row heights: `offsets[i]` is the pixel offset of cue
 * `i` inside the list and `offsets[cues.length]` is the total list height.
 *
 * Rows without a measurement fall back to `fallbackHeight`, so the returned
 * array is always usable — it is an estimate until every row has been
 * measured, and exactly right for the rows that have been.
 */
export function buildCueOffsets(
  cues: readonly CueIndexSource[],
  measuredHeights: ReadonlyMap<number, number>,
  fallbackHeight: number,
): Float64Array {
  const offsets = new Float64Array(cues.length + 1);
  for (let i = 0; i < cues.length; i += 1) {
    const measured = measuredHeights.get(cues[i]!.id);
    const height =
      measured !== undefined && measured > 0 ? measured : fallbackHeight;
    offsets[i + 1] = offsets[i]! + height;
  }
  return offsets;
}

/**
 * Index of the cue that contains `offset` — the cue whose
 * `[offsets[i], offsets[i + 1])` range holds the offset. Clamped to the list
 * bounds, so an offset past the end returns the last cue.
 */
export function findCueIndexAtOffset(
  offsets: Float64Array,
  count: number,
  offset: number,
): number {
  if (count <= 0) return 0;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid + 1]! > offset) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Index range that has to be mounted for a scroll offset + viewport height.
 *
 * `scrollTop` is measured from the list's own top, so the caller can stay
 * agnostic about which element owns the scroll (the Radix viewport on
 * desktop, the page window on mobile).
 */
export function computeCueVirtualWindow(
  offsets: Float64Array,
  count: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number = CUE_ROW_OVERSCAN,
): CueVirtualWindow {
  if (count <= 0) return { startIndex: 0, endIndex: 0 };
  const total = offsets[count]!;
  const top = Math.min(Math.max(scrollTop, 0), total);
  const bottom = Math.min(total, top + Math.max(viewportHeight, 0));
  const first = findCueIndexAtOffset(offsets, count, top);
  const last = findCueIndexAtOffset(offsets, count, bottom);
  return {
    startIndex: Math.max(0, first - overscan),
    endIndex: Math.min(count, last + 1 + overscan),
  };
}

/**
 * Padding that replaces the unmounted rows: the offset of the first mounted
 * row above, and the remaining height below.
 */
export function computeCueSpacers(
  offsets: Float64Array,
  count: number,
  window: CueVirtualWindow,
): CueSpacers {
  const total = offsets[count] ?? 0;
  const top = offsets[window.startIndex] ?? 0;
  const bottom = Math.max(0, total - (offsets[window.endIndex] ?? total));
  return { top, bottom };
}

/**
 * Mean of the measured row heights — the estimate used for rows that have
 * not been measured yet. Falls back to `fallbackHeight` when nothing has
 * been measured yet.
 */
export function averageMeasuredHeight(
  measuredHeights: ReadonlyMap<number, number>,
  fallbackHeight: number,
): number {
  if (measuredHeights.size === 0) return fallbackHeight;
  let sum = 0;
  let count = 0;
  for (const height of measuredHeights.values()) {
    if (height > 0) {
      sum += height;
      count += 1;
    }
  }
  if (count === 0) return fallbackHeight;
  return sum / count;
}
