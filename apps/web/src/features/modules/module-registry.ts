/**
 * module-registry — the `*.module.json` manifest spec + the unified dynamic
 * registry (MODULE_ARCHITECTURE.md §5).
 * ---------------------------------------------------------------------------
 * One shape describes EVERY module the platform knows about:
 *
 * - CORE_MODULES  — the built-in modules that ship inside the app (code
 *   manifests, so renaming or versioning one never depends on user storage).
 * - imported       — `*.module.json` files a learner installs later. They are
 *   validated against the same spec and persisted (localStorage, mirrored to
 *   the desktop SQLite `kv_store` by settings-store).
 *
 * `getRegisteredModules()` MERGES both sources, built-ins first, so a single
 * call feeds every consumer: the settings Modules grid, the sidebar's Modul
 * submenu, `/modules/`, and the player's module gates. Nothing downstream
 * needs to know where a manifest came from.
 *
 * UNKNOWN FIELDS, NOT UNKNOWN IDS: an imported manifest may carry a
 * `settingsSchema` (its own descriptor tree). `yomitan` uses exactly that to
 * hand its 18 Chrome-compatible sections to the renderer instead of hard-coding
 * them in the page — the same code path a community module will use.
 *
 * LAYOUTS ARE MANIFEST DATA TOO: a section whose editor is not a plain field
 * list is declared with `sectionLayouts` — an ordered row list, each row naming
 * one of the app's standard layouts (`list` / `field` / `usage` / `inputs`), the
 * field it edits, the host-owned data `source` behind it and its own text.
 * The app owns the layouts (`components/settings/ModuleListManager`,
 * `ModuleFieldRow`, `ModuleSelectPairRow`, `ModuleUsageMeter`) and the host-owned
 * data sources
 * (`components/settings/module-data-sources`); which field gets which layout is
 * never written in the page.
 *
 * Copy: `nameKey` / `descriptionKey` are DICTIONARY KEYS for built-ins (the
 * three locales own the module card's own strings). An imported manifest has no
 * dictionary entry, so it carries literal `name` / `description` and `nameKey`
 * is absent.
 *
 * A section-layout row works the same way: it carries LITERAL text (`label` /
 * `description` / `action` / `usage` / `none`) and, for the strings a platform
 * layout owns itself, the NAME of a built-in English table in
 * `components/settings/module-copy` (`copy: "dictionaries"`). Yomitan's
 * settings surface is the Chrome extension's own UI, so its rows ship the
 * upstream English text in the manifest and the app locales stay out of it.
 * ---------------------------------------------------------------------------
 */

import type { SettingSectionDescriptor } from '@gorakudo/yomitan-headless/settings';
import { yomitanSettingsTree } from '@gorakudo/yomitan-headless/settings';

/** Module categories (MODULE_ARCHITECTURE.md §5.1). */
export type EnteiModuleCategory = 'source' | 'dictionary' | 'mining' | 'tool';

/** Built-in module identifiers. Open-ended: the registry is dynamic. */
export type EnteiModuleId = string;

/** Dictionary keys of `Dictionary['modulesPage']` used for module copy. */
export type ModuleCopyKey =
  | 'ytdlpName'
  | 'ytdlpDescription'
  | 'torrentName'
  | 'torrentDescription'
  | 'yomitanName'
  | 'yomitanDescription'
  | 'jimakuName'
  | 'jimakuDescription'
  | 'nadeshikoName'
  | 'nadeshikoDescription';

/**
 * Layout ids a manifest may name for one row of a section layout.
 *
 * - `list`   — CRUD over installed items (`ModuleListManager`)
 * - `field`  — one standard settings row (`ModuleFieldRow`)
 * - `usage`  — a measured-usage row (`ModuleUsageMeter`)
 * - `inputs` — CRUD over an array of structured INPUT DEFINITIONS, each drawn as
 *   its own bordered card of standard rows. Where `list` edits installed ITEMS
 *   (a name, an enable switch, a delete), `inputs` edits BEHAVIOUR objects whose
 *   every card carries fields of its own — Yomitan's `scanning.inputs[]`, one
 *   card per trigger definition.
 * - `selects` — one row holding SEVERAL mini-labelled selects side by side, each
 *   bound to its own field (`ModuleSelectPairRow`). Upstream Yomitan pairs two
 *   related knobs under one label this way (Theme: Body + Shadow).
 * - `numbers` — the same row for NUMERIC knobs: several mini-labelled number
 *   inputs side by side, each bound to its own field (`ModuleNumberGroupRow`).
 *   Upstream pairs its pixel/offset knobs this way (Popup Position & Size: `Size`
 *   is a Width and a Height input on one line).
 */
