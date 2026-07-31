/**
 * EizouDendenshiSetup — ED-3 empty-state setup section (visual mocks).
 * ---------------------------------------------------------------------------
 * Desktop (>=768): 200x140-ish 1:1 image placeholder left; content right
 * with a ~48px heading, 18px description, and a left-aligned 132x40 Setup
 * button. Mobile: image above; the 132x40 Setup button centered, overlapping
 * the image lower edge halfway; centered ~36px heading and 18px description
 * below. The pairing dialog is owned here; a successful pair only flips the
 * visible connected/disconnected state for this section and hands the
 * capability token to a narrow callback (page memory only) for later bridge
 * integration. The normal local-file player flow is untouched.
 *
 * Scope: no yt-dlp, aria2, downloads, or torrent behavior.
 * --------------------------------------------------------------------------- */
'use client';

import { useCallback, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { AspectRatio } from '@/components/player/ui/aspect-ratio';
import { Button } from '@/components/player/ui/button';
import {
  EizouDendenshiPairingDialog,
  type EizouDendenshiPairingDict,
} from '@/components/player/EizouDendenshiPairingDialog';

export interface EizouDendenshiSetupDict extends EizouDendenshiPairingDict {
  eizouSetupLabel: string;
  eizouSetupTitle: string;
  eizouSetupDesc: string;
  eizouSetupImageAlt: string;
  eizouConnected: string;
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
          <ImageIcon size={40} aria-hidden="true" />
          <span className="entei-sr-only">{dict.eizouSetupImageAlt}</span>
        </AspectRatio>
      </div>
      <div className="entei-eizou-body">
        <h3 id="entei-eizou-setup-title" className="entei-eizou-title">
          {dict.eizouSetupTitle}
        </h3>
        <p className="entei-eizou-desc">{dict.eizouSetupDesc}</p>
        {isConnected && (
          <p className="entei-eizou-status" role="status">
            <span className="entei-eizou-status-dot" aria-hidden="true" />
            {dict.eizouConnected}
          </p>
        )}
        <Button
          type="button"
          variant="default"
          className="entei-eizou-setup-btn"
          onClick={() => setIsPairingDialogOpen(true)}
        >
          {dict.eizouSetupLabel}
        </Button>
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
