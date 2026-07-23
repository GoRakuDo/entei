/**
 * Unit tests for mining-viewport.ts pure helper functions.
 * ---------------------------------------------------------------------------
 * - computeInitialViewport: centers around selection, clamps to media bounds,
 *   handles short media, degenerate inputs.
 * - zoomIn: halves span centered on selection center, preserves endpoints.
 * - zoomOut: doubles span, clamps to media bounds.
 * - canZoomIn / canZoomOut: boundary checks.
 * - reframeIfNeeded: no-op when contained, recompute when out of bounds.
 * - Selection invariance: zoom never changes rangeStart/rangeEnd.
 * --------------------------------------------------------------------------- */

import { describe, it, expect } from 'vitest';
import {
  computeInitialViewport,
  zoomIn,
  zoomOut,
  canZoomIn,
  canZoomOut,
  reframeIfNeeded,
  MIN_VIEWPORT_SPAN,
} from '@/features/player/mining-viewport';

describe('computeInitialViewport', () => {
  it('centers viewport around a mid-media selection with context padding', () => {
    const vp = computeInitialViewport(100, 105, 600);
    expect(vp.viewStart).toBeLessThanOrEqual(100);
    expect(vp.viewEnd).toBeGreaterThanOrEqual(105);
    expect(vp.viewEnd - vp.viewStart).toBeLessThan(600);
    expect(vp.viewStart).toBeGreaterThanOrEqual(0);
    expect(vp.viewEnd).toBeLessThanOrEqual(600);
  });

  it('uses full duration for very short media', () => {
    const vp = computeInitialViewport(0.5, 1.5, 2);
    expect(vp.viewStart).toBe(0);
    expect(vp.viewEnd).toBe(2);
  });

  it('clamps viewport start to 0 when selection is near media start', () => {
    const vp = computeInitialViewport(0, 3, 600);
    expect(vp.viewStart).toBe(0);
    expect(vp.viewEnd).toBeGreaterThanOrEqual(3);
  });

  it('clamps viewport end to mediaDuration when selection is near end', () => {
    const vp = computeInitialViewport(597, 600, 600);
    expect(vp.viewEnd).toBe(600);
    expect(vp.viewStart).toBeLessThanOrEqual(597);
  });

  it('ensures both selection endpoints are visible', () => {
    const vp = computeInitialViewport(200, 204, 600);
    expect(vp.viewStart).toBeLessThanOrEqual(200);
    expect(vp.viewEnd).toBeGreaterThanOrEqual(204);
  });

  it('ensures minimum span for very narrow selection', () => {
    const vp = computeInitialViewport(300, 300.5, 600);
    expect(vp.viewEnd - vp.viewStart).toBeGreaterThanOrEqual(MIN_VIEWPORT_SPAN);
  });

  it('returns zero viewport for non-finite inputs', () => {
    expect(computeInitialViewport(NaN, 10, 600)).toEqual({
      viewStart: 0,
      viewEnd: 0,
    });
    expect(computeInitialViewport(10, NaN, 600)).toEqual({
      viewStart: 0,
      viewEnd: 0,
    });
    expect(computeInitialViewport(10, 20, NaN)).toEqual({
      viewStart: 0,
      viewEnd: 0,
    });
  });

  it('returns zero viewport for zero or negative mediaDuration', () => {
    expect(computeInitialViewport(10, 20, 0)).toEqual({
      viewStart: 0,
      viewEnd: 0,
    });
    expect(computeInitialViewport(10, 20, -5)).toEqual({
      viewStart: 0,
      viewEnd: 0,
    });
  });
});

describe('zoomIn', () => {
  it('halves the viewport span centered on selection center', () => {
    const initial = computeInitialViewport(200, 204, 600);
    const zoomed = zoomIn(initial, 200, 204, 600);
    const initialSpan = initial.viewEnd - initial.viewStart;
    const zoomedSpan = zoomed.viewEnd - zoomed.viewStart;
    expect(zoomedSpan).toBeLessThan(initialSpan);
    // Should be roughly half
    expect(zoomedSpan).toBeCloseTo(initialSpan * 0.5, 1);
  });

  it('does NOT change rangeStart or rangeEnd (selection invariance)', () => {
    const initial = computeInitialViewport(200, 204, 600);
    const zoomed = zoomIn(initial, 200, 204, 600);
    // The function returns a Viewport, not the range — verify the viewport
    // still contains the range endpoints
    expect(zoomed.viewStart).toBeLessThanOrEqual(200);
    expect(zoomed.viewEnd).toBeGreaterThanOrEqual(204);
  });

  it('returns same viewport when zoom is not possible (too narrow)', () => {
    const vp = { viewStart: 200, viewEnd: 201 };
    const result = zoomIn(vp, 200, 201, 600);
    expect(result).toEqual(vp);
  });

  it('clamps to media bounds when zooming near start', () => {
    const initial = { viewStart: 0, viewEnd: 100 };
    const zoomed = zoomIn(initial, 0, 5, 600);
    expect(zoomed.viewStart).toBeGreaterThanOrEqual(0);
    expect(zoomed.viewEnd).toBeLessThanOrEqual(600);
  });

  it('returns same viewport for non-finite mediaDuration', () => {
    const vp = { viewStart: 100, viewEnd: 200 };
    expect(zoomIn(vp, 110, 120, NaN)).toEqual(vp);
  });
});