export type EnteiModuleRowLayout =
  | 'list'
  | 'field'
  | 'usage'
  | 'inputs'
  | 'selects'
  | 'checkboxes'
  | 'numbers';

/**
 * One choice of a `selects` row's control.
 *
 * Declared by the row itself, not read from the descriptor: an upstream pair
 * ships its own option ORDER and wording (Theme's `site` is `Auto`, and it comes
 * first), which the tree's own list does not reproduce.
 */
export interface EnteiModuleSelectOption {
  /** Value written into the options tree. */
  value: string;
  /** Literal English label (this surface is the upstream tool's own UI). */
  label: string;
}

/** One mini-labelled select of a `selects` row. */
export interface EnteiModuleSelectBinding {
  /** Mini label above the control (`Body`, `Shadow`, `Visibility`, …). */
  label: string;
  /** Dot-path of the field this control edits. */
  field: string;
  /** Choices of this control, in draw order. */
  options: readonly EnteiModuleSelectOption[];
}

/**
 * The mini-label + field-path pair every GROUPED row item is made of.
 *
 * Shared by the layouts that draw SEVERAL controls under one row label
 * (`checkboxes`, `numbers`): each item captions one control and names the option
 * path it edits, so the renderer wires every one of them the same way — through
 * the module's options store, exactly like the equivalent single-field row.
 */
export interface EnteiModuleLabeledBinding {
  /** Mini label beside/above the control (`Downstep notation`, `Width`, …). */
  label: string;
  /** Dot-path of the field this control edits. */
  field: string;
}

/**
 * One mini-labelled checkbox of a `checkboxes` row.
 *
 * The row groups several independent booleans under one label (Yomitan's
 * "Pitch accent display styles": Downstep notation / Downstep position / Graph
 * on a single line).
 */
export type EnteiModuleCheckboxBinding = EnteiModuleLabeledBinding;

/**
 * One mini-labelled number input of a `numbers` row.
 *
 * The row groups several independent numbers under one label (Yomitan's `Size`:
 * a Width and a Height input on one line). The control takes its min/max/step
 * from the field's own descriptor, so a value written here is the same number the
 * single-field numeric row would write.
 */
export type EnteiModuleNumberBinding = EnteiModuleLabeledBinding;

/**
 * Name of a built-in English copy table a platform layout draws its own strings
 * from (see `components/settings/module-copy`). Open-ended like every other
 * manifest id: an unknown name resolves to nothing and the layout falls back to
 * its own empty string, so a typo can never render `undefined`.
 */
export type ModuleCopyTableName = string;

/**
 * One row of a manifest-declared section layout.
 *
 * `field` addresses a dot-path of the module's `settingsSchema` (the descriptor
 * decides the control); `source` names a host-owned data source. The row's TEXT
 * is literal: `label` / `description` win over the descriptor's own English,
 * which stays the fallback for a row that declares none.
 *
 * A layout the platform implements owns copy of its own (`list`, `inputs`, and
 * the `{used}`/`{total}` sentence of `usage`). Such a row names one of the
 * built-in English tables by id (`copy`); the app owns those strings, so no
 * manifest restates them and no locale translates them.
 */
