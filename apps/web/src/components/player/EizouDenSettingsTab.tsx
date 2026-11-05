/**
 * EizouDenSettingsTab — YouTube download mode (Quality / Speed) settings.
 * ---------------------------------------------------------------------------
 * EIZOU_DENDENSHI.md "YouTube 再生モード設定 (2026-08-07)".
 *
 * - Speed (default, changed 2026-08-08): progressive formats preferred
 *   (360p-1080p), plays while downloading (ED-2H instant-playback flow).
 * - Quality: DASH 1080p cap, plays after mux completes.
 *
 * Persisted to localStorage under `entei.eizou.yt-mode.v1`. The setting
 * applies to the NEXT download (never the in-flight job).
 *
 * The tab is also the home of the explicit DESTRUCTIVE pairing reset
 * (ED-3): a Lucide Unplug + shadcn Button (destructive variant) opens a
 * confirmation Dialog; the confirm action is delegated to the caller's
 * `onResetPairing` (companion DELETE first, then browser storage cleared
 * regardless of network outcome). Supplied by both the Player settings
 * modal (via the useCompanionPairing hook) and the global nav settings
 * modal (self-contained implementation inside the EizouSettingsDialog
 * island).
 *
 * PAIRING ENTRY POINT (Phase 2 transition): EizouDendenshiSetup was
 * retired from the Player empty state (which now only shows the local
 * MediaPicker plus the enabled source module slots), so an unpaired user
 * would have no way to pair. When `onPairSuccess` is wired and the
 * browser is NOT paired, this tab shows a plain "EizouDendenshi Pairing"
 * button that opens EizouDendenshiPairingDialog (the same OTP dialog the
 * old empty-state section owned). The dialog still hands the token to
 * `onPairSuccess` only — no storage access here.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useCallback, useState } from 'react';
import { Link2, Unplug } from 'lucide-react';
import {
  EizouDendenshiPairingDialog,
  type EizouDendenshiPairingDict,
} from '@/components/player/EizouDendenshiPairingDialog';
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
  | 'settingsEizouDenContentHeading'
  | 'ytModeQuality'
  | 'ytModeSpeed'
  | 'ytModeQualityDesc'
  | 'ytModeSpeedDesc'
  // Pairing entry point (unpaired browsers only).
  | 'eizouPairingOpenButton'
  // Pairing reset (destructive — EizouDen tab is its only home).
  | 'eizouResetButton'
  | 'eizouResetTitle'
  | 'eizouResetDesc'
  | 'eizouResetConfirm'
  | 'eizouResetCancel'
  | 'dialogClose'
> &
  EizouDendenshiPairingDict;

interface EizouDenSettingsTabProps {
  dict: EizouDenPlayerUI;
  /** Explicit destructive reset (player wiring): companion DELETE first,
   *  then clear. The reset control only renders when this is provided
   *  (player settings modal; the global nav modal has no pairing context). */
  onResetPairing?: () => void | Promise<void>;
  /** True when this browser already holds a paired companion session.
   *  The pairing button renders only when this is not true. */
  isPaired?: boolean;
  /** Receives the capability token on a successful pair (the caller
   *  persists it). The pairing button/dialog only render when provided. */
  onPairSuccess?: (token: string) => void;
  /** Locale for the tutorial link inside the pairing dialog. */
  locale?: 'id' | 'ja' | 'en';
}

export function EizouDenSettingsTab({
  dict,
  onResetPairing,
  isPaired = false,
  onPairSuccess,
  locale = 'id',
}: EizouDenSettingsTabProps) {
  const [mode, setMode] = useState<YtDownloadMode>(() =>
    readYtDownloadMode(),
  );
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isPairingOpen, setIsPairingOpen] = useState(false);

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
      {onPairSuccess && !isPaired ? (
        <div className="entei-eizouden-pair-section">
          <Button
            type="button"
            variant="default"
            className="entei-eizouden-pair-btn"
            onClick={() => setIsPairingOpen(true)}
          >
            <Link2 size={16} aria-hidden="true" />
            {dict.eizouPairingOpenButton}
          </Button>
          <EizouDendenshiPairingDialog
            open={isPairingOpen}
            onOpenChange={setIsPairingOpen}
            onPairSuccess={onPairSuccess}
            dict={dict}
            locale={locale}
          />
        </div>
      ) : null}
      <h3 className="entei-settings-label">{dict.settingsEizouDenContentHeading}</h3>
      <RadioGroup
        className="entei-eizouden-mode-group"
        value={mode}
        onValueChange={handleChange}
        aria-label={dict.settingsEizouDenContentHeading}
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
