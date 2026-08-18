/**
 * PlayerApp — Main React component for the Entei Player.
 * ---------------------------------------------------------------------------
 * P1.1: Custom control layer replaces native browser controls.
 *
 * Fixes applied:
 * - #1: Latest URL tracked in ref, revoked exactly once on unmount.
 * - #2: Shared HTMLMediaElement ref for both video/audio; active cue clears
 *       when media time is outside every cue.
 * - #3: Volume applied after media element mount for both video and audio.
 * - #4: All raw SVG replaced with lucide-react icons.
 * - #5: SubtitlePanel handles prefers-reduced-motion + aria-current.
 * - #6: KeyboardShortcutsHelp uses Radix Dialog.
 * - #8: Listens for entei:locale-change CustomEvent, uses typed dictionary.
 * - #9: Persists volume/playbackRate via player preferences module.
 * - #10: isLoading starts false, becomes true when selecting supported media.
 * - P1.1: Custom PlayerControls for both video and audio.
 * --------------------------------------------------------------------------- */
'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  type SubtitleCue,
  parseSubtitle,
  findActiveCue,
} from '@/features/player/subtitle-reader';
import {
  detectSourceKind,
  planSync,
} from '@/features/player/subtitle-sync-planner';
import {
  syncSubtitleToAudio,
  syncSubtitleToReference,
} from '@/features/player/subtitle-sync';
import { decodeToMono16k } from '@/features/player/audio-decoder';
import { fetchMagnetSubtitle } from '@/features/player/companion-media';
import { loadMkvGo } from '@/features/player/mkvgo';
import { SubtitleSyncDialog } from '@/components/player/SubtitleSyncDialog';
import {
  createMediaUrl,
  revokeUrl,
  MEDIA_ACCEPT,
  SUBTITLE_ACCEPT,
  classifyMediaFile,
  classifyMediaError,
  isVideoFile,
  isAudioFile,
  isSubtitleFile,
  getFileExtension,
} from '@/features/player/media-url';
import {
  readPlayerPreferences,
  writePlayerPreferences,
} from '@/features/player/preferences';
import {
  readPanelLayout,
  writePanelLayout,
  DEFAULT_LAYOUT,
} from '@/features/player/panel-layout';
import {
  surfaceClickEffect,
  nextCaptionDisplayMode,
  BLUR_RESTORE_TIMEOUT_MS,
  type CaptionDisplayMode,
  type PlayMode,
  shouldCondensedSeek,
  shouldFastForward,
  FAST_FORWARD_RATE,
} from '@/features/player/control-helpers';
import {
  type LocaleChangeDetail,
  LOCALE_CHANGE_EVENT,
} from '@i18n/locale-events';
import type { Dictionary } from '@i18n/types';
import { getDictionary } from '@i18n/index';
import { MediaPicker } from '@/components/player/MediaPicker';
import { Button } from '@/components/player/ui/button';
import { VideoPlayer } from '@/components/player/VideoPlayer';
import { RightPanel } from '@/components/player/RightPanel';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/player/ui/resizable';
import { recordMiningHistory } from '@/features/player/mining-history';
import {
  useTrackerRuntime,
  recordTrackerMiningArchive,
  flushTrackerData,
} from '@/features/player/tracker';
import { SubtitleOverlay } from '@/components/player/SubtitleOverlay';
import {
  PlayerControls,
  type PlayerControlsHandle,
} from '@/components/player/PlayerControls';
import { useKeyboardShortcuts } from '@/features/player/use-keyboard-shortcuts';
import { captureVideoFrame } from '@/features/player/screenshot-capture';
import { recordVideoClip } from '@/features/player/video-clip';
import { ScreenshotPreviewDialog } from '@/components/player/ScreenshotPreviewDialog';
import {
  recordAudioClip,
  cancelActiveRecording,
  checkAudioClipCapabilities,
} from '@/features/player/audio-clip';
import { AudioClipPreviewDialog } from '@/components/player/AudioClipPreviewDialog';
import { MagnetInput } from '@/components/player/MagnetInput';
import { useCompanionJobSession } from '@/features/player/use-companion-job-session';
import type { CompanionBridgePhase } from '@/features/player/companion-bridge';
import { clampCompanionSeek } from '@/features/player/seek-limiter';
import {
  notifyQuality,
  notifyCompanionError,
  notifySubtitleSyncError,
  notifySubtitleSyncSuccess,
  notifyLazySyncInfo,
} from '@/features/player/eizouden-toast.tsx';
import {
  LAZY_SYNC_POLL_INTERVAL_MS,
  LAZY_SYNC_MAX_WAIT_POLLS,
  LAZY_SYNC_MIN_REF_CUES,
  LAZY_SYNC_MIN_OFFSET_MS,
  LAZY_SYNC_STABLE_THRESHOLD_MS,
  estimateMedianOffset,
  shiftCuesByOffset,
} from '@/features/player/lazy-sync';

import { EizouDendenshiSetup } from '@/components/player/EizouDendenshiSetup';
import { useCompanionPairing } from '@/features/player/use-companion-pairing';
import { YouTubeMark } from '@/components/player/YouTubeMark';
import { YouTubeInput } from '@/components/player/YouTubeInput';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import { Music, AlertTriangle, Magnet } from 'lucide-react';
import { formatTime } from '@/features/player/control-helpers';
import { MiningPreviewDialog } from '@/components/player/MiningPreviewDialog';
import {
  readAnkiMinerPreferences,
  writeAnkiMinerPreferences,
  parseAnkiTags,
  type AnkiFieldMapping,
} from '@/features/player/anki-miner-preferences';
import {
  wrapDenChouField,
  isDenChouActiveTarget,
} from '@/features/player/denchou-scene';
import { selectCueTextInRange } from '@/features/player/subtitle-interval';
import {
  AnkiExportClient,
  blobToBase64,
  generateMediaFilename,
  updateNoteFieldsAndAddTags,
  addTagsOnlyIfAny,
} from '@/features/player/anki-export-client';
import {
  AnkiConnectClient,
  runAnkiConnectionFlow,
} from '@/features/player/anki-connect';
import {
  listenForAnkiSessionCredentials,
  listenForSubtitleSettingsChange,
  type SubtitleSettings,
} from '@/features/player/settings-bridge';

function getInitialLocale(): 'id' | 'ja' | 'en' {
  const lang = document.documentElement.lang;
  if (lang === 'ja' || lang === 'en') return lang;
  return 'id';
}

function getDictionaryFor(locale: 'id' | 'ja' | 'en'): Dictionary {
  return getDictionary(locale);
}

/** AM-4: Seek a video element to a target time and wait for the seek to
 *  complete. Aborts on signal or 5-second timeout. Never leaves the video
 *  playing — always pauses after seek. */
const SEEK_TIMEOUT_MS = 5000;

/** Companion YouTube subtitle fetch retry (ED-2G): while the job is still
 *  downloading in speed mode, the media is playable before the subtitle
 *  file exists — the first fetch then 404s with "subtitle not available".
 *  Retry every 5 seconds until the content appears, the component
 *  unmounts, or the bounded 3-minute window passes. Failures are silent
 *  (the panel simply fills in once the file exists). Exported for the
 *  subtitle-fetch retry tests (companion-subtitle-retry.test.tsx). */
export const SUBTITLE_RETRY_INTERVAL_MS = 5000;

/** Upper bound for the subtitle retry window (3 minutes). Exported for
 *  the subtitle-fetch retry tests. */
export const SUBTITLE_RETRY_WINDOW_MS = 3 * 60 * 1000;

/** Companion start-buffering safety timeout: if the overlay has shown but
 *  canplay never fires (e.g. a stalled .part), hide it after 15 s so the
 *  player does not sit on the overlay forever. Longer than the 5 s seek
 *  buffer bound because the initial load can legitimately take longer
 *  (the piece may still be downloading). Playback is unaffected — a
 *  later canplay just proceeds normally. */
const START_BUFFERING_SAFETY_MS = 15000;

/** Maximum length of a displayed media name (defense in depth). */
const MAX_MEDIA_NAME_LENGTH = 255;

/** sanitizeDisplayName — safe display text for the top-left controls and
 *  history. The companion already serves sanitized basenames (no paths),
 *  but the browser never trusts that alone: control characters are
 *  stripped, whitespace trimmed, and the length is capped so a hostile
 *  basename cannot break layout, logs, or Anki export fields. */
function sanitizeDisplayName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, MAX_MEDIA_NAME_LENGTH);
}

function seekVideoSafely(
  video: HTMLVideoElement,
  targetTime: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new DOMException('Seek timeout', 'TimeoutError'));
    }, SEEK_TIMEOUT_MS);

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const onSeeked = () => {
      cleanup();
      video.pause();
      resolve();
    };

    function cleanup() {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      video.removeEventListener('seeked', onSeeked);
    }

    signal.addEventListener('abort', onAbort);
    video.addEventListener('seeked', onSeeked);
    video.currentTime = targetTime;
  });
}

export default function PlayerApp() {
  // --- Locale ---
  const [locale, setLocale] = useState<'id' | 'ja' | 'en'>(getInitialLocale);
  const dictRef = useRef<Dictionary>(getDictionaryFor(locale));
  dictRef.current = getDictionaryFor(locale);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<LocaleChangeDetail>).detail;
      if (detail?.locale) {
        setLocale(detail.locale);
        dictRef.current = detail.dictionary;
      }
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  // --- Preferences ---
  const prefsRef = useRef(readPlayerPreferences());

  // --- Media state ---
  const activeUrlRef = useRef<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'video' | 'audio' | null>(null);
  const [mediaName, setMediaName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Stage 2a: Track local file for tracker fingerprint computation
  const mediaFileRef = useRef<File | null>(null);
  // Stage 2a: Track subtitle text content for tracker digest computation
  const subtitleTextRef = useRef<string | null>(null);
  const [isSyncingSubtitle, setIsSyncingSubtitle] = useState(false);
  const [isSubtitleSyncDialogOpen, setIsSubtitleSyncDialogOpen] =
    useState(false);
  // --- LazySync (Magnet-only, docs SUBTITLE_SYNC.md §10) ---
  // Session-memory toggle state: ON runs the DL-prefix cue polling that
  // estimates and applies a constant offset to the loaded subtitle.
  const [isLazySyncOn, setIsLazySyncOn] = useState(false);
  /** Mutable LazySync loop state (no re-renders between polls). */
  const lazySyncStateRef = useRef<{
    /** Original user-loaded cues — the base every offset is applied to. */
    baseCues: SubtitleCue[];
    /** Whether at least one offset has been applied (typewriter off). */
    appliedOnce: boolean;
    /** Last applied offset (ms) — stability is measured against this. */
    lastOffsetMs: number | null;
    /** Consecutive polls in a waiting state (too few ref cues / an estimate
     *  refused by the concentration check). Bounded by
     *  LAZY_SYNC_MAX_WAIT_POLLS. */
    waitPollCount: number;
  } | null>(null);

  // --- Subtitle state ---
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [subtitleErrors, setSubtitleErrors] = useState<
    { line: number; message: string }[]
  >([]);
  const [activeCueId, setActiveCueId] = useState<number | null>(null);

  // --- Playback state ---
  const [isPlaying, setIsPlaying] = useState(false);
  const prevIsPlayingRef = useRef(false);
  const [playbackRate, setPlaybackRate] = useState(
    prefsRef.current.playbackRate,
  );
  const [volume, setVolume] = useState(prefsRef.current.volume);

  // --- Seek buffering overlay ---
  // After a seek, if the video element's readyState drops below
  // HAVE_FUTURE_DATA (2), show a spinner overlay. The overlay clears
  // when readyState recovers (data arrives) or the element errors.
  // This is separate from the companion loading overlay (which shows
  // while waiting for the job media URL to surface).
  const [isSeekBuffering, setIsSeekBuffering] = useState(false);
  const seekBufferingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const seekBufferingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // --- Companion start buffering overlay ---
  // The companion job media URL is surfaced (video element mounted) but
  // playback cannot start yet: the element sits at readyState < 3 or a
  // `waiting` event fires while the growing .part yields no playable
  // data. After 1 s of that state the larger "Preparing video…" overlay
  // shows (same 1 s debounce pattern as isSeekBuffering, so fast starts
  // never flash); canplay/playing clears it.
  const [isStartBuffering, setIsStartBuffering] = useState(false);
  const startBufferingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Safety bound for the start-buffering overlay (START_BUFFERING_SAFETY_MS);
  // cleared by canplay / error / unmount.
  const startBufferingSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // P2.1: Play mode — default normal, not persisted
  const [playMode, setPlayMode] = useState<PlayMode>('normal');
  // P2.1: Manual rate selected by user (separate from fast-forward effective rate)
  const manualPlaybackRateRef = useRef(prefsRef.current.playbackRate);
  // P2.1: Condensed seek in-flight guard
  const isCondensedSeekingRef = useRef(false);
  const condensedSeekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // --- P1.1: subtitle panel visibility ---
  const [isSubtitlePanelVisible, setIsSubtitlePanelVisible] = useState(true);

  // --- Resizable panel responsive breakpoint ---
  const [isDesktop, setIsDesktop] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isLandscapeImmersive, setIsLandscapeImmersive] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  // --- Panel layout persistence (desktop only) ---
  const [panelLayout, setPanelLayout] = useState(DEFAULT_LAYOUT);
  const [panelLayoutKey, setPanelLayoutKey] = useState(0);

  useEffect(() => {
    const desktopMql = window.matchMedia('(min-width: 768px)');
    const landscapeImmersiveMql = window.matchMedia(
      '(orientation: landscape) and (max-height: 500px)',
    );
    const mobileWidthMql = window.matchMedia('(max-width: 767px)');
    const coarsePointerMql = window.matchMedia('(pointer: coarse)');
    const setMobileViewport = () =>
      setIsMobileViewport(
        mobileWidthMql.matches ||
          (landscapeImmersiveMql.matches && coarsePointerMql.matches),
      );
    setIsDesktop(desktopMql.matches);
    setIsLandscapeImmersive(landscapeImmersiveMql.matches);
    setMobileViewport();
    const desktopHandler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    const landscapeHandler = (e: MediaQueryListEvent) =>
      setIsLandscapeImmersive(e.matches);
    const mobileHandler = () => setMobileViewport();
    desktopMql.addEventListener('change', desktopHandler);
    landscapeImmersiveMql.addEventListener('change', landscapeHandler);
    landscapeImmersiveMql.addEventListener('change', mobileHandler);
    mobileWidthMql.addEventListener('change', mobileHandler);
    coarsePointerMql.addEventListener('change', mobileHandler);
    return () => {
      desktopMql.removeEventListener('change', desktopHandler);
      landscapeImmersiveMql.removeEventListener('change', landscapeHandler);
      landscapeImmersiveMql.removeEventListener('change', mobileHandler);
      mobileWidthMql.removeEventListener('change', mobileHandler);
      coarsePointerMql.removeEventListener('change', mobileHandler);
    };
  }, []);

  // Restore saved panel layout on mount
  useEffect(() => {
    setPanelLayout(readPanelLayout());
  }, []);

  // --- P1.3a.2: caption display mode + overlay reveal state ---
  const [captionDisplayMode, setCaptionDisplayMode] =
    useState<CaptionDisplayMode>(prefsRef.current.captionDisplayMode);
  const [isOverlayRevealed, setIsOverlayRevealed] = useState(false);
  const blurRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // --- P2.1: Subtitle appearance settings (persisted in prefs) ---
  const [subtitleSettings, setSubtitleSettings] = useState<SubtitleSettings>({
    fontSize: prefsRef.current.subtitleFontSize,
    textColor: prefsRef.current.subtitleTextColor,
    backgroundColor: prefsRef.current.subtitleBackgroundColor,
    backgroundPadding: prefsRef.current.subtitleBackgroundPadding,
    verticalPosition: prefsRef.current.subtitleVerticalPosition,
  });

  // --- AM-2: Screenshot state ---
  const [screenshotPreviewUrl, setScreenshotPreviewUrl] = useState<
    string | null
  >(null);
  const [isScreenshotDialogOpen, setIsScreenshotDialogOpen] = useState(false);
  const [hasScreenshotError, setHasScreenshotError] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  // AM-2: synchronous guard against double-clicks (React state is async)
  const isCapturingRef = useRef(false);
  const screenshotUrlRef = useRef<string | null>(null);
  // AM-2: mounted ref for unmount safety under React Strict Mode
  const mountedRef = useRef(true);
  // AM-2: monotonic epoch to invalidate stale capture results
  const captureEpochRef = useRef(0);

  // --- AM-3: Audio clip state ---
  const [audioClipUrl, setAudioClipUrl] = useState<string | null>(null);
  const [isAudioClipDialogOpen, setIsAudioClipDialogOpen] = useState(false);
  const [hasAudioClipError, setHasAudioClipError] = useState(false);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  // AM-3: expected cue duration for preview fallback when audio.duration is NaN/Infinity
  const [audioClipExpectedDuration, setAudioClipExpectedDuration] = useState(0);
  // AM-3: synchronous guard against double-clicks
  const isRecordingAudioRef = useRef(false);
  const audioClipUrlRef = useRef<string | null>(null);
  const audioClipEpochRef = useRef(0);
  // AM-3: capability check (stable per browser session)
  const [audioClipCaps] = useState(() => checkAudioClipCapabilities());

  // --- AM-4: Mining Preview state ---
  const [isMiningPreviewOpen, setIsMiningPreviewOpen] = useState(false);
  // AM-4: Mapped draft fields (controlled by Anki field mapping)
  const [miningDraftFields, setMiningDraftFields] = useState<
    { key: string; physicalName: string; value: string }[]
  >([]);
  const [miningHasScreenshotError, setMiningHasScreenshotError] =
    useState(false);
  const [miningHasAudioError, setMiningHasAudioError] = useState(false);
  const [miningScreenshotUrl, setMiningScreenshotUrl] = useState<string | null>(
    null,
  );
  const [miningAudioUrl, setMiningAudioUrl] = useState<string | null>(null);
  const [miningAudioExpectedDuration, setMiningAudioExpectedDuration] =
    useState(0);
  const [miningRangeStart, setMiningRangeStart] = useState(0);
  const [miningRangeEnd, setMiningRangeEnd] = useState(0);
  const [miningMediaDuration, setMiningMediaDuration] = useState(0);
  const [isMiningCapturing, setIsMiningCapturing] = useState(false);
  const [isMiningRefreshing, setIsMiningRefreshing] = useState(false);
  // AM-4: synchronous guard against double-clicks
  const isMiningRef = useRef(false);
  const isMiningRefreshingRef = useRef(false);
  const miningEpochRef = useRef(0);
  const miningScreenshotUrlRef = useRef<string | null>(null);
  const miningAudioUrlRef = useRef<string | null>(null);
  const miningAbortControllerRef = useRef<AbortController | null>(null);
  const miningSnapshotTimeRef = useRef(0);

  // --- Stage 2: AnkiConnect session credentials (page-lifetime, memory-only) ---
  const [ankiSession, setAnkiSession] = useState<{
    endpoint: string;
    apiKey: string;
  } | null>(null);
  // Background connection: epoch to detect supersession by Settings connection
  const bgConnEpochRef = useRef(0);
  const bgConnAbortRef = useRef<AbortController | null>(null);
  const bgConnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether Settings has established a session (prevents background overwrite)
  const settingsSessionActiveRef = useRef(false);
  // Export state
  const [exportMode, setExportModeState] = useState<'new' | 'update'>(
    () => readAnkiMinerPreferences().exportMode,
  );
  const [mediaMode, setMediaMode] = useState<'image' | 'video'>(
    () => readAnkiMinerPreferences().mediaMode ?? 'image',
  );
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [mediaPreviewType, setMediaPreviewType] = useState<
    'image' | 'video' | null
  >('image');
  const [mediaUnsupported, setMediaUnsupported] = useState<string | null>(null);
  const mediaBlobRef = useRef<Blob | null>(null);
  const mediaBlobUrlRef = useRef<string | null>(null);
  const mediaEpochRef = useRef(0);
  const [isMediaRecapturing, setIsMediaRecapturing] = useState(false);
  /** Dedicated AbortController for media-mode re-capture. Superseded on each
   *  new toggle, aborted on dialog close / media change / unmount. */
  const mediaRecaptureAbortRef = useRef<AbortController | null>(null);
  /** Records the actual captured media artifact type at capture time.
   * Export uses this instead of the live mediaMode toggle, so toggling
   * Image/Video after capture but before Send does not corrupt markup. */
  const capturedMediaTypeRef = useRef<'image' | 'video' | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState(false);
  const exportEpochRef = useRef(0);
  const exportAbortControllerRef = useRef<AbortController | null>(null);
  // AM-6c: Append-to-specific state
  const [isAppending, setIsAppending] = useState(false);
  const [appendResult, setAppendResult] = useState<{
    succeeded: number[];
    failed: number[];
  } | null>(null);
  const appendEpochRef = useRef(0);
  const appendAbortControllerRef = useRef<AbortController | null>(null);
  // Refs for Blobs (kept separately from preview URLs)
  const miningScreenshotBlobRef = useRef<Blob | null>(null);
  const miningAudioBlobRef = useRef<Blob | null>(null);

  // --- P1.1: touch + reduced-motion detection ---
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    setIsTouchDevice(
      typeof window !== 'undefined' &&
        ('ontouchstart' in window || navigator.maxTouchPoints > 0),
    );
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // ED-1: Magnet URI dialog visibility — visual shell only, no torrent runtime.
  const [isMagnetDialogOpen, setIsMagnetDialogOpen] = useState(false);
  // ED-3: EizouDendenshi local-companion pairing — persistent credential.
  // The opaque token is persisted (browser localStorage envelope) after a
  // successful pair and re-validated on mount, so pairing survives F5 /
  // companion restarts until the user explicitly resets it.
  const pairing = useCompanionPairing();

  // --- EizouDendenshi ED-2F YouTube job bridge ---
  const jobSession = useCompanionJobSession();
  const displayMediaUrl = jobSession.jobMediaUrl ?? mediaUrl;
  const displayMediaType = jobSession.jobMediaUrl ? 'video' : mediaType;
  // LazySync polling loop reads the session through this ref so the loop
  // closure never goes stale across renders (token/jobId may arrive after
  // the loop starts).
  const jobSessionRef = useRef(jobSession);
  jobSessionRef.current = jobSession;
  /** Magnet (torrent) source — drives the LazySync toggle rendering. */
  const isMagnet = jobSession.kind === 'torrent';

  // ED-2H: Seek clamp — when streaming from a companion, clamp seek targets
  // to the verified byte range (available) to prevent the player from seeking
  // beyond what's been downloaded (which would stall on ServeContent Read).
  const clampSeekTime = useCallback(
    (seconds: number): number => {
      const p = jobSession.progress;
      if (!p || p.total <= 0) return seconds;
      const media =
        mediaType === 'video' ? videoRef.current : audioRef.current;
      const duration = media?.duration ?? 0;
      return clampCompanionSeek(seconds, p.available, p.total, duration);
    },
    [jobSession.progress, mediaType],
  );

  // ED-2F: a real YouTube job accepted by the companion starts the bridge
  // session (polling the job's status; media loads only on complete).
  const handleYouTubeJobAccepted = useCallback(
    (jobId: string) => {
      const token = pairing.tokenRef.current;
      if (!token) return;
      jobSession.beginJobSession({
        baseUrl: 'http://127.0.0.1:4322',
        token,
        jobId,
        kind: 'youtube',
      });
      setIsYouTubeDialogOpen(false);
    },
    [jobSession, pairing.tokenRef],
  );

  const handleMagnetJobAccepted = useCallback(
    (jobId: string, selectedName: string, subtitleFileId: string) => {
      const token = pairing.tokenRef.current;
      if (!token) return;
      // Torrent basename handoff (C): the companion's sanitized file list
      // provides the selected video's basename; mirror it into mediaName
      // for the top-left controls / history, sanitized for safe display.
      setMediaName(sanitizeDisplayName(selectedName));
      jobSession.beginJobSession({
        baseUrl: 'http://127.0.0.1:4322',
        token,
        jobId,
        kind: 'torrent',
        subtitleFileId: subtitleFileId || undefined,
      });
      setIsMagnetDialogOpen(false);
    },
    [jobSession, pairing.tokenRef],
  );

  // Attach the actual video element on the complete gate (existing ref).
  // Companion source fix: the job session's media is a video, but the local
  // `mediaType` state is only set by the local-file/audio flows. Without
  // this mirror, videoCallbackRef gates sharedMediaRef to null for
  // companion playback, which freezes the custom timestamp (00:00 / 00:00)
  // and makes Play/Pause a no-op. Mirror the type the moment the companion
  // media URL surfaces (before the callback ref / PlayerControls effect).
  useEffect(() => {
    if (jobSession.jobMediaUrl) setMediaType('video');
  }, [jobSession.jobMediaUrl]);

  // ED-2F: mirror the companion's YouTube video title into mediaName (the
  // tracker / controls display name). Torrents already set the selected file
  // basename in handleMagnetJobAccepted; YouTube's title arrives async from
  // the job-status poll once yt-dlp starts.
  useEffect(() => {
    if (jobSession.jobTitle) {
      setMediaName(sanitizeDisplayName(jobSession.jobTitle));
    }
  }, [jobSession.jobTitle]);

  // Companion job failure (state=error → bridge phase 'error'):
  // (a) clear every loading surface immediately — the companion loading
  // overlay (active && !jobMediaUrl) would otherwise spin forever, and
  // the start-buffering overlay must not linger on a failed job;
  // (b) surface the failure via the EizouToaster once per error (the
  // fixed toast id already prevents stacking; the phase guard prevents
  // a re-render from re-firing). No duplicate UI: the video element is
  // unmounted during 'error' (jobMediaUrl null), so VideoPlayer's own
  // errorLabel never renders for job errors — the toast is the single
  // error surface. 2026-08-09 (WARP failure: spinner with no error).
  const prevJobPhaseRef = useRef<CompanionBridgePhase | null>(null);
  useEffect(() => {
    const phase = jobSession.phase;
    if (phase === 'error' && prevJobPhaseRef.current !== 'error') {
      setIsStartBuffering(false);
      setIsLoading(false);
      notifyCompanionError(
        dictRef.current.playerUI.companionJobError,
      );
    }
    if (phase === 'error' || phase === 'idle') {
      // A failed/ended job also releases the buffering overlays.
      setIsStartBuffering(false);
    }
    prevJobPhaseRef.current = phase;
  }, [jobSession.phase]);

  // Quality toast wiring (2026-08-09): notifyQuality has existed since
  // rc.46 but had ZERO call sites — the wiring was never done, which is
  // why no quality toast appeared in any mode (not a speed-vs-quality
  // bug). Fire once per job at the moment the media URL first surfaces,
  // which is the same "handed to the player" moment for both modes:
  // speed reports playable early, quality reports playable only at
  // complete — the URL surfacing is the handoff in both cases.
  const notifiedQualityJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jobSession.jobMediaUrl) return;
    // The quality toast is a YouTube-job surface: without a known mode
    // (torrent sessions / idle) there is no "Speed/Quality" label to
    // show — bail instead of falling back to Speed implicitly.
    if (!jobSession.jobMode) return;
    const quality = jobSession.jobQuality;
    const jobId = jobSession.jobId;
    // 0/NA/absent → no toast (a partial mock session without these
    // fields must stay silent too).
    if (!quality || quality <= 0 || !jobId) return;
    if (notifiedQualityJobRef.current === jobId) return; // once per job
    notifiedQualityJobRef.current = jobId;
    const ui = dictRef.current.playerUI;
    const modeLabel =
      jobSession.jobMode === 'quality'
        ? ui.ytModeLabelQuality
        : ui.ytModeLabelSpeed;
    notifyQuality(ui.ytModeToastFormat, `${quality}p`, modeLabel);
  }, [jobSession.jobMediaUrl, jobSession.jobQuality, jobSession.jobId, jobSession.jobMode]);

  // Whether the companion-subtitle bounded retry has actually given up
  // (SUBTITLE_RETRY_WINDOW_MS elapsed with no 200). While false, the
  // subtitle panel shows "Preparing subtitles…"; once true it falls back
  // to the ordinary empty/subtitle-less state so a video without
  // subtitles does not show a spinner forever (2026-08-09, Mimo BLOCKER).
  const [subtitleFetchFailed, setSubtitleFetchFailed] = useState(false);

  // Companion job with a subtitle fetch still running (or not yet
  // attempted) and no content parsed yet — drives the "Preparing
  // subtitles…" panel state. Cleared once the bounded retry gives up
  // (subtitleFetchFailed), content arrives, or the job errors (the
  // error toast takes over; a spinner must never linger on a failed
  // job). Single source of truth so the desktop and mobile RightPanel
  // receive the same computed value. The SubtitlePanel keeps no
  // deadline knowledge: PlayerApp owns the retry window and the
  // fallback.
  const isLoadingSubtitles =
    jobSession.active &&
    !!jobSession.subtitleUrl &&
    cues.length === 0 &&
    !subtitleFetchFailed &&
    jobSession.phase !== 'error';

