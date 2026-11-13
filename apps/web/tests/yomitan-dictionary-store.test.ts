/**
 * Dictionary store tests — the pure half (no IndexedDB needed).
 * ---------------------------------------------------------------------------
 * Covers what a dictionary import decides BEFORE anything is written:
 *
 * - `index.json` validation (missing fields, unsupported format)
 * - bank row conversion for both dictionary formats (V1 / V3)
 * - glossary node formatting (text collapses, images become resolvable targets,
 *   structured content is walked)
 * - the `options.dictionaries` helpers that back the enable/delete toggles
 */

import { describe, expect, it } from 'bun:test';
import {
  convertKanjiBankEntry,
  convertKanjiMetaBankEntry,
  convertTagBankEntry,
  convertTermBankEntry,
  convertTermMetaBankEntry,
  createDictionaryOptionEntry,
  formatGlossaryNode,
  getDictionaryRecord,
  getImageMediaTypeFromFileName,
  listInstalledDictionaries,
  parseDictionaryIndex,
  removeDictionaryOption,
  setDictionaryEnabled,
  orderDictionaryOptions,
  type DictionaryOptionEntry,
} from '@/features/yomitan/dictionary-store';

describe('parseDictionaryIndex', () => {
  it('reads a format-3 index', () => {
    const index = parseDictionaryIndex(
      JSON.stringify({
        title: 'JMdict',
        revision: 'jmdict-3.5.0',
        version: 3,
        sequenced: true,
        author: 'Electronic Dictionary Research',
        frequencyMode: 'merge-split',
      }),
    );
    expect(index.title).toBe('JMdict');
    expect(index.revision).toBe('jmdict-3.5.0');
    expect(index.version).toBe(3);
    expect(index.sequenced).toBe(true);
    expect(index.author).toBe('Electronic Dictionary Research');
    expect(index.frequencyMode).toBe('merge-split');
  });

  it('accepts a format-1 index and keeps its inline tag metadata', () => {
    const index = parseDictionaryIndex(
      JSON.stringify({
        title: 'Kanjium',
        revision: '1.0',
        version: 1,
        tagMeta: {
          n: { category: 'frequency', order: 0, notes: 'notes', score: 0 },
        },
      }),
    );
    expect(index.version).toBe(1);
    expect(index.tagMeta?.n?.category).toBe('frequency');
  });

  it('rejects an index with no title', () => {
    expect(() => parseDictionaryIndex('{"revision":"1","version":3}')).toThrow(
      /missing 'title'/i,
    );
  });

  it('rejects an unsupported dictionary format', () => {
    expect(() =>
      parseDictionaryIndex('{"title":"X","revision":"1","version":2}'),
    ).toThrow(/not supported/i);
  });

  it('rejects a file that is not JSON', () => {
    expect(() => parseDictionaryIndex('nope')).toThrow(/invalid index\.json/i);
  });
});

describe('convertTermBankEntry', () => {
  it('converts a format-3 row (expression, reading, tags, rules, score, glossary, sequence, termTags)', () => {
    const entry = convertTermBankEntry(
      ['彼', 'かれ', 'pn', 'n', 100, ['he; him'], 2501, 'common'],
      'dict',
      3,
    );
    expect(entry.expression).toBe('彼');
    expect(entry.reading).toBe('かれ');
    expect(entry.definitionTags).toEqual(['pn']);
    expect(entry.rules).toEqual(['n']);
    expect(entry.score).toBe(100);
    expect(entry.glossary).toEqual(['he; him']);
    expect(entry.sequence).toBe(2501);
    expect(entry.termTags).toEqual(['common']);
    expect(entry.dictionary).toBe('dict');
    // Suffix-search indices hold the reversed strings (code-point safe).
    expect(entry.expressionReverse).toBe([...'彼'].reverse().join(''));
  });

  it('falls back to the expression when a format-3 row leaves the reading empty', () => {
    const entry = convertTermBankEntry(
      ['東京', '', 'n', 'n', 0, ['Tokyo'], -1, ''],
      'dict',
      3,
    );
    expect(entry.reading).toBe('東京');
    expect(entry.readingReverse).toBe([...'東京'].reverse().join(''));
  });

  it('converts a format-1 row (glossary entries spread after the score)', () => {
    const entry = convertTermBankEntry(
      ['食べる', 'たべる', 'v1', 'v1 vt', 50, 'to eat', 'consume'],
      'dict',
      1,
    );
    expect(entry.definitionTags).toEqual(['v1']);
    expect(entry.glossary).toEqual(['to eat', 'consume']);
    // Format-1 banks carry no sequence / term tags.
    expect(entry.sequence).toBe(-1);
    expect(entry.termTags).toEqual([]);
  });

  it('splits multi-word tag strings', () => {
    const entry = convertTermBankEntry(
      ['x', 'y', 'v1 ichidan', 'n', 0, ['g'], 1, 'ichi1 common'],
      'dict',
      3,
    );
    expect(entry.definitionTags).toEqual(['v1', 'ichidan']);
    expect(entry.termTags).toEqual(['ichi1', 'common']);
  });
});

