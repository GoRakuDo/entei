/**
 * modules-store — platform module registry + enabled-state persistence.
 * ---------------------------------------------------------------------------
 * MODULE_ARCHITECTURE.md §5: every capability of the platform is a module
 * (official core modules today, imported community modules later). The
 * enabled/disabled state of each module lives in localStorage under
 * `entei.modules.v1` so the player can honour it without a server.
 *
 * The stored payload is intentionally minimal — a schema version plus an
 * `enabled` map keyed by module id. Manifests themselves are code (built-in
 * modules ship with the app), so they are never persisted: renaming or
 * adding a built-in module must not depend on user storage.
 *
 * Name/description are dictionary KEYS, not literals, so the dashboard
 * renders localized copy (id / ja / en) from the same manifest.
 * ---------------------------------------------------------------------------
 */

/** Module categories (MODULE_ARCHITECTURE.md §5.1). */
export type EnteiModuleCategory = 'source' | 'dictionary' | 'mining' | 'tool';

/** Built-in module identifiers. */
export type EnteiModuleId = 'ytdlp' | 'torrent' | 'yomitan';

/** Dictionary keys of `Dictionary['modulesPage']` used for module copy. */
export type ModuleCopyKey =
  | 'ytdlpName'
  | 'ytdlpDescription'
  | 'torrentName'
  | 'torrentDescription'
  | 'yomitanName'
  | 'yomitanDescription';

/** One module entry (MODULE_ARCHITECTURE.md §5.1). */
export interface EnteiModuleManifest {
  id: EnteiModuleId;
  /** Dictionary key for the localized display name. */
  nameKey: ModuleCopyKey;
  /** Dictionary key for the localized description. */
  descriptionKey: ModuleCopyKey;
  version: string;
  author: string;
  /** Lucide icon name rendered by the dashboard (falls back to Blocks). */
  icon: 'Download' | 'Magnet' | 'BookOpen';
  category: EnteiModuleCategory;
  /** Official built-in module (vs. a future imported community module). */
  builtIn: boolean;
  /** Enabled state when the user has never toggled it. */
  defaultEnabled: boolean;
}

/** localStorage key (versioned). */
export const MODULES_KEY = 'entei.modules.v1';

/** Persisted schema version. */
export const MODULES_SCHEMA_VERSION = 1;

/** Official core modules — MODULE_ARCHITECTURE.md §2 + §5.2. */
export const CORE_MODULES: readonly EnteiModuleManifest[] = [
  {
    id: 'ytdlp',
    nameKey: 'ytdlpName',
    descriptionKey: 'ytdlpDescription',
    version: '2026.1.0',
    author: 'Entei',
    icon: 'Download',
    category: 'source',
    builtIn: true,
    defaultEnabled: true,
  },
  {
    id: 'torrent',
    nameKey: 'torrentName',
    descriptionKey: 'torrentDescription',
    version: '2026.1.0',
    author: 'Entei',
    icon: 'Magnet',
    category: 'source',
    builtIn: true,
    defaultEnabled: true,
  },
  {
    id: 'yomitan',
    nameKey: 'yomitanName',
    descriptionKey: 'yomitanDescription',
    version: '1.0.0',
    author: 'GoRakuDo',
    icon: 'BookOpen',
    category: 'dictionary',
    builtIn: true,
    defaultEnabled: true,
  },
] as const;

/** Enabled state per module id. */
export type ModuleEnabledState = Record<EnteiModuleId, boolean>;

/** Default state derived from the manifests (all core modules ON). */
export const DEFAULT_MODULE_STATE: ModuleEnabledState = CORE_MODULES.reduce(
  (acc, module) => {
    acc[module.id] = module.defaultEnabled;
    return acc;
  },
  {} as ModuleEnabledState,
);

function isModuleId(value: string): value is EnteiModuleId {
  return CORE_MODULES.some((module) => module.id === value);
}

/** Read the persisted enabled state; falls back to defaults on any failure. */
export function readModuleState(): ModuleEnabledState {
  const state: ModuleEnabledState = { ...DEFAULT_MODULE_STATE };
  try {
    const raw = localStorage.getItem(MODULES_KEY);
    if (raw === null) return state;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return state;
    const enabled = (parsed as Record<string, unknown>).enabled;
    if (typeof enabled !== 'object' || enabled === null) return state;
    for (const [id, value] of Object.entries(
      enabled as Record<string, unknown>,
    )) {
      // Unknown ids (removed modules) and non-boolean values are dropped.
      if (isModuleId(id) && typeof value === 'boolean') state[id] = value;
    }
    return state;
  } catch {
    return state; // storage unavailable or corrupted
  }
}

/** Persist the enabled state. Failures are silently ignored (preference only). */
export function writeModuleState(state: ModuleEnabledState): void {
  try {
    localStorage.setItem(
      MODULES_KEY,
      JSON.stringify({ version: MODULES_SCHEMA_VERSION, enabled: state }),
    );
  } catch {
    // storage unavailable — ignore (preference only)
  }
}

/** Pure toggle — returns the next state (does not persist). */
export function toggleModuleState(
  state: ModuleEnabledState,
  id: EnteiModuleId,
): ModuleEnabledState {
  return { ...state, [id]: !state[id] };
}
