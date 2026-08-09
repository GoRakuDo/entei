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

/** Retry interval for the YouTube title poll. */
const TITLE_POLL_INTERVAL_MS = 2_000;

/** Bounded retries before giving up on the YouTube title (yt-dlp writes
 *  title.txt very early — a title that has not appeared by then is not
 *  coming, and a persistent loop would add endless background fetches). */
const TITLE_POLL_MAX_ATTEMPTS = 5;

/** Bounded network-error retries for the title poll (transient companion
 *  unreachability should retry, but not forever). */
const TITLE_POLL_MAX_ERRORS = 5;

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
  /** Opaque job id of the active session (null when idle). */
  jobId: string | null;
  /** Selected format height from the companion (0 = unknown/not yet
   *  reported). Populated by the job poll for YouTube jobs; used for the
   *  quality toast wiring (notifyQuality). */
  jobQuality: number;
  /** Download mode of the active YouTube job ("speed"/"quality"); null
   *  while idle or for torrent jobs. Drives the quality-toast mode label. */
  jobMode: 'speed' | 'quality' | null;
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
  /** YouTube video title from the companion job (display name for the
   *  tracker / controls). Null until the companion reports it or for
   *  non-YouTube jobs (torrents use the selected file basename instead). */
  jobTitle: string | null;
  setPlayIntent: (play: boolean) => void;
  requestSeek: (seconds: number) => void;
}

export function useCompanionJobSession(): UseCompanionJobSessionResult {
  const bridge = useCompanionBridge();
  const [active, setActive] = useState(false);
  const [kind, setKind] = useState<CompanionJobKind | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobQuality, setJobQuality] = useState(0);
  const [jobMode, setJobMode] = useState<'speed' | 'quality' | null>(null);
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const [jobTitle, setJobTitle] = useState<string | null>(null);
  const activeRef = useRef(false);
  const sourceRef = useRef<CompanionJobSource | null>(null);
  const attachedRef = useRef(false);
  const intentCleanupRef = useRef<(() => void) | null>(null);
  const titlePollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleAttemptsRef = useRef(0);
  const titleErrorRef = useRef(0);

  // Poll the companion job-status endpoint for the YouTube video title.
  // Only YouTube jobs expose a title; torrents keep the selected file
  // basename (already in mediaName). Plain/page-memory value — never
  // persisted. The title typically appears as soon as yt-dlp starts, so the
  // poll is capped (a few 2s retries) to avoid a persistent background loop.
  const pollTitle = useCallback(() => {
    const src = sourceRef.current;
    if (!src || src.kind !== 'youtube' || !activeRef.current) return;
    void fetch(
      `${src.baseUrl}/v1/source/jobs/${encodeURIComponent(src.jobId)}?token=${encodeURIComponent(src.token)}`,
      { cache: 'no-store' },
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { title?: string; state?: string; quality?: number; mode?: string } | null) => {
        if (body?.title) {
          setJobTitle(body.title);
        }
        // The job poll also carries the selected format height + mode for
        // the quality toast (notifyQuality): yt-dlp writes height.txt as
        // soon as the format is chosen, so quality arrives early — expose
        // it without waiting for the download to finish.
        if (body && typeof body.quality === 'number' && body.quality > 0) {
          setJobQuality(body.quality);
        }
        if (body?.mode === 'speed' || body?.mode === 'quality') {
          setJobMode(body.mode);
        }
        // Job failed (error/cancelled): the title will never appear — stop
        // polling instead of burning the bounded retries. A job reported
        // error also means the quality that may already have arrived is
        // final; the session (and toast) surface that through phase.
        if (body?.state === 'error' || body?.state === 'cancelled') {
          return;
        }
        // Not ready yet; give it a bounded number of retries.
        if (
          activeRef.current &&
          titleAttemptsRef.current < TITLE_POLL_MAX_ATTEMPTS
        ) {
          titleAttemptsRef.current += 1;
          titlePollRef.current = setTimeout(pollTitle, TITLE_POLL_INTERVAL_MS);
        }
      })
      .catch(() => {
        // Companion unreachable mid-poll: retry while active, but do NOT
        // consume a "not ready" attempt — a transient network error is not
        // evidence the title is absent. Network failures get their own
        // bounded budget so a persistently unreachable companion cannot
        // keep the retry chain alive forever.
        if (
          activeRef.current &&
          titleErrorRef.current < TITLE_POLL_MAX_ERRORS
        ) {
          titleErrorRef.current += 1;
          titlePollRef.current = setTimeout(pollTitle, TITLE_POLL_INTERVAL_MS);
        }
      });
  }, []);

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
      setJobId(source.jobId);
      setJobQuality(0);
      setJobMode(source.kind === 'youtube' ? 'speed' : null);
      // Speed is the unified default; the job poll corrects to "quality"
      // when the job was created in quality mode.
      // Compute subtitle URL if a subtitle was selected.
      if (source.kind === 'torrent' && source.subtitleFileId) {
        setSubtitleUrl(
          `${source.baseUrl}/v1/source/torrents/${encodeURIComponent(source.jobId)}/subtitle?token=${encodeURIComponent(source.token)}`,
        );
      } else if (source.kind === 'youtube') {
        // YouTube jobs always attempt to serve Japanese subtitles
        // (manual preferred, auto fallback) when available.
        setSubtitleUrl(
          `${source.baseUrl}/v1/source/jobs/${encodeURIComponent(source.jobId)}/subtitle?token=${encodeURIComponent(source.token)}`,
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
      // Kick off title polling for YouTube jobs (display name for tracker).
      if (source.kind === 'youtube') {
        titleAttemptsRef.current = 0;
        titleErrorRef.current = 0;
        pollTitle();
      }
    },
    [bridge, clearIntentListeners, pollTitle],
  );

  const endJobSession = useCallback(() => {
    if (!activeRef.current) return;
    bridge.endSession();
    sourceRef.current = null;
    activeRef.current = false;
    attachedRef.current = false;
    clearIntentListeners();
    if (titlePollRef.current !== null) {
      clearTimeout(titlePollRef.current);
      titlePollRef.current = null;
    }
    titleAttemptsRef.current = 0;
    titleErrorRef.current = 0;
    setActive(false);
    setSubtitleUrl(null);
    setJobTitle(null);
    setJobId(null);
    setJobQuality(0);
    setJobMode(null);
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
    jobId,
    jobQuality,
    jobMode,
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
    jobTitle,
    setPlayIntent,
    requestSeek,
  };
}
