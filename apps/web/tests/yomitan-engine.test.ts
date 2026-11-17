/**
 * Yomitan engine tests — the host's lookup pipeline.
 * ---------------------------------------------------------------------------
 * Two layers are covered, both without an app:
 *
 * - the `DictionaryDatabase` reshape: Rust rows (database columns, tags as one
 *   space-separated string, dictionary by TITLE, per-row `id`) → the rows
 *   Yomitan's `Translator` reads (`definitions` array, tag arrays, positional tag
 *   replies);
 * - a real `Translator` run over a faked IPC: the point of that test is the
 *   OPTION object. `Translator.findTerms` destructures a dozen options and throws
 *   on a missing one, so a lookup that returns a headword proves the plumbing, not
 *   just the mapping.
 *
 * Glossary/deinflection behaviour itself belongs to `yomitan-headless`; bank
 * parsing and the SQL behind these rows belong to
 * `plugins/tauri-plugin-modules/tests/yomitan_dictionary_test.rs`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import {
  createDictionaryOptionEntry,
  invalidateInstalledDictionaries,
} from '@/modules/yomitan/dictionary-store';
import {
  createDefaultOptions,
} from '@gorakudo/yomitan-headless/settings';
import {
  createDictionaryDatabase,
  dictionarySignatureOf,
  invalidateYomitanEngineCaches,
  lookupTermMatch,
  lookupTerms,
  parseTextScanning,
  readEnabledDictionaryMap,
  summarizeKanjiEntry,
  summarizeTermEntry,
  type EnabledDictionary,
  type EnabledDictionaryMap,
} from '@/modules/yomitan/yomitan-engine';

interface InvokeArgs {
  command: string;
  args: Record<string, unknown> | undefined;
}

interface InternalsWindow {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

function internals(): InternalsWindow {
  return globalThis as unknown as InternalsWindow;
}

function installTauri(
  impl: (command: string, args: Record<string, unknown> | undefined) => unknown,
): InvokeArgs[] {
  const calls: InvokeArgs[] = [];
  internals().__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return impl(command, args);
    }),
  };
  return calls;
}

/** One Rust bulk term row, exactly as the plugin serialises it. */
function termRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 0,
    dictionary: 'JMdict',
    id: 1,
    expression: '食べる',
    reading: 'たべる',
    definitionTags: 'v1 vt',
    rules: 'v1',
    score: 100,
    sequence: 1001,
    termTags: 'common',
    glossary: ['to eat'],
    ...overrides,
  };
}

/** The installed-dictionary reply `readEnabledDictionaryMap` reads. */
const INSTALLED = [
  {
    id: 'a1',
    title: 'JMdict',
    format: 3,
    revision: 'jmdict-3.5.0',
    sequenced: true,
    author: null,
    url: null,
    description: null,
    createdAt: 1_700_000_000_000,
    enabled: true,
    hasFrequencyData: false,
  },
];

beforeEach(() => {
  localStorage.clear();
  /* The store caches the installed list for the hot scan path, so a test that
     fakes a different engine reply has to drop it — exactly what the app's own
     import / toggle / delete handlers do. */
  invalidateInstalledDictionaries();
  invalidateYomitanEngineCaches();
});

