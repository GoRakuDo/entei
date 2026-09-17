import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractAudioCover, revokeAudioCoverUrl } from '@/features/player/audio-cover/audio-cover';

const musicMetadataMocks = vi.hoisted(() => ({
  parseBlob: vi.fn(),
  selectCover: vi.fn(),
}));

vi.mock('music-metadata', () => musicMetadataMocks);

describe('audio cover extraction', () => {
  beforeEach(() => {
    musicMetadataMocks.parseBlob.mockReset();
    musicMetadataMocks.selectCover.mockReset();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:cover-art'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  it('reads the metadata title and creates an object URL for selectCover art', async () => {
    const picture = {
      format: 'image/jpeg',
      data: Uint8Array.from([0xff, 0xd8, 0xff]),
    };
    musicMetadataMocks.parseBlob.mockResolvedValue({
      common: { title: 'Tagged audiobook', picture: [picture] },
    });
    musicMetadataMocks.selectCover.mockReturnValue(picture);

    const result = await extractAudioCover(
      new File(['audio'], 'fallback.m4b', { type: 'audio/mp4' }),
    );

    expect(result).toEqual({
      title: 'Tagged audiobook',
      coverUrl: 'blob:cover-art',
    });
    expect(musicMetadataMocks.parseBlob).toHaveBeenCalledOnce();
    expect(musicMetadataMocks.selectCover).toHaveBeenCalledWith([picture]);
  });

  it('keeps playback fallback data when parsing fails', async () => {
    musicMetadataMocks.parseBlob.mockRejectedValue(new Error('bad tags'));

    const result = await extractAudioCover(
      new File(['audio'], 'Fallback title.m4b', { type: 'audio/mp4' }),
    );

    expect(result).toEqual({ title: 'Fallback title.m4b', coverUrl: null });
  });

  it('keeps a valid title but falls back when cover data is not an image', async () => {
    const picture = { format: 'application/octet-stream', data: Uint8Array.from([1]) };
    musicMetadataMocks.parseBlob.mockResolvedValue({
      common: { title: 'Title without art', picture: [picture] },
    });
    musicMetadataMocks.selectCover.mockReturnValue(picture);

    await expect(
      extractAudioCover(new File(['audio'], 'book.m4b')),
    ).resolves.toEqual({ title: 'Title without art', coverUrl: null });
  });

  it('revokes only the display cover URL', () => {
    revokeAudioCoverUrl('blob:cover-art');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cover-art');
    revokeAudioCoverUrl(null);
  });
});
