/**
 * SettingsApp — the `/settings/` dedicated settings page (React island).
 * ---------------------------------------------------------------------------
 * Replaces the former settings MODALS (EizouSettingsDialog +
 * PlayerSettingsDialog + SettingsTabs) with one full-page, two-pane surface:
 *
 * - Desktop (≥768px): Shadcn-Sidebar-style left nav tree + wide content pane.
 *   Groups: General / Appearance / Modules (every REGISTERED module whose
 *   manifest declares a settings tree).
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
import { AnkiConnectionCard } from '@/components/settings/AnkiConnectionCard';
import { AnkiCardManagementsCard } from '@/components/settings/AnkiCardManagementsCard';
import { AnkiFieldProfilesCard } from '@/components/settings/AnkiFieldProfilesCard';
import { AnkiMiscellaneousCard } from '@/components/settings/AnkiMiscellaneousCard';
import {
  ArrowLeft,
  Blocks,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Download,
  FolderDown,
  Globe,
  Keyboard,
  Languages,
  Magnet,
  MessageSquareText,
  Palette,
  PanelLeft,
  Puzzle,
  type LucideIcon,
} from 'lucide-react';
import { PlayingCardsFan } from '@/components/settings/PlayingCardsFan';
import {
  SubtitleAppearanceTab,
  type SubtitleAppearanceSettings,
} from '@/components/player/SubtitleAppearanceTab';
import {
  ModuleSettingsRenderer,
  moduleHasSettings,
} from '@/components/settings/ModuleSettingsRenderer';
import { LanguageCombobox } from '@/components/home/LanguageCombobox';
import { Switch } from '@/components/player/ui/switch';
import { buildShortcuts } from '@/features/player/player-shortcuts';
import {
  readPlayerPreferences,
  writePlayerPreferences,
} from '@/features/player/preferences';
import {
  getRegisteredModules,
  type EnteiModuleId,
  type EnteiModuleManifest,
  type ModuleEnabledState,
  readModuleState,
  toggleModuleState,
  writeModuleState,
} from '@/features/modules/modules-store';
import { MODULES_CHANGED_EVENT } from '@/features/modules/use-module-registry';
import { initSettingsSync } from '@/features/settings/settings-store';
import { SettingsButton } from '@/components/settings/SettingsButton';
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
type SettingsGroup = 'general' | 'appearance' | 'anki' | 'module';

/**
 * Which module page is open (`item === null` = the Modules landing grid).
 *
 * OPEN-ENDED on purpose: the sidebar and the grid are both driven by the
 * registry, so an imported `*.module.json` navigates here without a code
 * change. A module's settings come from its own manifest; modules without one
 * are not offered a page at all.
 */
interface SettingsSelection {
  group: SettingsGroup;
  item: string | null;
}

const VALID_GROUPS: readonly SettingsGroup[] = [
  'general',
  'appearance',
  'anki',
  'module',
];

/** Lucide icon per manifest `icon` name (manifests stay serializable). */
const MODULE_ICONS: Record<string, LucideIcon> = {
  Download: Download,
  Magnet: Magnet,
  BookOpen: Puzzle,
  MessageSquareText: MessageSquareText,
  BrainCircuit: BrainCircuit,
  Blocks: Blocks,
};

/** localStorage key persisting the desktop sidebar's collapsed state. */
const SIDEBAR_COLLAPSED_KEY = 'entei.settings.sidebarCollapsed';

/** localStorage key persisting the desktop "Modul" accordion open state. */
const MODULE_EXPANDED_KEY = 'entei.settings.moduleExpanded';

/**
 * Read a persisted boolean localStorage flag (SSR-safe, never throws).
 *
 * A stored value that is neither `true` nor `false` (hand-edited, stale) falls
 * back to the caller's default instead of silently coercing to `false`.
 */
function readBoolFlag(key: string, defaultVal: boolean): boolean {
  if (typeof window === 'undefined') return defaultVal;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return defaultVal;
  } catch {
    return defaultVal;
  }
}

/**
 * Persist a boolean localStorage flag (mirrors to the desktop DB on write).
 * An unavailable localStorage degrades to memory-only for this session.
 */
function writeBoolFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* localStorage unavailable — in-memory only, still works this session */
  }
}