export interface EnteiModuleRowBinding {
  /** Which standard layout draws this row. */
  layout: EnteiModuleRowLayout;
  /**
   * Dot-path of the field this row edits — omitted only by a row the host draws
   * whole (`list` / `inputs` rows, and a `field` row whose editor is a block the
   * app composes rather than a value the tree holds).
   */
  field?: string;
  /** Host-owned source id (`list`, `inputs`, `usage` and host-owned `field` rows). */
  source?: string;
  /** Host-owned source id supplying a `field` row's select options. */
  optionsSource?: string;
  /**
   * Literal choices of a `field` row's select, written by the manifest itself.
   *
   * The descriptor's own option list is the fallback; a row that needs a specific
   * wording the tree does not reproduce — upstream Yomitan's own settings.html
   * labels (`Vertical bar (left)`, `Term furigana`, …) — ships its own list here.
   * The VALUES match the descriptor's, so the written value and the field type are
   * unchanged; only the display text differs. Ignored for a non-select control.
   */
  options?: readonly EnteiModuleSelectOption[];
  /**
   * Built-in English copy table of the layout drawing this row — the strings
   * that layout owns itself (`list` / `inputs`, and a `usage` row's sentence).
   */
  copy?: ModuleCopyTableName;
  /** Row label (wins over the descriptor's own label). */
  label?: string;
  /** Row description under the label (wins over the descriptor's). */
  description?: string;
  /** Action button label of a `usage` row. */
  action?: string;
  /** Sentence template of a `usage` row, with `{used}` / `{total}`. */
  usage?: string;
  /** Leading "none" option of a `field` row's select. */
  none?: string;
  /**
   * Controls of a `selects` row: two or more mini-labelled selects drawn side by
   * side in the row's control column, each with its own literal choices. The row's
   * own `label` / `description` are the text block on the left; the items carry no
   * text of their own beyond their mini labels.
   */
  selects?: readonly EnteiModuleSelectBinding[];
  /**
   * Checkboxes of a `checkboxes` row: two or more mini-labelled boolean toggles
   * drawn side by side in the row's control column. The row's own `label` /
   * `description` are the text block on the left; each item is a real boolean
   * field path the renderer writes through the options store.
   */
  checkboxes?: readonly EnteiModuleCheckboxBinding[];
  /**
   * Number inputs of a `numbers` row: two or more mini-labelled numeric controls
   * drawn side by side in the row's control column. Like every grouped row the
   * row's own `label` / `description` are the text block on the left.
   */
  numbers?: readonly EnteiModuleNumberBinding[];
  /**
   * Control type of a row whose `field` has NO descriptor in the module's
   * `settingsSchema` — a HOST-DECLARED VIRTUAL FIELD.
   *
   * Yomitan's own tree cannot describe every knob worth exposing: a scan
   * modifier lives inside an array of scan inputs, so "which modifier" is one
   * value the app derives rather than a field the tree has. Such a row declares
   * its control here (`select` also needs an `optionsSource`; `boolean` needs
   * nothing else), and the app answers the path in its options store.
   *
   * Ignored when the tree DOES have the field — the descriptor always wins, so
   * an imported manifest cannot use this to override a real field's control.
   */
  type?: 'boolean' | 'select';
}

/**
 * Manifest-declared layout of one settings section: its rows, in draw order,
 * replacing the generic group walk for that section.
 */
export interface EnteiModuleSectionLayout {
  /** `key` of the section in the module's `settingsSchema`. */
  section: string;
  /** Rows to draw, top to bottom. */
  rows: readonly EnteiModuleRowBinding[];
}

/** One `*.module.json` document (the platform manifest spec). */
export interface EnteiModuleManifest {
  /** Stable identifier — also the `entei.modules.v1` state key. */
  id: EnteiModuleId;
  /** Manifest spec version this document was written against. */
  manifestVersion?: number;
  version: string;
  author: string;
  category: EnteiModuleCategory;
  /** Official module shipped with the app (vs. an imported community one). */
  builtIn: boolean;
  /** Enabled state when the user has never toggled it. */
  defaultEnabled: boolean;
  /** Lucide icon name rendered by the grid card (falls back to Blocks). */
  icon?:
    | 'Download'
    | 'Magnet'
    | 'BookOpen'
    | 'MessageSquareText'
    | 'BrainCircuit'
    | 'Blocks'
    | (string & {});
  /** Path to the module icon asset (e.g. '/icons/modules/ytdlp.png'). */
  iconPath?: string;
  /** Whether the module exposes a settings panel or custom settings. */
  hasSettings?: boolean;
  /**
   * Whether a rendered `settingsSchema` shows a leading icon on every section
   * header. The manifest decides; the renderer only draws what it is told to
   * (absent = off, so an imported module opts in explicitly).
   */
  showSectionIcons?: boolean;
  /** Dictionary key for the localized display name (built-in modules). */
  nameKey?: ModuleCopyKey;
  /** Dictionary key for the localized description (built-in modules). */
  descriptionKey?: ModuleCopyKey;
  /** Literal display name (imported modules — no dictionary entry). */
  name?: string;
  /** Literal description (imported modules). */
  description?: string;
  /**
   * Sections whose rows the manifest lays out itself, in place of the generic
   * group walk. The renderer resolves every row against the descriptor tree and
   * the host source registry; an unknown source degrades to the read-only note.
   */
  sectionLayouts?: readonly EnteiModuleSectionLayout[];
  /**
   * Self-describing settings tree. When present, the module's settings page
   * renders straight from it — no page-side knowledge of the module at all.
   */
  settingsSchema?: readonly SettingSectionDescriptor[];
}

