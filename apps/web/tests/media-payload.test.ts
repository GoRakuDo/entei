/**
 * media-payload unit tests — MODULE_ARCHITECTURE.md §3.
 *
 * The payload is the contract every source module speaks: the converters must
 * be pure, deterministic in shape, and must not invent data (no poster without
 * a video id, no duration guess). These tests pin that contract so a module
 * refactor cannot silently change what the player receives.
 */

import { describe, expect, it } from 'bun:test';
import {
  createLocalFilePayload,
  createTorrentPayload,
  createYouTubePayload,
  LOCAL_FILE_MODULE_ID,
  TORRENT_MODULE_ID,
  YTDLP_MODULE_ID,
  youtubePosterUrl,
} from '@/features/player/media-payload';

function makeFile(name: string, type = ''): File {
  return new File(['x'], name, { type });
}

describe('media-payload — local file', () => {
  it('maps a video file to a video payload', () => {
    const payload = createLocalFilePayload(
      makeFile('episode01.mkv'),
      'blob:entei-1',
    );

    expect(payload).toMatchObject({
      mediaUrl: 'blob:entei-1',
      mediaType: 'video',
      title: 'episode01.mkv',
      originModuleId: LOCAL_FILE_MODULE_ID,
    });
    expect(payload.sourceId.startsWith(`${LOCAL_FILE_MODULE_ID}:`)).toBe(true);
    // No duration/poster/subtitle invented by the converter.
    expect(payload.duration).toBeUndefined();
    expect(payload.posterUrl).toBeUndefined();
    expect(payload.subtitles).toBeUndefined();
  });

  it('maps an audio file to an audio payload', () => {
    const payload = createLocalFilePayload(
      makeFile('novel.m4b', 'audio/mp4'),
      'blob:entei-2',
    );

    expect(payload.mediaType).toBe('audio');
    expect(payload.title).toBe('novel.m4b');
  });

  it('gives distinct source ids to two picks of the same file', () => {
    const first = createLocalFilePayload(makeFile('a.mp4'), 'blob:entei-3');
    const second = createLocalFilePayload(makeFile('a.mp4'), 'blob:entei-4');

    expect(first.sourceId).not.toBe(second.sourceId);
  });

  it('derives a deterministic source id from the object url', () => {
    const once = createLocalFilePayload(makeFile('a.mp4'), 'blob:entei-5');
    const twice = createLocalFilePayload(makeFile('a.mp4'), 'blob:entei-5');

    expect(once.sourceId).toBe(`${LOCAL_FILE_MODULE_ID}:blob:entei-5`);
    expect(twice.sourceId).toBe(once.sourceId);
  });
});

describe('media-payload — yt-dlp', () => {
  it('carries the job identity and the module origin', () => {
    const payload = createYouTubePayload(
      'job-42',
      'Some Video',
      'stream://ytdlp/job-42',
      'video',
    );

    expect(payload).toEqual({
      sourceId: `${YTDLP_MODULE_ID}:job-42`,
      mediaUrl: 'stream://ytdlp/job-42',
      mediaType: 'video',
      title: 'Some Video',
      originModuleId: YTDLP_MODULE_ID,
    });
  });

  it('derives a poster only when a video id is known', () => {
    const withId = createYouTubePayload(
      'job-7',
      'T',
      'stream://ytdlp/job-7',
      'audio',
      'dQw4w9WgXcQ',
    );
    const withoutId = createYouTubePayload(
      'job-8',
      'T',
      'stream://ytdlp/job-8',
      'audio',
    );

    expect(withId.posterUrl).toBe(youtubePosterUrl('dQw4w9WgXcQ'));
    expect(withId.posterUrl).toBe(
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
    );
    expect(withoutId.posterUrl).toBeUndefined();
    expect(withId.mediaType).toBe('audio');
  });
});

describe('media-payload — torrent', () => {
  it('produces a video payload owned by the torrent module', () => {
    const payload = createTorrentPayload(
      'job-9',
      'Show S01E01.mkv',
      'stream://torrent/job-9',
    );

    expect(payload).toEqual({
      sourceId: `${TORRENT_MODULE_ID}:job-9`,
      mediaUrl: 'stream://torrent/job-9',
      mediaType: 'video',
      title: 'Show S01E01.mkv',
      originModuleId: TORRENT_MODULE_ID,
    });
  });

  it('passes a caller-provided poster through untouched', () => {
    const payload = createTorrentPayload(
      'job-10',
      'T',
      'stream://torrent/job-10',
      'https://example.test/thumb.jpg',
    );

    expect(payload.posterUrl).toBe('https://example.test/thumb.jpg');
  });

  it('never derives a YouTube poster for a torrent', () => {
    const payload = createTorrentPayload(
      'job-11',
      'T',
      'stream://torrent/job-11',
    );

    expect(payload.posterUrl).toBeUndefined();
  });
});
