/**
 * dictionary-store — Yomitan dictionary data, kept out of the user database.
 * ---------------------------------------------------------------------------
 * TWO STORAGES, ON PURPOSE:
 *
 * - `entei.db` (SQLite `kv_store`) holds USER data: watch history, settings,
 *   timeline. `yomitan:options` lives there, and `options.dictionaries` — the
 *   small metadata array (name / alias / enabled / …) — is written through
 *   `yomitan-preferences` exactly like every other setting.
 * - Dictionary DATA (hundreds of MB to >1 GB per dictionary: term banks, kanji
 *   banks, frequency/pitch meta, glossary media) lives HERE, in its own
 *   IndexedDB `yomitan-dictionaries`. It never enters `entei.db`, so GitHub
 *   backups and settings sync stay kilobytes-sized.
 *
 * The object stores mirror Yomitan's own `dict` database (v60 schema) one to
 * one — `terms`, `kanji`, `termMeta`, `kanjiMeta`, `tagMeta`, `media`,
 * `dictionaries` with the same indices — so Yomitan's `Translator` /
 * `DictionaryDatabase` can read what we import without a translation layer, and
 * any existing Yomitan dictionary zip imports unchanged.
 *
 * Import follows Yomitan's importer semantics: validate `index.json`, convert
 * every bank row (V1 and V3 layouts), extract glossary images into `media`
 * (dimensions measured with `createImageBitmap`), then write in 1000-row
 * transactions so a huge bank never builds one giant transaction.
 *
 * NOT in this slice (deliberate — the next wave's work): the lookup path that
 * consumes these stores. Import, enable/disable, delete and the settings
 * surface are complete; searching is not wired yet.
 * ---------------------------------------------------------------------------
 */

import { readZipArchive, type ZipArchive, type ZipEntry } from './dictionary-zip';
import { traceYomitan } from './yomitan-preferences';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Dedicated dictionary database — never the user database. */
export const DICTIONARY_DB_NAME = 'yomitan-dictionaries';

/** IndexedDB version of that database (not a dictionary format version). */
const DICTIONARY_DB_VERSION = 1;

const STORE_TERMS = 'terms';
const STORE_KANJI = 'kanji';
const STORE_TERM_META = 'termMeta';
const STORE_KANJI_META = 'kanjiMeta';
const STORE_TAG_META = 'tagMeta';
const STORE_MEDIA = 'media';
const STORE_DICTIONARIES = 'dictionaries';

/** Rows per IndexedDB transaction (same chunk size as Yomitan's importer). */
const BULK_CHUNK = 1000;

const INDEX_FILE_NAME = 'index.json';
const STYLES_FILE_NAME = 'styles.css';

const TERM_FILE = /^term_bank_(\d+)\.json$/;
const TERM_META_FILE = /^term_meta_bank_(\d+)\.json$/;
const KANJI_FILE = /^kanji_bank_(\d+)\.json$/;
const KANJI_META_FILE = /^kanji_meta_bank_(\d+)\.json$/;
const TAG_FILE = /^tag_bank_(\d+)\.json$/;

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------ */

/** One `options.dictionaries[]` entry (`DictionaryOptions` in the settings tree). */
export interface DictionaryOptionEntry {
  name: string;
  alias: string;
  enabled: boolean;
  allowSecondarySearches: boolean;
  definitionsCollapsible:
    | 'not-collapsible'
    | 'expanded'
    | 'collapsed'
    | 'force-collapsed'
    | 'force-expanded';
  partsOfSpeechFilter: boolean;
  useDeinflections: boolean;
}

/**
 * One bank's imported row counts.
 *
 * `total` is every row; the remaining keys are per-`mode` sub-counts for the
 * meta banks (`freq`, `pitch`, `ipa`), matching Yomitan's summary shape.
 */
export interface BankCount {
  total: number;
  [mode: string]: number | BankCount;
}

/** Per-bank row counts of one imported dictionary. */
export interface DictionaryCounts {
  terms: BankCount;
  termMeta: BankCount;
  kanji: BankCount;
  kanjiMeta: BankCount;
  tagMeta: BankCount;
  media: BankCount;
}

/** A row of the `dictionaries` store — Yomitan's `Summary` shape. */
export interface DictionaryRecord {
  id?: number;
  title: string;
  revision: string;
  sequenced: boolean;
  version: number;
  importDate: number;
  prefixWildcardsSupported: boolean;
  counts: DictionaryCounts;
  styles: string;
  importSuccess: boolean;
  author?: string;
  url?: string;
  description?: string;
  attribution?: string;
  frequencyMode?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}

/** What the settings UI needs to draw one installed dictionary. */
export interface InstalledDictionary {
  /** Dictionary title — the identity `options.dictionaries[].name` refers to. */
  name: string;
  /** Dictionary revision (`index.json`'s `revision`). */
  version: string;
  author?: string;
  /** Total imported rows across every bank. */
  entries: number;
  /** ISO date the import finished. */
  importedAt: string;
}

