import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractAudioCover, revokeAudioCoverUrl } from '@/features/player/audio-cover/audio-cover';

const musicMetadataMocks = vi.hoisted(() => ({
  parseBlob: vi.fn(),
  selectCover: vi.fn(),
}));

vi.mock('music-metadata', () => musicMetadataMocks);

// ---------------------------------------------------------------------------
// MP4 box fixture helpers
// ---------------------------------------------------------------------------

function u32(value: number): Uint8Array {
  const chunk = new Uint8Array(4);
  new DataView(chunk.buffer).setUint32(0, value);
  return chunk;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(8 + payload.length);
  chunk.set(u32(8 + payload.length), 0);
  chunk.set(Array.from(type, (character) => character.charCodeAt(0)), 4);
  chunk.set(payload, 8);
  return chunk;
}

function fullBox(type: string, payload: Uint8Array): Uint8Array {
  // A "full box" carries 1 version byte + 3 flag bytes before its payload.
  return box(type, new Uint8Array([0, 0, 0, 0, ...payload]));
}

function dataBox(dataType: number, payload: Uint8Array): Uint8Array {
  return fullBox('data', new Uint8Array([...u32(dataType), ...u32(0), ...payload]));
}

/** Audible-style data box: version/flags + dataType 0, NO locale field —
    image bytes start at +8 instead of +12. */
function audibleDataBox(payload: Uint8Array): Uint8Array {
  return box('data', new Uint8Array([0, 0, 0, 0, ...u32(0), ...payload]));
}

function textDataBox(text: string): Uint8Array {
  return dataBox(1, new Uint8Array([...new TextEncoder().encode(text), 0]));
}

/** A minimal iTunes-style metadata tree: moov > udta > meta > ilst. */
function mp4Fixture(options: {
  title?: string | null;
  cover?: { dataType: number; bytes: Uint8Array } | null;
  prefixBytes?: number;
}) {
  const items: Uint8Array[] = [];
  if (options.title !== null && options.title !== undefined) {
    items.push(box('\xa9nam', textDataBox(options.title)));
  }
  if (options.cover !== null && options.cover !== undefined) {
    items.push(box('covr', dataBox(options.cover.dataType, options.cover.bytes)));
  }

  const ilst = box('ilst', new Uint8Array(items.flatMap((item) => Array.from(item))));
  const meta = fullBox('meta', ilst);
  const udta = box('udta', meta);
  const moov = box('moov', udta);
  const prefix = box('free', new Uint8Array(options.prefixBytes ?? 0));
  return new File([new Uint8Array([...prefix, ...moov])], 'fixture.m4b', {
    type: 'audio/mp4',
  });
}

/**
 * A virtual MP4 whose `mdat` body is declared by size but never materialized:
 * only `head` (ftyp+moov bytes) and the 8-byte mdat header are real. Records
 * every slice range so a test can prove the reader never walked the media data.
 */
function virtualMp4File(options: {
  head: Uint8Array;
  mdatSize: number;
  mdatFirst: boolean;
}) {
  const mdatHeader = new Uint8Array([
    ...u32(options.mdatSize),
    ...new TextEncoder().encode('mdat'),
  ]);
  const mdatOffset = options.mdatFirst ? 0 : options.head.length;
  const headOffset = options.mdatFirst ? options.mdatSize : 0;
  const totalSize = options.head.length + options.mdatSize;
  const reads: Array<[number, number]> = [];

  const slice = (start: number, end?: number) => {
    const sliceEnd = Math.min(end ?? totalSize, totalSize);
    const bytes = new Uint8Array(Math.max(sliceEnd - start, 0));
    const place = (source: Uint8Array, sourceOffset: number) => {
      const from = Math.max(start, sourceOffset);
      const to = Math.min(sliceEnd, sourceOffset + source.length);
      if (from < to) {
        bytes.set(source.subarray(from - sourceOffset, to - sourceOffset), from - start);
      }
    };
    place(mdatHeader, mdatOffset);
    place(options.head, headOffset);
    reads.push([start, sliceEnd]);
    return new Blob([bytes]);
  };

  return {
    file: {
      name: 'virtual.m4b',
      type: 'audio/mp4',
      size: totalSize,
      slice,
    } as unknown as File,
    reads,
    mdatBody: [mdatOffset + 8, mdatOffset + options.mdatSize] as const,
  };
}

const JPEG_PAYLOAD = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

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
      new File(['audio'], 'fallback.mp3', { type: 'audio/mpeg' }),
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
      new File(['audio'], 'Fallback title.mp3', { type: 'audio/mpeg' }),
    );

    expect(result).toEqual({ title: 'Fallback title.mp3', coverUrl: null });
  });

  it('keeps a valid title but falls back when cover data is not an image', async () => {
    const picture = { format: 'application/octet-stream', data: Uint8Array.from([1]) };
    musicMetadataMocks.parseBlob.mockResolvedValue({
      common: { title: 'Title without art', picture: [picture] },
    });
    musicMetadataMocks.selectCover.mockReturnValue(picture);

    await expect(
      extractAudioCover(new File(['audio'], 'book.mp3')),
    ).resolves.toEqual({ title: 'Title without art', coverUrl: null });
  });

  it('revokes only the display cover URL', () => {
    revokeAudioCoverUrl('blob:cover-art');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cover-art');
    revokeAudioCoverUrl(null);
  });
});

