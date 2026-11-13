/**
 * dictionary-zip — minimal ZIP reader for Yomitan dictionary archives.
 * ---------------------------------------------------------------------------
 * Yomitan dictionaries ship as a ZIP holding `index.json` + `term_bank_*.json`
 * / `kanji_bank_*.json` / `*_meta_bank_*.json` / `tag_bank_*.json` (+ media).
 *
 * Yomitan itself reads archives through `@zip.js/zip.js` with a web worker. We
 * only need "open the archive, hand back named files", so the central directory
 * is parsed directly and the two compression methods that appear in real
 * dictionaries are supported:
 *
 * - `0` (stored) — slice the bytes out.
 * - `8` (deflate) — inflate through the browser-native `DecompressionStream`
 *   (`deflate-raw`, i.e. the headerless stream a ZIP stores). No dependency, and
 *   it runs off the main thread inside the browser's own implementation.
 *
 * Zip64 is handled for the cases a large dictionary can actually trigger (entry
 * count / central-directory offset in the EOCD, and per-entry 8-byte sizes in
 * the `0x0001` extra field). Anything else — encryption, imploding, bzip2,
 * LZMA, multi-disk — is refused with a message naming the method, so an
 * unsupported archive fails loudly instead of importing garbage.
 * ---------------------------------------------------------------------------
 */

/** Archive entry: a named file plus the two read helpers we need. */
export interface ZipEntry {
  /** Full path inside the archive (UTF-8 decoded, e.g. `dict/term_bank_1.json`). */
  readonly name: string;
  /** Uncompressed size in bytes (0 when the archive does not declare it). */
  readonly size: number;
  /** Decompressed file content as text (UTF-8). */
  readText(): Promise<string>;
  /** Decompressed file content as raw bytes. */
  readBytes(): Promise<Uint8Array>;
}

/** An opened archive: every file entry keyed by its full path. */
export interface ZipArchive {
  readonly entries: ReadonlyMap<string, ZipEntry>;
}

const EOCD_SIGNATURE = 0x06054b54;
const ZIP64_EOCD_SIGNATURE = 0x06064b64;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b64;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const utf8Decoder = new TextDecoder('utf-8');

interface CentralRecord {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
}

