/**
 * dictionary-store — Yomitan dictionaries: native data, persisted settings.
 * ---------------------------------------------------------------------------
 * The dictionary DATA is Rust: `plugins/tauri-plugin-modules` owns a SQLite
 * database (import, enable, delete, term/kanji lookups) and the web layer
 * reaches it through `features/player/tauri-bridge`. There is no dictionary
 * IndexedDB, no ZIP decompression and no bank conversion on this side — the
 * functions below are a thin adapter that reshapes the engine's summaries for
 * the settings UI, plus the pure `options.dictionaries` list transforms, the
 * frequency-dictionary filter and the storage measurement the settings meter
 * shows.
 *
 * What the host still owns is the SETTINGS half, like every other Yomitan
 * option: `options.dictionaries` in the persisted options tree
 * (`features/yomitan/yomitan-preferences.ts`). That array is
 *
 * - the per-dictionary flags the translator reads (secondary searches,
 *   deinflections, collapsible definitions, …), and
 * - the dictionary PRIORITY ORDER: Yomitan merges results top-down in this
 *   array's order, and the native engine has no order column, so the list
 *   layout's reorder writes here.
 *
 * Enable state is written to BOTH (engine + options) in the same handler, so
 * lookups and the settings tree never disagree.
 * ---------------------------------------------------------------------------
 */

import {
  yomitanDeleteDictionaryDirect,
  yomitanGetStorageUsageDirect,
  yomitanImportDictionaryDirect,
  yomitanListDictionariesDirect,
  yomitanToggleDictionaryDirect,
  isTauri,
  type YomitanDictionarySummary,
} from '@/features/player/tauri-bridge';
import {
  readStorageUsage,
  type StorageUsageSnapshot,
} from '@/features/settings/storage-usage';

/* ---------------------------------------------------------------------------
 * Installed dictionaries (native engine)
 * ------------------------------------------------------------------------ */

/** What the settings UI needs to draw one installed dictionary. */
export interface InstalledDictionary {
  /** Native engine id — what toggle/delete address. */
  id: string;
  /** Dictionary title — the identity `options.dictionaries[].name` refers to. */
  name: string;
  /** Dictionary revision (`index.json`'s `revision`). */
  version: string;
  author?: string;
  /** False when the user switched this dictionary off for lookups. */
  enabled: boolean;
  /** ISO date the import first ran. */
  importedAt: string;
  /**
   * True when this dictionary ships frequency metadata (`term_meta` in the
   * engine's `freq` mode) — the only dictionaries Yomitan offers as a frequency
   * sorting choice. A plain word dictionary (JMdict) has nothing to sort by.
   */
  hasFrequencyData: boolean;
}

/** Reshape one engine summary for the settings UI. */
function toInstalledDictionary(
  summary: YomitanDictionarySummary,
): InstalledDictionary {
  const installed: InstalledDictionary = {
    id: summary.id,
    name: summary.title,
    version: summary.revision,
    enabled: summary.enabled,
    importedAt:
      typeof summary.createdAt === 'number'
        ? new Date(summary.createdAt).toISOString()
        : '',
    hasFrequencyData: summary.hasFrequencyData === true,
  };
  if (summary.author !== null) installed.author = summary.author;
  return installed;
}

/**
 * Every imported dictionary, newest import first.
 *
 * Rejects outside the desktop app: the engine lives in the Tauri plugin, and a
 * browser has nowhere to keep a multi-gigabyte dictionary database.
 */
export async function listInstalledDictionaries(): Promise<InstalledDictionary[]> {
  const summaries = await yomitanListDictionariesDirect();
  return summaries.map(toInstalledDictionary);
}

/**
 * How long one cached read answers before the engine is asked again.
 *
 * Lookups are a pointer gesture: without a cache the settings page and every
 * scan would each cross the IPC boundary, and with an unbounded one an import or
 * a toggle would not reach a lookup until a reload. Every WRITE path below drops
 * the cache, so a change is visible to the very next read; this window only
 * covers a change made by someone else (another window, the engine itself).
 */
