/**
 * Unit tests for subtitle-interval.ts — ASB-style >=50% overlap rule.
 * ---------------------------------------------------------------------------
 * - Boundary: cue exactly at range edge
 * - >=50% overlap included, <50% excluded
 * - Zero-length cues ignored
 * - Blank text filtered from join
 * - Ordering preserved, newline join
 * - Invalid range returns empty
 * --------------------------------------------------------------------------- */

import { describe, it, expect } from 'vitest';
import { selectCueTextInRange } from '@/features/player/subtitle-interval';
import type { SubtitleCue } from '@/features/player/subtitle-reader';

function cue(
  id: number,
  start: number,
  end: number,
  text: string,
): SubtitleCue {
  return { id, start, end, text };
}

describe('selectCueTextInRange', () => {
  it('includes a cue fully inside the range', () => {
    const cues = [cue(1, 10, 15, 'hello')];
    expect(selectCueTextInRange(cues, 8, 18)).toBe('hello');
  });

  it('includes a cue with exactly 50% overlap', () => {
    // cue 10-20 (duration 10), range 15-25 → overlap 5 = 50%
    const cues = [cue(1, 10, 20, 'half')];
    expect(selectCueTextInRange(cues, 15, 25)).toBe('half');
  });

  it('excludes a cue with less than 50% overlap', () => {
    // cue 10-20 (duration 10), range 15-25 → overlap 5 = 50% (included)
    // cue 10-20 (duration 10), range 16-25 → overlap 4 = 40% (excluded)
    const cues = [cue(1, 10, 20, 'under')];
    expect(selectCueTextInRange(cues, 16, 25)).toBe('');
  });

  it('includes a cue that fully contains the range', () => {
    // cue 5-30, range 10-15 → overlap 5, cue duration 25, 5/25 = 20% → excluded
    const cues = [cue(1, 5, 30, 'big')];
    expect(selectCueTextInRange(cues, 10, 15)).toBe('');
  });

  it('includes a cue that fully contains the range when overlap >= 50%', () => {
    // cue 10-20, range 12-18 → overlap 6, cue duration 10, 6/10 = 60% → included
    const cues = [cue(1, 10, 20, 'contained')];
    expect(selectCueTextInRange(cues, 12, 18)).toBe('contained');
  });

  it('ignores zero-length cues', () => {
    const cues = [cue(1, 10, 10, 'zero'), cue(2, 10, 15, 'good')];
    expect(selectCueTextInRange(cues, 8, 18)).toBe('good');
  });

  it('filters blank/whitespace-only text from join', () => {
    const cues = [
      cue(1, 10, 15, 'first'),
      cue(2, 12, 17, '   '),
      cue(3, 14, 19, 'third'),
    ];
    expect(selectCueTextInRange(cues, 8, 20)).toBe('first\nthird');
  });

  it('joins multiple qualifying cues with newline in order', () => {
    const cues = [
      cue(1, 10, 15, 'one'),
      cue(2, 14, 20, 'two'),
      cue(3, 19, 25, 'three'),
    ];
    expect(selectCueTextInRange(cues, 8, 28)).toBe('one\ntwo\nthree');
  });

  it('preserves cue order from input array', () => {
    const cues = [
      cue(3, 19, 25, 'three'),
      cue(1, 10, 15, 'one'),
      cue(2, 14, 20, 'two'),
    ];
    // Output follows array order, not time order
    expect(selectCueTextInRange(cues, 8, 28)).toBe('three\none\ntwo');
  });

  it('returns empty string when no cues qualify', () => {
    const cues = [cue(1, 0, 5, 'early')];
    expect(selectCueTextInRange(cues, 100, 110)).toBe('');
  });

  it('returns empty string for empty cues array', () => {
    expect(selectCueTextInRange([], 10, 20)).toBe('');
  });

  it('returns empty string for invalid range (start >= end)', () => {
    const cues = [cue(1, 10, 15, 'hello')];
    expect(selectCueTextInRange(cues, 20, 10)).toBe('');
  });

  it('returns empty string for non-finite range', () => {
    const cues = [cue(1, 10, 15, 'hello')];
    expect(selectCueTextInRange(cues, NaN, 20)).toBe('');
    expect(selectCueTextInRange(cues, 10, Infinity)).toBe('');
  });

  it('handles cue at exact range boundary', () => {
    // cue 10-15, range 10-15 → overlap 5, duration 5, 100% → included
    const cues = [cue(1, 10, 15, 'exact')];
    expect(selectCueTextInRange(cues, 10, 15)).toBe('exact');
  });

  it('handles adjacent cues without overlap gap', () => {
    const cues = [cue(1, 10, 15, 'first'), cue(2, 15, 20, 'second')];
    // range 10-20: cue1 overlap 5/5=100%, cue2 overlap 5/5=100%
    expect(selectCueTextInRange(cues, 10, 20)).toBe('first\nsecond');
  });
});