/** Import progress: which phase, and how far through it. */
export interface ImportProgress {
  /** Phase id (`reading`, `terms`, `kanji`, `done`, …). */
  step: string;
  done: number;
  total: number;
}

export type ImportProgressCallback = (progress: ImportProgress) => void;

/* ---------------------------------------------------------------------------
 * IndexedDB open / upgrade
 * ------------------------------------------------------------------------ */

function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/**
 * Open (and on first run create) the dictionary database.
 *
 * Returns null when IndexedDB is unavailable (SSR, locked-down private mode, a
 * test runner without a browser), so callers report "no dictionaries" instead
 * of throwing.
 */
export function openDictionaryDB(): Promise<IDBDatabase | null> {
  if (!isIndexedDBAvailable()) return Promise.resolve(null);
  if (dbPromise !== null) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(
        DICTIONARY_DB_NAME,
        DICTIONARY_DB_VERSION,
      );
      request.onupgradeneeded = () => {
        const db = request.result;

        // Term rows: keyed by an auto id, looked up by expression/reading. The
        // `*Reverse` indices hold reversed strings so an ends-with search is a
        // range scan too.
        if (!db.objectStoreNames.contains(STORE_TERMS)) {
          const store = db.createObjectStore(STORE_TERMS, {
            keyPath: 'id',
            autoIncrement: true,
          });
          store.createIndex('dictionary', 'dictionary', { unique: false });
          store.createIndex('expression', 'expression', { unique: false });
          store.createIndex('reading', 'reading', { unique: false });
          store.createIndex('sequence', 'sequence', { unique: false });
          store.createIndex('expressionReverse', 'expressionReverse', {
            unique: false,
          });
          store.createIndex('readingReverse', 'readingReverse', {
            unique: false,
          });
        }

        if (!db.objectStoreNames.contains(STORE_KANJI)) {
          const store = db.createObjectStore(STORE_KANJI, {
            autoIncrement: true,
          });
          store.createIndex('dictionary', 'dictionary', { unique: false });
          store.createIndex('character', 'character', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_TERM_META)) {
          const store = db.createObjectStore(STORE_TERM_META, {
            autoIncrement: true,
          });
          store.createIndex('dictionary', 'dictionary', { unique: false });
          store.createIndex('expression', 'expression', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_KANJI_META)) {
          const store = db.createObjectStore(STORE_KANJI_META, {
            autoIncrement: true,
          });
          store.createIndex('dictionary', 'dictionary', { unique: false });
          store.createIndex('character', 'character', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_TAG_META)) {
          const store = db.createObjectStore(STORE_TAG_META, {
            autoIncrement: true,
          });
          store.createIndex('dictionary', 'dictionary', { unique: false });
          store.createIndex('name', 'name', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_MEDIA)) {
          const store = db.createObjectStore(STORE_MEDIA, {
            keyPath: 'id',
            autoIncrement: true,
          });
          store.createIndex('dictionary', 'dictionary', { unique: false });
          store.createIndex('path', 'path', { unique: false });
        }

        // One summary row per dictionary; `title` is the identity used
        // everywhere else in the schema.
        if (!db.objectStoreNames.contains(STORE_DICTIONARIES)) {
          const store = db.createObjectStore(STORE_DICTIONARIES, {
            keyPath: 'id',
            autoIncrement: true,
          });
          store.createIndex('title', 'title', { unique: false });
          store.createIndex('version', 'version', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        traceYomitan('dictionary_db_open_failed', { error: request.error });
        resolve(null);
      };
      request.onblocked = () => resolve(null);
    } catch (error) {
      traceYomitan('dictionary_db_open_failed', { error });
      resolve(null);
    }
  });
  return dbPromise;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<T>).then === 'function'
  );
}

/**
 * Run `work` inside one read-write transaction and resolve only once that
 * transaction has COMMITTED, so a caller that reads back after the await sees
 * its own writes.
 */
function runTransaction<T>(
  db: IDBDatabase,
  stores: readonly string[],
  work: (transaction: IDBTransaction) => T | PromiseLike<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T;
    let hasResult = false;
    let completed = false;
    let failed = false;

    const settle = () => {
      if (failed || !completed || !hasResult) return;
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (failed || completed) return;
      failed = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(stores, 'readwrite');
    } catch (error) {
      fail(error);
      return;
    }
    transaction.oncomplete = () => {
      completed = true;
      settle();
    };
    transaction.onerror = () =>
      fail(transaction.error ?? new Error('IndexedDB write failed.'));
    transaction.onabort = () =>
      fail(transaction.error ?? new Error('IndexedDB transaction aborted.'));

    try {
      const returned = work(transaction);
      if (isPromiseLike<T>(returned)) {
        returned.then(
          (value) => {
            result = value;
            hasResult = true;
            settle();
          },
          fail,
        );
      } else {
        result = returned;
        hasResult = true;
        settle();
      }
    } catch (error) {
      fail(error);
    }
  });
}

