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
 *
 * Desktop (Tauri) direct torrent sessions:
 * - `beginDirectTorrentSession` mounts the loopback relay URLs the in-process
 *   torrent plugin produced (`tauri-plugin-torrent` → 127.0.0.1 Range server)
 *   and skips the companion bridge entirely: no token, no `/v1/*` polling,
 *   phase is reported as `ready` from the start because the plugin only hands
 *   out a URL once the file's first byte is on disk.
 * - `cancelActiveJob` then cancels the in-process torrent instead of POSTing
 *   the companion cancel endpoint.
 *
 * All job/session state is page memory only — never localStorage/
 * IndexedDB/sessionStorage/cookies/URL/logs. The capability token itself
 * is persisted by the pairing controller (opaque localStorage envelope;
 * see use-companion-pairing) — this hook never writes it.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CompanionBridgePhase,
  CompanionBridgeProgress,
} from '@/features/player/companion-bridge';
import { useCompanionBridge } from '@/features/player/use-companion-bridge';
import { cancelTorrentDirect } from '@/features/player/tauri-bridge';

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

/** Media-error resets allowed for a desktop direct torrent session. A browser
 *  media element never retries a failed fetch on its own (Chrome stops with
 *  error code 4), so the relay's transient `503`/aborted range request is
 *  recovered by an explicit `src` + `load()` reset — bounded, because a truly
 *  dead relay must surface as an error instead of an endless reload loop. */
const DIRECT_MEDIA_RESET_LIMIT = 3;

/** Backoff before a direct-torrent media reset. The plugin only hands out the
 *  relay URL once the file is streamable, so a reset mostly races a very short
 *  window; a small delay keeps it from hammering the relay. */
const DIRECT_MEDIA_RESET_DELAY_MS = 600;

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

/**
 * Desktop (Tauri) direct torrent session: the loopback relay URLs the
 * in-process torrent plugin produced. No companion, no capability token.
 */
