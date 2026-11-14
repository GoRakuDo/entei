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
  createDictionaryDatabase,
  lookupTerms,
  summarizeKanjiEntry,
  summarizeTermEntry,
} from '@/features/yomitan/yomitan-engine';

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

  it('answers nothing when no dictionary is installed', async () => {
    installTauri((command) =>
      command === 'plugin:modules|yomitan_list_dictionaries' ? [] : [],
    );
    expect(await lookupTerms('食べた')).toEqual([]);
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