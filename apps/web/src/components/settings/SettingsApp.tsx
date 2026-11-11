/**
 * SettingsApp — the `/settings/` dedicated settings page (React island).
 * ---------------------------------------------------------------------------
 * Replaces the former settings MODALS (EizouSettingsDialog +
 * PlayerSettingsDialog + SettingsTabs) with one full-page, two-pane surface:
 *
 * - Desktop (≥768px): Shadcn-Sidebar-style left nav tree + wide content pane.
 *   Groups: General / Appearance / Modules (▸ Yomitan · Jimaku.cc · Nadeshiko).
 * - Mobile (<768px): hierarchical DRILL-DOWN. The left nav renders as the
 *   top-level menu; picking Modules opens a submenu of its children; every
 *   detail pane carries a "← Back" control. Menu ⇄ detail is CSS-toggled from
 *   state (data-depth on the shell), so a resize never needs a re-render.
 *
 * PERSISTENCE (hybrid, no manual Save button): `initSettingsSync()` installs a
 * localStorage write interceptor that mirrors every settings key to the
 * embedded SQLite `kv_store` on desktop and seeds the cache from it on mount.
 * Every control below writes through the existing per-feature store
 * (preferences / jimaku / nadeshiko / modules / anki-miner), so a change is
 * saved the moment it happens — localStorage in the browser, localStorage +
 * SQLite on desktop. See features/settings/settings-store.ts.
 *
 * The dict is supplied by the Astro page (serializable) and the island follows
 * `entei:locale-change` for live language switching (React text is outside the
 * `[data-i18n]` pass).
 * ---------------------------------------------------------------------------
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Blocks,
  BookOpen,
  BrainCircuit,
  ChevronRight,
  Globe,
  Keyboard,
  MessageSquareText,
  Palette,
  Plug,
} from 'lucide-react';
import { AnkiFieldsTab } from '@/components/player/AnkiFieldsTab';
import {
  SubtitleAppearanceTab,
  type SubtitleAppearanceSettings,
} from '@/components/player/SubtitleAppearanceTab';
import { NadeshikoSettingsTab } from '@/components/player/NadeshikoSettingsTab';
import { JimakuSettings } from '@/components/settings/JimakuSettings';
import { LanguageCombobox } from '@/components/home/LanguageCombobox';
import { Switch } from '@/components/player/ui/switch';
import { buildShortcuts } from '@/features/player/player-shortcuts';
import {
  readPlayerPreferences,
  writePlayerPreferences,
} from '@/features/player/preferences';
import {
  CORE_MODULES,
  type EnteiModuleId,
  type ModuleEnabledState,
  readModuleState,
  toggleModuleState,
  writeModuleState,
} from '@/features/modules/modules-store';
import { initSettingsSync } from '@/features/settings/settings-store';
import {
  dispatchAnkiSessionCredentials,
} from '@/features/player/settings-bridge';
import {
  LOCALE_CHANGE_EVENT,
  type LocaleChangeDetail,
} from '@i18n/locale-events';
import type { Dictionary, Locale } from '@i18n/types';

const DEFAULT_SUBTITLE_SETTINGS: SubtitleAppearanceSettings = {
  fontSize: 18,
  textColor: 'oklch(98% 0 0deg)',
  backgroundColor: 'oklch(0% 0 0 / 0.72)',
  backgroundPadding: 8,
  verticalPosition: 96,
  syncMode: 'auto',
};

/** Top-level settings groups. */
type SettingsGroup = 'general' | 'appearance' | 'module';

/** Children of the Modules group. */
type ModuleChild = 'yomitan' | 'jimaku' | 'nadeshiko';

/** A sidebar destination resolved from the URL (`?group=&item=`). */
interface SettingsSelection {
  group: SettingsGroup;
  item: ModuleChild | null;
}

const VALID_GROUPS: readonly SettingsGroup[] = ['general', 'appearance', 'module'];
const VALID_ITEMS: readonly ModuleChild[] = ['yomitan', 'jimaku', 'nadeshiko'];

/** Parse `?group=&item=` into a validated selection (defaults to General). */
function readSelectionFromUrl(): SettingsSelection {
  if (typeof window === 'undefined') return { group: 'general', item: null };
  const params = new URLSearchParams(window.location.search);
  const group = params.get('group') as SettingsGroup | null;
  const item = params.get('item') as ModuleChild | null;
  if (!group || !VALID_GROUPS.includes(group)) {
    return { group: 'general', item: null };
  }
  if (group === 'module' && item && VALID_ITEMS.includes(item)) {
    return { group: 'module', item };
  }
  return { group, item: null };
}

