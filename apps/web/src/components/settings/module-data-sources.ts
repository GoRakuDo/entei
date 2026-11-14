/**
 * module-data-sources — the host registry behind a manifest's `source` ids.
 * ---------------------------------------------------------------------------
 * A manifest names LAYOUTS (`list`, `field`, `usage`) and DATA SOURCES. The
 * layouts are generic; the sources cannot be, because only the host can reach a
 * module's storage — so the host keeps this id → capability map and the renderer
 * resolves it without knowing any module by name.
 *
 * One id may serve several layouts, because they are facets of the same data:
 * `yomitan-dictionaries` draws the installed-item list, feeds the "frequency
 * sorting dictionary" select, measures the module's storage, and knows nothing
 * about any of those callers.
 *
 * An unknown id resolves to `undefined`. The renderer then degrades: a `list` or
 * `inputs` row falls back to its generic read-only note, a `field` row keeps its
 * descriptor options, and a `usage` row is skipped — a manifest can never make
 * the page draw an editor the app does not implement.
 */

import type { ComponentType } from 'react';
import type {
  Options,
  SelectOption,
} from '@gorakudo/yomitan-headless/settings';
import { ModuleItemManager } from '@/components/settings/ModuleItemManager';
import type { ModuleListManagerCopy } from '@/components/settings/ModuleListManager';
import {
  ScanningInputManager,
  type ScanningInputManagerCopy,
} from '@/components/settings/ScanningInputManager';
import {
  frequencyDictionaryNames,
  listInstalledDictionaries,
  readDictionaryStorageUsage,
} from '@/features/yomitan/dictionary-store';
import { getDictionary } from '@/i18n';
import { getSavedLocale } from '@/i18n/preferences';
import type { StorageUsageSnapshot } from '@/features/settings/storage-usage';

/** What a `list` layout's host source receives. */
export interface ModuleListSourceProps {
  /** The module's whole options tree (sources write through `onChange`). */
  options: Options;
  /** Persist the next options tree. */
  onChange: (next: Options) => void;
  /** Block title the renderer resolved from the manifest's `labelKey`. */
  title?: string;
  /** Block description the renderer resolved from `descriptionKey`. */
  description?: string;
  /** Already-localized copy for the list layout. */
  copy: ModuleListManagerCopy;
}

export type ModuleListSource = ComponentType<ModuleListSourceProps>;

/** What an `inputs` layout's host source receives. */
export interface ModuleInputsSourceProps {
  /** The module's whole options tree (sources write through `onChange`). */
  options: Options;
  /** Persist the next options tree. */
  onChange: (next: Options) => void;
  /** Block title the renderer resolved from the manifest's `labelKey`. */
  title?: string;
  /** Block description the renderer resolved from `descriptionKey`. */
  description?: string;
  /** Already-localized copy for the inputs layout. */
  copy: ScanningInputManagerCopy;
}

export type ModuleInputsSource = ComponentType<ModuleInputsSourceProps>;

/** Every layout a host source can back, keyed by nothing — presence is the flag. */
export interface ModuleDataSource {
  /** Draws the `list` layout for this source. */
  list?: ModuleListSource;
  /** Draws the `inputs` layout for this source (a list of input definitions). */
  inputs?: ModuleInputsSource;
  /** Options of a `field` row that named this source as `optionsSource`. */
  options?: () => Promise<readonly SelectOption[]>;
  /** Measurement of a `usage` row that named this source. */
  usage?: () => Promise<StorageUsageSnapshot | null>;
}

/**
 * The dictionaries the "frequency sorting dictionary" select may offer.
 *
 * Frequency metadata only, exactly like Yomitan's own settings list: a plain
 * word dictionary (JMdict) has no counts to sort by. Fails soft to "none
 * installed": the engine lives in the desktop plugin, so a browser pass has no
 * answer, and a combobox with only its `none` option is the same thing Yomitan
 * shows with no frequency dictionary installed.
 */
async function readInstalledDictionaryOptions(): Promise<readonly SelectOption[]> {
  try {
    const installed = await listInstalledDictionaries();
    return frequencyDictionaryNames(installed).map((name) => ({
      value: name,
      label: name,
    }));
  } catch {
    return [];
  }
}

/**
 * The scan modifiers the Yomitan scanning section offers.
 *
 * `none` is first and is a real choice, not an empty state: scanning on plain
 * hover (no modifier held) is what a reading aid wants while the pointer rests on
 * subtitles. Values are the tokens the app writes into the first scan input's
 * `include` (`features/yomitan/yomitan-preferences`).
 *
 * Labelled from the ACTIVE LOCALE rather than hard-coded: this module is host
 * code, and a settings row in a Japanese UI must not read "Shift". The locale is
 * read at call time and the row re-reads this list when the copy table changes,
 * so a switch applies without a reload.
 */
async function readScanModifierOptions(): Promise<readonly SelectOption[]> {
  const scanning = getDictionary(getSavedLocale()).yomitanSettings.scanning;
  return [
    { value: 'none', label: scanning.modifierNone },
    { value: 'shift', label: scanning.modifierShift },
    { value: 'alt', label: scanning.modifierAlt },
    { value: 'ctrl', label: scanning.modifierCtrl },
    { value: 'meta', label: scanning.modifierMeta },
  ];
}

/** Every data source the app implements, keyed by manifest `source` id. */
const MODULE_DATA_SOURCES: Readonly<Record<string, ModuleDataSource>> = {
  'yomitan-dictionaries': {
    list: ModuleItemManager,
    options: readInstalledDictionaryOptions,
    usage: readDictionaryStorageUsage,
  },
  'yomitan-scan-modifier-keys': { options: readScanModifierOptions },
  'yomitan-scan-inputs': { inputs: ScanningInputManager },
};

/** The capabilities a manifest-declared source id resolves to. */
export function resolveModuleDataSource(
  source: string | undefined,
): ModuleDataSource | undefined {
  if (source === undefined) return undefined;
  return MODULE_DATA_SOURCES[source];
}