/**
 * SettingsTabs — shared settings modal content (Player + Navigation).
 * ---------------------------------------------------------------------------
 * The tab strip + every tab's content, shared by the Player settings modal
 * (PlayerSettingsDialog) and the global navigation settings modal
 * (EizouSettingsDialog) so both show the exact same settings.
 *
 * Tabs:
 *   1. Player   — keyboard shortcut reference
 *   2. Subtitle — subtitle appearance (live preview; persisted to
 *                `entei.player.prefs.v1`, same store the player reads)
 *   3. EizouDen — YouTube download mode (Quality / Speed)
 *   4. Anki     — AnkiConnect setup + field mapping
 *
 * The dialog shell (overlay/content/header/title) is owned by each caller;
 * only the tabbed body lives here.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/player/ui/tabs';
import { AnkiFieldsTab, type AnkiSessionCredentials } from '@/components/player/AnkiFieldsTab';
import {
  SubtitleAppearanceTab,
  type SubtitleAppearanceSettings,
} from '@/components/player/SubtitleAppearanceTab';
import { EizouDenSettingsTab } from '@/components/player/EizouDenSettingsTab';
import { readPlayerPreferences, writePlayerPreferences } from '@/features/player/preferences';
import type { ShortcutEntry } from '@/features/player/player-shortcuts';

const DEFAULT_SUBTITLE_SETTINGS: SubtitleAppearanceSettings = {
  fontSize: 18,
  textColor: 'oklch(98% 0 0deg)',
  backgroundColor: 'oklch(0% 0 0 / 0.72)',
  backgroundPadding: 8,
  verticalPosition: 96,
  syncMode: 'subtitle',
};

export interface SettingsTabsProps {
  dict: Parameters<typeof AnkiFieldsTab>[0]['dict'];
  shortcuts: ShortcutEntry[];
  /** Whether the Shortcut tab (player-only keyboard reference) is shown.
   *  Player settings modal passes true; the global nav settings dialog
   *  passes true only on the /player page. Defaults to false (opt-in). */
  showShortcuts?: boolean;
  /** Anki export session callback (optional; player wires it, nav omits). */
  onSessionCredentials?: (creds: AnkiSessionCredentials | null) => void;
  /** Live subtitle settings from the player (optional; synced when present). */
  subtitleSettings?: Partial<SubtitleAppearanceSettings>;
  /** Live subtitle change callback from the player (optional). */
  onSubtitleSettingsChange?: (settings: Partial<SubtitleAppearanceSettings>) => void;
  /** Explicit destructive pairing reset, supplied by the Player wiring and
   *  the global nav settings modal (ED-3). Both supply onResetPairing; the
   *  EizouDen tab renders its reset control only when present. */
  onResetPairing?: () => void | Promise<void>;
}

export function SettingsTabs({
  dict,
  shortcuts,
  showShortcuts = false,
  onSessionCredentials,
  subtitleSettings,
  onSubtitleSettingsChange,
  onResetPairing,
}: SettingsTabsProps) {
  // Subtitle appearance is self-contained here (reads/writes the same
  // `entei.player.prefs.v1` store the player reads); when the player passes
  // live settings they win for a live overlay preview.
  const [localSubtitle, setLocalSubtitle] = useState<SubtitleAppearanceSettings>(() => {
    if (subtitleSettings) {
      return { ...DEFAULT_SUBTITLE_SETTINGS, ...subtitleSettings };
    }
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

  // Sync when the player pushes live settings (e.g. PlayerApp overlay state).
  useEffect(() => {
    if (subtitleSettings) {
      setLocalSubtitle((prev) => ({ ...prev, ...subtitleSettings }));
    }
  }, [subtitleSettings]);

  const handleSubtitleChange = useCallback(
    (settings: Partial<SubtitleAppearanceSettings>) => {
      setLocalSubtitle((prev) => ({ ...prev, ...settings }));
      // NOTE: every SubtitleAppearanceSettings field MUST have an explicit
      // mapping line here (and in handleSubtitleReset). A plain spread
      // silently drops every change because the key names differ between
      // the two types (fontSize vs subtitleFontSize — this was a real bug
      // fixed on 2026-08-13). When adding a new field, add its mapping in
      // BOTH places or it will never be persisted.
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
      onSubtitleSettingsChange?.(settings);
    },
    [onSubtitleSettingsChange],
  );

  const handleSubtitleReset = useCallback(() => {
    setLocalSubtitle(DEFAULT_SUBTITLE_SETTINGS);
    const prefs = readPlayerPreferences();
    // Same key mapping as handleSubtitleChange (reset is a full replace).
    writePlayerPreferences({
      ...prefs,
      subtitleFontSize: DEFAULT_SUBTITLE_SETTINGS.fontSize,
      subtitleTextColor: DEFAULT_SUBTITLE_SETTINGS.textColor,
      subtitleBackgroundColor: DEFAULT_SUBTITLE_SETTINGS.backgroundColor,
      subtitleBackgroundPadding: DEFAULT_SUBTITLE_SETTINGS.backgroundPadding,
      subtitleVerticalPosition: DEFAULT_SUBTITLE_SETTINGS.verticalPosition,
      subtitleSyncMode: DEFAULT_SUBTITLE_SETTINGS.syncMode ?? 'subtitle',
    });
    onSubtitleSettingsChange?.(DEFAULT_SUBTITLE_SETTINGS);
  }, [onSubtitleSettingsChange]);

  const effective = subtitleSettings
    ? { ...localSubtitle, ...subtitleSettings }
    : localSubtitle;

  return (
    // Note: defaultValue is mount-time only; safe because the dialog
    // unmounts on close (each open mounts fresh with the current value).
    <Tabs defaultValue={showShortcuts ? 'shortcut' : 'subtitle'} className="entei-settings-tabs">
      <div className="entei-settings-body">
        <TabsList className="entei-settings-tabs-list">
          {showShortcuts && (
            <TabsTrigger value="shortcut">{dict.settingsTabShortcut}</TabsTrigger>
          )}
          <TabsTrigger value="subtitle">{dict.settingsTabSubtitle}</TabsTrigger>
          <TabsTrigger value="eizouden">{dict.settingsTabEizouDen}</TabsTrigger>
          <TabsTrigger value="anki">{dict.settingsTabAnki}</TabsTrigger>
        </TabsList>
        <div className="entei-settings-panel">
          {showShortcuts && (
            <TabsContent value="shortcut" className="entei-settings-tab-content">
              <div className="entei-settings-section">
                <h3 className="entei-settings-label">{dict.settingsShortcuts}</h3>
                <div className="entei-settings-shortcuts-list">
                  {shortcuts.map((s) => (
                    <div key={s.key} className="entei-settings-shortcut-row">
                      <kbd className="entei-shortcut-key">{s.key}</kbd>
                      <span className="entei-shortcut-desc">{s.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>
          )}
          <TabsContent value="subtitle" className="entei-settings-tab-content">
            <SubtitleAppearanceTab
              dict={dict}
              settings={effective}
              onChange={handleSubtitleChange}
              onReset={handleSubtitleReset}
            />
          </TabsContent>
          <TabsContent value="eizouden" className="entei-settings-tab-content">
            <EizouDenSettingsTab dict={dict} onResetPairing={onResetPairing} />
          </TabsContent>
          <TabsContent value="anki" className="entei-settings-tab-content">
            <AnkiFieldsTab
              dict={dict}
              onSessionCredentials={onSessionCredentials}
            />
          </TabsContent>
        </div>
      </div>
    </Tabs>
  );
}
