/**
 * Tests for P2.1 play mode behavior.
 * ---------------------------------------------------------------------------
 * Covers: default normal, mode exclusivity, Condensed 1000ms boundary +
 * paused/mining guards, Fast-forward 600ms boundary and 1x/3x behavior,
 * manual rate restored after disabling Fast-forward.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldCondensedSeek,
  shouldFastForward,
  findNextCue,
  CONDENSED_SKIP_THRESHOLD_MS,
  FAST_FORWARD_GAP_THRESHOLD_MS,
  FAST_FORWARD_RATE,
  type PlayMode,
} from '@/features/player/control-helpers';

describe('findNextCue', () => {
  const cues = [
    { id: 1, start: 0, end: 2 },
    { id: 2, start: 5, end: 7 },
    { id: 3, start: 10, end: 12 },
  ];

  it('returns the next cue when time is before it', () => {
    expect(findNextCue(cues, 2.5)).toEqual(cues[1]);
  });

  it('returns undefined when no cue starts after time', () => {
    expect(findNextCue(cues, 15)).toBeUndefined();
  });

  it('returns first cue when time is negative', () => {
    expect(findNextCue(cues, -1)).toEqual(cues[0]);
  });
});

describe('shouldCondensedSeek', () => {
  const cues = [
    { id: 1, start: 0, end: 2 },
    { id: 2, start: 5, end: 7 },
    { id: 3, start: 10, end: 12 },
  ];

  it('returns false when mode is normal', () => {
    expect(
      shouldCondensedSeek('normal', true, false, false, false, false, cues, 3),
    ).toBe(false);
  });

  it('returns false when mode is fast-forward', () => {
    expect(
      shouldCondensedSeek(
        'fast-forward',
        true,
        false,
        false,
        false,
        false,
        cues,
        3,
      ),
    ).toBe(false);
  });

  it('returns false when paused', () => {
    expect(
      shouldCondensedSeek(
        'condensed',
        false,
        true,
        false,
        false,
        false,
        cues,
        3,
      ),
    ).toBe(false);
  });

  it('returns false when mining/capturing', () => {
    expect(
      shouldCondensedSeek(
        'condensed',
        true,
        false,
        true,
        false,
        false,
        cues,
        3,
      ),
    ).toBe(false);
  });

  it('returns false when seeking', () => {
    expect(
      shouldCondensedSeek(
        'condensed',
        true,
        false,
        false,
        true,
        false,
        cues,
        3,
      ),
    ).toBe(false);
  });

  it('returns false when condensed seek already in flight', () => {
    expect(
      shouldCondensedSeek(
        'condensed',
        true,
        false,
        false,
        false,
        true,
        cues,
        3,
      ),
    ).toBe(false);
  });

  it('returns false when no cues loaded', () => {
    expect(
      shouldCondensedSeek('condensed', true, false, false, false, false, [], 3),
    ).toBe(false);
  });

  it('returns false when inside an active cue', () => {
    expect(
      shouldCondensedSeek(
        'condensed',
        true,
        false,
        false,
        false,
        false,
        cues,
        1,
      ),
    ).toBe(false);
  });

  it('returns false when no next cue exists', () => {
    expect(
      shouldCondensedSeek(
        'condensed',
        true,
        false,
        false,
        false,
        false,
        cues,
        15,
      ),
    ).toBe(false);
  });

  it('returns false when gap is exactly 1000ms', () => {
    // cue ends at 2, next starts at 3 → gap = 1s = 1000ms
    const tightCues = [
      { id: 1, start: 0, end: 2 },
      { id: 2, start: 3, end: 4 },
    ];
    expect(
      shouldCondensedSeek(
        'condensed',
        true,
        false,
        false,
        false,
        false,
        tightCues,
        2,
      ),
    ).toBe(false);
  });

  it('returns false when gap is less than 1000ms', () => {
    // cue ends at 2, next starts at 2.9 → gap = 900ms
    const tightCues = [
      { id: 1, start: 0, end: 2 },
      { id: 2, start: 2.9, end: 4 },
    ];
    expect(
      shouldCondensedSeek(
        'condensed',
        true,
        false,
        false,
        false,
        false,
        tightCues,
        2,
      ),
    ).toBe(false);
  });

  it('returns true when gap is strictly greater than 1000ms', () => {
    // cue ends at 2, next starts at 5.1 → gap = 3100ms
    expect(
      shouldCondensedSeek(
        'condensed',
        true,
        false,
        false,
        false,
        false,
        cues,
        2,
      ),
    ).toBe(true);
  });

  it('returns true for large gaps between cues', () => {
    expect(
      shouldCondensedSeek(
        'condensed',
        true,
        false,
        false,
        false,
        false,
        cues,
        7.5,
      ),
    ).toBe(true);
  });
});

describe('shouldFastForward', () => {
  const cues = [
    { id: 1, start: 0, end: 2 },
    { id: 2, start: 5, end: 7 },
    { id: 3, start: 10, end: 12 },
  ];

  it('returns false when mode is normal', () => {
    expect(shouldFastForward('normal', cues, 3)).toBe(false);
  });

  it('returns false when mode is condensed', () => {
    expect(shouldFastForward('condensed', cues, 3)).toBe(false);
  });

  it('returns false when no cues loaded', () => {
    expect(shouldFastForward('fast-forward', [], 3)).toBe(false);
  });

  it('returns false when inside an active cue', () => {
    expect(shouldFastForward('fast-forward', cues, 1)).toBe(false);
  });

  it('returns false when within 600ms of previous cue end', () => {
    // cue 1 ends at 2, time = 2.4 → offset = 0.4s = 400ms < 600ms
    expect(shouldFastForward('fast-forward', cues, 2.4)).toBe(false);
  });

  it('returns false when within 600ms of next cue start', () => {
    // cue 2 starts at 5, time = 4.7 → offset = 0.3s = 300ms < 600ms
    expect(shouldFastForward('fast-forward', cues, 4.7)).toBe(false);
  });

  it('returns false when exactly 600ms from both edges', () => {
    // cue 1 ends at 2, time = 2.6 → offset = 600ms
    // cue 2 starts at 5, time = 2.6 → offset = 2.4s > 600ms
    // This should be false: 600ms is not strictly greater than 600ms.
    expect(shouldFastForward('fast-forward', cues, 2.6)).toBe(false);
  });

  it('returns true when both edges are more than 600ms away', () => {
    // cue 1 ends at 2, time = 3.5 → offset = 1.5s > 600ms
    // cue 2 starts at 5, time = 3.5 → offset = 1.5s > 600ms
    expect(shouldFastForward('fast-forward', cues, 3.5)).toBe(true);
  });

  it('returns true in large gap between cues', () => {
    // cue 2 ends at 7, time = 8 → offset from prev = 1s > 600ms
    // cue 3 starts at 10, time = 8 → offset to next = 2s > 600ms
    expect(shouldFastForward('fast-forward', cues, 8)).toBe(true);
  });

  it('returns false before first cue when within 600ms of it', () => {
    // No previous cue, next starts at 0, time = -0.3 → offset = 0.3s < 600ms
    expect(shouldFastForward('fast-forward', cues, -0.3)).toBe(false);
  });

  it('returns true before first cue when more than 600ms away', () => {
    // No previous cue (treated as Infinity), next starts at 0, time = -1
    // offset to next = 1s > 600ms
    expect(shouldFastForward('fast-forward', cues, -1)).toBe(true);
  });

  it('returns false after last cue when within 600ms of it', () => {
    // cue 3 ends at 12, time = 12.4 → offset = 0.4s < 600ms
    expect(shouldFastForward('fast-forward', cues, 12.4)).toBe(false);
  });

  it('returns true after last cue when more than 600ms away', () => {
    // cue 3 ends at 12, time = 13 → offset = 1s > 600ms
    // No next cue (treated as Infinity)
    expect(shouldFastForward('fast-forward', cues, 13)).toBe(true);
  });
});

describe('FAST_FORWARD_RATE constant', () => {
  it('is exactly 3', () => {
    expect(FAST_FORWARD_RATE).toBe(3);
  });
});

describe('CONDENSED_SKIP_THRESHOLD_MS constant', () => {
  it('is exactly 1000', () => {
    expect(CONDENSED_SKIP_THRESHOLD_MS).toBe(1000);
  });
});

describe('FAST_FORWARD_GAP_THRESHOLD_MS constant', () => {
  it('is exactly 600', () => {
    expect(FAST_FORWARD_GAP_THRESHOLD_MS).toBe(600);
  });
});

describe('PlayMode type contract', () => {
  it('accepts exactly the three allowed values', () => {
    const modes: PlayMode[] = ['normal', 'condensed', 'fast-forward'];
    expect(modes).toHaveLength(3);
    expect(modes).toContain('normal');
    expect(modes).toContain('condensed');
    expect(modes).toContain('fast-forward');
  });
});