describe('convertKanjiBankEntry', () => {
  it('converts a format-3 row with stats', () => {
    const entry = convertKanjiBankEntry(
      ['日', ['ニチ'], ['ひ'], ['nature'], ['day', 'sun'], { codepoint: 26085 }],
      'dict',
      3,
    );
    expect(entry.character).toBe('日');
    expect(entry.onyomi).toEqual(['ニチ']);
    expect(entry.meanings).toEqual(['day', 'sun']);
    expect(entry.stats).toEqual({ codepoint: 26085 });
  });

  it('converts a format-1 row (meanings spread as loose arguments, no stats)', () => {
    const entry = convertKanjiBankEntry(
      ['日', ['ニチ'], ['ひ'], ['nature'], 'day', 'sun'],
      'dict',
      1,
    );
    expect(entry.meanings).toEqual([]);
    expect(entry.stats).toBeUndefined();
  });
});

describe('convertTermMetaBankEntry / convertKanjiMetaBankEntry', () => {
  it('reads a frequency row', () => {
    const meta = convertTermMetaBankEntry(['食べる', 'freq', 1234], 'dict');
    expect(meta.mode).toBe('freq');
    expect(meta.data).toBe(1234);
    expect(meta.dictionary).toBe('dict');
  });

  it('reads a pitch-accent row', () => {
    const meta = convertTermMetaBankEntry(
      ['食べる', 'pitch', { pitches: [{ reading: 'たべる', devoice: [], nasal: [] }] }],
      'dict',
    );
    expect(meta.mode).toBe('pitch');
    expect(typeof meta.data).toBe('object');
  });

  it('reads a kanji code-point row', () => {
    const meta = convertKanjiMetaBankEntry(['日', 'freq', 26085], 'dict');
    expect(meta.character).toBe('日');
    expect(meta.mode).toBe('freq');
  });
});

describe('convertTagBankEntry', () => {
  it('reads a tag row', () => {
    const tag = convertTagBankEntry(
      ['v1', 'part-of-speech', 0, 'Ichidan verb', 0],
      'dict',
    );
    expect(tag.name).toBe('v1');
    expect(tag.category).toBe('part-of-speech');
    expect(tag.order).toBe(0);
    expect(tag.notes).toBe('Ichidan verb');
  });
});

describe('formatGlossaryNode', () => {
  it('collapses a text node to its string', () => {
    const requirements: Parameters<typeof formatGlossaryNode>[1] = [];
    expect(formatGlossaryNode({ type: 'text', text: 'hello' }, requirements)).toBe(
      'hello',
    );
    expect(requirements).toHaveLength(0);
  });

  it('turns an image node into a resolvable target', () => {
    const requirements: Parameters<typeof formatGlossaryNode>[1] = [];
    const node = formatGlossaryNode(
      { type: 'image', path: 'images/pic.png', height: 100, alt: 'pic' },
      requirements,
    );
    expect(node).toMatchObject({ type: 'image', path: '' });
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.source.path).toBe('images/pic.png');
  });

  it('walks structured content and collects its images', () => {
    const requirements: Parameters<typeof formatGlossaryNode>[1] = [];
    const node = formatGlossaryNode(
      {
        type: 'structured-content',
        content: [
          'plain ',
          { tag: 'img', path: 'a.png' },
          { tag: 'span', content: [{ tag: 'img', path: 'b.png' }] },
        ],
      },
      requirements,
    );
    expect(node).toMatchObject({ type: 'structured-content' });
    expect(requirements.map((item) => item.source.path)).toEqual([
      'a.png',
      'b.png',
    ]);
  });

  it('passes an unknown node type through untouched', () => {
    const requirements: Parameters<typeof formatGlossaryNode>[1] = [];
    const node = formatGlossaryNode({ type: 'future-thing', data: 1 }, requirements);
    expect(node).toEqual({ type: 'future-thing', data: 1 });
    expect(requirements).toHaveLength(0);
  });
});