// ED-2G: Auto-fetch subtitle content from companion when a torrent job
  // selected a subtitle file, or from a YouTube job that has Japanese
  // subtitles. Fetches the text, parses it with the same subtitle-reader
  // used for local files, and populates the subtitle panel.
  //
  // Torrent: subtitle file is prioritized on selection so content is
  // available immediately — no need to wait for bridge 'ready'.
  // YouTube: the companion serves the subtitle as soon as the file is on
  // disk, which happens in parallel with the media download (yt-dlp
  // writes it while downloading; speed mode streams the .part early, so
  // the bridge can report 'ready' before the VTT exists). The first
  // fetch can therefore legitimately return 404 ("subtitle not
  // available") — rather than giving up, retry in a bounded loop (every
  // SUBTITLE_RETRY_INTERVAL_MS, until SUBTITLE_RETRY_WINDOW_MS or
  // unmount/cancel). Failures stay silent: no toast, no error state;
  // the panel simply fills in once the file appears.
  //
  // Mimo BLOCKER (2026-08-09): when the retry deadline passes without a
  // 200, there is no reason to keep showing "Preparing subtitles…"
  // forever (a video may simply have no Japanese subtitle). On the
  // deadline, mark subtitleFetchFailed so the loading state clears and
  // the panel falls back to the ordinary empty state. The SubtitlePanel
  // itself owns NO deadline knowledge — PlayerApp owns the retry window
  // and the fallback, which keeps the panel a pure presentation layer.
  useEffect(() => {
    const url = jobSession.subtitleUrl;
    if (!url || !jobSession.active) return;
    // A new job/source resets the retry state.
    setSubtitleFetchFailed(false);
    // YouTube subtitles are only fetchable once the bridge reports the
    // media playable (the file can still be mid-write — the bounded
    // retry below absorbs the gap); torrents fetch immediately.
    // Note: the retry window starts here, so a phase gate that opens
    // after SUBTITLE_RETRY_WINDOW_MS has elapsed (unlikely: ready/playing
    // arrives within seconds of the media URL) would leave the subtitle
    // unfetched until a re-render re-runs this effect. This is a known
    // limit, not a regression — the gate exists to avoid fetching before
    // any media is servable.
    if (jobSession.kind === 'youtube' && jobSession.phase !== 'ready' && jobSession.phase !== 'playing') return;
    let cancelled = false;
    const ac = new AbortController();
    const retryDeadline = Date.now() + SUBTITLE_RETRY_WINDOW_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async (): Promise<void> => {
      try {
        const res = await fetch(url, {
          cache: 'no-store',
          signal: ac.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          // 404 / 4xx / 5xx — not available yet; retry until the file
          // is written (bounded), unless the component unmounted.
          scheduleRetry();
          return;
        }
        const text = await res.text();
        if (cancelled) return;
        const result = parseSubtitle(text);
        setCues(result.cues);
        setSubtitleErrors(result.errors);
        setActiveCueId(null);
        subtitleTextRef.current = text;
      } catch {
        // Network error or abort — stay silent and retry while bounded.
        scheduleRetry();
      }
    };

    const scheduleRetry = () => {
      if (cancelled) return;
      if (Date.now() >= retryDeadline) {
        // Bounded retry exhausted without a 200: give up silently and
        // let the panel fall back to the empty state (no "Preparing…
        //" forever). A later phase/source change re-runs this effect
        // and resets the flag.
        setSubtitleFetchFailed(true);
        return;
      }
      if (retryTimer !== null) return; // one pending retry at a time
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void fetchOnce();
      }, SUBTITLE_RETRY_INTERVAL_MS);
    };

    void fetchOnce();

    return () => {
      cancelled = true;
      ac.abort();
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
  }, [jobSession.subtitleUrl, jobSession.active, jobSession.kind, jobSession.phase]);

  useEffect(() => {
    jobSession.attachMediaElement(videoRef.current);
  }, [jobSession, jobSession.jobMediaUrl, jobSession.phase]);
  const [isYouTubeDialogOpen, setIsYouTubeDialogOpen] = useState(false);

  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const controlsHandleRef = useRef<PlayerControlsHandle>(null);
  const mediaContainerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const sharedMediaRef = useRef<HTMLMediaElement | null>(null);

  // --- Stage 2a: Tracker runtime (non-visual, side-effect only) ---
  // Refs to carry latest media identity into the flush callback (defined
  // before trackerFlush so the stable callback can read ref.current).
  const flushMediaIdRef = useRef<string | null>(null);
  const flushMediaNameRef = useRef('');

  const trackerFlush = useCallback(
    async (
      cells: Map<string, import('@/features/player/tracker/types').ExposureCell>,
      totals: import('@/features/player/tracker/types').TimeTotals,
      learningSetId: string,
    ) => {
      // Stage 2b: Real IndexedDB persistence. Fire-and-forget: failures
      // are swallowed and never block playback or Anki export.
      const mediaId = flushMediaIdRef.current;
      if (!mediaId) return;

      const file = mediaFileRef.current;
      flushTrackerData(cells, totals, learningSetId, {
        mediaId,
        mediaName: flushMediaNameRef.current,
        byteSize: file?.size ?? 0,
        mimeType: file?.type ?? '',
      }).catch(() => {});
    },
    [],
  );

  const trackerRuntime = useTrackerRuntime({
    // Browser torrent source was removed in ED-1; tracker stays local-file only.
    isTorrentSource: false,
    isLocalFile: !!mediaFileRef.current,
    mediaFile: mediaFileRef.current,
    mediaName,
    hasSubtitles: cues.length > 0,
    subtitleText: subtitleTextRef.current,
    playMode: playMode === 'condensed' || playMode === 'fast-forward'
      ? playMode
      : 'normal',
    playbackRate,
    isPlaying,
    isPaused: !isPlaying && !!mediaUrl,
    isBuffering: false,
    mediaRef: sharedMediaRef,
    onFlush: trackerFlush,
  });

  // Stage 2b: Sync latest media identity into flush callback refs
  flushMediaIdRef.current = trackerRuntime.mediaId;
  flushMediaNameRef.current = mediaName;

  // Cleanup on unmount
  useEffect(() => {
    // AM-2: Reset for React StrictMode double-invoke (setup→cleanup→setup).
    // Without this, the second setup leaves mountedRef=false and discards all work.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      revokeUrl(activeUrlRef.current);
      activeUrlRef.current = null;
      // AM-2: Revoke any lingering screenshot object URL
      if (screenshotUrlRef.current) {
        URL.revokeObjectURL(screenshotUrlRef.current);
        screenshotUrlRef.current = null;
      }
      // AM-3: Revoke any lingering audio clip object URL
      if (audioClipUrlRef.current) {
        URL.revokeObjectURL(audioClipUrlRef.current);
        audioClipUrlRef.current = null;
      }
      // AM-3: Cancel any in-flight recording
      cancelActiveRecording();
      // AM-4: Revoke any lingering mining object URLs
      if (miningScreenshotUrlRef.current) {
        URL.revokeObjectURL(miningScreenshotUrlRef.current);
        miningScreenshotUrlRef.current = null;
      }
      if (miningAudioUrlRef.current) {
        URL.revokeObjectURL(miningAudioUrlRef.current);
        miningAudioUrlRef.current = null;
      }
      // AM-4: Abort any in-flight mining recording
      miningAbortControllerRef.current?.abort();
      // Stage 2: Clear session credentials + abort pending export
      setAnkiSession(null);
      // Background connection cleanup
      bgConnEpochRef.current += 1;
      bgConnAbortRef.current?.abort();
      if (bgConnTimerRef.current !== null) {
        clearTimeout(bgConnTimerRef.current);
        bgConnTimerRef.current = null;
      }
      exportAbortControllerRef.current?.abort();
      // Media-mode recapture abort + cleanup
      mediaRecaptureAbortRef.current?.abort();
      mediaRecaptureAbortRef.current = null;
      if (mediaBlobUrlRef.current) {
        URL.revokeObjectURL(mediaBlobUrlRef.current);
        mediaBlobUrlRef.current = null;
      }
      miningScreenshotBlobRef.current = null;
      miningAudioBlobRef.current = null;
      mediaBlobRef.current = null;
      capturedMediaTypeRef.current = null;
      setIsMediaRecapturing(false);
      if (mediaBlobUrlRef.current) {
        URL.revokeObjectURL(mediaBlobUrlRef.current);
        mediaBlobUrlRef.current = null;
      }
      setMediaPreviewUrl(null);
      setMediaUnsupported(null);
    };
  }, []);

  // Fix: Use callback refs instead of a sync effect. Callback refs fire during
  // the commit phase (before any effects), so sharedMediaRef.current is populated
  // before PlayerControls' listener effect reads it. This eliminates the
  // parent-effect-before-child-effect timing race.
  const videoCallbackRef = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el;
      sharedMediaRef.current = displayMediaType === 'video' ? el : null;
    },
    [displayMediaType],
  );

  const audioCallbackRef = useCallback(
    (el: HTMLAudioElement | null) => {
      audioRef.current = el;
      sharedMediaRef.current = displayMediaType === 'audio' ? el : null;
    },
    [displayMediaType],
  );

  // Fix #4: Apply volume using direct element refs (avoids sharedRef timing race)
  useEffect(() => {
    const media = mediaType === 'video' ? videoRef.current : audioRef.current;
    if (!media) return;
    media.volume = isMobileViewport ? 1 : volume;
  }, [volume, mediaUrl, mediaType, isMobileViewport]);

  // Fix #4: Apply playback rate using direct element refs
  useEffect(() => {
    const media = mediaType === 'video' ? videoRef.current : audioRef.current;
    if (!media) return;
    media.playbackRate = playbackRate;
  }, [playbackRate, mediaUrl, mediaType]);

  // --- Handlers ---
  /** AM-2: Revoke prior screenshot URL and update ref/state atomically. */
  const replaceScreenshotUrl = useCallback((newUrl: string | null) => {
    const prev = screenshotUrlRef.current;
    if (prev && prev !== newUrl) {
      URL.revokeObjectURL(prev);
    }
    screenshotUrlRef.current = newUrl;
    setScreenshotPreviewUrl(newUrl);
  }, []);

  /** AM-2: Clear screenshot state when media changes or dialog closes. */
  const clearScreenshot = useCallback(() => {
    captureEpochRef.current += 1;
    isCapturingRef.current = false;
    setHasScreenshotError(false);
    replaceScreenshotUrl(null);
    setIsScreenshotDialogOpen(false);
    setIsCapturing(false);
  }, [replaceScreenshotUrl]);

  /** AM-3: Revoke prior audio clip URL and update ref/state atomically. */
  const replaceAudioClipUrl = useCallback((newUrl: string | null) => {
    const prev = audioClipUrlRef.current;
    if (prev && prev !== newUrl) {
      URL.revokeObjectURL(prev);
    }
    audioClipUrlRef.current = newUrl;
    setAudioClipUrl(newUrl);
  }, []);

  /** AM-3: Clear audio clip state when media changes or dialog closes. */
  const clearAudioClip = useCallback(() => {
    audioClipEpochRef.current += 1;
    isRecordingAudioRef.current = false;
    setHasAudioClipError(false);
    setAudioClipExpectedDuration(0);
    replaceAudioClipUrl(null);
    setIsAudioClipDialogOpen(false);
    setIsRecordingAudio(false);
    cancelActiveRecording();
  }, [replaceAudioClipUrl]);

  /** AM-4: Revoke prior mining screenshot URL and update ref/state atomically. */
  const replaceMiningScreenshotUrl = useCallback((newUrl: string | null) => {
    const prev = miningScreenshotUrlRef.current;
    if (prev && prev !== newUrl) {
      URL.revokeObjectURL(prev);
    }
    miningScreenshotUrlRef.current = newUrl;
    setMiningScreenshotUrl(newUrl);
  }, []);

  /** AM-4: Revoke prior mining audio URL and update ref/state atomically. */
  const replaceMiningAudioUrl = useCallback((newUrl: string | null) => {
    const prev = miningAudioUrlRef.current;
    if (prev && prev !== newUrl) {
      URL.revokeObjectURL(prev);
    }
    miningAudioUrlRef.current = newUrl;
    setMiningAudioUrl(newUrl);
  }, []);

  /** AM-4: Clear mining preview state when media changes or dialog closes. */
  const clearMiningPreview = useCallback(() => {
    miningEpochRef.current += 1;
    isMiningRef.current = false;
    isMiningRefreshingRef.current = false;
    setIsMiningCapturing(false);
    setIsMiningRefreshing(false);
    setMiningHasScreenshotError(false);
    setMiningHasAudioError(false);
    setMiningDraftFields([]);
    setMiningRangeStart(0);
    setMiningRangeEnd(0);
    setMiningMediaDuration(0);
    setMiningAudioExpectedDuration(0);
    miningScreenshotBlobRef.current = null;
    miningAudioBlobRef.current = null;
    // Stage 2: Clear export state
    setExportError(null);
    setExportSuccess(false);
    replaceMiningScreenshotUrl(null);
    replaceMiningAudioUrl(null);
    setIsMiningPreviewOpen(false);
    miningAbortControllerRef.current?.abort();
    miningAbortControllerRef.current = null;
    exportAbortControllerRef.current?.abort();
    exportAbortControllerRef.current = null;
  }, [replaceMiningScreenshotUrl, replaceMiningAudioUrl]);

  /** AM-4: Build draft fields from Anki field mapping.
   *  Semantic order: sentence, definition, image, audio, word, source, tags.
   *  Omit fields with empty/null mapping. If sentence mapping is empty,
   *  return empty array (no draft fields at all).
   *  Dedupe by physical field name — keep first semantic entry. */
  const buildDraftFields = useCallback(
    (
      mapping: AnkiFieldMapping,
      cueText: string,
      sourceLabel: string,
    ): { key: string; physicalName: string; value: string }[] => {
      // If sentence mapping is empty, show no draft fields
      if (!mapping.sentence) return [];

      // Semantic order with defaults
      const entries: {
        key: string;
        physicalName: string;
        value: string;
      }[] = [
        { key: 'sentence', physicalName: mapping.sentence, value: cueText },
        ...(mapping.definition
          ? [{ key: 'definition', physicalName: mapping.definition, value: '' }]
          : []),
        ...(mapping.image
          ? [{ key: 'image', physicalName: mapping.image, value: '' }]
          : []),
        ...(mapping.audio
          ? [{ key: 'audio', physicalName: mapping.audio, value: '' }]
          : []),
        ...(mapping.word
          ? [{ key: 'word', physicalName: mapping.word, value: '' }]
          : []),
        ...(mapping.source
          ? [
              {
                key: 'source',
                physicalName: mapping.source,
                value: sourceLabel,
              },
            ]
          : []),
      ];

      // Dedupe by physical field name — keep first semantic entry
      const seen = new Set<string>();
      return entries.filter((e) => {
        if (seen.has(e.physicalName)) return false;
        seen.add(e.physicalName);
        return true;
      });
    },
    [],
  );

  /** AM-4: Handler for draft field value changes. */
  const handleDraftFieldChange = useCallback(
    (index: number, newValue: string) => {
      setMiningDraftFields((prev) =>
        prev.map((f, i) => (i === index ? { ...f, value: newValue } : f)),
      );
    },
    [],
  );

  const handleMediaSelect = useCallback(
    (file: File) => {
      // ED-2E: media switch ends any active companion fixture session.
      void jobSession.cancelActiveJob();

      const admission = classifyMediaFile(file);

      if (admission.kind === 'rejected') {
        setLoadError(
          `${dictRef.current.playerUI.unsupportedFormat}: .${admission.ext}`,
        );
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setLoadError(null);
      setActiveCueId(null);
      // Stage 2a: Clear subtitle text on media change (subtitles are media-specific)
      subtitleTextRef.current = null;
      // AM-2: Invalidate any prior screenshot when selecting new media
      clearScreenshot();
      // AM-3: Invalidate any prior audio clip when selecting new media
      clearAudioClip();
      // AM-4: Invalidate any prior mining preview when selecting new media
      clearMiningPreview();

      const oldUrl = activeUrlRef.current;
      const newUrl = createMediaUrl(file, oldUrl);
      activeUrlRef.current = newUrl;
      setMediaUrl(newUrl);
      setMediaType(admission.kind);
      setMediaName(file.name);
      // Stage 2a: Store local file reference for tracker fingerprint computation.
      mediaFileRef.current = file;
    },
    [clearScreenshot, clearAudioClip, clearMiningPreview, jobSession],
  );

  const handleSubtitleSelect = useCallback((file: File) => {
    setSubtitleErrors([]);

    if (!isSubtitleFile(file)) {
      const p = dictRef.current.playerUI;
      setSubtitleErrors([
        {
          line: 0,
          message: `${p.unsupportedFormat}: .${getFileExtension(file)}`,
        },
      ]);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result;
      if (typeof content !== 'string') {
        setSubtitleErrors([
          { line: 0, message: dictRef.current.playerUI.failedToRead },
        ]);
        return;
      }

      const result = parseSubtitle(content);
      setCues(result.cues);
      setSubtitleErrors(result.errors);
      setActiveCueId(null);
      // Stage 2a: Store raw subtitle text for tracker digest computation
      subtitleTextRef.current = content;
    };
    reader.onerror = () => {
      setSubtitleErrors([
        { line: 0, message: dictRef.current.playerUI.failedToRead },
      ]);
    };
    reader.readAsText(file);
  }, []);

  // File open handler: routes subtitle files to handleSubtitleSelect, everything else to handleMediaSelect.
  const handleFileOpen = useCallback(
    (file: File) => {
      if (isSubtitleFile(file)) {
        handleSubtitleSelect(file);
      } else {
        handleMediaSelect(file);
      }
    },
    [handleSubtitleSelect, handleMediaSelect],
  );

  const handleCueClick = useCallback((cue: SubtitleCue) => {
    const media = sharedMediaRef.current;
    if (!media) return;
    // ED-2H: Clamp seek to companion's verified byte range when streaming.
    // Without this, clicking a cue beyond the available prefix stalls the
    // player (seeking=true, readyState=1, GPU 100%).
    const targetTime = jobSession.active
      ? clampSeekTime(cue.start)
      : cue.start;
    media.currentTime = targetTime;
    media.play().catch(() => {});
    // P2: Reveal controls when clicking a cue while they are hidden
    controlsHandleRef.current?.show();
  }, [jobSession.active, clampSeekTime]);

  // --- P1.3a.2: Caption display mode handlers ---

  const handleCycleCaptionMode = useCallback(() => {
    setCaptionDisplayMode((prev) => {
      const next = nextCaptionDisplayMode(prev);
      // Persist the new mode together with current volume/rate
      writePlayerPreferences({
        volume: prefsRef.current.volume,
        playbackRate: prefsRef.current.playbackRate,
        captionDisplayMode: next,
        subtitleFontSize: prefsRef.current.subtitleFontSize,
        subtitleTextColor: prefsRef.current.subtitleTextColor,
        subtitleBackgroundColor: prefsRef.current.subtitleBackgroundColor,
        subtitleBackgroundPadding: prefsRef.current.subtitleBackgroundPadding,
        subtitleVerticalPosition: prefsRef.current.subtitleVerticalPosition,
        subtitleSyncMode: prefsRef.current.subtitleSyncMode,
      });
      // Keep prefsRef in sync to avoid stale reads in other callbacks
      prefsRef.current = { ...prefsRef.current, captionDisplayMode: next };
      return next;
    });
    // Reset reveal state when cycling modes
    setIsOverlayRevealed(false);
  }, []);

  /** Clear the blur-restore timer if pending. */
  const clearBlurRestoreTimer = useCallback(() => {
    if (blurRestoreTimerRef.current !== null) {
      clearTimeout(blurRestoreTimerRef.current);
      blurRestoreTimerRef.current = null;
    }
  }, []);

  // Desktop: pointer enter overlay → cancel pending restore, reveal immediately
  const handleOverlayPointerEnter = useCallback(() => {
    if (captionDisplayMode !== 'blurred') return;
    clearBlurRestoreTimer();
    setIsOverlayRevealed(true);
  }, [captionDisplayMode, clearBlurRestoreTimer]);

  // Desktop: pointer leave overlay → start 1s restore timer
  const handleOverlayPointerLeave = useCallback(() => {
    if (captionDisplayMode !== 'blurred') return;
    blurRestoreTimerRef.current = setTimeout(() => {
      setIsOverlayRevealed(false);
      blurRestoreTimerRef.current = null;
    }, BLUR_RESTORE_TIMEOUT_MS);
  }, [captionDisplayMode]);

  // Mobile: tap blurred overlay → pause media + reveal text
  const handleOverlayTouchTap = useCallback(() => {
    if (captionDisplayMode !== 'blurred') return;
    const media = sharedMediaRef.current;
    if (media && !media.paused) {
      media.pause();
    }
    setIsOverlayRevealed(true);
    controlsHandleRef.current?.show();
  }, [captionDisplayMode]);

  // Cleanup blur timer on unmount or mode change away from blurred
  useEffect(() => {
    if (captionDisplayMode !== 'blurred') {
      clearBlurRestoreTimer();
      setIsOverlayRevealed(false);
    }
    return clearBlurRestoreTimer;
  }, [captionDisplayMode, clearBlurRestoreTimer]);

  // P1.3a.2: Re-blur overlay ONLY on an actual resume transition (isPlaying: false→true).
  // This prevents the race where a touch-tap pause sets isOverlayRevealed=true
  // but isPlaying is still true (pause event not yet fired by React), which
  // would cause an immediate spurious re-blur.
  useEffect(() => {
    const wasPlaying = prevIsPlayingRef.current;
    prevIsPlayingRef.current = isPlaying;

    if (
      !wasPlaying &&
      isPlaying &&
      captionDisplayMode === 'blurred' &&
      isOverlayRevealed
    ) {
      clearBlurRestoreTimer();
      setIsOverlayRevealed(false);
    }
    return clearBlurRestoreTimer;
  }, [isPlaying, captionDisplayMode, isOverlayRevealed, clearBlurRestoreTimer]);

  const handleTimeUpdate = useCallback(
    (time: number) => {
      const active = findActiveCue(cues, time);
      setActiveCueId(active?.id ?? null);
    },
    [cues],
  );

  const handlePlay = useCallback(() => setIsPlaying(true), []);
  const handlePause = useCallback(() => setIsPlaying(false), []);

  const handleLoaded = useCallback(() => {
    setIsLoading(false);
    setLoadError(null);
  }, []);

  const handleError = useCallback((error: string) => {
    setIsLoading(false);
    setLoadError(error);
    // Clear seek buffering on error — the overlay is meaningless if the
    // element has errored.
    setIsSeekBuffering(false);
    // Symmetric for the companion start-buffering overlay: an errored
    // element never becomes playable, so the overlay must not linger.
    setIsStartBuffering(false);
  }, []);

  // --- Seek buffering: monitor readyState after seek events ---
  // When the video element fires 'seeking', it means a seek is in
  // progress. If readyState < HAVE_FUTURE_DATA (2) at that point, we
  // show the spinner overlay — but only after a 1-second delay so that
  // fast seeks that resolve within 1 second never flash the overlay.
  // The overlay clears when:
  // 1. 'canplay' fires (readyState >= HAVE_FUTURE_DATA, data arrived)
  // 2. 'error' fires (element errored, overlay is meaningless)
  // 3. A safety timeout fires (5s — prevents stuck overlay if canplay
  //    never fires for some reason)
  useEffect(() => {
    const media = mediaType === 'video' ? videoRef.current : null;
    if (!media) return;

    const HAVE_FUTURE_DATA = 2;

    const clearSeekBufferingTimers = () => {
      if (seekBufferingDelayRef.current !== null) {
        clearTimeout(seekBufferingDelayRef.current);
        seekBufferingDelayRef.current = null;
      }
      if (seekBufferingTimeoutRef.current !== null) {
        clearTimeout(seekBufferingTimeoutRef.current);
        seekBufferingTimeoutRef.current = null;
      }
    };

    const onSeeking = () => {
      // If readyState is already sufficient, no overlay needed
      if (media.readyState >= HAVE_FUTURE_DATA) return;
      // Delay showing the overlay by 1 second so fast seeks stay invisible
      clearSeekBufferingTimers();
      seekBufferingDelayRef.current = setTimeout(() => {
        seekBufferingDelayRef.current = null;
        // Re-check readyState after the delay — the seek may have resolved
        if (media.readyState >= HAVE_FUTURE_DATA) return;
        setIsSeekBuffering(true);
        // Safety timeout: clear after 5s even if canplay never fires
        seekBufferingTimeoutRef.current = setTimeout(() => {
          seekBufferingTimeoutRef.current = null;
          setIsSeekBuffering(false);
        }, 5000);
      }, 1000);
    };

    const onCanPlay = () => {
      clearSeekBufferingTimers();
      setIsSeekBuffering(false);
    };

    media.addEventListener('seeking', onSeeking);
    media.addEventListener('canplay', onCanPlay);
    return () => {
      media.removeEventListener('seeking', onSeeking);
      media.removeEventListener('canplay', onCanPlay);
      clearSeekBufferingTimers();
      setIsSeekBuffering(false);
    };
  }, [mediaType, mediaUrl]);

  // --- Companion start buffering: monitor the initial playability ---
  // The companion surfaces jobMediaUrl while the .part is still being
  // written; the video element can mount but not start playback yet
  // (readyState < HAVE_FUTURE_DATA or a 'waiting' event). Mirror the
  // seek buffering logic: after 1 s of not-enough-data show the
  // "Preparing video…" overlay; the PLAYING event clears it. The delay
  // avoids flashing the overlay for fast starts.
  //
  // Clear condition is the FIRST PAINTED FRAME, not 'playing'
  // (2026-08-09 on-device: after the playing-based clearing a bare black
  // 00:00/00:00 frame could still linger for seconds). 'playing' only
  // reports that playback stalls cleared — for .part streams whose first
  // bytes carry no video samples (audio-first interleave) the first
  // picture comes later. requestVideoFrameCallback (Chromium) fires when
  // a frame is actually presented, so the overlay then hides exactly
  // when the image appears. Browsers without rVFC fall back to 'playing'
  // (same behavior as before). The 15 s safety bound still hides it for
  // stalled/autoplay-blocked loads. Seek buffering (isSeekBuffering
  // above) deliberately keeps its own canplay-based clearing — this
  // change is initial-load only.
  useEffect(() => {
    const media = mediaType === 'video' ? videoRef.current : null;
    if (!media) return;
    // Only companion job sessions with a surfaced media URL qualify;
    // the pre-URL loading overlay covers the earlier phase.
    if (!jobSession.active || !jobSession.jobMediaUrl) return;

    const HAVE_FUTURE_DATA = 2;

    // One-shot escape hatch: once the 15 s safety bound has fired (a
    // stalled / autoplay-blocked job where 'playing' never comes), stop
    // re-arming on 'waiting' — the overlay must not come back and keep
    // the controls locked. Resets naturally when this effect re-runs
    // (new job / media URL change). Resets on effect re-run (new URL or
    // re-activation).
    let startBufferingExhausted = false;

    // Whether the overlay is currently visible, tracked inside this
    // effect (render-round state would go stale in the event callbacks).
    // Used to skip pointless rVFC registrations once the picture is
    // already on screen.
    let bufferingShown = false;

    const clearStartBufferingTimers = () => {
      if (startBufferingDelayRef.current !== null) {
        clearTimeout(startBufferingDelayRef.current);
        startBufferingDelayRef.current = null;
      }
      if (startBufferingSafetyRef.current !== null) {
        clearTimeout(startBufferingSafetyRef.current);
        startBufferingSafetyRef.current = null;
      }
    };

    const armStartBuffering = () => {
      // After the safety bound the overlay must never reappear for this
      // job/source — the user regains the controls (a manual play press
      // then fires 'playing' and clears the state normally).
      if (startBufferingExhausted) return;
      // If enough data is already here AND playback is under way, nothing
      // to show.
      if (media.readyState >= HAVE_FUTURE_DATA && !media.paused) return;
      clearStartBufferingTimers();
      startBufferingDelayRef.current = setTimeout(() => {
        startBufferingDelayRef.current = null;
        // Re-check after the delay: the element may have become playable
        // (or actually started playing).
        if (media.readyState >= HAVE_FUTURE_DATA && !media.paused) return;
        setIsStartBuffering(true);
        bufferingShown = true;
        // Safety bound: hide the overlay after 15 s even if playing never
        // fires (stalled download or autoplay block) — playback itself is
        // unaffected, and the controls stay usable thanks to the
        // pointer-events:none on the overlay.
        startBufferingSafetyRef.current = setTimeout(() => {
          startBufferingSafetyRef.current = null;
          startBufferingExhausted = true; // never re-arm for this source
          setIsStartBuffering(false);
        }, START_BUFFERING_SAFETY_MS);
      }, 1000);
    };

    const onPlaying = () => {
      bufferingShown = false;
      clearStartBufferingTimers();
      setIsStartBuffering(false);
    };

    // First visible frame: when the video starts we register an rVFC
    // callback that fires only after a frame has literally been painted.
    // On rVFC-capable browsers this is what clears the overlay — playing
    // alone is deliberately NOT enough (a black frame can still be on
    // screen). On browsers without the API (rVFC undefined) we keep the
    // 'playing' fallback above.
    const hasRVFC =
      // both are always present together per spec, but defensive check
      // costs nothing
      typeof media.requestVideoFrameCallback === 'function' &&
      typeof media.cancelVideoFrameCallback === 'function';
    let rvfcHandle: number | null = null;
    const onFirstFrame = (
      _now: DOMHighResTimeStamp,
      meta: VideoFrameCallbackMetadata,
    ) => {
      // Idempotent: safe to call even if already cleared.
      rvfcHandle = null; // consumed
      // The rVFC callback fires for every newly presented frame, and
      // Chromium can present a black/empty frame (width=0/height=0)
      // before the first real video sample arrives (audio-first
      // interleave in .part streams). Only a frame with actual media
      // pixels ends the "black screen" — keep the overlay up and
      // re-register for the NEXT frame when the metadata is empty.
      // The 15 s safety bound (START_BUFFERING_SAFETY_MS) is the
      // ultimate upper limit, so this re-registration cannot loop
      // forever.
      if (meta && meta.width > 0 && meta.height > 0) {
        bufferingShown = false;
        clearStartBufferingTimers();
        setIsStartBuffering(false);
        return;
      }
      // Empty frame (still black): wait for the next frame. Only
      // re-register while the overlay is actually shown — after the
      // safety bound the overlay is gone and further frames are
      // nothing to wait for.
      // Temporary instrumentation: confirms whether Chromium really
      // presents 0x0 frames on the real device (the rVFC spec says the
      // callback fires per presented frame; the width/height here are
      // the media pixel size). Harmless to keep; drop together with the
      // black-frame re-registration if it is never seen.
      console.debug('[entei] rVFC black frame', meta);
      if (bufferingShown && startBufferingSafetyRef.current !== null) {
        requestFirstFrame();
      }
    };
    const requestFirstFrame = () => {
      if (!hasRVFC) return;
      if (rvfcHandle !== null) {
        media.cancelVideoFrameCallback(rvfcHandle);
      }
      rvfcHandle = media.requestVideoFrameCallback(onFirstFrame as VideoFrameRequestCallback);
    };
    const onPlayingRVFC = () => {
      // Already cleared (picture on screen) — skip the pointless
      // re-registration/API calls on later playing transitions.
      if (!bufferingShown) return;
      // With rVFC the picture event is authoritative; playing alone must
      // not clear. Re-register the frame callback on each playback
      // transition so a frame painted during that segment is caught.
      if (hasRVFC) {
        requestFirstFrame();
        return;
      }
      // Fallback path (non-rVFC browsers): onPlaying is the clearing
      // handler used ONLY here.
      onPlaying();
    };

    // If the element is already playing when the effect runs (e.g. a
    // rapid ready→playing transition before the observer attaches), arm
    // the rVFC callback (or clear immediately for non-rVFC browsers).
    if (!media.paused && media.currentTime > 0) {
      if (hasRVFC) {
        requestFirstFrame();
      } else {
        onPlaying();
      }
    }

    media.addEventListener('waiting', armStartBuffering);
    media.addEventListener('playing', onPlayingRVFC);
    // Initial state: the element may already be short of data (typical
    // right after the companion surfaces the URL).
    if (media.paused || media.readyState < HAVE_FUTURE_DATA) {
      armStartBuffering();
    }

    return () => {
      media.removeEventListener('waiting', armStartBuffering);
      media.removeEventListener('playing', onPlayingRVFC);
      if (rvfcHandle !== null && typeof media.cancelVideoFrameCallback === 'function') {
        media.cancelVideoFrameCallback(rvfcHandle);
      }
      clearStartBufferingTimers();
      bufferingShown = false;
      setIsStartBuffering(false);
    };
    // jobSession.phase is a dependency so an error/idle transition re-runs
    // this effect: the cleanup above cancels the pending rVFC handle and
    // resets bufferingShown, so the closure never keeps a stale "shown"
    // flag after the global error handler cleared the overlay from a
    // different effect. Re-arm is harmless for playable phases (arm
    // requires paused || readyState < HAVE_FUTURE_DATA).
  }, [mediaType, jobSession.active, jobSession.jobMediaUrl, jobSession.phase]);

  const handleVolumeChange = useCallback((val: number) => {
    setVolume(val);
    writePlayerPreferences({
      volume: val,
      playbackRate: prefsRef.current.playbackRate,
      captionDisplayMode: prefsRef.current.captionDisplayMode,
      subtitleFontSize: prefsRef.current.subtitleFontSize,
      subtitleTextColor: prefsRef.current.subtitleTextColor,
      subtitleBackgroundColor: prefsRef.current.subtitleBackgroundColor,
      subtitleBackgroundPadding: prefsRef.current.subtitleBackgroundPadding,
      subtitleVerticalPosition: prefsRef.current.subtitleVerticalPosition,
      subtitleSyncMode: prefsRef.current.subtitleSyncMode,
    });
    prefsRef.current = { ...prefsRef.current, volume: val };
  }, []);

  const handlePlaybackRateChange = useCallback((rate: number) => {
    setPlaybackRate(rate);
    manualPlaybackRateRef.current = rate;
    writePlayerPreferences({
      volume: prefsRef.current.volume,
      playbackRate: rate,
      captionDisplayMode: prefsRef.current.captionDisplayMode,
      subtitleFontSize: prefsRef.current.subtitleFontSize,
      subtitleTextColor: prefsRef.current.subtitleTextColor,
      subtitleBackgroundColor: prefsRef.current.subtitleBackgroundColor,
      subtitleBackgroundPadding: prefsRef.current.subtitleBackgroundPadding,
      subtitleVerticalPosition: prefsRef.current.subtitleVerticalPosition,
      subtitleSyncMode: prefsRef.current.subtitleSyncMode,
    });
    prefsRef.current = { ...prefsRef.current, playbackRate: rate };
  }, []);

  // P2.1: Play mode change handler
  const handlePlayModeChange = useCallback(
    (mode: PlayMode) => {
      const prevMode = playMode;
      setPlayMode(mode);

      // When switching away from fast-forward, restore manual rate
      if (prevMode === 'fast-forward' && mode !== 'fast-forward') {
        const restored = manualPlaybackRateRef.current;
        setPlaybackRate(restored);
        const media =
          mediaType === 'video' ? videoRef.current : audioRef.current;
        if (media) media.playbackRate = restored;
      }

      // When switching to fast-forward, evaluate immediately
      if (mode === 'fast-forward') {
        const media =
          mediaType === 'video' ? videoRef.current : audioRef.current;
        if (media) {
          const useFast = shouldFastForward(mode, cues, media.currentTime);
          const targetRate = useFast ? FAST_FORWARD_RATE : 1;
          setPlaybackRate(targetRate);
          media.playbackRate = targetRate;
        }
      }
    },
    [playMode, mediaType, cues],
  );

  // P2.1: Condensed mode — seek to next cue during subtitle-free gaps
  useEffect(() => {
    const media = mediaType === 'video' ? videoRef.current : audioRef.current;
    if (!media || playMode !== 'condensed') return;

    const onTimeUpdate = () => {
      const isMiningOrCapturing =
        isMiningRef.current ||
        isMiningRefreshingRef.current ||
        isCapturingRef.current ||
        isRecordingAudioRef.current;

      if (
        shouldCondensedSeek(
          playMode,
          isPlaying,
          media.paused,
          isMiningOrCapturing,
          media.seeking,
          isCondensedSeekingRef.current,
          cues,
          media.currentTime,
        )
      ) {
        const next = cues.find((c) => c.start > media.currentTime);
        if (next) {
          // If clampSeekTime would move the position, the next cue is beyond the
          // verified range — skip auto-seek to avoid a loop (will retry on next tick).
          if (jobSession.active && clampSeekTime) {
            const clamped = clampSeekTime(next.start);
            if (clamped !== next.start) return;
          }
          isCondensedSeekingRef.current = true;
          // ED-2H: Clamp condensed-mode seek to companion's verified range.
          media.currentTime = jobSession.active
            ? clampSeekTime(next.start)
            : next.start;
          // Fall back to a bounded release if this browser does not dispatch seeked.
          condensedSeekTimeoutRef.current = setTimeout(() => {
            isCondensedSeekingRef.current = false;
            condensedSeekTimeoutRef.current = null;
          }, 500);
        }
      }
    };

    const onSeeked = () => {
      isCondensedSeekingRef.current = false;
      if (condensedSeekTimeoutRef.current !== null) {
        clearTimeout(condensedSeekTimeoutRef.current);
        condensedSeekTimeoutRef.current = null;
      }
    };

    media.addEventListener('timeupdate', onTimeUpdate);
    media.addEventListener('seeked', onSeeked);
    return () => {
      media.removeEventListener('timeupdate', onTimeUpdate);
      media.removeEventListener('seeked', onSeeked);
      onSeeked();
    };
  }, [playMode, mediaType, cues, isPlaying]);

  // P2.1: Fast-forward mode — adjust playback rate based on subtitle proximity
  useEffect(() => {
    const media = mediaType === 'video' ? videoRef.current : audioRef.current;
    if (!media || playMode !== 'fast-forward') return;

    const onTimeUpdate = () => {
      if (!isPlaying) {
        if (media.playbackRate !== 1) {
          media.playbackRate = 1;
          setPlaybackRate(1);
        }
        return;
      }

      const isMiningOrCapturing =
        isMiningRef.current ||
        isMiningRefreshingRef.current ||
        isCapturingRef.current ||
        isRecordingAudioRef.current;

      // Never fast-forward during mining/capture
      if (isMiningOrCapturing) {
        if (media.playbackRate !== 1) {
          media.playbackRate = 1;
          setPlaybackRate(1);
        }
        return;
      }

      const useFast = shouldFastForward(playMode, cues, media.currentTime);
      const targetRate = useFast ? FAST_FORWARD_RATE : 1;
      if (media.playbackRate !== targetRate) {
        media.playbackRate = targetRate;
        setPlaybackRate(targetRate);
      }
    };

    media.addEventListener('timeupdate', onTimeUpdate);
    // Evaluate immediately on mount / mode change
    onTimeUpdate();
    return () => media.removeEventListener('timeupdate', onTimeUpdate);
  }, [playMode, mediaType, cues, isPlaying]);

  // --- AM-2: Screenshot capture ---
  const handleScreenshot = useCallback(async () => {
    const video = videoRef.current;
    if (!video || mediaType !== 'video') return;
    // Guard: synchronous ref prevents double-click within a single render cycle.
    if (isCapturingRef.current) return;

    const epoch = captureEpochRef.current + 1;
    captureEpochRef.current = epoch;
    isCapturingRef.current = true;
    setIsCapturing(true);
    setHasScreenshotError(false);

    let result: Awaited<ReturnType<typeof captureVideoFrame>>;
    try {
      result = await captureVideoFrame(video);
    } catch (e) {
      // Defensive: captureVideoFrame should never reject, but if it does,
      // treat it as a generic capture failure to avoid leaving UI locked.
      result = {
        ok: false,
        error: {
          code: 'BLOB_ENCODE_FAILED',
          message:
            e instanceof Error ? e.message : 'Unexpected capture failure.',
        },
      };
    }

    // Guard: component unmounted → do not touch React state or create URLs.
    if (!mountedRef.current) {
      // Note: do NOT create a URL just to revoke it. Let the Blob be GC'd.
      return;
    }

    // Guard: epoch changed (new media, dialog closed, retry superseded).
    // A newer request or cleanup has taken over; discard this result silently.
    if (captureEpochRef.current !== epoch) {
      return;
    }

    isCapturingRef.current = false;
    setIsCapturing(false);

    if (!result.ok) {
      setHasScreenshotError(true);
      replaceScreenshotUrl(null);
      setIsScreenshotDialogOpen(true);
      return;
    }

    const url = URL.createObjectURL(result.blob);
    replaceScreenshotUrl(url);
    setIsScreenshotDialogOpen(true);
  }, [mediaType, replaceScreenshotUrl]);

  /** AM-2: Close dialog and revoke the object URL to free memory. */
  const handleScreenshotDialogClose = useCallback(() => {
    captureEpochRef.current += 1;
    isCapturingRef.current = false;
    setIsScreenshotDialogOpen(false);
    setHasScreenshotError(false);
    replaceScreenshotUrl(null);
    setIsCapturing(false);
  }, [replaceScreenshotUrl]);

  // --- AM-3: Audio clip capture ---
  const handleAudioClip = useCallback(async () => {
    if (!mediaUrl || !activeCueId || !audioClipCaps.supported) return;
    // Guard: refuse if AM-4 mining is in flight to prevent cross-cancellation
    if (isMiningRef.current || isMiningRefreshingRef.current) return;
    if (isRecordingAudioRef.current) return;

    const activeCue = cues.find((c) => c.id === activeCueId);
    if (!activeCue) return;

    const expectedDuration = activeCue.end - activeCue.start;
    setAudioClipExpectedDuration(expectedDuration > 0 ? expectedDuration : 0);

    const epoch = audioClipEpochRef.current + 1;
    audioClipEpochRef.current = epoch;
    isRecordingAudioRef.current = true;
    setIsRecordingAudio(true);
    setHasAudioClipError(false);

    const result = await recordAudioClip({
      mediaUrl,
      start: activeCue.start,
      end: activeCue.end,
      playbackRate,
    });

    // Guard: component unmounted → do not touch React state or create URLs.
    if (!mountedRef.current) {
      return;
    }

    // Guard: epoch changed (new media, dialog closed, retry superseded).
    if (audioClipEpochRef.current !== epoch) {
      return;
    }

    isRecordingAudioRef.current = false;
    setIsRecordingAudio(false);

    if (!result.ok) {
      setHasAudioClipError(true);
      replaceAudioClipUrl(null);
      setIsAudioClipDialogOpen(true);
      return;
    }

    const url = URL.createObjectURL(result.blob);
    replaceAudioClipUrl(url);
    setIsAudioClipDialogOpen(true);
  }, [
    mediaUrl,
    activeCueId,
    audioClipCaps.supported,
    cues,
    playbackRate,
    replaceAudioClipUrl,
  ]);

  /** AM-3: Close dialog and revoke the object URL to free memory. */
  const handleAudioClipDialogClose = useCallback(() => {
    audioClipEpochRef.current += 1;
    isRecordingAudioRef.current = false;
    setIsAudioClipDialogOpen(false);
    setHasAudioClipError(false);
    replaceAudioClipUrl(null);
    setIsRecordingAudio(false);
    cancelActiveRecording();
  }, [replaceAudioClipUrl]);

  // --- AM-4: Mining capture ---
  /** Mine a cue. When `overrideCue` is provided (row mining), the media is
   *  paused and seeked to cue.start before capture. Without override, mines
   *  the current active cue at whatever time the media is at. */
  /** Apply the detected subtitle text (parsed cues + raw text) after sync. */
  const applySyncedSubtitle = useCallback(
    (syncedText: string) => {
      const result = parseSubtitle(syncedText);
      setCues(result.cues);
      setSubtitleErrors(result.errors);
      setActiveCueId(null);
      subtitleTextRef.current = syncedText;
      // Every sync path (sub-to-sub / sub-to-audio-local / sub-to-audio-magnet)
      // converges here — a single success toast for all of them.
      notifySubtitleSyncSuccess(
        dictRef.current.playerUI.subtitleSyncSuccess,
      );
    },
    [setCues, setSubtitleErrors, setActiveCueId],
  );

  /**
   * Stage 4b: wire the sync button to the planner + subomatic engine.
   *  - skip-youtube          → no-op (button disabled for youtube)
   *  - sub-to-sub            → sync to a picked reference subtitle
   *  - sub-to-sub-auto-ref   → the embedded subtitle is auto-detected and
   *                            used as the reference: Magnet via the
   *                            companion (empty file id), local files via
   *                            mkvgo (first embedded subtitle track). In
   *                            auto mode (fallbackToAudio) a missing
   *                            embedded subtitle falls back to sub-to-audio
   *                            (magnet → dialog, local → direct decode).
   *  - sub-to-audio-local    → decode local media → sync to audio
   *  - sub-to-audio-magnet   → SubtitleSyncDialog (wait for DL → PCM)
   *  - no-reference-subtitle → retired: no plan produces it anymore; the
   *                            branch remains for defensive narrowing.
   */
  /** Shared try/catch/finally for sync tasks (subtitle + audio paths). */
  const runSync = useCallback(async (task: () => Promise<void>) => {
    setIsSyncingSubtitle(true);
    try {
      await task();
    } catch (err) {
      notifySubtitleSyncError(
        err instanceof Error ? err.message : 'subtitle sync failed',
      );
    } finally {
      setIsSyncingSubtitle(false);
    }
  }, []);

  const handleSyncSubtitle = useCallback(() => {
    const text = subtitleTextRef.current;
    if (!text) {
      notifySubtitleSyncError(dictRef.current.playerUI.subtitleSyncNoSubtitle);
      return;
    }
    const prefs = readPlayerPreferences();
    const mode = prefs.subtitleSyncMode ?? 'subtitle';
    const source = detectSourceKind(jobSession.kind, !!mediaUrl);
    // Reference subtitle only for Magnet with a selected subtitle file
    // (local reference picker UI lands in a later stage → false here).
    const hasRef =
      source === 'magnet' ? !!jobSession.subtitleFileId : false;
    const plan = planSync(mode, source, hasRef);
    void runSync(async () => {
      if (plan.kind === 'skip-youtube') return;
      if (plan.kind === 'no-reference-subtitle') {
        notifySubtitleSyncError(
          dictRef.current.playerUI.subtitleSyncNoReference,
        );
        return;
      }
      const detected = parseSubtitle(text);
      const inFormat = detected.format ?? 'vtt';
      // Local audio sync — shared by the sub-to-audio-local plan and the
      // auto fallback when the embedded-subtitle reference is missing.
      // SubtitleSyncDialog is magnet-only, so local media decodes directly.
      const runSubToAudioLocal = async (t: string, f: string) => {
        if (!mediaUrl) {
          notifySubtitleSyncError(
            dictRef.current.playerUI.subtitleSyncNoReference,
          );
          return;
        }
        const res = await fetch(mediaUrl);
        const buffer = await res.arrayBuffer();
        const { samples, sampleRate } = await decodeToMono16k(buffer);
        const synced = await syncSubtitleToAudio(t, f, samples, sampleRate, {
          onProgress: () => {},
        });
        applySyncedSubtitle(synced);
      };
      if (plan.kind === 'sub-to-sub') {
        // Reference subtitle source: Magnet (torrent subtitle file).
        if (
          jobSession.kind !== 'torrent' ||
          !jobSession.jobId ||
          !jobSession.token ||
          !jobSession.subtitleFileId
        ) {
          notifySubtitleSyncError(
            dictRef.current.playerUI.subtitleSyncNoReference,
          );
          return;
        }
        const ref = await fetchMagnetSubtitle(
          jobSession.token,
          jobSession.jobId,
          jobSession.subtitleFileId,
        );
        if (ref.kind !== 'ok') {
          // Explicit selection yet the companion cannot serve it (no
          // embedded track / still preparing) — surface the reference
          // error instead of parsing a non-existent body.
          notifySubtitleSyncError(
            dictRef.current.playerUI.subtitleSyncNoReference,
          );
          return;
        }
        const refDetected = parseSubtitle(ref.text);
        const synced = await syncSubtitleToReference(
          text,
          inFormat,
          ref.text,
          refDetected.format ?? 'vtt',
          { onProgress: () => {} },
        );
        applySyncedSubtitle(synced);
        return;
      }
      if (plan.kind === 'sub-to-sub-auto-ref') {
        // No manual subtitle selection — the embedded subtitle is
        // auto-detected and used as the sub-to-sub reference: Magnet via
        // the companion (empty file id), local files via mkvgo (first
        // embedded subtitle track).
        if (jobSession.kind !== 'torrent' && !mediaFileRef.current) {
          notifySubtitleSyncError(
            dictRef.current.playerUI.subtitleSyncNoReference,
          );
          return;
        }
        try {
          let refText: string;
          if (jobSession.kind === 'torrent') {
            if (!jobSession.jobId || !jobSession.token) {
              notifySubtitleSyncError(
                dictRef.current.playerUI.subtitleSyncNoReference,
              );
              return;
            }
            const ref = await fetchMagnetSubtitle(
              jobSession.token,
              jobSession.jobId,
              '',
            );
            // Any non-ok result (no embedded track / cues still pending /
            // timeout) means the reference is unavailable right now — the
            // shared catch below routes it to the auto fallback or the
            // reference error, as before.
            if (ref.kind !== 'ok') throw new Error('no embedded subtitle');
            refText = ref.text;
          } else {
            // Local embedded subtitle via mkvgo.
            const file = mediaFileRef.current;
            if (!file) throw new Error('no embedded subtitle');
            // extractSubtitleVTT accepts a Blob/File and reads it through
            // ranged slices (memory-bounded, like probe()), so even a
            // 13.4 GiB MKV extracts without loading the whole file into
            // memory — no size ceiling needed. probe() is also ranged.
            const mkvgo = await loadMkvGo({
              wasmUrl: '/wasm/mkvgo.wasm',
              wasmExecUrl: '/wasm/wasm_exec.js',
            });
            const probe = await mkvgo.probe(file);
            const subTrack = probe.tracks.find(
              (t) => t.type === 'subtitle',
            );
            if (!subTrack) throw new Error('no embedded subtitle');
            refText = await mkvgo.extractSubtitleVTT(file, subTrack.id);
          }
          const refDetected = parseSubtitle(refText);
          const synced = await syncSubtitleToReference(
            text,
            inFormat,
            refText,
            refDetected.format ?? 'vtt',
            { onProgress: () => {} },
          );
          applySyncedSubtitle(synced);
        } catch (err) {
          // No embedded subtitle in the source (404 from the companion /
          // missing track), or the mkvgo extraction failed.
          console.error('[entei] embedded subtitle extraction failed', err);
          if (plan.fallbackToAudio) {
            // auto mode: sub-to-sub failed → fall back to sub-to-audio.
            // Magnet audio is disabled (docs SUBTITLE_SYNC.md §10.4): the
            // user is told to use subtitle mode instead. Local files
            // decode directly.
            if (jobSession.kind === 'torrent') {
              notifySubtitleSyncError(
                dictRef.current.playerUI.subtitleSyncAudioUnavailable,
              );
            } else {
              await runSubToAudioLocal(text, inFormat);
            }
          } else {
            notifySubtitleSyncError(
              dictRef.current.playerUI.subtitleSyncNoReference,
            );
          }
        }
        return;
      }
      if (plan.kind === 'sub-to-audio-local') {
        await runSubToAudioLocal(text, inFormat);
        return;
      }
      if (plan.kind === 'sub-to-audio-magnet') {
        // Magnet audio sync is disabled (docs SUBTITLE_SYNC.md §10.4):
        // full-DL + PCM conversion is not viable while streaming. The
        // sync button is a LazySync toggle for Magnet anyway — this branch
        // is defense-in-depth for any residual call path.
        notifySubtitleSyncError(
          dictRef.current.playerUI.subtitleSyncAudioUnavailable,
        );
      }
    });
  }, [
    jobSession.kind,
    jobSession.jobId,
    jobSession.token,
    jobSession.subtitleFileId,
    mediaUrl,
    applySyncedSubtitle,
    runSync,
  ]);

  /**
   * LazySync toggle (Magnet only, docs SUBTITLE_SYNC.md §10).
   *  - OFF → ON: validate a loaded subtitle, snapshot its cues as the base,
   *    start the polling loop, toast "LazySync enabled".
   *  - ON → OFF: stop the loop (the polling effect aborts), keep the
   *    already-shifted display as-is, toast "LazySync disabled".
   *  - Audio sync mode on Magnet is unavailable (§10.4): clicking the
   *    toggle in audio mode only explains why (no state change).
   */
  const handleToggleLazySync = useCallback(() => {
    if (jobSessionRef.current.kind !== 'torrent') return;
    const ui = dictRef.current.playerUI;
    if (isLazySyncOn) {
      setIsLazySyncOn(false);
      lazySyncStateRef.current = null;
      notifyLazySyncInfo(ui.subtitleSyncLazyOff);
      return;
    }
    // Audio-based sync is disabled for Magnet (docs §10.4): the toggle
    // would only ever run the subtitle-based LazySync, so a user in audio
    // mode gets the guidance toast instead of a dead toggle.
    const mode = readPlayerPreferences().subtitleSyncMode ?? 'subtitle';
    if (mode === 'audio') {
      notifySubtitleSyncError(ui.subtitleSyncAudioUnavailable);
      return;
    }
    const text = subtitleTextRef.current;
    if (!text) {
      notifySubtitleSyncError(ui.subtitleSyncNoSubtitle);
      return;
    }
    const baseCues = parseSubtitle(text).cues;
    if (baseCues.length === 0) {
      notifySubtitleSyncError(ui.subtitleSyncNoSubtitle);
      return;
    }
    lazySyncStateRef.current = {
      baseCues,
      appliedOnce: false,
      lastOffsetMs: null,
      waitPollCount: 0,
    };
    setIsLazySyncOn(true);
    notifyLazySyncInfo(ui.subtitleSyncLazyOn);
  }, [isLazySyncOn]);

  /**
   * LazySync polling loop (docs §10.2-10.3): every poll interval, fetch the
   * embedded subtitle's downloaded-prefix cues and estimate the constant
   * offset by rank-pairing median. The concentration check refuses bimodal
   * splits (fail-closed); |offset| < LAZY_SYNC_MIN_OFFSET_MS (including a
   * 0 median) converges silently. Waiting states share one bounded counter
   * (LAZY_SYNC_MAX_WAIT_POLLS ≈ 12 min); abort / stale session / exhausted
   * bound stop the loop. Mutable data flows through lazySyncStateRef so the
   * loop never depends on a render's closure.
   */
  const runLazySyncPolling = useCallback(async (signal: AbortSignal) => {
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
      });

    const stop = () => {
      setIsLazySyncOn(false);
      lazySyncStateRef.current = null;
    };

    while (!signal.aborted) {
      const session = jobSessionRef.current;
      if (
        session.kind !== 'torrent' ||
        !session.token ||
        !session.jobId
      ) {
        // The Magnet session ended or changed while the loop ran — reset
        // the toggle so it cannot linger on a stale session.
        stop();
        return;
      }
      const state = lazySyncStateRef.current;
      if (!state) return;

      /** One bounded waiting round: bump the wait counter, sleep a poll
       *  interval, and give up (no-subtitle toast) once the ~12-min bound
       *  is exceeded. Returns false when the loop must stop. */
      const boundedWait = async (): Promise<boolean> => {
        state.waitPollCount += 1;
        if (state.waitPollCount > LAZY_SYNC_MAX_WAIT_POLLS) {
          stop();
          notifySubtitleSyncError(
            dictRef.current.playerUI.subtitleSyncNoSubtitle,
          );
          return false;
        }
        await sleep(LAZY_SYNC_POLL_INTERVAL_MS);
        return true;
      };

      try {
        const result = await fetchMagnetSubtitle(
          session.token,
          session.jobId,
          session.subtitleFileId ?? '',
        );
        if (result.kind === 'no-track') {
          // The torrent has NO embedded subtitle track (404, permanent):
          // a reference can never appear, so stop immediately instead of
          // waiting out the bounded wait.
          stop();
          notifySubtitleSyncError(
            dictRef.current.playerUI.subtitleSyncNoReference,
          );
          return;
        }
        if (result.kind === 'cues-pending') {
          // The embedded track exists but the DL'd prefix has no cues yet
          // (503, temporary — Growing Media contract). Same waiting state
          // as a short ref-cue prefix, bounded so it cannot run forever.
          if (!(await boundedWait())) return;
          continue;
        }
        if (result.kind === 'error') {
          // Transient failure (timeout / companion hiccup) — keep the
          // waiting state and try again on the next poll.
          await sleep(LAZY_SYNC_POLL_INTERVAL_MS);
          continue;
        }
        const ref = result;
        const refCues = parseSubtitle(ref.text).cues;
        if (refCues.length < LAZY_SYNC_MIN_REF_CUES) {
          // Downloaded prefix has too few cues yet to trust an estimate
          // (docs §10: first sync waits for a usable cue count). Bounded
          // so the waiting state cannot run forever.
          if (!(await boundedWait())) return;
          continue;
        }

        const est = estimateMedianOffset(state.baseCues, refCues);
        if (!est) {
          // Median estimator returned null (no cues, a bimodal split refused
          // by the concentration check, or an offset beyond 1 h).
          if (!(await boundedWait())) return;
          continue;
        }

        const offsetMs = est.offsetMs;
        if (Math.abs(offsetMs) < LAZY_SYNC_MIN_OFFSET_MS) {
          // Already in sync (ffsubsync --suppress-output-if-offset-less-
          // than): an offset under 100 ms is sub-frame noise — leave the
          // cues untouched and treat the sync as converged. No success
          // toast for Magnet; polling continues to re-check as the DL
          // grows.
          state.lastOffsetMs = offsetMs;
          state.waitPollCount = 0;
          if (!state.appliedOnce) state.appliedOnce = true;
          await sleep(LAZY_SYNC_POLL_INTERVAL_MS);
          continue;
        }

        const prev = state.lastOffsetMs;
        const changed =
          prev === null ||
          Math.abs(offsetMs - prev) > LAZY_SYNC_STABLE_THRESHOLD_MS;
        state.lastOffsetMs = offsetMs;
        state.waitPollCount = 0;

        if (changed) {
          // Apply to the ORIGINAL base cues every time — never to the
          // previously shifted display — so refinement cannot drift.
          setCues(shiftCuesByOffset(state.baseCues, offsetMs));
          setSubtitleErrors([]);
          setActiveCueId(null);
        }
        if (!state.appliedOnce) {
          state.appliedOnce = true;
        }
      } catch {
        // Transient fetch failure (subtitle still preparing) — keep the
        // waiting state and try again on the next poll.
      }
      await sleep(LAZY_SYNC_POLL_INTERVAL_MS);
    }
  }, []);

  // Start / stop the LazySync loop with the toggle. The cleanup abort also
  // covers unmount.
  useEffect(() => {
    if (!isLazySyncOn) return;
    const ac = new AbortController();
    void runLazySyncPolling(ac.signal);
    return () => ac.abort();
  }, [isLazySyncOn, runLazySyncPolling]);

  /** Magnet audio sync: dialog handed us decoded PCM — run sub-to-audio. */
  const handleAudioSyncComplete = useCallback(
    async (audio: { samples: Float32Array; sampleRate: number }) => {
      const text = subtitleTextRef.current;
      if (!text) return;
      const detected = parseSubtitle(text);
      const inFormat = detected.format ?? 'vtt';
      await runSync(async () => {
        const synced = await syncSubtitleToAudio(
          text,
          inFormat,
          audio.samples,
          audio.sampleRate,
          { onProgress: () => {} },
        );
        applySyncedSubtitle(synced);
      });
    },
    [applySyncedSubtitle, runSync],
  );

  const handleMine = useCallback(
    async (overrideCue?: SubtitleCue) => {
      if (!mediaUrl) return;
      // Guard: refuse if any standalone capture (AM-2 screenshot / AM-3 audio) or AM-4 mining is in flight
      if (
        isCapturingRef.current ||
        isRecordingAudioRef.current ||
        isMiningRef.current
      )
        return;

      const targetCue = overrideCue ?? cues.find((c) => c.id === activeCueId);
      if (!targetCue) return;

      const media = sharedMediaRef.current;

      // Row mining: seek the visible media to the target cue start so
      // the screenshot/video-clip frame reflects the mined timestamp.
      if (overrideCue && media) {
        media.pause();
        if (mediaType === 'video' && videoRef.current) {
          const seekController = new AbortController();
          try {
            await seekVideoSafely(
              videoRef.current,
              targetCue.start,
              seekController.signal,
            );
          } catch {
            // Seek failed or aborted — abort mining
            return;
          }
        } else {
          media.currentTime = targetCue.start;
        }
      }

      const snapshotTime = media?.currentTime ?? 0;
      miningSnapshotTimeRef.current = snapshotTime;
      media?.pause();

      const epoch = miningEpochRef.current + 1;
      miningEpochRef.current = epoch;
      isMiningRef.current = true;
      setIsMiningCapturing(true);
      setMiningHasScreenshotError(false);
      setMiningHasAudioError(false);

      // AM-4: Read field mapping from saved preferences on every Mine start
      const prefs = readAnkiMinerPreferences();
      const sourceLabel = `${mediaName} (${formatTime(targetCue.start)} – ${formatTime(targetCue.end)})`;
      const draftFields = buildDraftFields(
        prefs.fields,
        targetCue.text,
        sourceLabel,
      );
      setMiningDraftFields(draftFields);

      setMiningRangeStart(targetCue.start);
      setMiningRangeEnd(targetCue.end);
      setMiningAudioExpectedDuration(
        Math.max(0, targetCue.end - targetCue.start),
      );
      const duration = media?.duration ?? 0;
      setMiningMediaDuration(Number.isFinite(duration) ? duration : 0);
      // Open immediately: materials stream into the workspace independently.
      // Waiting for real-time audio recording here made Mine appear unresponsive
      // for the full cue duration.
      setIsMiningPreviewOpen(true);

      const abortController = new AbortController();
      miningAbortControllerRef.current = abortController;

      // Screenshot: video only
      let screenshotResult: Awaited<
        ReturnType<typeof captureVideoFrame>
      > | null = null;
      let videoClipResult: Awaited<ReturnType<typeof recordVideoClip>> | null =
        null;
      if (mediaType === 'video' && videoRef.current) {
        if (mediaMode === 'video') {
          // Video Clip mode: record silent WebM instead of JPEG screenshot
          try {
            videoClipResult = await recordVideoClip({
              mediaUrl,
              start: targetCue.start,
              end: targetCue.end,
              playbackRate,
              signal: abortController.signal,
            });
          } catch (e) {
            videoClipResult = {
              ok: false,
              error: {
                code: 'RECORDER_ERROR',
                message:
                  e instanceof Error
                    ? e.message
                    : 'Unexpected video clip failure.',
              },
            };
          }
        } else {
          // Image mode: capture JPEG screenshot
          try {
            screenshotResult = await captureVideoFrame(videoRef.current);
          } catch (e) {
            screenshotResult = {
              ok: false,
              error: {
                code: 'BLOB_ENCODE_FAILED',
                message:
                  e instanceof Error
                    ? e.message
                    : 'Unexpected capture failure.',
              },
            };
          }
        }
      }

      // Screenshot resolves before audio recording. Show it immediately instead
      // of holding a completed frame behind the still-recording audio task.
      if (!mountedRef.current || miningEpochRef.current !== epoch) return;
      if (mediaType === 'video') {
        if (mediaMode === 'video') {
          // Video Clip result handling
          if (videoClipResult && !videoClipResult.ok) {
            // Unsupported video — fall back to JPEG
            setMediaUnsupported(dictRef.current.playerUI.mediaModeUnsupported);
            setMediaPreviewType('image');
            setMediaPreviewUrl(null);
            mediaBlobRef.current = null;
            capturedMediaTypeRef.current = null;
            // Fall through to screenshot capture as fallback
            if (videoRef.current) {
              try {
                screenshotResult = await captureVideoFrame(videoRef.current);
              } catch (e) {
                screenshotResult = {
                  ok: false,
                  error: {
                    code: 'BLOB_ENCODE_FAILED',
                    message:
                      e instanceof Error
                        ? e.message
                        : 'Unexpected capture failure.',
                  },
                };
              }
            }
          } else if (videoClipResult && videoClipResult.ok) {
            setMediaUnsupported(null);
            setMediaPreviewType('video');
            mediaBlobRef.current = videoClipResult.blob;
            capturedMediaTypeRef.current = 'video';
            // Revoke old URL
            if (mediaBlobUrlRef.current)
              URL.revokeObjectURL(mediaBlobUrlRef.current);
            const newUrl = URL.createObjectURL(videoClipResult.blob);
            mediaBlobUrlRef.current = newUrl;
            setMediaPreviewUrl(newUrl);
            // Store for export — do NOT route through screenshotUrl
            miningScreenshotBlobRef.current = videoClipResult.blob;
          }
          // Video clip failed → JPEG fallback was captured above; consume it
          // exactly like the image-mode handler so Picture field shows the frame.
          if (
            videoClipResult &&
            !videoClipResult.ok &&
            screenshotResult &&
            screenshotResult.ok
          ) {
            // Revoke old media preview URL
            if (mediaBlobUrlRef.current)
              URL.revokeObjectURL(mediaBlobUrlRef.current);
            miningScreenshotBlobRef.current = screenshotResult.blob;
            const fallbackUrl = URL.createObjectURL(screenshotResult.blob);
            mediaBlobUrlRef.current = fallbackUrl;
            replaceMiningScreenshotUrl(fallbackUrl);
            mediaBlobRef.current = screenshotResult.blob;
            capturedMediaTypeRef.current = 'image';
            setMediaPreviewType('image');
            setMediaPreviewUrl(fallbackUrl);
          } else if (
            videoClipResult &&
            !videoClipResult.ok &&
            screenshotResult &&
            !screenshotResult.ok
          ) {
            // Both video and JPEG fallback failed — surface error
            setMiningHasScreenshotError(true);
            replaceMiningScreenshotUrl(null);
            miningScreenshotBlobRef.current = null;
            mediaBlobRef.current = null;
            capturedMediaTypeRef.current = null;
            setMediaPreviewUrl(null);
          }
        } else {
          // Image mode result handling
          if (screenshotResult && !screenshotResult.ok) {
            setMiningHasScreenshotError(true);
            replaceMiningScreenshotUrl(null);
            miningScreenshotBlobRef.current = null;
            mediaBlobRef.current = null;
            capturedMediaTypeRef.current = null;
            setMediaPreviewUrl(null);
          } else if (screenshotResult && screenshotResult.ok) {
            miningScreenshotBlobRef.current = screenshotResult.blob;
            replaceMiningScreenshotUrl(
              URL.createObjectURL(screenshotResult.blob),
            );
            mediaBlobRef.current = screenshotResult.blob;
            capturedMediaTypeRef.current = 'image';
            setMediaPreviewType('image');
            setMediaPreviewUrl(miningScreenshotUrl);
          }
        }
      }

      // Audio
      const audioResult = await recordAudioClip({
        mediaUrl,
        start: targetCue.start,
        end: targetCue.end,
        playbackRate,
        signal: abortController.signal,
      });

      // Guards
      if (!mountedRef.current) return;
      if (miningEpochRef.current !== epoch) return;

      isMiningRef.current = false;
      setIsMiningCapturing(false);

      // Audio result
      if (!audioResult.ok) {
        setMiningHasAudioError(true);
        replaceMiningAudioUrl(null);
        miningAudioBlobRef.current = null;
      } else {
        miningAudioBlobRef.current = audioResult.blob;
        const url = URL.createObjectURL(audioResult.blob);
        replaceMiningAudioUrl(url);
      }
    },
    [
      mediaUrl,
      activeCueId,
      cues,
      mediaType,
      mediaName,
      mediaMode,
      playbackRate,
      replaceMiningScreenshotUrl,
      replaceMiningAudioUrl,
    ],
  );

  /** AM-4: Close mining preview, revoke URLs, seek back to snapshot, pause. */
  const handleMiningPreviewClose = useCallback(() => {
    miningEpochRef.current += 1;
    isMiningRef.current = false;
    isMiningRefreshingRef.current = false;
    setIsMiningPreviewOpen(false);
    setIsMiningCapturing(false);
    setIsMiningRefreshing(false);
    setMiningHasScreenshotError(false);
    setMiningHasAudioError(false);
    miningScreenshotBlobRef.current = null;
    miningAudioBlobRef.current = null;
    // Stage 2: Clear export state + abort pending export
    exportEpochRef.current += 1;
    setIsExporting(false);
    setExportError(null);
    setExportSuccess(false);
    exportAbortControllerRef.current?.abort();
    exportAbortControllerRef.current = null;
    replaceMiningScreenshotUrl(null);
    replaceMiningAudioUrl(null);
    miningAbortControllerRef.current?.abort();
    miningAbortControllerRef.current = null;
    // Abort any in-flight media-mode recapture
    mediaRecaptureAbortRef.current?.abort();
    mediaRecaptureAbortRef.current = null;

    const media = sharedMediaRef.current;
    if (media) {
      media.currentTime = miningSnapshotTimeRef.current;
      media.pause();
    }
  }, [replaceMiningScreenshotUrl, replaceMiningAudioUrl]);

  const handleMiningRangeChange = useCallback((value: number[]) => {
    const [start, end] = value;
    if (start !== undefined) setMiningRangeStart(start);
    if (end !== undefined) setMiningRangeEnd(end);
  }, []);

  /** AM-4 Stage 1.1: Auto-refresh range-derived materials on slider commit.
   *  Uses the exact committed [start, end] values — not stale React state.
   *  Only sentence/source/image/audio are overwritten; user-edited
   *  definition/word/tags are preserved. */
  const handleRangeCommit = useCallback(
    async (committedValue: number[]) => {
      const start = committedValue[0];
      const end = committedValue[1];
      if (
        !mediaUrl ||
        start == null ||
        end == null ||
        !Number.isFinite(start) ||
        !Number.isFinite(end)
      )
        return;
      if (start >= end || start < 0) return;
      if (isMiningRefreshingRef.current) return;

      // Determine which fields are mapped
      const prefs = readAnkiMinerPreferences();
      const hasSentence = !!prefs.fields.sentence;
      const hasSource = !!prefs.fields.source;
      const hasImage = !!prefs.fields.image;
      const hasAudio = !!prefs.fields.audio;
      const hasVideo = mediaType === 'video' && !!videoRef.current;

      // If literally no mapped fields, nothing to do
      if (!hasSentence && !hasSource && !hasImage && !hasAudio) return;

      const epoch = miningEpochRef.current + 1;
      miningEpochRef.current = epoch;
      isMiningRefreshingRef.current = true;
      setIsMiningRefreshing(true);

      // Use the committed values — not stale state
      const committedStart = start;
      const committedEnd = end;

      const abortController = new AbortController();
      miningAbortControllerRef.current = abortController;

      // Phase 1: Update sentence and source (synchronous)
      if (hasSentence || hasSource) {
        const newSentence = hasSentence
          ? selectCueTextInRange(cues, committedStart, committedEnd)
          : '';
        const newSource = hasSource
          ? `${mediaName} (${formatTime(committedStart)} – ${formatTime(committedEnd)})`
          : '';

        setMiningDraftFields((prev) =>
          prev.map((f) => {
            if (f.key === 'sentence' && hasSentence) {
              return { ...f, value: newSentence };
            }
            if (f.key === 'source' && hasSource) {
              return { ...f, value: newSource };
            }
            return f;
          }),
        );
      }

      // Phase 1.5: Immediately clear old Picture + Audio and show skeletons
      if (hasImage) {
        // Revoke old picture artifact
        if (mediaBlobUrlRef.current) {
          URL.revokeObjectURL(mediaBlobUrlRef.current);
          mediaBlobUrlRef.current = null;
        }
        mediaBlobRef.current = null;
        miningScreenshotBlobRef.current = null;
        capturedMediaTypeRef.current = null;
        replaceMiningScreenshotUrl(null);
        setMediaPreviewUrl(null);
        setMediaPreviewType(null);
      }
      if (hasAudio) {
        // Revoke old audio artifact
        miningAudioBlobRef.current = null;
        replaceMiningAudioUrl(null);
      }
      // Clear error states for fresh skeletons
      setMiningHasScreenshotError(false);
      setMiningHasAudioError(false);
      setMediaUnsupported(null);

      // Phase 2+3: Capture media + audio concurrently (staged, not published yet)
      // Stage results in local variables — no React state updates until both finish.
      let stagedPictureResult: {
        ok: boolean;
        blob?: Blob;
        type?: 'image' | 'video';
        unsupportedMessage?: string;
        errorMsg?: string;
      } = { ok: false };
      let stagedAudioResult: {
        ok: boolean;
        blob?: Blob;
        errorMsg?: string;
      } = { ok: false };

      const capturePicture = async (): Promise<{
        ok: boolean;
        blob?: Blob;
        type?: 'image' | 'video';
        unsupportedMessage?: string;
        errorMsg?: string;
      }> => {
        if (!hasImage || !hasVideo) return { ok: false, errorMsg: 'no-video' };
        const video = videoRef.current!;

        try {
          await seekVideoSafely(video, committedStart, abortController.signal);

          if (!mountedRef.current || miningEpochRef.current !== epoch)
            return { ok: false, errorMsg: 'stale' };
          if (abortController.signal.aborted)
            return { ok: false, errorMsg: 'aborted' };

          if (mediaMode === 'video') {
            const clipResult = await recordVideoClip({
              mediaUrl: mediaUrl!,
              start: committedStart,
              end: committedEnd,
              signal: abortController.signal,
            });

            if (!mountedRef.current || miningEpochRef.current !== epoch)
              return { ok: false, errorMsg: 'stale' };
            if (clipResult.ok) {
              return {
                ok: true,
                blob: clipResult.blob,
                type: 'video',
              };
            }

            // Video failed — JPEG fallback
            const fallback = await captureVideoFrame(video);
            if (!mountedRef.current || miningEpochRef.current !== epoch)
              return { ok: false, errorMsg: 'stale' };
            if (fallback.ok) {
              return {
                ok: true,
                blob: fallback.blob,
                type: 'image',
                unsupportedMessage: clipResult.error.message,
              };
            }
            return {
              ok: false,
              errorMsg: 'both-failed',
              unsupportedMessage: clipResult.error.message,
            };
          } else {
            // Image mode: JPEG capture
            const screenshotResult = await captureVideoFrame(video);
            if (!mountedRef.current || miningEpochRef.current !== epoch)
              return { ok: false, errorMsg: 'stale' };
            if (screenshotResult.ok) {
              return {
                ok: true,
                blob: screenshotResult.blob,
                type: 'image',
              };
            }
            return { ok: false, errorMsg: 'capture-failed' };
          }
        } catch {
          return { ok: false, errorMsg: 'exception' };
        } finally {
          video.currentTime = miningSnapshotTimeRef.current;
          video.pause();
        }
      };

      const captureAudio = async (): Promise<{
        ok: boolean;
        blob?: Blob;
        errorMsg?: string;
      }> => {
        if (!hasAudio || !audioClipCaps.supported)
          return { ok: false, errorMsg: 'unsupported' };
        const result = await recordAudioClip({
          mediaUrl,
          start: committedStart,
          end: committedEnd,
          playbackRate,
          signal: abortController.signal,
        });
        if (result.ok) {
          return { ok: true, blob: result.blob };
        }
        return { ok: false, errorMsg: 'audio-failed' };
      };

      // Run both captures concurrently
      const [pictureOutcome, audioOutcome] = await Promise.allSettled([
        capturePicture(),
        captureAudio(),
      ]);

      // Staged results
      stagedPictureResult =
        pictureOutcome.status === 'fulfilled'
          ? pictureOutcome.value
          : { ok: false, errorMsg: 'promise-rejected' };
      stagedAudioResult =
        audioOutcome.status === 'fulfilled'
          ? audioOutcome.value
          : { ok: false, errorMsg: 'promise-rejected' };

      // Final guard before publishing
      if (!mountedRef.current || miningEpochRef.current !== epoch) return;
      if (abortController.signal.aborted) return;

      // Phase 4: Single React update boundary — publish both results together
      // Picture
      if (hasImage) {
        if (stagedPictureResult.ok && stagedPictureResult.blob) {
          const blob = stagedPictureResult.blob;
          const url = URL.createObjectURL(blob);
          if (stagedPictureResult.type === 'video') {
            mediaBlobUrlRef.current = url;
            mediaBlobRef.current = blob;
            capturedMediaTypeRef.current = 'video';
            setMediaPreviewType('video');
            setMediaPreviewUrl(url);
            miningScreenshotBlobRef.current = blob;
            replaceMiningScreenshotUrl(url);
          } else {
            mediaBlobUrlRef.current = url;
            mediaBlobRef.current = blob;
            capturedMediaTypeRef.current = 'image';
            setMediaPreviewType('image');
            setMediaPreviewUrl(url);
            miningScreenshotBlobRef.current = blob;
            replaceMiningScreenshotUrl(url);
          }
          if (stagedPictureResult.unsupportedMessage) {
            setMediaUnsupported(stagedPictureResult.unsupportedMessage);
          }
        } else {
          setMiningHasScreenshotError(true);
          replaceMiningScreenshotUrl(null);
          miningScreenshotBlobRef.current = null;
          mediaBlobUrlRef.current = null;
          mediaBlobRef.current = null;
          capturedMediaTypeRef.current = null;
          if (stagedPictureResult.unsupportedMessage) {
            setMediaUnsupported(stagedPictureResult.unsupportedMessage);
          }
        }
      }
      // Audio
      if (hasAudio) {
        if (stagedAudioResult.ok && stagedAudioResult.blob) {
          miningAudioBlobRef.current = stagedAudioResult.blob;
          const audioUrl = URL.createObjectURL(stagedAudioResult.blob);
          replaceMiningAudioUrl(audioUrl);
        } else {
          setMiningHasAudioError(true);
          replaceMiningAudioUrl(null);
          miningAudioBlobRef.current = null;
        }
      }

      // Final guard
      if (!mountedRef.current || miningEpochRef.current !== epoch) return;

      isMiningRefreshingRef.current = false;
      setIsMiningRefreshing(false);
    },
    [
      mediaUrl,
      mediaType,
      mediaName,
      cues,
      audioClipCaps.supported,
      playbackRate,
      mediaMode,
      replaceMiningScreenshotUrl,
      replaceMiningAudioUrl,
    ],
  );

  /** AM-4: Mine is possible when media loaded and active cue exists,
   *  AND no standalone AM-2 screenshot or AM-3 audio capture is in flight. */
  const canMine =
    (mediaType === 'video' || mediaType === 'audio') &&
    !!mediaUrl &&
    activeCueId != null &&
    !isCapturing &&
    !isRecordingAudio &&
    !isMiningCapturing &&
    !isMiningRefreshing;

  const isMining = isMiningCapturing || isMiningRefreshing;

  /** Row mining: possible whenever media is loaded, regardless of active cue.
   *  Same capture-in-flight guard as canMine. */
  const canMineRow =
    (mediaType === 'video' || mediaType === 'audio') &&
    !!mediaUrl &&
    !isCapturing &&
    !isRecordingAudio &&
    !isMiningCapturing &&
    !isMiningRefreshing;

  // AM-4: canRefresh — true if ANY mapped field can be refreshed.
  const canRefresh = useMemo(() => {
    const prefs = readAnkiMinerPreferences();
    const hasSentence = !!prefs.fields.sentence;
    const hasSource = !!prefs.fields.source;
    const hasImage = !!prefs.fields.image && mediaType === 'video';
    const hasAudio = !!prefs.fields.audio && audioClipCaps.supported;
    return hasSentence || hasSource || hasImage || hasAudio;
  }, [mediaType, audioClipCaps.supported]);

  /** Stage 2: Background read-only AnkiConnect connection from saved endpoint.
   *  Enables Mining Preview Send without opening Settings. Retries every 10s
   *  on failure only — never retries after a successful connection. Resumes
   *  when Settings disconnects (via handleSessionCredentials). Never calls
   *  write APIs, never stores API key. Settings connection supersedes via
   *  epoch guard. */
  const attemptBackgroundConnect = useCallback(async () => {
    if (settingsSessionActiveRef.current) return;

    const prefs = readAnkiMinerPreferences();
    const endpoint = prefs.ankiConnectUrl || 'http://127.0.0.1:8765';

    const epoch = bgConnEpochRef.current;
    const controller = new AbortController();
    bgConnAbortRef.current = controller;

    const client = new AnkiConnectClient(endpoint, undefined);

    try {
      const result = await runAnkiConnectionFlow(client, controller.signal);

      // Guard: superseded by Settings or unmounted
      if (epoch !== bgConnEpochRef.current) return;
      if (!mountedRef.current) return;
      if (settingsSessionActiveRef.current) return;
      if (controller.signal.aborted) return;

      if (result.requireApiKey) {
        // Background cannot provide API key — Settings must handle this
        return;
      }

      // Success: set session (no API key for background)
      setAnkiSession({ endpoint, apiKey: '' });
      // ponytail: No retry on success — stop here. Resume only when
      // Settings disconnects (handleSessionCredentials clears the epoch).
      return;
    } catch {
      // Silently fail — will retry
      if (epoch !== bgConnEpochRef.current) return;
      if (!mountedRef.current) return;
      if (settingsSessionActiveRef.current) return;
    }

    // Schedule retry on failure only
    if (epoch !== bgConnEpochRef.current) return;
    if (!mountedRef.current) return;
    if (settingsSessionActiveRef.current) return;

    if (bgConnTimerRef.current !== null) {
      clearTimeout(bgConnTimerRef.current);
    }
    bgConnTimerRef.current = setTimeout(() => {
      bgConnTimerRef.current = null;
      attemptBackgroundConnect();
    }, 10_000);
  }, []);

  // Global navigation settings live in a separate React island. SettingsTabs
  // persists subtitle changes; this listener only updates the in-memory
  // overlay so the player reacts immediately.
  useEffect(() => {
    return listenForSubtitleSettingsChange((settings) => {
      setSubtitleSettings((previous) => ({ ...previous, ...settings }));
    });
  }, []);

  // Anki credentials are page-lifetime memory only. A Settings session
  // supersedes background work; disconnect resumes the existing keyless
  // background attempt after the same 1-second grace period as before.
  useEffect(() => {
    const handleSessionCredentials = (
      credentials: { endpoint: string; apiKey: string } | null,
    ) => {
      bgConnEpochRef.current += 1;
      bgConnAbortRef.current?.abort();

      if (credentials !== null) {
        settingsSessionActiveRef.current = true;
        setAnkiSession({
          endpoint: credentials.endpoint,
          apiKey: credentials.apiKey,
        });
        return;
      }

      settingsSessionActiveRef.current = false;
      setAnkiSession(null);
      if (bgConnTimerRef.current !== null) {
        clearTimeout(bgConnTimerRef.current);
      }
      bgConnTimerRef.current = setTimeout(() => {
        bgConnTimerRef.current = null;
        void attemptBackgroundConnect();
      }, 1_000);
    };

    return listenForAnkiSessionCredentials(handleSessionCredentials);
  }, [attemptBackgroundConnect]);

  // Mount: start background connection
  useEffect(() => {
    attemptBackgroundConnect();

    return () => {
      bgConnEpochRef.current += 1;
      bgConnAbortRef.current?.abort();
      if (bgConnTimerRef.current !== null) {
        clearTimeout(bgConnTimerRef.current);
        bgConnTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  /** Stage 2: Persist export mode preference when user changes it. */
  const handleExportModeChange = useCallback((mode: 'new' | 'update') => {
    setExportModeState(mode);
    // Persist only the mode — preserve all other existing prefs
    try {
      const prefs = readAnkiMinerPreferences();
      writeAnkiMinerPreferences({ ...prefs, exportMode: mode });
    } catch {
      // localStorage failure is non-fatal
    }
  }, []);

  const handleMediaModeChange = useCallback(
    (mode: 'image' | 'video') => {
      if (mode === mediaMode) return; // no-op if already selected
      setMediaMode(mode);
      try {
        const prefs = readAnkiMinerPreferences();
        writeAnkiMinerPreferences({ ...prefs, mediaMode: mode });
      } catch {
        // localStorage failure is non-fatal
      }
      // Abort any prior media recapture
      mediaRecaptureAbortRef.current?.abort();
      setIsMediaRecapturing(true);
      const epoch = ++mediaEpochRef.current;
      const abortCtrl = new AbortController();
      mediaRecaptureAbortRef.current = abortCtrl;
      const signal = abortCtrl.signal;
      const videoEl = videoRef.current;
      const currentRange: [number, number] = [miningRangeStart, miningRangeEnd];

      const run = async () => {
        // Save visible player state for restoration after capture
        const savedTime = videoEl?.currentTime ?? 0;
        const savedPaused = videoEl?.paused ?? true;
        try {
          // Clear old screenshot/URL state so skeleton appears in AspectRatio
          if (mediaBlobUrlRef.current) {
            URL.revokeObjectURL(mediaBlobUrlRef.current);
            mediaBlobUrlRef.current = null;
          }
          mediaBlobRef.current = null;
          capturedMediaTypeRef.current = null;
          setMediaPreviewUrl(null);
          setMediaPreviewType(mode);
          setMediaUnsupported(null);
          miningScreenshotBlobRef.current = null;
          replaceMiningScreenshotUrl(null);

          // Seek to range start for accurate capture
          if (videoEl) {
            videoEl.currentTime = currentRange[0];
            await new Promise<void>((resolve) => {
              if (!videoEl) {
                resolve();
                return;
              }
              const onSeeked = () => {
                videoEl.removeEventListener('seeked', onSeeked);
                resolve();
              };
              videoEl.addEventListener('seeked', onSeeked);
              // Timeout to avoid hanging if seeked never fires
              setTimeout(resolve, 2000);
            });
          }

          if (signal.aborted || epoch !== mediaEpochRef.current) return;

          if (mode === 'video') {
            const clipResult = await recordVideoClip({
              mediaUrl: mediaUrl!,
              start: currentRange[0],
              end: currentRange[1],
              signal,
            });
            if (signal.aborted || epoch !== mediaEpochRef.current) return;
            if (clipResult.ok) {
              const newUrl = URL.createObjectURL(clipResult.blob);
              mediaBlobUrlRef.current = newUrl;
              mediaBlobRef.current = clipResult.blob;
              capturedMediaTypeRef.current = 'video';
              setMediaPreviewType('video');
              setMediaPreviewUrl(newUrl);
              miningScreenshotBlobRef.current = clipResult.blob;
              replaceMiningScreenshotUrl(newUrl);
            } else {
              // Fallback to JPEG on video failure
              setMediaUnsupported(clipResult.error.message);
              if (videoEl) {
                videoEl.currentTime = currentRange[0];
                await new Promise<void>((resolve) => {
                  if (!videoEl) {
                    resolve();
                    return;
                  }
                  const onSeeked = () => {
                    videoEl.removeEventListener('seeked', onSeeked);
                    resolve();
                  };
                  videoEl.addEventListener('seeked', onSeeked);
                  setTimeout(resolve, 2000);
                });
              }
              if (signal.aborted || epoch !== mediaEpochRef.current) return;
              const fallback = videoEl
                ? await captureVideoFrame(videoEl)
                : null;
              if (signal.aborted || epoch !== mediaEpochRef.current) return;
              if (fallback && fallback.ok) {
                const imgUrl = URL.createObjectURL(fallback.blob);
                mediaBlobUrlRef.current = imgUrl;
                mediaBlobRef.current = fallback.blob;
                capturedMediaTypeRef.current = 'image';
                setMediaPreviewType('image');
                setMediaPreviewUrl(imgUrl);
                miningScreenshotBlobRef.current = fallback.blob;
                replaceMiningScreenshotUrl(imgUrl);
              }
            }
          } else if (videoEl) {
            // Image mode: capture JPEG at range start
            const result = await captureVideoFrame(videoEl);
            if (signal.aborted || epoch !== mediaEpochRef.current) return;
            if (result.ok) {
              const imgUrl = URL.createObjectURL(result.blob);
              mediaBlobUrlRef.current = imgUrl;
              mediaBlobRef.current = result.blob;
              capturedMediaTypeRef.current = 'image';
              setMediaPreviewType('image');
              setMediaPreviewUrl(imgUrl);
              miningScreenshotBlobRef.current = result.blob;
              replaceMiningScreenshotUrl(imgUrl);
            }
          }
        } finally {
          // Restore visible player time/pause state
          if (videoEl) {
            videoEl.currentTime = savedTime;
            if (savedPaused) videoEl.pause();
          }
          if (epoch === mediaEpochRef.current) {
            setIsMediaRecapturing(false);
            mediaRecaptureAbortRef.current = null;
          }
        }
      };
      void run();
    },
    [
      mediaMode,
      miningRangeStart,
      miningRangeEnd,
      replaceMiningScreenshotUrl,
      mediaUrl,
    ],
  );

  /** Determine if export is possible and the localized disabled reason. */
  const exportDisabledReason = useMemo(() => {
    const d = dictRef.current.playerUI;
    if (isExporting) return d.exportSendDisabledRequestActive;
    if (!ankiSession) return d.exportSendDisabledNoConnection;
    const prefs = readAnkiMinerPreferences();
    if (!prefs.deck || !prefs.noteType || !prefs.fields.sentence) {
      return d.exportSendDisabledInvalidPreset;
    }
    const sentenceField = miningDraftFields.find((f) => f.key === 'sentence');
    if (!sentenceField || sentenceField.value.trim().length === 0) {
      return d.exportSendDisabledNoSentence;
    }
    return null;
  }, [isExporting, ankiSession, miningDraftFields]);

  const canExport =
    exportDisabledReason === null && !isMiningCapturing && !isMiningRefreshing;

  /** AM-6c: Disabled reason for append Send button (selectedIds checked in MiningPreviewDialog). */
  const appendSendDisabledReason = useMemo(() => {
    const d = dictRef.current.playerUI;
    if (isAppending) return d.exportSendDisabledRequestActive;
    if (!ankiSession) return d.exportSendDisabledNoConnection;
    const prefs = readAnkiMinerPreferences();
    if (!prefs.noteType || !prefs.fields.sentence) {
      return d.exportSendDisabledInvalidPreset;
    }
    return null;
  }, [isAppending, ankiSession]);

  /** Mining History: write only after a successful Anki mutation. */
  const writeHistory = useCallback(async () => {
    try {
      const sentence = miningDraftFields.find(
        (f) => f.key === 'sentence',
      )?.value;

      // Transitional: keep old mining-history write as side-effect.
      // Fire-and-forget: its success no longer controls the visible History panel
      // because the panel now reads from the tracker mining_archive.
      void recordMiningHistory({
        filename: mediaName,
        rangeStart: miningRangeStart,
        rangeEnd: miningRangeEnd,
        sentence: sentence ?? '',
      });

      // Authoritative: write to tracker mining_archive.
      // The visible History panel reads from here, so refresh depends on this.
      const archiveWritten = await recordTrackerMiningArchive({
        mediaId: trackerRuntime.mediaId,
        subtitleId: trackerRuntime.subtitleId,
        learningSetId: trackerRuntime.learningSetId,
        displayName: mediaName,
        rangeStart: miningRangeStart,
        rangeEnd: miningRangeEnd,
        sentence: sentence ?? '',
      });
      if (archiveWritten) setHistoryRefreshKey((key) => key + 1);

      // Stage 2b: Increment mineCount on the cell covering the mined timestamp.
      // Uses the start of the mined range as the representative media time.
      // NOTE: recordMine is synchronous (in-memory cell mutation). It runs after
      // the archive write completes so the mine is recorded even if a flush
      // happens immediately after. The cell will be persisted on the next
      // lifecycle event (pause / visibility change / pagehide).
      trackerRuntime.recordMine(miningRangeStart);
    } catch {
      // IndexedDB failures must never alter an already successful Anki mutation.
    }
  }, [
    mediaName,
    miningDraftFields,
    miningRangeEnd,
    miningRangeStart,
    trackerRuntime.mediaId,
    trackerRuntime.subtitleId,
    trackerRuntime.learningSetId,
    trackerRuntime.recordMine,
  ]);

  /** Stage 2 AM-6a: Send new note to Anki. */
  const handleExportSend = useCallback(async () => {
    const d = dictRef.current.playerUI;
    if (!ankiSession || isExporting) return;
    if (exportDisabledReason) return;

    const prefs = readAnkiMinerPreferences();
    if (!prefs.deck || !prefs.noteType || !prefs.fields.sentence) return;
    // Top-level space-separated tags → string[] for the new note payload.
    // addTags is deliberately NOT called on the new-note path: the tags
    // array is written by the note itself.
    const exportTags = parseAnkiTags(prefs.tags ?? '');

    const epoch = exportEpochRef.current + 1;
    exportEpochRef.current = epoch;
    setIsExporting(true);
    setExportError(null);
    setExportSuccess(false);

    const abortController = new AbortController();
    exportAbortControllerRef.current = abortController;

    const client = new AnkiExportClient(
      ankiSession.endpoint,
      ankiSession.apiKey || undefined,
    );

    try {
      if (exportMode === 'new') {
        // Build note fields from draft
        const noteFields: Record<string, string> = {};
        const seen = new Set<string>();
        const isDenChou = prefs.noteType === 'DenChou';
        for (const f of miningDraftFields) {
          if (f.key === 'image' || f.key === 'audio') continue;
          if (seen.has(f.physicalName)) continue;
          seen.add(f.physicalName);
          // DenChou: auto-wrap sentence/source in <span class="group">
          noteFields[f.physicalName] = isDenChou
            ? wrapDenChouField(f.key, f.value)
            : f.value;
        }

        // canAddNotes check — new card allows duplicates within the target deck
        const noteOptions = {
          allowDuplicate: true,
          duplicateScope: 'deck' as const,
          duplicateScopeOptions: {
            deckName: prefs.deck,
            checkChildren: false,
          },
        };
        const canAddResult = await client.canAddNotes(
          [
            {
              deckName: prefs.deck,
              modelName: prefs.noteType,
              fields: noteFields,
              tags: exportTags,
              options: noteOptions,
            },
          ],
          abortController.signal,
        );

        if (!mountedRef.current || exportEpochRef.current !== epoch) return;
        if (abortController.signal.aborted) return;

        if (!canAddResult[0]) {
          setExportError(d.exportRejectedCanAdd);
          return;
        }

        // Upload media (screenshot/video) if mapped — branch on captured blob type
        const fieldMapping = prefs.fields;
        if (fieldMapping.image && miningScreenshotBlobRef.current) {
          const isVideo = capturedMediaTypeRef.current === 'video';
          const filename = generateMediaFilename(
            isVideo ? 'entei_video' : 'entei_screenshot',
            isVideo ? 'webm' : 'jpg',
          );
          const base64 = await blobToBase64(miningScreenshotBlobRef.current);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          await client.storeMediaFile(filename, base64, abortController.signal);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          if (fieldMapping.image && !noteFields[fieldMapping.image]) {
            noteFields[fieldMapping.image] = isVideo
              ? `<video autoplay loop muted playsinline src="${filename}"></video>`
              : `<img src="${filename}">`;
          }
        }

        if (fieldMapping.audio && miningAudioBlobRef.current) {
          const filename = generateMediaFilename('entei_audio', 'webm');
          const base64 = await blobToBase64(miningAudioBlobRef.current);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          await client.storeMediaFile(filename, base64, abortController.signal);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          if (fieldMapping.audio && !noteFields[fieldMapping.audio]) {
            noteFields[fieldMapping.audio] = `[sound:${filename}]`;
          }
        }

        if (!mountedRef.current || exportEpochRef.current !== epoch) return;
        if (abortController.signal.aborted) return;

        // addNote — includes duplicate-allowing options for new card
        const noteId = await client.addNote(
          {
            deckName: prefs.deck,
            modelName: prefs.noteType,
            fields: noteFields,
            tags: exportTags,
            options: noteOptions,
          },
          abortController.signal,
        );

        if (!mountedRef.current || exportEpochRef.current !== epoch) return;

        if (typeof noteId !== 'number' || noteId <= 0) {
          setExportError(d.exportError);
          return;
        }

        setExportSuccess(true);
        // Fire-and-forget: IndexedDB write must never block/fail Anki success
        void writeHistory();
      } else if (exportMode === 'update') {
        // One-click update: findNotes → notesInfo → validate → media → updateNoteFields
        const noteIds = await client.findNotes(
          'added:1',
          abortController.signal,
        );
        if (!mountedRef.current || exportEpochRef.current !== epoch) return;
        if (abortController.signal.aborted) return;

        if (!noteIds || noteIds.length === 0) {
          setExportError(d.exportNoCandidate);
          return;
        }

        const maxId = Math.max(...noteIds);
        const info = await client.notesInfo([maxId], abortController.signal);
        if (!mountedRef.current || exportEpochRef.current !== epoch) return;
        if (abortController.signal.aborted) return;

        if (!info || info.length === 0) {
          setExportError(d.exportNoCandidate);
          return;
        }

        const candidate = info[0];
        if (!candidate) {
          setExportError(d.exportNoCandidate);
          return;
        }

        // Validate target model matches saved note type
        if (candidate.modelName !== prefs.noteType) {
          setExportError(d.exportError);
          return;
        }

        // Build update fields from draft (text fields only)
        const updateFields: Record<string, string> = {};
        const seen = new Set<string>();
        for (const f of miningDraftFields) {
          if (f.key === 'image' || f.key === 'audio') continue;
          if (seen.has(f.physicalName)) continue;
          seen.add(f.physicalName);
          updateFields[f.physicalName] = f.value;
        }

        // Upload media if available (never wipe existing) — branch on captured type
        if (prefs.fields.image && miningScreenshotBlobRef.current) {
          const isVideo = capturedMediaTypeRef.current === 'video';
          const filename = generateMediaFilename(
            isVideo ? 'entei_video' : 'entei_screenshot',
            isVideo ? 'webm' : 'jpg',
          );
          const base64 = await blobToBase64(miningScreenshotBlobRef.current);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          await client.storeMediaFile(filename, base64, abortController.signal);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          if (prefs.fields.image) {
            updateFields[prefs.fields.image] = isVideo
              ? `<video autoplay loop muted playsinline src="${filename}"></video>`
              : `<img src="${filename}">`;
          }
        }

        if (prefs.fields.audio && miningAudioBlobRef.current) {
          const filename = generateMediaFilename('entei_audio', 'webm');
          const base64 = await blobToBase64(miningAudioBlobRef.current);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          await client.storeMediaFile(filename, base64, abortController.signal);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          if (prefs.fields.audio) {
            updateFields[prefs.fields.audio] = `[sound:${filename}]`;
          }
        }

        if (!mountedRef.current || exportEpochRef.current !== epoch) return;
        if (abortController.signal.aborted) return;

        // ASB parity (anki.ts: updateNoteFields → await addTags): a tag
        // failure propagates → whole export fails (outer catch → no
        // success toast, no history).
        await updateNoteFieldsAndAddTags(
          client,
          candidate.noteId,
          updateFields,
          prefs.tags ?? '',
          abortController.signal,
        );

        if (!mountedRef.current || exportEpochRef.current !== epoch) return;

        setExportSuccess(true);
        // Fire-and-forget: IndexedDB write must never block/fail Anki success
        void writeHistory();
      }
    } catch (e) {
      if (!mountedRef.current || exportEpochRef.current !== epoch) return;
      if (e instanceof DOMException && e.name === 'AbortError') {
        // Aborted — don't set error
        return;
      }
      setExportError(d.exportError);
    } finally {
      if (mountedRef.current && exportEpochRef.current === epoch) {
        setIsExporting(false);
      }
      // Restore player to snapshot time/pause after export
      const media = sharedMediaRef.current;
      if (media) {
        media.currentTime = miningSnapshotTimeRef.current;
        media.pause();
      }
    }
  }, [
    ankiSession,
    isExporting,
    exportDisabledReason,
    exportMode,
    miningDraftFields,
    writeHistory,
  ]);

  // --- AM-6c: Append-to-specific handlers ---
  const handleAppendSearch = useCallback(
    async (query: string) => {
      if (!ankiSession) throw new Error('No session');
      const client = new AnkiExportClient(
        ankiSession.endpoint,
        ankiSession.apiKey || undefined,
      );
      const noteIds = await client.findNotes(query);
      const bounded = noteIds
        .filter((id) => id > 0)
        .sort((a, b) => b - a)
        .slice(0, 100);
      if (bounded.length === 0) return [];
      return client.notesInfo(bounded);
    },
    [ankiSession],
  );

  /** AM-6c: Batch-fetch deck names for card IDs via cardsInfo. */
  const handleFetchDeckNames = useCallback(
    async (
      cardIds: number[],
      signal?: AbortSignal,
    ): Promise<Map<number, string>> => {
      if (!ankiSession || cardIds.length === 0) return new Map();
      const client = new AnkiExportClient(
        ankiSession.endpoint,
        ankiSession.apiKey || undefined,
      );
      const cards = await client.cardsInfo(cardIds, signal);
      const map = new Map<number, string>();
      for (const card of cards) {
        map.set(card.cardId, card.deckName);
      }
      return map;
    },
    [ankiSession],
  );

  const handleAppend = useCallback(
    async (selectedIds: number[]) => {
      if (!ankiSession || isAppending || selectedIds.length === 0) {
        return { succeeded: [] as number[], failed: [] as number[] };
      }

      const prefs = readAnkiMinerPreferences();
      if (!prefs.noteType || !prefs.fields.sentence) {
        return { succeeded: [] as number[], failed: selectedIds };
      }
      // Top-level tags: one trimmed text per operation; applied additively
      // after the field update (or alone when no fields changed).
      const tagsText = (prefs.tags ?? '').trim();

      const epoch = appendEpochRef.current + 1;
      appendEpochRef.current = epoch;
      setIsAppending(true);
      setAppendResult(null);

      const abortController = new AbortController();
      appendAbortControllerRef.current = abortController;

      const client = new AnkiExportClient(
        ankiSession.endpoint,
        ankiSession.apiKey || undefined,
      );

      const succeeded: number[] = [];
      const failed: number[] = [];
      let validNotes: Awaited<ReturnType<AnkiExportClient['notesInfo']>> = [];

      try {
        // Re-fetch and revalidate selected notes
        const refreshed = await client.notesInfo(
          selectedIds,
          abortController.signal,
        );
        if (!mountedRef.current || appendEpochRef.current !== epoch)
          return { succeeded, failed };
        if (abortController.signal.aborted) return { succeeded, failed };

        validNotes = refreshed.filter(
          (n) => n.noteId > 0 && n.modelName === prefs.noteType,
        );
        const validIds = new Set(validNotes.map((n) => n.noteId));
        for (const id of selectedIds) {
          if (!validIds.has(id)) failed.push(id);
        }

        if (validNotes.length === 0) {
          return { succeeded, failed };
        }

        // Upload media once per operation, then reuse markup
        let imageMarkup: string | null = null;
        let audioMarkup: string | null = null;

        if (prefs.fields.image && miningScreenshotBlobRef.current) {
          const isVideo = capturedMediaTypeRef.current === 'video';
          const filename = generateMediaFilename(
            isVideo ? 'entei_video' : 'entei_screenshot',
            isVideo ? 'webm' : 'jpg',
          );
          const base64 = await blobToBase64(miningScreenshotBlobRef.current);
          if (!mountedRef.current || appendEpochRef.current !== epoch)
            return { succeeded, failed };
          if (abortController.signal.aborted) return { succeeded, failed };
          await client.storeMediaFile(filename, base64, abortController.signal);
          if (!mountedRef.current || appendEpochRef.current !== epoch)
            return { succeeded, failed };
          imageMarkup = isVideo
            ? `<video autoplay loop muted playsinline src="${filename}"></video>`
            : `<img src="${filename}">`;
        }

        if (prefs.fields.audio && miningAudioBlobRef.current) {
          const filename = generateMediaFilename('entei_audio', 'webm');
          const base64 = await blobToBase64(miningAudioBlobRef.current);
          if (!mountedRef.current || appendEpochRef.current !== epoch)
            return { succeeded, failed };
          if (abortController.signal.aborted) return { succeeded, failed };
          await client.storeMediaFile(filename, base64, abortController.signal);
          if (!mountedRef.current || appendEpochRef.current !== epoch)
            return { succeeded, failed };
          audioMarkup = `[sound:${filename}]`;
        }

        // For each valid note, append mapped fields
        for (const note of validNotes) {
          if (!mountedRef.current || appendEpochRef.current !== epoch) break;
          if (abortController.signal.aborted) break;

          const updates: Record<string, string> = {};

          for (const draft of miningDraftFields) {
            if (draft.key === 'image' || draft.key === 'audio') continue;
            const fieldName = draft.physicalName;
            const existing = note.fields[fieldName]?.value ?? '';
            let incoming = draft.value;
            if (!incoming) continue;
            // DenChou: wrap incoming with scene HTML
            const isDenChou = prefs.noteType === 'DenChou';
            const skipBr = isDenChou && isDenChouActiveTarget(draft.key);
            if (isDenChou) {
              incoming = wrapDenChouField(draft.key, incoming);
            }
            if (skipBr) {
              // DenChou sentence/source: no <br> (scene groups own layout)
              updates[fieldName] = existing
                ? `${existing}${incoming}`
                : incoming;
            } else {
              // All other cases: <br> separator
              updates[fieldName] = existing
                ? `${existing}<br>${incoming}`
                : incoming;
            }
          }

          // Append image markup if available — always use <br> (not a wrapper target)
          if (prefs.fields.image && imageMarkup) {
            const existing = note.fields[prefs.fields.image]?.value ?? '';
            updates[prefs.fields.image] = existing
              ? `${existing}<br>${imageMarkup}`
              : imageMarkup;
          }

          // Append audio markup if available — always use <br> (not a wrapper target)
          if (prefs.fields.audio && audioMarkup) {
            const existing = note.fields[prefs.fields.audio]?.value ?? '';
            updates[prefs.fields.audio] = existing
              ? `${existing}<br>${audioMarkup}`
              : audioMarkup;
          }

          if (Object.keys(updates).length === 0) {
            // No fields to append — tags-only note. ASB parity: success
            // depends on the addTags call; an addTags-only helper keeps
            // empty tags a zero-API no-op while preserving success.
            try {
              // ASB parity — additive tags, failure → note failed.
              await addTagsOnlyIfAny(
                client,
                note.noteId,
                tagsText,
                abortController.signal,
              );
              if (
                mountedRef.current &&
                appendEpochRef.current === epoch &&
                !abortController.signal.aborted
              ) {
                succeeded.push(note.noteId);
              }
            } catch {
              if (
                mountedRef.current &&
                appendEpochRef.current === epoch &&
                !abortController.signal.aborted
              ) {
                failed.push(note.noteId);
              }
            }
            continue;
          }

          try {
            // ASB parity (anki.ts): updateNoteFields → await addTags;
            // an addTags failure marks the note failed — no partial
            // success state is tracked, and the same append is never
            // auto-retried (fields may already have been updated).
            await updateNoteFieldsAndAddTags(
              client,
              note.noteId,
              updates,
              tagsText,
              abortController.signal,
            );
            if (
              mountedRef.current &&
              appendEpochRef.current === epoch &&
              !abortController.signal.aborted
            ) {
              succeeded.push(note.noteId);
            }
          } catch {
            if (
              mountedRef.current &&
              appendEpochRef.current === epoch &&
              !abortController.signal.aborted
            ) {
              failed.push(note.noteId);
            }
          }
        }
      } catch {
        // All remaining valid notes are considered failed
        for (const note of validNotes ?? []) {
          if (
            !succeeded.includes(note.noteId) &&
            !failed.includes(note.noteId)
          ) {
            failed.push(note.noteId);
          }
        }
      } finally {
        if (mountedRef.current && appendEpochRef.current === epoch) {
          setIsAppending(false);
          setAppendResult({ succeeded, failed });
          // Fire-and-forget: IndexedDB write must never block/fail Anki success
          if (succeeded.length > 0) {
            void writeHistory();
          }
        }
        appendAbortControllerRef.current = null;
      }

      return { succeeded, failed };
    },
    [ankiSession, isAppending, miningDraftFields, writeHistory],
  );

  // --- P1.1: Surface click behavior ---
  const handleSurfaceClick = useCallback(
    (e: React.MouseEvent) => {
      // Only handle clicks on the bare media area, not controls or overlay
      const target = e.target as HTMLElement;
      if (target.closest('.entei-controls-layer')) return;
      // P1.3a.1: Ignore overlay clicks — let Yomitan/content-script document
      // listeners and text selection work without interference.
      if (target.closest('[data-entei-subtitle-overlay]')) return;
      // Companion fix: gate on displayMediaUrl (jobSession.jobMediaUrl ??
      // mediaUrl), not the local mediaUrl — companion playback only sets
      // jobMediaUrl, so the local URL stays null and would make surface
      // clicks a no-op for every companion session.
      const media = sharedMediaRef.current;
      if (!media || isLoading || loadError || !displayMediaUrl) return;

      const currentVisible = controlsHandleRef.current?.getVisible() ?? true;
      const effect = surfaceClickEffect(isTouchDevice, currentVisible);

      // Apply visibility change
      if (effect.setVisibility === 'show') {
        controlsHandleRef.current?.show();
      } else if (effect.setVisibility === 'hide') {
        controlsHandleRef.current?.hide();
      }

      // Only toggle play on desktop — touch uses the Play/Pause button only
      if (effect.togglePlay) {
        if (media.paused) {
          media.play().catch(() => {});
        } else {
          media.pause();
        }
      }
    },
    [isLoading, loadError, displayMediaUrl, isTouchDevice],
  );

  // --- Keyboard shortcuts ---
  useKeyboardShortcuts({
    videoRef: sharedMediaRef,
    cues,
    activeCueId,
    playbackRate,
    setPlaybackRate: handlePlaybackRateChange,
    onCueClick: handleCueClick,
    enabled: true,
  });

  // --- Drag and drop ---
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        if (isSubtitleFile(file)) {
          handleSubtitleSelect(file);
        } else if (isVideoFile(file) || isAudioFile(file)) {
          handleMediaSelect(file);
        }
      }
    },
    [handleMediaSelect, handleSubtitleSelect],
  );

  const dict = dictRef.current.playerUI;
  const hasMedia = displayMediaUrl !== null;
  const ankiPrefs = readAnkiMinerPreferences();

  // --- Desktop immersive layout ---
  // When media is loaded on desktop (≥1024px), apply immersive class to <html>
  // to hide TopBar/SiteFooter and make the player fill 100dvh.
  useEffect(() => {
    if (!hasMedia) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = (matches: boolean) => {
      document.documentElement.classList.toggle(
        'entei-player-immersive',
        matches,
      );
    };
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
      document.documentElement.classList.remove('entei-player-immersive');
    };
  }, [hasMedia]);

  // --- Layout class ---
  const layoutClass = `entei-player-layout${isSubtitlePanelVisible ? ' entei-player-layout--with-panel' : ' entei-player-layout--no-panel'}`;

  // --- Shared media area content (extracted to avoid duplication) ---
  const mediaArea = (
    <div
      ref={surfaceRef}
      className="entei-player-surface"
      onClick={handleSurfaceClick}
    >
      {displayMediaType === 'video' && (
        <VideoPlayer
          ref={videoCallbackRef}
          src={displayMediaUrl!}
          isLoading={isLoading}
          error={loadError}
          // ED-2H: keep the video element mounted while an active
          // companion session has an uncleared loadError (e.g. the initial
          // 503 during buffering). The condition keys on loadError, NOT on
          // the bridge phase: the bridge's recovery transition
          // (buffering → ready) re-renders React, and a phase-based
          // condition would unmount the element right before the bridge's
          // explicit src/load — the loadeddata that clears loadError (via
          // handleLoaded) then never fires and "Aliran belum siap" sticks.
          // loadError is cleared by loadeddata, so the condition flips
          // back to false automatically once playback resumes. Outside an
          // active session the element unmounts on error exactly as before.
          keepElementOnError={jobSession.active && loadError !== null}
          errorLabel={jobSession.active && jobSession.phase !== 'error' ? dict.companionStreamNotReady : dict.failedToLoadVideo}
          decodeErrorLabel={dict.videoDecodeError}
          onTimeUpdate={handleTimeUpdate}
          onPlay={handlePlay}
          onPause={handlePause}
          onLoaded={handleLoaded}
          onError={handleError}
        />
      )}
      {displayMediaType === 'audio' && (
        <div className="entei-player-audio-area">
          <div className="entei-player-audio-visual">
            <div className="entei-player-audio-icon">
              <Music size={64} />
            </div>
            <p className="entei-player-audio-name">{mediaName}</p>
          </div>
          <audio
            ref={audioCallbackRef}
            src={mediaUrl!}
            onTimeUpdate={(e) => handleTimeUpdate(e.currentTarget.currentTime)}
            onPlay={handlePlay}
            onPause={handlePause}
            onLoadedData={handleLoaded}
            onError={(e) => {
              const mediaError = e.currentTarget.error;
              const classified = classifyMediaError(mediaError, 'audio');
              if (classified?.kind === 'decode')
                handleError(dict.audioDecodeError);
              else handleError(dict.failedToLoadAudio);
            }}
            preload="metadata"
          />
          {isLoading && (
            <div className="entei-player-loading-overlay entei-player-audio-loading">
              <div className="entei-player-skeleton entei-player-skeleton--audio" />
            </div>
          )}
        </div>
      )}
      <SubtitleOverlay
        cues={cues}
        activeCueId={activeCueId}
        displayMode={captionDisplayMode}
        isRevealed={isOverlayRevealed}
        onPointerEnter={handleOverlayPointerEnter}
        onPointerLeave={handleOverlayPointerLeave}
        onTouchTap={handleOverlayTouchTap}
        appearance={subtitleSettings}
      />
      {/* Seek buffering overlay: shows a spinner after a seek when the
          video element's readyState is below HAVE_FUTURE_DATA. Clears
          when canplay fires (data arrived) or on error/timeout.
          Separate from the companion loading overlay above. */}
      {isSeekBuffering && !isLoading && !loadError && (
        <div className="entei-companion-loading" role="status" aria-label="Loading">
          <TypewriterLoading aria-hidden="true" />
        </div>
      )}
      {/* Companion start buffering overlay: the job media URL surfaced
          but the .part has not yielded playable data yet (readyState
          below HAVE_FUTURE_DATA / 'waiting' for over 1 s). Shows the
          same "preparing video" copy as the pre-URL loading overlay, at
          a larger size so the waiting-for-playback state is readable on
          phones; clears on canplay / error / 15 s safety bound.
          Mutually exclusive with the seek-buffering overlay: when both
          are true only the seek one renders, so the surface never shows
          two stacked loaders. */}
      {isStartBuffering &&
        !isSeekBuffering &&
        !isLoading &&
        !loadError &&
        jobSession.phase !== 'error' &&
        // Pairing 復旧中はオーバーレイを出さない（前フレームを維持し、
        // 再ペアリング UI が最前面で操作できるようにする意図）。
        jobSession.phase !== 'rePairRequired' && (
          <div className="entei-companion-loading entei-start-buffering" role="status" aria-label="Loading">
            <TypewriterLoading aria-hidden="true" className="entei-typewriter--start" />
            <p className="entei-companion-loading-text entei-companion-loading-text--start">
              {dict.companionPreparingVideo}
            </p>
          </div>
        )}
      <PlayerControls
        ref={controlsHandleRef}
        mediaRef={sharedMediaRef}
        surfaceRef={surfaceRef}
        isPlaying={isPlaying}
        isLoading={isLoading}
        error={loadError}
        hasMedia={hasMedia}
        mediaType={displayMediaType}
        mediaKey={displayMediaUrl!}
        mediaName={mediaName}
        dict={dict}
        isSubtitlePanelVisible={isSubtitlePanelVisible}
        onToggleSubtitlePanel={() => {
          setIsSubtitlePanelVisible((v) => {
            const next = !v;
            if (next) {
              // Re-read layout from storage when showing panel
              setPanelLayout(readPanelLayout());
              setPanelLayoutKey((k) => k + 1);
            }
            return next;
          });
        }}
        captionDisplayMode={captionDisplayMode}
        onCycleCaptionMode={handleCycleCaptionMode}
        volume={volume}
        onVolumeChange={handleVolumeChange}
        playbackRate={playbackRate}
        onPlaybackRateChange={handlePlaybackRateChange}
        playMode={playMode}
        onPlayModeChange={handlePlayModeChange}
        isTouchDevice={isTouchDevice}
        isMobileViewport={isMobileViewport}
        reducedMotion={reducedMotion}
        onMine={handleMine}
        canMine={canMine}
        isMining={isMining}
        onFileOpen={handleFileOpen}
        fileAccept={`${MEDIA_ACCEPT},${SUBTITLE_ACCEPT}`}
        fileOpenLabel={dict.fileOpenLabel}
        clampSeekTime={jobSession.active ? clampSeekTime : undefined}
      />
      <ScreenshotPreviewDialog
        open={isScreenshotDialogOpen}
        onOpenChange={handleScreenshotDialogClose}
        imageUrl={screenshotPreviewUrl}
        error={hasScreenshotError}
        onRetry={handleScreenshot}
        onClose={handleScreenshotDialogClose}
        isCapturing={isCapturing}
        dict={dict}
      />
      <AudioClipPreviewDialog
        open={isAudioClipDialogOpen}
        onOpenChange={handleAudioClipDialogClose}
        audioUrl={audioClipUrl}
        expectedDuration={audioClipExpectedDuration}
        error={hasAudioClipError}
        onRetry={handleAudioClip}
        onClose={handleAudioClipDialogClose}
        isRecording={isRecordingAudio}
        dict={dict}
      />
      <SubtitleSyncDialog
        open={isSubtitleSyncDialogOpen}
        onOpenChange={setIsSubtitleSyncDialogOpen}
        dict={dict}
        token={jobSession.token ?? ''}
        onComplete={handleAudioSyncComplete}
      />
      <MiningPreviewDialog
        open={isMiningPreviewOpen}
        onOpenChange={handleMiningPreviewClose}
        draftFields={miningDraftFields}
        onDraftFieldChange={handleDraftFieldChange}
        screenshotUrl={miningScreenshotUrl}
        hasScreenshotError={miningHasScreenshotError}
        isScreenshotUnavailable={mediaType !== 'video'}
        audioUrl={miningAudioUrl}
        audioExpectedDuration={miningAudioExpectedDuration}
        hasAudioError={miningHasAudioError}
        rangeStart={miningRangeStart}
        rangeEnd={miningRangeEnd}
        mediaDuration={miningMediaDuration}
        cues={cues}
        isCapturing={isMiningCapturing}
        isRefreshing={isMiningRefreshing}
        canRefresh={canRefresh}
        onRangeChange={handleMiningRangeChange}
        onRangeCommit={handleRangeCommit}
        onCancel={handleMiningPreviewClose}
        dict={dict}
        exportMode={exportMode}
        onExportModeChange={handleExportModeChange}
        isExporting={isExporting}
        canExport={canExport}
        exportDisabledReason={exportDisabledReason}
        exportError={exportError}
        exportSuccess={exportSuccess}
        onExportSend={handleExportSend}
        onAppendSearch={handleAppendSearch}
        onAppend={handleAppend}
        isAppending={isAppending}
        appendResult={appendResult}
        appendSendDisabledReason={appendSendDisabledReason}
        savedDeck={ankiPrefs?.deck ?? ''}
        savedNoteType={ankiPrefs?.noteType ?? ''}
        sentenceFieldName={ankiPrefs?.fields.sentence ?? null}
        wordFieldName={ankiPrefs?.fields.word ?? null}
        onFetchDeckNames={handleFetchDeckNames}
        mediaMode={mediaMode}
        onMediaModeChange={handleMediaModeChange}
        mediaPreviewUrl={mediaPreviewUrl}
        mediaPreviewType={mediaPreviewType}
        mediaUnsupported={mediaUnsupported}
        isMediaRecapturing={isMediaRecapturing}
      />
    </div>
  );

  // --- Errors block (shared between desktop/mobile) ---
  // Per user request (2026-08-14): subtitle parse warnings are intentionally
  // NOT shown — they clutter the player frame. The parsing logic and state
  // (subtitleErrors / setSubtitleErrors) stay intact for future use; only the
  // display is suppressed.
  void subtitleErrors; // keep state read (future re-enable of the block)
  const subtitleErrorsBlock = null;

  const lowerMediaName = mediaName.toLowerCase();
  const hideSyncSubtitle =
    jobSession.kind === 'youtube' ||
    !isMagnet ||
    !(lowerMediaName.endsWith('.mkv') || lowerMediaName.endsWith('.mp4'));

  return (
    <div
      ref={mediaContainerRef}
      className="entei-player-container"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      data-entei-player-root=""
    >
      {/* --- Empty state --- */}
      {!hasMedia && !jobSession.active && (
        <div className="entei-player-empty">
          <div className="entei-player-empty-cta">
              <div className="entei-player-empty-inner">
                <h2 className="entei-player-empty-title">
                  {dict.selectMediaTitle}
                </h2>
                <p className="entei-player-empty-desc">{dict.selectMediaDesc}</p>
                <div className="entei-player-pickers">
                  <MediaPicker
                    onSelect={handleMediaSelect}
                    accept={MEDIA_ACCEPT}
                    label={dict.chooseMedia}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    type="button"
                    className="entei-player-magnet-icon-btn"
                    onClick={() => setIsMagnetDialogOpen(true)}
                    aria-label={dict.magnetInputLabel}
                    title={dict.magnetInputLabel}
                  >
                    <Magnet />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    type="button"
                    className="entei-player-youtube-icon-btn"
                    onClick={() => setIsYouTubeDialogOpen(true)}
                    aria-label={dict.youtubeInputLabel}
                    title={dict.youtubeInputLabel}
                  >
                    <YouTubeMark />
                  </Button>
                </div>
            </div>
          </div>
          {/* ED-3: EizouDendenshi setup section — pairing state only; the
              local-file player flow above is untouched by it. The pairing
              is persistent: the opaque token survives reloads and
              companion restarts (re-validated on mount via the status
              endpoint) until the user explicitly resets it from the
              EizouDen settings tab (EizouDenSettingsTab). */}
          <EizouDendenshiSetup
            isConnected={pairing.connected}
            isValidating={pairing.validating}
            onPairSuccess={pairing.handlePairSuccess}
            dict={{
              eizouSetupLabel: dict.eizouSetupLabel,
              eizouSetupTitle: dict.eizouSetupTitle,
              eizouSetupImageAlt: dict.eizouSetupImageAlt,
              eizouConnected: dict.eizouConnected,
              eizouDisconnected: dict.eizouDisconnected,
              eizouChecking: dict.eizouChecking,
              eizouPairingTitle: dict.eizouPairingTitle,
              eizouPairingOtpLabel: dict.eizouPairingOtpLabel,
              eizouPairingOtpInvalid: dict.eizouPairingOtpInvalid,
              eizouPairingSubmit: dict.eizouPairingSubmit,
              eizouPairingConnecting: dict.eizouPairingConnecting,
              eizouPairingErrorNetwork: dict.eizouPairingErrorNetwork,
              eizouPairingErrorInvalidCode: dict.eizouPairingErrorInvalidCode,
              eizouPairingErrorGeneric: dict.eizouPairingErrorGeneric,
              dialogClose: dict.dialogClose,
            }}
          />
        </div>
      )}

      {/* --- Companion job error fallback --- */}
      {/* While the companion job has failed (phase='error'), the loading
          overlays above are suppressed; without this block the player
          area would be a full black void. Show a calm, centered failure
          message instead of a spinner (2026-08-09: second-URL job error
          left a black player frame). New URL / local file entry points
          remain accessible via the dialogs and pickers. */}
      {jobSession.active && jobSession.phase === 'error' && (
        <div
          className="entei-player-job-error"
          role="alert"
          aria-label={dict.companionJobFailed}
        >
          <AlertTriangle
            size={28}
            aria-hidden="true"
            className="entei-player-job-error-icon"
          />
          <p className="entei-player-job-error-text">{dict.companionJobFailed}</p>
        </div>
      )}

      {/* --- Companion loading overlay --- */}
      {jobSession.active &&
        !jobSession.jobMediaUrl &&
        jobSession.phase !== 'error' &&
        jobSession.phase !== 'rePairRequired' && (
          <div
            className="entei-companion-loading"
            role="status"
            aria-label="Loading"
          >
            <TypewriterLoading aria-hidden="true" />
            <p className="entei-companion-loading-text">
              {dict.companionPreparingVideo}
            </p>
          </div>
        )}

      {/* ED-2G: Magnet source dialog — real companion torrent flow (pairing
           gate → create → poll → file selection → select). The
           selected video's sanitized basename travels with the job id. */}
      <MagnetInput
        open={isMagnetDialogOpen}
        onOpenChange={setIsMagnetDialogOpen}
        isPaired={pairing.connected}
        token={pairing.tokenRef.current}
        onJobAccepted={handleMagnetJobAccepted}
        dict={{
          magnetInputLabel: dict.magnetInputLabel,
          magnetInputPlaceholder: dict.magnetInputPlaceholder,
          magnetInputLabelTitle: dict.magnetInputLabelTitle,
          magnetErrorInvalid: dict.magnetErrorInvalid,
          magnetInputSubmit: dict.magnetInputSubmit,
          magnetInputUnpairedBody: dict.magnetInputUnpairedBody,
          magnetConsentLabel: dict.magnetConsentLabel,
          magnetInputErrorRepair: dict.magnetInputErrorRepair,
          magnetInputErrorConflict: dict.magnetInputErrorConflict,
          magnetInputErrorNetwork: dict.magnetInputErrorNetwork,
          magnetInputErrorGeneric: dict.magnetInputErrorGeneric,
          magnetInputErrorMetadataTimeout: dict.magnetInputErrorMetadataTimeout,
          magnetInputErrorEvicted: dict.magnetInputErrorEvicted,
          magnetInputErrorV2Unsupported: dict.magnetInputErrorV2Unsupported,
          magnetInputSubmitting: dict.magnetInputSubmitting,
          magnetCheckMetadata: dict.magnetCheckMetadata,
          magnetFilesTitle: dict.magnetFilesTitle,
          magnetFilesBody: dict.magnetFilesBody,
          magnetNoVideoError: dict.magnetNoVideoError,
          magnetSelectSubmit: dict.magnetSelectSubmit,
          magnetCancel: dict.magnetCancel,
          dialogClose: dict.dialogClose,
          magnetTableFileName: dict.magnetTableFileName,
          magnetTableSize: dict.magnetTableSize,
          magnetFileKindVideo: dict.magnetFileKindVideo,
          magnetFileKindSubtitle: dict.magnetFileKindSubtitle,
          magnetFileKindFolder: dict.magnetFileKindFolder,
          magnetFileKindOther: dict.magnetFileKindOther,
          magnetTableNavUp: dict.magnetTableNavUp,
          magnetNoVideosInFolder: dict.magnetNoVideosInFolder,
        }}
      />

      {/* ED-2F: YouTube source dialog — real URL input, job create on the
          paired companion; media switch / End button cancels the job. */}
      <YouTubeInput
        open={isYouTubeDialogOpen}
        onOpenChange={setIsYouTubeDialogOpen}
        isPaired={pairing.connected}
        token={pairing.tokenRef.current}
        onJobAccepted={handleYouTubeJobAccepted}
        cancelActiveJob={jobSession.cancelActiveJob}
        dict={{
          youtubeInputLabel: dict.youtubeInputLabel,
          youtubeInputTitle: dict.youtubeInputTitle,
          youtubeInputPlaceholder: dict.youtubeInputPlaceholder,
          youtubeInputSubmit: dict.youtubeInputSubmit,
          youtubeInputErrorInvalid: dict.youtubeInputErrorInvalid,
          youtubeInputErrorRepair: dict.youtubeInputErrorRepair,
          youtubeInputErrorConflict: dict.youtubeInputErrorConflict,
          youtubeInputErrorNetwork: dict.youtubeInputErrorNetwork,
          youtubeInputErrorGeneric: dict.youtubeInputErrorGeneric,
          youtubeInputSubmitting: dict.youtubeInputSubmitting,
          dialogClose: dict.dialogClose,
        }}
      />

      {/* --- Active state --- */}
      {hasMedia &&
      isDesktop &&
      !isLandscapeImmersive &&
      isSubtitlePanelVisible ? (
        <ResizablePanelGroup
          key={panelLayoutKey}
          id="entei-player-layout"
          orientation="horizontal"
          className="entei-resizable-group"
          defaultLayout={{
            'entei-main': panelLayout.mainPct,
            'entei-side': panelLayout.sidePct,
          }}
          onLayoutChanged={(layout, { isUserInteraction }) => {
            if (!isUserInteraction) return;
            const main = layout['entei-main'];
            const side = layout['entei-side'];
            if (typeof main === 'number' && typeof side === 'number') {
              const next = { mainPct: main, sidePct: side };
              setPanelLayout(next);
              writePanelLayout(next);
            }
          }}
        >
          <ResizablePanel
            id="entei-main"
            defaultSize={`${panelLayout.mainPct}%`}
            minSize="45%"
            className="entei-resizable-panel-main"
          >
            <div className="entei-player-layout entei-player-layout--no-panel">
              <div className="entei-player-media-area">{mediaArea}</div>
              {subtitleErrorsBlock}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle className="entei-resizable-handle" />
          <ResizablePanel
            id="entei-side"
            defaultSize={`${panelLayout.sidePct}%`}
            minSize="10%"
            maxSize="45%"
            className="entei-resizable-panel-side"
          >
            <RightPanel
              visible={isSubtitlePanelVisible}
              dict={dict}
              cues={cues}
              isLoadingSubtitles={isLoadingSubtitles}
              activeCueId={activeCueId}
              onCueClick={handleCueClick}
              onSubtitleSelect={handleSubtitleSelect}
              subtitleAccept={SUBTITLE_ACCEPT}
              onSyncSubtitle={handleSyncSubtitle}
              canSyncSubtitle={!!subtitleTextRef.current}
              isSyncingSubtitle={isSyncingSubtitle}
              syncMode={prefsRef.current.subtitleSyncMode ?? 'subtitle'}
              hideSyncSubtitle={hideSyncSubtitle}
              isMagnet={isMagnet}
              lazySyncOn={isLazySyncOn}
              onToggleLazySync={handleToggleLazySync}
              historyRefreshKey={historyRefreshKey}
              onMineCue={handleMine}
              canMineRow={canMineRow}
              isMining={isMining}
              trackerAccumulator={trackerRuntime.accumulator}
              onTrackerFlush={trackerRuntime.onFlush}
              trackerLearningSetId={trackerRuntime.learningSetId ?? undefined}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : hasMedia ? (
        <div className={layoutClass}>
          <div className="entei-player-media-area">{mediaArea}</div>
          {isSubtitlePanelVisible && (
            <RightPanel
              visible={isSubtitlePanelVisible}
              dict={dict}
              cues={cues}
              isLoadingSubtitles={isLoadingSubtitles}
              activeCueId={activeCueId}
              onCueClick={handleCueClick}
              onSubtitleSelect={handleSubtitleSelect}
              subtitleAccept={SUBTITLE_ACCEPT}
              onSyncSubtitle={handleSyncSubtitle}
              canSyncSubtitle={!!subtitleTextRef.current}
              isSyncingSubtitle={isSyncingSubtitle}
              syncMode={prefsRef.current.subtitleSyncMode ?? 'subtitle'}
              hideSyncSubtitle={hideSyncSubtitle}
              isMagnet={isMagnet}
              lazySyncOn={isLazySyncOn}
              onToggleLazySync={handleToggleLazySync}
              historyRefreshKey={historyRefreshKey}
              onMineCue={handleMine}
              canMineRow={canMineRow}
              isMining={isMining}
              trackerAccumulator={trackerRuntime.accumulator}
              onTrackerFlush={trackerRuntime.onFlush}
              trackerLearningSetId={trackerRuntime.learningSetId ?? undefined}
            />
          )}
          {subtitleErrorsBlock}
        </div>
      ) : null}
    </div>
  );
}
