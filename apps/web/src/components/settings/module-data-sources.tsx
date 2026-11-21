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

import { useCallback, useRef, useState, useId, type ComponentType } from 'react';
import { FileHeadphone, GripVertical, Trash2 } from 'lucide-react';
import type {
  AudioSource,
  AudioSourceType,
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
import {
  readOptionPath,
  writeOptionPath,
} from '@/modules/yomitan/yomitan-preferences';
import { YomitanPopupPreview } from '@/modules/yomitan/popup-preview/YomitanPopupPreview';
import type { StorageUsageSnapshot } from '@/features/settings/storage-usage';
import {
  readJimakuPreferences,
  setJimakuApiKey,
  setJimakuAutoLoad,
} from '@/features/player/jimaku-preferences';
import { Input } from '@/components/player/ui/input';
import { Switch } from '@/components/player/ui/switch';
import { SettingsButton } from '@/components/settings/SettingsButton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/player/ui/select';
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

/* ---------------------------------------------------------------------------
 * Yomitan Audio Sources
 * -------------------------------------------------------------------------
 * Yomitan models audio playback sources as an ordered list (`audio.sources[]`).
 * Each entry names a source TYPE (one of several built-in providers or a custom
 * URL) and, for custom types, the URL to fetch from. The list is checked in
 * order; the first valid source wins, so the order is the fallback chain.
 *
 * The settings tree can only describe the array as a whole (`type: 'array'`),
 * so the host owns an editor: this one, registered under `yomitan-audio-sources`
 * and bound to `audio.sources` in the manifest's Audio section.
 *
 * TTS types (`text-to-speech`, `text-to-speech-reading`) are deliberately
 * excluded from the selectable options per product decision.
 * ------------------------------------------------------------------------- */

/** Dot-path of the audio sources array. */
const AUDIO_SOURCES_PATH = 'audio.sources';

/** The audio source types this host offers (TTS excluded by product decision). */
const AUDIO_SOURCE_TYPES: ReadonlyArray<{ value: AudioSourceType; label: string }> = [
  { value: 'custom-json', label: 'Custom URL (JSON)' },
  { value: 'custom', label: 'Custom URL' },
  { value: 'jisho', label: 'Jisho.org' },
  { value: 'jpod101', label: 'JapanesePod101' },
  { value: 'language-pod-101', label: 'LanguagePod101' },
  { value: 'lingua-libre', label: '(Commons) Lingua Libre' },
  { value: 'wiktionary', label: '(Commons) Wiktionary' },
];

/** Source types that expose a URL field. */
const URL_SOURCE_TYPES: ReadonlySet<string> = new Set(['custom', 'custom-json']);

/** Default source added by the "Add Source" button. */
function newAudioSource(): AudioSource {
  return { type: 'jpod101', url: '', voice: '' };
}

/** Coerce an untrusted stored entry into a complete `AudioSource`. */
function normalizeAudioSource(raw: unknown): AudioSource {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const type = typeof source.type === 'string' && AUDIO_SOURCE_TYPES.some(t => t.value === source.type)
    ? source.type as AudioSourceType
    : 'jpod101';
  return {
    type,
    url: typeof source.url === 'string' ? source.url : '',
    voice: typeof source.voice === 'string' ? source.voice : '',
  };
}

/** Read the persisted audio sources list, every entry coerced. */
function readAudioSources(options: Options): AudioSource[] {
  const raw = readOptionPath(options, AUDIO_SOURCES_PATH);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeAudioSource);
}

/** Persist a whole audio sources list through the options tree. */
function writeAudioSources(options: Options, sources: readonly AudioSource[]): Options {
  return writeOptionPath(options, AUDIO_SOURCES_PATH, [...sources]);
}

/** English copy for the audio sources editor (platform-owned, not a dictionary entry). */
const AUDIO_SOURCES_COPY = {
  add: 'Add Source',
  empty: 'No audio sources configured. Add a source to enable audio playback.',
  remove: 'Delete audio source',
  reorder: 'Reorder audio source',
  reorderHint: 'Drag to change the order, or press the up and down arrow keys.',
  urlPlaceholder: 'http://...',
} as const;

/**
 * YomitanAudioSourcesManager — the Audio section's host-owned editor.
 * ---------------------------------------------------------------------------
 * Renders the `audio.sources[]` array as an ordered list of source rows: drag
 * handle + type Select + optional URL input (custom types only) + delete button.
 * Writes through the whole options tree (`onChange`), which persists.
 * ---------------------------------------------------------------------------
 */
