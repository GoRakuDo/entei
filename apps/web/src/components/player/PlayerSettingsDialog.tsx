/**
 * PlayerSettingsDialog — Dialog-based Settings Modal (AM-1)
 * ---------------------------------------------------------------------------
 * Workspace layout:
 * - Desktop: horizontal tab strip below header + full-width scrollable panel
 * - Mobile: sheet-like full-viewport, horizontal tabs at top
 * - Uses existing Dialog wrapper (focus trap, Escape, return-focus)
 * - Opening the modal does NOT pause media
 *
 * The tabbed body (Player / Subtitle / EizouDen / Anki Fields) is shared
 * with the global navigation settings modal (SettingsTabs) so both show
 * the exact same settings.
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
import {
  SettingsTabs,
  type SettingsTabsProps,
} from './SettingsTabs';
import type { SubtitleAppearanceSettings } from './SubtitleAppearanceTab';
import type { Dictionary } from '@i18n/types';
import type { ShortcutEntry } from './KeyboardShortcutsHelp';

interface PlayerSettingsDialogProps {
  dict: Dictionary['playerUI'];
  shortcuts: ShortcutEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSessionCredentials?: SettingsTabsProps['onSessionCredentials'];
  /** Current subtitle overlay appearance settings (live from PlayerApp). */
  subtitleSettings?: Partial<SubtitleAppearanceSettings>;
  /** Callback when subtitle appearance settings change (live update). */
  onSubtitleSettingsChange?: SettingsTabsProps['onSubtitleSettingsChange'];
  /** Explicit destructive pairing reset (ED-3), forwarded to the
   *  EizouDen tab from PlayerApp's use-companion-pairing. */
  onResetPairing?: SettingsTabsProps['onResetPairing'];
}

export function PlayerSettingsDialog({
  dict,
  shortcuts,
  open,
  onOpenChange,
  onSessionCredentials,
  subtitleSettings,
  onSubtitleSettingsChange,
  onResetPairing,
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
        <SettingsTabs
          dict={dict}
          shortcuts={shortcuts.map((s) => ({ key: s.key, desc: s.desc }))}
          showShortcuts={true}
          onSessionCredentials={onSessionCredentials}
          subtitleSettings={subtitleSettings}
          onSubtitleSettingsChange={onSubtitleSettingsChange}
          onResetPairing={onResetPairing}
        />
      </DialogContent>
    </Dialog>
  );
}
