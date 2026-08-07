/**
 * EizouDendenshiPairingDialog — ED-3 pairing modal (visual mock: 320x200).
 * ---------------------------------------------------------------------------
 * Local companion pairing: the user types the 6-digit code shown by the
 * companion app (terminal/OTP), and the browser POSTs it directly to
 * `http://127.0.0.1:4322/v1/pair` with the page's natural Origin. The
 * capability token is accepted **only on HTTP 200** and handed to a narrow
 * callback; the CALLER's pairing hook persists it (opaque localStorage
 * envelope; see use-companion-pairing) — this dialog itself never touches
 * any storage, and neither the code nor the token ever appears in
 * localStorage, IndexedDB, sessionStorage, cookies, URL, console, error
 * text, or telemetry. OTP digits and any token are cleared on close and on
 * unmount. Errors are localized and generic: no code/token/request detail.
 *
 * Scope: no yt-dlp, aria2, downloads, cookie upload, or torrent behavior.
 * --------------------------------------------------------------------------- */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/player/ui/dialog';
import { Button } from '@/components/player/ui/button';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/player/ui/input-otp';

/** Companion pair endpoint — loopback only, fixed for this stage (ED-3). */
const PAIR_ENDPOINT = 'http://127.0.0.1:4322/v1/pair';

type PairErrorKind = 'incomplete' | 'network' | 'invalidCode' | 'generic';

export interface EizouDendenshiPairingDict {
  eizouPairingTitle: string;
  eizouPairingOtpLabel: string;
  eizouPairingOtpInvalid: string;
  eizouPairingSubmit: string;
  eizouPairingConnecting: string;
  eizouPairingErrorNetwork: string;
  eizouPairingErrorInvalidCode: string;
  eizouPairingErrorGeneric: string;
  dialogClose: string;
}

interface EizouDendenshiPairingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the capability token on a successful pair; the pairing
   *  controller persists it opaquely (this dialog never writes storage). */
  onPairSuccess: (token: string) => void;
  dict: EizouDendenshiPairingDict;
}

export function EizouDendenshiPairingDialog({
  open,
  onOpenChange,
  onPairSuccess,
  dict,
}: EizouDendenshiPairingDialogProps) {
  const [code, setCode] = useState('');
  const [isPairing, setIsPairing] = useState(false);
  const [errorKind, setErrorKind] = useState<PairErrorKind | null>(null);
  // Guards stale responses after close/unmount; the in-flight request is
  // aborted so nothing is ever acted on twice.
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const clearAll = useCallback(() => {
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setCode('');
    setIsPairing(false);
    setErrorKind(null);
  }, []);

  // Unmount cleanup: abort any in-flight pair request, drop OTP + token.
  useEffect(() => clearAll, [clearAll]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) clearAll();
      onOpenChange(nextOpen);
    },
    [clearAll, onOpenChange],
  );

  const handlePair = useCallback(async () => {
    if (isPairing) return; // single in-flight attempt only
    if (!/^\d{6}$/.test(code)) {
      setErrorKind('incomplete');
      return;
    }
    const epoch = epochRef.current;
    setErrorKind(null);
    setIsPairing(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await fetch(PAIR_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: abort.signal,
      });
      if (epoch !== epochRef.current) return; // closed/unmounted meanwhile
      if (!res.ok) {
        // 400/403 mean the code itself was rejected; never echo details.
        setErrorKind(
          res.status === 400 || res.status === 403
            ? 'invalidCode'
            : 'generic',
        );
        return;
      }
      // Accept the token ONLY on 200. Fail closed if the body is malformed.
      let token: unknown = null;
      try {
        const body: unknown = await res.json();
        token =
          typeof body === 'object' && body !== null
            ? (body as { token?: unknown }).token
            : null;
      } catch {
        token = null;
      }
      if (typeof token !== 'string' || token.length === 0) {
        setErrorKind('generic');
        return;
      }
      // Success: hand the token to the page-memory callback and close.
      onPairSuccess(token);
      handleOpenChange(false);
    } catch {
      // Network failure / abort — generic, localized, no request detail.
      if (epoch === epochRef.current) setErrorKind('network');
    } finally {
      if (epoch === epochRef.current) setIsPairing(false);
      abortRef.current = null;
    }
  }, [code, isPairing, onPairSuccess, handleOpenChange]);

  const errorMessage =
    errorKind === 'incomplete'
      ? dict.eizouPairingOtpInvalid
      : errorKind === 'network'
        ? dict.eizouPairingErrorNetwork
        : errorKind === 'invalidCode'
          ? dict.eizouPairingErrorInvalidCode
          : errorKind === 'generic'
            ? dict.eizouPairingErrorGeneric
            : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="entei-eizou-pair-dialog"
        closeLabel={dict.dialogClose}
      >
        <DialogHeader>
          {/* NOTE: intentionally NO DialogDescription. The OTP input is
            self-labelled via aria-label (eizouPairingOtpLabel), and a
            sr-only description was user-rejected to keep it out of the
            DOM entirely (user requirement). Radix's dev warning about a
            missing description does not appear in production builds. */}
          <DialogTitle className="entei-magnet-dialog-title">
            {dict.eizouPairingTitle}
          </DialogTitle>
        </DialogHeader>
        <div className="entei-eizou-pair-body">
          <InputOTP
            maxLength={6}
            value={code}
            onChange={(value) => {
              setCode(value.replace(/[^\d]/g, '').slice(0, 6));
              if (errorKind) setErrorKind(null);
            }}
            inputMode="numeric"
            pattern="[0-9]*"
            autoFocus
            aria-label={dict.eizouPairingOtpLabel}
            aria-invalid={errorKind !== null}
            disabled={isPairing}
          >
            <InputOTPGroup>
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot
                  key={index}
                  index={index}
                  className="entei-eizou-pair-otp-slot"
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
          {errorMessage && (
            <p className="entei-eizou-pair-error" role="alert">
              {errorMessage}
            </p>
          )}
          <Button
            type="button"
            variant="default"
            className="entei-eizou-pair-submit"
            onClick={() => void handlePair()}
            disabled={isPairing}
          >
            {isPairing ? dict.eizouPairingConnecting : dict.eizouPairingSubmit}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
