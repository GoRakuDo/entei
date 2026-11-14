/**
 * yomitan-engine — the host's dictionary lookup pipeline.
 * ---------------------------------------------------------------------------
 * Three layers, each with one job:
 *
 * 1. `DictionaryDatabase`: the read contract Yomitan's `Translator` drives. Its
 *    bulk methods are a thin reshape of the Rust plugin's bulk IPC
 *    (`plugins/tauri-plugin-modules/src/yomitan.rs`) — the SQLite banks stay in
 *    Rust, and nothing here caches dictionary DATA.
 *
 * 2. Option plumbing: the `Translator` is only half a lookup. It also needs the
 *    profile's dictionary set, its scan resolution, its text replacements — the
 *    same object Yomitan's own backend builds (`_getTranslatorFindTermsOptions`).
 *    `yomitan-headless`'s API server does this in `src/server/index.ts`; this is
 *    that plumbing against the PERSISTED options instead of a request body.
 *
 * 3. Summaries: what the rest of the app may read. A `Translator` entry is a
 *    deep, Yomitan-internal shape (headwords, sources, definition groups, tag
 *    groups, frequencies). Rather than leak that across the feature boundary,
 *    `summarizeTermEntry` / `summarizeKanjiEntry` flatten one entry to the few
 *    fields a popup or a trace line shows.
 *
 * What is deliberately NOT here: rendering. The scan pipeline emits
 * `yomitan:scan-result` (see `features/yomitan/text-scanner.ts`) and the UI that
 * draws it is a later step.
 * ---------------------------------------------------------------------------
 */

import type {
  DictionaryDatabase,
  DictionarySet,
  DictionarySummary,
  KanjiEntry,
  KanjiMeta,
  MatchType,
  Tag,
  TermEntry,
  TermExactRequest,
  TermGlossary,
  TermMeta,
} from '@gorakudo/yomitan-headless';
import { createTranslator } from '@gorakudo/yomitan-headless';
import type { Options, ProfileOptions } from '@gorakudo/yomitan-headless/settings';
import {
  invalidateInstalledDictionaries,
  listInstalledDictionariesCached,
  type InstalledDictionary,
} from '@/features/yomitan/dictionary-store';
import { readYomitanOptions } from '@/features/yomitan/yomitan-preferences';
import {
  yomitanFindKanjiBulkDirect,
  yomitanFindTagsBulkDirect,
  yomitanFindTermMetaBulkDirect,
  yomitanFindTermsBulkDirect,
  type YomitanBulkKanjiEntry,
  type YomitanBulkTagEntry,
  type YomitanBulkTermEntry,
  type YomitanTermMatchType,
  type YomitanTermMetaEntry,
} from '@/features/player/tauri-bridge';

/* ---------------------------------------------------------------------------
 * Row reshaping (engine columns → Yomitan database rows)
 * ---------------------------------------------------------------------------
 * The Rust rows are DATABASE columns (space-separated tag strings, glossary as
 * stored JSON, dictionary by title). The `Translator` expects YOMITAN database
 * rows (arrays of tags, a `definitions` array, `matchType`/`matchSource` filled
 * in). Only this file knows both shapes.
 * ------------------------------------------------------------------------- */

/** Space-separated bank field → array (Yomitan stores tags as one string). */
function splitField(value: string | null): string[] {
  return typeof value === 'string' && value.length > 0 ? value.split(' ') : [];
}

/**
 * One stored glossary value → a `TermGlossary` node.
 *
 * A bank may carry a bare string (the common JMdict shape) or a structured
 * object. A bare string becomes a text node so every downstream reader sees one
 * node type, and anything structured is passed through untouched — including the
 * `[formOf, inflectionRules]` pair, which is how a dictionary declares its own
 * deinflections and which the translator matches on `Array.isArray`.
 */
function toGlossaryNode(entry: unknown): TermGlossary {
  if (typeof entry === 'string') return { type: 'text', text: entry };
  return entry;
}

