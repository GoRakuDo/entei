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
  icon?: 'Download' | 'Magnet' | 'BookOpen' | 'MessageSquareText' | 'BrainCircuit';
  /** Path to the module icon asset (e.g. '/icons/modules/ytdlp.svg'). */
  iconPath?: string;
  /** Dictionary key for the localized display name (built-in modules). */
  nameKey?: ModuleCopyKey;
  /** Dictionary key for the localized description (built-in modules). */
  descriptionKey?: ModuleCopyKey;
  /** Literal display name (imported modules — no dictionary entry). */
  name?: string;
  /** Literal description (imported modules). */
  description?: string;
  /**
   * Self-describing settings tree. When present, the module's settings page
   * renders straight from it — no page-side knowledge of the module at all.
   */
  settingsSchema?: readonly SettingSectionDescriptor[];
}

/** Current `*.module.json` spec version. */
export const MODULE_MANIFEST_VERSION = 1;

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

/** Official core modules — MODULE_ARCHITECTURE.md §2 + §5.2. */
export const CORE_MODULES: readonly EnteiModuleManifest[] = [
  {
    id: 'ytdlp',
    nameKey: 'ytdlpName',
    descriptionKey: 'ytdlpDescription',
    manifestVersion: MODULE_MANIFEST_VERSION,
    version: '2026.07.04',
    author: 'Entei',
    icon: 'Download',
    iconPath: '/icons/modules/ytdlp.svg',
    category: 'source',
    builtIn: true,
    defaultEnabled: true,
  },
  {
    id: 'torrent',
    nameKey: 'torrentName',
    descriptionKey: 'torrentDescription',
    manifestVersion: MODULE_MANIFEST_VERSION,
    version: '9.1.0',
    author: 'Entei',
    icon: 'Magnet',
    iconPath: '/icons/modules/torrent.svg',
    category: 'source',
    builtIn: true,
    defaultEnabled: true,
  },
  {
    id: 'yomitan',
    nameKey: 'yomitanName',
    descriptionKey: 'yomitanDescription',
    manifestVersion: MODULE_MANIFEST_VERSION,
    version: '0.1.1',
    author: 'GoRakuDo',
    icon: 'BookOpen',
    iconPath: '/icons/modules/yomitan.svg',
    category: 'dictionary',
    builtIn: true,
    defaultEnabled: true,
    settingsSchema: YOMITAN_SETTINGS_SCHEMA,
  },
  {
    id: 'jimaku',
    nameKey: 'jimakuName',
    descriptionKey: 'jimakuDescription',
    manifestVersion: MODULE_MANIFEST_VERSION,
    version: '2026.07.04',
    author: 'Entei',
    icon: 'MessageSquareText',
    iconPath: '/icons/modules/jimaku.svg',
    category: 'source',
    builtIn: true,
    defaultEnabled: true,
  },
  {
    id: 'nadeshiko',
    nameKey: 'nadeshikoName',
    descriptionKey: 'nadeshikoDescription',
    manifestVersion: MODULE_MANIFEST_VERSION,
    version: '2026.07.04',
    author: 'Entei',
    icon: 'BrainCircuit',
    iconPath: '/icons/modules/nadeshiko.svg',
    category: 'dictionary',
    builtIn: true,
    defaultEnabled: true,
  },
] as const;

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
      icon: 'BookOpen',
      ...(typeof raw.iconPath === 'string' && raw.iconPath.trim() !== ''
        ? { iconPath: raw.iconPath.trim() }
        : {}),
      name,
      description:
        typeof raw.description === 'string' ? raw.description.trim() : '',
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