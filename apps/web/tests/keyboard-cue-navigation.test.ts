import { describe, expect, it } from 'vitest';
import type { SubtitleCue } from '../src/features/player/subtitle-reader';

/**
 * Tests for keyboard shortcut cue navigation bounds logic.
 *
 * The actual hook (use-keyboard-shortcuts.ts) attaches to window keydown.
 * These tests exercise the identical bounds-clamping arithmetic used in the
 * hook to ensure stale/out-of-range activeCueId values are handled correctly.
 */

function makeCues(count: number): SubtitleCue[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    start: i * 3,
    end: i * 3 + 2,
    text: `Cue ${i}`,
  }));
}

/**
 * Mirror the ArrowLeft logic from use-keyboard-shortcuts.ts.
 * Returns the cue that would be selected, or null if cues are empty.
 */
function arrowLeftTarget(
  cues: SubtitleCue[],
  activeCueId: number | null,
): SubtitleCue | null {
  if (cues.length === 0) return null;
  const clampedId =
    activeCueId !== null && activeCueId >= 0 && activeCueId < cues.length
      ? activeCueId
      : 0;
  return clampedId > 0 ? cues[clampedId - 1]! : cues[0]!;
}

/**
 * Mirror the ArrowRight logic from use-keyboard-shortcuts.ts.
 * Returns the cue that would be selected, or null if cues are empty.
 */
function arrowRightTarget(
  cues: SubtitleCue[],
  activeCueId: number | null,
): SubtitleCue | null {
  if (cues.length === 0) return null;
  const clampedId =
    activeCueId !== null && activeCueId >= 0 && activeCueId < cues.length
      ? activeCueId
      : cues.length - 1;
  return clampedId < cues.length - 1
    ? cues[clampedId + 1]!
    : cues[cues.length - 1]!;
}

describe('ArrowLeft cue navigation bounds', () => {
  it('selects first cue when activeCueId is null', () => {
    const cues = makeCues(5);
    expect(arrowLeftTarget(cues, null)).toBe(cues[0]);
  });

  it('selects first cue when activeCueId is 0', () => {
    const cues = makeCues(5);
    expect(arrowLeftTarget(cues, 0)).toBe(cues[0]);
  });

  it('selects previous cue when activeCueId is valid', () => {
    const cues = makeCues(5);
    expect(arrowLeftTarget(cues, 3)).toBe(cues[2]);
  });

  it('clamps stale activeCueId exceeding cues length to first cue', () => {
    const cues = makeCues(3);
    // activeCueId=10 is out of range for 3-element array
    expect(arrowLeftTarget(cues, 10)).toBe(cues[0]);
  });

  it('clamps negative activeCueId to first cue', () => {
    const cues = makeCues(3);
    expect(arrowLeftTarget(cues, -5)).toBe(cues[0]);
  });

  it('returns null for empty cues', () => {
    expect(arrowLeftTarget([], null)).toBeNull();
    expect(arrowLeftTarget([], 2)).toBeNull();
  });
});

describe('ArrowRight cue navigation bounds', () => {
  it('selects last cue when activeCueId is null', () => {
    const cues = makeCues(5);
    expect(arrowRightTarget(cues, null)).toBe(cues[4]);
  });

  it('selects last cue when activeCueId is at end', () => {
    const cues = makeCues(5);
    expect(arrowRightTarget(cues, 4)).toBe(cues[4]);
  });

  it('selects next cue when activeCueId is valid', () => {
    const cues = makeCues(5);
    expect(arrowRightTarget(cues, 2)).toBe(cues[3]);
  });

  it('clamps stale activeCueId exceeding cues length to last cue', () => {
    const cues = makeCues(3);
    // activeCueId=99 is out of range for 3-element array
    expect(arrowRightTarget(cues, 99)).toBe(cues[2]);
  });

  it('clamps negative activeCueId to last cue', () => {
    const cues = makeCues(3);
    expect(arrowRightTarget(cues, -1)).toBe(cues[2]);
  });

  it('returns null for empty cues', () => {
    expect(arrowRightTarget([], null)).toBeNull();
    expect(arrowRightTarget([], 0)).toBeNull();
  });

  it('stays on last cue when activeCueId equals last index', () => {
    const cues = makeCues(1);
    expect(arrowRightTarget(cues, 0)).toBe(cues[0]);
  });
});

describe('Home key seek bounds', () => {
  it('seeks to cue start when activeCueId is valid', () => {
    const cues = makeCues(5);
    const id = 3;
    const cue = id !== null && id >= 0 && id < cues.length ? cues[id] : null;
    expect(cue?.start).toBe(9);
  });

  it('does not seek when activeCueId is out of range', () => {
    const cues = makeCues(3);
    const id = 99;
    const cue = id !== null && id >= 0 && id < cues.length ? cues[id] : null;
    expect(cue).toBeNull();
  });
});
