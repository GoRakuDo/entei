/**
 * player-shortcuts — single source of truth for the Player keyboard
 * shortcut reference shown in the settings "Player" tab.
 * ---------------------------------------------------------------------------
 * Both the Player settings modal (PlayerSettingsDialog via PlayerApp) and
 * the global navigation settings modal (EizouSettingsDialog) render the
 * same six shortcuts; extracting them here prevents drift when one is
 * added. Descriptions come from the localized playerUI dictionary
 * (descKey), so the reference is identical on every page and in every
 * language.
 * ---------------------------------------------------------------------------
 */

import type { Dictionary } from '@i18n/types';

export interface ShortcutEntry {
  key: string;
  desc: string;
}

interface ShortcutDef {
  key: string;
  descKey:
    | 'shortcutPlayPause'
    | 'shortcutPrevCue'
    | 'shortcutNextCue'
    | 'shortcutSeekHome'
    | 'shortcutSlowDown'
    | 'shortcutSpeedUp';
}

/** Canonical shortcut definitions (key + dictionary desc key). */
export const SHORTCUT_ENTRIES: readonly ShortcutDef[] = [
  { key: 'Space', descKey: 'shortcutPlayPause' },
  { key: '\u2190', descKey: 'shortcutPrevCue' },
  { key: '\u2192', descKey: 'shortcutNextCue' },
  { key: 'Home', descKey: 'shortcutSeekHome' },
  { key: '[', descKey: 'shortcutSlowDown' },
  { key: ']', descKey: 'shortcutSpeedUp' },
];

/**
 * Resolve the shortcut entries from a localized playerUI dictionary.
 * Used by both settings modals so the reference never drifts.
 */
export function buildShortcuts(dict: Dictionary['playerUI']): ShortcutEntry[] {
  return SHORTCUT_ENTRIES.map((s) => ({ key: s.key, desc: dict[s.descKey] }));
}