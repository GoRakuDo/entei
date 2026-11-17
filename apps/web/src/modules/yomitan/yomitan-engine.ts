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
 * `yomitan:scan-result` (see `modules/yomitan/text-scanner.ts`) carrying BOTH the
 * translator's own entries and the flattened summaries of them, so the floating
 * popup card (see `modules/yomitan/popup-preview`) draws the scanned word without
 * running a second lookup of its own.
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
import { createTranslator, distributeFuriganaInflected, isCodePointJapanese } from '@gorakudo/yomitan-headless';
import type { Options, ProfileOptions } from '@gorakudo/yomitan-headless/settings';
import {
  invalidateInstalledDictionaries,
  listInstalledDictionariesCached,
  type InstalledDictionary,
} from '@/modules/yomitan/dictionary-store';
import { readYomitanOptions } from '@/modules/yomitan/yomitan-preferences';
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

/**
 * Where one bulk term row matched, and how exactly.
 *
 * Port of upstream's `DictionaryDatabase._createTermGeneric`
 * (`ext/js/dictionary/dictionary-database.js`), which knows the answer because it
 * queries TWO indexes — `expression` and `reading` — and reads the winning index's
 * position off the request (`data.indexIndex`). The Rust IPC behind
 * `yomitanFindTermsBulkDirect` answers both in ONE statement
 * (`expression = ?1 OR reading = ?1`, likewise for the prefix ranges), so the row
 * itself has to say which side matched: the expression matching the query means
 * the match was on the headword, and anything else can only have come from the
 * reading.
 *
 * This is not bookkeeping for its own sake. The translator sorts candidate entries
 * by `sourceTermExactMatchCount` — how many headwords matched on the TERM — and
 * only THEN by frequency (`Translator._sortTermDictionaryEntries`). Tagging every
 * row `'term'` therefore made a reading-only hit (「園」, read その) tie with the
 * headword the user actually typed (「その」), and the frequency sort put 園 first.
 *
 * The expression is checked first for the same reason upstream de-duplicates by row
 * id across its two indexes: a kana headword matches on both sides, and the
 * headword is the side that matched.
 */
