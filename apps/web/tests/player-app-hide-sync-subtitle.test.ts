import { describe, expect, it } from 'vitest';
import { shouldHideSubtitleSync } from '../src/components/player/PlayerApp';

// ---------------------------------------------------------------------------
// W16: Right-panel "subtitle sync" button visibility predicate.
//
// Spec: docs/SUBTITLE_SYNC.md §2.11-12.
//   - YouTube: hidden (auto subs already accurate).
//   - Magnet or local: shown iff the media file looks like a video
//     (.mkv / .mp4); hidden for any other extension.
//
// Note: `isMagnet` is kept in the signature for call-site symmetry but is
// NOT part of the visibility decision (Magnet .mkv/.mp4 → shown).
// ---------------------------------------------------------------------------

describe('shouldHideSubtitleSync (SUBTITLE_SYNC.md §2.11-12)', () => {
  it('hides for YouTube regardless of file name', () => {
    expect(
      shouldHideSubtitleSync({
        jobKind: 'youtube',
        isMagnet: false,
        mediaName: 'anything.mp4',
      }),
    ).toBe(true);
    expect(
      shouldHideSubtitleSync({
        jobKind: 'youtube',
        isMagnet: true,
        mediaName: 'anything.mkv',
      }),
    ).toBe(true);
  });

  it('shows for Magnet .mkv / .mp4 (regression guard)', () => {
    expect(
      shouldHideSubtitleSync({
        jobKind: 'torrent',
        isMagnet: true,
        mediaName: 'movie.mkv',
      }),
    ).toBe(false);
    expect(
      shouldHideSubtitleSync({
        jobKind: 'torrent',
        isMagnet: true,
        mediaName: 'Movie.MP4',
      }),
    ).toBe(false);
  });

  it('shows for local (non-magnet) .mkv / .mp4', () => {
    expect(
      shouldHideSubtitleSync({
        jobKind: 'torrent',
        isMagnet: false,
        mediaName: 'local-clip.mkv',
      }),
    ).toBe(false);
    expect(
      shouldHideSubtitleSync({
        jobKind: 'torrent',
        isMagnet: false,
        mediaName: 'local-clip.mp4',
      }),
    ).toBe(false);
  });

  it('hides for local non-video files (e.g. .txt subtitles)', () => {
    expect(
      shouldHideSubtitleSync({
        jobKind: 'torrent',
        isMagnet: false,
        mediaName: 'subs.txt',
      }),
    ).toBe(true);
    expect(
      shouldHideSubtitleSync({
        jobKind: 'torrent',
        isMagnet: false,
        mediaName: 'subs.srt',
      }),
    ).toBe(true);
  });

  it('hides for Magnet non-video files too (Magnet alone is not enough)', () => {
    // Regression: previous predicate `!isMagnet || !isLocalVideo` would have
    // hidden magnet .txt (correctly), but also hidden local .mkv (wrong).
    expect(
      shouldHideSubtitleSync({
        jobKind: 'torrent',
        isMagnet: true,
        mediaName: 'subs.srt',
      }),
    ).toBe(true);
  });

  it('does not match .mkv/.mp4 as a substring — only as a suffix', () => {
    expect(
      shouldHideSubtitleSync({
        jobKind: 'torrent',
        isMagnet: false,
        mediaName: 'report.mkv-notes.txt',
      }),
    ).toBe(true);
  });
});