const INSTALLED_CACHE_MS = 5000;

let installedCache: readonly InstalledDictionary[] | null = null;
let installedAt = 0;
let installedLoad: Promise<readonly InstalledDictionary[]> | null = null;

/**
 * Every imported dictionary, briefly cached — the read a lookup performs.
 *
 * Concurrent callers share one in-flight read, so a burst of scans costs a single
 * IPC however many lookups it turns into.
 */
export async function listInstalledDictionariesCached(): Promise<
  readonly InstalledDictionary[]
> {
  const fresh = Date.now() - installedAt < INSTALLED_CACHE_MS;
  if (installedCache !== null && fresh) return installedCache;
  if (installedLoad === null) {
    installedLoad = listInstalledDictionaries()
      .then((list) => {
        installedCache = list;
        installedAt = Date.now();
        return list;
      })
      .finally(() => {
        installedLoad = null;
      });
  }
  return installedLoad;
}

/**
 * Drop the cached dictionary list.
 *
 * Called by every write below (import, enable/disable, delete) and by anything
 * else that changes what the engine holds: the cached list decides which
 * dictionaries a lookup may answer from, so a stale copy is a lookup that
 * ignores what the user just did.
 */
export function invalidateInstalledDictionaries(): void {
  installedCache = null;
  installedAt = 0;
  installedLoad = null;
}

/**
 * Import one dictionary archive from an absolute path.
 *
 * A path, not bytes: the engine streams the ZIP off disk, so a huge dictionary
 * never lands in renderer memory. Re-importing replaces that dictionary's banks
 * and leaves it enabled.
 */
export async function importDictionaryFromPath(
  zipPath: string,
): Promise<InstalledDictionary> {
  const imported = toInstalledDictionary(
    await yomitanImportDictionaryDirect({ zipPath }),
  );
  invalidateInstalledDictionaries();
  return imported;
}

/** Enable/disable one dictionary for lookups (engine side of the toggle). */
export async function toggleDictionary(
  id: string,
  enabled: boolean,
): Promise<void> {
  await yomitanToggleDictionaryDirect({ id, enabled });
  invalidateInstalledDictionaries();
}

/** Delete one dictionary and every bank row it owns (engine side). */
export async function deleteDictionary(id: string): Promise<void> {
  await yomitanDeleteDictionaryDirect({ id });
  invalidateInstalledDictionaries();
}

/**
 * Names of the dictionaries that may serve as the frequency sorting dictionary.
 *
 * Yomitan's own settings list offers only dictionaries that carry frequency
 * metadata (`counts.termMeta.freq > 0`): a plain word dictionary such as JMdict
 * has no counts to sort by, so offering it would be a choice that silently does
 * nothing. Kept pure so the rule is testable without the engine.
 */
export function frequencyDictionaryNames(
  list: readonly InstalledDictionary[],
): readonly string[] {
  return list
    .filter((entry) => entry.hasFrequencyData)
    .map((entry) => entry.name);
}

/**
 * Measure the dictionary database's real size, in bytes.
 *
 * On the desktop the engine measures its own files (`yomitan-dictionaries.db`
 * plus its WAL sidecars): the banks are a Rust-owned SQLite database, not origin
 * storage, so the browser's estimate would read 0 however much is imported. A
 * browser has no engine at all, so it falls back to its own origin estimate.
 *
 * An unavailable reading resolves to `null` rather than a fabricated 0, so the
 * meter can show "unknown" instead of "0 bytes used".
 */
export async function readDictionaryStorageUsage(): Promise<StorageUsageSnapshot | null> {
  if (!isTauri()) return readStorageUsage();
  try {
    const usage = await yomitanGetStorageUsageDirect();
    return { usage: usage.usage, quota: usage.quota };
  } catch {
    return null;
  }
}

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
 * normal options path; the native engine's own `enabled` flag is set by the
 * caller in the same handler, so the two never disagree for long.
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
 * import whose settings write has not happened) gets a fresh DISABLED one, so
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