/** Stored glossary (value, or array of values) → the `definitions` array. */
function toDefinitions(glossary: unknown): TermGlossary[] {
  const list = Array.isArray(glossary) ? glossary : [glossary];
  return list
    .filter((entry) => entry !== null && entry !== undefined)
    .map(toGlossaryNode);
}

/**
 * One bulk term row → a Yomitan `TermEntry`.
 *
 * `reading` falls back to the expression: Yomitan's own database never leaves it
 * empty (kana headwords are their own reading), and the translator compares the
 * two to decide whether a match came from the reading.
 */
function toTermEntry(
  row: YomitanBulkTermEntry,
  matchType: MatchType,
  matchSource: TermEntry['matchSource'],
): TermEntry {
  return {
    index: row.index,
    matchType,
    matchSource,
    term: row.expression,
    reading: row.reading !== null && row.reading.length > 0 ? row.reading : row.expression,
    definitionTags: splitField(row.definitionTags),
    termTags: splitField(row.termTags),
    rules: splitField(row.rules),
    definitions: toDefinitions(row.glossary),
    score: row.score,
    dictionary: row.dictionary,
    id: row.id,
    sequence: row.sequence,
  };
}

/** One bulk term-metadata row → a Yomitan `TermMeta`. */
function toTermMeta(row: YomitanTermMetaEntry): TermMeta {
  return {
    index: row.index,
    term: row.expression,
    mode: row.mode === 'pitch' || row.mode === 'ipa' ? row.mode : 'freq',
    data: row.data,
    dictionary: row.dictionary,
  };
}

/**
 * One bulk kanji row → a Yomitan `KanjiEntry`.
 *
 * The translator reads kanji stats as string-or-number values (a grade, a
 * frequency count), so a value some bank encoded differently is dropped rather
 * than passed through as an untyped `unknown` the display layer would trip on.
 */
function toKanjiStats(
  stats: Record<string, unknown> | null,
): { [name: string]: string | number } {
  const kept: { [name: string]: string | number } = {};
  for (const [name, value] of Object.entries(stats ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') {
      kept[name] = value;
    }
  }
  return kept;
}

function toKanjiEntry(row: YomitanBulkKanjiEntry): KanjiEntry {
  return {
    index: row.index,
    character: row.character,
    onyomi: splitField(row.onyomi),
    kunyomi: splitField(row.kunyomi),
    tags: splitField(row.tags),
    definitions: row.meanings,
    stats: toKanjiStats(row.stats),
    dictionary: row.dictionary,
  };
}

/** One bulk tag row → a Yomitan `Tag`. */
function toTag(row: YomitanBulkTagEntry): Tag {
  return {
    name: row.name,
    category: row.category,
    order: row.order,
    notes: row.notes,
    score: row.score,
    dictionary: row.dictionary,
  };
}

/** The `:category` suffix the translator strips before asking for a tag. */
function tagBaseName(query: string): string {
  const separator = query.indexOf(':');
  return separator === -1 ? query : query.slice(0, separator);
}

/* ---------------------------------------------------------------------------
 * Dictionary set (which dictionaries a lookup may answer from)
 * ------------------------------------------------------------------------- */

/** One dictionary as the translator needs to see it. */
export interface EnabledDictionary {
  index: number;
  alias: string;
  allowSecondarySearches: boolean;
  partsOfSpeechFilter: boolean;
  useDeinflections: boolean;
}

export type EnabledDictionaryMap = Map<string, EnabledDictionary>;

/**
 * Drop every cached engine-side value.
 *
 * The installed-dictionary list is cached by the store that owns it
 * (`dictionary-store`), whose write paths drop it themselves; this drops the
 * translator alongside it, because the translator's tag cache and frequency-mode
 * map are keyed to the dictionaries that were installed when it was prepared.
 *
 * Call it after anything that changes what the engine holds from OUTSIDE that
 * store: a delete, an import or an enable/disable that the settings page performed
 * leaves lookups answering from a dictionary the user just switched off otherwise.
 */
export function invalidateYomitanEngineCaches(): void {
  invalidateInstalledDictionaries();
  translator = null;
  dictionarySignature = '';
}