/** Wrap an IDB request in a promise resolving to its result. */
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

/**
 * Write `rows` in chunks.
 *
 * One transaction over a 200k-row bank risks the whole import; chunking keeps
 * each transaction short and lets progress move.
 */
async function bulkAdd(
  db: IDBDatabase,
  storeName: string,
  rows: readonly unknown[],
  onChunk?: () => void,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BULK_CHUNK) {
    const chunk = rows.slice(i, i + BULK_CHUNK);
    await runTransaction(db, [storeName], (transaction) => {
      const store = transaction.objectStore(storeName);
      for (const row of chunk) store.add(row);
      return undefined;
    });
    onChunk?.();
  }
}

/* ---------------------------------------------------------------------------
 * index.json
 * ------------------------------------------------------------------------ */

/** Minimal `index.json` shape we depend on. */
export interface DictionaryIndex {
  title: string;
  revision: string;
  /** Dictionary data format: 1 (legacy) or 3 (current). */
  version: number;
  sequenced: boolean;
  author?: string;
  url?: string;
  description?: string;
  attribution?: string;
  frequencyMode?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  /** Format-1 dictionaries declare tag metadata inline. */
  tagMeta?: Record<
    string,
    { category: string; order: number; notes: string; score: number }
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate and normalize `index.json`.
 *
 * Failures name the missing field, so an import error points at the archive
 * problem instead of failing later inside a bank file.
 */
export function parseDictionaryIndex(content: string): DictionaryIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid ${INDEX_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid ${INDEX_FILE_NAME}: expected an object.`);
  }
  const { title, revision, version } = parsed;
  if (typeof title !== 'string' || title === '') {
    throw new Error(`Invalid ${INDEX_FILE_NAME}: missing 'title'.`);
  }
  if (typeof revision !== 'string') {
    throw new Error(`Invalid ${INDEX_FILE_NAME}: missing 'revision'.`);
  }
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    throw new Error(`Invalid ${INDEX_FILE_NAME}: missing 'version'.`);
  }
  if (version !== 1 && version !== 3) {
    throw new Error(`Dictionary format ${version} is not supported.`);
  }

  return {
    title,
    revision,
    version,
    sequenced: parsed.sequenced === true,
    author: typeof parsed.author === 'string' ? parsed.author : undefined,
    url: typeof parsed.url === 'string' ? parsed.url : undefined,
    description:
      typeof parsed.description === 'string' ? parsed.description : undefined,
    attribution:
      typeof parsed.attribution === 'string' ? parsed.attribution : undefined,
    frequencyMode:
      typeof parsed.frequencyMode === 'string' ? parsed.frequencyMode : undefined,
    sourceLanguage:
      typeof parsed.sourceLanguage === 'string' ? parsed.sourceLanguage : undefined,
    targetLanguage:
      typeof parsed.targetLanguage === 'string' ? parsed.targetLanguage : undefined,
    tagMeta: isRecord(parsed.tagMeta)
      ? (parsed.tagMeta as DictionaryIndex['tagMeta'])
      : undefined,
  };
}

/* ---------------------------------------------------------------------------
 * Pure conversions (bank rows → database rows)
 * ------------------------------------------------------------------------ */

/** Reverse a string (suffix-search index), matching Yomitan's `stringReverse`. */
function stringReverse(text: string): string {
  let result = '';
  for (let i = text.length - 1; i >= 0; --i) result += text[i];
  return result;
}

/** Glossary node before media resolution (`unknown` = Yomitan's opaque node). */
export type TermGlossary = unknown;

/** A term row as stored in `terms`. */
export interface DatabaseTermEntry {
  expression: string;
  reading: string;
  definitionTags: string[];
  rules: string[];
  score: number;
  glossary: TermGlossary[];
  sequence: number;
  termTags: string[];
  dictionary: string;
  expressionReverse: string;
  readingReverse: string;
}

function splitTags(value: unknown): string[] {
  return typeof value === 'string' && value !== '' ? value.split(' ') : [];
}

/**
 * Convert one `term_bank_*.json` row.
 *
 * Format 3 rows are `[expression, reading, definitionTags, rules, score,
 * glossary, sequence, termTags]`; format 1 rows drop the last two (and spread
 * the remaining entries as the glossary list).
 */
export function convertTermBankEntry(
  entry: readonly unknown[],
  dictionary: string,
  version: number,
): DatabaseTermEntry {
  const expression = String(entry[0] ?? '');
  const rawReading = String(entry[1] ?? '');
  // An empty reading means "same as the expression" in both formats.
  const reading = rawReading.length > 0 ? rawReading : expression;

  if (version === 1) {
    return {
      expression,
      reading,
      definitionTags: splitTags(entry[2]),
      rules: splitTags(entry[3]),
      score: Number(entry[4] ?? 0),
      glossary: entry.slice(5),
      sequence: -1,
      termTags: [],
      dictionary,
      expressionReverse: stringReverse(expression),
      readingReverse: stringReverse(reading),
    };
  }

  return {
    expression,
    reading,
    definitionTags: splitTags(entry[2]),
    rules: splitTags(entry[3]),
    score: Number(entry[4] ?? 0),
    glossary: Array.isArray(entry[5]) ? (entry[5] as TermGlossary[]) : [],
    sequence: Number(entry[6] ?? -1),
    termTags: splitTags(entry[7]),
    dictionary,
    expressionReverse: stringReverse(expression),
    readingReverse: stringReverse(reading),
  };
}

export interface DatabaseKanjiEntry {
  character: string;
  onyomi: string[];
  kunyomi: string[];
  tags: string[];
  meanings: string[];
  stats?: Record<string, unknown>;
  dictionary: string;
}

/** Convert one `kanji_bank_*.json` row (format 3 adds `stats`). */
export function convertKanjiBankEntry(
  entry: readonly unknown[],
  dictionary: string,
  version: number,
): DatabaseKanjiEntry {
  const character = String(entry[0] ?? '');
  const onyomi = Array.isArray(entry[1]) ? (entry[1] as string[]) : [];
  const kunyomi = Array.isArray(entry[2]) ? (entry[2] as string[]) : [];
  const tags = Array.isArray(entry[3]) ? (entry[3] as string[]) : [];
  const meanings = Array.isArray(entry[4]) ? (entry[4] as string[]) : [];
  if (version === 1) {
    return { character, onyomi, kunyomi, tags, meanings, dictionary };
  }
  const stats = isRecord(entry[5]) ? entry[5] : undefined;
  return { character, onyomi, kunyomi, tags, meanings, stats, dictionary };
}

export interface DatabaseTermMeta {
  expression: string;
  mode: string;
  data: unknown;
  dictionary: string;
}

/** Convert one `term_meta_bank_*.json` row: `[expression, mode, data]`. */
export function convertTermMetaBankEntry(
  entry: readonly unknown[],
  dictionary: string,
): DatabaseTermMeta {
  return {
    expression: String(entry[0] ?? ''),
    mode: String(entry[1] ?? ''),
    data: entry[2],
    dictionary,
  };
}

export interface DatabaseKanjiMeta {
  character: string;
  mode: string;
  data: unknown;
  dictionary: string;
}

/** Convert one `kanji_meta_bank_*.json` row: `[character, mode, data]`. */
export function convertKanjiMetaBankEntry(
  entry: readonly unknown[],
  dictionary: string,
): DatabaseKanjiMeta {
  return {
    character: String(entry[0] ?? ''),
    mode: String(entry[1] ?? ''),
    data: entry[2],
    dictionary,
  };
}

export interface DatabaseTag {
  name: string;
  category: string;
  order: number;
  notes: string;
  score: number;
  dictionary: string;
}

/** Convert one `tag_bank_*.json` row: `[name, category, order, notes, score]`. */
export function convertTagBankEntry(
  entry: readonly unknown[],
  dictionary: string,
): DatabaseTag {
  return {
    name: String(entry[0] ?? ''),
    category: String(entry[1] ?? ''),
    order: Number(entry[2] ?? 0),
    notes: String(entry[3] ?? ''),
    score: Number(entry[4] ?? 0),
    dictionary,
  };
}

/* ---------------------------------------------------------------------------
 * Glossary media
 * ------------------------------------------------------------------------ */

/** Image media type from a file path (Yomitan's `media-util` mapping). */
export function getImageMediaTypeFromFileName(path: string): string | null {
  const match = /\.[^./\\]*$/.exec(path);
  switch ((match === null ? '' : match[0]).toLowerCase()) {
    case '.apng':
      return 'image/apng';
    case '.avif':
      return 'image/avif';
    case '.bmp':
      return 'image/bmp';
    case '.gif':
      return 'image/gif';
    case '.ico':
    case '.cur':
      return 'image/x-icon';
    case '.jpg':
    case '.jpeg':
    case '.jfif':
    case '.pjpeg':
    case '.pjp':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

/** A glossary image node, once its archive file has been resolved. */
export type GlossaryImageTarget = {
  type?: string;
  tag?: string;
  /** Loose bag: which of Yomitan's presentation fields this node carries. */
  [key: string]: unknown;
};
interface MediaRow {
  dictionary: string;
  path: string;
  mediaType: string;
  width: number;
  height: number;
  content: ArrayBuffer;
}

/** An image the glossary referenced and the archive has to provide. */
interface ImageRequirement {
  target: GlossaryImageTarget;
  source: Record<string, unknown>;
}

/** Presentation fields copied from the source image node to the stored one. */
const IMAGE_PASSTHROUGH_KEYS = [
  'verticalAlign',
  'border',
  'borderRadius',
  'sizeUnits',
  'width',
  'height',
  'title',
  'alt',
  'description',
  'pixelated',
  'imageRendering',
  'appearance',
  'background',
  'collapsed',
  'collapsible',
] as const;

/**
 * Measure an image with the browser's own decoder.
 *
 * Falls back to `0 × 0` when `createImageBitmap` is missing or refuses the
 * type: the image still renders (CSS sizes it), it just carries no intrinsic
 * size hint. One undecodable SVG must not fail a whole import.
 */
async function measureImage(
  content: ArrayBuffer,
  mediaType: string,
): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap !== 'function') return { width: 0, height: 0 };
  if (mediaType === 'image/svg+xml' || mediaType === 'image/x-icon') {
    return { width: 0, height: 0 };
  }
  try {
    const bitmap = await createImageBitmap(new Blob([content], { type: mediaType }));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * Turn a glossary node into its stored form, collecting image requirements.
 *
 * Mirrors Yomitan's `_formatDictionaryTermGlossaryObject`: `text` collapses to
 * a plain string, `image` / `img` become a target the archive pass fills with
 * `path` + measured dimensions, and structured content is walked recursively.
 */
export function formatGlossaryNode(
  data: unknown,
  requirements: ImageRequirement[],
): TermGlossary {
  if (!isRecord(data)) return data;
  switch (data.type) {
    case 'text':
      return data.text;
    case 'image': {
      const target: GlossaryImageTarget = { type: 'image', path: '' };
      requirements.push({ target, source: data });
      return target;
    }
    case 'structured-content':
      return {
        type: 'structured-content',
        content: prepareStructuredContent(data.content, requirements),
      };
    default:
      // An unknown node type is kept verbatim rather than failing an import
      // over a glossary flavour this host does not render yet.
      return data;
  }
}

function prepareStructuredContent(
  content: unknown,
  requirements: ImageRequirement[],
): unknown {
  if (Array.isArray(content)) {
    return content.map((child) => prepareStructuredContent(child, requirements));
  }
  if (!isRecord(content)) return content;
  if (content.tag === 'img') {
    const target: GlossaryImageTarget = { tag: 'img', path: '' };
    requirements.push({ target, source: content });
    return target;
  }
  if ('content' in content) {
    return {
      ...content,
      content: prepareStructuredContent(content.content, requirements),
    };
  }
  return content;
}

/** Shared state for one bank file's image resolution pass. */
interface ImageContext {
  archive: ZipArchive;
  mediaByPath: Map<string, MediaRow>;
  dictionary: string;
  errors: Error[];
}

/** Point one image target at its archive file and measure it. */
async function resolveImageRequirement(
  context: ImageContext,
  requirement: ImageRequirement,
): Promise<void> {
  const { target, source } = requirement;
  for (const key of IMAGE_PASSTHROUGH_KEYS) {
    const value = source[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      target[key] = value;
    }
  }

  const path = typeof source.path === 'string' ? source.path : '';
  const mediaType = getImageMediaTypeFromFileName(path);
  if (mediaType === null) {
    context.errors.push(
      new Error(`Could not determine media type for image at ${JSON.stringify(path)}.`),
    );
    return;
  }
  const entry = context.archive.entries.get(path);
  if (entry === undefined) {
    context.errors.push(
      new Error(`Could not find image at ${JSON.stringify(path)}.`),
    );
    return;
  }
  target.path = path;

  let row = context.mediaByPath.get(path);
  if (row === undefined) {
    const bytes = await entry.readBytes();
    const content = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const size = await measureImage(content, mediaType);
    row = {
      dictionary: context.dictionary,
      path,
      mediaType,
      width: size.width,
      height: size.height,
      content,
    };
    context.mediaByPath.set(path, row);
  }
  if (typeof target.width !== 'number') target.width = row.width;
  if (typeof target.height !== 'number') target.height = row.height;
}

/* ---------------------------------------------------------------------------
 * options.dictionaries helpers (pure)
 * ------------------------------------------------------------------------ */

/** A fresh enabled entry for `options.dictionaries[]`. */
export function createDictionaryOptionEntry(name: string): DictionaryOptionEntry {
  return {
    name,
    alias: '',
    enabled: true,
    allowSecondarySearches: false,
    definitionsCollapsible: 'not-collapsible',
    partsOfSpeechFilter: true,
    useDeinflections: true,
  };
}

/**
 * Enable/disable one dictionary by name, leaving every other entry untouched.
 *
 * The list is part of the persisted settings tree, so it is written through the
 * normal options path (localStorage + SQLite mirror) — never into the
 * dictionary database.
 */
export function setDictionaryEnabled(
  list: readonly DictionaryOptionEntry[],
  name: string,
  enabled: boolean,
): DictionaryOptionEntry[] {
  let found = false;
  const next = list.map((entry) => {
    if (entry.name !== name) return entry;
    found = true;
    return { ...entry, enabled };
  });
  if (!found) next.push({ ...createDictionaryOptionEntry(name), enabled });
  return next;
}

/** Drop one dictionary from `options.dictionaries[]`. */
export function removeDictionaryOption(
  list: readonly DictionaryOptionEntry[],
  name: string,
): DictionaryOptionEntry[] {
  return list.filter((entry) => entry.name !== name);
}

/**
 * Rebuild `options.dictionaries[]` in the order the list shows.
 *
 * The array IS the dictionary priority order (Yomitan reads it top-down when
 * merging results), so reordering rows is a real setting write, not a view
 * state. `names` is the full displayed order: a name with no entry yet (an
 * import interrupted before the settings write) gets a fresh DISABLED one, so
 * the order the user arranged is exactly what persists. Names absent from
 * `names` keep their entry at the end rather than being dropped.
 */
export function orderDictionaryOptions(
  list: readonly DictionaryOptionEntry[],
  names: readonly string[],
): DictionaryOptionEntry[] {
  const byName = new Map(list.map((entry) => [entry.name, entry]));
  const ordered: DictionaryOptionEntry[] = [];
  for (const name of names) {
    const existing = byName.get(name);
    if (existing === undefined) {
      ordered.push({ ...createDictionaryOptionEntry(name), enabled: false });
      continue;
    }
    byName.delete(name);
    ordered.push(existing);
  }
  for (const entry of byName.values()) ordered.push(entry);
  return ordered;
}

/* ---------------------------------------------------------------------------
 * Import
 * ------------------------------------------------------------------------ */

/** Every bank file matching `pattern`, ordered by its numeric index. */
function collectBankFiles(archive: ZipArchive, pattern: RegExp): ZipEntry[] {
  const matches: { index: number; entry: ZipEntry }[] = [];
  for (const entry of archive.entries.values()) {
    const match = pattern.exec(entry.name);
    const index = match?.[1];
    if (index === undefined) continue;
    matches.push({ index: Number(index), entry });
  }
  matches.sort((a, b) => a.index - b.index);
  return matches.map((item) => item.entry);
}

/** Parse a bank file's JSON array (a non-array is treated as an empty bank). */
async function readBank(entry: ZipEntry): Promise<unknown[]> {
  const parsed = JSON.parse(await entry.readText()) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

/** Locate `index.json`, which must sit at the archive root. */
function findIndexEntry(archive: ZipArchive): ZipEntry {
  const direct = archive.entries.get(INDEX_FILE_NAME);
  if (direct !== undefined) return direct;
  for (const entry of archive.entries.values()) {
    if (entry.name.replace(/.*\//, '') === INDEX_FILE_NAME) {
      const directory = entry.name.replace(/[^/]*$/, '');
      throw new Error(
        `Dictionary index found nested in redundant directories: "${directory}" when it must be in the archive's root directory`,
      );
    }
  }
  throw new Error('No dictionary index found in archive');
}