/** Whether the mobile shell should show the top-level MENU (vs a detail pane).
 *  Only the Modules landing is a "menu" on mobile — it lists its children. */
function isMobileMenu(selection: SettingsSelection): boolean {
  return selection.group === 'module' && selection.item === null;
}

export interface SettingsAppProps {
  /** Full dictionary (all strings — serializable across the island). */
  dict: Dictionary;
  /** Static-page locale (the island re-syncs on `entei:locale-change`). */
  locale: Locale;
}

export function SettingsApp({ dict, locale: initialLocale }: SettingsAppProps) {
  const [selection, setSelection] = useState<SettingsSelection>(() =>
    readSelectionFromUrl(),
  );
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [moduleState, setModuleState] = useState<ModuleEnabledState>(() =>
    readModuleState(),
  );

  /* Activate hybrid persistence (localStorage + desktop SQLite) and follow
     locale changes so the React-rendered labels switch live. */
  useEffect(() => {
    void initSettingsSync();
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<LocaleChangeDetail>).detail;
      if (!detail) return;
      setLocale(detail.locale);
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  /* Live subtitle appearance — reads/writes the player prefs store so the
     player picks the values up on its next mount. */
  const [subtitleSettings, setSubtitleSettings] =
    useState<SubtitleAppearanceSettings>(() => {
      const prefs = readPlayerPreferences();
      return {
        fontSize: prefs.subtitleFontSize,
        textColor: prefs.subtitleTextColor,
        backgroundColor: prefs.subtitleBackgroundColor,
        backgroundPadding: prefs.subtitleBackgroundPadding,
        verticalPosition: prefs.subtitleVerticalPosition,
        syncMode: prefs.subtitleSyncMode,
      };
    });

  const handleSubtitleChange = useCallback(
    (settings: Partial<SubtitleAppearanceSettings>) => {
      setSubtitleSettings((prev) => ({ ...prev, ...settings }));
      // NOTE: every field MUST have an explicit mapping line here — the key
      // names differ between SubtitleAppearanceSettings (fontSize) and
      // PlayerPreferences (subtitleFontSize). A plain spread silently drops
      // every change (a real bug fixed on 2026-08-13).
      const prefs = readPlayerPreferences();
      writePlayerPreferences({
        ...prefs,
        ...(settings.fontSize !== undefined && { subtitleFontSize: settings.fontSize }),
        ...(settings.textColor !== undefined && { subtitleTextColor: settings.textColor }),
        ...(settings.backgroundColor !== undefined && { subtitleBackgroundColor: settings.backgroundColor }),
        ...(settings.backgroundPadding !== undefined && { subtitleBackgroundPadding: settings.backgroundPadding }),
        ...(settings.verticalPosition !== undefined && { subtitleVerticalPosition: settings.verticalPosition }),
        ...(settings.syncMode !== undefined && { subtitleSyncMode: settings.syncMode }),
      });
    },
    [],
  );

  const handleSubtitleReset = useCallback(() => {
    setSubtitleSettings(DEFAULT_SUBTITLE_SETTINGS);
    const prefs = readPlayerPreferences();
    writePlayerPreferences({
      ...prefs,
      subtitleFontSize: DEFAULT_SUBTITLE_SETTINGS.fontSize,
      subtitleTextColor: DEFAULT_SUBTITLE_SETTINGS.textColor,
      subtitleBackgroundColor: DEFAULT_SUBTITLE_SETTINGS.backgroundColor,
      subtitleBackgroundPadding: DEFAULT_SUBTITLE_SETTINGS.backgroundPadding,
      subtitleVerticalPosition: DEFAULT_SUBTITLE_SETTINGS.verticalPosition,
      subtitleSyncMode: DEFAULT_SUBTITLE_SETTINGS.syncMode ?? 'auto',
    });
  }, []);

  const handleModuleToggle = useCallback(
    (id: EnteiModuleId) => {
      const next = toggleModuleState(moduleState, id);
      setModuleState(next);
      writeModuleState(next);
    },
    [moduleState],
  );

  /* Navigate: update state + the URL so deep links and browser Back work. */
  const navigate = useCallback(
    (group: SettingsGroup, item: ModuleChild | null) => {
      setSelection({ group, item });
      const params = new URLSearchParams();
      params.set('group', group);
      if (group === 'module' && item) params.set('item', item);
      window.history.pushState(null, '', `/settings/?${params.toString()}`);
    },
    [],
  );

  /* Browser Back / Forward re-read the URL. */
  useEffect(() => {
    const onPopState = () => setSelection(readSelectionFromUrl());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const settings = dict.settingsPage;
  const playerUI = dict.playerUI;

  const navGroups = useMemo(
    () =>
      [
        { id: 'general' as const, label: settings.general, Icon: Globe },
        { id: 'appearance' as const, label: settings.appearance, Icon: Palette },
        { id: 'module' as const, label: settings.module, Icon: Blocks },
      ],
    [settings.general, settings.appearance, settings.module],
  );

  const moduleChildren = useMemo(
    () =>
      [
        { id: 'yomitan' as const, label: settings.yomitan, Icon: BookOpen },
        { id: 'jimaku' as const, label: settings.jimaku, Icon: MessageSquareText },
        { id: 'nadeshiko' as const, label: settings.nadeshiko, Icon: BrainCircuit },
      ],
    [settings.yomitan, settings.jimaku, settings.nadeshiko],
  );

  const moduleMeta = useMemo(
    () => new Map(CORE_MODULES.map((m) => [m.id, m])),
    [],
  );

  return (
    <div
      className="entei-settings-shell"
      data-depth={isMobileMenu(selection) ? 'menu' : 'detail'}
    >
      {/* Mobile drill-down back control (hidden on desktop via CSS). */}
      <div className="entei-settings-mobile-header">
        <button type="button" className="entei-settings-back" onClick={backToMenu}>
          <ArrowLeft className="entei-settings-back-icon" aria-hidden="true" />
          <span>{settings.back}</span>
        </button>
      </div>

      {/* ------------------------------------------------------------------
       * LEFT NAV — sidebar tree (desktop) / menu + submenu (mobile).
       * --------------------------------------------------------------- */}
      <nav className="entei-settings-nav" aria-label={settings.title}>
        {navGroups.map(({ id, label, Icon }) => {
          const isModule = id === 'module';
          const isActive =
            selection.group === id && (!isModule || selection.item === null);
          return (
            <div className="entei-settings-nav-group" key={id}>
              <button
                type="button"
                className="entei-settings-nav-item"
                aria-current={isActive ? 'page' : undefined}
                aria-expanded={isModule ? true : undefined}
                aria-label={isModule ? `${label} — ${settings.opensSubmenu}` : undefined}
                onClick={() => navigate(id, null)}
              >
                <Icon className="entei-settings-nav-icon" aria-hidden="true" />
                <span>{label}</span>
                {isModule && (
                  <ChevronRight
                    className="entei-settings-nav-chevron"
                    aria-hidden="true"
                  />
                )}
              </button>

              {/* Desktop: children inline. Mobile: hidden — the submenu screen
                  renders them at top level (CSS `display:none`). */}
              {isModule && (
                <div className="entei-settings-nav-children">
                  {moduleChildren.map(
                    ({ id: childId, label: childLabel, Icon: ChildIcon }) => {
                      const childActive =
                        selection.group === 'module' &&
                        selection.item === childId;
                      return (
                        <button
                          key={childId}
                          type="button"
                          className="entei-settings-nav-item entei-settings-nav-item--child"
                          aria-current={childActive ? 'page' : undefined}
                          onClick={() => navigate('module', childId)}
                        >
                          <ChildIcon
                            className="entei-settings-nav-icon"
                            aria-hidden="true"
                          />
                          <span>{childLabel}</span>
                        </button>
                      );
                    },
                  )}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* ------------------------------------------------------------------
       * CONTENT PANE
       * --------------------------------------------------------------- */}
      <div className="entei-settings-content">
        <ContentHeader selection={selection} settings={settings} />

        {selection.group === 'general' && (
          <div className="entei-settings-section-stack">
            {/* Language */}
            <section className="entei-settings-section-card">
              <h3 className="entei-settings-label">{dict.language.selectLabel}</h3>
              <LanguageCombobox
                currentLocale={locale}
                selectLabel={dict.language.selectLabel}
              />
            </section>

            {/* Player Anki Fields (AnkiConnect + field mapping) */}
            <section className="entei-settings-section-card">
              <h3 className="entei-settings-label">
                <Plug size={18} aria-hidden="true" /> {playerUI.settingsTabAnki}
              </h3>
              <AnkiFieldsTab
                dict={playerUI}
                onSessionCredentials={dispatchAnkiSessionCredentials}
              />
            </section>

            {/* Keyboard shortcuts reference */}
            <section className="entei-settings-section-card">
              <h3 className="entei-settings-label">
                <Keyboard size={18} aria-hidden="true" />{' '}
                {playerUI.settingsShortcuts}
              </h3>
              <div className="entei-settings-shortcuts-list">
                {buildShortcuts(playerUI).map((s) => (
                  <div key={s.key} className="entei-settings-shortcut-row">
                    <kbd className="entei-shortcut-key">{s.key}</kbd>
                    <span className="entei-shortcut-desc">{s.desc}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {selection.group === 'appearance' && (
          <div className="entei-settings-section-stack">
            <section className="entei-settings-section-card">
              <SubtitleAppearanceTab
                dict={playerUI}
                settings={subtitleSettings}
                onChange={handleSubtitleChange}
                onReset={handleSubtitleReset}
              />
            </section>
          </div>
        )}

        {/* Modules landing: core-module switches + children quick-entries. */}
        {selection.group === 'module' && selection.item === null && (
          <div className="entei-settings-section-stack">
            <section className="entei-settings-section-card">
              <ul className="entei-modules-list">
                {CORE_MODULES.map((module) => {
                  const isOn = moduleState[module.id];
                  const name = dict.modulesPage[module.nameKey];
                  return (
                    <li className="entei-module-card" key={module.id}>
                      <span className="entei-module-icon" aria-hidden="true">
                        <Blocks size={20} />
                      </span>
                      <div className="entei-module-head">
                        <h3 className="entei-module-name" title={name}>
                          {name}
                        </h3>
                        {module.builtIn && (
                          <span className="entei-module-badge">
                            {dict.modulesPage.builtIn}
                          </span>
                        )}
                      </div>
                      <div className="entei-module-toggle">
                        <Switch
                          id={`entei-module-switch-${module.id}`}
                          checked={isOn}
                          onCheckedChange={() => handleModuleToggle(module.id)}
                          aria-label={name}
                        />
                      </div>
                      <p className="entei-module-description">
                        {dict.modulesPage[module.descriptionKey]}
                      </p>
                      <p className="entei-module-meta">
                        <span>v{module.version}</span>
                        <span>{module.author}</span>
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* Module sub-pages (mirror the sidebar children). */}
            <section className="entei-settings-section-card">
              <div className="entei-settings-nav-children">
                {moduleChildren.map(
                  ({ id: childId, label: childLabel, Icon: ChildIcon }) => (
                    <button
                      key={childId}
                      type="button"
                      className="entei-settings-nav-item"
                      onClick={() => navigate('module', childId)}
                    >
                      <ChildIcon
                        className="entei-settings-nav-icon"
                        aria-hidden="true"
                      />
                      <span>{childLabel}</span>
                      <ChevronRight
                        className="entei-settings-nav-chevron"
                        aria-hidden="true"
                      />
                    </button>
                  ),
                )}
              </div>
            </section>
          </div>
        )}

        {/* Modules › Yomitan */}
        {selection.group === 'module' && selection.item === 'yomitan' && (
          <div className="entei-settings-section-stack">
            <section className="entei-settings-section-card">
              <div className="entei-module-card">
                <span className="entei-module-icon" aria-hidden="true">
                  <BookOpen size={20} />
                </span>
                <div className="entei-module-head">
                  <h3 className="entei-module-name">{settings.yomitan}</h3>
                  <span className="entei-module-badge">
                    v{moduleMeta.get('yomitan')?.version}
                  </span>
                </div>
                <div className="entei-module-toggle">
                  <Switch
                    checked={moduleState.yomitan}
                    onCheckedChange={() => handleModuleToggle('yomitan')}
                    aria-label={settings.yomitan}
                  />
                </div>
                <p className="entei-module-description">
                  {dict.modulesPage.yomitanDescription}
                </p>
              </div>
            </section>
          </div>
        )}

        {/* Modules › Jimaku.cc */}
        {selection.group === 'module' && selection.item === 'jimaku' && (
          <div className="entei-settings-section-stack">
            <section className="entei-settings-section-card">
              <JimakuSettings dict={playerUI} />
            </section>
          </div>
        )}

        {/* Modules › Nadeshiko */}
        {selection.group === 'module' && selection.item === 'nadeshiko' && (
          <div className="entei-settings-section-stack">
            <section className="entei-settings-section-card">
              <NadeshikoSettingsTab dict={dict.nadeshiko} />
            </section>
          </div>
        )}
      </div>
    </div>
  );

  function backToMenu() {
    if (selection.group === 'module' && selection.item) {
      navigate('module', null);
    } else {
      navigate('general', null);
    }
  }
}

/** Content pane heading (title) per selection. */
function ContentHeader({
  selection,
  settings,
}: {
  selection: SettingsSelection;
  settings: Dictionary['settingsPage'];
}) {
  const title =
    selection.group === 'module' && selection.item
      ? settings[selection.item]
      : settings[selection.group];
  return (
    <header className="entei-settings-content-header">
      <h1 className="entei-settings-content-title">{title}</h1>
    </header>
  );
}
