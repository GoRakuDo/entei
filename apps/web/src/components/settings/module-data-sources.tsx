/**
 * module-data-sources — the host registry behind a manifest's `source` ids.
 * ---------------------------------------------------------------------------
 * A manifest names LAYOUTS (`list`, `field`, `usage`, `inputs`) and DATA
 * SOURCES. The layouts are generic; the sources cannot be, because only the host
 * can reach a module's storage — so the host keeps this id → capability map and
 * the renderer resolves it without knowing any module by name.
 *
 * Text on those rows is the manifest's own (and, for the strings a layout owns
 * itself, the app's English tables in `module-copy`): nothing here localises a
 * label.
 *
 * One id may serve several layouts, because they are facets of the same data:
 * `yomitan-dictionaries` draws the installed-item list, feeds the "frequency
 * sorting dictionary" select, measures the module's storage, and knows nothing
 * about any of those callers.
 *
 * A `field` row may name one too. Its editor is host-owned because the standard
 * row cannot draw the value: a module's API key lives in that module's own store
 * (`jimaku-api-key`, `nadeshiko-api-key`), and a control that is more than one value
 * (`yomitan-related-dictionaries` edits the merge dictionary AND every per-dictionary
 * secondary-search flag) needs a surface of its own. The row's text still comes from
 * the manifest, and a host editor may WRITE the options tree through `onChange`. Without
 * such a source the same row falls back to the standard control, so a missing binding
 * degrades instead of vanishing.
 *
 * An unknown id resolves to `undefined`. The renderer then degrades: a `list` or
 * `inputs` row falls back to its generic read-only note, a `field` row keeps its
 * descriptor options, and a `usage` row is skipped — a manifest can never make
 * the page draw an editor the app does not implement.
 */

import { useState, type ComponentType } from 'react';
import type {
  Options,
  SelectOption,
} from '@gorakudo/yomitan-headless/settings';
import { ModuleItemManager } from '@/components/settings/ModuleItemManager';
import { ModuleRelatedDictionariesSelect } from '@/components/settings/ModuleRelatedDictionariesSelect';
import type { ModuleListManagerCopy } from '@/components/settings/ModuleListManager';
import {
  createSecretField,
  type ModuleSecretFieldProps,
} from '@/components/settings/ModuleSecretField';
import {
  ScanningInputManager,
  type ScanningInputManagerCopy,
} from '@/components/settings/ScanningInputManager';
import {
  frequencyDictionaryNames,
  listInstalledDictionaries,
  readDictionaryStorageUsage,
} from '@/modules/yomitan/dictionary-store';
import { YomitanPopupPreview } from '@/modules/yomitan/popup-preview/YomitanPopupPreview';
import type { StorageUsageSnapshot } from '@/features/settings/storage-usage';
import {
  readJimakuPreferences,
  setJimakuApiKey,
  setJimakuAutoLoad,
} from '@/features/player/jimaku-preferences';
import { Switch } from '@/components/player/ui/switch';
import {
  JIMAKU_KEY_CHANGED_EVENT,
  dispatchJimakuKeyChanged,
} from '@/features/player/settings-bridge';
import {
  clearNadeshikoApiKey,
  readNadeshikoApiKey,
  writeNadeshikoApiKey,
} from '@/modules/nadeshiko/api-key';

/** What a `list` layout's host source receives. */
export interface ModuleListSourceProps {
  /** The module's whole options tree (sources write through `onChange`). */
  options: Options;
  /** Persist the next options tree. */
  onChange: (next: Options) => void;
  /** Block title: the row's own literal `label`. */
  title?: string;
  /** Block description: the row's own literal `description`. */
  description?: string;
  /** English copy of the list layout (`module-copy`). */
  copy: ModuleListManagerCopy;
}

export type ModuleListSource = ComponentType<ModuleListSourceProps>;

/** What an `inputs` layout's host source receives. */
export interface ModuleInputsSourceProps {
  /** The module's whole options tree (sources write through `onChange`). */
  options: Options;
  /** Persist the next options tree. */
  onChange: (next: Options) => void;
  /** Block title: the row's own literal `label`. */
  title?: string;
  /** Block description: the row's own literal `description`. */
  description?: string;
  /** English copy of the inputs layout (`module-copy`). */
  copy: ScanningInputManagerCopy;
}

export type ModuleInputsSource = ComponentType<ModuleInputsSourceProps>;

/**
 * What a `field` row whose editor the host owns receives: the row's own text plus
 * the module's options tree.
 *
 * An alias, not a narrower type: the renderer draws every host-owned field editor
 * through ONE contract, because it cannot know which kind of value it is drawing.
 * A credential editor ignores the tree; Yomitan's popup preview draws from it.
 */
export type ModuleFieldSourceProps = ModuleSecretFieldProps & {
  /**
   * Persist a next options tree.
   *
   * A host-owned editor is not read-only by definition: a credential writes to its
   * own store, but a row whose control IS several option paths (Yomitan's merge
   * dictionary selection writes the primary dictionary and every per-dictionary
   * secondary-search flag) has nothing else to write through. Required, because the
   * renderer always owns the tree and always has a setter to hand over — an editor
   * that does not need it simply ignores it.
   */
  onChange: (next: Options) => void;
};