afterEach(() => {
  delete internals().__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('dictionary database — term rows', () => {
  it('reshapes a Rust row into the row the translator reads', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_terms_bulk' ? [termRow()] : [],
    );
    const [entry] = await createDictionaryDatabase().findTermsBulk(
      ['食べる'],
      new Set(['JMdict']),
      'exact',
    );

    expect(entry).toBeDefined();
    if (entry === undefined) return;
    // The translator de-duplicates by id and keys dictionaries by title: a
    // constant id or an id-as-dictionary would collapse every headword.
    expect(entry.id).toBe(1);
    expect(entry.dictionary).toBe('JMdict');
    expect(entry.term).toBe('食べる');
    expect(entry.reading).toBe('たべる');
    expect(entry.matchType).toBe('exact');
    expect(entry.matchSource).toBe('term');
    // Tags are one space-separated string in the bank and an array here.
    expect(entry.definitionTags).toEqual(['v1', 'vt']);
    expect(entry.termTags).toEqual(['common']);
    expect(entry.rules).toEqual(['v1']);
    // A bare string glossary becomes a text node.
    expect(entry.definitions).toEqual([{ type: 'text', text: 'to eat' }]);
  });

  it('keeps the index of the query term that produced each row', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_terms_bulk'
        ? [termRow({ index: 1, id: 7, expression: '食う' })]
        : [],
    );
    const [entry] = await createDictionaryDatabase().findTermsBulk(
      ['食べる', '食う'],
      new Set(['JMdict']),
      'exact',
    );
    expect(entry?.index).toBe(1);
    expect(entry?.term).toBe('食う');
  });

  it('falls back to the expression for an empty reading and empty tag fields', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_terms_bulk'
        ? [
            termRow({
              expression: '猫',
              reading: null,
              definitionTags: null,
              rules: null,
              termTags: null,
              glossary: { type: 'text', text: 'cat' },
            }),
          ]
        : [],
    );
    const [entry] = await createDictionaryDatabase().findTermsBulk(
      ['猫'],
      new Set(['JMdict']),
      'exact',
    );
    expect(entry?.reading).toBe('猫');
    expect(entry?.definitionTags).toEqual([]);
    expect(entry?.termTags).toEqual([]);
    expect(entry?.rules).toEqual([]);
    // Structured content passes through untouched.
    expect(entry?.definitions).toEqual([{ type: 'text', text: 'cat' }]);
  });

  it('answers nothing for an empty batch and never calls the engine', async () => {
    const calls = installTauri(() => []);
    const database = createDictionaryDatabase();
    expect(await database.findTermsBulk([], new Set(), 'exact')).toEqual([]);
    expect(await database.findTermMetaBulk([], new Set())).toEqual([]);
    expect(await database.findKanjiBulk([], new Set())).toEqual([]);
    expect(await database.findTagMetaBulk([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  /* Upstream queries its `expression` and `reading` indexes separately and reads the
     winning index off the request (`dictionary-database.js` `_createTermGeneric`);
     the Rust IPC answers both in one statement, so the ROW decides. It matters: the
     translator sorts by how many headwords matched on the TERM before it compares
     frequency at all. */
  it('marks a reading-only hit as a reading match, so the typed headword wins', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_terms_bulk'
        ? [
            // 「園」, read その — matched on the READING, and the higher score.
            termRow({ index: 0, id: 1, expression: '園', reading: 'その', score: 900 }),
            // The headword the user actually typed.
            termRow({ index: 0, id: 2, expression: 'その', reading: 'その', score: 10 }),
          ]
        : [],
    );
    const entries = await createDictionaryDatabase().findTermsBulk(
      ['その'],
      new Set(['JMdict']),
      'exact',
    );
    expect(entries.map((entry) => entry.term)).toEqual(['園', 'その']);
    expect(entries.map((entry) => entry.matchSource)).toEqual([
      'reading',
      'term',
    ]);
    // And a full match on either side is an exact match, as upstream re-tags it.
    expect(entries.map((entry) => entry.matchType)).toEqual(['exact', 'exact']);
  });

  it('keeps a prefix hit partial and names the side that starts with the query', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_terms_bulk'
        ? [
            // A real prefix hit on the EXPRESSION: nothing about it is exact.
            termRow({ index: 0, id: 1, expression: 'こいぬ', reading: 'いぬ' }),
            // The same hit on the READING.
            termRow({ index: 0, id: 2, expression: '苔', reading: 'こけ' }),
          ]
        : [],
    );
    const entries = await createDictionaryDatabase().findTermsBulk(
      ['こ'],
      new Set(['JMdict']),
      'prefix',
    );
    expect(entries.map((entry) => entry.matchType)).toEqual(['prefix', 'prefix']);
    expect(entries.map((entry) => entry.matchSource)).toEqual(['term', 'reading']);
  });

  /* The side is decided first and the match type is read off it, so the two answers
     can never disagree: a row reported as a `prefix` match is one whose named side
     only STARTS with the query. */
  it('names the term as the winning side even when the reading matches in full', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_terms_bulk'
        ? [
            // 「こいぬ」, read こ: the headword is the side that starts with the query.
            termRow({ index: 0, id: 1, expression: 'こいぬ', reading: 'こ' }),
          ]
        : [],
    );
    const entries = await createDictionaryDatabase().findTermsBulk(
      ['こ'],
      new Set(['JMdict']),
      'prefix',
    );
    expect(entries.map((entry) => entry.matchSource)).toEqual(['term']);
    expect(entries.map((entry) => entry.matchType)).toEqual(['prefix']);
  });
});

