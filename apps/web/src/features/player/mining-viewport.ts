/**
 * Mining viewport helpers — pure functions for the ASB-style range zoom.
 * ---------------------------------------------------------------------------
 * The Mining Preview Slider can span the full media duration, which makes
 * a 2-6 second cue visually invisible.  A viewport [viewStart, viewEnd]
 * narrows the visible window around the selected audio range so both thumbs
 * are visibly separated.
 *
 * Viewport is React-memory-only — it must never persist to localStorage
 * or affect Anki export.  It is purely a visual aid.
 * --------------------------------------------------------------------------- */

/** Minimum viewport span in seconds.  Below this there is no point zooming. */
export const MIN_VIEWPORT_SPAN = 1;

/**
 * Context padding as a fraction of the selection span on each side.
 * e.g. 1.0 means "add 100% of selection span as context on each side".
 */
const CONTEXT_RATIO = 1.5;

/** Maximum zoom factor — how many times narrower than the current span. */
const ZOOM_IN_FACTOR = 0.5;

/** Zoom out factor — how many times wider than the current span. */
const ZOOM_OUT_FACTOR = 2;

export interface Viewport {
  viewStart: number;
  viewEnd: number;
}

/**
 * Compute the initial viewport around a selected range.
 *
 * Strategy:
 * - If media is very short (≤ MIN_VIEWPORT_SPAN * 3), use the full duration.
 * - Otherwise, center on the selection midpoint and add context on both sides
 *   (CONTEXT_RATIO × selection span).  Clamp to [0, mediaDuration].
 *
 * @param rangeStart  selected range start (seconds)
 * @param rangeEnd    selected range end (seconds)
 * @param mediaDuration total media duration (seconds), must be > 0
 */
export function computeInitialViewport(
  rangeStart: number,
  rangeEnd: number,
  mediaDuration: number,
): Viewport {
  if (
    !Number.isFinite(rangeStart) ||
    !Number.isFinite(rangeEnd) ||
    !Number.isFinite(mediaDuration) ||
    mediaDuration <= 0
  ) {
    return { viewStart: 0, viewEnd: 0 };
  }

  // Very short media — show everything
  if (mediaDuration <= MIN_VIEWPORT_SPAN * 3) {
    return { viewStart: 0, viewEnd: mediaDuration };
  }

  const selectionSpan = Math.max(rangeEnd - rangeStart, MIN_VIEWPORT_SPAN);
  const context = selectionSpan * CONTEXT_RATIO;
  const center = (rangeStart + rangeEnd) / 2;

  let viewStart = center - context - selectionSpan / 2;
  let viewEnd = center + context + selectionSpan / 2;

  // Clamp to media bounds
  if (viewStart < 0) {
    viewEnd += Math.abs(viewStart);
    viewStart = 0;
  }
  if (viewEnd > mediaDuration) {
    viewStart -= viewEnd - mediaDuration;
    viewEnd = mediaDuration;
  }
  // Final safety clamp
  viewStart = Math.max(0, viewStart);
  viewEnd = Math.min(mediaDuration, viewEnd);

  // Ensure both endpoints are visible
  if (viewStart > rangeStart) viewStart = rangeStart;
  if (viewEnd < rangeEnd) viewEnd = rangeEnd;

  // Ensure minimum span (avoid degenerate viewport)
  const span = viewEnd - viewStart;
  if (span < MIN_VIEWPORT_SPAN) {
    const mid = (viewStart + viewEnd) / 2;
    viewStart = Math.max(0, mid - MIN_VIEWPORT_SPAN / 2);
    viewEnd = Math.min(mediaDuration, mid + MIN_VIEWPORT_SPAN / 2);
  }

  return { viewStart, viewEnd };
}

/**
 * Zoom in: halve the viewport span, centered on the selection center.
 * Does NOT change rangeStart/rangeEnd.
 *
 * Returns the same viewport if zooming would not produce a meaningfully
 * narrower window while keeping both endpoints visible.
 */
