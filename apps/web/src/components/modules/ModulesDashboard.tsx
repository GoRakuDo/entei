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
import { BookOpen, Download, Magnet, type LucideIcon } from 'lucide-react';
import { Switch } from '@/components/player/ui/switch';
import {
  CORE_MODULES,
  type EnteiModuleCategory,
  type EnteiModuleId,
  type ModuleEnabledState,
  readModuleState,
  toggleModuleState,
  writeModuleState,
} from '@/features/modules/modules-store';
import {
  LOCALE_CHANGE_EVENT,
  type LocaleChangeDetail,
} from '@i18n/locale-events';
import type { Dictionary } from '@i18n/types';

export interface ModulesDashboardProps {
  /** Modules page copy (all strings — serializable across the island). */
  dict: Dictionary['modulesPage'];
}

const ICONS: Record<string, LucideIcon> = {
  Download,
  Magnet,
  BookOpen,
};

export function ModulesDashboard({ dict }: ModulesDashboardProps) {
  const [copy, setCopy] = useState(dict);
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

  function handleToggle(id: EnteiModuleId) {
    const nextState = toggleModuleState(enabled, id);
    setEnabled(nextState);
    writeModuleState(nextState);
  }

  function categoryLabel(category: EnteiModuleCategory): string {
    if (category === 'source') return copy.categorySource;
    if (category === 'dictionary') return copy.categoryDictionary;
    return '';
  }

  return (
    <section className="entei-modules" aria-labelledby="entei-modules-title">
      <header className="entei-modules-header">
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
      </header>

      <h2 className="entei-modules-heading">{copy.coreHeading}</h2>

      <ul className="entei-modules-list">
        {CORE_MODULES.map((module) => {
          const Icon = ICONS[module.icon] ?? BookOpen;
          const isOn = enabled[module.id];
          const name = copy[module.nameKey];
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
                {copy[module.descriptionKey]}
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
    </section>
  );
}
