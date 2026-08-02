/**
 * EizouDendenshiSetup — ED-3 empty-state setup section (visual mocks).
 * ---------------------------------------------------------------------------
 * Desktop (>=768): 200px 1:1 image placeholder left; content right with a
 * ~48px heading and a left-aligned row of two 132px controls: the Setup
 * button and the non-interactive connection status. Mobile: image above;
 * the two controls centered (side-by-side, wrapping only below feasible
 * widths), the row overlapping the image lower edge halfway; centered ~36px
 * heading below. The pairing dialog is owned here; a successful pair only
 * flips the visible connected/disconnected state for this section and hands
 * the capability token to a narrow callback (persisted by the caller's
 * pairing hook — see use-companion-pairing) for later bridge integration.
 *
 * When connected, an explicit DESTRUCTIVE reset control (Lucide Unplug +
 * shadcn Button, destructive variant) opens a confirmation Dialog; the
 * confirm action is delegated to the caller (companion DELETE first, then
 * browser storage cleared regardless of network outcome). The status
 * indicator itself is never interactive — no accidental remove from it.
 *
 * While a stored token is being re-validated after reload (validating),
 * the status shows a neutral "Checking…" label instead of a false
 * "Disconnected".
 *
 * Scope: no yt-dlp, aria2, downloads, or torrent behavior.
 * --------------------------------------------------------------------------- */
'use client';

import { useCallback, useState } from 'react';
import { Plug, PlugZap, Unplug } from 'lucide-react';
import { AspectRatio } from '@/components/player/ui/aspect-ratio';
import { Button } from '@/components/player/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/player/ui/dialog';
import {
  EizouDendenshiPairingDialog,
  type EizouDendenshiPairingDict,
} from '@/components/player/EizouDendenshiPairingDialog';

export interface EizouDendenshiSetupDict extends EizouDendenshiPairingDict {
  eizouSetupLabel: string;
  eizouSetupTitle: string;
  eizouSetupImageAlt: string;
  eizouConnected: string;
  eizouDisconnected: string;
  eizouChecking: string;
  eizouResetButton: string;
  eizouResetTitle: string;
  eizouResetDesc: string;
  eizouResetConfirm: string;
  eizouResetCancel: string;
}

interface EizouDendenshiSetupProps {
  isConnected: boolean;
  /** True while a persisted token is being re-validated after reload. */
  isValidating?: boolean;
  /** Receives the capability token on successful pairing (the caller
   *  persists it; page memory + opaque localStorage envelope only). */
  onPairSuccess: (token: string) => void;
  /** Explicit destructive reset: companion DELETE first, then clear. */
  onResetPairing: () => void | Promise<void>;
  dict: EizouDendenshiSetupDict;
}

export function EizouDendenshiSetup({
  isConnected,
  isValidating = false,
  onPairSuccess,
  onResetPairing,
  dict,
}: EizouDendenshiSetupProps) {
  const [isPairingDialogOpen, setIsPairingDialogOpen] = useState(false);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handlePairSuccess = useCallback(
    (token: string) => {
      onPairSuccess(token);
    },
    [onPairSuccess],
  );

  const handleResetConfirm = useCallback(async () => {
    if (isResetting) return;
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
    <section
      className="entei-eizou-section"
      aria-labelledby="entei-eizou-setup-title"
    >
      <div className="entei-eizou-visual">
        <AspectRatio ratio={1} className="entei-eizou-image">
          <img
            src="/eizou-dendenshi.webp"
            alt={dict.eizouSetupImageAlt}
            className="entei-eizou-art"
            draggable={false}
          />
        </AspectRatio>
      </div>
      <div className="entei-eizou-body">
        <h3 id="entei-eizou-setup-title" className="entei-eizou-title">
          {dict.eizouSetupTitle}
        </h3>
        <div className="entei-eizou-controls">
          <Button
            type="button"
            variant="outline"
            className="entei-eizou-setup-btn"
            onClick={() => setIsPairingDialogOpen(true)}
          >
            {dict.eizouSetupLabel}
          </Button>
          <span
            role="status"
            className={`entei-eizou-status-control${
              isConnected
                ? ' entei-eizou-status-control--connected'
                : ' entei-eizou-status-control--disconnected'
            }`}
          >
            {isConnected ? (
              <Plug size={16} aria-hidden="true" />
            ) : (
              <PlugZap size={16} aria-hidden="true" />
            )}
            {isValidating
              ? dict.eizouChecking
              : isConnected
                ? dict.eizouConnected
                : dict.eizouDisconnected}
          </span>
          {isConnected ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="entei-eizou-reset-btn"
              onClick={() => setIsResetDialogOpen(true)}
              aria-label={dict.eizouResetButton}
              title={dict.eizouResetButton}
            >
              <Unplug size={16} aria-hidden="true" />
              {dict.eizouResetButton}
            </Button>
          ) : null}
        </div>
      </div>
      <EizouDendenshiPairingDialog
        open={isPairingDialogOpen}
        onOpenChange={setIsPairingDialogOpen}
        onPairSuccess={handlePairSuccess}
        dict={dict}
      />
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
    </section>
  );
}