describe('dictionary database — exact (term + reading) search', () => {
  it('keeps only the rows whose reading matches the requested pair', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_terms_bulk'
        ? [
            termRow({ index: 0, id: 1, reading: 'たべる' }),
            termRow({ index: 1, id: 2, expression: '降ろす', reading: 'おろす' }),
            termRow({ index: 1, id: 3, expression: '下す', reading: 'くだす' }),
          ]
        : [],
    );
    const entries = await createDictionaryDatabase().findTermsExactBulk(
      [
        { term: '食べる', reading: 'たべる' },
        { term: '降ろす', reading: 'おろす' },
      ],
      new Set(['JMdict']),
    );
    expect(entries.map((entry) => entry.id)).toEqual([1, 2]);
  });
});

describe('dictionary database — kanji and tags', () => {
  it('reshapes a kanji row and defaults its stats', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_kanji_bulk'
        ? [
            {
              index: 0,
              dictionary: 'KANJIDIC',
              character: '食',
              onyomi: 'ショク ジキ',
              kunyomi: 'た.べる く.う',
              tags: 'ate1',
              meanings: ['eat', 'food'],
              stats: { grade: 2 },
            },
          ]
        : [],
    );
    const [entry] = await createDictionaryDatabase().findKanjiBulk(
      ['食'],
      new Set(['KANJIDIC']),
    );
    expect(entry?.onyomi).toEqual(['ショク', 'ジキ']);
    expect(entry?.kunyomi).toEqual(['た.べる', 'く.う']);
    expect(entry?.tags).toEqual(['ate1']);
    expect(entry?.definitions).toEqual(['eat', 'food']);
    expect(entry?.stats).toEqual({ grade: 2 });

    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_kanji_bulk'
        ? [
            {
              index: 0,
              dictionary: 'KANJIDIC',
              character: '行',
              onyomi: null,
              kunyomi: null,
              tags: null,
              meanings: [],
              stats: null,
            },
          ]
        : [],
    );
    const [bare] = await createDictionaryDatabase().findKanjiBulk(
      ['行'],
      new Set(['KANJIDIC']),
    );
    expect(bare?.stats).toEqual({});
    expect(bare?.onyomi).toEqual([]);
  });

  it('answers a tag reply POSITIONALLY, with holes for the misses', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_tags_bulk'
        ? [
            {
              index: 1,
              name: 'v1',
              category: 'partOfSpeech',
              order: 10,
              notes: 'Ichidan verb',
              score: 0,
              dictionary: 'JMdict',
            },
          ]
        : [],
    );
    const tags = await createDictionaryDatabase().findTagMetaBulk([
      { query: 'vt', dictionary: 'JMdict' },
      { query: 'v1:verb', dictionary: 'JMdict' },
    ]);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toBeUndefined();
    expect(tags[1]?.name).toBe('v1');
    expect(tags[1]?.order).toBe(10);
    expect(tags[1]?.notes).toBe('Ichidan verb');
  });

  it('strips the category suffix before asking the engine', async () => {
    const calls = installTauri(() => []);
    await createDictionaryDatabase().findTagMetaBulk([
      { query: 'v1:verb', dictionary: 'JMdict' },
    ]);
    const sent = calls[0]?.args?.items as { query: string }[];
    expect(sent[0]?.query).toBe('v1');
  });

  it('answers nothing for sequence and kanji-frequency lookups', async () => {
    const calls = installTauri(() => []);
    const database = createDictionaryDatabase();
    expect(await database.findTermsBySequenceBulk([])).toEqual([]);
    expect(await database.findKanjiMetaBulk(['食'], new Set())).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('lookup pipeline — a real translator over a faked engine', () => {
  it('deinflects and returns a headword for 食べた', async () => {
    installTauri((command, args) => {
      switch (command) {
        case 'plugin:modules|yomitan_list_dictionaries':
          return INSTALLED;
        case 'plugin:modules|yomitan_find_terms_bulk': {
          // The translator asks for the whole deinflection batch at once; only
          // the dictionary form is in the (fake) dictionary.
          const terms = (args?.terms as string[]) ?? [];
          return terms
            .map((term, index) =>
              term === '食べる' ? termRow({ index, id: index + 1 }) : null,
            )
            .filter((row): row is Record<string, unknown> => row !== null);
        }
        default:
          return [];
      }
    });

    const entries = await lookupTerms('食べた');
    expect(entries.length).toBeGreaterThan(0);
    expect(summarizeTermEntry(entries[0])?.term).toBe('食べる');
  });

  it('reports how much of the query the match covers (what a highlight is sized by)', async () => {
    installTauri((command, args) => {
      switch (command) {
        case 'plugin:modules|yomitan_list_dictionaries':
          return INSTALLED;
        case 'plugin:modules|yomitan_find_terms_bulk': {
          const terms = (args?.terms as string[]) ?? [];
          return terms
            .map((term, index) =>
              term === '食べる' ? termRow({ index, id: index + 1 }) : null,
            )
            .filter((row): row is Record<string, unknown> => row !== null);
        }
        default:
          return [];
      }
    });

    /* The scanner reads a WINDOW longer than the word (up to `scanning.length`
       characters); this number is the only thing that says where the word ends. */
    const match = await lookupTermMatch('食べた');
    expect(match.originalTextLength).toBe(3);
    expect(match.entries.length).toBeGreaterThan(0);

    /* And the entries are the same ones the plain form answers with — a scanner
       that does not highlight can keep calling that. */
    expect(await lookupTerms('食べた')).toEqual(match.entries);
  });

  it('reports no match length when nothing matched', async () => {
    installTauri(() => []);
    expect(await lookupTermMatch('食べた')).toEqual({
      entries: [],
      originalTextLength: 0,
    });
  });

  it('answers nothing when no dictionary is installed', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_list_dictionaries' ? [] : [],
    );
    expect(await lookupTerms('食べた')).toEqual([]);
  });
});

