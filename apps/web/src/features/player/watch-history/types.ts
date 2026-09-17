export type WatchHistorySource = 'local' | 'youtube' | 'audio';
export type WatchHistoryPosterStatus = 'pending' | 'ready' | 'none';

export interface WatchHistoryRecord {
  /** The local Tracker fingerprint or the youtube:{videoId} identity. */
  mediaId: string;
  title: string;
  /** Native/Japanese title when available; older records omit it. */
  titleNative?: string | null;
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
> & {
  /** YouTube supplies its poster synchronously at record time. */
  posterUrl?: string | null;
  posterStatus?: Exclude<WatchHistoryPosterStatus, 'pending'>;
};

export interface PosterResolution {
  posterUrl: string | null;
  posterStatus: Exclude<WatchHistoryPosterStatus, 'pending'>;
  titleNative?: string | null;
}