/**
 * The dictionaries a lookup may answer from, in PRIORITY order.
 *
 * Two sources, and which one decides what:
 *
 * - the ENGINE decides what EXISTS and whether it is switched on
 *   (`dictionaries.enabled` — the switch the Modules page writes),
 * - the OPTIONS TREE decides the ORDER and the per-dictionary behaviour. Yomitan
 *   merges definitions top-down in `options.dictionaries` order, so that array —
 *   the one the settings list reorders — IS the dictionary priority, and the
 *   `index` handed to the translator is this map's insertion order.
 *
 * A dictionary the engine has enabled but the options tree does not list yet (an
 * import whose settings write has not happened) is appended after the configured
 * ones with defaults, so a lagging settings list cannot mute a lookup. A stale
 * options entry for a dictionary the engine no longer has is skipped: the
 * translator would otherwise be told about a dictionary the database cannot
 * answer for.
 */
export async function readEnabledDictionaryMap(
  options: Options = readYomitanOptions(),
): Promise<EnabledDictionaryMap> {
  const profile = activeProfile(options);
  const installed = await listInstalledDictionariesCached();
  const enabledNames = new Set(
    installed.filter((entry) => entry.enabled).map((entry) => entry.name),
  );

  const map: EnabledDictionaryMap = new Map();
  /** Switched off in the settings tree: the append pass below must respect it. */
  const disabledNames = new Set<string>();
  for (const configured of profile.dictionaries ?? []) {
    if (configured.enabled === false) {
      disabledNames.add(configured.name);
      continue;
    }
    if (!enabledNames.has(configured.name)) continue;
    map.set(configured.name, {
      index: map.size,
      alias:
        configured.alias !== undefined && configured.alias !== ''
          ? configured.alias
          : configured.name,
      allowSecondarySearches: configured.allowSecondarySearches === true,
      partsOfSpeechFilter: configured.partsOfSpeechFilter !== false,
      useDeinflections: configured.useDeinflections !== false,
    });
  }

  for (const entry of installed) {
    if (!entry.enabled || map.has(entry.name)) continue;
    // Explicitly switched off in the settings tree: appending it here would undo
    // the user's own off switch.
    if (disabledNames.has(entry.name)) continue;
    map.set(entry.name, {
      index: map.size,
      alias: entry.name,
      allowSecondarySearches: false,
      partsOfSpeechFilter: true,
      useDeinflections: true,
    });
  }
  return map;
}

/** Kanji dictionaries are the same set with a smaller per-dictionary contract. */
function toKanjiDictionaryMap(
  terms: EnabledDictionaryMap,
): Map<string, { index: number; alias: string }> {
  const kanji = new Map<string, { index: number; alias: string }>();
  for (const [name, entry] of terms) {
    kanji.set(name, { index: entry.index, alias: entry.alias });
  }
  return kanji;
}

/** The active profile's options (the persisted tree is the host's own). */
function activeProfile(options: Options): ProfileOptions {
  const profile = options.profiles[options.profileCurrent] ?? options.profiles[0];
  if (profile === undefined) {
    // `normalizeOptions` guarantees at least one profile; this is the guard for a
    // hand-built tree, and it fails closed to "nothing enabled".
    throw new Error('yomitan options carry no profile');
  }
  return profile.options;
}

/* ---------------------------------------------------------------------------
 * DictionaryDatabase (the Translator's read contract)
 * ------------------------------------------------------------------------- */

/** Dictionary summaries for the translator's frequency-mode map. */
function toDictionarySummaries(list: readonly InstalledDictionary[]): DictionarySummary[] {
  return list.map((entry) => ({
    title: entry.name,
    format: 3,
    revision: entry.version,
    sequenced: false,
  }));
}

/**
 * Keep only the rows the caller may see.
 *
 * The engine already filters on its own `enabled` flag, but the translator asks
 * with the dictionary set `options.dictionaries` resolved to — and it then reads each
 * returned row's dictionary STRAIGHT out of that map
 * (`enabledDictionaryMap.get(entry.dictionary)`, whose `partsOfSpeechFilter` it destructures).
 * A row from a dictionary that is not in the map is therefore not merely unwanted,
 * it is a crash inside the translator, which is exactly what Yomitan's own
 * `dictionary-database.js` guards against with the same filter. Two views can disagree for
 * a moment (a toggle mid-lookup, a stale cached list), so this is the host's
 * half of that defence.
 */