export function zoomIn(
  viewport: Viewport,
  rangeStart: number,
  rangeEnd: number,
  mediaDuration: number,
): Viewport {
  if (
    !Number.isFinite(mediaDuration) ||
    mediaDuration <= 0 ||
    !Number.isFinite(rangeStart) ||
    !Number.isFinite(rangeEnd)
  ) {
    return viewport;
  }

  const currentSpan = viewport.viewEnd - viewport.viewStart;
  const newSpan = currentSpan * ZOOM_IN_FACTOR;

  // Can we zoom in while keeping both endpoints visible?
  const minSpanNeeded = rangeEnd - rangeStart;
  if (newSpan < minSpanNeeded + MIN_VIEWPORT_SPAN) {
    return viewport; // no meaningful zoom possible
  }

  const center = (rangeStart + rangeEnd) / 2;
  let viewStart = center - newSpan / 2;
  let viewEnd = center + newSpan / 2;

  // Clamp to media bounds
  if (viewStart < 0) {
    viewEnd += Math.abs(viewStart);
    viewStart = 0;
  }
  if (viewEnd > mediaDuration) {
    viewStart -= viewEnd - mediaDuration;
    viewEnd = mediaDuration;
  }
  viewStart = Math.max(0, viewStart);
  viewEnd = Math.min(mediaDuration, viewEnd);

  // Ensure endpoints still visible
  if (viewStart > rangeStart) viewStart = rangeStart;
  if (viewEnd < rangeEnd) viewEnd = rangeEnd;

  return { viewStart, viewEnd };
}

/**
 * Zoom out: double the viewport span, centered on the selection center.
 * Does NOT change rangeStart/rangeEnd.
 *
 * Returns the same viewport if we are already at full media duration.
 */
export function zoomOut(
  viewport: Viewport,
  rangeStart: number,
  rangeEnd: number,
  mediaDuration: number,
): Viewport {
  if (
    !Number.isFinite(mediaDuration) ||
    mediaDuration <= 0 ||
    !Number.isFinite(rangeStart) ||
    !Number.isFinite(rangeEnd)
  ) {
    return viewport;
  }

  const currentSpan = viewport.viewEnd - viewport.viewStart;

  // Already at full media? No point zooming out further.
  if (currentSpan >= mediaDuration - 1e-6) {
    return viewport;
  }

  const newSpan = Math.min(currentSpan * ZOOM_OUT_FACTOR, mediaDuration);
  const center = (rangeStart + rangeEnd) / 2;

  let viewStart = center - newSpan / 2;
  let viewEnd = center + newSpan / 2;

  // Clamp to media bounds
  if (viewStart < 0) {
    viewEnd += Math.abs(viewStart);
    viewStart = 0;
  }
  if (viewEnd > mediaDuration) {
    viewStart -= viewEnd - mediaDuration;
    viewEnd = mediaDuration;
  }
  viewStart = Math.max(0, viewStart);
  viewEnd = Math.min(mediaDuration, viewEnd);

  return { viewStart, viewEnd };
}

/**
 * Determine whether zoom in is available.
 * True when the current viewport can be meaningfully narrowed while
 * keeping both selected endpoints visible.
 */
export function canZoomIn(
  viewport: Viewport,
  rangeStart: number,
  rangeEnd: number,
): boolean {
  const currentSpan = viewport.viewEnd - viewport.viewStart;
  const newSpan = currentSpan * ZOOM_IN_FACTOR;
  const minSpanNeeded = rangeEnd - rangeStart;
  return newSpan >= minSpanNeeded + MIN_VIEWPORT_SPAN;
}

/**
 * Determine whether zoom out is available.
 * True when the current viewport is narrower than the full media duration.
 */
export function canZoomOut(viewport: Viewport, mediaDuration: number): boolean {
  const currentSpan = viewport.viewEnd - viewport.viewStart;
  return currentSpan < mediaDuration - 1e-6;
}

/**
 * Reframe the viewport if the selected range has fallen outside it.
 * If the range is fully contained, returns the original viewport.
 * Otherwise, recomputes around the new range.
 */
export function reframeIfNeeded(
  viewport: Viewport,
  rangeStart: number,
  rangeEnd: number,
  mediaDuration: number,
): Viewport {
  // If range is within viewport, no change needed
  if (rangeStart >= viewport.viewStart && rangeEnd <= viewport.viewEnd) {
    return viewport;
  }

  // Range fell outside — recompute
  return computeInitialViewport(rangeStart, rangeEnd, mediaDuration);
}
