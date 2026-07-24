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

import { useEffect } from 'react';
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
import type { Dictionary } from '@i18n/types';
import type { ShortcutEntry } from './KeyboardShortcutsHelp';

interface PlayerSettingsDialogProps {
  dict: Dictionary['playerUI'];
  shortcuts: ShortcutEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSessionCredentials?: (creds: AnkiSessionCredentials | null) => void;
}

export function PlayerSettingsDialog({
  dict,
  shortcuts,
  open,
  onOpenChange,
  onSessionCredentials,
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
              <TabsTrigger value="player">
                {dict.settingsTabPlayer}
              </TabsTrigger>
              <TabsTrigger value="anki">
                {dict.settingsTabAnki}
              </TabsTrigger>
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
                      <div
                        key={s.key}
                        className="entei-settings-shortcut-row"
                      >
                        <kbd className="entei-shortcut-key">{s.key}</kbd>
                        <span className="entei-shortcut-desc">
                          {s.desc}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </TabsContent>
              <TabsContent
                value="anki"
                className="entei-settings-tab-content"
              >
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
