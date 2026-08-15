import { describe, expect, it } from 'vitest';
import { parseMediaFileName } from '../src/features/player/filename-parser';

describe('parseMediaFileName', () => {
  it('parses the documented MagicStar example', () => {
    expect(
      parseMediaFileName(
        '[MagicStar] Meitantei no Mama de Ite EP01 [WEBDL] [1080p] [TELASA] [JPN_SUB]',
      ),
    ).toEqual({ title: 'Meitantei no Mama de Ite', episode: 1 });
  });

  it('parses a bare title without episode', () => {
    expect(parseMediaFileName('Sousou no Frieren 1080p.mkv')).toEqual({
      title: 'Sousou no Frieren',
      episode: null,
    });
  });

  it('handles S01E01 season+episode', () => {
    expect(parseMediaFileName('Show Name S01E03 1080p.mkv')).toEqual({
      title: 'Show Name',
      episode: 3,
    });
  });

  it('handles 1x01 season+episode', () => {
    expect(parseMediaFileName('Title - 1x04 - WEB.mkv')).toEqual({
      title: 'Title',
      episode: 4,
    });
  });

  it('handles bare E01', () => {
    expect(parseMediaFileName('Anime E12.mkv')).toEqual({
      title: 'Anime',
      episode: 12,
    });
  });

  it('handles 第n話 (Japanese episode marker)', () => {
    expect(parseMediaFileName('葬送のフリーレン 第2話.mkv')).toEqual({
      title: '葬送のフリーレン',
      episode: 2,
    });
  });

  it('removes year tags and normalizes dots/underscores', () => {
    expect(parseMediaFileName('Kekkon_Surutte_Masaka (2024) EP05.mkv')).toEqual({
      title: 'Kekkon Surutte Masaka',
      episode: 5,
    });
  });

  it('strips multiple bracket tags', () => {
    expect(parseMediaFileName('[Sub] Title E07 [HEVC] [JPN_SUB].mp4')).toEqual({
      title: 'Title',
      episode: 7,
    });
  });

  it('returns empty title/episode null for a tag-only name', () => {
    expect(parseMediaFileName('[1080p] [HEVC].mkv')).toEqual({
      title: '',
      episode: null,
    });
  });

  it('returns empty for an empty input', () => {
    expect(parseMediaFileName('')).toEqual({ title: '', episode: null });
    expect(parseMediaFileName('   ')).toEqual({ title: '', episode: null });
  });
});