function onlyFrom<T extends { dictionary: string }>(
  rows: readonly T[],
  dictionaries: DictionarySet,
): T[] {
  return rows.filter((row) => dictionaries.has(row.dictionary));
}

/**
 * Build the `DictionaryDatabase` the headless translator drives.
 *
 * Stateless: every call goes straight through the bulk IPC, so there is no
 * per-row cache to invalidate. The translator holds the caches (tags, frequency
 * modes) and is itself cached below.
 */
export function createDictionaryDatabase(): DictionaryDatabase {
  return {
    findTermsBulk: async (
      termList: string[],
      dictionaries: DictionarySet,
      matchType: MatchType,
    ) => {
      if (termList.length === 0) return [];
      const rows = await yomitanFindTermsBulkDirect({
        terms: termList,
        matchType: matchType as YomitanTermMatchType,
      });
      // A bulk match comes from the headword itself, never from a reading-only
      // or sequence match: those are separate queries.
      return onlyFrom(rows, dictionaries).map((row) =>
        toTermEntry(row, matchType, 'term'),
      );
    },

    /**
     * Secondary (term + reading) search: the bulk IPC matches on expression OR
     * reading, so the reading half of the pair is applied here — one crossing,
     * then the rows whose reading does not match the requested pair are dropped.
     */
    findTermsExactBulk: async (
      termList: TermExactRequest[],
      dictionaries: DictionarySet,
    ) => {
      if (termList.length === 0) return [];
      const rows = await yomitanFindTermsBulkDirect({
        terms: termList.map((item) => item.term),
        matchType: 'exact',
      });
      return onlyFrom(rows, dictionaries)
        .map((row) => toTermEntry(row, 'exact', 'term'))
        .filter((entry) => {
          const requested = termList[entry.index];
          return requested !== undefined && entry.reading === requested.reading;
        });
    },

    /**
     * Note: sequence lookups answer nothing. They exist for Yomitan's "related
     * entries" (`merge` output mode), which this host does not use — a scan runs
     * in `group`/`simple` mode, where the translator never asks.
     */
    findTermsBySequenceBulk: async () => [],

    findTermMetaBulk: async (
      termList: string[],
      dictionaries: DictionarySet,
    ) => {
      if (termList.length === 0) return [];
      const rows = await yomitanFindTermMetaBulkDirect({ terms: termList });
      return onlyFrom(rows, dictionaries).map(toTermMeta);
    },

    findKanjiBulk: async (
      kanjiList: string[],
      dictionaries: DictionarySet,
    ) => {
      if (kanjiList.length === 0) return [];
      const rows = await yomitanFindKanjiBulkDirect({ characters: kanjiList });
      return onlyFrom(rows, dictionaries).map(toKanjiEntry);
    },

    /**
     * Note: kanji frequency metadata answers nothing yet. No Yomitan kanji bank
     * in the wild ships `term_meta`-style kanji frequency that this host imports
     * (the importer stores kanji `stats` on the entry itself), so the translator's
     * kanji frequency branch has nothing to read. The follow-up is a
     * `kanji_meta` bank table.
     */
    findKanjiMetaBulk: async (): Promise<KanjiMeta[]> => [],

    findTagMetaBulk: async (items: DictionaryAndQuery[]) => {
      if (items.length === 0) return [];
      const rows = await yomitanFindTagsBulkDirect({
        items: items.map((item) => ({
          query: tagBaseName(item.query),
          dictionary: item.dictionary,
        })),
      });
      // The contract is POSITIONAL: a request with no tag is `undefined`, and a
      // tag several dictionaries define lands on its own request's slot.
      const tags: (Tag | undefined)[] = new Array(items.length).fill(undefined);
      for (const row of rows) {
        if (row.index >= tags.length) continue;
        tags[row.index] = toTag(row);
      }
      return tags;
    },

    getDictionaryInfo: async () =>
      toDictionarySummaries(await listInstalledDictionariesCached()),
  };
}

