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
};

export interface SettingsTabsProps {
  dict: Parameters<typeof AnkiFieldsTab>[0]['dict'];
  shortcuts: ShortcutEntry[];
  /** Anki export session callback (optional; player wires it, nav omits). */
  onSessionCredentials?: (creds: AnkiSessionCredentials | null) => void;
  /** Live subtitle settings from the player (optional; synced when present). */
  subtitleSettings?: Partial<SubtitleAppearanceSettings>;
  /** Live subtitle change callback from the player (optional). */
  onSubtitleSettingsChange?: (settings: Partial<SubtitleAppearanceSettings>) => void;
}

export function SettingsTabs({
  dict,
  shortcuts,
  onSessionCredentials,
  subtitleSettings,
  onSubtitleSettingsChange,
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
      // Persist to the same preferences store the player reads.
      const prefs = readPlayerPreferences();
      writePlayerPreferences({ ...prefs, ...settings });
      onSubtitleSettingsChange?.(settings);
    },
    [onSubtitleSettingsChange],
  );

  const handleSubtitleReset = useCallback(() => {
    setLocalSubtitle(DEFAULT_SUBTITLE_SETTINGS);
    const prefs = readPlayerPreferences();
    writePlayerPreferences({ ...prefs, ...DEFAULT_SUBTITLE_SETTINGS });
    onSubtitleSettingsChange?.(DEFAULT_SUBTITLE_SETTINGS);
  }, [onSubtitleSettingsChange]);

  const effective = subtitleSettings
    ? { ...localSubtitle, ...subtitleSettings }
    : localSubtitle;

  return (
    <Tabs defaultValue="player" className="entei-settings-tabs">
      <div className="entei-settings-body">
        <TabsList className="entei-settings-tabs-list">
          <TabsTrigger value="player">{dict.settingsTabPlayer}</TabsTrigger>
          <TabsTrigger value="subtitle">{dict.settingsTabSubtitle}</TabsTrigger>
          <TabsTrigger value="eizouden">{dict.settingsTabEizouDen}</TabsTrigger>
          <TabsTrigger value="anki">{dict.settingsTabAnki}</TabsTrigger>
        </TabsList>
        <div className="entei-settings-panel">
          <TabsContent value="player" className="entei-settings-tab-content">
            <div className="entei-settings-section">
              <p className="entei-settings-label">{dict.settingsShortcuts}</p>
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
          <TabsContent value="subtitle" className="entei-settings-tab-content">
            <SubtitleAppearanceTab
              dict={dict}
              settings={effective}
              onChange={handleSubtitleChange}
              onReset={handleSubtitleReset}
            />
          </TabsContent>
          <TabsContent value="eizouden" className="entei-settings-tab-content">
            <EizouDenSettingsTab dict={dict} />
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