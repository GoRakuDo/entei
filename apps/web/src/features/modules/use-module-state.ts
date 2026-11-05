/**
 * use-module-state — live enabled-state of the platform modules.
 * ---------------------------------------------------------------------------
 * MODULE_ARCHITECTURE.md §5.3 (phase 2-B): the player honours module toggles at
 * runtime. `modules-store` owns persistence; this hook only exposes the current
 * snapshot to React and keeps it fresh when the user toggles a module on
 * `/modules/` in another tab (the browser fires `storage` there).
 *
 * Same-tab navigation re-mounts the player islands, so the mount read covers
 * the common path; the `storage` listener covers a second tab/window.
 * --------------------------------------------------------------------------- */

'use client';

import { useEffect, useState } from 'react';
import {
  readModuleState,
  type ModuleEnabledState,
} from '@/features/modules/modules-store';

/** Current enabled state per module id, re-read on cross-tab changes. */
export function useModuleState(): ModuleEnabledState {
  const [state, setState] = useState<ModuleEnabledState>(readModuleState);

  useEffect(() => {
    const sync = () => setState(readModuleState());
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  return state;
}
