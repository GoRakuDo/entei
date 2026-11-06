import { describe, expect, it } from 'bun:test';
import {
  resolveMediaSourceKind,
  shouldHideJimakuSearch,
  shouldHideSubtitleSync,
} from '../src/components/player/PlayerApp';

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

// ---------------------------------------------------------------------------
// P4: Right-panel "Jimaku subtitle search" button visibility predicate.
//
// Spec: docs/JIMAKU_SUBS.md §2.2.1.
//   - YouTube: hidden (YouTube delivers native captions; Jimaku anime/drama
//     matching is irrelevant for YouTube videos).
//   - Magnet / local (null jobKind): shown.
// ---------------------------------------------------------------------------

describe('shouldHideJimakuSearch', () => {
  it('hides for YouTube', () => {
    expect(shouldHideJimakuSearch('youtube')).toBe(true);
  });

  it('shows for torrent (Magnet)', () => {
    expect(shouldHideJimakuSearch('torrent')).toBe(false);
  });

  it('shows for local media (null jobKind)', () => {
    expect(shouldHideJimakuSearch(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ED-2F desktop path: YouTube played directly from the in-process yt-dlp
// relay has NO companion job session, so `jobSession.kind` stays null. The
// effective source kind must still resolve to 'youtube', otherwise both the
// subtitle-sync button and the Jimaku search button reappear on YouTube.
// ---------------------------------------------------------------------------

describe('resolveMediaSourceKind (ED-2F desktop YouTube stream)', () => {
  it("resolves 'youtube' for a direct Tauri yt-dlp stream (no job session)", () => {
    const kind = resolveMediaSourceKind({
      jobActive: false,
      jobKind: null,
      youtubeStreamActive: true,
    });
    expect(kind).toBe('youtube');
    expect(shouldHideJimakuSearch(kind)).toBe(true);
    expect(
      shouldHideSubtitleSync({ jobKind: kind, isMagnet: false, mediaName: '' }),
    ).toBe(true);
  });

  it("resolves 'youtube' for a companion YouTube job", () => {
    expect(
      resolveMediaSourceKind({
        jobActive: true,
        jobKind: 'youtube',
        youtubeStreamActive: false,
      }),
    ).toBe('youtube');
  });

  it("resolves 'torrent' for a companion Magnet job", () => {
    const kind = resolveMediaSourceKind({
      jobActive: true,
      jobKind: 'torrent',
      youtubeStreamActive: false,
    });
    expect(kind).toBe('torrent');
    expect(shouldHideJimakuSearch(kind)).toBe(false);
  });

  it('resolves null for local media (no job, no YouTube stream)', () => {
    const kind = resolveMediaSourceKind({
      jobActive: false,
      jobKind: null,
      youtubeStreamActive: false,
    });
    expect(kind).toBeNull();
    expect(shouldHideJimakuSearch(kind)).toBe(false);
  });

  it('ignores a stale kind on an inactive session', () => {
    // Defense in depth: endJobSession clears kind, but never trust stale state.
    expect(
      resolveMediaSourceKind({
        jobActive: false,
        jobKind: 'youtube',
        youtubeStreamActive: false,
      }),
    ).toBeNull();
  });

  it('prefers the active job kind over a stale YouTube stream flag', () => {
    expect(
      resolveMediaSourceKind({
        jobActive: true,
        jobKind: 'torrent',
        youtubeStreamActive: true,
      }),
    ).toBe('torrent');
  });
});