/** Current `*.module.json` spec version. */
export const MODULE_MANIFEST_VERSION = 1;

/** Layout ids a manifest may name for a section-layout row. */
const ROW_LAYOUTS: readonly EnteiModuleRowLayout[] = [
  'list',
  'field',
  'usage',
  'inputs',
  'selects',
  'checkboxes',
  'numbers',
];

/**
 * The controls of a `selects` row, or `undefined` when none is usable.
 *
 * Fail-closed per CONTROL: one needs a label, a field and at least one choice
 * (a select with no options is a dead control), so a malformed item is dropped
 * rather than half applied. A row left with nothing is dropped by the caller.
 */
function parseSelectBindings(
  input: unknown,
): EnteiModuleSelectBinding[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const items: EnteiModuleSelectBinding[] = [];
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const label = optionalId(raw.label);
    const field = optionalId(raw.field);
    if (label === undefined || field === undefined) continue;
    const options: EnteiModuleSelectOption[] = [];
    for (const choice of Array.isArray(raw.options) ? raw.options : []) {
      if (typeof choice !== 'object' || choice === null) continue;
      const option = choice as Record<string, unknown>;
      const value = optionalId(option.value);
      const optionLabel = optionalId(option.label);
      if (value === undefined || optionLabel === undefined) continue;
      options.push({ value, label: optionLabel });
    }
    if (options.length === 0) continue;
    items.push({ label, field, options });
  }
  return items.length === 0 ? undefined : items;
}

/**
 * Validate the item array of a GROUPED row (`checkboxes`, `numbers`).
 *
 * Fail-closed per ITEM: each needs a label and a field (a control bound to no path
 * edits nothing). A row left with no usable item is dropped by the caller.
 */
function parseLabeledBindings(
  input: unknown,
): EnteiModuleLabeledBinding[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const items: EnteiModuleLabeledBinding[] = [];
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const label = optionalId(raw.label);
    const field = optionalId(raw.field);
    if (label === undefined || field === undefined) continue;
    items.push({ label, field });
  }
  return items.length === 0 ? undefined : items;
}