function createSummary(
  index: DictionaryIndex,
  counts: DictionaryCounts,
  styles: string,
  importSuccess: boolean,
): DictionaryRecord {
  const summary: DictionaryRecord = {
    title: index.title,
    revision: index.revision,
    sequenced: index.sequenced,
    version: index.version,
    importDate: Date.now(),
    prefixWildcardsSupported: true,
    counts,
    styles,
    importSuccess,
  };
  if (index.author !== undefined) summary.author = index.author;
  if (index.url !== undefined) summary.url = index.url;
  if (index.description !== undefined) summary.description = index.description;
  if (index.attribution !== undefined) summary.attribution = index.attribution;
  if (index.frequencyMode !== undefined) summary.frequencyMode = index.frequencyMode;
  if (index.sourceLanguage !== undefined) summary.sourceLanguage = index.sourceLanguage;
  if (index.targetLanguage !== undefined) summary.targetLanguage = index.targetLanguage;
  return summary;
}

function emptyCounts(): DictionaryCounts {
  return {
    terms: { total: 0 },
    termMeta: { total: 0 },
    kanji: { total: 0 },
    kanjiMeta: { total: 0 },
    tagMeta: { total: 0 },
    media: { total: 0 },
  };
}

/** Add one row to a meta bank's total and to its per-mode sub-count. */
function countMetaRow(bank: BankCount, mode: string): void {
  bank.total += 1;
  const bucket = bank[mode];
  if (bucket === undefined) {
    bank[mode] = { total: 1 };
    return;
  }
  if (typeof bucket === 'number') {
    bank[mode] = bucket + 1;
    return;
  }
  bucket.total += 1;
}

