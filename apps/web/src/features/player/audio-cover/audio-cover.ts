import { parseBlob, selectCover } from 'music-metadata';

export interface AudioCoverResult {
  /** Metadata title, or the selected file name when tags are unavailable. */
  title: string;
  /** Short-lived object URL for the extracted image, when one is available. */
  coverUrl: string | null;
}

interface Mp4Box {
  type: string;
  contentStart: number;
  end: number;
}

interface Mp4Cover {
  format: string;
  data: Uint8Array;
}

interface Mp4Metadata {
  title: string | null;
  cover: Mp4Cover | null;
}

interface DataPayload {
  dataType: number;
  payload: Uint8Array;
}

const MAX_TOP_LEVEL_BOXES = 128;
const MAX_CHILD_BOXES = 2048;
const MAX_TITLE_BYTES = 1024 * 1024;
const MAX_COVER_BYTES = 32 * 1024 * 1024;

function fallbackResult(file: File): AudioCoverResult {
  return { title: file.name || 'Audio track', coverUrl: null };
}

function metadataTitle(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function isMp4Like(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    /\.(?:m4a|m4b|mp4|m4v|mov|qt)$/.test(name) ||
    /^(?:audio|video|application)\/(?:mp4|x-m4a|x-m4b|quicktime)(?:$|;)/.test(
      file.type.toLowerCase(),
    )
  );
}

/** Read one bounded range; never materialize the source File as a whole. */
async function readRange(
  file: File,
  start: number,
  length: number,
): Promise<Uint8Array | null> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length <= 0 ||
    start > file.size - length
  ) {
    return null;
  }

  const bytes = await file.slice(start, start + length).arrayBuffer();
  if (bytes.byteLength !== length) return null;
  return new Uint8Array(bytes);
}

function fourCc(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
}

async function readBoxHeader(
  file: File,
  offset: number,
  containerEnd: number,
): Promise<Mp4Box | null> {
  if (offset < 0 || offset > containerEnd - 8) return null;

  const base = await readRange(file, offset, 8);
  if (base === null) return null;

  const view = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const size32 = view.getUint32(0);
  const type = fourCc(base.subarray(4, 8));
  let headerSize = 8;
  let size: number;

  if (size32 === 1) {
    const extended = await readRange(file, offset + 8, 8);
    if (extended === null) return null;
    const extendedView = new DataView(
      extended.buffer,
      extended.byteOffset,
      extended.byteLength,
    );
    const high = extendedView.getUint32(0);
    const low = extendedView.getUint32(4);
    size = high * 0x1_0000_0000 + low;
    headerSize = 16;
  } else if (size32 === 0) {
    size = containerEnd - offset;
  } else {
    size = size32;
  }

  if (
    !Number.isSafeInteger(size) ||
    size < headerSize ||
    size > containerEnd - offset
  ) {
    return null;
  }

  return {
    type,
    contentStart: offset + headerSize,
    end: offset + size,
  };
}

type BoxVisitor = (box: Mp4Box) => Promise<boolean>;

/** Scan only child headers and stop on malformed or excessive box sequences. */
async function scanBoxRange(
  file: File,
  start: number,
  end: number,
  visitor: BoxVisitor,
): Promise<boolean> {
  if (start < 0 || end < start || end > file.size) return false;

  let offset = start;
  for (let count = 0; offset < end; count += 1) {
    if (count >= MAX_CHILD_BOXES) return false;
    const box = await readBoxHeader(file, offset, end);
    if (box === null) return false;
    if (!(await visitor(box))) return false;
    offset = box.end;
  }

  return offset === end;
}

async function readDataPayload(
  file: File,
  item: Mp4Box,
  maxBytes: number,
): Promise<DataPayload | null> {
  let result: DataPayload | null = null;
  const valid = await scanBoxRange(file, item.contentStart, item.end, async (box) => {
    if (box.type !== 'data' || result !== null) return true;

    // A data box is a full box: version/flags (4), data type (4), locale (4),
    // then the payload.
    if (box.end - box.contentStart < 12) return false;
    const header = await readRange(file, box.contentStart, 12);
    if (header === null) return false;

    const headerView = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    );
    const payloadStart = box.contentStart + 12;
    const payloadLength = box.end - payloadStart;
    if (payloadLength < 0) return false;

    // Ignore an overlarge candidate without allocating it; another data box
    // in the same item may still contain a usable image.
    if (payloadLength > maxBytes || payloadLength === 0) return true;
    const payload = await readRange(file, payloadStart, payloadLength);
    if (payload === null) return false;

    result = { dataType: headerView.getUint32(4), payload };
    return true;
  });

  return valid ? result : null;
}

function decodeMetadataText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;

  let decoder: TextDecoder;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    decoder = new TextDecoder('utf-16le');
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    decoder = new TextDecoder('utf-16be');
  } else {
    decoder = new TextDecoder('utf-8');
  }

  const text = decoder.decode(bytes).replace(/\u0000/g, '').trim();
  return text.length > 0 ? text : null;
}