/** A non-empty trimmed string, or `undefined` (manifest fields are optional). */
function optionalId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Validate the `sectionLayouts` array of a manifest.
 *
 * Fail-closed per ROW: a malformed row is dropped rather than half applied, so
 * the renderer can trust that every row it receives is addressable — it names a
 * layout the app has and carries whatever that layout needs. A row is addressable
 * through its FIELD or through its SOURCE, and `usage` / `list` / `inputs` always
 * need the source: a `field` row may name a path in the options tree, or no path at
 * all when the host draws its whole editor (a credential lives in the module's own
 * store; Yomitan's popup preview is a block the app composes out of the tree). A
 * section left with no rows is dropped with it.
 *
 * A `field` row may also declare the CONTROL of a path the descriptor tree has
 * no field for (a host-declared virtual field). Only the two types the renderer
 * can draw without a descriptor survive here; anything else is dropped, so a
 * manifest cannot ask for an editor the app does not have.
 */
export function normalizeSectionLayouts(
  input: unknown,
): EnteiModuleSectionLayout[] {
  if (!Array.isArray(input)) return [];
  const layouts: EnteiModuleSectionLayout[] = [];
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const section = optionalId(raw.section);
    if (section === undefined) continue;
    const rows: EnteiModuleRowBinding[] = [];
    for (const item of Array.isArray(raw.rows) ? raw.rows : []) {
      if (typeof item !== 'object' || item === null) continue;
      const row = item as Record<string, unknown>;
      const layout = ROW_LAYOUTS.find(
        (value) => value === optionalId(row.layout),
      );
      const field = optionalId(row.field);
      const source = optionalId(row.source);
      const optionsSource = optionalId(row.optionsSource);
      if (layout === undefined) continue;
      if (layout === 'selects') {
        /* A `selects` row is addressable ONLY through its controls: each one names
           a field and its own choices, and a row with no usable control would draw
           an empty box. */
        const selects = parseSelectBindings(row.selects);
        if (selects === undefined) continue;
        const pairRow: EnteiModuleRowBinding = { layout, selects };
        const pairLabel = optionalId(row.label);
        if (pairLabel !== undefined) pairRow.label = pairLabel;
        const pairDescription = optionalId(row.description);
        if (pairDescription !== undefined) {
          pairRow.description = pairDescription;
        }
        rows.push(pairRow);
        continue;
      }
      if (layout === 'checkboxes') {
        /* A `checkboxes` row is addressable ONLY through its items: each names a
           boolean field path, and a row with no usable item would draw an empty
           box. */
        const checkboxes = parseLabeledBindings(row.checkboxes);
        if (checkboxes === undefined) continue;
        const checkboxRow: EnteiModuleRowBinding = { layout, checkboxes };
        const checkboxLabel = optionalId(row.label);
        if (checkboxLabel !== undefined) checkboxRow.label = checkboxLabel;
        const checkboxDescription = optionalId(row.description);
        if (checkboxDescription !== undefined) {
          checkboxRow.description = checkboxDescription;
        }
        rows.push(checkboxRow);
        continue;
      }
      if (layout === 'numbers') {
        /* A `numbers` row is addressable the same way: each item names a numeric
           field path, and a row with no usable item would draw an empty box. */
        const numbers = parseLabeledBindings(row.numbers);
        if (numbers === undefined) continue;
        const numberRow: EnteiModuleRowBinding = { layout, numbers };
        const numberLabel = optionalId(row.label);
        if (numberLabel !== undefined) numberRow.label = numberLabel;
        const numberDescription = optionalId(row.description);
        if (numberDescription !== undefined) {
          numberRow.description = numberDescription;
        }
        rows.push(numberRow);
        continue;
      }
      if (field === undefined && source === undefined) continue;
      if (layout !== 'field' && source === undefined) continue;
      const binding: EnteiModuleRowBinding = { layout };
      if (field !== undefined) binding.field = field;
      const type = optionalId(row.type);
      if (layout === 'field' && (type === 'boolean' || type === 'select')) {
        binding.type = type;
      }
      if (source !== undefined) binding.source = source;
      if (optionsSource !== undefined) binding.optionsSource = optionsSource;
      /* A `field` row may ship its own select choices (upstream's exact wording).
         Parsed with the same fail-closed-per-option rule as a `selects` control:
         a choice without a value or a label is dropped, and an empty list is
         treated as absent so the descriptor's own options stay the fallback. */
      if (layout === 'field' && Array.isArray(row.options)) {
        const options: EnteiModuleSelectOption[] = [];
        for (const choice of row.options) {
          if (typeof choice !== 'object' || choice === null) continue;
          const option = choice as Record<string, unknown>;
          const value = optionalId(option.value);
          const optionLabel = optionalId(option.label);
          if (value === undefined || optionLabel === undefined) continue;
          options.push({ value, label: optionLabel });
        }
        if (options.length > 0) binding.options = options;
      }
      /* The layout's own English table, then the row's literal text. Both are
         optional: a row naming neither falls back to the descriptor's English
         (or to the layout's own fallback for the copy it owns). */
      const copy = optionalId(row.copy);
      if (copy !== undefined) binding.copy = copy;
      for (const key of [
        'label',
        'description',
        'action',
        'usage',
        'none',
      ] as const) {
        const value = optionalId(row[key]);
        if (value !== undefined) binding[key] = value;
      }
      rows.push(binding);
    }
    if (rows.length === 0) continue;
    layouts.push({ section, rows });
  }
  return layouts;
}

