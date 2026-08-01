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
 * the capability token to a narrow callback (page memory only) for later
 * bridge integration. The normal local-file player flow is untouched.
 *
 * Scope: no yt-dlp, aria2, downloads, or torrent behavior.
 * --------------------------------------------------------------------------- */
'use client';

import { useCallback, useState } from 'react';
import { Plug, PlugZap } from 'lucide-react';
import { AspectRatio } from '@/components/player/ui/aspect-ratio';
import { Button } from '@/components/player/ui/button';
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
}

interface EizouDendenshiSetupProps {
  isConnected: boolean;
  /** Receives the capability token on successful pairing (page memory only). */
  onPairSuccess: (token: string) => void;
  dict: EizouDendenshiSetupDict;
}

export function EizouDendenshiSetup({
  isConnected,
  onPairSuccess,
  dict,
}: EizouDendenshiSetupProps) {
  const [isPairingDialogOpen, setIsPairingDialogOpen] = useState(false);

  const handlePairSuccess = useCallback(
    (token: string) => {
      onPairSuccess(token);
    },
    [onPairSuccess],
  );

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
            {isConnected ? dict.eizouConnected : dict.eizouDisconnected}
          </span>
        </div>
      </div>
      <EizouDendenshiPairingDialog
        open={isPairingDialogOpen}
        onOpenChange={setIsPairingDialogOpen}
        onPairSuccess={handlePairSuccess}
        dict={dict}
      />
    </section>
  );
}
