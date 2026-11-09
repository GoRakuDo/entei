/**
 * cue-virtual-window — pure virtual-window math unit tests.
 * ---------------------------------------------------------------------------
 * The subtitle cue list mounts only the rows near the viewport; these tests
 * cover the index → pixel bookkeeping that decides which rows those are.
 * Pure logic only (no DOM, no React) — see
 * `src/features/player/cue-virtual-window.ts`.
 * --------------------------------------------------------------------------- */

import { describe, it, expect } from 'bun:test';
import {
  CUE_ROW_FALLBACK_HEIGHT,
  CUE_ROW_OVERSCAN,
  averageMeasuredHeight,
  buildCueOffsets,
  computeCueSpacers,
  computeCueVirtualWindow,
  findCueIndexAtOffset,
} from '../src/features/player/cue-virtual-window';

/** Cue stubs — only the id matters for the window math. */
function cues(count: number): { id: number }[] {
  return Array.from({ length: count }, (_, i) => ({ id: i }));
}

describe('buildCueOffsets', () => {
  it('falls back to the fallback height for unmeasured rows', () => {
    const offsets = buildCueOffsets(cues(3), new Map(), 46);
    expect(Array.from(offsets)).toEqual([0, 46, 92, 138]);
  });

  it('uses the measured height where it is known', () => {
    const measured = new Map<number, number>([
      [0, 50],
      [2, 70],
    ]);
    const offsets = buildCueOffsets(cues(3), measured, 46);
    expect(Array.from(offsets)).toEqual([0, 50, 96, 166]);
  });

  it('returns a zero-length array for an empty cue list', () => {
    const offsets = buildCueOffsets([], new Map(), 46);
    expect(offsets.length).toBe(1);
    expect(offsets[0]).toBe(0);
  });

  it('keeps the total height equal to the sum of the row heights', () => {
    const count = 500;
    const measured = new Map<number, number>();
    for (let i = 0; i < count; i += 1) measured.set(i, 40 + (i % 7));
    const offsets = buildCueOffsets(cues(count), measured, 46);
    let sum = 0;
    for (const height of measured.values()) sum += height;
    expect(offsets[count]).toBeCloseTo(sum, 5);
  });
});

describe('findCueIndexAtOffset', () => {
  const offsets = buildCueOffsets(cues(4), new Map(), 46); // 0,46,92,138,184

  it('returns the first cue at offset 0', () => {
    expect(findCueIndexAtOffset(offsets, 4, 0)).toBe(0);
  });

  it('returns the cue that owns the offset', () => {
    expect(findCueIndexAtOffset(offsets, 4, 45)).toBe(0);
    expect(findCueIndexAtOffset(offsets, 4, 46)).toBe(1);
    expect(findCueIndexAtOffset(offsets, 4, 91)).toBe(1);
    expect(findCueIndexAtOffset(offsets, 4, 92)).toBe(2);
  });

  it('clamps an offset past the end to the last cue', () => {
    expect(findCueIndexAtOffset(offsets, 4, 10_000)).toBe(3);
  });

  it('returns 0 for an empty list', () => {
    expect(findCueIndexAtOffset(new Float64Array(1), 0, 100)).toBe(0);
  });
});

describe('computeCueVirtualWindow', () => {
  const count = 3000;
  const offsets = buildCueOffsets(cues(count), new Map(), 46);

  it('mounts only the visible rows plus the overscan', () => {
    const window = computeCueVirtualWindow(offsets, count, 0, 600);
    // 600px / 46px ≈ 14 visible rows, plus 8 rows of overscan on each side.
    expect(window.startIndex).toBe(0);
    expect(window.endIndex).toBeLessThan(40);
    expect(window.endIndex).toBeGreaterThan(14);
  });

  it('never mounts more than a handful of rows for a long subtitle', () => {
    const window = computeCueVirtualWindow(offsets, count, 46 * 1500, 600);
    const mounted = window.endIndex - window.startIndex;
    expect(mounted).toBeLessThan(60);
    expect(window.startIndex).toBeLessThan(1500);
    expect(window.endIndex).toBeGreaterThan(1500);
  });

  it('keeps the overscan symmetric around the visible band', () => {
    const scrollTop = 46 * 500;
    const window = computeCueVirtualWindow(offsets, count, scrollTop, 600);
    const firstVisible = findCueIndexAtOffset(offsets, count, scrollTop);
    expect(window.startIndex).toBe(firstVisible - CUE_ROW_OVERSCAN);
  });

  it('clamps the window to the list bounds', () => {
    const atEnd = computeCueVirtualWindow(offsets, count, 46 * count, 600);
    expect(atEnd.endIndex).toBe(count);
    expect(atEnd.startIndex).toBeLessThan(count);
  });

  it('returns an empty window for an empty list', () => {
    const window = computeCueVirtualWindow(new Float64Array(1), 0, 0, 600);
    expect(window).toEqual({ startIndex: 0, endIndex: 0 });
  });

  it('mounts at least one row when the viewport height is unknown', () => {
    const window = computeCueVirtualWindow(offsets, count, 0, 0);
    expect(window.endIndex).toBeGreaterThan(window.startIndex);
  });
});

describe('computeCueSpacers', () => {
  const count = 1000;
  const offsets = buildCueOffsets(cues(count), new Map(), 46);

  it('replaces the unmounted rows with padding above and below', () => {
    const window = computeCueVirtualWindow(offsets, count, 46 * 400, 600);
    const spacers = computeCueSpacers(offsets, count, window);
    expect(spacers.top).toBe(offsets[window.startIndex]!);
    expect(spacers.bottom).toBe(offsets[count]! - offsets[window.endIndex]!);
  });

  it('keeps spacer + mounted height equal to the total height', () => {
    const window = computeCueVirtualWindow(offsets, count, 46 * 400, 600);
    const spacers = computeCueSpacers(offsets, count, window);
    const mountedHeight =
      offsets[window.endIndex]! - offsets[window.startIndex]!;
    expect(spacers.top + mountedHeight + spacers.bottom).toBeCloseTo(
      offsets[count]!,
      5,
    );
  });

  it('never reports a negative bottom spacer', () => {
    const window = { startIndex: 0, endIndex: count };
    const spacers = computeCueSpacers(offsets, count, window);
    expect(spacers.bottom).toBe(0);
  });
});

describe('averageMeasuredHeight', () => {
  it('falls back when nothing has been measured', () => {
    expect(averageMeasuredHeight(new Map(), 46)).toBe(46);
  });

  it('averages the measured heights', () => {
    const measured = new Map<number, number>([
      [0, 50],
      [1, 60],
    ]);
    expect(averageMeasuredHeight(measured, 46)).toBe(55);
  });

  it('ignores non-positive heights', () => {
    const measured = new Map<number, number>([
      [0, 0],
      [1, 50],
    ]);
    expect(averageMeasuredHeight(measured, 46)).toBe(50);
  });
});

describe('constants', () => {
  it('keeps the fallback row height and the overscan stable', () => {
    expect(CUE_ROW_FALLBACK_HEIGHT).toBe(46);
    expect(CUE_ROW_OVERSCAN).toBe(8);
  });
});