describe('scanning parser — the furigana header behind /search/', () => {
  /** A host whose one dictionary holds exactly the headwords listed. */
  function installDictionary(headwords: readonly [string, string][]): void {
    installTauri((command, args) => {
      switch (command) {
        case 'plugin:modules|yomitan_list_dictionaries':
          return INSTALLED;
        case 'plugin:modules|yomitan_find_terms_bulk': {
          const terms = (args?.terms as string[]) ?? [];
          return terms.flatMap((term, index) => {
            const hit = headwords.find(([expression]) => expression === term);
            if (hit === undefined) return [];
            return [termRow({ index, id: index + 1, expression: hit[0], reading: hit[1] })];
          });
        }
        default:
          return [];
      }
    });
  }

  it('splits a matched word into its furigana segments', async () => {
    installDictionary([['猫', 'ねこ']]);

    expect(await parseTextScanning('猫')).toEqual([
      [{ text: '猫', reading: 'ねこ' }],
    ]);
  });

  it('spans an inflected word from its dictionary form', async () => {
    installDictionary([['食べる', 'たべる']]);

    /* The dictionary holds 食べる; the text says 食べた. The stem's kanji keeps the
       reading and the inflected ending stays kana as written — but either way the
       segments must add back up to exactly what was typed. */
    const lines = await parseTextScanning('食べた');
    expect(lines).toHaveLength(1);
    const segments = lines[0] ?? [];
    expect(segments.map((segment) => `${segment.text}|${segment.reading}`)).toEqual([
      '食|た',
      'べた|',
    ]);
    expect(segments.map((segment) => segment.text).join('')).toBe('食べた');
  });

  it('walks the text one window at a time and coalesces the misses', async () => {
    installDictionary([['猫', 'ねこ']]);

    /* One character per window (what `scanning.length: 1` asks for): the leading
       run nobody could parse stays ONE segment, and the word after it is its own
       line. */
    const lines = await parseTextScanning('とて猫', { scanLength: 1 });
    expect(lines).toEqual([
      [{ text: 'とて', reading: '' }],
      [{ text: '猫', reading: 'ねこ' }],
    ]);
  });

  it('answers nothing to an empty text or a host with no dictionary', async () => {
    installDictionary([['猫', 'ねこ']]);
    expect(await parseTextScanning('')).toEqual([]);

    installTauri((command) =>
      command === 'plugin:modules|yomitan_list_dictionaries' ? [] : [],
    );
    expect(await parseTextScanning('猫')).toEqual([]);
  });
});

