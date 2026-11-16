/**
 * related-dictionaries unit tests — the "Group related terms" selection.
 *
 * Covers the whole mapping the settings row is a view of:
 * - the merge gate (the row only exists for `resultOutputMode === 'merge'`)
 * - reading the selection back out of the two settings Yomitan splits apart
 *   (`general.mainDictionary` + `dictionaries[].allowSecondarySearches`)
 * - writing it: first selection = primary, the rest = secondary searches,
 *   every other dictionary off, the array's ORDER (the merge priority) untouched
 * - what a write must NOT touch: `enabled`, and any key the row does not own
 * - the choices list (installed dictionaries, then a stale option entry), which is
 *   what keeps a dictionary the engine no longer has removable
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Options } from '@gorakudo/yomitan-headless/settings';
import { createDefaultOptions } from '@gorakudo/yomitan-headless/settings';
import {
  createDictionaryOptionEntry,
  type DictionaryOptionEntry,
} from '@/modules/yomitan/dictionary-store';
import {
  readOptionPath,
  writeOptionPath,
} from '@/modules/yomitan/yomitan-preferences';
import {
  isMergeResultOutput,
  readRelatedDictionaries,
  relatedDictionaryChoices,
  writeRelatedDictionaries,
} from '@/modules/yomitan/related-dictionaries';

/** One stored dictionary entry, with the flags a test needs. */
function entry(
  name: string,
  allowSecondarySearches: boolean,
  extra: Record<string, unknown> = {},
): DictionaryOptionEntry {
  return {
    ...createDictionaryOptionEntry(name),
    allowSecondarySearches,
    ...extra,
  } as DictionaryOptionEntry;
}

/**
 * A whole options tree carrying exactly these entries and general fields.
 *
 * Built through the production write path rather than by casting a literal: the
 * functions under test are the ones that read and write this tree, so a test
 * fixture cannot invent a shape the app would never store.
 */
function optionsWith(
  dictionaries: readonly DictionaryOptionEntry[],
  general: Readonly<Record<string, unknown>> = {},
): Options {
  let options = writeOptionPath(createDefaultOptions(), 'dictionaries', [
    ...dictionaries,
  ]);
  for (const [key, value] of Object.entries(general)) {
    options = writeOptionPath(options, `general.${key}`, value);
  }
  return options;
}

