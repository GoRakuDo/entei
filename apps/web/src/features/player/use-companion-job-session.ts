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
 *   the media URL is NOT surfaced until the bridge reports `ready`
 *   (= companion status `playable` or `complete`, meaning `available > 0`).
 *   This avoids the browser fetching the media endpoint before any verified
 *   piece exists, which would block on the server's ServeContent Read and
 *   hit Chrome's ~30 s video timeout.
 * - complete gate: the controller reports `ready` → jobMediaUrl surfaces →
 *   the player renders the video element → attachMediaElement hands it to
 *   the controller (explicit src/load, pending seek, play intent).
 * - cancelActiveJob: POSTs the companion job-cancel endpoint (freeing the
 *   one-active session and its private temp dir) then ends the local
 *   session. Used by the banner's End button and by media switch.
 * - endJobSession: local-only end (media switch / unmount safety).
 * All job/session state is page memory only — never localStorage/
 * IndexedDB/sessionStorage/cookies/URL/logs. The capability token itself
 * is persisted by the pairing controller (opaque localStorage envelope;
 * see use-companion-pairing) — this hook never writes it.
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
  /** Capability token from pairing (persisted opaquely by the pairing
   *  controller; this session only ever holds it in memory). */
  token: string;
  /** Opaque job id returned by the companion job-create endpoint. */
  jobId: string;
  /** Source kind: routes the cancel endpoint to the correct job API. */
  kind: CompanionJobKind;
  /** Optional subtitle file id for torrent jobs (passed from MagnetInput). */
  subtitleFileId?: string;
}

export interface UseCompanionJobSessionResult {
  /** True while a companion job session is active. */
  active: boolean;
  /** Source kind (YouTube vs torrent) drives the session label and cancel route. */
  kind: CompanionJobKind | null;
  phase: CompanionBridgePhase;
  progress: CompanionBridgeProgress | null;
  reason: string | null;
  /** Stable error code from the source (e.g. "torrent_concurrency_limit").
   *  Only present when phase is 'error'. */
  errorCode: string | null;
  /** Begin the bridge session for an accepted YouTube job. */
  beginJobSession: (source: CompanionJobSource) => void;
  /** Cancel the job on the companion, then end the local session. */
  cancelActiveJob: () => Promise<void>;
  /** End the local session only (media switch, unmount safety). */
  endJobSession: () => void;
  /** Feed the actual video element (existing ref architecture). */
  attachMediaElement: (el: HTMLVideoElement | null) => void;
  /** Media URL surfaced only once the bridge reports `ready` (= companion
   *  status `playable` or `complete`, `available > 0`) — null during
   *  `buffering` / `idle` / `error` to prevent premature fetches. */
  jobMediaUrl: string | null;
  /** Subtitle URL for the selected subtitle file. Only available for
   *  torrent jobs that selected a subtitle. Null when no subtitle was
   *  selected or the session is not active. */
  subtitleUrl: string | null;
  setPlayIntent: (play: boolean) => void;
  requestSeek: (seconds: number) => void;
}

export function useCompanionJobSession(): UseCompanionJobSessionResult {
  const bridge = useCompanionBridge();
  const [active, setActive] = useState(false);
  const [kind, setKind] = useState<CompanionJobKind | null>(null);
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const activeRef = useRef(false);
  const sourceRef = useRef<CompanionJobSource | null>(null);
  const attachedRef = useRef(false);
  const intentCleanupRef = useRef<(() => void) | null>(null);

  // ED-2H core design: jobMediaUrl is gated on bridge.phase === 'ready'
  // || 'playing' to prevent the video element from fetching while
  // available=0 (ServeContent Read would block → Chrome ~30s timeout
  // → error code 4). Do NOT remove this gate without replacing it with
  // an equivalent available>0 check. See docs/EIZOU_DENDENSHI.md
  // "ED-2H: 即ストリーミング設計".
  //
  // Complete gate: the media URL is surfaced only when the bridge phase is
  // `ready` or `playing` (= companion reported `playable` or `complete`,
  // meaning `available > 0` and verified pieces exist). Surfacing it
  // earlier (during `buffering` with `available = 0`) would cause the
  // browser to fetch `/v1/media/fixture` before any verified piece exists;
  // the server's ServeContent sends a 206 header but `Read` blocks until
  // pieces arrive, hitting Chrome's ~30 s internal video timeout and
  // failing to start playback. Keeping it through `playing` matters:
  // dropping it on the play transition would unmount the element mid-
  // playback (found by headed Chrome QA). The element unmounts when the
  // session ends, the source fails, or re-pairing is required.
  const jobMediaUrl = useMemo(() => {
    if (!active || !sourceRef.current) return null;
    // Gate on bridge phase: only surface the media URL when the companion
    // confirms playable (available > 0) or complete. This prevents the
    // browser from issuing a fetch that would block on 0 available pieces.
    if (bridge.phase !== 'ready' && bridge.phase !== 'playing') return null;
    const src = sourceRef.current;
    return `${src.baseUrl}/v1/media/fixture?token=${encodeURIComponent(src.token)}`;
  }, [active, bridge.phase]);

  const clearIntentListeners = useCallback(() => {
    intentCleanupRef.current?.();
    intentCleanupRef.current = null;
  }, []);

  // Derive errorCode from bridge reason when phase is 'error'.
  // Error codes are snake_case identifiers (e.g. "torrent_concurrency_limit");
  // human-readable reasons contain spaces.
  const derivedErrorCode =
    bridge.phase === 'error' && bridge.reason && !bridge.reason.includes(' ')
      ? bridge.reason
      : null;

  const beginJobSession = useCallback(
    (source: CompanionJobSource) => {
      if (activeRef.current) bridge.endSession();
      sourceRef.current = source;
      activeRef.current = true;
      attachedRef.current = false;
      clearIntentListeners();
      setActive(true);
      setKind(source.kind);
      // Compute subtitle URL if a subtitle was selected.
      if (source.kind === 'torrent' && source.subtitleFileId) {
        setSubtitleUrl(
          `${source.baseUrl}/v1/source/torrents/${encodeURIComponent(source.jobId)}/subtitle?token=${encodeURIComponent(source.token)}`,
        );
      } else {
        setSubtitleUrl(null);
      }
      // No media element exists yet at begin; jobMediaUrl stays null until
      // the bridge phase reaches `ready` (companion status playable/complete).
      // Once the URL surfaces, the video element mounts and is attached via
      // attachMediaElement — the bridge's startReadyTransition handles the
      // explicit src/load, pending seek, and play intent.
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
    setSubtitleUrl(null);
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
      // The player's video element mounts only after jobMediaUrl surfaces
      // (bridge phase `ready`/`playing`), so this callback is typically
      // called when the phase is already `ready`. The `buffering` guard
      // is retained for safety (e.g. a rapid phase transition). Note:
      // Under the current design (ED-2H) the element mounts only during
      // `ready`/`playing` — the `buffering` branch is unreachable in
      // practice but kept as a defensive guard. Phases where the session
      // is dead (idle / error / disconnected / rePairRequired) stay
      // blocked, and the element may attach on a later transition.
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
    errorCode: derivedErrorCode,
    beginJobSession,
    cancelActiveJob,
    endJobSession,
    attachMediaElement,
    jobMediaUrl,
    subtitleUrl,
    setPlayIntent,
    requestSeek,
  };
}
