/**
 * module-copy — the platform's own ENGLISH copy for the layouts it implements.
 * ---------------------------------------------------------------------------
 * A module's settings manifest ships its own literal text (its rows are that
 * module's UI, in that module's own words). Some of those rows are drawn by a
 * layout the PLATFORM implements — the installed-item list, the scan-input cards
 * — and those layouts carry strings of their own that no module should have to
 * restate: `Import Dictionary (.zip)`, `Enable dictionary`, `Add New Key`.
 *
 * They live HERE, in English, and a row names a table by id (`copy:
 * "dictionaries"` for the list, `"scanningInputs"` for the cards). They are
 * deliberately NOT dictionary entries: the settings surface that renders them is
 * the upstream tool's own UI, whose text is English in every locale — a
 * per-locale translation of it is not what the user is looking at. Entei's own
 * settings copy is untouched; nothing outside these layouts reads this file.
 *
 * An unknown table name (or a missing key inside one) resolves to `undefined`,
 * so a mistyped id degrades to the layout's own empty string rather than
 * rendering `undefined` into the page.
 */

import type { ModuleListManagerCopy } from '@/components/settings/ModuleListManager';
import type { ScanningInputManagerCopy } from '@/components/settings/ScanningInputManager';

/** Copy of the `list` layout: CRUD over installed items. */
export const DICTIONARIES_COPY: ModuleListManagerCopy = {
  import: 'Import Dictionary (.zip)',
  importing: 'Importing…',
  importingProgress: 'Importing',
  empty: 'No dictionaries imported. Import a dictionary file (.zip) to start looking up terms.',
  enable: 'Enable dictionary',
  remove: 'Delete dictionary',
  definitionsCollapsible: 'Definitions collapsible',
  importFailed: 'Dictionary import failed',
  loadFailed: 'Installed dictionaries could not be read',
  reorder: 'Reorder dictionary',
  reorderHint:
    'Drag to change the priority, or press the up and down arrow keys.',
};

/** Copy of the `inputs` layout: one card per scan-input definition. */
export const SCANNING_INPUTS_COPY: ScanningInputManagerCopy = {
  add: 'Add New Key',
  count: '{count} defined',
  required: 'Required inputs:',
  excluded: 'Excluded inputs:',
  noInputs: 'No inputs',
  inputTypes: 'Input types:',
  mouse: 'Mouse',
  touch: 'Touch',
  pen: 'Pen',
  searchFor: 'Search for:',
  term: 'Term',
  kanji: 'Kanji',
  scanOn: 'Scan on:',
  tap: 'Tap',
  press: 'Press',
  release: 'Release',
  move: 'Move',
  preventScrolling: 'Prevent Scan on scrolling:',
  minimumTouchTime: 'Minimum Touch Time (in ms):',
  capture: 'Record a key or mouse button',
  listening: 'Press a key or mouse button (Esc cancels)',
  remove: 'Remove',
  empty:
    'No scanning inputs defined yet. Add a key to define when scanning happens.',
};

/** A copy table's shape: a flat map of strings (any layout's contract). */
export type ModuleCopyTable = {
  readonly [key: string]: string | undefined;
};

/** Widen one typed contract into the generic shape (an interface has no index
 *  signature of its own, so the annotation is what makes the table readable by
 *  key at all). */
function table<T extends object>(copy: T): ModuleCopyTable {
  return copy as unknown as ModuleCopyTable;
}

/** Every table a manifest may name in a row's `copy`. */
const MODULE_COPY_TABLES: Readonly<Record<string, ModuleCopyTable>> = {
  dictionaries: table(DICTIONARIES_COPY),
  scanningInputs: table(SCANNING_INPUTS_COPY),
};

/** One named table, or `undefined` for a name this app does not implement. */
export function resolveModuleCopyTable(
  name: string | undefined,
): ModuleCopyTable | undefined {
  if (name === undefined) return undefined;
  return MODULE_COPY_TABLES[name];
}