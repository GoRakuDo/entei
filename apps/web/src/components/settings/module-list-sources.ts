/**
 * module-list-sources — the host registry behind a manifest's `listFields`.
 * ---------------------------------------------------------------------------
 * A manifest names a list LAYOUT (`list-manager`, drawn by
 * `components/settings/ModuleListManager`) and a DATA SOURCE. The layout is
 * generic; the source cannot be, because only the host can reach a module's
 * storage — so the host keeps this id → adapter map and the renderer resolves
 * it without knowing any module by name.
 *
 * An unknown source id resolves to `undefined`, and the renderer then falls
 * back to its generic read-only note: a manifest can never make the page draw
 * an editor the app does not implement.
 */

import type { ComponentType } from 'react';
import type { Options } from '@gorakudo/yomitan-headless/settings';
import {
  DictionaryManager,
  type YomitanDictionaryListLabels,
} from '@/components/settings/DictionaryManager';

/**
 * Copy a list source receives. It is the standard layout's labels plus whatever
 * the individual source reads; the host passes one object and the renderer
 * forwards it verbatim.
 */
export type ModuleListSourceLabels = YomitanDictionaryListLabels;

export interface ModuleListSourceProps {
  /** The module's whole options tree (sources write through `onChange`). */
  options: Options;
  /** Persist the next options tree. */
  onChange: (next: Options) => void;
  /** Already-localized copy for this source. */
  labels: ModuleListSourceLabels;
}

export type ModuleListSource = ComponentType<ModuleListSourceProps>;

/** Every list source the app implements, keyed by manifest `source` id. */
const MODULE_LIST_SOURCES: Readonly<Record<string, ModuleListSource>> = {
  'yomitan-dictionaries': DictionaryManager,
};

/** The adapter for a manifest-declared source id, or `undefined`. */
export function resolveModuleListSource(
  source: string | undefined,
): ModuleListSource | undefined {
  if (source === undefined) return undefined;
  return MODULE_LIST_SOURCES[source];
}