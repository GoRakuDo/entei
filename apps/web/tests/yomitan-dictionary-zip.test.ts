/**
 * Dictionary ZIP reader tests — the pure half of the import path.
 * ---------------------------------------------------------------------------
 * A ZIP is assembled here byte by byte (local header + central directory +
 * EOCD) so these tests need no fixture files and no unzip library:
 *
 * - a stored entry round-trips
 * - a raw-DEFLATE entry round-trips (the case every real dictionary uses)
 * - directory entries are skipped, names are UTF-8 decoded
 * - an archive that is not a ZIP is refused with a clear message
 */

import { describe, expect, it } from 'bun:test';
import { readZipArchive } from '@/features/yomitan/dictionary-zip';

const utf8 = new TextEncoder();

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD = 0x06054b54;

interface TestEntry {
  name: string;
  content: Uint8Array;
  /** `0` = stored, `8` = raw deflate. */
  method?: number;
  /** Skip the data entirely (a directory entry). */
  directory?: boolean;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const transform = (globalThis as { CompressionStream?: unknown })
    .CompressionStream as
    | (new (format: string) => TransformStream<Uint8Array, Uint8Array>)
    | undefined;
  if (typeof transform !== 'function') {
    throw new Error('CompressionStream is unavailable in this runtime.');
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
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

/** Build a ZIP archive from the given entries. */
async function buildZip(entries: readonly TestEntry[]): Promise<Uint8Array> {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8.encode(entry.name);
    const stored = entry.content;
    const method = entry.method ?? 0;
    const data =
      method === 8 && !entry.directory ? await deflateRaw(stored) : stored;

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, method, true);
    localView.setUint16(10, 0, true); // mod time
    localView.setUint16(12, 0, true); // mod date
    localView.setUint32(14, 0, true); // crc32 (unused here)
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, stored.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_HEADER, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0, true); // flags
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, 0, true); // crc32
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, stored.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true); // extra length
    centralView.setUint16(32, 0, true); // comment length
    centralView.setUint16(34, 0, true); // disk
    centralView.setUint16(36, 0, true); // internal attrs
    centralView.setUint32(38, 0, true); // external attrs
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const directory = concat(centralParts);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, directory.length, true);
  eocdView.setUint32(16, offset, true);
  eocdView.setUint16(20, 0, true);

  return concat([...localParts, directory, eocd]);
}

describe('readZipArchive', () => {
  it('reads a stored entry', async () => {
    const archive = await buildZip([
      { name: 'index.json', content: utf8.encode('{"title":"Test"}') },
    ]);
    const zip = await readZipArchive(archive);
    const entry = zip.entries.get('index.json');
    expect(entry).toBeDefined();
    expect(await entry?.readText()).toBe('{"title":"Test"}');
  });

  it('inflates a raw-DEFLATE entry (how real dictionaries compress)', async () => {
    const json = JSON.stringify([['走る', 'はしる', 'v1', 'v', 100, 'to run']]);
    const archive = await buildZip([
      { name: 'term_bank_1.json', content: utf8.encode(json), method: 8 },
    ]);
    const zip = await readZipArchive(archive);
    const entry = zip.entries.get('term_bank_1.json');
    expect(await entry?.readText()).toBe(json);
  });

  it('names the missing piece when the runtime cannot inflate', async () => {
    const archive = await buildZip([
      { name: 'term_bank_1.json', content: utf8.encode('[]'), method: 8 },
    ]);
    const zip = await readZipArchive(archive);
    const original = (globalThis as { DecompressionStream?: unknown })
      .DecompressionStream;
    Reflect.deleteProperty(globalThis, 'DecompressionStream');
    try {
      await expect(zip.entries.get('term_bank_1.json')?.readText()).rejects.toThrow(
        /DecompressionStream is unavailable/i,
      );
    } finally {
      (globalThis as { DecompressionStream?: unknown }).DecompressionStream =
        original;
    }
  });

  it('skips directory entries and decodes UTF-8 names', async () => {
    const archive = await buildZip([
      { name: '辞書/', content: new Uint8Array(0), directory: true },
      { name: '辞書/index.json', content: utf8.encode('{}') },
    ]);
    const zip = await readZipArchive(archive);
    expect([...zip.entries.keys()]).toEqual(['辞書/index.json']);
  });

  it('reports the size from the central directory', async () => {
    const archive = await buildZip([
      { name: 'index.json', content: utf8.encode('abc') },
    ]);
    const zip = await readZipArchive(archive);
    expect(zip.entries.get('index.json')?.size).toBe(3);
  });

  it('refuses a file that is not a ZIP archive', async () => {
    const notZip = utf8.encode('this is not an archive at all');
    await expect(readZipArchive(notZip)).rejects.toThrow(
      /not a valid dictionary archive/i,
    );
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', async () => {
    const archive = await buildZip([
      { name: 'index.json', content: utf8.encode('{"title":"Buffer"}') },
    ]);
    const zip = await readZipArchive(
      archive.buffer.slice(
        archive.byteOffset,
        archive.byteOffset + archive.byteLength,
      ) as ArrayBuffer,
    );
    expect(await zip.entries.get('index.json')?.readText()).toBe(
      '{"title":"Buffer"}',
    );
  });
});