export interface ImportOptions {
  onProgress?: ImportProgressCallback;
  /** Replace an already-imported dictionary of the same title. */
  overwrite?: boolean;
}

/**
 * Import one Yomitan dictionary archive into `yomitan-dictionaries`.
 *
 * Returns the stored summary row. Writing the `options.dictionaries` entry is
 * the CALLER's job (the settings UI goes through `yomitan-preferences`), which
 * keeps this module free of settings knowledge.
 */
export async function importDictionaryArchive(
  source: ArrayBuffer | Uint8Array,
  options: ImportOptions = {},
): Promise<DictionaryRecord> {
  const db = await openDictionaryDB();
  if (db === null) {
    throw new Error('Dictionary storage is unavailable in this browser.');
  }

  const report = options.onProgress ?? (() => {});
  report({ step: 'reading', done: 0, total: 1 });

  const archive = await readZipArchive(source);
  const indexEntry = findIndexEntry(archive);
  const index = parseDictionaryIndex(await indexEntry.readText());
  const dictionary = index.title;

  const existing = await getDictionaryRecord(dictionary);
  if (existing !== null) {
    if (options.overwrite !== true) {
      throw new Error(`Dictionary ${dictionary} is already imported, skipped it.`);
    }
    await deleteDictionary(dictionary);
  }

  const counts = emptyCounts();
  const errors: Error[] = [];
  const termFiles = collectBankFiles(archive, TERM_FILE);
  const termMetaFiles = collectBankFiles(archive, TERM_META_FILE);
  const kanjiFiles = collectBankFiles(archive, KANJI_FILE);
  const kanjiMetaFiles = collectBankFiles(archive, KANJI_META_FILE);
  const tagFiles = collectBankFiles(archive, TAG_FILE);

  // The summary row goes in first, so an interrupted import shows up as a
  // half-imported dictionary instead of silently not existing.
  const summaryKey = await runTransaction(db, [STORE_DICTIONARIES], (transaction) =>
    requestResult(
      transaction.objectStore(STORE_DICTIONARIES).add(
        createSummary(index, counts, '', false),
      ),
    ),
  );

  let importSuccess = false;
  const totalBanks =
    termFiles.length +
    termMetaFiles.length +
    kanjiFiles.length +
    kanjiMetaFiles.length +
    tagFiles.length;
  let banksDone = 0;

  try {
    for (const file of termFiles) {
      const rows = await readBank(file);
      const mediaByPath = new Map<string, MediaRow>();
      const terms: DatabaseTermEntry[] = [];
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const entry = convertTermBankEntry(row, dictionary, index.version);
        const requirements: ImageRequirement[] = [];
        entry.glossary = entry.glossary.map((node) =>
          formatGlossaryNode(node, requirements),
        );
        if (requirements.length > 0) {
          const context: ImageContext = {
            archive,
            mediaByPath,
            dictionary,
            errors,
          };
          await Promise.all(
            requirements.map((requirement) =>
              resolveImageRequirement(context, requirement),
            ),
          );
        }
        terms.push(entry);
      }

      if (mediaByPath.size > 0) {
        const media = [...mediaByPath.values()];
        await bulkAdd(db, STORE_MEDIA, media);
        counts.media.total += media.length;
      }
      await bulkAdd(db, STORE_TERMS, terms);
      counts.terms.total += terms.length;
      banksDone += 1;
      report({ step: 'terms', done: banksDone, total: totalBanks });
    }

    for (const file of termMetaFiles) {
      const rows = await readBank(file);
      const metas: DatabaseTermMeta[] = [];
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const meta = convertTermMetaBankEntry(row, dictionary);
        countMetaRow(counts.termMeta, meta.mode);
        metas.push(meta);
      }
      await bulkAdd(db, STORE_TERM_META, metas);
      banksDone += 1;
      report({ step: 'termMeta', done: banksDone, total: totalBanks });
    }

    for (const file of kanjiFiles) {
      const rows = await readBank(file);
      const kanji: DatabaseKanjiEntry[] = [];
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        kanji.push(convertKanjiBankEntry(row, dictionary, index.version));
      }
      await bulkAdd(db, STORE_KANJI, kanji);
      counts.kanji.total += kanji.length;
      banksDone += 1;
      report({ step: 'kanji', done: banksDone, total: totalBanks });
    }

    for (const file of kanjiMetaFiles) {
      const rows = await readBank(file);
      const metas: DatabaseKanjiMeta[] = [];
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const meta = convertKanjiMetaBankEntry(row, dictionary);
        countMetaRow(counts.kanjiMeta, meta.mode);
        metas.push(meta);
      }
      await bulkAdd(db, STORE_KANJI_META, metas);
      banksDone += 1;
      report({ step: 'kanjiMeta', done: banksDone, total: totalBanks });
    }

    const tags: DatabaseTag[] = [];
    for (const file of tagFiles) {
      const rows = await readBank(file);
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        tags.push(convertTagBankEntry(row, dictionary));
      }
      banksDone += 1;
      report({ step: 'tagMeta', done: banksDone, total: totalBanks });
    }
    // Format-1 dictionaries declare their tags inside index.json instead.
    if (index.tagMeta !== undefined) {
      for (const [name, value] of Object.entries(index.tagMeta)) {
        tags.push({ name, ...value, dictionary });
      }
    }
    if (tags.length > 0) {
      await bulkAdd(db, STORE_TAG_META, tags);
      counts.tagMeta.total += tags.length;
    }

    importSuccess = true;
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }

  const stylesEntry = archive.entries.get(STYLES_FILE_NAME);
  const styles = stylesEntry === undefined ? '' : await stylesEntry.readText();

  await runTransaction(db, [STORE_DICTIONARIES], (transaction) => {
    transaction
      .objectStore(STORE_DICTIONARIES)
      .put({ ...createSummary(index, counts, styles, importSuccess), id: summaryKey });
    return undefined;
  });
  report({ step: 'done', done: 1, total: 1 });

  traceYomitan('dictionary_imported', {
    dictionary,
    terms: counts.terms.total,
    kanji: counts.kanji.total,
    media: counts.media.total,
    importSuccess,
  });

  if (!importSuccess) {
    const reason = errors[0]?.message ?? 'Unknown import error.';
    throw new Error(`Could not import ${dictionary}: ${reason}`);
  }
  if (errors.length > 0) {
    // Non-fatal (one glossary image missing, say): the import stands, and the
    // first reason is in the trace journal for later diagnosis.
    traceYomitan('dictionary_import_warnings', {
      dictionary,
      error: errors[0]?.message,
    });
  }

  const record = await getDictionaryRecord(dictionary);
  if (record === null) {
    throw new Error(`Could not import ${dictionary}: summary row is missing.`);
  }
  return record;
}