describe('summaries — what leaves the feature', () => {
  it('flattens a translator term entry to term, reading and definitions', () => {
    const summary = summarizeTermEntry({
      headwords: [{ term: '食べる', reading: 'たべる', sources: [] }],
      definitions: [
        {
          dictionary: 'JMdict',
          entries: [
            { type: 'text', text: 'to eat' },
            { type: 'text', text: 'to live on' },
          ],
        },
      ],
      frequencies: [],
      pronunciations: [],
    });
    expect(summary).toEqual({
      term: '食べる',
      reading: 'たべる',
      definitions: ['to eat', 'to live on'],
      dictionary: 'JMdict',
    });
  });

  it('reads structured-content glossary nodes and skips the rest', () => {
    const summary = summarizeTermEntry({
      headwords: [{ term: '猫', reading: 'ねこ' }],
      definitions: [
        {
          dictionary: 'JMdict',
          entries: [
            { type: 'structured-content', content: [{ type: 'text', text: 'cat' }] },
            { type: 'image', path: 'x.png' },
          ],
        },
      ],
    });
    expect(summary?.definitions).toEqual(['cat']);
  });

  it('refuses an entry with no headword', () => {
    expect(summarizeTermEntry({ definitions: [] })).toBeNull();
    expect(summarizeTermEntry(null)).toBeNull();
    expect(summarizeTermEntry('食べる')).toBeNull();
  });

  it('flattens a translator kanji entry', () => {
    expect(
      summarizeKanjiEntry({
        character: '食',
        onyomi: ['ショク'],
        kunyomi: ['た.べる'],
        tags: [],
        definitions: ['eat', 'food'],
        stats: [],
        dictionary: 'KANJIDIC',
      }),
    ).toEqual({
      character: '食',
      onyomi: ['ショク'],
      kunyomi: ['た.べる'],
      meanings: ['eat', 'food'],
      dictionary: 'KANJIDIC',
    });
    expect(summarizeKanjiEntry({})).toBeNull();
  });
});
describe('dictionary set — the caller decides what a row may come from', () => {
  it('drops rows from a dictionary the caller did not enable', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_terms_bulk' ? [termRow()] : [],
    );
    // The engine answered with a JMdict row; the translator asked with only
    // KANJIDIC enabled. Returning it would make the translator read a dictionary
    // that is absent from its own map (and crash destructuring it).
    const entries = await createDictionaryDatabase().findTermsBulk(
      ['食べる'],
      new Set(['KANJIDIC']),
      'exact',
    );
    expect(entries).toEqual([]);
  });

  it('keeps rows from every dictionary the caller did enable', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_find_terms_bulk'
        ? [termRow({ id: 1 }), termRow({ id: 2, dictionary: 'JMdict Extra' })]
        : [],
    );
    const entries = await createDictionaryDatabase().findTermsBulk(
      ['食べる'],
      new Set(['JMdict', 'JMdict Extra']),
      'exact',
    );
    expect(entries.map((entry) => entry.dictionary)).toEqual([
      'JMdict',
      'JMdict Extra',
    ]);
  });

  it('applies the same rule to meta and kanji rows', async () => {
    installTauri((command) => {
      switch (command) {
        case 'plugin:modules|yomitan_find_term_meta_bulk':
          return [
            { index: 0, expression: '食べる', mode: 'freq', data: 3, dictionary: 'JMdict' },
          ];
        case 'plugin:modules|yomitan_find_kanji_bulk':
          return [
            {
              index: 0,
              dictionary: 'KANJIDIC',
              character: '食',
              onyomi: null,
              kunyomi: null,
              tags: null,
              meanings: [],
              stats: null,
            },
          ];
        default:
          return [];
      }
    });
    const database = createDictionaryDatabase();
    expect(await database.findTermMetaBulk(['食べる'], new Set())).toEqual([]);
    expect(await database.findKanjiBulk(['食'], new Set())).toEqual([]);

    const meta = await database.findTermMetaBulk(['食べる'], new Set(['JMdict']));
    expect(meta.map((entry) => entry.term)).toEqual(['食べる']);
    const kanji = await database.findKanjiBulk(['食'], new Set(['KANJIDIC']));
    expect(kanji.map((entry) => entry.character)).toEqual(['食']);
  });
});

