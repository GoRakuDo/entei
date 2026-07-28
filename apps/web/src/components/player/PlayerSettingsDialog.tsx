/**
 * PlayerSettingsDialog — Dialog-based Settings Modal (AM-1)
 * ---------------------------------------------------------------------------
 * Workspace layout:
 * - Desktop: horizontal tab strip below header + full-width scrollable panel
 * - Mobile: sheet-like full-viewport, horizontal tabs at top
 * - Uses existing Dialog wrapper (focus trap, Escape, return-focus)
 * - Opening the modal does NOT pause media
 * --------------------------------------------------------------------------- */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { Settings } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { AnkiFieldsTab, type AnkiSessionCredentials } from './AnkiFieldsTab';
import { SubtitleAppearanceTab } from './SubtitleAppearanceTab';
import type { Dictionary } from '@i18n/types';
import type { ShortcutEntry } from './KeyboardShortcutsHelp';
import { readPlayerPreferences, writePlayerPreferences } from '@/features/player/preferences';

interface PlayerSettingsDialogProps {
  dict: Dictionary['playerUI'];
  shortcuts: ShortcutEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSessionCredentials?: (creds: AnkiSessionCredentials | null) => void;
  /** Current subtitle overlay appearance settings (live from PlayerApp). */
  subtitleSettings?: {
    fontSize: number;
    textColor: string;
    backgroundColor: string;
    backgroundPadding: number;
    verticalPosition: number;
  };
  /** Callback when subtitle appearance settings change (live update). */
  onSubtitleSettingsChange?: (settings: Partial<{
    fontSize: number;
    textColor: string;
    backgroundColor: string;
    backgroundPadding: number;
    verticalPosition: number;
  }>) => void;
}

export function PlayerSettingsDialog({
  dict,
  shortcuts,
  open,
  onOpenChange,
  onSessionCredentials,
  subtitleSettings,
  onSubtitleSettingsChange,
}: PlayerSettingsDialogProps) {
  /* W6: Toggle root class to hide TopBar on mobile while Settings is open.
   * Cleanup removes class on close and unmount. */
  useEffect(() => {
    const root = document.documentElement;
    if (open) {
      root.classList.add('entei-settings-dialog-open');
    } else {
      root.classList.remove('entei-settings-dialog-open');
    }
    return () => {
      root.classList.remove('entei-settings-dialog-open');
    };
  }, [open]);

  // Load subtitle settings synchronously from passed prefs or localStorage.
  // No null → effect pattern: state is populated on first render to avoid flash.
  const [localSubtitleSettings, setLocalSubtitleSettings] = useState<{
    fontSize: number;
    textColor: string;
    backgroundColor: string;
    backgroundPadding: number;
    verticalPosition: number;
  }>(() => {
    if (subtitleSettings) return subtitleSettings;
    const prefs = readPlayerPreferences();
    return {
      fontSize: prefs.subtitleFontSize,
      textColor: prefs.subtitleTextColor,
      backgroundColor: prefs.subtitleBackgroundColor,
      backgroundPadding: prefs.subtitleBackgroundPadding,
      verticalPosition: prefs.subtitleVerticalPosition,
    };
  });

  // Sync when parent-controlled subtitleSettings prop changes (e.g., from PlayerApp state)
  useEffect(() => {
    if (subtitleSettings) {
      setLocalSubtitleSettings(subtitleSettings);
    }
  }, [subtitleSettings]);

  const handleSubtitleSettingsChange = useCallback((settings: Partial<{
    fontSize: number;
    textColor: string;
    backgroundColor: string;
    backgroundPadding: number;
    verticalPosition: number;
  }>) => {
    // Update local state for live preview
    setLocalSubtitleSettings((prev) => ({ ...prev, ...settings }));
    // Persist to localStorage
    const prefs = readPlayerPreferences();
    writePlayerPreferences({ ...prefs, ...settings });
    // Notify parent for live overlay update
    onSubtitleSettingsChange?.(settings);
  }, [onSubtitleSettingsChange]);

  const handleSubtitleReset = useCallback(() => {
    const defaults = {
      fontSize: 18,
      textColor: 'oklch(98% 0 0deg)',
      backgroundColor: 'oklch(0% 0 0 / 0.72)',
      backgroundPadding: 8,
      verticalPosition: 96,
    };
    setLocalSubtitleSettings(defaults);
    const prefs = readPlayerPreferences();
    writePlayerPreferences({ ...prefs, ...defaults });
    onSubtitleSettingsChange?.(defaults);
  }, [onSubtitleSettingsChange]);

  const effectiveSubtitleSettings = subtitleSettings ?? localSubtitleSettings;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="entei-controls-btn entei-controls-settings-btn"
          aria-label={dict.settingsLabel}
          title={dict.settingsLabel}
          onClick={(e) => e.stopPropagation()}
        >
          <Settings size={18} />
        </button>
      </DialogTrigger>
      <DialogContent
        closeLabel={dict.dialogClose}
        className="entei-settings-dialog"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{dict.settingsTitle}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="player" className="entei-settings-tabs">
          <div className="entei-settings-body">
            <TabsList className="entei-settings-tabs-list">
              <TabsTrigger value="player">{dict.settingsTabPlayer}</TabsTrigger>
              <TabsTrigger value="subtitle">{dict.settingsTabSubtitle}</TabsTrigger>
              <TabsTrigger value="anki">{dict.settingsTabAnki}</TabsTrigger>
            </TabsList>
            <div className="entei-settings-panel">
              <TabsContent
                value="player"
                className="entei-settings-tab-content"
              >
                <div className="entei-settings-section">
                  <p className="entei-settings-label">
                    {dict.settingsShortcuts}
                  </p>
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
                  settings={effectiveSubtitleSettings}
                  onChange={handleSubtitleSettingsChange}
                  onReset={handleSubtitleReset}
                />
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
      </DialogContent>
    </Dialog>
  );
}