/** `{query, dictionary}` pair — the tag/sequence lookup request shape. */
interface DictionaryAndQuery {
  query: string;
  dictionary: string;
}

/* ---------------------------------------------------------------------------
 * Translator (cached: preparing it rebuilds the deinflection transformers)
 * ------------------------------------------------------------------------- */

let translator: ReturnType<typeof createTranslator> | null = null;
let dictionarySignature = '';

/** Identity of the dictionary set a cached translator was prepared against. */
function signatureOf(map: EnabledDictionaryMap): string {
  return [...map.keys()].join(' ');
}

/**
 * The prepared translator for the current dictionary set.
 *
 * Rebuilt when the set changes (import, delete, enable/disable) so its tag cache
 * and frequency-mode map cannot outlive the dictionaries they describe.
 */
async function readTranslator(
  map: EnabledDictionaryMap,
): Promise<ReturnType<typeof createTranslator>> {
  const signature = signatureOf(map);
  if (translator !== null && dictionarySignature === signature) return translator;
  const database = createDictionaryDatabase();
  const next = createTranslator(database);
  translator = next;
  dictionarySignature = signature;
  return next;
}

/* ---------------------------------------------------------------------------
 * Lookups
 * ------------------------------------------------------------------------- */

/** Text replacements, compiled exactly as Yomitan's backend compiles them. */
function textReplacementsFor(
  profile: ProfileOptions,
): ({ pattern: RegExp; replacement: string }[] | null)[] {
  const replacements: ({ pattern: RegExp; replacement: string }[] | null)[] = [];
  for (const group of profile.translation.textReplacements.groups ?? []) {
    const entries: { pattern: RegExp; replacement: string }[] = [];
    for (const { pattern, ignoreCase, replacement } of group) {
      try {
        entries.push({
          pattern: new RegExp(pattern, ignoreCase ? 'gi' : 'g'),
          replacement,
        });
      } catch {
        // An invalid user pattern is skipped, never fatal — same as Yomitan.
      }
    }
    if (entries.length > 0) replacements.push(entries);
  }
  if (replacements.length === 0 || profile.translation.textReplacements.searchOriginal) {
    replacements.unshift(null);
  }
  return replacements;
}

/** What a lookup is asked for, beyond the text itself. */
export interface LookupOptions {
  /**
   * How a stored headword is compared to the query.
   *
   * `exact` (the default) is a whole-word match; `prefix` answers headwords that
   * START with the scanned text (Yomitan's "Match type prefix" scanning option).
   * Note: `suffix` is not answered by the engine yet — see `find_terms_bulk`.
   */
  matchType?: MatchType;
  /**
   * How much of the text is looked up at once: one character at a time
   * (`letter`, the default) or whole words (`word`).
   *
   * The scanner passes the scanning section's own resolution here, so the knob the
   * user sees is the one the translator obeys.
   */
  searchResolution?: 'letter' | 'word';
  /** Cap on returned entries (defaults to `general.maxResults`). */
  maxResults?: number;
}

/**
 * Look up a block of Japanese text: deinflected, dictionary-merged term entries.
 *
 * This is the entry point every scanner calls — a subtitle line, a settings
 * label, a modal heading. An empty result is a normal answer (most UI text is not
 * Japanese), so nothing here throws for "not found".
 */
export async function lookupTerms(
  text: string,
  options: LookupOptions = {},
): Promise<unknown[]> {
  if (text.trim().length === 0) return [];
  const profile = activeProfile(readYomitanOptions());
  const map = await readEnabledDictionaryMap();
  if (map.size === 0) return [];
  const engine = await readTranslator(map);
  const { dictionaryEntries } = await engine.findTerms(
    profile.general.resultOutputMode,
    text,
    {
      matchType: options.matchType ?? 'exact',
      deinflect: true,
      primaryReading: '',
      mainDictionary: profile.general.mainDictionary,
      sortFrequencyDictionary: profile.general.sortFrequencyDictionary,
      sortFrequencyDictionaryOrder: profile.general.sortFrequencyDictionaryOrder,
      removeNonJapaneseCharacters: !profile.scanning.alphanumeric,
      searchResolution:
        options.searchResolution ?? profile.translation.searchResolution,
      textReplacements: textReplacementsFor(profile),
      enabledDictionaryMap: map,
      excludeDictionaryDefinitions: null,
      language: profile.general.language,
      useAllFrequencyDictionaries: profile.parsing.useAllFrequencyDictionaries,
    } as Parameters<typeof engine.findTerms>[2],
  );
  return dictionaryEntries.slice(0, options.maxResults ?? profile.general.maxResults);
}

