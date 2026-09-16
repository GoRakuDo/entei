import { describe, expect, it } from 'vitest';
import { getPlaybackWatchDeltaMs } from '@/features/player/watch-sessions';

describe('watch session playback timing', () => {
  it('counts only a normal forward playback delta', () => {
    expect(getPlaybackWatchDeltaMs(10, 10.75)).toBe(750);
  });

  it('ignores the first sample, seeks, and stale gaps', () => {
    expect(getPlaybackWatchDeltaMs(null, 1)).toBe(0);
    expect(getPlaybackWatchDeltaMs(10, 4)).toBe(0);
    expect(getPlaybackWatchDeltaMs(10, 20)).toBe(0);
  });
});
