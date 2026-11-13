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
 * LAYOUTS ARE MANIFEST DATA TOO: a field whose editor is a list of installed
 * items is declared with `listFields` (field + `layout` + host `source`). The
 * app owns one such layout (`components/settings/ModuleListManager`) and the
 * host-owned data sources (`components/settings/module-list-sources`); which
 * field gets which layout is never written in the page.
 *
 * Copy: `nameKey` / `descriptionKey` are DICTIONARY KEYS for built-ins (the
 * three locales own the strings). An imported manifest has no dictionary entry,
 * so it carries literal `name` / `description` and `nameKey` is absent.
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

/** Standard layout sets the app can draw a field with. */
export type EnteiModuleListLayout = 'list-manager';

/**
 * One `listFields` entry: bind a field of the module's options tree to one of
 * the app's standard list layouts, backed by a host-owned data source.
 */
export interface EnteiModuleListBinding {
  /** Dot-path of the field (e.g. `'dictionaries'`). */
  field: string;
  /** Which standard layout set draws it. */
  layout: EnteiModuleListLayout;
  /** Host-owned source id that supplies the rows. */
  source: string;
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
   * Fields that draw through one of the app's standard list layouts instead of
   * a generic control. The renderer resolves `source` against the host
   * registry; an unknown source degrades to the read-only note.
   */
  listFields?: readonly EnteiModuleListBinding[];
  /**
   * Self-describing settings tree. When present, the module's settings page
   * renders straight from it — no page-side knowledge of the module at all.
   */
  settingsSchema?: readonly SettingSectionDescriptor[];
}

/** Current `*.module.json` spec version. */
export const MODULE_MANIFEST_VERSION = 1;

/** Layout ids a manifest may name in `listFields`. */
const LIST_LAYOUTS: readonly EnteiModuleListLayout[] = ['list-manager'];

/**
 * Validate the `listFields` array of a manifest.
 *
 * Fail-closed per entry: a malformed binding is dropped rather than half
 * applied, so the renderer can trust that every binding it receives is
 * addressable (non-empty field + source) and names a layout the app has.
 */
export function normalizeListFields(input: unknown): EnteiModuleListBinding[] {
  if (!Array.isArray(input)) return [];
  const bindings: EnteiModuleListBinding[] = [];
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const field = typeof raw.field === 'string' ? raw.field.trim() : '';
    const source = typeof raw.source === 'string' ? raw.source.trim() : '';
    const layout = LIST_LAYOUTS.find((value) => value === raw.layout);
    if (field === '' || source === '' || layout === undefined) continue;
    bindings.push({ field, layout, source });
  }
  return bindings;
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
      listFields: normalizeListFields(manifest.listFields),
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
      listFields: normalizeListFields(raw.listFields),
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