function termMatchOf(
  row: YomitanBulkTermEntry,
  termList: readonly string[],
  matchType: MatchType,
): { matchType: MatchType; matchSource: TermEntry['matchSource'] } {
  const query = termList[row.index];
  // No query to compare against (a row whose index is outside the request): keep
  // the requested match type rather than inventing an exact one.
  if (query === undefined) return { matchType, matchSource: 'term' };
  /* WHICH SIDE matched is decided first, and on its own: the headword, then the
     reading, in the order upstream de-duplicates its two indexes. A partial
     (`prefix`) hit is the same two sides narrowed to whichever one STARTS with the
     query; every other match type only matches in full.

     The match type is then read off the winning side, so the two answers cannot
     disagree: `exact` says the side named beside it is equal to the query, and
     anything else keeps the requested match type. Deciding the exactness first was
     what let a row come back as `exact` on its READING while its headword was the
     side the scan had actually matched — the sort position this function exists to
     fix. */
  const prefix = matchType === 'prefix';
  if (row.expression === query || (prefix && row.expression.startsWith(query))) {
    return {
      matchType: row.expression === query ? 'exact' : matchType,
      matchSource: 'term',
    };
  }
  const reading = row.reading;
  if (
    reading !== null &&
    (reading === query || (prefix && reading.startsWith(query)))
  ) {
    return {
      matchType: reading === query ? 'exact' : matchType,
      matchSource: 'reading',
    };
  }
  // Neither side matched: `suffix` cannot reach here — the engine answers nothing for
  // it (see `find_terms_bulk`) — so this only has to preserve the requested match
  // type for a row the statement returned on some other merit.
  return { matchType, matchSource: 'term' };
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
  version?: string;
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
  // Parsed windows are answers from the dictionaries that were installed when they
  // were scanned, so they expire with them.
  parseCache.clear();
  parseCacheOwner = '';
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
  const installedMap = new Map(installed.map((entry) => [entry.name, entry]));
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
      version: installedMap.get(configured.name)?.version,
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
      version: entry.version,
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
      // Where each row matched decides its match type AND its match source, and
      // through those the order the translator sorts the entries into.
      return onlyFrom(rows, dictionaries).map((row) => {
        const match = termMatchOf(row, termList, matchType);
        return toTermEntry(row, match.matchType, match.matchSource);
      });
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

/**
 * Identity of what a cached translator was prepared against.
 *
 * Rebuilt when the dictionary set, their priority order, their revisions, or any
 * per-dictionary options change (alias, filters, secondary search), ensuring the
 * translator's internal caches (like `_tagCache` and `_dictionaryFrequencyModeMap`)
 * cannot outlive the definitions they describe.
 *
 * Exported because it is the cache key: the unit test pins what counts as "the
 * dictionaries changed", which is otherwise only observable as a stale lookup.
 */
export function dictionarySignatureOf(map: EnabledDictionaryMap): string {
  return [...map.entries()]
    .map(([name, dictionary]) =>
      JSON.stringify([
        name,
        dictionary.version ?? '',
        dictionary.alias,
        dictionary.partsOfSpeechFilter ? 1 : 0,
        dictionary.useDeinflections ? 1 : 0,
        dictionary.allowSecondarySearches ? 1 : 0,
      ]),
    )
    .join('\u0000');
}

/**
 * The prepared translator for the current dictionary set.
 *
 * Rebuilt when the set OR any of its per-dictionary settings change (import,
 * delete, enable/disable, alias, priority, filters), so the translator's tag cache
 * and frequency-mode map cannot outlive what they describe.
 */
async function readTranslator(
  map: EnabledDictionaryMap,
): Promise<ReturnType<typeof createTranslator>> {
  const signature = dictionarySignatureOf(map);
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

/**
 * The `findTerms` options every lookup shares.
 *
 * The object Yomitan's own backend builds in `_getTranslatorFindTermsOptions` and
 * then hands to `Translator.findTerms`: the translator destructures a dozen options
 * and throws on a missing one, so a lookup that answers at all proves this
 * plumbing. Kept in one place because there are now two call sites that must not
 * drift apart — a normal lookup and the scanning parser (below), which differ only
 * in the match type, the search resolution and the find MODE.
 */
function translatorFindTermsOptions(
  profile: ProfileOptions,
  map: EnabledDictionaryMap,
): Record<string, unknown> {
  return {
    deinflect: true,
    primaryReading: '',
    mainDictionary: profile.general.mainDictionary,
    sortFrequencyDictionary: profile.general.sortFrequencyDictionary,
    sortFrequencyDictionaryOrder: profile.general.sortFrequencyDictionaryOrder,
    removeNonJapaneseCharacters: !profile.scanning.alphanumeric,
    textReplacements: textReplacementsFor(profile),
    enabledDictionaryMap: map,
    excludeDictionaryDefinitions: null,
    language: profile.general.language,
    useAllFrequencyDictionaries: profile.parsing.useAllFrequencyDictionaries,
  };
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
 * One term lookup's answer: the entries, and how much of the query they matched.
 *
 * `originalTextLength` is the translator's own number (`findTerms` returns it
 * beside `dictionaryEntries`): the length of the source text the winning
 * deinflection was read from, counted from the START of `text`. A scan needs it
 * because the window it looks up is deliberately longer than the word (up to
 * `scanning.length` characters, so an inflected or compound word still resolves),
 * and this is the only thing that says where inside that window the word ends.
 */
export interface TermLookupResult {
  /** The translator's own dictionary entries (empty when nothing matched). */
  entries: unknown[];
  /**
   * Length in UTF-16 code units of the matched source text at the start of the
   * queried text. `0` when nothing matched.
   */
  originalTextLength: number;
}

/**
 * Look up a block of Japanese text: deinflected, dictionary-merged term entries,
 * PLUS the length of the text they matched.
 *
 * The entry point every scanner calls — a subtitle line, a settings label, a
 * modal heading. An empty result is a normal answer (most UI text is not
 * Japanese), so nothing here throws for "not found".
 *
 * The entries are the translator's own shape, because that is what Yomitan's
 * card generator needs (`summarizeTermEntry` flattens them for readers that only
 * print a line of text). No consumer repeats the lookup: the scan publishes these
 * entries with its result and the popup renders them directly.
 */
export async function lookupTermMatch(
  text: string,
  options: LookupOptions = {},
): Promise<TermLookupResult> {
  if (text.trim().length === 0) return { entries: [], originalTextLength: 0 };
  const profile = activeProfile(readYomitanOptions());
  const map = await readEnabledDictionaryMap();
  if (map.size === 0) return { entries: [], originalTextLength: 0 };
  const engine = await readTranslator(map);
  const { dictionaryEntries, originalTextLength } = await engine.findTerms(
    profile.general.resultOutputMode,
    text,
    {
      ...translatorFindTermsOptions(profile, map),
      matchType: options.matchType ?? 'exact',
      searchResolution:
        options.searchResolution ?? profile.translation.searchResolution,
    } as Parameters<typeof engine.findTerms>[2],
  );
  return {
    entries: dictionaryEntries.slice(
      0,
      options.maxResults ?? profile.general.maxResults,
    ),
    originalTextLength,
  };
}

/**
 * Look up a block of Japanese text: deinflected, dictionary-merged term entries.
 *
 * The entries only — for callers that show them and never need to know how much
 * of the query they matched. A scanner that has to HIGHLIGHT the word wants
 * `lookupTermMatch` instead.
 */
export async function lookupTerms(
  text: string,
  options: LookupOptions = {},
): Promise<unknown[]> {
  return (await lookupTermMatch(text, options)).entries;
}

/* ---------------------------------------------------------------------------
 * Scanning parser (the furigana header on the search page)
 * ---------------------------------------------------------------------------
 * Yomitan's search page does not just look a query up: it PARSES the text the
 * user typed, word by word, and draws it above the results with a reading over
 * every segment (`ext/js/display/query-parser.js` renders what the backend's
 * `_textParseScanning` produced). Clicking a word there is a lookup for that word.
 *
 * This is that backend loop. It walks the text one window at a time — up to
 * `scanning.length` characters, so an inflected or compound word still resolves —
 * asks the translator for the window in `simple` mode, and keeps the winning
 * headword's term/reading split across the source text
 * (`distributeFuriganaInflected`). A window that resolves to nothing is one more
 * character of ungrouped text, and consecutive misses coalesce into a single run
 * so punctuation and Latin text stay in one piece.
 * ------------------------------------------------------------------------- */

/** One piece of a parsed term: the text as written, and the reading over it. */
export interface TermParseSegment {
  /** Source text of this piece (`api.ParseTextSegment.text`). */
  text: string;
  /** Reading for this piece; empty for kana written as-is and for unparsed text. */
  reading: string;
}

/** One parsed term — the segments it is drawn from (`api.ParseTextLine`). */
export type TermParseLine = TermParseSegment[];

/** What one dictionary window answered with. */
interface ScannedWindow {
  /** How much of the window the winning deinflection covered. */
  originalTextLength: number;
  /** The segments to draw (empty when the window resolved to nothing). */
  segments: TermParseSegment[];
}

/**
 * What a parsed window's answer depends on beyond the window itself.
 *
 * Upstream keys its own cache by the options context's index, which changes when the
 * profile does. A profile EDIT does not swap the index, so the same guard is done here
 * by naming the options the parse actually reads: change the main dictionary, the
 * frequency sort or the text replacements and the header must be re-split, not served
 * from before the change.
 */
function parseCacheKey(profile: ProfileOptions): string {
  return [
    profile.general.mainDictionary,
    profile.general.sortFrequencyDictionary,
    profile.general.sortFrequencyDictionaryOrder,
    profile.scanning.alphanumeric ? 1 : 0,
    profile.parsing.useAllFrequencyDictionaries ? 1 : 0,
    profile.translation.searchResolution,
    profile.translation.textReplacements.groups
      .map((group) =>
        group
          .map((entry) => `${entry.ignoreCase ? 'i' : ''}${entry.pattern}`)
          .join('|'),
      )
      .join(';'),
  ].join('\u0000');
}

/** Which profile the cache above was filled against. */
let parseCacheOwner = '';

/**
 * Parsed windows, keyed by the substring the translator answered for.
 *
 * Upstream's own `_textParseCache`, and worth having here for the same reason:
 * parsing is one engine round trip PER WINDOW, and typing a sentence re-scans the
 * windows already scanned (a prefix lookup is not what this is — every window is
 * its own substring). Keyed by the substring alone, like upstream's per-options
 * `index`, because the window's answer depends on the dictionary set and the
 * profile — and a change to either clears this through
 * [`invalidateYomitanEngineCaches`] or [`parseCacheKey`].
 */
const parseCache = new Map<string, ScannedWindow>();

/**
 * Ceiling on the parse cache.
 *
 * The page parses whatever is typed into it, so an unbounded cache is a slow leak
 * on a page that stays open for hours. Clearing the whole map when it fills is
 * upstream's own shape (one map per options context, dropped wholesale) and costs
 * at most one re-parse of the sentence on screen.
 */
const PARSE_CACHE_LIMIT = 512;

/** The first headword of the first entry that carries one. */
function firstParseHeadword(
  entries: readonly unknown[],
): { term: string; reading: string } | null {
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const headwords = (entry as { headwords?: unknown }).headwords;
    if (!Array.isArray(headwords)) continue;
    for (const headword of headwords) {
      if (typeof headword !== 'object' || headword === null) continue;
      const { term, reading } = headword as { term?: unknown; reading?: unknown };
      // The translator never leaves a reading empty (a kana headword is its own
      // reading), so a row without both is a shape this parser cannot split.
      if (typeof term === 'string' && typeof reading === 'string') {
        return { term, reading };
      }
    }
  }
  return null;
}

/**
 * Parse ONE window of `text`.
 *
 * The condition is upstream's, verbatim: a window that only matched the character
 * it starts with is not a word (a single kanji in a kanji dictionary), so the
 * character has to be Japanese for that to count as a parse.
 */
async function scanParseWindow(
  engine: ReturnType<typeof createTranslator>,
  substring: string,
  character: string,
  codePoint: number,
  options: Record<string, unknown>,
): Promise<ScannedWindow> {
  const { dictionaryEntries, originalTextLength } = await engine.findTerms(
    'simple',
    substring,
    options as Parameters<typeof engine.findTerms>[2],
  );
  const headword = firstParseHeadword(dictionaryEntries);
  const resolves =
    originalTextLength > 0 &&
    headword !== null &&
    (originalTextLength !== character.length || isCodePointJapanese(codePoint));
  if (!resolves || headword === null) return { originalTextLength, segments: [] };
  const source = substring.substring(0, originalTextLength);
  const segments = distributeFuriganaInflected(
    headword.term,
    headword.reading,
    source,
  ) as TermParseSegment[];
  return { originalTextLength, segments };
}

/**
 * Parse a block of Japanese text into the lines the furigana header draws.
 *
 * Port of the backend's `_textParseScanning` (there is an equivalent in
 * `yomitan-headless/dist/server.js`, unexported, which is why this exists).
 *
 * Empty input and a host with no enabled dictionaries are normal answers (an empty
 * header), so nothing here throws for them. A failing engine call does propagate:
 * the caller already has the unparsed preview on screen and keeps it.
 */
export async function parseTextScanning(
  text: string,
  options: { scanLength?: number } = {},
): Promise<TermParseLine[]> {
  if (text.length === 0) return [];
  const profile = activeProfile(readYomitanOptions());
  const scanLength = Math.max(
    1,
    Math.floor(options.scanLength ?? profile.scanning.length),
  );
  const map = await readEnabledDictionaryMap();
  if (map.size === 0) return [];
  const engine = await readTranslator(map);
  const owner = parseCacheKey(profile);
  if (owner !== parseCacheOwner) {
    // Everything held was scanned against another dictionary or another profile.
    parseCache.clear();
    parseCacheOwner = owner;
  }
  const findOptions = {
    ...translatorFindTermsOptions(profile, map),
    matchType: 'exact',
    searchResolution: profile.translation.searchResolution,
  };

  const lines: TermParseLine[] = [];
  /** The run of characters no window could parse, coalesced into one segment. */
  let ungrouped: TermParseSegment | null = null;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    const substring = text.substring(index, index + scanLength);

    let window = parseCache.get(substring);
    if (window === undefined) {
      window = await scanParseWindow(
        engine,
        substring,
        character,
        codePoint,
        findOptions,
      );
      if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
      parseCache.set(substring, window);
    }

    if (window.segments.length > 0) {
      ungrouped = null;
      lines.push(window.segments);
      // Upstream advances by the matched source length, not by the segments: that
      // is the number the translator reported, and the two are only equal by
      // coincidence of `distributeFuriganaInflected`'s reconstruction.
      index += Math.max(window.originalTextLength, character.length);
      continue;
    }
    if (ungrouped === null) {
      ungrouped = { text: character, reading: '' };
      lines.push([ungrouped]);
    } else {
      ungrouped.text += character;
    }
    index += character.length;
  }
  return lines;
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