/** localStorage key holding imported `*.module.json` documents. */
export const MODULE_IMPORTS_KEY = 'entei.modules.imported.v1';

/**
 * The settings subtree of the Yomitan Chrome extension.
 *
 * Declared once here (not inside a page component) so the descriptor tree is
 * data, exactly like an imported `*.module.json` would be. The renderer walks
 * it generically; adding a section upstream needs no Entei change.
 */
const YOMITAN_SETTINGS_SCHEMA: readonly SettingSectionDescriptor[] =
  yomitanSettingsTree;

/** Canonical registration order for built-in modules. */
const CORE_ORDER: readonly string[] = [
  'ytdlp',
  'torrent',
  'yomitan',
  'jimaku',
  'nadeshiko',
];

/** `import.meta` extras that only exist outside the browser bundle. */
interface NodeImportMeta extends ImportMeta {
  /** Bun/Node CJS shim — absent in browsers. */
  require?: (id: string) => unknown;
  /** Bun: absolute path of the directory holding this module. */
  dir?: string;
}

/**
 * Read every `*.module.json` under `<web root>/src/modules` straight from disk.
 *
 * Belt-and-braces only: BOTH runtimes this project uses already provide the
 * glob rewrite (Vite for the app, Bun 1.4.4 for `bun test`), so this path is
 * not reached today — and in a plain Node ESM process it cannot work at all
 * (`import.meta.require` does not exist there). It stays as the safety net for
 * a runner that has neither, where an empty registry is worse than a slow one.
 */
function loadManifestsFromDisk(): EnteiModuleManifest[] {
  const meta = import.meta as NodeImportMeta;
  if (typeof meta.require !== 'function') return [];
  try {
    const fs = meta.require('node:fs') as typeof import('node:fs');
    const path = meta.require('node:path') as typeof import('node:path');
    // This file lives in `<web root>/src/features/modules`, so the manifests sit
    // two directories up. The `cwd()` candidate covers a runner started from
    // the workspace root instead of `apps/web`.
    const candidates = [
      path.resolve(meta.dir ?? process.cwd(), '../../modules'),
      path.resolve(process.cwd(), 'src/modules'),
    ];
    const targetDir = candidates.find((candidate) => fs.existsSync(candidate));
    if (targetDir === undefined) return [];

    const manifests: EnteiModuleManifest[] = [];
    const scan = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (entry.isFile() && entry.name.endsWith('.module.json')) {
          const content = fs.readFileSync(full, 'utf-8');
          manifests.push(JSON.parse(content) as EnteiModuleManifest);
        }
      }
    };
    scan(targetDir);
    return manifests;
  } catch {
    // Unreadable directory / malformed JSON: the registry stays empty rather
    // than half-populated, and the caller surfaces the failure as no modules.
    return [];
  }
}

/**
 * Dynamically discover and load all `*.module.json` manifests located under
 * `/src/modules/` (MODULE_ARCHITECTURE.md §5.2).
 *
 * In Vite (dev & production build), `import.meta.glob` aggregates every
 * manifest without manual registry entries. The call is NOT feature-detected:
 * Vite statically replaces the CALL SITE with the aggregated module map, so
 * `typeof import.meta.glob` is `undefined` at runtime — guarding on it would
 * silently empty the registry in the shipped bundle.
 *
 * Bun's transpiler does the same replacement for `bun test` (Bun 1.4.4
 * implements `import.meta.glob` with Vite-compatible options), so both runtimes
 * take this branch; the catch is a safety net for anything that does not.
 */
function loadCoreManifests(): readonly EnteiModuleManifest[] {
  let manifests: EnteiModuleManifest[] = [];

  try {
    const globbed = import.meta.glob<EnteiModuleManifest>(
      '/src/modules/**/*.module.json',
      { eager: true, import: 'default' },
    );
    manifests = Object.values(globbed);
  } catch {
    manifests = loadManifestsFromDisk();
  }

  return manifests
    .map((manifest) => ({
      ...manifest,
      manifestVersion: manifest.manifestVersion ?? MODULE_MANIFEST_VERSION,
      // The manifest owns these: a JSON document may legitimately mark a
      // module off by default, and overriding it here would hide that.
      builtIn: manifest.builtIn ?? true,
      defaultEnabled: manifest.defaultEnabled ?? true,
      icon: manifest.icon ?? 'Blocks',
      showSectionIcons: manifest.showSectionIcons ?? false,
      sectionLayouts: normalizeSectionLayouts(manifest.sectionLayouts),
      ...(manifest.id === 'yomitan'
        ? { settingsSchema: YOMITAN_SETTINGS_SCHEMA }
        : {}),
    }))
    .sort((a, b) => {
      const indexA = CORE_ORDER.indexOf(a.id);
      const indexB = CORE_ORDER.indexOf(b.id);
      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      return a.id.localeCompare(b.id);
    });
}

