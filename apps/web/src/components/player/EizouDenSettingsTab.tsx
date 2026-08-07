/**
 * EizouDenSettingsTab — YouTube download mode (Quality / Speed) settings.
 * ---------------------------------------------------------------------------
 * EIZOU_DENDENSHI.md "YouTube 再生モード設定 (2026-08-07)".
 *
 * - Quality (default): DASH 1080p cap, plays after mux completes.
 * - Speed: progressive formats preferred (360p-1080p), plays while
 *   downloading (ED-2H instant-playback flow).
 *
 * Persisted to localStorage under `entei.eizou.yt-mode.v1`. The setting
 * applies to the NEXT download (never the in-flight job).
 *
 * The tab is also the home of the explicit DESTRUCTIVE pairing reset
 * (ED-3): a Lucide Unplug + shadcn Button (destructive variant) opens a
 * confirmation Dialog; the confirm action is delegated to the caller's
 * `onResetPairing` (companion DELETE first, then browser storage cleared
 * regardless of network outcome). Given on the Player settings modal only
 * (never across the Astro island boundary — functions are supplied inside
 * the React island).
 * ---------------------------------------------------------------------------
 */

'use client';

import { useCallback, useState } from 'react';
import { Unplug } from 'lucide-react';
import { RadioGroup, RadioGroupItem } from '@/components/player/ui/radio-group';
import { Button } from '@/components/player/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/player/ui/dialog';
import type { Dictionary } from '@i18n/types';
import {
  readYtDownloadMode,
  writeYtDownloadMode,
  type YtDownloadMode,
} from '@/features/player/yt-download-mode';

export type EizouDenPlayerUI = Pick<
  Dictionary['playerUI'],
  | 'settingsTabEizouDen'
  | 'ytModeQuality'
  | 'ytModeSpeed'
  | 'ytModeQualityDesc'
  | 'ytModeSpeedDesc'
  // Pairing reset (destructive — EizouDen tab is its only home).
  | 'eizouResetButton'
  | 'eizouResetTitle'
  | 'eizouResetDesc'
  | 'eizouResetConfirm'
  | 'eizouResetCancel'
  | 'dialogClose'
>;

interface EizouDenSettingsTabProps {
  dict: EizouDenPlayerUI;
  /** Explicit destructive reset (player wiring): companion DELETE first,
   *  then clear. The reset control only renders when this is provided
   *  (player settings modal; the global nav modal has no pairing context). */
  onResetPairing?: () => void | Promise<void>;
}

export function EizouDenSettingsTab({
  dict,
  onResetPairing,
}: EizouDenSettingsTabProps) {
  const [mode, setMode] = useState<YtDownloadMode>(() =>
    readYtDownloadMode(),
  );
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleChange = (value: string) => {
    const next = value as YtDownloadMode;
    setMode(next);
    writeYtDownloadMode(next);
  };

  const handleResetConfirm = useCallback(async () => {
    if (isResetting || !onResetPairing) return;
    setIsResetting(true);
    try {
      await onResetPairing();
    } catch {
      // Graceful divergence: the browser-side unpaired state is
      // authoritative. A failed companion DELETE (unreachable) must not
      // block the dialog from closing.
    } finally {
      setIsResetting(false);
      setIsResetDialogOpen(false);
    }
  }, [isResetting, onResetPairing]);

  return (
    <div className="entei-settings-section">
      <p className="entei-settings-label">{dict.settingsTabEizouDen}</p>
      <RadioGroup
        className="entei-eizouden-mode-group"
        value={mode}
        onValueChange={handleChange}
        aria-label={dict.settingsTabEizouDen}
      >
        <div className="entei-eizouden-mode-option">
          <RadioGroupItem
            value="quality"
            id="entei-yt-mode-quality"
            className="entei-eizouden-mode-radio"
          />
          <label
            htmlFor="entei-yt-mode-quality"
            className="entei-eizouden-mode-label"
          >
            <span className="entei-eizouden-mode-name">
              {dict.ytModeQuality}
            </span>
            <span className="entei-eizouden-mode-desc">
              {dict.ytModeQualityDesc}
            </span>
          </label>
        </div>
        <div className="entei-eizouden-mode-option">
          <RadioGroupItem
            value="speed"
            id="entei-yt-mode-speed"
            className="entei-eizouden-mode-radio"
          />
          <label
            htmlFor="entei-yt-mode-speed"
            className="entei-eizouden-mode-label"
          >
            <span className="entei-eizouden-mode-name">{dict.ytModeSpeed}</span>
            <span className="entei-eizouden-mode-desc">
              {dict.ytModeSpeedDesc}
            </span>
          </label>
        </div>
      </RadioGroup>
      {onResetPairing ? (
        <div className="entei-eizouden-reset-section">
          <Button
            type="button"
            variant="destructive"
            className="entei-eizouden-reset-btn"
            onClick={() => setIsResetDialogOpen(true)}
            aria-label={dict.eizouResetButton}
          >
            <Unplug size={16} aria-hidden="true" />
            {dict.eizouResetButton}
          </Button>
          <Dialog open={isResetDialogOpen} onOpenChange={setIsResetDialogOpen}>
            <DialogContent
              className="entei-eizou-reset-dialog"
              closeLabel={dict.dialogClose}
            >
              <DialogHeader>
                <DialogTitle className="entei-magnet-dialog-title">
                  {dict.eizouResetTitle}
                </DialogTitle>
                <DialogDescription className="entei-sr-only">
                  {dict.eizouResetDesc}
                </DialogDescription>
              </DialogHeader>
              <p className="entei-eizou-reset-desc">{dict.eizouResetDesc}</p>
              <div className="entei-eizou-reset-actions">
                <Button
                  type="button"
                  variant="outline"
                  className="entei-eizou-reset-cancel"
                  onClick={() => setIsResetDialogOpen(false)}
                  disabled={isResetting}
                >
                  {dict.eizouResetCancel}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className="entei-eizou-reset-confirm"
                  onClick={() => void handleResetConfirm()}
                  disabled={isResetting}
                >
                  <Unplug size={16} aria-hidden="true" />
                  {dict.eizouResetConfirm}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
    </div>
  );
}