describe('dictionary priority — the settings order wins', () => {
  const INSTALLED_TWO = [
    { ...INSTALLED[0]!, id: 'a1', title: 'Alpha' },
    { ...INSTALLED[0]!, id: 'b2', title: 'Beta' },
  ];

  it('numbers the dictionaries in options.dictionaries order, not import order', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_list_dictionaries' ? INSTALLED_TWO : [],
    );
    const options = createDefaultOptions();
    const profileIndex = options.profileCurrent;
    // Import order is Alpha, Beta; the user dragged Beta to the top.
    options.profiles[profileIndex]!.options.dictionaries = [
      { ...createDictionaryOptionEntry('Beta') },
      { ...createDictionaryOptionEntry('Alpha') },
    ];

    const map = await readEnabledDictionaryMap(options);
    expect([...map.keys()]).toEqual(['Beta', 'Alpha']);
    expect(map.get('Beta')?.index).toBe(0);
    expect(map.get('Alpha')?.index).toBe(1);
  });

  it('keeps the engine as the source of truth for what exists', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_list_dictionaries' ? INSTALLED_TWO : [],
    );
    const options = createDefaultOptions();
    const profileIndex = options.profileCurrent;
    options.profiles[profileIndex]!.options.dictionaries = [
      // A dictionary the engine does not have (a stale settings entry) must not
      // reach the translator's map.
      { ...createDictionaryOptionEntry('Ghost') },
      { ...createDictionaryOptionEntry('Alpha'), enabled: false },
      { ...createDictionaryOptionEntry('Beta') },
    ];
    const map = await readEnabledDictionaryMap(options);
    expect([...map.keys()]).toEqual(['Beta']);
  });

  it('appends a freshly imported dictionary the settings list has not seen', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_list_dictionaries' ? INSTALLED_TWO : [],
    );
    const options = createDefaultOptions();
    options.profiles[options.profileCurrent]!.options.dictionaries = [
      { ...createDictionaryOptionEntry('Beta') },
    ];
    const map = await readEnabledDictionaryMap(options);
    expect([...map.keys()]).toEqual(['Beta', 'Alpha']);
    expect(map.get('Alpha')?.useDeinflections).toBe(true);
  });
});

describe('lookup — the scan knobs reach the engine', () => {
  it('asks for a prefix match when the scanning option is on', async () => {
    const calls = installTauri((command, args) => {
      if (command === 'plugin:modules|yomitan_list_dictionaries') return INSTALLED;
      if (command === 'plugin:modules|yomitan_find_terms_bulk') {
        const terms = (args?.terms as string[]) ?? [];
        return terms
          .map((term, index) => (term.startsWith('食') ? termRow({ index, id: index + 1 }) : null))
          .filter((row): row is Record<string, unknown> => row !== null);
      }
      return [];
    });

    await lookupTerms('食べ', { matchType: 'prefix' });
    const sent = calls.find(
      (call) => call.command === 'plugin:modules|yomitan_find_terms_bulk',
    );
    expect(sent?.args?.matchType).toBe('prefix');
  });
});

describe('translator cache key — what forces a rebuild', () => {
  function dictionaryEntry(
    overrides: Partial<EnabledDictionary> = {},
  ): EnabledDictionary {
    return {
      index: 0,
      alias: 'JMdict',
      allowSecondarySearches: false,
      partsOfSpeechFilter: true,
      useDeinflections: true,
      ...overrides,
    };
  }

  it('changes when a per-dictionary setting changes, not just the name set', () => {
    const plain = new Map([['JMdict', dictionaryEntry()]]);
    expect(dictionarySignatureOf(plain)).toBe(dictionarySignatureOf(
      new Map([['JMdict', dictionaryEntry()]]),
    ));

    for (const changed of [
      dictionaryEntry({ alias: 'JM' }),
      dictionaryEntry({ version: 'rev.2' }),
      dictionaryEntry({ partsOfSpeechFilter: false }),
      dictionaryEntry({ useDeinflections: false }),
      dictionaryEntry({ allowSecondarySearches: true }),
    ]) {
      expect(dictionarySignatureOf(new Map([['JMdict', changed]]))).not.toBe(
        dictionarySignatureOf(plain),
      );
    }
  });

  it('changes when the priority order changes', () => {
    const alpha = dictionaryEntry({ alias: 'Alpha' });
    const beta = dictionaryEntry({ alias: 'Beta' });
    const alphaFirst = new Map([
      ['Alpha', alpha],
      ['Beta', beta],
    ]);
    const betaFirst = new Map([
      ['Beta', beta],
      ['Alpha', alpha],
    ]);
    expect(dictionarySignatureOf(alphaFirst)).not.toBe(
      dictionarySignatureOf(betaFirst),
    );
  });

  it('stays equal for maps built in the same order with the same settings', () => {
    const build = (): EnabledDictionaryMap =>
      new Map([
        ['Alpha', dictionaryEntry({ alias: 'Alpha', index: 0 })],
        ['Beta', dictionaryEntry({ alias: 'Beta', index: 1 })],
      ]);
    expect(dictionarySignatureOf(build())).toBe(dictionarySignatureOf(build()));
  });
});