describe('getImageMediaTypeFromFileName', () => {
  it('maps the common glossary image extensions', () => {
    expect(getImageMediaTypeFromFileName('a/b/c.png')).toBe('image/png');
    expect(getImageMediaTypeFromFileName('c.JPG')).toBe('image/jpeg');
    expect(getImageMediaTypeFromFileName('c.svg')).toBe('image/svg+xml');
    expect(getImageMediaTypeFromFileName('c.webp')).toBe('image/webp');
  });

  it('returns null for a file that is not an image', () => {
    expect(getImageMediaTypeFromFileName('a.json')).toBeNull();
    expect(getImageMediaTypeFromFileName('no-extension')).toBeNull();
  });
});

describe('options.dictionaries helpers', () => {
  const list: DictionaryOptionEntry[] = [
    { ...createDictionaryOptionEntry('Dict A'), alias: 'A' },
    { ...createDictionaryOptionEntry('Dict B'), enabled: false },
  ];

  it('creates a fully-formed enabled entry', () => {
    expect(createDictionaryOptionEntry('Dict C')).toEqual({
      name: 'Dict C',
      alias: '',
      enabled: true,
      allowSecondarySearches: false,
      definitionsCollapsible: 'not-collapsible',
      partsOfSpeechFilter: true,
      useDeinflections: true,
    });
  });

  it('toggles one dictionary without touching its siblings', () => {
    const next = setDictionaryEnabled(list, 'Dict A', false);
    expect(next[0]?.enabled).toBe(false);
    expect(next[1]?.enabled).toBe(false);
    // The input list is not mutated.
    expect(list[0]?.enabled).toBe(true);
  });

  it('appends an entry for a dictionary missing from the list', () => {
    const next = setDictionaryEnabled(list, 'Dict C', true);
    expect(next).toHaveLength(3);
    expect(next[2]?.name).toBe('Dict C');
  });

  it('removes exactly one entry', () => {
    const next = removeDictionaryOption(list, 'Dict A');
    expect(next.map((entry) => entry.name)).toEqual(['Dict B']);
  });

  it('reorders by display order, keeping every entry and its flags', () => {
    // Row order IS dictionary priority, so a reorder writes this array.
    const next = orderDictionaryOptions(list, ['Dict B', 'Dict A']);
    expect(next.map((entry) => entry.name)).toEqual(['Dict B', 'Dict A']);
    expect(next[1]?.enabled).toBe(true);
    expect(next[0]?.enabled).toBe(false);
    // The input list is not mutated.
    expect(list.map((entry) => entry.name)).toEqual(['Dict A', 'Dict B']);
  });

  it('creates a disabled entry for a name with no entry yet', () => {
    const next = orderDictionaryOptions(list, ['Dict C', 'Dict A']);
    expect(next.map((entry) => entry.name)).toEqual([
      'Dict C',
      'Dict A',
      'Dict B',
    ]);
    expect(next[0]?.enabled).toBe(false);
  });
});

describe('store read APIs without IndexedDB', () => {
  it('report "no dictionaries" instead of throwing', async () => {
    // `bun test` runs in Bun's runtime, which has no `indexedDB` global — the
    // same shape as an SSR pass or a locked-down browser.
    expect(typeof indexedDB).toBe('undefined');
    expect(await listInstalledDictionaries()).toEqual([]);
    expect(await getDictionaryRecord('Dict A')).toBeNull();
  });
});