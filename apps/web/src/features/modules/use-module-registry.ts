/**
 * use-module-registry — the live merged module registry for React surfaces.
 * ---------------------------------------------------------------------------
 * `module-registry` owns the `*.module.json` spec and the merge (built-in +
 * imported). This hook only makes that merge reactive:
 *
 * - re-reads when the user enables/disables a module on `/modules/` in another
 *   tab (the browser fires `storage` there), and
 * - re-reads when a manifest is imported in this tab (`entei:modules-changed`).
 *
 * Same-tab navigation re-mounts the settings island, so the mount read covers
 * the common path.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useEffect, useState } from 'react';
import {
  getRegisteredModules,
  readModuleState,
  type EnteiModuleManifest,
  type ModuleEnabledState,
} from '@/features/modules/modules-store';

/** Fired after an import so same-tab surfaces re-read the registry. */
export const MODULES_CHANGED_EVENT = 'entei:modules-changed';

export interface ModuleRegistrySnapshot {
  /** Every registered manifest — built-ins first, then imported. */
  modules: EnteiModuleManifest[];
  /** Enabled state per module id. */
  enabled: ModuleEnabledState;
}

function read(): ModuleRegistrySnapshot {
  return { modules: getRegisteredModules(), enabled: readModuleState() };
}

/** Live registry snapshot, refreshed on cross-tab / same-tab registry changes. */
export function useModuleRegistry(): ModuleRegistrySnapshot {
  const [snapshot, setSnapshot] = useState<ModuleRegistrySnapshot>(read);

  useEffect(() => {
    const sync = () => setSnapshot(read());
    window.addEventListener('storage', sync);
    window.addEventListener(MODULES_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(MODULES_CHANGED_EVENT, sync);
    };
  }, []);

  return snapshot;
}