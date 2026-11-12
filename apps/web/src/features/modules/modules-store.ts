/**
 * modules-store — enabled-state persistence for the platform modules.
 * ---------------------------------------------------------------------------
 * MODULE_ARCHITECTURE.md §5: every capability of the platform is a module
 * (official core modules today, imported community modules later). Manifests
 * live in `module-registry` (the `*.module.json` spec + the merged registry);
 * THIS file owns only what the user changes about them: enabled / disabled.
 *
 * The stored payload is intentionally minimal — a schema version plus an
 * `enabled` map keyed by module id. Manifests themselves are never persisted
 * here: renaming or versioning a built-in module must not depend on user
 * storage.
 *
 * Because the registry is dynamic, an unknown id in the stored map is KEPT
 * (an imported manifest may legitimately appear between sessions) while the
 * enabled state of a module the registry no longer knows is simply unused.
 * ---------------------------------------------------------------------------
 */

import { CORE_MODULES } from '@/features/modules/module-registry';

export type {
  EnteiModuleCategory,
  EnteiModuleId,
  EnteiModuleManifest,
  ModuleCopyKey,
} from '@/features/modules/module-registry';
export {
  CORE_MODULES,
  MODULE_IMPORTS_KEY,
  MODULE_MANIFEST_VERSION,
  getRegisteredModules,
  hasSettingsSchema,
  parseModuleManifest,
  readImportedModules,
} from '@/features/modules/module-registry';

/** localStorage key (versioned). */
export const MODULES_KEY = 'entei.modules.v1';

/** Persisted schema version. */
export const MODULES_SCHEMA_VERSION = 1;

/** Enabled state per module id. */
export type ModuleEnabledState = Record<string, boolean>;

/** Default state derived from the built-in manifests (all core modules ON). */
export const DEFAULT_MODULE_STATE: ModuleEnabledState = CORE_MODULES.reduce(
  (acc, module) => {
    acc[module.id] = module.defaultEnabled;
    return acc;
  },
  {} as ModuleEnabledState,
);

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
      // Non-boolean values are dropped; unknown ids are kept for imported
      // manifests that are not installed (yet).
      if (typeof value === 'boolean') state[id] = value;
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
  id: string,
): ModuleEnabledState {
  return { ...state, [id]: !state[id] };
}