/* ---------------------------------------------------------------------------
 * Read / delete
 * ------------------------------------------------------------------------ */

/** The stored summary row for one dictionary title (null when absent). */
export async function getDictionaryRecord(
  title: string,
): Promise<DictionaryRecord | null> {
  const db = await openDictionaryDB();
  if (db === null) return null;
  const row = await runTransaction(db, [STORE_DICTIONARIES], (transaction) =>
    requestResult(
      transaction.objectStore(STORE_DICTIONARIES).index('title').get(title),
    ),
  );
  return (row as DictionaryRecord | undefined) ?? null;
}

/** Every imported dictionary's metadata, newest import first. */
export async function listInstalledDictionaries(): Promise<InstalledDictionary[]> {
  const db = await openDictionaryDB();
  if (db === null) return [];
  const rows = await runTransaction(db, [STORE_DICTIONARIES], (transaction) =>
    requestResult(transaction.objectStore(STORE_DICTIONARIES).getAll()),
  );
  return (rows as DictionaryRecord[])
    .filter((row) => row.importSuccess !== false)
    .sort((a, b) => b.importDate - a.importDate)
    .map((record) => ({
      name: record.title,
      version: record.revision,
      author: record.author,
      entries:
        record.counts.terms.total +
        record.counts.kanji.total +
        record.counts.termMeta.total +
        record.counts.kanjiMeta.total,
      importedAt:
        typeof record.importDate === 'number'
          ? new Date(record.importDate).toISOString()
          : '',
    }));
}

/**
 * Delete one dictionary: every row it owns, then its summary.
 *
 * Rows are removed through each store's `dictionary` index, so deletion scales
 * with that dictionary and never touches another one.
 */
export async function deleteDictionary(title: string): Promise<void> {
  const db = await openDictionaryDB();
  if (db === null) return;

  for (const storeName of [
    STORE_TERMS,
    STORE_KANJI,
    STORE_TERM_META,
    STORE_KANJI_META,
    STORE_TAG_META,
    STORE_MEDIA,
  ]) {
    await runTransaction(db, [storeName], async (transaction) => {
      const store = transaction.objectStore(storeName);
      const keys = await requestResult(
        store.index('dictionary').getAllKeys(IDBKeyRange.only(title)),
      );
      for (const key of keys) store.delete(key);
      return undefined;
    });
  }

  await runTransaction(db, [STORE_DICTIONARIES], async (transaction) => {
    const store = transaction.objectStore(STORE_DICTIONARIES);
    const keys = await requestResult(
      store.index('title').getAllKeys(IDBKeyRange.only(title)),
    );
    for (const key of keys) store.delete(key);
    return undefined;
  });

  traceYomitan('dictionary_deleted', { dictionary: title });
}