describe('MP4 cover extraction', () => {
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

  it('extracts title and JPEG cover from a small m4b', async () => {
    const file = mp4Fixture({
      title: 'Small audiobook',
      cover: { dataType: 13, bytes: JPEG_PAYLOAD },
    });

    await expect(extractAudioCover(file)).resolves.toEqual({
      title: 'Small audiobook',
      coverUrl: 'blob:cover-art',
    });
    expect(URL.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/jpeg' }),
    );
    expect(musicMetadataMocks.parseBlob).not.toHaveBeenCalled();
  });

  it('extracts an Audible-style covr with no locale field', async () => {
    const items = box('covr', audibleDataBox(JPEG_PAYLOAD));
    const ilst = box('ilst', items);
    const meta = fullBox('meta', ilst);
    const moov = box('moov', box('udta', meta));
    const file = new File([new Uint8Array([...moov])], 'audible.m4b', {
      type: 'audio/mp4',
    });

    await expect(extractAudioCover(file)).resolves.toEqual({
      title: 'audible.m4b',
      coverUrl: 'blob:cover-art',
    });
    expect(URL.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/jpeg' }),
    );
  });

  it('omits a cover when the m4b has a title but no covr atom', async () => {
    const file = mp4Fixture({ title: 'No art', cover: null });

    await expect(extractAudioCover(file)).resolves.toEqual({
      title: 'No art',
      coverUrl: null,
    });
  });

  it('falls back to the file name when the MP4 tree is corrupt', async () => {
    const file = new File([new Uint8Array([0, 0, 0, 3, 0x6d, 0x6f, 0x6f, 0x76])], 'broken.m4b', {
      type: 'audio/mp4',
    });

    await expect(extractAudioCover(file)).resolves.toEqual({
      title: 'broken.m4b',
      coverUrl: null,
    });
  });

  it('retries music-metadata when a QuickTime meta box has no version or flags', async () => {
    // .mov/.qt may store `meta` as a plain container; the +4 full-box skip then
    // finds no ilst and the range reader gives up before the metadata fallback.
    const moov = box(
      'moov',
      box(
        'udta',
        box(
          'meta',
          box('ilst', box('\xa9nam', textDataBox('QuickTime title'))),
        ),
      ),
    );
    const file = new File([new Uint8Array([...moov])], 'legacy.mov', {
      type: 'video/quicktime',
    });
    musicMetadataMocks.parseBlob.mockResolvedValue({
      common: { title: 'QuickTime title', picture: [] },
    });
    musicMetadataMocks.selectCover.mockReturnValue(null);

    await expect(extractAudioCover(file)).resolves.toEqual({
      title: 'QuickTime title',
      coverUrl: null,
    });
    expect(musicMetadataMocks.parseBlob).toHaveBeenCalledOnce();
  });

  it('handles a covr atom near the end of a large file without reading the file whole', async () => {
    const source = mp4Fixture({
      title: 'Audible audiobook',
      cover: { dataType: 13, bytes: JPEG_PAYLOAD },
    });
    const moovBytes = new Uint8Array(await source.arrayBuffer());
    const moovOffset = 238_227_717;
    const totalSize = moovOffset + moovBytes.length;
    const sliceLengths: number[] = [];
    const file = {
      name: 'audible.m4b',
      type: 'audio/mp4',
      size: totalSize,
      slice(start: number, end?: number) {
        const sliceEnd = end ?? totalSize;
        const bytes = new Uint8Array(sliceEnd - start);
        const freeHeader = new Uint8Array([...u32(moovOffset), ...new TextEncoder().encode('free')]);
        if (start < freeHeader.length && sliceEnd > 0) {
          bytes.set(freeHeader.subarray(start, sliceEnd), -start);
        }
        const moovEnd = moovOffset + moovBytes.length;
        const overlapStart = Math.max(start, moovOffset);
        const overlapEnd = Math.min(sliceEnd, moovEnd);
        if (overlapStart < overlapEnd) {
          bytes.set(
            moovBytes.subarray(overlapStart - moovOffset, overlapEnd - moovOffset),
            overlapStart - start,
          );
        }
        sliceLengths.push(bytes.length);
        return new Blob([bytes]);
      },
    } as unknown as File;

    await expect(extractAudioCover(file)).resolves.toEqual({
      title: 'Audible audiobook',
      coverUrl: 'blob:cover-art',
    });
    expect(Math.max(...sliceLengths)).toBeLessThan(1_000_000);
    expect(musicMetadataMocks.parseBlob).not.toHaveBeenCalled();
  });

  it('walks ftyp then moov to a covr atom without reading the surrounding media data', async () => {
    const head = new Uint8Array([
      ...box('ftyp', new TextEncoder().encode('M4B ')),
      ...box(
        'moov',
        box(
          'udta',
          fullBox(
            'meta',
            box(
              'ilst',
              new Uint8Array([
                ...box('\xa9nam', textDataBox('Range-read audiobook')),
                ...box('covr', dataBox(13, JPEG_PAYLOAD)),
              ]),
            ),
          ),
        ),
      ),
    ]);

    // "mdat after moov" is the common layout; "mdat before moov" puts the covr
    // payload within a few hundred bytes of EOF.
    for (const mdatFirst of [false, true]) {
      const { file, reads, mdatBody } = virtualMp4File({
        head,
        mdatSize: 180_000_000,
        mdatFirst,
      });

      await expect(extractAudioCover(file)).resolves.toEqual({
        title: 'Range-read audiobook',
        coverUrl: 'blob:cover-art',
      });

      // Every control-flow path must have used the box walk, not a whole-file
      // parse, and must never have touched the declared mdat body.
      const bytesRead = reads.reduce((total, [start, end]) => total + (end - start), 0);
      expect(bytesRead).toBeLessThan(head.length + 1024);
      expect(
        reads.some(([start, end]) => end > mdatBody[0] && start < mdatBody[1]),
      ).toBe(false);
    }

    expect(musicMetadataMocks.parseBlob).not.toHaveBeenCalled();
  });
});