export interface DirectTorrentSession {
  /** Plugin torrent id (used only to cancel the in-process session). */
  torrentId: string;
  /** `http://127.0.0.1:<port>/stream/<session>` for the selected video. */
  videoUrl: string;
  /** Relay URL for the selected subtitle file, when one was chosen. */
  subtitleUrl?: string | null;
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
  /** Companion API token of the active session (null when idle). */
  token: string | null;
  /** Torrent subtitle file id selected at session start (null when idle). */
  subtitleFileId: string | null;
  /** Begin the bridge session for an accepted YouTube job. */
  beginJobSession: (source: CompanionJobSource) => void;
  /**
   * Begin a desktop (Tauri) direct torrent session from the in-process
   * plugin's loopback relay URLs — no companion, no capability token.
   */
  beginDirectTorrentSession: (source: DirectTorrentSession) => void;
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
  /** Session API token / selected torrent subtitle file id (for sync). */
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [subtitleFileId, setSubtitleFileId] = useState<string | null>(null);
  const [jobQuality, setJobQuality] = useState(0);
  const [jobMode, setJobMode] = useState<'speed' | 'quality' | null>(null);
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const [jobTitle, setJobTitle] = useState<string | null>(null);
  // Desktop direct torrent session (no companion bridge involved).
  const directRef = useRef<DirectTorrentSession | null>(null);
  const [directActive, setDirectActive] = useState(false);
  const [directMediaUrl, setDirectMediaUrl] = useState<string | null>(null);
  const activeRef = useRef(false);
  const sourceRef = useRef<CompanionJobSource | null>(null);
  const attachedRef = useRef(false);
  const intentCleanupRef = useRef<(() => void) | null>(null);
  /** Media-error resets already spent by the current direct torrent session. */
  const directResetsRef = useRef(0);
  /** Last position reported by the direct session's media element. It is the
   *  only trustworthy resume point: by the time our reset runs, the player's
   *  own error handling has already stripped `src` and called `load()`, which
   *  rewinds `el.currentTime` to 0. */
  const lastPositionRef = useRef(0);
  /** Playback intent captured before the reset: `load()` pauses the element,
   *  so the "was playing" answer has to be taken while it is still playing. */
  const wasPlayingRef = useRef(false);
  /** Pending direct-torrent media reset (one at a time). */
  const directResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      .then(
        (
          body: {
            title?: string;
            state?: string;
            quality?: number;
            mode?: string;
          } | null,
        ) => {
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
            titlePollRef.current = setTimeout(
              pollTitle,
              TITLE_POLL_INTERVAL_MS,
            );
          }
        },
      )
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
    if (!active) return null;
    // Desktop direct torrent: the plugin already waited for the file's first
    // byte before handing out the relay URL, so there is nothing to gate.
    if (directActive) return directMediaUrl;
    if (!sourceRef.current) return null;
    // Gate on bridge phase: only surface the media URL when the companion
    // confirms playable (available > 0) or complete. This prevents the
    // browser from issuing a fetch that would block on 0 available pieces.
    if (bridge.phase !== 'ready' && bridge.phase !== 'playing') return null;
    const src = sourceRef.current;
    return `${src.baseUrl}/v1/media/fixture?token=${encodeURIComponent(src.token)}`;
  }, [active, bridge.phase, directActive, directMediaUrl]);

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
      directRef.current = null;
      setDirectActive(false);
      setDirectMediaUrl(null);
      sourceRef.current = source;
      activeRef.current = true;
      attachedRef.current = false;
      clearIntentListeners();
      setActive(true);
      setKind(source.kind);
      setJobId(source.jobId);
      setSessionToken(source.token ?? null);
      setSubtitleFileId(source.subtitleFileId ?? null);
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

  // Desktop (Tauri) direct torrent session: mount the loopback relay URLs the
  // in-process plugin produced. No companion bridge is started (no token, no
  // `/v1/*` polling), so the media URL is available immediately and the phase
  // reports `ready` — the plugin only returns a URL once the file's first byte
  // is on disk.
  const beginDirectTorrentSession = useCallback(
    (source: DirectTorrentSession) => {
      // End any previous session's bridge polling without cancelling the
      // torrent we are about to start (the caller already owns the switch).
      if (activeRef.current) bridge.endSession();
      if (titlePollRef.current !== null) {
        clearTimeout(titlePollRef.current);
        titlePollRef.current = null;
      }
      titleAttemptsRef.current = 0;
      titleErrorRef.current = 0;
      clearIntentListeners();
      sourceRef.current = null;
      directRef.current = {
        torrentId: source.torrentId,
        videoUrl: source.videoUrl,
        subtitleUrl: source.subtitleUrl ?? null,
      };
      activeRef.current = true;
      attachedRef.current = false;
      setActive(true);
      setKind('torrent');
      setJobId(source.torrentId);
      setSessionToken(null);
      setSubtitleFileId(null);
      setJobQuality(0);
      setJobMode(null);
      setJobTitle(null);
      setDirectActive(true);
      setDirectMediaUrl(source.videoUrl);
      setSubtitleUrl(source.subtitleUrl ?? null);
      directResetsRef.current = 0;
      lastPositionRef.current = 0;
      wasPlayingRef.current = false;
    },
    [bridge, clearIntentListeners],
  );

  const endJobSession = useCallback(() => {
    if (!activeRef.current) return;
    bridge.endSession();
    sourceRef.current = null;
    directRef.current = null;
    setDirectActive(false);
    setDirectMediaUrl(null);
    directResetsRef.current = 0;
    lastPositionRef.current = 0;
    wasPlayingRef.current = false;
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
    setKind(null);
    setSubtitleUrl(null);
    setJobTitle(null);
    setJobId(null);
    setSessionToken(null);
    setSubtitleFileId(null);
    setJobQuality(0);
    setJobMode(null);
  }, [bridge, clearIntentListeners]);

  const cancelActiveJob = useCallback(async () => {
    // Capture the outgoing session, then end it locally FIRST and only then
    // talk to the plugin / companion. Callers start the replacement session
    // immediately after calling this (magnet switch), so ending the local
    // state after the await would clobber the new session.
    const direct = directRef.current;
    const src = sourceRef.current;
    endJobSession();

    if (direct) {
      try {
        // Desktop direct mode: cancel the in-process torrent (best effort —
        // the session may already be gone). The plugin deletes its streaming
        // cache, so no partial episode is left on disk.
        await cancelTorrentDirect(direct.torrentId);
      } catch {
        // Plugin unreachable: the local session is already ended.
      }
      return;
    }
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
        // Companion unreachable: the local session is already ended.
      }
    }
  }, [endJobSession]);

  const attachMediaElement = useCallback(
    (el: HTMLVideoElement | null) => {
      if (!el || !activeRef.current || attachedRef.current) return;
      // Desktop direct mode: the relay URL is a plain HTTP media source, so
      // the element needs no bridge wiring — but it does need its own error
      // recovery. A browser media element never retries a failed fetch
      // (Chrome stops with error code 4 and stays dead), so one transient
      // relay answer — the `503` window while the torrent was still opening
      // its storage, or an aborted range request — would kill playback for
      // good. Recover with the measured explicit `src` + `load()` reset,
      // bounded so a genuinely dead relay still surfaces as an error.
      if (directRef.current) {
        attachedRef.current = true;
        /** Resume point + play intent armed by the last media error. */
        let resumeAt = 0;
        let resumePlay = false;

        // The element's own position is not usable across a reset: `error`
        // recovery strips `src` and calls `load()`, which rewinds
        // `currentTime` to 0. Track the position as it plays instead.
        const onTimeUpdate = () => {
          const at = el.currentTime;
          if (Number.isFinite(at) && at > 0) lastPositionRef.current = at;
        };
        const onPlaying = () => {
          wasPlayingRef.current = true;
        };
        const onPause = () => {
          // A fatal media error also pauses the element; keep the intent so the
          // reset can resume it. Only a user/API pause clears it.
          if (el.error) return;
          wasPlayingRef.current = false;
        };
        // Restore once the reset load has a seekable timeline. `loadedmetadata`
        // and `canplay` are both listened to because either can arrive first
        // across WebView2 / Chrome; the first one clears the pending state, so
        // the seek and the resume happen exactly once.
        const onResumePoint = () => {
          if (resumeAt <= 0 && !resumePlay) return;
          const at = resumeAt;
          const shouldPlay = resumePlay;
          resumeAt = 0;
          resumePlay = false;
          if (at > 0) {
            try {
              el.currentTime = at;
            } catch {
              // Seek refused (not seekable yet): playback starts from the head.
            }
          }
          if (!shouldPlay) return;
          try {
            const started = el.play();
            if (started && typeof started.catch === 'function') {
              started.catch(() => {
                // Autoplay policy refused the resume; the user can press play.
              });
            }
          } catch {
            // No media pipeline (test/unsupported env): nothing to resume.
          }
        };
        const onLoaded = () => {
          // A successful load earns the reset budget back, so a later hiccup
          // in the same session is still recoverable.
          directResetsRef.current = 0;
        };
        const onError = () => {
          const direct = directRef.current;
          if (!direct || !activeRef.current) return;
          if (directResetsRef.current >= DIRECT_MEDIA_RESET_LIMIT) return;
          // One pending reset at a time: a media element fires `error` once
          // per failed load, but the guard keeps a burst from stacking timers.
          if (directResetTimerRef.current !== null) return;
          directResetsRef.current += 1;
          resumeAt = lastPositionRef.current;
          resumePlay = wasPlayingRef.current;
          directResetTimerRef.current = setTimeout(() => {
            directResetTimerRef.current = null;
            // The session may have ended or been replaced while waiting.
            if (!activeRef.current || directRef.current !== direct) return;
            // The relay URL stays valid across a reset (same session id), so
            // the element is simply pointed at it again. `load()` runs the
            // media load algorithm even for the same URL, which is what makes
            // the browser fetch again.
            el.src = direct.videoUrl;
            el.load();
          }, DIRECT_MEDIA_RESET_DELAY_MS);
        };
        el.addEventListener('timeupdate', onTimeUpdate);
        el.addEventListener('playing', onPlaying);
        el.addEventListener('pause', onPause);
        el.addEventListener('loadedmetadata', onResumePoint);
        el.addEventListener('canplay', onResumePoint);
        el.addEventListener('loadeddata', onLoaded);
        el.addEventListener('error', onError);
        intentCleanupRef.current = () => {
          el.removeEventListener('timeupdate', onTimeUpdate);
          el.removeEventListener('playing', onPlaying);
          el.removeEventListener('pause', onPause);
          el.removeEventListener('loadedmetadata', onResumePoint);
          el.removeEventListener('canplay', onResumePoint);
          el.removeEventListener('loadeddata', onLoaded);
          el.removeEventListener('error', onError);
          if (directResetTimerRef.current !== null) {
            clearTimeout(directResetTimerRef.current);
            directResetTimerRef.current = null;
          }
        };
        return;
      }
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

  // Unmount safety: a desktop direct torrent session owns an in-process
  // torrent inside the Rust plugin. Leaving the player without cancelling it
  // would keep the download running (and the relay slot occupied) with no UI
  // left to stop it. Refs are read inside the cleanup so the effect can stay
  // dependency-free. The plugin deletes its streaming cache on cancel, so no
  // partial episode is left on disk.
  useEffect(() => {
    return () => {
      const direct = directRef.current;
      directRef.current = null;
      if (direct) {
        void cancelTorrentDirect(direct.torrentId).catch(() => {
          // Plugin already gone / app closing: nothing left to clean up.
        });
      }
      // Release the media-element listeners and any pending reset timer: an
      // unmount leaves no element to fire them on, and the timer would touch
      // a detached element after the session is gone.
      clearIntentListeners();
      if (titlePollRef.current !== null) {
        clearTimeout(titlePollRef.current);
        titlePollRef.current = null;
      }
    };
  }, [clearIntentListeners]);

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
    token: sessionToken,
    subtitleFileId,
    jobQuality,
    jobMode,
    phase: directActive ? 'ready' : bridge.phase,
    progress: bridge.progress,
    reason: bridge.reason,
    errorCode: derivedErrorCode,
    beginJobSession,
    beginDirectTorrentSession,
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
