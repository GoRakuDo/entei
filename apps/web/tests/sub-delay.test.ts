// SPDX-License-Identifier: Apache-2.0
// Pure-logic tests for sub-delay (docs/MODULE_ARCHITECTURE.md §9.3):
// sub-millisecond subtitle offset applied from a native engine handoff.

import { describe, expect, it } from 'bun:test';
import type { SubtitleCue } from '../src/features/player/subtitle-reader';
import {
  createSubDelayState,
  dispatchSubDelay,
  listenForSubDelay,
  rebaseSubDelay,
  sanitizeSubDelaySeconds,
  setSubDelayOffset,
  shiftCuesBySubDelay,
  subDelayCues,
  SUB_DELAY_EVENT,
  SUB_DELAY_MAX_SECONDS,
} from '../src/features/player/sub-delay';

function cue(id: number, start: number, end: number): SubtitleCue {
  return { id, start, end, text: `cue-${id}` };
}

/** Round to microseconds so float dust never breaks an exact comparison. */
function times(cues: readonly SubtitleCue[]): [number, number][] {
  return cues.map((cue) => [
    Number(cue.start.toFixed(6)),
    Number(cue.end.toFixed(6)),
  ]);
}

const BASE: SubtitleCue[] = [
  cue(0, 1, 3),
  cue(1, 12.5, 14.25),
  cue(2, 40, 42),
];

describe('shiftCuesBySubDelay', () => {
  it('shifts forward with sub-millisecond precision (+2.3 s)', () => {
    expect(times(shiftCuesBySubDelay(BASE, 2.3))).toEqual([
      [3.3, 5.3],
      [14.8, 16.55],
      [42.3, 44.3],
    ]);
  });

  it('shifts backward with a negative offset (-10.5 s) and clamps at 0', () => {
    expect(times(shiftCuesBySubDelay(BASE, -10.5))).toEqual([
      [0, 0],
      [2, 3.75],
      [29.5, 31.5],
    ]);
  });

  it('keeps cue ids and text, and never mutates the input', () => {
    const shifted = shiftCuesBySubDelay(BASE, 1.75);
    expect(shifted.map((c) => c.id)).toEqual([0, 1, 2]);
    expect(shifted.map((c) => c.text)).toEqual(BASE.map((c) => c.text));
    expect(BASE.map((c) => c.start)).toEqual([1, 12.5, 40]);
    expect(shifted).not.toBe(BASE);
  });

  it('returns an equal copy for a zero / invalid offset', () => {
    for (const offset of [0, -0, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
      const shifted = shiftCuesBySubDelay(BASE, offset as number);
      expect(shifted.map((c) => c.start)).toEqual([1, 12.5, 40]);
      expect(shifted).not.toBe(BASE);
    }
  });
});

describe('sanitizeSubDelaySeconds', () => {
  it('accepts fractional and negative offsets', () => {
    expect(sanitizeSubDelaySeconds(-10.5)).toBe(-10.5);
    expect(sanitizeSubDelaySeconds(2.3)).toBe(2.3);
    expect(sanitizeSubDelaySeconds(0)).toBe(0);
  });

  it('rejects non-numbers, non-finite values and absurd offsets', () => {
    expect(sanitizeSubDelaySeconds('1')).toBeNull();
    expect(sanitizeSubDelaySeconds(null)).toBeNull();
    expect(sanitizeSubDelaySeconds(undefined)).toBeNull();
    expect(sanitizeSubDelaySeconds(Number.NaN)).toBeNull();
    expect(sanitizeSubDelaySeconds(Number.POSITIVE_INFINITY)).toBeNull();
    expect(sanitizeSubDelaySeconds(SUB_DELAY_MAX_SECONDS + 1)).toBeNull();
    expect(sanitizeSubDelaySeconds(-(SUB_DELAY_MAX_SECONDS + 1))).toBeNull();
  });
});

describe('SubDelayState', () => {
  it('starts at zero offset with the given base', () => {
    const state = createSubDelayState(BASE);
    expect(state.offsetSeconds).toBe(0);
    expect(state.baseCues).toBe(BASE);
    expect(subDelayCues(state).map((c) => c.start)).toEqual([1, 12.5, 40]);
  });

  it('keeps the base intact across repeated adjustments (no drift)', () => {
    let state = createSubDelayState(BASE);
    state = setSubDelayOffset(state, 10.5);
    state = setSubDelayOffset(state, -2.3);
    state = setSubDelayOffset(state, 4);

    expect(state.baseCues).toBe(BASE);
    expect(state.offsetSeconds).toBe(4);
    // Applied to the ORIGINAL base, not to the previous shifted copy.
    expect(subDelayCues(state).map((c) => c.start)).toEqual([5, 16.5, 44]);
    expect(BASE.map((c) => c.start)).toEqual([1, 12.5, 40]);
  });

  it('ignores an invalid offset without touching the current state', () => {
    const state = setSubDelayOffset(createSubDelayState(BASE), 1.5);
    expect(setSubDelayOffset(state, Number.NaN)).toBe(state);
    expect(setSubDelayOffset(state, 'x')).toBe(state);
    expect(state.offsetSeconds).toBe(1.5);
  });

  it('re-anchors to a new base while keeping the offset', () => {
    const state = setSubDelayOffset(createSubDelayState(BASE), 2);
    const next = rebaseSubDelay(state, [cue(0, 100, 101)]);
    expect(next.offsetSeconds).toBe(2);
    expect(subDelayCues(next)).toEqual([
      { id: 0, start: 102, end: 103, text: 'cue-0' },
    ]);
  });

  it('is immutable: state transitions return new objects', () => {
    const state = createSubDelayState(BASE);
    const next = setSubDelayOffset(state, 3);
    expect(next).not.toBe(state);
    expect(state.offsetSeconds).toBe(0);
  });
});

describe('native engine bridge', () => {
  it('delivers a native offset to the listener', () => {
    const seen: number[] = [];
    const cleanup = listenForSubDelay((offset) => seen.push(offset));

    dispatchSubDelay(-10.5);
    dispatchSubDelay(2.3);

    cleanup();
    expect(seen).toEqual([-10.5, 2.3]);
  });

  it('drops invalid payloads and stops after cleanup', () => {
    const seen: number[] = [];
    const cleanup = listenForSubDelay((offset) => seen.push(offset));

    dispatchSubDelay(Number.NaN);
    dispatchSubDelay('1.5');
    window.dispatchEvent(
      new CustomEvent(SUB_DELAY_EVENT, { detail: { seconds: 3 } }),
    );
    expect(seen).toEqual([]);

    dispatchSubDelay(1.25);
    cleanup();
    dispatchSubDelay(9);
    expect(seen).toEqual([1.25]);
  });
});
