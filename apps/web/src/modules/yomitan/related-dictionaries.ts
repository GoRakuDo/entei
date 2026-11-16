/**
 * related-dictionaries — the "Group related terms" dictionary selection.
 * ---------------------------------------------------------------------------
 * Yomitan's `merge` result grouping does not merge everything: it merges what a
 * PRIMARY dictionary answers with the entries other dictionaries add for the same
 * term. Upstream expresses that as two separate settings — `general.mainDictionary`
 * names the primary, and each `options.dictionaries[]` entry carries its own
 * `allowSecondarySearches` flag. Two controls in two different sections, which
 * reads as two unrelated knobs.
 *
 * This is the same state as ONE ordered selection, kept pure so both the row and
 * its tests speak about the mapping rather than about dot-paths:
 *
 * - the FIRST selected dictionary is the primary (`general.mainDictionary`),
 * - every other selected dictionary is a secondary search
 *   (`allowSecondarySearches: true`), and every unselected one is not,
 * - selection ORDER is therefore the merge order the user arranged.
 *
 * A write never touches `dictionaries[].enabled` or the array's order: which
 * dictionaries exist, whether they are switched on, and what priority their
 * definitions merge in are the Dictionaries section's own settings (a switched
 * off dictionary keeps its own switch — exactly like upstream's per-entry
 * checkbox). Unknown keys on an entry survive a write, because the array is the
 * persisted tree, not a view model.
 */

import type { Options } from '@gorakudo/yomitan-headless/settings';
import { createDictionaryOptionEntry } from '@/modules/yomitan/dictionary-store';
import {
  readOptionPath,
  writeOptionPath,
} from '@/modules/yomitan/yomitan-preferences';

/* Descriptor paths this mapping owns. Private on purpose: the manifest names the
   same paths in its row declaration, and an exported constant nobody imports is a
   second place to keep in step. */

/** The one result grouping mode that merges entries across dictionaries. */
const MERGE_RESULT_OUTPUT_MODE = 'merge';

/** Descriptor path of the grouping mode (the row that gates this one). */
const RESULT_OUTPUT_MODE_PATH = 'general.resultOutputMode';

/** Descriptor path of the primary (merge) dictionary. */
const MAIN_DICTIONARY_PATH = 'general.mainDictionary';

/** Descriptor path of the per-dictionary option array. */
const DICTIONARIES_PATH = 'dictionaries';

/** True while the grouping mode is "Group related terms" (this row's gate). */
export function isMergeResultOutput(options: Options): boolean {
  return readOptionPath(options, RESULT_OUTPUT_MODE_PATH) === MERGE_RESULT_OUTPUT_MODE;
}

/** One `options.dictionaries[]` entry as stored (unknown keys preserved). */
type DictionaryRecord = Record<string, unknown>;

/** The persisted per-dictionary entries, in stored (priority) order. */
function readDictionaryRecords(options: Options): DictionaryRecord[] {
  const raw = readOptionPath(options, DICTIONARIES_PATH);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is DictionaryRecord =>
    typeof entry === 'object' && entry !== null,
  );
}

/** A record's dictionary name, or `''` for a malformed entry. */
function recordName(record: DictionaryRecord): string {
  return typeof record.name === 'string' ? record.name : '';
}

/**
 * The selection the options tree describes: the primary first, then the
 * dictionaries allowed to run a secondary search, in merge priority order.
 *
 * Read back the way it is written, so the row and the store can never disagree:
 * a stored `mainDictionary` with no matching entry still leads the list (Yomitan
 * would merge from it), and a nameless / duplicate entry is dropped.
 */
export function readRelatedDictionaries(options: Options): readonly string[] {
  const stored = readOptionPath(options, MAIN_DICTIONARY_PATH);
  const primary = typeof stored === 'string' ? stored.trim() : '';
  const selected: string[] = [];
  if (primary !== '') selected.push(primary);
  for (const record of readDictionaryRecords(options)) {
    if (record.allowSecondarySearches !== true) continue;
    const name = recordName(record);
    if (name === '' || name === primary || selected.includes(name)) continue;
    selected.push(name);
  }
  return selected;
}

/**
 * The dictionaries the row offers, in draw order: what the engine has installed,
 * then any name the options tree still lists for a dictionary the engine no
 * longer has (a stale entry stays visible and removable instead of silently
 * holding a secondary search the user cannot clear).
 */
export function relatedDictionaryChoices(
  installedNames: readonly string[],
  options: Options,
): readonly string[] {
  const choices: string[] = [];
  const seen = new Set<string>();
  for (const name of installedNames) {
    const trimmed = name.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    choices.push(trimmed);
  }
  for (const record of readDictionaryRecords(options)) {
    const name = recordName(record);
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    choices.push(name);
  }
  return choices;
}

/**
 * The options tree for a new selection: `selected[0]` becomes the primary
 * dictionary, the rest become secondary searches, and every other dictionary is
 * switched back to "not a secondary search".
 *
 * Names are trimmed and de-duplicated (a hand-built selection must not be able to
 * make one dictionary both primary and secondary), the array's ORDER is left
 * alone, and a selected dictionary with no entry yet gets a fresh one — the same
 * rule `setDictionaryEnabled` follows, so selecting a dictionary the settings
 * write has not reached still persists.
 */
export function writeRelatedDictionaries(
  options: Options,
  selected: readonly string[],
): Options {
  const names: string[] = [];
  for (const value of selected) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (name === '' || names.includes(name)) continue;
    names.push(name);
  }
  const [primary = '', ...secondary] = names;
  const secondaryNames = new Set(secondary);

  const records = readDictionaryRecords(options);
  const written = new Set<string>();
  const nextDictionaries = records.map((record) => {
    const name = recordName(record);
    // A malformed entry is stored tree data, not this row's business: keep it.
    if (name === '') return record;
    written.add(name);
    return { ...record, allowSecondarySearches: secondaryNames.has(name) };
  });
  for (const name of secondary) {
    if (written.has(name)) continue;
    written.add(name);
    nextDictionaries.push({
      ...createDictionaryOptionEntry(name),
      allowSecondarySearches: true,
    });
  }

  const withPrimary = writeOptionPath(
    options,
    MAIN_DICTIONARY_PATH,
    primary,
  );
  return writeOptionPath(withPrimary, DICTIONARIES_PATH, nextDictionaries);
}