/**
 * Inflate a raw DEFLATE stream.
 *
 * `deflate-raw` is the headerless variant a ZIP entry stores, and is exactly
 * what `DecompressionStream` documents — no manual window handling needed.
 * Runtime support was measured as uneven (Chromium/Firefox/Safari and Bun 1.4
 * have it; Node 26 and Bun's `Blob` shim do not), so a missing implementation is
 * reported as a failed check rather than trusted: the caller refuses the import
 * with a readable message instead of writing an empty dictionary.
 */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const transform = (globalThis as { DecompressionStream?: unknown })
    .DecompressionStream as
    | (new (format: string) => TransformStream<Uint8Array, Uint8Array>)
    | undefined;
  if (typeof transform !== 'function') {
    throw new Error(
      'This browser cannot decompress dictionary archives (DecompressionStream is unavailable).',
    );
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(new transform('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done === true) break;
    if (value !== undefined) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Read one file out of the archive without loading the whole archive. */
async function readEntryBytes(
  archive: Uint8Array,
  record: CentralRecord,
): Promise<Uint8Array> {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const offset = record.localHeaderOffset;
  if (offset + 30 > archive.byteLength) {
    throw new Error(
      `Dictionary archive is truncated at '${record.name}'.`,
    );
  }
  if (view.getUint32(offset, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(
      `Dictionary archive has no local header for '${record.name}'.`,
    );
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const raw = archive.subarray(dataStart, dataStart + record.compressedSize);
  if (raw.byteLength !== record.compressedSize) {
    throw new Error(
      `Dictionary archive is truncated at '${record.name}'.`,
    );
  }
  if (record.method === METHOD_STORED) return raw;
  if (record.method === METHOD_DEFLATE) return inflateRaw(raw);
  throw new Error(
    `Dictionary entry '${record.name}' uses unsupported compression method ${record.method}.`,
  );
}

/**
 * Parse the `0x0001` Zip64 extra field.
 *
 * Only the fields whose central-directory slot is the `0xFFFFFFFF` sentinel are
 * present, in the fixed order uncompressed → compressed → offset → disk, so the
 * values are consumed positionally.
 */
function readZip64Extra(
  view: DataView,
  extraStart: number,
  extraLength: number,
  needs: { size: boolean; compressedSize: boolean; offset: boolean },
): { size?: number; compressedSize?: number; offset?: number } {
  const result: { size?: number; compressedSize?: number; offset?: number } =
    {};
  let cursor = extraStart;
  const end = extraStart + extraLength;
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const length = view.getUint16(cursor + 2, true);
    const bodyStart = cursor + 4;
    let body = bodyStart;
    if (id === ZIP64_EXTRA_ID) {
      if (needs.size) {
        result.size = Number(view.getBigUint64(body, true));
        body += 8;
      }
      if (needs.compressedSize) {
        result.compressedSize = Number(view.getBigUint64(body, true));
        body += 8;
      }
      if (needs.offset) {
        result.offset = Number(view.getBigUint64(body, true));
      }
      return result;
    }
    cursor = bodyStart + length;
  }
  return result;
}

/** Parse the central directory into per-file records. */
function parseCentralDirectory(
  archive: Uint8Array,
  count: number,
  directoryOffset: number,
): CentralRecord[] {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const records: CentralRecord[] = [];
  let cursor = directoryOffset;

  for (let i = 0; i < count; ++i) {
    if (cursor + 46 > archive.byteLength) {
      throw new Error('Dictionary archive has a truncated central directory.');
    }
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error('Dictionary archive has a corrupt central directory.');
    }
    const method = view.getUint16(cursor + 10, true);
    let compressedSize = view.getUint32(cursor + 20, true);
    let size = view.getUint32(cursor + 24, true);
    let localHeaderOffset = view.getUint32(cursor + 42, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + 46;
    const name = utf8Decoder.decode(
      archive.subarray(nameStart, nameStart + nameLength),
    );

    const needs = {
      size: size === 0xffffffff,
      compressedSize: compressedSize === 0xffffffff,
      offset: localHeaderOffset === 0xffffffff,
    };
    if (needs.size || needs.compressedSize || needs.offset) {
      const zip64 = readZip64Extra(view, nameStart + nameLength, extraLength, needs);
      if (zip64.size !== undefined) size = zip64.size;
      if (zip64.compressedSize !== undefined) {
        compressedSize = zip64.compressedSize;
      }
      if (zip64.offset !== undefined) localHeaderOffset = zip64.offset;
    }

    // Directories (name ending in `/`) carry no data; skipping them keeps the
    // entry map to actual files.
    if (!name.endsWith('/')) {
      records.push({
        name,
        method,
        compressedSize,
        size,
        localHeaderOffset,
      });
    }

    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return records;
}

/**
 * Open a ZIP archive held entirely in memory.
 *
 * The whole file is read once (a `File` is slurped to an `ArrayBuffer`) because
 * a dictionary import reads every bank anyway; streaming would only move the
 * same bytes through more code.
 */
export async function readZipArchive(
  source: ArrayBuffer | Uint8Array,
): Promise<ZipArchive> {
  const archive =
    source instanceof Uint8Array ? source : new Uint8Array(source);
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );

  // EOCD is the last record; a comment may follow it (max 64 KiB - 1).
  let eocd = -1;
  const scanStart = Math.max(0, archive.byteLength - 0xffff - 22);
  for (let i = archive.byteLength - 22; i >= scanStart; --i) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('File is not a valid dictionary archive (no ZIP records).');
  }

  let count = view.getUint16(eocd + 10, true);
  let directorySize = view.getUint32(eocd + 12, true);
  let directoryOffset = view.getUint32(eocd + 16, true);

  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    // Zip64: the locator sits immediately before the EOCD and points at the
    // real record.
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new Error('Dictionary archive uses an unsupported Zip64 layout.');
    }
    const zip64Offset = Number(view.getBigUint64(locator + 8, true));
    if (view.getUint32(zip64Offset, true) !== ZIP64_EOCD_SIGNATURE) {
      throw new Error('Dictionary archive has a corrupt Zip64 directory.');
    }
    count = Number(view.getBigUint64(zip64Offset + 32, true));
    directorySize = Number(view.getBigUint64(zip64Offset + 40, true));
    directoryOffset = Number(view.getBigUint64(zip64Offset + 48, true));
  }

  const records = parseCentralDirectory(archive, count, directoryOffset);
  const entries = new Map<string, ZipEntry>();
  for (const record of records) {
    entries.set(record.name, {
      name: record.name,
      size: record.size,
      readText: async () => utf8Decoder.decode(await readEntryBytes(archive, record)),
      readBytes: () => readEntryBytes(archive, record),
    });
  }
  return { entries };
}