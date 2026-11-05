/**
 * EizouSettingsDialog — global settings dialog opened from the TopBar nav
 * settings button (desktop pill) and the mobile Dock's Settings entry.
 * ---------------------------------------------------------------------------
 * NAVIGATION_BAR.md "設定ボタンの追加 (2026-08-07)": the Settings modal can
 * be opened from any page and shows the SAME settings as the Player modal —
 * the shared SettingsTabs body (Player / Subtitle / Nadeshiko / Anki Fields).
 *
 * Only the title differs (settingsTitleGlobal "Settings" vs the player's
 * "Player Settings"); the keyboard-shortcut reference is rebuilt from the
 * same dictionary the Player uses, so the Player tab is identical.
 *
 * The dict string props are supplied by the Astro TopBar (serializable —
 * playerUI is all strings), so the island boundary stays JSON-clean.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/player/ui/dialog';
import { SettingsTabs } from '@/components/player/SettingsTabs';
import { LanguageCombobox } from '@/components/home/LanguageCombobox';
import { buildShortcuts } from '@/features/player/player-shortcuts';
import {
  dispatchAnkiSessionCredentials,
  dispatchSubtitleSettingsChange,
  listenForOpenSettings,
} from '@/features/player/settings-bridge';
import { LOCALE_CHANGE_EVENT, type LocaleChangeDetail } from '@i18n/locale-events';
import type { Dictionary, Locale } from '@i18n/types';

export interface EizouSettingsDialogProps {
  /** Label for the trigger button (localized, e.g. "Settings"). */
  label: string;
  /** aria-label for the trigger. */
  triggerLabel: string;
  /** Variant: desktop pill button, mobile dock link, or desktop Home
   *  sidebar row. */
  variant: 'pill' | 'dock' | 'sidebar';
  /** Full playerUI dictionary (all strings — serializable). */
  playerUI: Dictionary['playerUI'];
  /** Show the Shortcut tab (player-only keyboard reference). The TopBar
   *  passes true only when the current route is /player. */
  showShortcuts?: boolean;
  /** Nadeshiko dictionary block (for the new Nadeshiko settings tab). */
  nadeshikoDict?: Dictionary['nadeshiko'];
  /** Current locale for the in-dialog language selector (desktop topbar
   *  no longer carries a language combobox — language lives here). */
  locale?: Locale;
  /** Visible row label for the in-dialog language selector. */
  languageLabel?: string;
}

export function EizouSettingsDialog({
  label,
  triggerLabel,
  variant,
  playerUI,
  showShortcuts = false,
  nadeshikoDict,
  locale = 'id',
  languageLabel = 'Language',
}: EizouSettingsDialogProps) {
  const [open, setOpen] = useState(false);

  /* Localized strings for the trigger + language row. The nav labels are
   * rendered by a React island, so the locale-switcher's data-i18n pass
   * cannot reach them — listen to the locale-change event instead and
   * re-render with the new dictionary strings. */
  const [labels, setLabels] = useState({
    trigger: triggerLabel,
    row: label,
    language: languageLabel,
  });

  useEffect(() => {
    const handler = (event: Event) => {
      const dictionary = (event as CustomEvent<LocaleChangeDetail>).detail
        ?.dictionary;
      if (!dictionary) return;
      setLabels({
        trigger: dictionary.playerUI.settingsLabel,
        row: dictionary.nav.destinationSettings,
        language: dictionary.language.selectLabel,
      });
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  // P4: the jimaku search dialog (PlayerApp island) can open this settings
  // modal via the settings-bridge event. Only the variant visible at the
  // current viewport reacts (desktop pill / mobile dock), so the two
  // instances never stack two settings modals on top of each other.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return; // non-browser (tests)
    const media = window.matchMedia('(min-width: 768px)');
    const handlesEvent = variant === 'dock' ? !media.matches : media.matches;
    if (!handlesEvent) return;
    return listenForOpenSettings(() => setOpen(true));
  }, [variant]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        className={
          variant === 'pill'
            ? 'entei-desktop-pill-link entei-nav-settings-trigger'
            : variant === 'sidebar'
              ? 'entei-desktop-sidebar-link entei-nav-settings-trigger'
              : 'entei-mobile-dock-link entei-nav-settings-trigger'
        }
        aria-label={labels.trigger}
        title={labels.trigger}
        data-entei-nav-settings
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Settings aria-hidden="true" className="entei-nav-settings-icon" />
        {variant !== 'pill' && <span>{labels.row}</span>}
      </button>
      <DialogContent
        closeLabel={playerUI.dialogClose}
        className="entei-settings-dialog"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{playerUI.settingsTitleGlobal}</DialogTitle>
        </DialogHeader>
        <div className="entei-settings-language-row">
          <span className="entei-settings-language-label">{labels.language}</span>
          <LanguageCombobox
            currentLocale={locale}
            selectLabel={labels.language}
          />
        </div>
        <SettingsTabs
          dict={playerUI}
          shortcuts={buildShortcuts(playerUI)}
          showShortcuts={showShortcuts}
          onSubtitleSettingsChange={dispatchSubtitleSettingsChange}
          onSessionCredentials={dispatchAnkiSessionCredentials}
          nadeshikoDict={nadeshikoDict}
        />
      </DialogContent>
    </Dialog>
  );
}
