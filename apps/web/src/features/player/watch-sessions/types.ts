/** A single local watch session for a local file or YouTube source. */
export interface WatchSessionRecord {
  sessionId: string;
  mediaId: string;
  startedAt: number;
  endedAt: number;
  watchMs: number;
  episode: number | null;
  minedSentences: string[];
}

/** Return the positive playback delta that counts as watched progress. */
export function getPlaybackWatchDeltaMs(
  previousTime: number | null,
  currentTime: number,
  maxDeltaSeconds = 5,
): number {
  if (
    previousTime === null ||
    !Number.isFinite(previousTime) ||
    !Number.isFinite(currentTime)
  ) {
    return 0;
  }

  const deltaSeconds = currentTime - previousTime;
  if (deltaSeconds <= 0 || deltaSeconds > maxDeltaSeconds) return 0;
  return deltaSeconds * 1000;
}
