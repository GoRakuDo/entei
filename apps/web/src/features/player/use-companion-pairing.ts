/**
 * useCompanionPairing — persistent EizouDendenshi pairing state.
 * ---------------------------------------------------------------------------
 * Owns the browser-side pairing lifecycle for the Player:
 *
 * - On mount, reads the persisted opaque token (companion-pairing-store)
 *   and re-validates it against the companion's authenticated status
 *   endpoint (GET /v1/pair/status?token=…). `connected` becomes true ONLY
 *   on HTTP 200 — so a reload with a valid stored token shows connected,
 *   while an invalid/stale token (companion reset, deletion, restart with
 *   fresh credentials) clears the stored value and shows unpaired (never
 *   a false "connected"). Reload validation is a pure read: it never
 *   creates pairing state on the companion.
 *
 * - On pair success, the opaque token is persisted to localStorage
 *   (schema-versioned envelope; ONLY the token — never the code, a
 *   source URL, magnet, media, or cookies) and the session is connected.
 *
 * - resetPairing is the explicit destructive reset: it calls
 *   DELETE /v1/pair?token=… on the companion FIRST while a token exists,
 *   then clears browser storage and memory state REGARDLESS of the
 *   network outcome (graceful divergence: the browser always ends
 *   unpaired; a companion that is unreachable keeps its credential until
 *   the user resets it from the CLI or another paired browser).
 *
 * Privacy: the token is used only in the loopback request query strings
 * (the established PoC contract) and in the opaque localStorage envelope.
 * It never appears in the DOM, browser history, logs, error text, or
 * analytics.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearStoredPairingToken,
  isValidPairingToken,
  readStoredPairingToken,
  writeStoredPairingToken,
} from '@/features/player/companion-pairing-store';

/** Loopback companion origin; the only accepted pairing endpoint. */
export const COMPANION_PAIRING_BASE_URL = 'http://127.0.0.1:4322';

export interface UseCompanionPairingResult {
  /** Opaque capability token for the current session (null = unpaired). */
  token: string | null;
  /**
   * Stable ref mirroring `token` — lets existing handlers read the
   * current token without re-binding callbacks.
   */
  tokenRef: { current: string | null };
  /** True only after the status endpoint accepted the token (200). */
  connected: boolean;
  /** True while a stored token is being re-validated after mount. */
  validating: boolean;
  /** Persist the token (pair success) and connect. */
  handlePairSuccess: (token: string) => void;
  /** Explicit destructive reset: companion DELETE first, then clear. */
  resetPairing: () => Promise<void>;
}

export function useCompanionPairing(): UseCompanionPairingResult {
  const [token, setToken] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [validating, setValidating] = useState(false);
  const tokenRef = useRef<string | null>(null);

  // Mount validation: re-validate a persisted token against the
  // companion. 200 → connected (the pairing survives F5/restart);
  // 401/403 → the stored token is dead (companion reset) — clear it and
  // behave unpaired; network failure → the companion is simply not
  // running, so KEEP the stored token and show disconnected (a later
  // reload can validate again). Never writes any server state.
  useEffect(() => {
    const stored = readStoredPairingToken();
    if (stored === null) return;
    let stale = false;
    const ac = new AbortController();
    setValidating(true);
    void (async () => {
      try {
        const res = await fetch(
          `${COMPANION_PAIRING_BASE_URL}/v1/pair/status?token=${encodeURIComponent(stored)}`,
          { cache: 'no-store', signal: ac.signal },
        );
        if (stale) return;
        if (res.ok) {
          tokenRef.current = stored;
          setToken(stored);
          setConnected(true);
          return;
        }
        if (res.status === 401 || res.status === 403) {
          // The companion explicitly rejected the stored token (pairing
          // was reset/deleted): clear it and show unpaired.
          clearStoredPairingToken();
          return;
        }
        // Any other status: keep the stored token, stay disconnected.
      } catch {
        // Network error / abort: companion unreachable — keep the stored
        // token for the next reload, stay disconnected.
      } finally {
        if (!stale) setValidating(false);
      }
    })();
    return () => {
      stale = true;
      ac.abort();
    };
  }, []);

  const handlePairSuccess = useCallback((nextToken: string) => {
    if (!isValidPairingToken(nextToken)) return; // defensive; fail closed
    writeStoredPairingToken(nextToken); // persist ONLY the opaque token
    tokenRef.current = nextToken;
    setToken(nextToken);
    setConnected(true);
  }, []);

  const resetPairing = useCallback(async () => {
    const current = tokenRef.current;
    // 1. Companion-side delete FIRST while a token exists (best effort).
    if (current !== null) {
      try {
        await fetch(
          `${COMPANION_PAIRING_BASE_URL}/v1/pair?token=${encodeURIComponent(current)}`,
          { method: 'DELETE', cache: 'no-store' },
        );
      } catch {
        // Companion unreachable: the browser-side clear below is still
        // authoritative for this page (graceful divergence).
      }
    }
    // 2. Clear browser storage + memory regardless of network outcome.
    clearStoredPairingToken();
    tokenRef.current = null;
    setToken(null);
    setConnected(false);
    setValidating(false);
  }, []);

  return {
    token,
    tokenRef,
    connected,
    validating,
    handlePairSuccess,
    resetPairing,
  };
}