describe('zoomOut', () => {
  it('doubles the viewport span centered on selection center', () => {
    const initial = { viewStart: 290, viewEnd: 310 };
    const zoomed = zoomOut(initial, 298, 302, 600);
    const initialSpan = 20;
    const zoomedSpan = zoomed.viewEnd - zoomed.viewStart;
    expect(zoomedSpan).toBeGreaterThan(initialSpan);
    // Should be roughly double
    expect(zoomedSpan).toBeCloseTo(40, 1);
  });

  it('returns same viewport when already at full media duration', () => {
    const vp = { viewStart: 0, viewEnd: 600 };
    const result = zoomOut(vp, 200, 204, 600);
    expect(result).toEqual(vp);
  });

  it('clamps to media bounds', () => {
    const initial = { viewStart: 0, viewEnd: 50 };
    const zoomed = zoomOut(initial, 0, 5, 600);
    expect(zoomed.viewStart).toBeGreaterThanOrEqual(0);
    expect(zoomed.viewEnd).toBeLessThanOrEqual(600);
  });

  it('caps at full media duration', () => {
    const initial = { viewStart: 200, viewEnd: 250 };
    const zoomed = zoomOut(initial, 220, 230, 300);
    expect(zoomed.viewEnd).toBeLessThanOrEqual(300);
  });

  it('does NOT change the selection range', () => {
    const initial = { viewStart: 290, viewEnd: 310 };
    const zoomed = zoomOut(initial, 298, 302, 600);
    // Viewport still contains selection
    expect(zoomed.viewStart).toBeLessThanOrEqual(298);
    expect(zoomed.viewEnd).toBeGreaterThanOrEqual(302);
  });

  it('returns same viewport for non-finite mediaDuration', () => {
    const vp = { viewStart: 100, viewEnd: 200 };
    expect(zoomOut(vp, 110, 120, NaN)).toEqual(vp);
  });
});

describe('canZoomIn', () => {
  it('returns true when viewport is wide enough to halve', () => {
    const vp = { viewStart: 100, viewEnd: 300 };
    expect(canZoomIn(vp, 190, 200)).toBe(true);
  });

  it('returns false when viewport is too narrow for selection', () => {
    const vp = { viewStart: 195, viewEnd: 205 };
    // selection span = 5, half viewport = 5, needs >= 5 + MIN_VIEWPORT_SPAN
    expect(canZoomIn(vp, 195, 200)).toBe(false);
  });

  it('returns false when selection span nearly fills viewport', () => {
    const vp = { viewStart: 0, viewEnd: 10 };
    expect(canZoomIn(vp, 0, 9.5)).toBe(false);
  });
});

describe('canZoomOut', () => {
  it('returns true when viewport is narrower than media', () => {
    const vp = { viewStart: 100, viewEnd: 200 };
    expect(canZoomOut(vp, 600)).toBe(true);
  });

  it('returns false when viewport spans full media', () => {
    const vp = { viewStart: 0, viewEnd: 600 };
    expect(canZoomOut(vp, 600)).toBe(false);
  });

  it('returns false with floating-point tolerance', () => {
    const vp = { viewStart: 0, viewEnd: 599.999999 };
    expect(canZoomOut(vp, 600)).toBe(false);
  });
});

describe('reframeIfNeeded', () => {
  it('returns same viewport when range is fully contained', () => {
    const vp = { viewStart: 100, viewEnd: 200 };
    const result = reframeIfNeeded(vp, 120, 180, 600);
    expect(result).toBe(vp);
  });

  it('reframes when rangeStart falls below viewport', () => {
    const vp = { viewStart: 100, viewEnd: 200 };
    const result = reframeIfNeeded(vp, 50, 180, 600);
    expect(result.viewStart).toBeLessThanOrEqual(50);
    expect(result.viewEnd).toBeGreaterThanOrEqual(180);
  });

  it('reframes when rangeEnd exceeds viewport', () => {
    const vp = { viewStart: 100, viewEnd: 200 };
    const result = reframeIfNeeded(vp, 120, 250, 600);
    expect(result.viewStart).toBeLessThanOrEqual(120);
    expect(result.viewEnd).toBeGreaterThanOrEqual(250);
  });

  it('reframes when both endpoints are outside', () => {
    const vp = { viewStart: 100, viewEnd: 200 };
    const result = reframeIfNeeded(vp, 300, 305, 600);
    expect(result.viewStart).toBeLessThanOrEqual(300);
    expect(result.viewEnd).toBeGreaterThanOrEqual(305);
  });
});
