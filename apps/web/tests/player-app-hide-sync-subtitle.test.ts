import { describe, expect, it } from 'bun:test';
import {
  resolveMediaSourceKind,
  shouldHideJimakuSearch,
  shouldHideSubtitleSync,
} from '../src/components/player/PlayerApp';

describe('shouldHideSubtitleSync', () => {
  it('hides for YouTube regardless of extension', () => {
    expect(shouldHideSubtitleSync({ jobKind: 'youtube', mediaName: 'video.mp4' })).toBe(true);
    expect(shouldHideSubtitleSync({ jobKind: 'youtube', mediaName: 'video.mkv' })).toBe(true);
  });

  it('shows for native torrent and local video files only', () => {
    expect(shouldHideSubtitleSync({ jobKind: 'torrent', mediaName: 'movie.mkv' })).toBe(false);
    expect(shouldHideSubtitleSync({ jobKind: null, mediaName: 'movie.MP4' })).toBe(false);
    expect(shouldHideSubtitleSync({ jobKind: 'torrent', mediaName: 'subs.srt' })).toBe(true);
    expect(shouldHideSubtitleSync({ jobKind: null, mediaName: 'report.mkv-notes.txt' })).toBe(true);
  });
});

describe('shouldHideJimakuSearch', () => {
  it('hides for YouTube but keeps local and torrent search available', () => {
    expect(shouldHideJimakuSearch('youtube')).toBe(true);
    expect(shouldHideJimakuSearch('torrent')).toBe(false);
    expect(shouldHideJimakuSearch(null)).toBe(false);
  });
});

describe('resolveMediaSourceKind', () => {
  it('resolves native yt-dlp, torrent, and local sources', () => {
    expect(resolveMediaSourceKind({ torrentActive: false, youtubeStreamActive: true })).toBe('youtube');
    expect(resolveMediaSourceKind({ torrentActive: true, youtubeStreamActive: false })).toBe('torrent');
    expect(resolveMediaSourceKind({ torrentActive: false, youtubeStreamActive: false })).toBeNull();
  });

  it('prefers an active YouTube stream if source flags conflict', () => {
    expect(resolveMediaSourceKind({ torrentActive: true, youtubeStreamActive: true })).toBe('youtube');
  });
});
