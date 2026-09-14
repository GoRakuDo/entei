export type WatchHistorySource = 'local';
export type WatchHistoryPosterStatus = 'pending' | 'ready' | 'none';

export interface WatchHistoryRecord {
  /** The Tracker media fingerprint. This is the only identity key. */
  mediaId: string;
  title: string;
  episode: number | null;
  watchedAt: number;
  source: WatchHistorySource;
  anilistId: number | null;
  tmdbId: string | null;
  posterUrl: string | null;
  posterStatus: WatchHistoryPosterStatus;
}

export type WatchHistoryInput = Omit<
  WatchHistoryRecord,
  'watchedAt' | 'posterUrl' | 'posterStatus'
>;

export interface PosterResolution {
  posterUrl: string | null;
  posterStatus: Exclude<WatchHistoryPosterStatus, 'pending'>;
}