function imageFormat(dataType: number, bytes: Uint8Array): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    (bytes[3] === 0x38 || bytes[3] === 0x39) &&
    bytes[4] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }

  // Standard iTunes data types: 13 = JPEG, 14 = PNG.
  if (dataType === 13) return 'image/jpeg';
  if (dataType === 14) return 'image/png';
  return null;
}

async function readIlst(
  file: File,
  ilst: Mp4Box,
  result: Mp4Metadata,
): Promise<boolean> {
  return scanBoxRange(file, ilst.contentStart, ilst.end, async (item) => {
    if (item.type === '\xa9nam' && result.title === null) {
      const titleData = await readDataPayload(file, item, MAX_TITLE_BYTES);
      if (titleData !== null) {
        result.title = decodeMetadataText(titleData.payload);
      }
    }

    if (item.type === 'covr' && result.cover === null) {
      const coverData = await readDataPayload(file, item, MAX_COVER_BYTES);
      if (coverData !== null) {
        const format = imageFormat(coverData.dataType, coverData.payload);
        if (format !== null) {
          result.cover = { format, data: coverData.payload };
        }
      }
    }

    return true;
  });
}

async function readMeta(
  file: File,
  meta: Mp4Box,
  result: Mp4Metadata,
): Promise<boolean> {
  // meta is a full box; skip version (1 byte) and flags (3 bytes).
  if (meta.end - meta.contentStart < 4) return false;
  return scanBoxRange(file, meta.contentStart + 4, meta.end, async (box) => {
    if (box.type !== 'ilst') return true;
    return readIlst(file, box, result);
  });
}

async function readUserData(
  file: File,
  udta: Mp4Box,
  result: Mp4Metadata,
): Promise<boolean> {
  return scanBoxRange(file, udta.contentStart, udta.end, async (box) => {
    if (box.type === 'meta') return readMeta(file, box, result);
    if (box.type === 'ilst') return readIlst(file, box, result);
    return true;
  });
}

async function readMovieMetadata(
  file: File,
  moov: Mp4Box,
): Promise<Mp4Metadata | null> {
  const result: Mp4Metadata = { title: null, cover: null };
  const valid = await scanBoxRange(file, moov.contentStart, moov.end, async (box) => {
    if (box.type === 'udta') return readUserData(file, box, result);
    if (box.type === 'meta') return readMeta(file, box, result);
    return true;
  });
  return valid ? result : null;
}

async function readMp4Metadata(file: File): Promise<Mp4Metadata | null> {
  let offset = 0;
  for (let count = 0; offset < file.size; count += 1) {
    if (count >= MAX_TOP_LEVEL_BOXES) return null;
    const box = await readBoxHeader(file, offset, file.size);
    if (box === null) return null;
    if (box.type === 'moov') return readMovieMetadata(file, box);
    offset = box.end;
  }
  return null;
}

function createImageObjectUrl(
  format: string,
  data: Uint8Array,
): string | null {
  if (!format.startsWith('image/') || data.byteLength === 0) return null;

  // Copy into a plain ArrayBuffer so strict DOM typings accept image bytes
  // from both music-metadata and the range reader.
  const imageBytes = new Uint8Array(data.byteLength);
  imageBytes.set(data);
  const imageBlob = new Blob([imageBytes.buffer], { type: format });
  return URL.createObjectURL(imageBlob);
}

function createPictureObjectUrl(
  picture: { format: string; data: Uint8Array } | null,
): string | null {
  return picture === null ? null : createImageObjectUrl(picture.format, picture.data);
}

/**
 * Read an audio File in the browser and extract its title and preferred cover.
 *
 * MP4-family files are read by box range: only container headers, metadata
 * headers, and the selected image payload are loaded. Other audio formats
 * retain the existing music-metadata path. Cover parsing is best-effort:
 * callers can assign the audio object URL before awaiting this function, so a
 * parser/image failure never blocks playback.
 */
export async function extractAudioCover(file: File): Promise<AudioCoverResult> {
  const fallback = fallbackResult(file);

  try {
    if (isMp4Like(file)) {
      const metadata = await readMp4Metadata(file);
      if (metadata !== null) {
        return {
          title: metadataTitle(metadata.title, fallback.title),
          coverUrl:
            metadata.cover === null
              ? null
              : createImageObjectUrl(metadata.cover.format, metadata.cover.data),
        };
      }
      // Note: some QuickTime `.mov`/`.qt` files carry `meta` boxes without the
      // version/flags prefix the range reader assumes. Fall through and let
      // music-metadata try once before the title-card fallback; this reads the
      // file whole, but only for MP4-like inputs the box walk already rejected.
    }

    const metadata = await parseBlob(file);
    const title = metadataTitle(metadata.common.title, fallback.title);
    const picture = selectCover(metadata.common.picture);
    return {
      title,
      coverUrl: createPictureObjectUrl(picture),
    };
  } catch {
    // Invalid tags, unsupported containers, and object-URL failures all use
    // the same non-blocking title-card fallback.
    return fallback;
  }
}

/** Release a display-only cover URL without affecting the source audio. */
export function revokeAudioCoverUrl(coverUrl: string | null): void {
  if (coverUrl === null) return;
  try {
    URL.revokeObjectURL(coverUrl);
  } catch {
    // Cleanup is best effort; browsers may already have released the URL.
  }
}