export type ModuleFieldSource = ComponentType<ModuleFieldSourceProps>;

/** Every layout a host source can back, keyed by nothing — presence is the flag. */
export interface ModuleDataSource {
  /** Draws the `list` layout for this source. */
  list?: ModuleListSource;
  /** Draws the `inputs` layout for this source (a list of input definitions). */
  inputs?: ModuleInputsSource;
  /**
   * Draws a `field` row this source names — an editor the standard row cannot draw.
   * Either the value lives outside the options tree at all (a credential, see
   * `ModuleSecretField`, whose editor brings its own store) or the control IS several
   * option paths at once (Yomitan's merge dictionary selection). The row still brings
   * its own text, and the editor may write the tree through `onChange`.
   */
  field?: ModuleFieldSource;
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
 * `include` (`modules/yomitan/yomitan-preferences`).
 *
 * Yomitan's own labels, like the rest of that settings surface: the key names are
 * the extension's, so they read the same in every Entei locale.
 */
async function readScanModifierOptions(): Promise<readonly SelectOption[]> {
  return [
    { value: 'none', label: 'No key' },
    { value: 'shift', label: 'Shift' },
    { value: 'alt', label: 'Alt' },
    { value: 'ctrl', label: 'Ctrl' },
    { value: 'meta', label: 'Meta' },
  ];
}

/**
 * Nadeshiko's API key (`entei.nadeshiko.api-key.v1`, BYOK).
 *
 * Trimming and validation are the store helper's own (`writeNadeshikoApiKey`
 * refuses an empty key), and an empty field is a CLEAR, exactly like the
 * hand-written card: what the user sees is what is stored. The announcement is
 * what `NadeshikoPanel`'s inline form and other tabs already listen for.
 */
const NADESHIKO_KEY_CHANGED_EVENT = 'entei:nadeshiko-key-changed';

function announceNadeshikoKeyChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NADESHIKO_KEY_CHANGED_EVENT));
}

function JimakuAutoLoadField({ label, description }: ModuleFieldSourceProps) {
  const [enabled, setEnabled] = useState(() => readJimakuPreferences().autoLoadEnabled);
  return (
    <div className="entei-module-field entei-module-field--switch">
      <div className="entei-module-field-text">
        <span className="entei-module-field-label">{label}</span>
        {description !== undefined && (
          <p className="entei-module-field-description">{description}</p>
        )}
      </div>
      <div className="entei-module-field-control">
        <Switch
          checked={enabled}
          onCheckedChange={(next) => {
            setEnabled(next);
            setJimakuAutoLoad(next);
          }}
          aria-label={label}
        />
      </div>
    </div>
  );
}

/** Jimaku.cc's API key (`entei.jimaku.v1`, shared with the search dialog). */
const JIMAKU_API_KEY_FIELD = createSecretField({
  read: () => readJimakuPreferences().apiKey,
  write: (value) => {
    setJimakuApiKey(value);
    // An open jimaku search dialog reflects key presence live.
    dispatchJimakuKeyChanged(
      readJimakuPreferences().apiKey.trim().length > 0,
    );
  },
  clear: () => {
    setJimakuApiKey('');
    dispatchJimakuKeyChanged(false);
  },
  syncEvents: [JIMAKU_KEY_CHANGED_EVENT],
});

const NADESHIKO_API_KEY_FIELD = createSecretField({
  read: () => readNadeshikoApiKey() ?? '',
  write: (value) => {
    const trimmed = value.trim();
    if (trimmed === '') {
      clearNadeshikoApiKey();
    } else {
      writeNadeshikoApiKey(trimmed);
    }
    announceNadeshikoKeyChanged();
  },
  clear: () => {
    clearNadeshikoApiKey();
    announceNadeshikoKeyChanged();
  },
  syncEvents: [NADESHIKO_KEY_CHANGED_EVENT],
});

/** Every data source the app implements, keyed by manifest `source` id. */
const MODULE_DATA_SOURCES: Readonly<Record<string, ModuleDataSource>> = {
  'yomitan-dictionaries': {
    list: ModuleItemManager,
    options: readInstalledDictionaryOptions,
    usage: readDictionaryStorageUsage,
  },
  'yomitan-scan-modifier-keys': { options: readScanModifierOptions },
  'yomitan-scan-inputs': { inputs: ScanningInputManager },
  'yomitan-popup-preview': { field: YomitanPopupPreview },
  'yomitan-related-dictionaries': { field: ModuleRelatedDictionariesSelect },
  'jimaku-api-key': { field: JIMAKU_API_KEY_FIELD },
  'jimaku-auto-load': { field: JimakuAutoLoadField },
  'nadeshiko-api-key': { field: NADESHIKO_API_KEY_FIELD },
};

/** The capabilities a manifest-declared source id resolves to. */
export function resolveModuleDataSource(
  source: string | undefined,
): ModuleDataSource | undefined {
  if (source === undefined) return undefined;
  return MODULE_DATA_SOURCES[source];
}