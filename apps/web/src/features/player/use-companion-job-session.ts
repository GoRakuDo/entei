/**
 * useCompanionJobSession — ED-2F/ED-2G source job → bridge integration.
 * ---------------------------------------------------------------------------
 * Wires the companion buffering bridge into the player for a real source
 * job (YouTube or torrent; localhost companion, `/v1/media/fixture` serving
 * the active job). The user-facing source dialog creates the job on the
 * companion and hands the opaque job id here; this hook polls the existing
 * status bridge and surfaces the media URL only on `complete`. The source
 * `kind` routes the cancel endpoint to the correct job API.
 *
 * Lifecycle contract:
 * - beginJobSession: requires a token + job id; starts the controller poll;
 *   the media URL is surfaced immediately so the player renders the video
 *   element, whose initial 503 the bridge catches (error listener bound
 *   via attachMediaElement during buffering) and recovers with an explicit
 *   src/load once the status turns playable.
 * - complete gate: the controller reports `ready` → the mounted element is
 *   handed to the controller (explicit src/load, pending seek, play intent).
 * - cancelActiveJob: POSTs the companion job-cancel endpoint (freeing the
 *   one-active session and its private temp dir) then ends the local
 *   session. Used by the banner's End button and by media switch.
 * - endJobSession: local-only end (media switch / unmount safety).
 * All state is page memory only — never localStorage/IndexedDB/
 * sessionStorage/cookies/URL/logs.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  CompanionBridgePhase,
  CompanionBridgeProgress,
} from '@/features/player/companion-bridge';
import { useCompanionBridge } from '@/features/player/use-companion-bridge';

export type CompanionJobKind = 'youtube' | 'torrent';

export interface CompanionJobSource {
  /** Loopback companion origin, e.g. "http://127.0.0.1:4322". */
  baseUrl: string;
  /** Page-memory capability token from pairing (never persisted). */
  token: string;
  /** Opaque job id returned by the companion job-create endpoint. */
  jobId: string;
  /** Source kind: routes the cancel endpoint to the correct job API. */
  kind: CompanionJobKind;
}

export interface UseCompanionJobSessionResult {
  /** True while a companion job session is active. */
  active: boolean;
  /** Source kind (YouTube vs torrent) drives the session label and cancel route. */
  kind: CompanionJobKind | null;
  phase: CompanionBridgePhase;
  progress: CompanionBridgeProgress | null;
  reason: string | null;
  /** Begin the bridge session for an accepted YouTube job. */
  beginJobSession: (source: CompanionJobSource) => void;
  /** Cancel the job on the companion, then end the local session. */
  cancelActiveJob: () => Promise<void>;
  /** End the local session only (media switch, unmount safety). */
  endJobSession: () => void;
  /** Feed the actual video element (existing ref architecture). */
  attachMediaElement: (el: HTMLVideoElement | null) => void;
  /** Media URL surfaced only once the controller reports `complete` —
   *  never while buffering. */
  jobMediaUrl: string | null;
  setPlayIntent: (play: boolean) => void;
  requestSeek: (seconds: number) => void;
}

export function useCompanionJobSession(): UseCompanionJobSessionResult {
  const bridge = useCompanionBridge();
  const [active, setActive] = useState(false);
  const [kind, setKind] = useState<CompanionJobKind | null>(null);
  const activeRef = useRef(false);
  const sourceRef = useRef<CompanionJobSource | null>(null);
  const attachedRef = useRef(false);
  const intentCleanupRef = useRef<(() => void) | null>(null);

  // Complete gate: the media URL is derived at render time — it exists as
  // soon as the session is active (never while idle) and is cleared when
  // the session ends or the source fails/re-pairs (the element unmounts
  // with it). The player then renders the video element, and
  // attachMediaElement hands it to the controller. Keeping it through
  // `playing` matters: dropping it on the play transition would unmount
  // the element mid-playback (found by headed Chrome QA).
  //
  // Surfacing the URL immediately (not waiting for bridge "ready") lets
  // the native browser loading state be the only visual feedback while
  // the verified prefix grows — no custom banner needed. The bridge's
  // error-recovery path handles the initial503 from the companion.
  const jobMediaUrl = useMemo(() => {
    if (!active || !sourceRef.current) return null;
    const src = sourceRef.current;
    return `${src.baseUrl}/v1/media/fixture?token=${encodeURIComponent(src.token)}`;
  }, [active]);

  const clearIntentListeners = useCallback(() => {
    intentCleanupRef.current?.();
    intentCleanupRef.current = null;
  }, []);

  const beginJobSession = useCallback(
    (source: CompanionJobSource) => {
      if (activeRef.current) bridge.endSession();
      sourceRef.current = source;
      activeRef.current = true;
      attachedRef.current = false;
      clearIntentListeners();
      setActive(true);
      setKind(source.kind);
      // No media element exists yet at begin; it mounts as soon as the URL
      // surfaces and is attached via attachMediaElement — while buffering,
      // so the bridge's error listener catches the initial 503 and recovers
      // with an explicit src/load when the status turns playable.
      bridge.beginSession(
        { baseUrl: source.baseUrl, token: source.token },
        null,
      );
    },
    [bridge, clearIntentListeners],
  );

  const endJobSession = useCallback(() => {
    if (!activeRef.current) return;
    bridge.endSession();
    sourceRef.current = null;
    activeRef.current = false;
    attachedRef.current = false;
    clearIntentListeners();
    setActive(false);
  }, [bridge, clearIntentListeners]);

  const cancelActiveJob = useCallback(async () => {
    const src = sourceRef.current;
    if (src?.jobId) {
      try {
        // Best-effort companion-side cancel (frees the one-active session
        // and the job's private temp dir; never touches user files). The
        // cancel endpoint is routed by the source kind (YouTube vs torrent).
        const cancelPath =
          src.kind === 'torrent'
            ? `/v1/source/torrents/${encodeURIComponent(src.jobId)}/cancel`
            : `/v1/source/jobs/${encodeURIComponent(src.jobId)}/cancel`;
        await fetch(
          `${src.baseUrl}${cancelPath}?token=${encodeURIComponent(src.token)}`,
          { method: 'POST', cache: 'no-store' },
        );
      } catch {
        // Companion unreachable: the local session still ends below.
      }
    }
    endJobSession();
  }, [endJobSession]);

  const attachMediaElement = useCallback(
    (el: HTMLVideoElement | null) => {
      if (!el || !activeRef.current || attachedRef.current) return;
      // Attach while buffering as well as ready: the player's video element
      // mounts with the surfaced URL, and the companion answers 503 until
      // the verified prefix exists — the browser fires an error event that
      // must reach the bridge. bridge.attachMedia binds the (single) error
      // listener immediately; the bridge then re-checks status, keeps
      // polling alive, and does an explicit src/load recovery once the
      // status turns playable. Phases where the session is dead (idle /
      // error / disconnected / rePairRequired) stay blocked, and the element
      // may attach on a later transition.
      if (bridge.phase !== 'buffering' && bridge.phase !== 'ready') return;
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
    kind,
    phase: bridge.phase,
    progress: bridge.progress,
    reason: bridge.reason,
    beginJobSession,
    cancelActiveJob,
    endJobSession,
    attachMediaElement,
    jobMediaUrl,
    setPlayIntent,
    requestSeek,
  };
}