/** Official core modules — dynamically loaded from `*.module.json` manifests. */
export const CORE_MODULES: readonly EnteiModuleManifest[] = loadCoreManifests();

const CATEGORIES: readonly EnteiModuleCategory[] = [
  'source',
  'dictionary',
  'mining',
  'tool',
];

/**
 * Validate an untrusted manifest (an imported `*.module.json`).
 *
 * Fail-closed: anything malformed is rejected with a reason rather than
 * half-rendered. A rejected manifest never reaches the registry, so the grid
 * and the sidebar can trust every entry they receive.
 */
export function parseModuleManifest(
  input: unknown,
): { ok: true; manifest: EnteiModuleManifest } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: 'manifest is not an object' };
  }
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id === '') return { ok: false, reason: 'id is required' };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return { ok: false, reason: `id "${id}" must be lowercase a-z, 0-9 or '-'` };
  }
  if (CORE_MODULES.some((module) => module.id === id)) {
    return { ok: false, reason: `id "${id}" collides with a built-in module` };
  }
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (version === '') return { ok: false, reason: 'version is required' };
  const author = typeof raw.author === 'string' ? raw.author.trim() : '';
  if (author === '') return { ok: false, reason: 'author is required' };
  const category = CATEGORIES.find((value) => value === raw.category);
  if (category === undefined) {
    return { ok: false, reason: `category must be one of ${CATEGORIES.join(', ')}` };
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '') return { ok: false, reason: 'name is required' };

  return {
    ok: true,
    manifest: {
      id,
      manifestVersion: MODULE_MANIFEST_VERSION,
      version,
      author,
      category,
      builtIn: false,
      // Imported modules default OFF: nothing runs until the user enables it.
      defaultEnabled: false,
      icon: (raw.icon as EnteiModuleManifest['icon']) ?? 'Blocks',
      showSectionIcons: raw.showSectionIcons === true,
      ...(typeof raw.iconPath === 'string' && raw.iconPath.trim() !== ''
        ? { iconPath: raw.iconPath.trim() }
        : {}),
      name,
      description:
        typeof raw.description === 'string' ? raw.description.trim() : '',
      sectionLayouts: normalizeSectionLayouts(raw.sectionLayouts),
    },
  };
}

/** Read the imported manifests; anything malformed is dropped, never fatal. */
export function readImportedModules(): EnteiModuleManifest[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(MODULE_IMPORTS_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return [];
    const list = (parsed as Record<string, unknown>).modules;
    if (!Array.isArray(list)) return [];
    const manifests: EnteiModuleManifest[] = [];
    for (const entry of list) {
      const result = parseModuleManifest(entry);
      if (result.ok) manifests.push(result.manifest);
    }
    return manifests;
  } catch {
    return []; // storage unavailable or corrupted
  }
}

/**
 * The unified registry: built-in manifests first, then imported ones.
 *
 * Every surface (settings grid, sidebar submenu, `/modules/`, player gates)
 * reads this, so a newly imported module appears everywhere at once with no
 * per-page wiring.
 */
export function getRegisteredModules(): EnteiModuleManifest[] {
  return [...CORE_MODULES, ...readImportedModules()];
}

/** True when a manifest carries its own renderable settings tree. */
export function hasSettingsSchema(
  module: EnteiModuleManifest | undefined,
): module is EnteiModuleManifest & {
  settingsSchema: readonly SettingSectionDescriptor[];
} {
  return (
    module !== undefined &&
    module.settingsSchema !== undefined &&
    module.settingsSchema.length > 0
  );
}