/** Parse `?group=&item=` into a validated selection (defaults to General). */
function readSelectionFromUrl(): SettingsSelection {
  if (typeof window === 'undefined') return { group: 'general', item: null };
  const params = new URLSearchParams(window.location.search);
  const group = params.get('group') as SettingsGroup | null;
  const item = params.get('item');
  if (!group || !VALID_GROUPS.includes(group)) {
    return { group: 'general', item: null };
  }
  if (group === 'module' && item !== null && item !== '') {
    // Any registered module id is addressable; the landing grid stays at null.
    return { group: 'module', item };
  }
  return { group, item: null };
}

/** Resolve a manifest's localized name (dictionary key or literal). */
function moduleName(
  module: EnteiModuleManifest,
  dict: Dictionary['modulesPage'],
): string {
  if (module.nameKey !== undefined) {
    const localized: string | undefined = (
      dict as unknown as Record<string, unknown>
    )[module.nameKey] as string | undefined;
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
    const localized: string | undefined = (
      dict as unknown as Record<string, unknown>
    )[module.descriptionKey] as string | undefined;
    if (typeof localized === 'string' && localized !== '') return localized;
  }
  return module.description ?? '';
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
  /* The merged registry: built-in manifests + imported `*.module.json`. The
     sidebar submenu AND the landing grid both derive from it, so a newly
     imported module appears in both with no page-side wiring. */
  const [modules, setModules] = useState<EnteiModuleManifest[]>(() =>
    getRegisteredModules(),
  );
  const [moduleState, setModuleState] = useState<ModuleEnabledState>(() =>
    readModuleState(),
  );
  /* Desktop sidebar collapsed state (icon-only rail) — persisted so the
     choice survives reloads. Mobile ignores it (drill-down owns the nav). */
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    readBoolFlag(SIDEBAR_COLLAPSED_KEY, false),
  );
  /* Modules group accordion (desktop sidebar). true = children visible.
     Toggling the Modules row collapses/expands the registered module list. */
  const [moduleExpanded, setModuleExpanded] = useState<boolean>(() =>
    readBoolFlag(MODULE_EXPANDED_KEY, true),
  );

  const toggleModuleExpanded = useCallback(() => {
    setModuleExpanded((prev) => {
      const next = !prev;
      writeBoolFlag(MODULE_EXPANDED_KEY, next);
      return next;
    });
  }, []);

  /* Ensure-expanded helper (entering the Modules group) — also persisted, but
     only when it is actually collapsed (no needless localStorage + DB write). */
  const expandModules = useCallback(() => {
    setModuleExpanded((prev) => {
      if (prev) return prev;
      writeBoolFlag(MODULE_EXPANDED_KEY, true);
      return true;
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      writeBoolFlag(SIDEBAR_COLLAPSED_KEY, next);
      return next;
    });
  }, []);

  /* Activate hybrid persistence (localStorage + desktop SQLite) and follow
     locale changes so the React-rendered labels switch live. */
  useEffect(() => {
    void initSettingsSync().then(() => {
      /* The DB→cache seed has settled, so the flags may have changed under us
         (desktop DB restored a value the cache lacked) — re-read them now. */
      setSidebarCollapsed(readBoolFlag(SIDEBAR_COLLAPSED_KEY, false));
      setModuleExpanded(readBoolFlag(MODULE_EXPANDED_KEY, true));
    });
    /* A module's own settings payload belongs to its renderer (it seeds itself
       from the desktop DB when its page opens), so this island holds no module
       settings state of its own. */
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<LocaleChangeDetail>).detail;
      if (!detail) return;
      setLocale(detail.locale);
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  /* Keep the registry fresh: cross-tab toggles (`storage`) and same-tab
     imports (`entei:modules-changed`). */
  useEffect(() => {
    const sync = () => {
      setModules(getRegisteredModules());
      setModuleState(readModuleState());
    };
    window.addEventListener('storage', sync);
    window.addEventListener(MODULES_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(MODULES_CHANGED_EVENT, sync);
    };
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
    (group: SettingsGroup, item: string | null) => {
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

  /* Guard: if URL addresses a module without settings (or unknown module),
     redirect cleanly to the Modules landing grid. */
  useEffect(() => {
    if (selection.group === 'module' && selection.item !== null) {
      const target = modules.find((m) => m.id === selection.item);
      if (!target || !moduleHasSettings(target)) {
        navigate('module', null);
      }
    }
  }, [selection, modules, navigate]);

  const settings = dict.settingsPage;
  const playerUI = dict.playerUI;

  const navGroups = useMemo(
    () =>
      [
        { id: 'general' as const, label: settings.general, Icon: Globe },
        { id: 'appearance' as const, label: settings.appearance, Icon: Palette },
        { id: 'anki' as const, label: settings.anki, Icon: PlayingCardsFan },
        { id: 'module' as const, label: settings.module, Icon: Blocks },
      ],
    [settings.general, settings.appearance, settings.anki, settings.module],
  );

  /* Sidebar submenu rows — one per REGISTERED module WITH SETTINGS, so an
     imported manifest with settings shows up under Modul automatically, while
     modules without settings (yt-dlp, torrent) stay off the sidebar. */
  const moduleChildren = useMemo(
    () =>
      modules
        .filter(moduleHasSettings)
        .map((module) => {
          const Icon =
            (module.icon !== undefined ? MODULE_ICONS[module.icon] : undefined) ??
            Blocks;
          return {
            id: module.id,
            label: moduleName(module, dict.modulesPage),
            Icon,
            iconPath: module.iconPath,
          };
        }),
    [modules, dict.modulesPage],
  );

  /* Manifest for the page currently open (null on the landing grid). */
  const selectedModule = useMemo(
    () =>
      selection.item === null
        ? undefined
        : modules.find((module) => module.id === selection.item),
    [modules, selection.item],
  );

  return (
    <div
      className="entei-settings-shell"
      data-depth={isMobileMenu(selection) ? 'menu' : 'detail'}
      data-collapsed={sidebarCollapsed ? 'true' : undefined}
    >
      {/* Mobile drill-down back control (hidden on desktop via CSS). */}
      <div className="entei-settings-mobile-header">
        <button
          type="button"
          className="entei-settings-back"
          onClick={backToMenu}
          aria-label={settings.back}
        >
          <ArrowLeft className="entei-settings-back-icon" aria-hidden="true" />
        </button>
      </div>

      {/* ------------------------------------------------------------------
       * LEFT NAV — sidebar tree (desktop) / menu + submenu (mobile).
       * --------------------------------------------------------------- */}
      <nav className="entei-settings-nav" aria-label={settings.title}>
        {/* Sidebar header row: the collapse toggle (desktop only, hidden on
            mobile via CSS). Lives at the very top of the sidebar — docks to
            the top-right when expanded and centers into the icon rail when
            collapsed (Shadcn-Sidebar parity). */}
        <div className="entei-settings-nav-header">
          <button
            type="button"
            className="entei-settings-sidebar-toggle"
            aria-label={settings.title}
            aria-pressed={sidebarCollapsed}
            onClick={toggleSidebar}
          >
            <PanelLeft className="entei-settings-sidebar-toggle-icon" aria-hidden="true" />
          </button>
        </div>

        {navGroups.map(({ id, label, Icon }) => {
          const isModule = id === 'module';
          const isActive =
            selection.group === id && (!isModule || selection.item === null);
          const Chevron = isModule && moduleExpanded ? ChevronDown : ChevronRight;
          return (
            <div className="entei-settings-nav-group" key={id}>
              <button
                type="button"
                className="entei-settings-nav-item"
                aria-current={isActive ? 'page' : undefined}
                aria-expanded={isModule ? moduleExpanded : undefined}
                aria-label={isModule ? `${label} — ${settings.opensSubmenu}` : undefined}
                onClick={() => {
                  if (isModule) {
                    if (selection.group === 'module' && selection.item === null) {
                      // Already on the Modules landing — toggle the accordion collapse
                      toggleModuleExpanded();
                    } else {
                      // On a child page (Yomitan/Jimaku/Nadeshiko) or entering from another group —
                      // ensure expanded and navigate to the Modules landing page
                      expandModules();
                      navigate(id, null);
                    }
                  } else {
                    navigate(id, null);
                  }
                }}
              >
                <Icon className="entei-settings-nav-icon" aria-hidden="true" />
                <span>{label}</span>
                {isModule && (
                  <Chevron
                    className="entei-settings-nav-chevron"
                    aria-hidden="true"
                  />
                )}
              </button>

              {/* Desktop: children inline, collapsible via the group toggle.
                  Mobile: hidden — the submenu screen renders them at top level
                  (CSS `display:none`). */}
              {isModule && moduleExpanded && (
                <div className="entei-settings-nav-children">
                  {moduleChildren.map(
                    ({ id: childId, label: childLabel, Icon: ChildIcon, iconPath }) => {
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
                          {iconPath ? (
                            <img
                              src={iconPath}
                              alt=""
                              className="entei-settings-nav-icon entei-settings-nav-icon--img"
                              aria-hidden="true"
                            />
                          ) : (
                            <ChildIcon
                              className="entei-settings-nav-icon"
                              aria-hidden="true"
                            />
                          )}
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
        {selection.group === 'general' && (
          <div className="entei-settings-section-stack">
            {/* Language */}
            <section className="entei-settings-section-card entei-settings-section-card--language">
              <h3 className="entei-settings-label">
                <Languages aria-hidden="true" />
                <span>{dict.language.selectLabel}</span>
              </h3>
              <LanguageCombobox
                currentLocale={locale}
                selectLabel={dict.language.selectLabel}
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
            <SubtitleAppearanceTab
              dict={playerUI}
              settings={subtitleSettings}
              onChange={handleSubtitleChange}
              onReset={handleSubtitleReset}
            />
          </div>
        )}

        {/* Anki — connection, card managements, field profiles, miscellaneous */}
        {selection.group === 'anki' && (
          <div className="entei-settings-section-stack">
            <AnkiConnectionCard dict={dict.ankiConnection} notEditable={dict.yomitanSettings.notEditable} />
            <AnkiCardManagementsCard dict={dict.ankiCardManagements} />
            <AnkiFieldProfilesCard dict={dict.ankiFieldProfiles} />
            <AnkiMiscellaneousCard dict={dict.ankiMiscellaneous} />
          </div>
        )}

        {/* Modules landing: core-module switches in 2-column grid. */}
        {selection.group === 'module' && selection.item === null && (
          <div className="entei-settings-section-stack">
            <div className="entei-modules-toolbar">
              <SettingsButton
                icon={FolderDown}
                disabled
                title={dict.modulesPage.importHint}
              >
                {dict.modulesPage.importLabel}
              </SettingsButton>
            </div>
            <ul className="entei-modules-grid">
              {modules.map((module) => {
                const isOn = moduleState[module.id] === true;
                const name = moduleName(module, dict.modulesPage);
                const Icon =
                  (module.icon !== undefined
                    ? MODULE_ICONS[module.icon]
                    : undefined) ?? Blocks;
                const badgeText = module.builtIn
                  ? `${dict.modulesPage.builtIn} ・ ${module.author} ・ v${module.version}`
                  : `${module.author} ・ v${module.version}`;
                return (
                  <li className="entei-module-card" key={module.id}>
                    <span className="entei-module-icon" aria-hidden="true">
                      {module.iconPath ? (
                        <img
                          src={module.iconPath}
                          alt=""
                          className="entei-module-icon-img"
                        />
                      ) : (
                        <Icon size={20} />
                      )}
                    </span>
                    <div className="entei-module-head">
                      <h3 className="entei-module-name" title={name}>
                        {name}
                      </h3>
                      <span className="entei-module-badge">{badgeText}</span>
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
                      {moduleDescription(module, dict.modulesPage)}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* ----------------------------------------------------------------
         * MODULE DETAIL PANE
         *
         * Only modules with settings resolve here. The duplicate ModuleHeader
         * card is removed (the switch lives on the landing grid); the body is
         * the module's own settings directly.
         *
         * ONE call for every module: the manifest decides what is drawn (its own
         * descriptor tree, plus whatever host-owned editor a row's `source`
         * binds), so this page never names a module by id.
         * ------------------------------------------------------------- */}
        {selection.group === 'module' &&
          selection.item !== null &&
          selectedModule !== undefined &&
          moduleHasSettings(selectedModule) && (
            <div className="entei-settings-section-stack">
              <ModuleSettingsRenderer
                module={selectedModule}
                dict={dict}
                onNavigate={(target) => navigate(target as SettingsGroup, null)}
              />
            </div>
          )}
      </div>
    </div>
  );

  function backToMenu() {
    // Mobile drill-down: if inside a module's settings (e.g. /settings/?group=module&item=yomitan),
    // drill back up to the Modules landing list.
    if (selection.group === 'module' && selection.item) {
      navigate('module', null);
      return;
    }

    // Top-level settings (General, Appearance, Anki, Modules landing):
    // return to the previous page (Home, Player, etc.) via browser history,
    // or fall back to Home if directly navigated.
    if (typeof window !== 'undefined') {
      if (
        window.history.length > 1 &&
        (!document.referrer || document.referrer.startsWith(window.location.origin))
      ) {
        window.history.back();
      } else {
        window.location.href = '/';
      }
    }
  }
}