function YomitanAudioSourcesManager({
  label,
  description,
  options,
  onChange,
}: ModuleFieldSourceProps) {
  const sources = readAudioSources(options);
  const hintId = useId();
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const pointerId = useRef<number | null>(null);

  const commit = useCallback(
    (next: readonly AudioSource[]) => {
      onChange(writeAudioSources(options, next));
    },
    [onChange, options],
  );

  const move = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to > sources.length - 1 || from === to) return;
      const next = [...sources];
      const [item] = next.splice(from, 1);
      if (item === undefined) return;
      next.splice(to, 0, item);
      commit(next);
      setDragFrom(to);
    },
    [sources, commit],
  );

  const patchSource = useCallback(
    (index: number, patch: Partial<AudioSource>) => {
      commit(sources.map((s, at) => (at === index ? { ...s, ...patch } : s)));
    },
    [sources, commit],
  );

  return (
    <div className="entei-module-list entei-module-audio-sources">
      <div className="entei-module-list-header">
        <div className="entei-module-list-header-text">
          {label !== undefined && label !== '' && (
            <span className="entei-module-list-title">{label}</span>
          )}
          {description !== undefined && description !== '' && (
            <p className="entei-module-list-description">{description}</p>
          )}
        </div>
        <div className="entei-module-list-toolbar">
          <SettingsButton
            icon={FileHeadphone}
            onClick={() => commit([...sources, newAudioSource()])}
          >
            {AUDIO_SOURCES_COPY.add}
          </SettingsButton>
        </div>
      </div>

      <p className="entei-sr-only" id={hintId}>
        {AUDIO_SOURCES_COPY.reorderHint}
      </p>

      {sources.length === 0 ? (
        <p className="entei-module-list-empty">{AUDIO_SOURCES_COPY.empty}</p>
      ) : (
        <ul className="entei-module-audio-rows">
          {sources.map((source, index) => {
            const showUrl = URL_SOURCE_TYPES.has(source.type);
            const isDragging = dragFrom === index;
            return (
              <li
                key={index}
                className={
                  isDragging
                    ? 'entei-module-audio-row entei-module-list-row--dragging'
                    : 'entei-module-audio-row'
                }
                data-audio-row={index}
              >
                <button
                  type="button"
                  className="entei-module-list-handle"
                  aria-label={`${AUDIO_SOURCES_COPY.reorder}: ${index + 1}/${sources.length}`}
                  aria-describedby={hintId}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    pointerId.current = event.pointerId;
                    setDragFrom(index);
                  }}
                  onPointerMove={(event) => {
                    if (pointerId.current !== event.pointerId) return;
                    if (dragFrom === null) return;
                    const target = document
                      .elementFromPoint(event.clientX, event.clientY)
                      ?.closest('[data-audio-row]')
                      ?.getAttribute('data-audio-row') ?? null;
                    const to = target === null ? NaN : Number(target);
                    if (!Number.isInteger(to)) return;
                    move(dragFrom, to);
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                    pointerId.current = null;
                    setDragFrom(null);
                  }}
                  onPointerCancel={() => {
                    pointerId.current = null;
                    setDragFrom(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      move(index, index - 1);
                      return;
                    }
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      move(index, index + 1);
                    }
                  }}
                >
                  <GripVertical size={16} aria-hidden="true" />
                </button>

                <Select
                  value={source.type}
                  onValueChange={(next) => {
                    if (next === '') return;
                    patchSource(index, { type: next as AudioSourceType });
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="entei-module-audio-select"
                    aria-label={`Audio source type ${index + 1}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUDIO_SOURCE_TYPES.map(({ value, label: typeLabel }) => (
                      <SelectItem key={value} value={value}>
                        {typeLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {showUrl && (
                  <Input
                    className="entei-module-input entei-module-audio-url"
                    value={source.url}
                    placeholder={AUDIO_SOURCES_COPY.urlPlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`Audio source URL ${index + 1}`}
                    onChange={(event) =>
                      patchSource(index, { url: event.target.value })
                    }
                  />
                )}

                <button
                  type="button"
                  className="entei-module-list-remove"
                  aria-label={AUDIO_SOURCES_COPY.remove}
                  title={AUDIO_SOURCES_COPY.remove}
                  onClick={() => commit(sources.filter((_, at) => at !== index))}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Registry
 * ------------------------------------------------------------------------- */

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
  'yomitan-audio-sources': { field: YomitanAudioSourcesManager },
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