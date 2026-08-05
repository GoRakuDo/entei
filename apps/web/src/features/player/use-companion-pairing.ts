/**
 * useCompanionPairing — persistent EizouDendenshi pairing state.
 * ---------------------------------------------------------------------------
 * Owns the browser-side pairing lifecycle for the Player:
 *
 * - On mount, reads the persisted opaque token (companion-pairing-store)
 *   and starts periodic polling against the companion's authenticated
 *   status endpoint (GET /v1/pair/status?token=…). While a token is
 *   stored, polling continues every POLL_INTERVAL_MS milliseconds so
 *   that a companion restart is automatically detected:
 *     - 200 → connected=true (Terhubung restored on next poll)
 *     - 401/403 → token cleared, polling stops (companion was reset)
 *     - Network / other failure → connected=false, token kept, polling
 *       continues (waiting for companion to come back)
 *   Polling uses setTimeout (not setInterval): the next tick is scheduled
 *   only after the previous check completes, preventing overlapping fetches.
 *   The first check sets `validating=true`; subsequent polls keep it false.
 *
 * - On pair success, the opaque token is persisted to localStorage
 *   (schema-versioned envelope; ONLY the token — never the code, a
 *   source URL, magnet, media, or cookies) and the session is connected.
 *   If polling was not yet running it is started automatically.
 *
 * - resetPairing is the explicit destructive reset: it calls
 *   DELETE /v1/pair?token=… on the companion FIRST while a token exists,
 *   then clears browser storage and memory state REGARDLESS of the
 *   network outcome (graceful divergence: the browser always ends
 *   unpaired; a companion that is unreachable keeps its credential until
 *   the user resets it from the CLI or another paired browser).
 *   Polling is stopped as part of the reset.
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

/** Interval between poll checks (ms). Matches companion restart window. */
export const POLL_INTERVAL_MS = 5_000;

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
  /** True only during the very first validation check after mount. */
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

  // --- Polling infrastructure (refs avoid re-binding, survive re-renders) ---
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  /** Stop any pending poll timer and abort any in-flight fetch. */
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pollAbortRef.current !== null) {
      pollAbortRef.current.abort();
      pollAbortRef.current = null;
    }
  }, []);

  /** Check one status endpoint. Returns a "should continue" boolean. */
  const checkStatus = useCallback(
    async (currentToken: string, stale: { current: boolean }): Promise<boolean> => {
      const ac = new AbortController();
      pollAbortRef.current = ac;
      try {
        const res = await fetch(
          `${COMPANION_PAIRING_BASE_URL}/v1/pair/status?token=${encodeURIComponent(currentToken)}`,
          { cache: 'no-store', signal: ac.signal },
        );
        if (stale.current) return false;

        if (res.ok) {
          tokenRef.current = currentToken;
          setToken(currentToken);
          setConnected(true);
          return true; // keep polling — companion may restart again
        }
        if (res.status === 401 || res.status === 403) {
          // Companion explicitly rejected the token (reset/deleted).
          clearStoredPairingToken();
          tokenRef.current = null;
          setToken(null);
          setConnected(false);
          return false; // stop polling — token is dead
        }
        // Other HTTP status (500 etc.): keep token, stay disconnected, retry.
        setConnected(false);
        return true;
      } catch {
        if (stale.current) return false;
        // Network error / abort: companion unreachable — keep token, retry.
        setConnected(false);
        return true;
      } finally {
        pollAbortRef.current = null;
      }
    },
    [],
  );

  /** Schedule the next poll after POLL_INTERVAL_MS. */
  const scheduleNextPoll = useCallback(
    (currentToken: string, stale: { current: boolean }) => {
      pollTimerRef.current = setTimeout(() => {
        if (stale.current) return;
        checkStatus(currentToken, stale).then((shouldContinue) => {
          if (shouldContinue && !stale.current) {
            scheduleNextPoll(currentToken, stale);
          }
        });
      }, POLL_INTERVAL_MS);
    },
    [checkStatus],
  );

  /** Start polling with the given token. No-op if already polling. */
  const startPolling = useCallback(
    (currentToken: string, stale: { current: boolean }) => {
      stopPolling();
      setValidating(true);
      checkStatus(currentToken, stale)
        .then((shouldContinue) => {
          if (stale.current) return;
          setValidating(false);
          if (shouldContinue) {
            scheduleNextPoll(currentToken, stale);
          }
        })
        .catch(() => {
          // Defensive: checkStatus itself catches all errors, but if
          // something unexpected throws, ensure validating is cleared.
          if (!stale.current) setValidating(false);
        });
    },
    [stopPolling, checkStatus, scheduleNextPoll],
  );

  // Mount: if a token is stored, begin polling immediately.
  const staleRef = useRef(false);
  useEffect(() => {
    staleRef.current = false;
    const stored = readStoredPairingToken();
    if (stored !== null) {
      startPolling(stored, staleRef);
    }
    return () => {
      staleRef.current = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  const handlePairSuccess = useCallback(
    (nextToken: string) => {
      if (!isValidPairingToken(nextToken)) return; // defensive; fail closed
      writeStoredPairingToken(nextToken); // persist ONLY the opaque token
      tokenRef.current = nextToken;
      setToken(nextToken);
      setConnected(true);
      // Ensure polling covers the newly-paired session.
      if (!pollTimerRef.current) {
        startPolling(nextToken, staleRef);
      }
    },
    [startPolling],
  );

  const resetPairing = useCallback(async () => {
    stopPolling();
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
  }, [stopPolling]);

  return {
    token,
    tokenRef,
    connected,
    validating,
    handlePairSuccess,
    resetPairing,
  };
}