/** Look up every kanji in `text` (one entry per character). */
export async function lookupKanji(text: string): Promise<unknown[]> {
  if (text.trim().length === 0) return [];
  const profile = activeProfile(readYomitanOptions());
  const terms = await readEnabledDictionaryMap();
  if (terms.size === 0) return [];
  const engine = await readTranslator(terms);
  return engine.findKanji(text, {
    enabledDictionaryMap: toKanjiDictionaryMap(terms),
    removeNonJapaneseCharacters: !profile.scanning.alphanumeric,
  } as Parameters<typeof engine.findKanji>[1]);
}

/* ---------------------------------------------------------------------------
 * Summaries (what leaves this feature)
 * ------------------------------------------------------------------------- */

/** One term entry, flattened to what a reader shows. */
export interface TermSummary {
  /** Dictionary headword (`group` mode picks the primary headword). */
  term: string;
  /** Reading of that headword (equal to `term` for kana headwords). */
  reading: string;
  /** Text of every definition in the entry, in order. */
  definitions: string[];
  /** Dictionary the entry came from (already alias-resolved by the translator). */
  dictionary: string;
}

/** One kanji entry, flattened. */
export interface KanjiSummary {
  character: string;
  onyomi: string[];
  kunyomi: string[];
  meanings: string[];
  dictionary: string;
}

/** Pull the text out of one glossary node (structured content has `text`). */
function glossaryText(node: unknown): string | null {
  if (typeof node === 'string') return node;
  if (typeof node !== 'object' || node === null) return null;
  const record = node as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  const content = record.content;
  if (Array.isArray(content)) {
    const parts = content.map(glossaryText).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

/**
 * Flatten one translator term entry, or `null` when it carries no headword.
 *
 * Tolerant by design: the entry is a Yomitan-internal shape (headwords,
 * definitions, sources, frequencies) and only the headword's term/reading plus
 * the glossary texts are read here. Anything missing yields `null` rather than a
 * half-filled summary, so a reader never draws an empty row.
 */
export function summarizeTermEntry(entry: unknown): TermSummary | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const headwords = Array.isArray(record.headwords) ? record.headwords : [];
  const primary = headwords[0] as Record<string, unknown> | undefined;
  if (primary === undefined || typeof primary.term !== 'string') return null;

  const definitions: string[] = [];
  let dictionary = '';
  const groups = Array.isArray(record.definitions) ? record.definitions : [];
  for (const group of groups) {
    if (typeof group !== 'object' || group === null) continue;
    const groupRecord = group as Record<string, unknown>;
    if (dictionary === '' && typeof groupRecord.dictionary === 'string') {
      dictionary = groupRecord.dictionary;
    }
    const entries = Array.isArray(groupRecord.entries) ? groupRecord.entries : [];
    for (const node of entries) {
      const text = glossaryText(node);
      if (text !== null && text !== '') definitions.push(text);
    }
  }

  return {
    term: primary.term,
    reading: typeof primary.reading === 'string' ? primary.reading : primary.term,
    definitions,
    dictionary,
  };
}

/** Flatten one translator kanji entry, or `null` when it has no character. */
export function summarizeKanjiEntry(entry: unknown): KanjiSummary | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.character !== 'string') return null;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return {
    character: record.character,
    onyomi: strings(record.onyomi),
    kunyomi: strings(record.kunyomi),
    meanings: strings(record.definitions),
    dictionary: typeof record.dictionary === 'string' ? record.dictionary : '',
  };
}