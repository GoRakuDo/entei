/**
 * EizouSettingsDialog — stand-alone EizouDen settings dialog for the TopBar
 * nav settings button (desktop) and the mobile Dock's Settings entry.
 * ---------------------------------------------------------------------------
 * NAVIGATION_BAR.md "設定ボタンの追加 (2026-08-07)": the Settings modal can be
 * opened from any page. It reuses the same EizouDen Settings tab as the
 * Player settings modal (shared component).
 *
 * The dict string props are supplied by the Astro TopBar (serializable);
 * this avoids passing the full dictionary (which contains functions that
 * cannot cross the island boundary).
 * ---------------------------------------------------------------------------
 */

'use client';

import { useState } from 'react';
import { Settings } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/player/ui/dialog';
import { EizouDenSettingsTab, type EizouDenPlayerUI } from '@/components/player/EizouDenSettingsTab';

export interface EizouSettingsDialogProps {
  /** Label for the trigger button (localized, e.g. "Settings"). */
  label: string;
  /** aria-label for the trigger. */
  triggerLabel: string;
  /** Variant: desktop pill button vs mobile dock link. */
  variant: 'pill' | 'dock';
  /** Minimal playerUI dict slice (serializable strings only). */
  playerUI: EizouDenPlayerUI & { settingsTitle: string; dialogClose: string };
}

export function EizouSettingsDialog({
  label,
  triggerLabel,
  variant,
  playerUI,
}: EizouSettingsDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        className={
          variant === 'pill'
            ? 'entei-desktop-pill-link entei-nav-settings-trigger'
            : 'entei-mobile-dock-link entei-nav-settings-trigger'
        }
        aria-label={triggerLabel}
        title={triggerLabel}
        data-entei-nav-settings
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Settings aria-hidden="true" className="entei-nav-settings-icon" />
        <span>{label}</span>
      </button>
      <DialogContent
        closeLabel={playerUI.dialogClose}
        className="entei-settings-dialog"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{playerUI.settingsTitle}</DialogTitle>
        </DialogHeader>
        <div className="entei-settings-panel">
          <EizouDenSettingsTab dict={playerUI} />
        </div>
      </DialogContent>
    </Dialog>
  );
}