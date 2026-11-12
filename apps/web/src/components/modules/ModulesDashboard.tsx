/**
 * ModulesDashboard — `/modules/` module management screen.
 * ---------------------------------------------------------------------------
 * MODULE_ARCHITECTURE.md §5.2: lists every module the platform ships, with a
 * Switch per module so a learner can turn off what they do not use (KISS /
 * lightweight-by-default), plus a placeholder import entry for future
 * community modules.
 *
 * Persistence: `entei.modules.v1` via features/modules/modules-store
 * (schema-validated, defaults to all-on when storage is empty or corrupted).
 * The store is pure logic and unit-tested separately; this island only owns
 * the render + the switch handler.
 *
 * Copy comes from the dictionary (id / ja / en) passed by the Astro page, and
 * the island listens to `entei:locale-change` so the labels follow the
 * in-app language switcher (React text is outside the `[data-i18n]` pass).
 * ---------------------------------------------------------------------------
 */

'use client';

import { useEffect, useState } from 'react';
import {
  Blocks,
  BrainCircuit,
  Download,
  Magnet,
  MessageSquareText,
  Puzzle,
  type LucideIcon,
} from 'lucide-react';
import { Switch } from '@/components/player/ui/switch';
import {
  getRegisteredModules,
  type EnteiModuleCategory,
  type EnteiModuleId,
  type EnteiModuleManifest,
  type ModuleEnabledState,
  readModuleState,
  toggleModuleState,
  writeModuleState,
} from '@/features/modules/modules-store';
import { MODULES_CHANGED_EVENT } from '@/features/modules/use-module-registry';
import {
  LOCALE_CHANGE_EVENT,
  type LocaleChangeDetail,
} from '@i18n/locale-events';
import { trace } from '@/features/trace/trace-logger';
import type { Dictionary } from '@i18n/types';

export interface ModulesDashboardProps {
  /** Modules page copy (all strings — serializable across the island). */
  dict: Dictionary['modulesPage'];
}

/** Lucide icon per manifest `icon` name (manifests stay serializable). */
const ICONS: Record<string, LucideIcon> = {
  Download,
  Magnet,
  Puzzle,
  MessageSquareText,
  BrainCircuit,
};

/** Resolve a manifest's localized name (dictionary key or literal). */
function moduleName(
  module: EnteiModuleManifest,
  dict: Dictionary['modulesPage'],
): string {
  if (module.nameKey !== undefined) {
    const localized = (dict as unknown as Record<string, unknown>)[
      module.nameKey
    ];
    if (typeof localized === 'string' && localized !== '') return localized;
  }
  return module.name ?? module.id;
}

/** Resolve a manifest's localized description. */
function moduleDescription(
  module: EnteiModuleManifest,
  dict: Dictionary['modulesPage'],
): string {
  if (module.descriptionKey !== undefined) {
    const localized = (dict as unknown as Record<string, unknown>)[
      module.descriptionKey
    ];
    if (typeof localized === 'string' && localized !== '') return localized;
  }
  return module.description ?? '';
}

export function ModulesDashboard({ dict }: ModulesDashboardProps) {
  const [copy, setCopy] = useState(dict);
  /* The merged registry (built-in + imported `*.module.json`). */
  const [modules, setModules] = useState<EnteiModuleManifest[]>(() =>
    getRegisteredModules(),
  );
  const [enabled, setEnabled] = useState<ModuleEnabledState>(() =>
    readModuleState(),
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const dictionary = (event as CustomEvent<LocaleChangeDetail>).detail
        ?.dictionary;
      if (!dictionary) return;
      setCopy(dictionary.modulesPage);
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  /* Re-read when the registry changes (same-tab import or cross-tab toggle). */
  useEffect(() => {
    const sync = () => {
      setModules(getRegisteredModules());
      setEnabled(readModuleState());
    };
    window.addEventListener(MODULES_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(MODULES_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // The dashboard is the only place a module can be switched off, so record
  // what state the screen opened with (the import button is disabled today:
  // community modules are not loadable yet).
  useEffect(() => {
    trace('modules', 'dashboard_ready', {
      enabled: readModuleState(),
      importAvailable: false,
    });
  }, []);

  function handleToggle(id: EnteiModuleId) {
    const nextState = toggleModuleState(enabled, id);
    setEnabled(nextState);
    writeModuleState(nextState);
    trace('modules', 'module_toggle', {
      moduleId: id,
      enabled: nextState[id],
      enabledCount: Object.values(nextState).filter(Boolean).length,
    });
  }

  function categoryLabel(category: EnteiModuleCategory): string {
    if (category === 'source') return copy.categorySource;
    if (category === 'dictionary') return copy.categoryDictionary;
    return '';
  }

  return (
    <section className="entei-modules" aria-labelledby="entei-modules-title">
      <header className="entei-modules-header">
        <div className="entei-modules-header-row">
          <div className="entei-modules-heading">
            <h1
              id="entei-modules-title"
              className="entei-modules-title"
              data-i18n="modulesPage.title"
            >
              {copy.title}
            </h1>
            <p
              className="entei-modules-description"
              data-i18n="modulesPage.description"
            >
              {copy.description}
            </p>
          </div>

          <div className="entei-modules-import">
            <button
              type="button"
              className="entei-modules-import-button"
              disabled
              aria-describedby="entei-modules-import-hint"
            >
              {copy.importLabel}
            </button>
            <p
              id="entei-modules-import-hint"
              className="entei-modules-import-hint"
            >
              {copy.importHint}
            </p>
          </div>
        </div>
      </header>

      <ul className="entei-modules-list">
        {modules.map((module) => {
          const Icon =
            (module.icon !== undefined ? ICONS[module.icon] : undefined) ??
            Blocks;
          const isOn = enabled[module.id] === true;
          const name = moduleName(module, copy);
          return (
            <li className="entei-module-card" key={module.id}>
              <span className="entei-module-icon" aria-hidden="true">
                <Icon size={20} />
              </span>
              <div className="entei-module-head">
                <h3 className="entei-module-name" title={name}>
                  {name}
                </h3>
                {module.builtIn && (
                  <span className="entei-module-badge">{copy.builtIn}</span>
                )}
              </div>
              <div className="entei-module-toggle">
                <Switch
                  id={`entei-module-switch-${module.id}`}
                  checked={isOn}
                  onCheckedChange={() => handleToggle(module.id)}
                  aria-label={name}
                />
              </div>
              <p className="entei-module-description">
                {moduleDescription(module, copy)}
              </p>
              <p className="entei-module-meta">
                <span>{categoryLabel(module.category)}</span>
                <span>v{module.version}</span>
                <span>{module.author}</span>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
