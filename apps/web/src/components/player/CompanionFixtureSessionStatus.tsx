/**
 * CompanionFixtureSessionStatus — ED-2E session status banner.
 * ---------------------------------------------------------------------------
 * Shown only while an actual companion fixture session is active and not
 * playing: buffering (accessible progress), error, disconnected, or
 * re-pair required. Never rendered during idle/ready/playing, and never
 * part of the local-file flow. Re-pairing happens through the EizouDendenshi
 * setup section; the banner only ends the session.
 * ---------------------------------------------------------------------------
 */
'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/player/ui/button';
import type {
  CompanionBridgePhase,
  CompanionBridgeProgress,
} from '@/features/player/companion-bridge';

export interface CompanionFixtureSessionStatusDict {
  eizouSessionBuffering: string;
  eizouSessionProgressLabel: string;
  eizouSessionError: string;
  eizouSessionRePairRequired: string;
  eizouSessionEnd: string;
}

interface CompanionFixtureSessionStatusProps {
  phase: CompanionBridgePhase;
  progress: CompanionBridgeProgress | null;
  reason: string | null;
  onEndSession: () => void;
  dict: CompanionFixtureSessionStatusDict;
}

export function CompanionFixtureSessionStatus({
  phase,
  progress,
  reason,
  onEndSession,
  dict,
}: CompanionFixtureSessionStatusProps) {
  if (phase === 'idle' || phase === 'ready' || phase === 'playing') {
    return null;
  }

  let message: string;
  if (phase === 'buffering') {
    message = dict.eizouSessionBuffering;
  } else if (phase === 'rePairRequired') {
    message = dict.eizouSessionRePairRequired;
  } else {
    // error / disconnected
    message = dict.eizouSessionError;
  }

  return (
    <div className="entei-fixture-status">
      <span className="entei-fixture-status-message" role="status">
        {phase === 'buffering' && (
          <Loader2
            className="entei-fixture-status-spinner"
            size={16}
            aria-hidden="true"
          />
        )}
        <span>{message}</span>
        {phase === 'buffering' && progress && (
          <span className="entei-fixture-status-progress">
            <span className="entei-sr-only">
              {dict.eizouSessionProgressLabel}
            </span>
            {progress.available} / {progress.total}
          </span>
        )}
        {reason && phase !== 'buffering' && (
          <span className="entei-fixture-status-reason">{reason}</span>
        )}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="entei-fixture-status-end"
        onClick={onEndSession}
      >
        {dict.eizouSessionEnd}
      </Button>
    </div>
  );
}