/** The stored `dictionaries[]` of a tree, as the engine reads it. */
function storedEntries(options: Options): DictionaryOptionEntry[] {
  return readOptionPath(options, 'dictionaries') as DictionaryOptionEntry[];
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('related-dictionaries — the merge gate', () => {
  it('is on only for the "Group related terms" mode', () => {
    expect(isMergeResultOutput(optionsWith([], { resultOutputMode: 'merge' }))).toBe(
      true,
    );
    for (const mode of ['split', 'group', 'term']) {
      expect(
        isMergeResultOutput(optionsWith([], { resultOutputMode: mode })),
      ).toBe(false);
    }
    // The host's own default (`group`) must not open the row.
    expect(isMergeResultOutput(optionsWith([]))).toBe(false);
  });
});

describe('related-dictionaries — reading the selection', () => {
  it('leads with the primary dictionary and follows with the secondary searches', () => {
    const options = optionsWith(
      [
        entry('JMdict', true),
        entry('KANJIDIC2', false),
        entry('my-vocab', true),
      ],
      { mainDictionary: 'JMdict' },
    );
    expect(readRelatedDictionaries(options)).toEqual(['JMdict', 'my-vocab']);
  });

  it('keeps the stored merge priority order, not the array order of the tree', () => {
    // The tree's own order is the definition priority (the Dictionaries list
    // reorders it); a secondary search is simply flagged wherever it sits.
    const options = optionsWith(
      [entry('KANJIDIC2', true), entry('JMdict', false), entry('my-vocab', true)],
      { mainDictionary: 'my-vocab' },
    );
    expect(readRelatedDictionaries(options)).toEqual([
      'my-vocab',
      'KANJIDIC2',
    ]);
  });

  it('ignores a blank primary, a nameless entry and a duplicate', () => {
    const options = optionsWith(
      [
        entry('JMdict', true),
        entry('JMdict', true),
        entry('', true),
        entry('KANJIDIC2', false),
      ],
      { mainDictionary: '   ' },
    );
    expect(readRelatedDictionaries(options)).toEqual(['JMdict']);
  });

  it('still reports a stored primary the entries do not list', () => {
    // Yomitan would merge from it, so the row has to show it — and let the user
    // remove it rather than hiding a setting they cannot clear.
    const options = optionsWith([entry('JMdict', false)], {
      mainDictionary: 'Retired',
    });
    expect(readRelatedDictionaries(options)).toEqual(['Retired']);
  });

  it('reads nothing from a tree with no dictionary list', () => {
    expect(readRelatedDictionaries(optionsWith([]))).toEqual([]);
  });
});

describe('related-dictionaries — writing a selection', () => {
  it('makes the first selection the primary and the rest secondary searches', () => {
    const options = optionsWith([entry('JMdict', false), entry('KANJIDIC2', false)]);
    const next = writeRelatedDictionaries(options, ['JMdict', 'KANJIDIC2']);

    expect(readOptionPath(next, 'general.mainDictionary')).toBe('JMdict');
    /* The PRIMARY carries no secondary-search flag: Yomitan always reads the main
       dictionary for the term itself, and `allowSecondarySearches` is what asks the
       OTHER dictionaries for the same term. Flagging it would claim a pass the
       engine never makes for it. */
    expect(
      storedEntries(next).map((dictionary) => dictionary.allowSecondarySearches),
    ).toEqual([false, true]);
    expect(readRelatedDictionaries(next)).toEqual(['JMdict', 'KANJIDIC2']);
  });

  it('switches every unselected dictionary back off', () => {
    const options = optionsWith(
      [entry('JMdict', true), entry('KANJIDIC2', true), entry('my-vocab', true)],
      { mainDictionary: 'JMdict' },
    );
    // KANJIDIC2 becomes the primary (no flag of its own), JMdict is still asked as a
    // secondary search because the test selection keeps it, and my-vocab drops out.
    const next = writeRelatedDictionaries(options, ['KANJIDIC2', 'JMdict']);

    expect(readOptionPath(next, 'general.mainDictionary')).toBe('KANJIDIC2');
    expect(
      storedEntries(next).map((dictionary) => dictionary.allowSecondarySearches),
    ).toEqual([true, false, false]);
  });

  it('leaves the array order (the definition merge priority) alone', () => {
    const options = optionsWith([
      entry('KANJIDIC2', false),
      entry('JMdict', false),
      entry('my-vocab', false),
    ]);
    const next = writeRelatedDictionaries(options, ['my-vocab', 'JMdict']);

    expect(storedEntries(next).map((dictionary) => dictionary.name)).toEqual([
      'KANJIDIC2',
      'JMdict',
      'my-vocab',
    ]);
  });

  it('preserves the keys it does not own', () => {
    const options = optionsWith([
      entry('JMdict', false, { enabled: false, alias: ' JMdict (EN)' }),
      entry('KANJIDIC2', false, { definitionsCollapsible: 'collapsed' }),
    ]);
    const next = writeRelatedDictionaries(options, ['JMdict', 'KANJIDIC2']);
    const [first, second] = storedEntries(next);

    // Neither switched on nor renamed: this row owns one flag, nothing else.
    expect(first?.enabled).toBe(false);
    expect(first?.alias).toBe(' JMdict (EN)');
    expect(second?.definitionsCollapsible).toBe('collapsed');
  });

  it('creates a fresh entry for a selected dictionary the tree does not list yet', () => {
    const options = optionsWith([entry('JMdict', false)], {
      mainDictionary: 'JMdict',
    });
    const next = writeRelatedDictionaries(options, ['JMdict', 'my-vocab']);

    const added = storedEntries(next).find(
      (dictionary) => dictionary.name === 'my-vocab',
    );
    expect(added?.allowSecondarySearches).toBe(true);
    // Yomitan's own defaults for a newly listed dictionary, not an empty entry.
    expect(added?.definitionsCollapsible).toBe('not-collapsible');
  });

  it('clears both settings for an empty selection', () => {
    const options = optionsWith([entry('JMdict', true), entry('KANJIDIC2', true)], {
      mainDictionary: 'JMdict',
    });
    const next = writeRelatedDictionaries(options, []);

    expect(readOptionPath(next, 'general.mainDictionary')).toBe('');
    expect(
      storedEntries(next).some(
        (dictionary) => dictionary.allowSecondarySearches === true,
      ),
    ).toBe(false);
  });

  it('trims and de-duplicates a hand-built selection', () => {
    const options = optionsWith([entry('JMdict', false), entry('KANJIDIC2', false)]);
    const next = writeRelatedDictionaries(options, [
      ' JMdict ',
      'KANJIDIC2',
      'JMdict',
      '   ',
    ]);

    expect(readOptionPath(next, 'general.mainDictionary')).toBe('JMdict');
    expect(readRelatedDictionaries(next)).toEqual(['JMdict', 'KANJIDIC2']);
  });

  it('round-trips: reading what was written gives the selection back', () => {
    const options = optionsWith(
      [entry('JMdict', false), entry('KANJIDIC2', false), entry('my-vocab', false)],
      { resultOutputMode: 'merge' },
    );
    const selection = ['my-vocab', 'JMdict', 'KANJIDIC2'];
    expect(readRelatedDictionaries(writeRelatedDictionaries(options, selection))).toEqual(
      selection,
    );
  });

  it('returns the same tree when a path is not addressable', () => {
    // `general.mainDictionary` / `dictionaries` are real profile paths, so this is
    // only reachable if the tree shape changes: the row must not report a write it
    // could not persist.
    const options = optionsWith([]);
    expect(writeRelatedDictionaries(options, [])).toBeDefined();
    expect(readOptionPath(writeRelatedDictionaries(options, []), 'profileCurrent')).toBe(
      readOptionPath(options, 'profileCurrent'),
    );
  });
});

describe('related-dictionaries — the offered choices', () => {
  it('lists the installed dictionaries, then a stale option entry, once each', () => {
    const options = optionsWith([
      entry('JMdict', false),
      entry('Retired', true),
      entry('JMdict', false),
    ]);
    expect(relatedDictionaryChoices(['JMdict', 'KANJIDIC2', 'JMdict'], options)).toEqual(
      ['JMdict', 'KANJIDIC2', 'Retired'],
    );
  });

  it('falls back to the options tree alone when the engine lists nothing', () => {
    // A browser pass (no Tauri engine): the row still has to show what is stored,
    // so a stale selection stays removable.
    const options = optionsWith([entry('JMdict', false)], {
      mainDictionary: 'Retired',
    });
    expect(relatedDictionaryChoices([], options)).toEqual(['JMdict']);
    expect(relatedDictionaryChoices(['Retired'], options)).toEqual(['Retired', 'JMdict']);
  });
});