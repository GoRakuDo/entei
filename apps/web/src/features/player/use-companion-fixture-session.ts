/**
 * useCompanionFixtureSession — ED-2E fixture-only bridge integration.
 * ---------------------------------------------------------------------------
 * Wires the companion buffering bridge into the player for a *known fixture
 * session* only (localhost companion, `/v1/media/fixture`). This is the
 * internal path that the pairing token feeds; it is NOT a user-facing source
 * (Magnet / YouTube / downloaders remain out of scope).
 *
 * Lifecycle contract (ED-2E design):
 * - beginFixtureSession: requires a token; starts the controller poll; the
 *   growing media URL is NEVER assigned while buffering.
 * - complete gate: the controller reports `ready` → fixtureMediaUrl is
 *   surfaced (player renders the video element) → attachMediaElement()
 *   hands the element to the controller, which performs the explicit
 *   src/load, preserves pending seek and play intent.
 * - endFixtureSession: media switch / cancel / unmount — aborts polling,
 *   timers and media listeners. All state is page memory only.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  CompanionBridgePhase,
  CompanionBridgeProgress,
} from '@/features/player/companion-bridge';
import { useCompanionBridge } from '@/features/player/use-companion-bridge';

export interface CompanionFixtureSource {
  /** Loopback companion origin, e.g. "http://127.0.0.1:4322". */
  baseUrl: string;
  /** Page-memory capability token from pairing (never persisted). */
  token: string;
}

export interface UseCompanionFixtureSessionResult {
  /** True while a companion fixture session is active. */
  active: boolean;
  phase: CompanionBridgePhase;
  progress: CompanionBridgeProgress | null;
  reason: string | null;
  /** ED-2E fixture-only entry: begin a known companion fixture session. */
  beginFixtureSession: (source: CompanionFixtureSource) => void;
  /** End the session (media switch, cancel, unmount). */
  endFixtureSession: () => void;
  /** Feed the actual video element (existing ref architecture). */
  attachMediaElement: (el: HTMLVideoElement | null) => void;
  /** Media URL surfaced only once the controller reports `complete` —
   *  never while buffering. */
  fixtureMediaUrl: string | null;
  setPlayIntent: (play: boolean) => void;
  requestSeek: (seconds: number) => void;
}

export function useCompanionFixtureSession(): UseCompanionFixtureSessionResult {
  const bridge = useCompanionBridge();
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const sourceRef = useRef<CompanionFixtureSource | null>(null);
  const attachedRef = useRef(false);
  const intentCleanupRef = useRef<(() => void) | null>(null);

  // Complete gate: the media URL is derived at render time — it exists ONLY
  // once the controller reports `ready` or `playing` (never while buffering)
  // and the session is active, and is cleared when the session ends or the
  // source fails/re-pairs (the element unmounts with it). The player then
  // renders the video element, and attachMediaElement hands it to the
  // controller. Keeping it through `playing` matters: dropping it on the
  // play transition would unmount the element mid-playback (found by headed
  // Chrome QA).
  const fixtureMediaUrl = useMemo(() => {
    if (!active || !sourceRef.current) return null;
    if (bridge.phase !== 'ready' && bridge.phase !== 'playing') return null;
    const src = sourceRef.current;
    return `${src.baseUrl}/v1/media/fixture?token=${encodeURIComponent(src.token)}`;
  }, [active, bridge.phase]);

  const clearIntentListeners = useCallback(() => {
    intentCleanupRef.current?.();
    intentCleanupRef.current = null;
  }, []);

  const beginFixtureSession = useCallback(
    (source: CompanionFixtureSource) => {
      if (activeRef.current) bridge.endSession();
      sourceRef.current = source;
      activeRef.current = true;
      attachedRef.current = false;
      clearIntentListeners();
      setActive(true);
      // No media element exists yet (buffering shows in the empty state);
      // it is attached on the complete gate via attachMediaElement.
      bridge.beginSession(
        { baseUrl: source.baseUrl, token: source.token },
        null,
      );
    },
    [bridge, clearIntentListeners],
  );

  const endFixtureSession = useCallback(() => {
    if (!activeRef.current) return;
    bridge.endSession();
    sourceRef.current = null;
    activeRef.current = false;
    attachedRef.current = false;
    clearIntentListeners();
    setActive(false);
  }, [bridge, clearIntentListeners]);

  const attachMediaElement = useCallback(
    (el: HTMLVideoElement | null) => {
      if (!el || !activeRef.current || attachedRef.current) return;
      if (bridge.phase !== 'ready') return;
      attachedRef.current = true;
      bridge.attachMedia(el);

      // User play/pause/seek informs the bridge while the session is active.
      const onPlay = () => bridge.setPlayIntent(true);
      const onPause = () => bridge.setPlayIntent(false);
      const onSeeking = () => bridge.requestSeek(el.currentTime);
      el.addEventListener('play', onPlay);
      el.addEventListener('pause', onPause);
      el.addEventListener('seeking', onSeeking);
      intentCleanupRef.current = () => {
        el.removeEventListener('play', onPlay);
        el.removeEventListener('pause', onPause);
        el.removeEventListener('seeking', onSeeking);
      };
    },
    [bridge],
  );

  const setPlayIntent = useCallback(
    (play: boolean) => bridge.setPlayIntent(play),
    [bridge],
  );

  const requestSeek = useCallback(
    (seconds: number) => bridge.requestSeek(seconds),
    [bridge],
  );

  return {
    active,
    phase: bridge.phase,
    progress: bridge.progress,
    reason: bridge.reason,
    beginFixtureSession,
    endFixtureSession,
    attachMediaElement,
    fixtureMediaUrl,
    setPlayIntent,
    requestSeek,
  };
}
