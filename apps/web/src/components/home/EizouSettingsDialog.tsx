/**
 * EizouSettingsDialog — global settings dialog opened from the TopBar nav
 * settings button (desktop pill) and the mobile Dock's Settings entry.
 * ---------------------------------------------------------------------------
 * NAVIGATION_BAR.md "設定ボタンの追加 (2026-08-07)": the Settings modal can
 * be opened from any page and shows the SAME settings as the Player modal —
 * the shared SettingsTabs body (Player / Subtitle / EizouDen / Anki Fields).
 *
 * Only the title differs (settingsTitleGlobal "Settings" vs the player's
 * "Player Settings"); the keyboard-shortcut reference is rebuilt from the
 * same dictionary the Player uses, so the Player tab is identical.
 *
 * The dict string props are supplied by the Astro TopBar (serializable —
 * playerUI is all strings), so the island boundary stays JSON-clean. The
 * ED-3 pairing reset is self-contained INSIDE this island (read token →
 * companion DELETE → clear store), so Home / Tracker also show the
 * "Reset pairing" control in the EizouDen tab — without starting a second
 * status-poll loop (the Player's own hook already polls shared
 * localStorage).
 * ---------------------------------------------------------------------------
 */

'use client';

import { useCallback, useState } from 'react';
import { Settings } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/player/ui/dialog';
import { SettingsTabs } from '@/components/player/SettingsTabs';
import { buildShortcuts } from '@/features/player/player-shortcuts';
import {
  readStoredPairingToken,
  clearStoredPairingToken,
  COMPANION_PAIRING_BASE_URL,
} from '@/features/player/companion-pairing-store';
import type { Dictionary } from '@i18n/types';

export interface EizouSettingsDialogProps {
  /** Label for the trigger button (localized, e.g. "Settings"). */
  label: string;
  /** aria-label for the trigger. */
  triggerLabel: string;
  /** Variant: desktop pill button vs mobile dock link. */
  variant: 'pill' | 'dock';
  /** Full playerUI dictionary (all strings — serializable). */
  playerUI: Dictionary['playerUI'];
  /** Show the Shortcut tab (player-only keyboard reference). The TopBar
   *  passes true only when the current route is /player. */
  showShortcuts?: boolean;
}

export function EizouSettingsDialog({
  label,
  triggerLabel,
  variant,
  playerUI,
  showShortcuts = false,
}: EizouSettingsDialogProps) {
  const [open, setOpen] = useState(false);

  /** ED-3 explicit destructive pairing reset, self-contained inside the
   *  island so Home / Tracker show the "Reset pairing" control in the
   *  EizouDen tab too (mirrors useCompanionPairing().resetPairing without
   *  starting a second status poll on every page mount). */
  const handleResetPairing = useCallback(async () => {
    const token = readStoredPairingToken();
    // 1. Companion-side delete FIRST while a token exists (best effort).
    if (token !== null) {
      try {
        await fetch(
          `${COMPANION_PAIRING_BASE_URL}/v1/pair?token=${encodeURIComponent(token)}`,
          { method: 'DELETE', cache: 'no-store' },
        );
      } catch {
        // Companion unreachable: the browser-side clear below is still
        // authoritative (graceful divergence).
      }
    }
    // 2. Clear browser storage regardless of network outcome.
    clearStoredPairingToken();
  }, []);

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
        {variant === 'dock' && <span>{label}</span>}
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
        <SettingsTabs
          dict={playerUI}
          shortcuts={buildShortcuts(playerUI)}
          showShortcuts={showShortcuts}
          onResetPairing={handleResetPairing}
        />
      </DialogContent>
    </Dialog>
  );
}
