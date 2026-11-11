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

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { usePanelRef } from 'react-resizable-panels';
import {
  type SubtitleCue,
  findActiveCue,
} from '@/features/player/subtitle-reader';
import { syncSubtitleToAudio, syncSubtitleToReference } from '@/features/player/subtitle-sync';
import { decodeToMono16k } from '@/features/player/audio-decoder';
import {
  createMediaUrl,
  revokeUrl,
  MEDIA_ACCEPT,
  SUBTITLE_ACCEPT,
  classifyMediaFile,
  classifyMediaName,
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
import { useModuleState } from '@/features/modules/use-module-state';
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
import { JimakuSearchDialog } from '@/components/player/JimakuSearchDialog';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/player/ui/resizable';
import { recordMiningHistory } from '@/features/player/mining-history';
import {
  computeVideoFingerprint,
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
import type { DirectTorrentHandoff } from '@/components/player/MagnetInput';
import { MagnetInput } from '@/components/player/MagnetInput';
import { useTorrentSession } from '@/features/player/use-torrent-session';
import { convertFileSrc } from '@tauri-apps/api/core';
import { trace, traceError } from '@/features/trace/trace-logger';
import { isFirefox } from '@/features/player/browser-detect';
import {
  notifySubtitleSyncError,
  notifyJimakuToast,
  notifySubtitleSyncSuccess,
  notifyMiningExportSuccess,
  notifyMiningExportError,
  notifyFirefoxUnsupported,
} from '@/features/player/eizouden-toast.tsx';
import { recordWatchHistory } from '@/features/player/watch-history';
import {
  appendMinedSentence,
  createWatchSessionId,
  getPlaybackWatchDeltaMs,
  putWatchSession,
  type WatchSessionRecord,
} from '@/features/player/watch-sessions';
import { useJimakuAutoLoad } from '@/features/player/use-jimaku-auto-load';
import {
  createSubDelayState,
  listenForSubDelay,
  rebaseSubDelay,
  setSubDelayOffset,
  subDelayCues,
} from '@/features/player/sub-delay';

import type {
  YtdlpStreamSource,
  YtdlpVideoInfo,
} from '@/features/player/tauri-bridge';
import {
  setMpvNativeActive,
  setMpvNativeLoading as setMpvNativeCaptureLoading,
  mpvGetDuration,
  mpvGetTime,
  mpvLoad,
  mpvPause,
  mpvPlay,
  mpvSeek,
  mpvSetBounds,
  mpvSetSubDelay,
  resolvePhysicalPath,
  parseSubtitleDirect,
  parseMediaFilenameDirect,
  installTauriDragDropPaths,
} from '@/features/player/tauri-bridge';
import {
  computeNativePictureRect,
  NATIVE_HOLE_PROPERTY,
  planNativeSurfaceUpdate,
  toPhysicalSurfaceBounds,
  type NativePictureState,
} from '@/features/player/native-surface';
import { YouTubeMark } from '@/components/player/YouTubeMark';
import { YouTubeInput } from '@/components/player/YouTubeInput';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import { Music, Magnet } from 'lucide-react';
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
  buildMediaMarkup,
  detectAnkiDroidMode,
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

/**
 * Whether the "subtitle sync" button in the right panel should be hidden.
 *
 * Spec: docs/SUBTITLE_SYNC.md §2.11-12.
 *   - YouTube: hidden (subs are already accurate).
 *   - Local and torrent video files: shown for .mkv/.mp4; hidden otherwise.
 *
 * Exported so apps/web/tests/player-app-hide-sync-subtitle.test.ts can
 * pin the predicate independently of the React tree.
 */
export function shouldHideSubtitleSync(args: {
  jobKind: 'youtube' | 'torrent' | null;
  mediaName: string;
}): boolean {
  const lowerMediaName = args.mediaName.toLowerCase();
  const isLocalVideo =
    lowerMediaName.endsWith('.mkv') || lowerMediaName.endsWith('.mp4');
  // Hide for YouTube; only .mkv/.mp4 local or torrent sources can sync.
  return args.jobKind === 'youtube' || !isLocalVideo;
}

/**
 * Predicate for right-panel "Jimaku subtitle search" button visibility.
 * Hidden for YouTube sources (YouTube delivers native captions; Jimaku anime/drama
 * matching is irrelevant for YouTube videos).
 */
export function shouldHideJimakuSearch(
  jobKind: 'youtube' | 'torrent' | null,
): boolean {
  return jobKind === 'youtube';
}

/**
 * Resolve the effective media source kind used for YouTube-only UI gating.
 *
 * YouTube streams are produced by the in-process Tauri yt-dlp plugin; torrent
 * streams are tracked separately by the native torrent session hook.
 */
export function resolveMediaSourceKind(args: {
  torrentActive: boolean;
  youtubeStreamActive: boolean;
}): 'youtube' | 'torrent' | null {
  if (args.youtubeStreamActive) return 'youtube';
  return args.torrentActive ? 'torrent' : null;
}

/** Debounce before the in-process torrent start-buffering overlay appears. */
const START_BUFFERING_DELAY_MS = 2000;

/** Absolute upper bound for the start-buffering overlay, measured from the
 *  FIRST arm: 2 s debounce + 3 s visible. The first PAINTED frame normally
 *  clears it much earlier via rVFC, or via loadeddata/canplay/playing on
 *  browsers without rVFC. Armed once per effect lifetime and never re-armed
 *  by later `waiting` events, so fragmented stalls cannot push the deadline
 *  forward (or keep the overlay from ever showing). Deliberately shorter
 *  than the 5 s seek buffer bound: playback and the controls stay usable,
 *  so a lingering start overlay is only noise. */
const START_BUFFERING_SAFETY_MS = START_BUFFERING_DELAY_MS + 3000;

/** Maximum length of a displayed media name (defense in depth). */
const MAX_MEDIA_NAME_LENGTH = 255;

/** sanitizeDisplayName — safe display text for the top-left controls and
 *  history. Control characters are removed, whitespace is normalized, and
 *  the length is capped so a hostile filename cannot break layout, logs,
 *  stripped, whitespace trimmed, and the length is capped so a hostile
 *  basename cannot break layout, logs, or Anki export fields. */
function sanitizeDisplayName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, MAX_MEDIA_NAME_LENGTH);
}

/** Round a playback position to 2 decimals for trace payloads. */
function round2(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * 100) / 100;
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

  // Trace: what the Player screen opened with (runtime, modules, prefs). The
  // per-action entries that follow inherit this context.
  useEffect(() => {
    trace('player', 'mount', {
      tauri: '__TAURI_INTERNALS__' in window,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    });
  }, []);

  // Tauri v2 never exposes an absolute path on the standard HTML `File`
  // object, so the native `tauri://drag-drop` event is the only source of
  // `Z:\...` paths. Subscribe once, for the lifetime of the Player.
  useEffect(() => installTauriDragDropPaths(), []);

  // --- Preferences ---
  const prefsRef = useRef(readPlayerPreferences());

  // --- Media state ---
  const activeUrlRef = useRef<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'video' | 'audio' | null>(null);
  const [mediaName, setMediaName] = useState('');
  const watchHistoryRecordedRef = useRef(false);
  const youtubeVideoIdRef = useRef<string | null>(null);
  const watchSessionRef = useRef<{
    sessionId: string;
    mediaId: string | null;
    startedAt: number;
    watchMs: number;
    episode: number | null;
    minedSentences: string[];
  } | null>(null);
  const watchSessionLastTimeRef = useRef<number | null>(null);
  /**
   * Last known playback position, name and duration, kept in a ref so the
   * stable media callbacks (play / pause / seek / error) can label a trace
   * entry without being re-created on every render.
   */
  const traceMediaRef = useRef<{
    time: number;
    name: string;
    duration: number | null;
  }>({
    time: 0,
    name: '',
    duration: null,
  });
  const watchSessionIsPlayingRef = useRef(false);
  const watchSessionPendingMutationRef = useRef<Promise<void> | null>(null);
  const jimakuMatchRef = useRef<{
    anilistId: number | null;
    tmdbId: string | null;
    titleNative: string | null;
  }>({ anilistId: null, tmdbId: null, titleNative: null });
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Stage 2a: Track local file for tracker fingerprint computation
  const mediaFileRef = useRef<File | null>(null);
  // Media-pick epoch: the native filename parse is one IPC round-trip, so a
  // newer pick can resolve first. A stale pick must not start a watch
  // session for the media that was replaced in the meantime.
  const mediaSelectEpochRef = useRef(0);
  // Subtitle epoch: the native parse is async, so two subtitle loads can
  // resolve out of order. Only the newest load may replace the cues.
  const subtitleEpochRef = useRef(0);
  // Stage 2a: Track subtitle text content for tracker digest computation
  const subtitleTextRef = useRef<string | null>(null);
  const [isSyncingSubtitle, setIsSyncingSubtitle] = useState(false);
  const torrentSubtitleTextRef = useRef<string | null>(null);
  const activeTorrentUrlRef = useRef<string | null>(null);
  const [hasTorrentReferenceSubtitle, setHasTorrentReferenceSubtitle] =
    useState(false);
  // --- Sub-delay (docs MODULE_ARCHITECTURE.md §9.3) ---
  // The native engine reads the audio waveform timing itself and pushes a
  // plain offset in seconds (libmpv `--sub-delay=<sec>`). Kept as immutable
  // state so every application shifts the ORIGINAL base cues: repeated
  // adjustments never degrade the base.
  const subDelayStateRef = useRef(createSubDelayState());
  // P4 jimaku search modal: open flag + title prefill chosen by the opener —
  // RightPanel button (current media name) or the P3 auto-load fallback.
  const [isJimakuSearchOpen, setIsJimakuSearchOpen] = useState(false);
  const [jimakuSearchPrefill, setJimakuSearchPrefill] = useState('');

  // --- Subtitle state ---
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [subtitleErrors, setSubtitleErrors] = useState<
    { line: number; message: string }[]
  >([]);
  const [activeCueId, setActiveCueId] = useState<number | null>(null);

  // --- Playback state ---
  const [isPlaying, setIsPlaying] = useState(false);
  /** `isPlaying` for the stable transport callback (`togglePlayback`).
   *  In native mode the element never reports a transition, so the React state
   *  is the only truth there and it must be readable without re-creating the
   *  callback on every play/pause. */
  const isPlayingRef = useRef(false);
  isPlayingRef.current = isPlaying;
  const prevIsPlayingRef = useRef(false);
  const [playbackRate, setPlaybackRate] = useState(
    prefsRef.current.playbackRate,
  );
  const [volume, setVolume] = useState(prefsRef.current.volume);

  // --- Seek buffering overlay ---
  // After a seek, if the video element's readyState drops below
  // HAVE_FUTURE_DATA (2), show a spinner overlay. The overlay clears
  // when readyState recovers (data arrives) or the element errors.
  // This is separate from the torrent start-buffering overlay (which shows
  // while waiting for the job media URL to surface).
  const [isSeekBuffering, setIsSeekBuffering] = useState(false);
  const seekBufferingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const seekBufferingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // --- Torrent start buffering overlay ---
  // The native relay URL is mounted but no
  // current frame is available yet (readyState < HAVE_CURRENT_DATA or a
  // `waiting` event while the torrent relay waits for pieces). After
  // 2 s of that state the larger "Preparing video…" overlay shows (same 2 s
  // debounce pattern as isSeekBuffering, so fast starts never flash); the
  // first PAINTED frame clears it via rVFC, or via loadeddata/canplay/
  // playing on browsers without rVFC.
  const [isStartBuffering, setIsStartBuffering] = useState(false);
  const startBufferingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Absolute last-resort bound for the start-buffering overlay, armed once
  // at the first arm; cleared as soon as the first frame arrives, on error,
  // or on unmount. Later `waiting` events leave it untouched.
  const startBufferingSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Source-scoped one-shot latch: once a real frame or the safety bound has
  // ended start buffering, a later 'waiting' must not revive the overlay.
  const startBufferingExhaustedRef = useRef<{
    source: string;
    exhausted: boolean;
  }>({ source: '', exhausted: false });
  // rVFC only: readyState/loadeddata/playing are not proof of presented
  // pixels. Flipped solely by onFirstFrame when meta.width/height > 0.
  const realFramePresentedRef = useRef<{
    source: string;
    presented: boolean;
  }>({ source: '', presented: false });

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

  // --- Panel layout persistence (desktop only) ---
  const [panelLayout, setPanelLayout] = useState(DEFAULT_LAYOUT);
  // The side panel is COLLAPSED IN PLACE when the user closes it. Unmounting
  // it remounted the whole panel group — and with it the <video> element, so
  // the browser had to re-fetch the media and the panel took 1-2 seconds to
  // reopen. The imperative handle lets us collapse/expand the very same
  // mounted panel instead.
  const sidePanelRef = usePanelRef();
  // The group element: the library converts a percentage size through the
  // MEASURED group size, so the handle is only usable once the group has a
  // width (it never has one while it is hidden).
  const groupElementRef = useRef<HTMLDivElement | null>(null);

  // A viewport branch swap (desktop <-> mobile/immersive) remounts the media
  // element. The panel toggle does NOT: the side panel is collapsed in place.
  // Keep the snapshot tied to the current media identity so a normal media
  // switch can never restore an old position into the new file.
  const layoutMediaElementRef = useRef<HTMLMediaElement | null>(null);
  const layoutMediaSnapshotRef = useRef<{
    mediaUrl: string;
    mediaType: 'video' | 'audio';
    currentTime: number;
    paused: boolean;
    epoch: number;
  } | null>(null);
  const layoutMediaEpochRef = useRef(0);
  const snapshotLayoutMedia = useCallback(() => {
    const media = layoutMediaElementRef.current;
    if (!media) return;

    layoutMediaSnapshotRef.current = {
      mediaUrl: media.currentSrc || media.src,
      mediaType: media instanceof HTMLVideoElement ? 'video' : 'audio',
      currentTime: media.currentTime,
      paused: media.paused,
      epoch: layoutMediaEpochRef.current,
    };
  }, []);

  const restoreLayoutMedia = useCallback(() => {
    const snapshot = layoutMediaSnapshotRef.current;
    const media = layoutMediaElementRef.current;
    if (!snapshot || !media) return;

    const mediaMatchesSnapshot =
      snapshot.epoch === layoutMediaEpochRef.current &&
      snapshot.mediaUrl === (media.currentSrc || media.src) &&
      snapshot.mediaType ===
        (media instanceof HTMLVideoElement ? 'video' : 'audio');
    if (!mediaMatchesSnapshot) {
      layoutMediaSnapshotRef.current = null;
      return;
    }

    media.currentTime = snapshot.currentTime;
    if (snapshot.paused) {
      media.pause();
    } else {
      media.play().catch(() => {});
    }
    layoutMediaSnapshotRef.current = null;
  }, []);

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
    const desktopHandler = (e: MediaQueryListEvent) => {
      // The layout branch depends on the viewport only. The right panel is
      // collapsed in place, so toggling it never swaps the branch and never
      // remounts the media element.
      const previousBranch = isDesktop && !isLandscapeImmersive;
      const nextBranch = e.matches && !isLandscapeImmersive;
      if (previousBranch !== nextBranch) snapshotLayoutMedia();
      setIsDesktop(e.matches);
    };
    const landscapeHandler = (e: MediaQueryListEvent) => {
      const previousBranch = isDesktop && !isLandscapeImmersive;
      const nextBranch = isDesktop && !e.matches;
      if (previousBranch !== nextBranch) snapshotLayoutMedia();
      setIsLandscapeImmersive(e.matches);
    };
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
  }, [isDesktop, isLandscapeImmersive, snapshotLayoutMedia]);

  // Restore saved panel layout on mount
  useEffect(() => {
    setPanelLayout(readPanelLayout());
  }, []);

  // --- Right panel open/close (desktop) ---
  // The panel is collapsed IN PLACE instead of being unmounted: the <video>
  // element (and its decoder) stays alive across the toggle, so the browser
  // never re-fetches the media and the panel opens instantly.
  useEffect(() => {
    const panel = sidePanelRef.current;
    if (!panel) return;
    if (isSubtitlePanelVisible) {
      if (!panel.isCollapsed()) return;
      // Reopen at the width the user last chose. The library forgets that
      // width when the group remounts (desktop <-> mobile), so the
      // persisted width is applied. resize() converts the percentage through
      // the measured group size, so it needs a laid-out group; expand() is
      // the fallback when the group has no size yet.
      const groupWidth = groupElementRef.current?.clientWidth ?? 0;
      if (groupWidth > 0) {
        panel.resize(`${panelLayout.sidePct}%`);
      } else {
        panel.expand();
      }
    } else if (!panel.isCollapsed()) {
      panel.collapse();
    }
  }, [
    isSubtitlePanelVisible,
    isDesktop,
    isLandscapeImmersive,
    panelLayout.sidePct,
    sidePanelRef,
    groupElementRef,
  ]);

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

  // MODULE_ARCHITECTURE.md §5.3: module toggles gate the source entry points at
  // runtime — a disabled source module hides its button and its dialog.
  const moduleState = useModuleState();
  const torrentEnabled = moduleState.torrent;
  const ytdlpEnabled = moduleState.ytdlp;

  // Native source dialogs are scoped to the enabled modules.
  const [isMagnetDialogOpen, setIsMagnetDialogOpen] = useState(false);
  const [isYouTubeDialogOpen, setIsYouTubeDialogOpen] = useState(false);

  // MODULE_ARCHITECTURE.md §5.3: a module disabled in another tab while its
  // dialog is open must close the dialog, not just hide the entry button.
  useEffect(() => {
    if (!torrentEnabled) setIsMagnetDialogOpen(false);
  }, [torrentEnabled]);
  useEffect(() => {
    if (!ytdlpEnabled) setIsYouTubeDialogOpen(false);
  }, [ytdlpEnabled]);
  const torrentSession = useTorrentSession();
  const displayMediaUrl = torrentSession.mediaUrl ?? mediaUrl;
  const displayMediaType = torrentSession.mediaUrl ? 'video' : mediaType;

  // Clear a stale snapshot when the media identity changes.
  useEffect(() => {
    layoutMediaEpochRef.current += 1;
    layoutMediaSnapshotRef.current = null;
  }, [displayMediaUrl, displayMediaType]);
  /** Native yt-dlp relay source, used for YouTube-only UI gating. */
  const [isYouTubeStream, setIsYouTubeStream] = useState(false);
  /** Effective source kind for YouTube-only UI gating (see
   *  `resolveMediaSourceKind`). */
  const mediaSourceKind = resolveMediaSourceKind({
    torrentActive: torrentSession.active,
    youtubeStreamActive: isYouTubeStream,
  });

  // Persist watch sessions independently of the active native media source.
  const persistWatchSession = useCallback(
    (session: NonNullable<typeof watchSessionRef.current>, endedAt: number) => {
      if (!session.mediaId) return;
      const record: WatchSessionRecord = {
        sessionId: session.sessionId,
        mediaId: session.mediaId,
        startedAt: session.startedAt,
        endedAt,
        watchMs: Math.max(0, Math.round(session.watchMs)),
        episode: session.episode,
        minedSentences: [...session.minedSentences],
      };
      void putWatchSession(record);
    },
    [],
  );

  const persistWatchSessionAfterPending = useCallback(
    (session: NonNullable<typeof watchSessionRef.current>) => {
      const pendingMutation = watchSessionPendingMutationRef.current;
      if (pendingMutation) {
        void pendingMutation.then(() =>
          persistWatchSession(session, Date.now()),
        );
      } else {
        persistWatchSession(session, Date.now());
      }
    },
    [persistWatchSession],
  );

  const flushWatchSession = useCallback(() => {
    const session = watchSessionRef.current;
    if (!session) return;
    persistWatchSessionAfterPending(session);
  }, [persistWatchSessionAfterPending]);

  const endWatchSession = useCallback(() => {
    const session = watchSessionRef.current;
    if (!session) return;
    persistWatchSessionAfterPending(session);
    watchSessionRef.current = null;
    watchSessionLastTimeRef.current = null;
    watchSessionIsPlayingRef.current = false;
    watchSessionPendingMutationRef.current = null;
  }, [persistWatchSessionAfterPending]);

  const startWatchSession = useCallback(
    (mediaId: string | null, episode: number | null) => {
      endWatchSession();
      const session = {
        sessionId: createWatchSessionId(),
        mediaId,
        startedAt: Date.now(),
        watchMs: 0,
        episode,
        minedSentences: [] as string[],
      };
      watchSessionRef.current = session;
      watchSessionLastTimeRef.current = null;
      if (mediaId) persistWatchSession(session, session.startedAt);
    },
    [endWatchSession, persistWatchSession],
  );

  const attachWatchSessionMediaId = useCallback(
    (mediaId: string, episode: number | null) => {
      const session = watchSessionRef.current;
      if (!session || session.mediaId) return;
      session.mediaId = mediaId;
      session.episode = episode;
      persistWatchSession(session, session.startedAt);
    },
    [persistWatchSession],
  );

  const appendWatchSessionSentence = useCallback((sentence: string) => {
    const session = watchSessionRef.current;
    const normalized = sentence.trim();
    if (!session || !normalized) return Promise.resolve();
    session.minedSentences.push(normalized);
    const previous =
      watchSessionPendingMutationRef.current ?? Promise.resolve();
    const mutation = previous.then(async () => {
      await appendMinedSentence(session.sessionId, normalized);
    });
    watchSessionPendingMutationRef.current = mutation.catch(() => {});
    return mutation;
  }, []);

  const handleYouTubeVideoIdParsed = useCallback((videoId: string) => {
    youtubeVideoIdRef.current = videoId;
  }, []);

  // Desktop native engine: does libmpv hold the *current* media?
  // True only for a local file with an absolute physical path — the one case
  // where mpv is the renderer and the HTML element is a muted shim. Relay
  // streams (torrent / YouTube) and local `blob:` picks keep the engine out of
  // the picture: transport mirrors and native play/pause must stay silent for
  // them, otherwise mpv would seek/pause a stale file or sing next to the
  // element.
  const mpvActiveRef = useRef(false);
  // Each local native load owns a generation. A late completion from a media
  // that has already been replaced must never reactivate native capture.
  const mpvLoadEpochRef = useRef(0);
  const mpvNativeLoadPendingRef = useRef(false);
  // Serialize load/pause IPC pairs so an older native file cannot finish
  // replacing a newer one after its generation has been superseded.
  const mpvLoadQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Desktop native engine: hand a local file to libmpv and hold it paused.
  // `loadfile … replace` starts the engine's own clock, so without the explicit
  // pause the engine would begin playing on its own — audible in parallel with
  // the HTML element once the user presses Play (the "two engines singing"
  // symptom). Native rendering and capture are enabled only after both IPC
  // operations have completed for the still-current media generation.
  const loadMpvPaused = useCallback((url: string, epoch: number) => {
    const load = mpvLoadQueueRef.current.then(async () => {
      if (mpvLoadEpochRef.current !== epoch) return;
      await mpvLoad(url);
      if (mpvLoadEpochRef.current !== epoch) return;
      await mpvPause();
      if (mpvLoadEpochRef.current !== epoch || !mountedRef.current) return;

      mpvNativeLoadPendingRef.current = false;
      setMpvNativeCaptureLoading(false);
      mpvActiveRef.current = true;
      setMpvNativeActive(true);
      setIsMpvNative(true);
      setIsLoading(false);
    });
    const settledLoad = load.catch(() => {
      if (mpvLoadEpochRef.current !== epoch) return;
      mpvNativeLoadPendingRef.current = false;
      setMpvNativeCaptureLoading(false);
      setIsLoading(false);
    });
    mpvLoadQueueRef.current = settledLoad;
    return settledLoad;
  }, []);
  /** True while mpv owns the picture and sound for the current media. Drives
   *  the HTML element's `muted` and decode-error suppression. */
  const [isMpvNative, setIsMpvNative] = useState(false);
  /** Native mpv clock while it renders; null outside native mode. */
  const [mpvTime, setMpvTime] = useState<number | null>(null);
  /** The same clock as a ref, for callbacks that must not re-create on every
   *  poll tick (mining snapshot, native seek targets). */
  const mpvTimeRef = useRef<number | null>(null);
  /** True once the engine reported a position, i.e. the native picture is on
   *  screen. The transparent surface is only enabled from that moment on. */
  const [nativePictureReady, setNativePictureReady] = useState(false);
  const [mpvDuration, setMpvDuration] = useState<number | null>(null);

  /**
   * Hand the media back to the HTML element and stop the native engine.
   *
   * Every source that leaves native mode goes through here: a torrent/YouTube
   * relay stream, or a local `blob:` pick. Pausing the engine matters — a
   * still-playing mpv would keep sounding behind the webview after the element
   * took over (double audio), and a stale picture would stay loaded.
   */
  const releaseMpv = useCallback(() => {
    const wasActiveOrLoading =
      mpvActiveRef.current || mpvNativeLoadPendingRef.current;
    mpvLoadEpochRef.current += 1;
    mpvNativeLoadPendingRef.current = false;
    if (wasActiveOrLoading) {
      const pause = mpvLoadQueueRef.current.then(() => mpvPause());
      mpvLoadQueueRef.current = pause.catch(() => {});
    }
    mpvActiveRef.current = false;
    setMpvNativeCaptureLoading(false);
    setMpvNativeActive(false);
    setIsMpvNative(false);
    setMpvTime(null);
    mpvTimeRef.current = null;
    setMpvDuration(null);
    setNativePictureReady(false);
  }, []);

  // Stop native playback and release mpv whenever PlayerApp unmounts
  // (e.g. navigating back to Home/Timeline or switching routes).
  useEffect(() => {
    const handleLeave = () => {
      releaseMpv();
    };
    window.addEventListener('pagehide', handleLeave);
    window.addEventListener('beforeunload', handleLeave);
    return () => {
      window.removeEventListener('pagehide', handleLeave);
      window.removeEventListener('beforeunload', handleLeave);
      releaseMpv();
    };
  }, [releaseMpv]);

  // Shared subtitle-text pipeline: parse + replace cues (used by the P3
  // auto-load hook AND the P4 search modal).
  //
  // Desktop (Tauri): the parse runs in the native plugin, so a 3 000-cue
  // file no longer blocks the browser main thread. The browser build keeps
  // the TypeScript parser (the wrapper falls back to it).
  const handleSubtitleText = useCallback(async (text: string) => {
    const epoch = ++subtitleEpochRef.current;
    const result = await parseSubtitleDirect(text);
    // A newer subtitle load started while this one was parsing (manual pick
    // vs. auto-load) — the newer load wins, the stale one is dropped.
    if (epoch !== subtitleEpochRef.current) return;
    // Re-anchor the sub-delay base to the freshly loaded cues (the current
    // offset is kept) so a later native offset still shifts the originals.
    subDelayStateRef.current = rebaseSubDelay(
      subDelayStateRef.current,
      result.cues,
    );
    setCues(subDelayCues(subDelayStateRef.current));
    setSubtitleErrors(result.errors);
    setActiveCueId(null);
    subtitleTextRef.current = text;
  }, []);

  // Localized jimaku toast (rate-limit / auth / key-missing) — shared by the
  // auto-load hook and the search modal.
  const handleJimakuToast = useCallback(
    (kind: 'rate-limit' | 'auth' | 'key-missing') => {
      const ui = dictRef.current.playerUI;
      notifyJimakuToast(
        kind === 'rate-limit'
          ? ui.jimakuRateLimit
          : kind === 'auth'
            ? ui.jimakuAuthError
            : ui.jimakuKeyMissing,
      );
    },
    [],
  );

  // P3 jimaku auto-load (§2.2): fires on local media select / Magnet handoff
  // when the switch is ON. Exact match replaces subtitles; otherwise the
  // search modal opens with the parsed title.
  const jimakuAutoLoad = useJimakuAutoLoad({
    onSubtitleLoaded: handleSubtitleText,
    onMatchResolved: (match) => {
      jimakuMatchRef.current = match;
    },
    onOpenSearch: (_title) => {
      setJimakuSearchPrefill(_title);
      setIsJimakuSearchOpen(true);
    },
    onToast: handleJimakuToast,
  });
  // P4-1: spinner while the jimaku auto-load search is in flight.
  const jimakuLoading = jimakuAutoLoad.isLoading;

  // P4: RightPanel search button — pre-fill with the current media name.
  const handleOpenJimakuSearch = useCallback(async () => {
    // Parse the media filename so the search box is pre-filled with the
    // clean title (e.g. "Meitantei no Mama de Ite" from the raw .mkv name)
    // instead of the raw filename — raw names never match jimaku.
    const parsed = await parseMediaFilenameDirect(mediaName);
    setJimakuSearchPrefill(parsed.title || mediaName);
    setIsJimakuSearchOpen(true);
  }, [mediaName]);

  const handleMagnetJobAccepted = useCallback(
    (
      torrentId: string,
      selectedName: string,
      _subtitleFileId: string,
      direct: DirectTorrentHandoff,
    ) => {
      const previousTorrentUrl = activeTorrentUrlRef.current;
      activeTorrentUrlRef.current = direct.videoUrl;
      if (previousTorrentUrl) void torrentSession.cancelActiveSession();
      trace('player', 'magnet_job_accepted', {
        torrentId,
        name: selectedName,
        subtitle: Boolean(direct.subtitleUrl),
        selectedAudioTrack: direct.selectedAudioTrack ?? null,
        selectedSubtitleTrack: direct.selectedSubtitleTrack ?? null,
      });
      endWatchSession();
      setIsYouTubeStream(false);
      setMediaName(sanitizeDisplayName(selectedName));
      mediaFileRef.current = null;
      torrentSubtitleTextRef.current = null;
      setHasTorrentReferenceSubtitle(false);
      setMediaUrl(null);
      setMediaType('video');
      torrentSession.beginSession({
        torrentId,
        videoUrl: direct.videoUrl,
        subtitleUrl: direct.subtitleUrl,
      });
      releaseMpv();
      setIsMagnetDialogOpen(false);
      if (direct.subtitleUrl) {
        const subtitleUrl = direct.subtitleUrl;
        void fetch(subtitleUrl)
          .then((response) => (response.ok ? response.text() : ''))
          .then((text) => {
            if (!text || activeTorrentUrlRef.current !== direct.videoUrl) return;
            torrentSubtitleTextRef.current = text;
            setHasTorrentReferenceSubtitle(true);
            return handleSubtitleText(text);
          })
          .catch(() => {
            // Subtitle is optional; the source remains playable without it.
          });
      } else {
        void jimakuAutoLoad.runAutoLoad(selectedName, `magnet:${torrentId}`);
      }
    },
    [endWatchSession, handleSubtitleText, jimakuAutoLoad, releaseMpv, torrentSession],
  );

  // Torrent relay subtitles are read directly when selected; local and
  // YouTube subtitles use the same shared parse pipeline.
  const isLoadingSubtitles =
    (torrentSession.active && hasTorrentReferenceSubtitle && cues.length === 0) ||
    (jimakuLoading && cues.length === 0);

  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const controlsHandleRef = useRef<PlayerControlsHandle>(null);
  const mediaContainerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const sharedMediaRef = useRef<HTMLMediaElement | null>(null);

  // Native mode makes the media surface genuinely transparent so libmpv's
  // child HWND (created from `wid`) shows through the webview. The class is
  // scoped to <html>, so Home/Tracker keep their opaque shell.
  //
  // The class is applied only once the native picture is actually on screen
  // (the engine reports a position). The Tauri window is created with
  // `transparent: true`, so a transparent page before libmpv has painted
  // would show the desktop through the app for the whole engine start-up.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(
      'entei-native-video',
      isMpvNative && nativePictureReady,
    );
    return () => root.classList.remove('entei-native-video');
  }, [isMpvNative, nativePictureReady]);

  // --- Native surface: the rectangle the plugin and the wallpaper share ---
  //
  // libmpv paints into a child HWND that lives BEHIND the WebView2, so the
  // webview has to stay transparent exactly at the media frame. The wallpaper
  // carries a matching hole (`--entei-native-hole`); both rectangles come
  // from the same measurement, so they can never drift apart.
  //
  // The effect only restarts when the native mode itself starts or stops: a
  // picture that merely becomes visible must not hide and re-show the
  // surface, that would flash the frame.
  const nativeSurfaceSyncRef = useRef<(() => void) | null>(null);
  /** True while the native picture is on screen. Read inside the sync
   *  callback, which must not be re-created on every clock tick. */
  const nativePictureReadyRef = useRef(nativePictureReady);
  nativePictureReadyRef.current = nativePictureReady;

  useEffect(() => {
    const root = document.documentElement;
    if (!isMpvNative) {
      // Nothing native to place. The cleanup of the previous native run has
      // already hidden the picture, so there is nothing to do here.
      return;
    }

    let frame = 0;
    let observed: HTMLElement | null = null;
    /** The state the picture is known to be in; null = no picture. */
    let lastPicture: NativePictureState | null = null;
    /** True once a picture was requested: the cleanup has to hide it again,
     *  even when the move never came back. */
    let pictureRequested = false;
    let lastHole = '';
    /** Bumped for every request: a late IPC reply must never open a hole
     *  that belongs to an outdated frame. */
    let generation = 0;

    /** Write (or clear) the wallpaper hole. */
    const setHole = (hole: string) => {
      if (hole === lastHole) return;
      lastHole = hole;
      if (hole) {
        root.style.setProperty(NATIVE_HOLE_PROPERTY, hole);
      } else {
        root.style.removeProperty(NATIVE_HOLE_PROPERTY);
      }
    };

    /** Hide the native picture and close the wallpaper hole. */
    const hideSurface = () => {
      generation += 1;
      const wasRequested = pictureRequested;
      pictureRequested = false;
      lastPicture = null;
      setHole('');
      if (!wasRequested) return;
      void mpvSetBounds(0, 0, 0, 0);
    };

    const sync = () => {
      frame = 0;
      const surface = surfaceRef.current;
      if (!surface) {
        hideSurface();
        return;
      }
      if (surface !== observed) {
        // The layout branch can remount the media area, so the observer
        // follows the element that is actually on screen.
        if (observed) observer?.unobserve(observed);
        observer?.observe(surface);
        observed = surface;
      }
      const rect = surface.getBoundingClientRect();
      const bounds = toPhysicalSurfaceBounds(rect, window.devicePixelRatio);
      if (!bounds) {
        // No media frame (no media, immersive mode exited): hide the picture.
        hideSurface();
        return;
      }
      // The hole opens only while the picture is on screen: before that the
      // wallpaper has to cover the frame, or the transparent Tauri window
      // would show the desktop through the app.
      //
      // The hole is the rectangle the picture really covers: libmpv
      // letterboxes the video inside the surface exactly like the page's
      // `object-fit: contain`, so a hole built from the surface alone would
      // be bigger than the picture and expose the desktop.
      const video = videoRef.current;
      const pictureRect = computeNativePictureRect(
        rect,
        video?.videoWidth ?? 0,
        video?.videoHeight ?? 0,
      );
      const plan = planNativeSurfaceUpdate(lastPicture, {
        bounds,
        picture: pictureRect,
      });
      const move = plan.movePicture;
      // Without a picture on screen there is no hole at all: the wallpaper
      // covers the frame and the desktop can never come through.
      const holeDuringMove = nativePictureReadyRef.current
        ? plan.holeDuringMove
        : '';
      const holeAfterMove = nativePictureReadyRef.current
        ? plan.holeAfterMove
        : '';
      if (!move) {
        // The picture already sits in this rectangle: the hole may follow.
        setHole(holeAfterMove);
        lastPicture = { bounds, picture: pictureRect };
        return;
      }
      // The hole never outlives the picture. While the picture moves, the
      // hole shrinks to the overlap of the old and the new frame, so the
      // transparent window can never show the desktop — not even for the
      // few milliseconds the move takes.
      setHole(holeDuringMove);
      const gen = ++generation;
      pictureRequested = true;
      void mpvSetBounds(move.x, move.y, move.width, move.height)
        .then(() => {
          if (gen !== generation) return;
          // The picture is in the new frame: the hole may open now.
          lastPicture = { bounds: move, picture: pictureRect };
          setHole(holeAfterMove);
        })
        .catch(() => {
          if (gen !== generation) return;
          // The picture did not move: the wall stays closed, so the desktop
          // can never come through.
          setHole('');
        });
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(sync);
    };

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;

    nativeSurfaceSyncRef.current = sync;
    sync();

    window.addEventListener('resize', schedule);
    // The media frame moves with the page (and with the sticky media area on
    // mobile), so the surface has to follow every scroll.
    window.addEventListener('scroll', schedule, true);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      nativeSurfaceSyncRef.current = null;
      hideSurface();
    };
  }, [isMpvNative]);

  // The native picture just appeared (or vanished): re-measure so the
  // wallpaper hole opens exactly when the picture is on screen.
  useEffect(() => {
    nativeSurfaceSyncRef.current?.();
  }, [nativePictureReady]);

  // The layout can change without the media frame moving on its own: the
  // right panel toggle and the immersive mode swap the whole layout branch
  // (the media area is remounted). Re-measure so the picture follows the new
  // frame immediately — otherwise the wallpaper hole can be bigger than the
  // picture and the desktop shows through the transparent window.
  useEffect(() => {
    nativeSurfaceSyncRef.current?.();
  }, [isSubtitlePanelVisible, isDesktop, isLandscapeImmersive]);

  // The media frame is mounted through a callback ref: the layout branch can
  // remount the media area, and the native surface then has to follow the new
  // element instead of the detached one.
  const attachSurface = useCallback((element: HTMLDivElement | null) => {
    surfaceRef.current = element;
    // A remount fires the callback twice (null, then the new element); only
    // the mounted element has to be measured, so the transient null must not
    // hide the picture.
    if (element) nativeSurfaceSyncRef.current?.();
  }, []);

  // --- Stage 2a: Tracker runtime (non-visual, side-effect only) ---
  // Refs to carry latest media identity into the flush callback (defined
  // before trackerFlush so the stable callback can read ref.current).
  const flushMediaIdRef = useRef<string | null>(null);
  const flushMediaNameRef = useRef('');

  const trackerFlush = useCallback(
    async (
      cells: Map<
        string,
        import('@/features/player/tracker/types').ExposureCell
      >,
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
    // Tracker currently records local-file media only.
    isTorrentSource: false,
    isLocalFile: !!mediaFileRef.current,
    mediaFile: mediaFileRef.current,
    mediaName,
    hasSubtitles: cues.length > 0,
    subtitleText: subtitleTextRef.current,
    playMode:
      playMode === 'condensed' || playMode === 'fast-forward'
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

  // Flush on hidden as a safety checkpoint before pagehide/unload. The session
  // remains active so playback can continue when the tab becomes visible.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushWatchSession();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [flushWatchSession]);

  // Session boundaries are pagehide and player unmount. The media switch and
  // accepted-source handlers call start/end explicitly below.
  useEffect(() => {
    const onPageHide = () => endWatchSession();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [endWatchSession]);

  // Cleanup on unmount
  useEffect(() => {
    // AM-2: Reset for React StrictMode double-invoke (setup→cleanup→setup).
    // Without this, the second setup leaves mountedRef=false and discards all work.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      endWatchSession();
      revokeUrl(activeUrlRef.current);
      activeUrlRef.current = null;
      // Nothing is loaded into the engine any more: stop mirroring transport.
      // State is intentionally not touched here — this is an unmount cleanup.
      const wasMpvActiveOrLoading =
        mpvActiveRef.current || mpvNativeLoadPendingRef.current;
      mpvLoadEpochRef.current += 1;
      mpvNativeLoadPendingRef.current = false;
      if (wasMpvActiveOrLoading) {
        const pause = mpvLoadQueueRef.current.then(() => mpvPause());
        mpvLoadQueueRef.current = pause.catch(() => {});
      }
      mpvActiveRef.current = false;
      setMpvNativeCaptureLoading(false);
      setMpvNativeActive(false);
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
      if (el) torrentSession.attachMediaElement(el);
      sharedMediaRef.current = displayMediaType === 'video' ? el : null;
      if (displayMediaType === 'video') {
        layoutMediaElementRef.current = el;
      }
    },
    [displayMediaType, torrentSession.attachMediaElement],
  );

  const audioCallbackRef = useCallback(
    (el: HTMLAudioElement | null) => {
      audioRef.current = el;
      sharedMediaRef.current = displayMediaType === 'audio' ? el : null;
      if (displayMediaType === 'audio') {
        layoutMediaElementRef.current = el;
      }
    },
    [displayMediaType],
  );

  // Layout branch swaps remount the media element; restore position/pause
  // state once the replacement has loaded its metadata.
  useEffect(() => {
    const media = layoutMediaElementRef.current;
    const snapshot = layoutMediaSnapshotRef.current;
    if (!media || !snapshot) return;

    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (prefersReducedMotion) {
      // "Until found" metadata load skips the seek, so restore via the
      // loadeddata path instead (fires after the first frame is read).
      media.preload = 'auto';
      media.load();
    }

    const onLoaded = () => {
      media.removeEventListener('loadedmetadata', onLoaded);
      media.removeEventListener('loadeddata', onLoaded);
      restoreLayoutMedia();
    };
    if (media.readyState >= HTMLMediaElement.HAVE_METADATA) {
      onLoaded();
    } else {
      media.addEventListener('loadedmetadata', onLoaded);
      media.addEventListener('loadeddata', onLoaded);
    }
    return () => {
      media.removeEventListener('loadedmetadata', onLoaded);
      media.removeEventListener('loadeddata', onLoaded);
    };
  }, [isDesktop, isLandscapeImmersive]);

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

  // The Tauri yt-dlp plugin resolves and relays the stream in-process. Never
  // mount an unrelayed upstream URL on the media element.
  const handleYouTubeStreamAccepted = useCallback(
    (source: YtdlpStreamSource, info: YtdlpVideoInfo | null) => {
      const p = dictRef.current.playerUI;
      // Fail closed when the loopback relay could not bind: upstream URLs
      // expire and must never be mounted directly on the media element.
      if (!source.relayed) {
        setIsYouTubeDialogOpen(false);
        notifySubtitleSyncError(p.youtubeInputErrorGeneric);
        trace('player', 'youtube_stream_rejected', {
          reason: 'relay_unavailable',
          videoId: youtubeVideoIdRef.current,
        });
        return;
      }
      // Dual-stream guard: `urls.length > 1` is yt-dlp's video+audio fallback
      // (`bestvideo+bestaudio`). The player mounts a single <video> element, so
      // urls[0] would play a silent picture. The plugin's selector prefers a
      // muxed stream first, so this only happens for videos with no muxed
      // format at all — fail loudly instead of playing silent video.
      // Note: attaching a separate audio track is deferred (needs a second
      // media element plus drift correction inside VideoPlayer).
      if (source.urls.length > 1) {
        setIsYouTubeDialogOpen(false);
        notifySubtitleSyncError(p.youtubeInputErrorGeneric);
        trace('player', 'youtube_stream_rejected', {
          reason: 'dual_stream',
          videoId: youtubeVideoIdRef.current,
          urlCount: source.urls.length,
        });
        return;
      }
      trace('player', 'youtube_stream_accepted', {
        videoId: youtubeVideoIdRef.current,
        title: info ? sanitizeDisplayName(info.title) : null,
        mode: source.mode,
        duration: info?.duration ?? null,
        hasJapaneseSubtitle: Boolean(info?.subtitle_vtt_url),
      });
      watchHistoryRecordedRef.current = false;
      mediaFileRef.current = null;
      void torrentSession.cancelActiveSession();
      activeTorrentUrlRef.current = null;
      setIsYouTubeStream(true);
      const videoId = youtubeVideoIdRef.current;
      startWatchSession(videoId ? `youtube:${videoId}` : null, null);
      // New media identity: drop the previous subtitles and mining captures.
      subtitleTextRef.current = null;
      // Sub-delay belongs to the previous media's timings: reset the base.
      subDelayStateRef.current = createSubDelayState();
      setCues([]);
      setSubtitleErrors([]);
      setActiveCueId(null);
      clearScreenshot();
      clearAudioClip();
      clearMiningPreview();
      // Release the previous local blob URL before switching sources, otherwise
      // every YouTube source switch leaks the prior object URL until unmount.
      revokeUrl(activeUrlRef.current);
      activeUrlRef.current = source.url;
      setMediaUrl(source.url);
      setMediaType('video');
      // Native engine: the resolved relay stream stays on the HTML
      // element. mpv is only attached to a local file with an absolute path,
      // so YouTube playback never produces a second audio output.
      releaseMpv();
      // mediaName feeds the subtitle panel title and the mining source label.
      setMediaName(info ? sanitizeDisplayName(info.title) : (videoId ?? ''));
      setIsYouTubeDialogOpen(false);

      // YouTube subtitles: the plugin resolves an optional Japanese WebVTT URL
      // via the loopback relay. Fetch it through the shared parser pipeline.
      const subtitleUrl = info?.subtitle_vtt_url;
      if (subtitleUrl) {
        const requestedMediaUrl = source.url;
        void fetch(subtitleUrl)
          .then((response) => (response.ok ? response.text() : ''))
          .then((text) => {
            // Guard: the user may have switched media while the track was in
            // flight, and a stale track must not overwrite the new media's cues.
            if (!text || activeUrlRef.current !== requestedMediaUrl) return;
            handleSubtitleText(text);
          })
          .catch(() => {
            // Subtitles are optional; a failed track fetch never breaks playback.
          });
      }
    },
    [
      startWatchSession,
      clearScreenshot,
      clearAudioClip,
      clearMiningPreview,
      handleSubtitleText,
      releaseMpv,
      torrentSession,
    ],
  );

  /**
   * Shared local-media entry point for every pick path.
   *
   * `file` is present for a browser pick and for a Tauri drop that also
   * produced a `File`. A native dialog pick has only an absolute path
   * (WebView2 never exposes `File.path`), so `file` is null there and every
   * `File`-only step — object URL, tracker fingerprint — is skipped while the
   * path itself still goes straight to libmpv.
   */
  const selectLocalMedia = useCallback(
    async (input: {
      name: string;
      mime: string;
      bytes: number;
      file: File | null;
      physicalPath: string | null;
    }) => {
      const { name, mime, bytes, file, physicalPath } = input;
      // A local media selection ends any active in-process torrent session.
      void torrentSession.cancelActiveSession();
      activeTorrentUrlRef.current = null;

      const admission = file
        ? classifyMediaFile(file)
        : classifyMediaName(name);

      if (admission.kind === 'rejected') {
        setLoadError(
          `${dictRef.current.playerUI.unsupportedFormat}: .${admission.ext}`,
        );
        setIsLoading(false);
        trace('player', 'media_select_rejected', {
          name,
          ext: admission.ext,
          bytes,
        });
        return;
      }

      // Firefox playback guard: block all media selection with a toast
      // directing the user to Chrome or a Chromium-based browser.
      if (isFirefox()) {
        notifyFirefoxUnsupported(dictRef.current.playerUI.firefoxUnsupported);
        trace('player', 'media_select_blocked', { reason: 'firefox' });
        return;
      }

      trace('player', 'media_select', {
        name,
        kind: admission.kind,
        mime,
        bytes,
        nativePath: physicalPath !== null,
      });

      setIsLoading(true);
      setLoadError(null);
      setActiveCueId(null);
      // Stage 2a: Clear subtitle text on media change (subtitles are media-specific)
      subtitleTextRef.current = null;
      // Also clear the rendered cues so stale subtitles don't linger — this
      // also lets the jimaku auto-load spinner show (cues.length === 0).
      // Sub-delay is anchored to the previous media's timings: reset it.
      subDelayStateRef.current = createSubDelayState();
      setCues([]);
      // P3 auto-load: local file selected — auto-load jimaku subtitles.
      jimakuMatchRef.current = {
        anilistId: null,
        tmdbId: null,
        titleNative: null,
      };
      void jimakuAutoLoad.runAutoLoad(name, `local:${name}`);
      // AM-2: Invalidate any prior screenshot when selecting new media
      clearScreenshot();
      // AM-3: Invalidate any prior audio clip when selecting new media
      clearAudioClip();
      // AM-4: Invalidate any prior mining preview when selecting new media
      clearMiningPreview();

      // Desktop native engine: an absolute path (native dialog / Tauri drop)
      // goes straight to libmpv. The HTML element still needs a source for its
      // timing shim, and a native pick has no `File`, so the asset-protocol URL
      // of the same file is mounted instead of an object URL. mpv opens
      // `Z:\...` natively — no blob conversion, no HTTP relay, and SMB/CIFS
      // seeks are answered by the OS cache directly.
      const oldUrl = activeUrlRef.current;
      const newUrl = file
        ? createMediaUrl(file, oldUrl)
        : physicalPath
          ? convertFileSrc(physicalPath)
          : '';
      if (file) {
        activeUrlRef.current = newUrl;
      } else {
        // An asset URL is not an object URL: never hand it to revokeUrl.
        revokeUrl(oldUrl);
        activeUrlRef.current = null;
      }
      setMediaUrl(newUrl);
      setMediaType(admission.kind);
      if (physicalPath) {
        const mpvEpoch = ++mpvLoadEpochRef.current;
        mpvNativeLoadPendingRef.current = true;
        mpvActiveRef.current = false;
        setMpvNativeCaptureLoading(true);
        setMpvNativeActive(false);
        setIsMpvNative(false);
        setMpvTime(null);
        mpvTimeRef.current = null;
        setMpvDuration(null);
        setNativePictureReady(false);
        // The HTML element may still hold the previous frame while the native
        // engine opens this source. Keep capture disabled until load + pause
        // finish for this generation.
        void loadMpvPaused(physicalPath, mpvEpoch);
      } else {
        // A `blob:` object URL is not resolvable by libmpv: the element owns
        // this source and the engine is released so it cannot keep sounding
        // behind the webview.
        releaseMpv();
      }
      setMediaName(name);
      torrentSubtitleTextRef.current = null;
      setHasTorrentReferenceSubtitle(false);
      watchHistoryRecordedRef.current = false;
      youtubeVideoIdRef.current = null;
      setIsYouTubeStream(false);
      // Stage 2a: Store local file reference for tracker fingerprint computation.
      mediaFileRef.current = file;
      // Desktop (Tauri): the episode number comes from the native filename
      // parser. That parse is one IPC round-trip, so a newer pick can land
      // in between — the epoch guard drops a stale result instead of
      // starting a watch session for the wrong media.
      const selectEpoch = ++mediaSelectEpochRef.current;
      const parsed = await parseMediaFilenameDirect(name);
      if (selectEpoch !== mediaSelectEpochRef.current) return;
      startWatchSession(null, parsed.episode);
      if (file) {
        const sessionId = watchSessionRef.current?.sessionId;
        void computeVideoFingerprint(file).then((mediaId) => {
          if (!mediaId || watchSessionRef.current?.sessionId !== sessionId)
            return;
          attachWatchSessionMediaId(mediaId, parsed.episode);
        });
      }
    },
    [
      clearScreenshot,
      clearAudioClip,
      clearMiningPreview,
      torrentSession,
      jimakuAutoLoad,
      startWatchSession,
      loadMpvPaused,
      releaseMpv,
    ],
  );

  /** Browser pick, or a Tauri drop that also produced a `File`. */
  const handleMediaSelect = useCallback(
    (file: File) => {
      void selectLocalMedia({
        name: file.name,
        mime: file.type,
        bytes: file.size,
        file,
        physicalPath: resolvePhysicalPath(file),
      });
    },
    [selectLocalMedia],
  );

  /** Tauri native dialog pick: an absolute path with no `File` object. */
  const handleMediaSelectPath = useCallback(
    (path: string, name: string) => {
      void selectLocalMedia({
        name,
        mime: '',
        bytes: 0,
        file: null,
        physicalPath: path,
      });
    },
    [selectLocalMedia],
  );

  const handleSubtitleSelect = useCallback(
    (file: File) => {
      setSubtitleErrors([]);

      if (!isSubtitleFile(file)) {
        const p = dictRef.current.playerUI;
        setSubtitleErrors([
          {
            line: 0,
            message: `${p.unsupportedFormat}: .${getFileExtension(file)}`,
          },
        ]);
        trace('player', 'subtitle_select_rejected', {
          name: file.name,
          ext: getFileExtension(file),
        });
        return;
      }

      trace('player', 'subtitle_select', {
        name: file.name,
        bytes: file.size,
      });

      // BLOCKER 1: a manual subtitle pick must win over any in-flight jimaku
      // auto-load. Cancel the run so its pending fetch can't clobber this pick
      // once it resolves (docs/JIMAKU_SUBS.md §2.2-3).
      jimakuAutoLoad.cancel();

      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result;
        if (typeof content !== 'string') {
          setSubtitleErrors([
            { line: 0, message: dictRef.current.playerUI.failedToRead },
          ]);
          return;
        }
        // Route through the shared pipeline so the LazySync base refresh
        // (BLOCKER 2 fix) applies to manual picks too — otherwise the next
        // poll resurrects the stale base over this fresh pick.
        void handleSubtitleText(content);
      };
      reader.onerror = () => {
        setSubtitleErrors([
          { line: 0, message: dictRef.current.playerUI.failedToRead },
        ]);
      };
      reader.readAsText(file);
    },
    [jimakuAutoLoad.cancel, handleSubtitleText],
  );

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

  const handleCueClick = useCallback(
    (cue: SubtitleCue) => {
      const media = sharedMediaRef.current;
      if (!media) return;
      // Seek directly on the current HTML media element.
      const targetTime = cue.start;
      media.currentTime = targetTime;
      // Native engine: mirror the seek directly. An element that cannot decode
      // the source may never fire `seeking`, and mpv is the renderer that
      // actually moves the picture, so the cue jump must reach it either way.
      if (mpvActiveRef.current) void mpvSeek(targetTime);
      trace('player', 'cue_click', {
        cueId: cue.id,
        start: Math.round(cue.start * 100) / 100,
        end: Math.round(cue.end * 100) / 100,
        streaming: torrentSession.active,
      });
      // Note: do NOT call media.play() here. Setting currentTime preserves
      // the media's current playback state (stays paused if paused, continues
      // playing if playing) without forcing unwanted playback on click/tap.
      // P2: Reveal controls when clicking a cue while they are hidden
      controlsHandleRef.current?.show();
    },
    [torrentSession.active],
  );

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

  // --- Transport state ---
  // In native mode the engine is the source of truth: the HTML element is a
  // passive shim and its own play/pause events never reach libmpv (the
  // element-event funnel below is switched off there) nor the UI state.
  // Play/pause state updates only. The engine side lives in two places: the
  // media-element funnel effect below (every transition the element itself
  // reports) and `togglePlayback`, which drives libmpv directly for sources the
  // element cannot decode and therefore never reports.
  const handlePlay = useCallback(() => {
    watchSessionIsPlayingRef.current = true;
    watchSessionLastTimeRef.current = null;
    setIsPlaying(true);
    trace('player', 'play', { at: round2(traceMediaRef.current.time) });
  }, []);
  const handlePause = useCallback(() => {
    watchSessionIsPlayingRef.current = false;
    watchSessionLastTimeRef.current = null;
    setIsPlaying(false);
    trace('player', 'pause', { at: round2(traceMediaRef.current.time) });
  }, []);

  /**
   * Pause the transport for a capture / mining round.
   *
   * The element is always paused: it is the frame source for the capture and
   * must not run on while the round is open.
   *
   * Native mode: the element's `pause` event is a shim event and no longer
   * reaches libmpv (the funnel is off there), so the engine is paused
   * explicitly and the UI state is updated here as well.
   */
  const pauseTransport = useCallback(() => {
    sharedMediaRef.current?.pause();
    if (mpvActiveRef.current) {
      void mpvPause();
      handlePause();
    }
  }, [handlePause]);

  // Mobile: tap blurred overlay → pause media + reveal text
  const handleOverlayTouchTap = useCallback(() => {
    if (captionDisplayMode !== 'blurred') return;
    const media = sharedMediaRef.current;
    if (media && !media.paused) {
      // Native engine: the shim's `pause` event no longer reaches libmpv, so
      // the engine is paused explicitly through the shared helper.
      pauseTransport();
    }
    setIsOverlayRevealed(true);
    controlsHandleRef.current?.show();
  }, [captionDisplayMode, pauseTransport]);

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

  const recordWatchHistoryAtProgress = useCallback(
    async (time: number) => {
      if (watchHistoryRecordedRef.current) return;
      const media = sharedMediaRef.current;
      const duration = media?.duration ?? 0;
      const threshold =
        Number.isFinite(duration) && duration > 0
          ? Math.min(60, duration * 0.05)
          : 60;
      if (!Number.isFinite(time) || time < threshold) return;

      if (isYouTubeStream) {
        const videoId = youtubeVideoIdRef.current;
        const title = sanitizeDisplayName(mediaName);
        if (!videoId || !title) return;
        watchHistoryRecordedRef.current = true;
        await recordWatchHistory({
          mediaId: `youtube:${videoId}`,
          title,
          episode: null,
          source: 'youtube',
          anilistId: null,
          tmdbId: null,
          titleNative: null,
          posterUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
          posterStatus: 'ready',
        });
        return;
      }

      if (!trackerRuntime.mediaId || !mediaFileRef.current) return;
      const parsed = await parseMediaFilenameDirect(mediaName);
      const title = parsed.title || sanitizeDisplayName(mediaName);
      if (!title) return;
      watchHistoryRecordedRef.current = true;
      await recordWatchHistory({
        mediaId: trackerRuntime.mediaId,
        title,
        episode: parsed.episode,
        source: 'local',
        anilistId: jimakuMatchRef.current.anilistId,
        tmdbId: jimakuMatchRef.current.tmdbId,
        titleNative: jimakuMatchRef.current.titleNative,
      });
    },
    [isYouTubeStream, mediaName, trackerRuntime.mediaId],
  );

  const handleTimeUpdate = useCallback(
    (time: number) => {
      const active = findActiveCue(cues, time);
      setActiveCueId(active?.id ?? null);
      // Keep the trace label in sync with the real position.
      traceMediaRef.current.time = time;
      if (watchSessionIsPlayingRef.current) {
        const session = watchSessionRef.current;
        if (session) {
          session.watchMs += getPlaybackWatchDeltaMs(
            watchSessionLastTimeRef.current,
            time,
          );
        }
      }
      watchSessionLastTimeRef.current = watchSessionIsPlayingRef.current
        ? time
        : null;
      void recordWatchHistoryAtProgress(time);
    },
    [cues, recordWatchHistoryAtProgress],
  );

  // --- Native mpv clock (desktop) ---
  // WebView2 cannot decode every source libmpv can (HEVC 4:4:4 10-bit, FLAC in
  // MKV), so the element's `timeupdate` may never fire. While mpv renders, its
  // own `time-pos` becomes the clock for subtitles, the seek bar and the
  // tracker; `externalTime`/`externalDuration` feed the controls.
  const handleTimeUpdateRef = useRef(handleTimeUpdate);
  handleTimeUpdateRef.current = handleTimeUpdate;
  useEffect(() => {
    if (!isMpvNative) {
      setMpvTime(null);
      setMpvDuration(null);
      mpvTimeRef.current = null;
      setNativePictureReady(false);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const [time, duration] = await Promise.all([
        mpvGetTime(),
        mpvGetDuration(),
      ]);
      if (cancelled) return;
      if (duration !== null) setMpvDuration(duration);
      if (time !== null) {
        mpvTimeRef.current = time;
        setMpvTime(time);
        setNativePictureReady(true);
        handleTimeUpdateRef.current(time);
      }
    };
    void tick();
    const id = setInterval(tick, 200);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isMpvNative]);

  /**
   * Single play/pause entry point for every user transport trigger: the
   * control button, the Space shortcut and the desktop surface click.
   *
   * Native mode (mpv owns the media): the HTML element cannot decode the
   * source (HEVC 4:4:4 10-bit, FLAC in MKV), so it never fires `play`/`pause`
   * and the element-event funnel above can never reach libmpv — a bare
   * `media.play()` would leave the picture and the sound paused forever. The
   * intent therefore goes straight to the engine and `isPlaying` is updated
   * here, because no element event will ever report it. The element is still
   * nudged (it is muted in native mode) so it stays a live frame source for
   * mining captures; an undecodable element rejects harmlessly.
   * No seek is sent to the engine: mpv's own position is authoritative in
   * native mode, and a seek to the element's `currentTime` would restart an
   * undecodable source from 0:00.
   *
   * HTML mode: the element is the transport and its own events keep updating
   * `isPlaying`, so the element's real `paused` flag decides the intent. That
   * also makes one click replay after `ended`, where no pause event fires.
   */
  const togglePlayback = useCallback(() => {
    const media = sharedMediaRef.current;
    if (mpvActiveRef.current) {
      if (isPlayingRef.current) {
        void mpvPause();
        media?.pause();
        handlePause();
      } else {
        void mpvPlay();
        void media?.play().catch(() => {});
        handlePlay();
      }
      return;
    }
    if (!media) return;
    if (media.paused) {
      void media.play().catch(() => {});
    } else {
      media.pause();
    }
  }, [handlePlay, handlePause]);

  const handleLoaded = useCallback(() => {
    setIsLoading(false);
    setLoadError(null);
    trace('player', 'media_loaded', {
      name: traceMediaRef.current.name,
      duration: traceMediaRef.current.duration,
    });
  }, []);

  const handleError = useCallback((error: string) => {
    setIsLoading(false);
    setLoadError(error);
    trace('player', 'media_error', {
      name: traceMediaRef.current.name,
      at: round2(traceMediaRef.current.time),
      message: error,
    });
    // Clear seek buffering on error — the overlay is meaningless if the
    // element has errored.
    setIsSeekBuffering(false);
    // An errored element never becomes playable, so the torrent start overlay
    // must not linger.
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
    const media = displayMediaType === 'video' ? videoRef.current : null;
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
  }, [displayMediaType, mediaUrl]);

  // --- Desktop native engine: mirror transport into libmpv ---
  // Every seek path that touches the element (controls slider, scrub, condensed
  // mode auto seek, mining restore) ends in `media.currentTime = …`, so the
  // element's own `seeking` event is a single funnel for those. The same
  // reasoning applies to pause paths that end in `media.pause()` (mining
  // auto-pause, mobile blur pause, error handling).
  // User play/pause does NOT rely on these events: an undecodable source never
  // fires them, so `togglePlayback` drives the engine directly.
  // `mpvSeek` / `mpvPlay` / `mpvPause` are no-ops outside Tauri.
  //
  // NATIVE MODE EXCEPTION: while libmpv owns the media the element is a
  // passive shim and the mirror is switched off completely. The element's
  // position is not the engine's position — WebView2 cannot decode HEVC
  // 4:4:4 10-bit / FLAC, so the element can sit at 0:00 while the engine
  // plays on — and mirroring it dragged the engine back to that stale
  // position. Every transport intent is sent to the engine explicitly at its
  // own site (togglePlayback, controls slider, cue click, condensed seek,
  // keyboard Home, mining pause) instead of through the element's events.
  useEffect(() => {
    const media = mediaType === 'video' ? videoRef.current : audioRef.current;
    if (!media) return;
    // Native mode: the element never drives the engine (see above).
    if (isMpvNative) return;
    // Gate every mirror on `mpvActiveRef`: mpv only holds a local file, so a
    // relay / `blob:` source must never seek or pause whatever the engine
    // happens to hold.
    const onSeeking = () => {
      if (!mpvActiveRef.current) return;
      void mpvSeek(media.currentTime);
    };
    const onPlay = () => {
      if (!mpvActiveRef.current) return;
      // Align the engine with the element BEFORE it is allowed to make sound:
      // the engine sits paused at its own position (0:00 after a fresh load),
      // so a bare `mpvPlay` would start the audio from the wrong offset. The
      // seek is awaited so the two commands cannot race in the IPC queue.
      void mpvSeek(media.currentTime).then(() => mpvPlay());
    };
    const onPause = () => {
      if (!mpvActiveRef.current) return;
      void mpvPause();
    };
    media.addEventListener('seeking', onSeeking);
    media.addEventListener('play', onPlay);
    media.addEventListener('pause', onPause);
    return () => {
      media.removeEventListener('seeking', onSeeking);
      media.removeEventListener('play', onPlay);
      media.removeEventListener('pause', onPause);
    };
  }, [mediaType, mediaUrl, isMpvNative]);

  // --- Torrent start buffering: monitor the initial playable frame ---
  // The native relay can wait for torrent pieces after the video element
  // mounts, before its first frame is available.
  // After 2 s of that state show the "Preparing video…" overlay (the delay
  // avoids flashing for fast starts).
  //
  // Clear on the FIRST PAINTED FRAME, not on readyState or 'playing'.
  // On rVFC browsers even a paused element with HAVE_CURRENT_DATA can show
  // a 0x0 black frame, so the 1 s re-check uses a presented-frame flag and
  // the overlay itself requests rVFC. Non-rVFC browsers have no frame
  // metadata: the re-check uses HAVE_FUTURE_DATA (3) or active playback,
  // while loadeddata/canplay/playing keep the immediate fallback. The
  // torrent relay recovery assigns src + calls load() without React state,
  // so those media events are the only signals while
  // the element is still PAUSED. Once cleared, a source-scoped ref latch
  // stops a later 'waiting' (or a phase re-run) from re-arming the overlay.
  // Both the 2 s debounce and the 3 s safety bound are armed once, at the
  // first arm; later `waiting` bursts never postpone them.
  // Seek buffering deliberately keeps its own canplay-based clearing.
  useEffect(() => {
    // Source-scoped flags live in refs and reset only when the actual source
    // changes.
    // A new torrent relay URL resets the source-scoped latch.
    const source = displayMediaUrl || '';
    if (startBufferingExhaustedRef.current.source !== source) {
      startBufferingExhaustedRef.current = { source, exhausted: false };
      realFramePresentedRef.current = { source, presented: false };
    }
    const media = displayMediaType === 'video' ? videoRef.current : null;
    if (!media) return;
    if (!torrentSession.active || !torrentSession.mediaUrl) return;

    // 2 = HAVE_CURRENT_DATA, 3 = HAVE_FUTURE_DATA per the HTMLMediaElement
    // spec. rVFC browsers never trust readyState for the start overlay:
    // only presented pixels are authoritative.
    const HAVE_CURRENT_DATA = 2;
    const HAVE_FUTURE_DATA = 3;
    const hasRVFC =
      // both are always present together per spec, but defensive check
      // costs nothing
      typeof media.requestVideoFrameCallback === 'function' &&
      typeof media.cancelVideoFrameCallback === 'function';
    // rVFC: only real presented pixels end the wait. Non-rVFC: no frame
    // metadata exists, so HAVE_FUTURE_DATA or an active playback is the
    // best available signal (HAVE_CURRENT_DATA alone is not enough).
    const hasStartPlayableSignal = () =>
      hasRVFC
        ? realFramePresentedRef.current.presented
        : media.readyState >= HAVE_FUTURE_DATA || !media.paused;

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

    // Single clearing path for every end-of-start-buffering signal, so the
    // in-effect flags, both timers and the rendered state never drift apart.
    // Latching here (not only at the 3 s bound) stops a later 'waiting'
    // from resurrecting the start overlay after this source has shown a
    // real frame. The latch is source-scoped and survives effect re-runs.
    const clearStartBuffering = () => {
      startBufferingExhaustedRef.current = { source, exhausted: true };
      bufferingShown = false;
      clearStartBufferingTimers();
      setIsStartBuffering(false);
    };

    const armStartBuffering = () => {
      // Once a real frame has been presented (or the safety bound fired)
      // the overlay must never reappear for this job/source — the user
      // keeps the controls; later stalls belong to the seek overlay.
      if (startBufferingExhaustedRef.current.exhausted) return;
      // rVFC: readyState/loadeddata/playing are NOT proof of presented
      // pixels. Non-rVFC: HAVE_FUTURE_DATA or an active playback is.
      if (hasStartPlayableSignal()) return;
      // Both timers are armed ONCE, at the first arm. A burst of short
      // `waiting` events must neither restart the 2 s debounce nor push
      // the 3 s safety bound forward: clearing both timers here used to
      // cancel the bound (or, before it was ever armed, stop it from being
      // armed at all), leaving the overlay unbounded.
      if (
        startBufferingDelayRef.current !== null ||
        startBufferingSafetyRef.current !== null
      ) {
        return;
      }
      startBufferingSafetyRef.current = setTimeout(() => {
        startBufferingSafetyRef.current = null;
        // Give up on this source through the single path, so the latch
        // and bufferingShown stay in sync with the rendered state.
        clearStartBuffering();
      }, START_BUFFERING_SAFETY_MS);
      startBufferingDelayRef.current = setTimeout(() => {
        startBufferingDelayRef.current = null;
        // Re-check after the delay. A paused element can report
        // HAVE_CURRENT_DATA (loadeddata) with a 0x0 black frame still on
        // screen; on rVFC browsers ONLY a real presented frame ends the
        // wait, so readyState must not suppress the overlay here.
        if (startBufferingExhaustedRef.current.exhausted) return;
        if (hasStartPlayableSignal()) return;
        setIsStartBuffering(true);
        bufferingShown = true;
        // Wait for the first PAINTED frame even if loadeddata / canplay
        // already arrived before the debounce fired.
        if (hasRVFC) {
          requestFirstFrame();
        }
      }, START_BUFFERING_DELAY_MS);
    };

    // First visible frame: rVFC fires only after a frame has literally been
    // painted, with the presented frame's media pixel size in meta.
    // On capable browsers this is the ONLY clearing path — loadeddata,
    // canplay and playing merely request the callback below. An audio-first
    // .part stream can report HAVE_CURRENT_DATA and even fire 'playing'
    // while a 0x0 black frame is on screen; readyState/playing alone must
    // not clear there. Without the API (rVFC undefined) the paths below
    // keep the immediate 'ready' / 'playing' fallback.
    let rvfcHandle: number | null = null;
    const onFirstFrame = (
      _now: DOMHighResTimeStamp,
      meta: VideoFrameCallbackMetadata,
    ) => {
      // Idempotent: safe to call even if already cleared.
      rvfcHandle = null; // consumed
      // Chromium can present a black/empty frame (width=0/height=0)
      // before the first real video sample arrives (audio-first
      // interleave in .part streams). Only a frame with actual media
      // pixels ends the "black screen": clearStartBuffering also latches
      // this source as done.
      if (meta && meta.width > 0 && meta.height > 0) {
        realFramePresentedRef.current = { source, presented: true };
        clearStartBuffering();
        return;
      }
      // Empty frame (still black): keep the overlay up and wait for the
      // NEXT frame. Re-register only while the overlay is actually shown
      // and the 3 s safety bound is still armed — that bound is the
      // ultimate upper limit, so this cannot loop forever.
      // One diagnostic line per black frame: a real-device .part interleave
      // is otherwise invisible in the logs.
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
      rvfcHandle = media.requestVideoFrameCallback(
        onFirstFrame as VideoFrameRequestCallback,
      );
    };
    const onPlayingRVFC = () => {
      // Already cleared (picture on screen / safety bound) — skip the
      // pointless re-registration/API calls on later transitions.
      if (!bufferingShown || startBufferingExhaustedRef.current.exhausted)
        return;
      // With rVFC the painted frame is authoritative; playing alone must
      // not clear. Re-register the frame callback on each playback
      // transition so a frame painted during that segment is caught.
      if (hasRVFC) {
        requestFirstFrame();
        return;
      }
      // Fallback path (non-rVFC browsers): no frame callback to wait for.
      clearStartBuffering();
    };

    // Torrent recovery assigns src + calls load() without React state, so
    // this effect does NOT re-run
    // when the first frame lands. loadeddata / canplay are the signals that
    // frame data exists while the element is still PAUSED (autoplay blocked
    // or user-paused). readyState >= HAVE_CURRENT_DATA only guarantees the
    // current frame's DATA is available — an audio-first .part can reach it
    // with a 0x0 black frame on screen. On rVFC browsers these events
    // merely REQUEST the first painted frame: onFirstFrame clears the
    // overlay the instant it sees real pixels, even while paused. Without
    // rVFC there is no frame metadata, so clear immediately as before.
    const onMediaReady = () => {
      // A latched source never needs another frame registration.
      if (startBufferingExhaustedRef.current.exhausted) return;
      // rVFC: readyState is not authoritative — always wait for the
      // painted frame, even if this event carries no current-frame data.
      if (hasRVFC) {
        requestFirstFrame();
        return;
      }
      // Non-rVFC fallback: no frame metadata, so a loadeddata/canplay with
      // current-frame data is the best available signal.
      if (media.readyState < HAVE_CURRENT_DATA) return;
      clearStartBuffering();
    };

    // If the element is already playing when the effect runs (e.g. a
    // rapid ready→playing transition before the observer attaches), arm
    // the rVFC callback (or clear immediately for non-rVFC browsers).
    if (!media.paused && media.currentTime > 0) {
      if (hasRVFC) {
        requestFirstFrame();
      } else {
        clearStartBuffering();
      }
    }

    media.addEventListener('waiting', armStartBuffering);
    media.addEventListener('playing', onPlayingRVFC);
    media.addEventListener('loadeddata', onMediaReady);
    media.addEventListener('canplay', onMediaReady);
    // Initial state: arm only while no playable signal is present. On rVFC
    // browsers a paused element with readyState >= 2 but no painted frame
    // still needs guarding (audio-first .part black screen).
    if (!hasStartPlayableSignal()) {
      armStartBuffering();
    }

    return () => {
      media.removeEventListener('waiting', armStartBuffering);
      media.removeEventListener('playing', onPlayingRVFC);
      media.removeEventListener('loadeddata', onMediaReady);
      media.removeEventListener('canplay', onMediaReady);
      if (
        rvfcHandle !== null &&
        typeof media.cancelVideoFrameCallback === 'function'
      ) {
        media.cancelVideoFrameCallback(rvfcHandle);
      }
      clearStartBufferingTimers();
      bufferingShown = false;
      setIsStartBuffering(false);
    };
    // Torrent URL changes re-run this effect; cleanup cancels pending frame
    // callbacks and timers before observing the next relay source.
  }, [
    displayMediaType,
    torrentSession.active,
    torrentSession.mediaUrl,
    displayMediaUrl,
  ]);

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
    trace('player', 'playback_rate', { rate });
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
      trace('player', 'play_mode', { from: prevMode, to: mode });

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
          isCondensedSeekingRef.current = true;
          const condensedTarget = next.start;
          media.currentTime = condensedTarget;
          // Native engine: the element is a passive shim there — its `seeking`
          // event no longer reaches libmpv, so the engine is seeked directly.
          if (mpvActiveRef.current) void mpvSeek(condensedTarget);
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

  // Trace: the media element is the single funnel for every position change
  // (slider scrub, cue click, condensed/fast-forward jump), so seek and end
  // are recorded here instead of at each call site. `from` comes from the
  // last timeupdate so a trace line reads "12.4s → 88.1s".
  useEffect(() => {
    const media = mediaType === 'video' ? videoRef.current : audioRef.current;
    if (!media) return;

    let from = media.currentTime;
    const onSeeking = () => {
      from = traceMediaRef.current.time;
    };
    const onSeeked = () => {
      trace('player', 'seek', {
        from: round2(from),
        to: round2(media.currentTime),
        playMode,
      });
      traceMediaRef.current.time = media.currentTime;
    };
    const onEnded = () => {
      trace('player', 'ended', {
        name: traceMediaRef.current.name,
        duration: round2(Number.isFinite(media.duration) ? media.duration : 0),
      });
    };
    const onLoadedMetadata = () => {
      traceMediaRef.current.duration = Number.isFinite(media.duration)
        ? round2(media.duration)
        : null;
    };

    media.addEventListener('seeking', onSeeking);
    media.addEventListener('seeked', onSeeked);
    media.addEventListener('ended', onEnded);
    media.addEventListener('loadedmetadata', onLoadedMetadata);
    return () => {
      media.removeEventListener('seeking', onSeeking);
      media.removeEventListener('seeked', onSeeked);
      media.removeEventListener('ended', onEnded);
      media.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
    // `displayMediaUrl` re-mounts the element (new src, recovered session) and
    // `loadError` marks the recovery of a failed one: without both here the
    // listeners would stay bound to the detached element and every seek/ended
    // after a recovery would go untraced.
  }, [mediaType, playMode, displayMediaUrl, loadError]);

  // Keep the trace label's media name current (state is the source of truth).
  useEffect(() => {
    traceMediaRef.current.name = mediaName;
  }, [mediaName]);

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
    if (!displayMediaUrl || !activeCueId || !audioClipCaps.supported) return;
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
      mediaUrl: displayMediaUrl,
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
    displayMediaUrl,
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
    async (syncedText: string) => {
      const result = await parseSubtitleDirect(syncedText);
      subDelayStateRef.current = rebaseSubDelay(
        subDelayStateRef.current,
        result.cues,
      );
      setCues(subDelayCues(subDelayStateRef.current));
      setSubtitleErrors(result.errors);
      setActiveCueId(null);
      subtitleTextRef.current = syncedText;
      // Both supported sync paths converge here — one success toast.
      notifySubtitleSyncSuccess(dictRef.current.playerUI.subtitleSyncSuccess);
    },
    [setCues, setSubtitleErrors, setActiveCueId],
  );

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
    const mode = readPlayerPreferences().subtitleSyncMode ?? 'auto';
    const referenceText = torrentSubtitleTextRef.current;
    if (isYouTubeStream) return;

    void runSync(async () => {
      if (torrentSession.active && mode === 'audio') {
        notifySubtitleSyncError(
          dictRef.current.playerUI.subtitleSyncAudioUnavailable,
        );
        return;
      }
      if (torrentSession.active || mode === 'subtitle') {
        if (!referenceText) {
          notifySubtitleSyncError(
            dictRef.current.playerUI.subtitleSyncNoReference,
          );
          return;
        }
        const [parsed, reference] = await Promise.all([
          parseSubtitleDirect(text),
          parseSubtitleDirect(referenceText),
        ]);
        const synced = await syncSubtitleToReference(
          text,
          parsed.format ?? 'vtt',
          referenceText,
          reference.format ?? 'vtt',
          { onProgress: () => {} },
        );
        await applySyncedSubtitle(synced);
        return;
      }
      const parsed = await parseSubtitleDirect(text);
      const inputFormat = parsed.format ?? 'vtt';
      if (!mediaUrl) {
        notifySubtitleSyncError(
          dictRef.current.playerUI.subtitleSyncNoReference,
        );
        return;
      }
      const response = await fetch(mediaUrl);
      if (!response.ok) throw new Error('media could not be read for subtitle sync');
      const { samples, sampleRate } = await decodeToMono16k(
        await response.arrayBuffer(),
      );
      const synced = await syncSubtitleToAudio(
        text,
        inputFormat,
        samples,
        sampleRate,
        { onProgress: () => {} },
      );
      await applySyncedSubtitle(synced);
    });
  }, [
    applySyncedSubtitle,
    isYouTubeStream,
    mediaUrl,
    runSync,
    torrentSession.active,
  ]);

  /**
   * Apply a sub-delay offset in seconds (docs §9.3). The native engine hands
   * the value over as-is — no rounding, no sign conversion — and the cues
   * re-render immediately because the offset is a pure re-shift of the
   * untouched base (no audio analysis, so no stutter). An invalid or
   * unchanged offset is a no-op.
   */
  const applySubDelayOffset = useCallback((offsetSeconds: number) => {
    const next = setSubDelayOffset(subDelayStateRef.current, offsetSeconds);
    if (next === subDelayStateRef.current) return;
    subDelayStateRef.current = next;
    setCues(subDelayCues(next));
    setActiveCueId(null);
    // Desktop native engine: mirror the offset so mpv renders the same timings.
    // Echoing an offset the engine itself pushed is idempotent (same value).
    // Skipped while the engine holds no matching media (local `blob:` pick).
    if (mpvActiveRef.current) void mpvSetSubDelay(next.offsetSeconds);
  }, []);

  // Native engine sub-delay handoff: the engine computes the offset and pushes
  // it across the island boundary, so the Player never runs the heavy JS
  // analysis LazySync needs.
  useEffect(
    () => listenForSubDelay(applySubDelayOffset),
    [applySubDelayOffset],
  );

  /** Magnet audio sync: dialog handed us decoded PCM — run sub-to-audio. */
  const handleMine = useCallback(
    async (overrideCue?: SubtitleCue) => {
      if (!displayMediaUrl) return;
      // Guard: refuse if any standalone capture (AM-2 screenshot / AM-3 audio) or AM-4 mining is in flight
      if (
        isCapturingRef.current ||
        isRecordingAudioRef.current ||
        isMiningRef.current
      )
        return;

      const targetCue = overrideCue ?? cues.find((c) => c.id === activeCueId);
      if (!targetCue) return;

      trace('player', 'mine_start', {
        cueId: targetCue.id,
        start: round2(targetCue.start),
        end: round2(targetCue.end),
        rowMining: overrideCue !== undefined,
        name: traceMediaRef.current.name,
      });

      const media = sharedMediaRef.current;

      // Row mining: seek the visible media to the target cue start so
      // the screenshot/video-clip frame reflects the mined timestamp.
      if (overrideCue && media) {
        pauseTransport();
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

      // Native mode: the engine's position is the real one — the element can
      // sit at a stale position when WebView2 cannot decode the source.
      const snapshotTime = mpvActiveRef.current
        ? (mpvTimeRef.current ?? 0)
        : (media?.currentTime ?? 0);
      miningSnapshotTimeRef.current = snapshotTime;
      pauseTransport();

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
              mediaUrl: displayMediaUrl,
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
        mediaUrl: displayMediaUrl,
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
      displayMediaUrl,
      activeCueId,
      cues,
      mediaType,
      mediaName,
      mediaMode,
      playbackRate,
      pauseTransport,
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
        !displayMediaUrl ||
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
              mediaUrl: displayMediaUrl!,
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
          mediaUrl: displayMediaUrl,
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
      displayMediaUrl,
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
    !!displayMediaUrl &&
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
    !!displayMediaUrl &&
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

  // The settings page (/settings/) persists subtitle changes via the shared
  // player-prefs store. This listener only updates the in-memory overlay so an
  // already-mounted player reacts immediately to a settings-bridge event.
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
              mediaUrl: displayMediaUrl!,
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
      displayMediaUrl,
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
    if (exportMode === 'new') {
      const wordField = miningDraftFields.find((f) => f.key === 'word');
      if (
        prefs.fields.word &&
        (!wordField || wordField.value.trim().length === 0)
      ) {
        return d.exportSendDisabledNoWord;
      }
    }
    return null;
  }, [isExporting, ankiSession, miningDraftFields, exportMode]);

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

      // Append the sentence to the current watch session. IndexedDB may not
      // have the initial record yet; the in-memory session remains authoritative
      // until the next persistence flush.
      const currentWatchSession = watchSessionRef.current;
      if (currentWatchSession && sentence?.trim()) {
        await appendWatchSessionSentence(sentence);
      }

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
      // The visible History panel reads from here. The write helper itself
      // dispatches 'entei:tracker-archive-changed' so MiningHistoryPanel
      // (in the player and on /tracker/) refreshes without any extra wiring.
      await recordTrackerMiningArchive({
        mediaId: trackerRuntime.mediaId,
        subtitleId: trackerRuntime.subtitleId,
        learningSetId: trackerRuntime.learningSetId,
        displayName: mediaName,
        rangeStart: miningRangeStart,
        rangeEnd: miningRangeEnd,
        sentence: sentence ?? '',
      });

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
    appendWatchSessionSentence,
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
    setExportSuccess(false);
    trace('player', 'export_start', {
      mode: exportMode,
      deck: prefs.deck,
      noteType: prefs.noteType,
      tags: exportTags.length,
      hasScreenshot: miningScreenshotBlobRef.current !== null,
      hasAudio: miningAudioBlobRef.current !== null,
    });

    const abortController = new AbortController();
    exportAbortControllerRef.current = abortController;

    const client = new AnkiExportClient(
      ankiSession.endpoint,
      ankiSession.apiKey || undefined,
    );

    /** Close mining preview after successful export.
     *  Does NOT bump exportEpochRef — the `finally` block handles
     *  setIsExporting(false) via its epoch guard. */
    const closeAfterExportSuccess = (toastLabel: string) => {
      notifyMiningExportSuccess(toastLabel);
      trace('player', 'export_success', {
        mode: exportMode,
        deck: prefs.deck,
        noteType: prefs.noteType,
        tags: exportTags.length,
      });
      setIsMiningPreviewOpen(false);
      // Clean up mining state (normally done by handleMiningPreviewClose,
      // but we must not bump exportEpochRef here).
      miningScreenshotBlobRef.current = null;
      miningAudioBlobRef.current = null;
      replaceMiningScreenshotUrl(null);
      replaceMiningAudioUrl(null);
      exportAbortControllerRef.current = null;
      miningAbortControllerRef.current?.abort();
      miningAbortControllerRef.current = null;
      mediaRecaptureAbortRef.current?.abort();
      mediaRecaptureAbortRef.current = null;
      setExportSuccess(false);
    };

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

        // canAddNotes check — new card allows duplicates within the target deck.
        // checkAllModels must be sent explicitly: AnkiconnectAndroid's
        // NoteRequest.readNoteOptions() reads it unconditionally when
        // deckName is present and NPEs (NullPointerException) if absent.
        const noteOptions = {
          allowDuplicate: true,
          duplicateScope: 'deck' as const,
          duplicateScopeOptions: {
            deckName: prefs.deck,
            checkChildren: false,
            checkAllModels: false,
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
          notifyMiningExportError(d.exportRejectedCanAdd);
          return;
        }

        // Upload media (screenshot/video) if mapped — branch on captured blob type
        const fieldMapping = prefs.fields;
        // AnkiDroid mode is cached per-client (WeakMap) — paid exactly once
        // per export session. Must be resolved before the first storeMediaFile
        // so the markup uses the right filename source.
        const ankiDroidModeNew = await detectAnkiDroidMode(client);
        if (fieldMapping.image && miningScreenshotBlobRef.current) {
          const isVideo = capturedMediaTypeRef.current === 'video';
          const blob = miningScreenshotBlobRef.current;
          const filename = await generateMediaFilename(
            isVideo ? 'entei_video' : 'entei_screenshot',
            isVideo ? 'webm' : 'jpg',
            blob,
          );
          const base64 = await blobToBase64(blob);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          const storedFilename = await client.storeMediaFile(
            filename,
            base64,
            abortController.signal,
          );
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          if (fieldMapping.image && !noteFields[fieldMapping.image]) {
            noteFields[fieldMapping.image] = buildMediaMarkup(
              isVideo ? 'video' : 'image',
              filename,
              storedFilename,
              ankiDroidModeNew,
            );
          }
        }

        if (fieldMapping.audio && miningAudioBlobRef.current) {
          const blob = miningAudioBlobRef.current;
          const filename = await generateMediaFilename(
            'entei_audio',
            'webm',
            blob,
          );
          const base64 = await blobToBase64(blob);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          const storedFilename = await client.storeMediaFile(
            filename,
            base64,
            abortController.signal,
          );
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          if (fieldMapping.audio && !noteFields[fieldMapping.audio]) {
            noteFields[fieldMapping.audio] = buildMediaMarkup(
              'sound',
              filename,
              storedFilename,
              ankiDroidModeNew,
            );
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
          notifyMiningExportError(d.exportError);
          return;
        }

        setExportSuccess(true);
        // Fire-and-forget: IndexedDB write must never block/fail Anki success
        void writeHistory();
        // Toast + close modal after successful new-card export
        const enteredWordNew =
          miningDraftFields.find((f) => f.key === 'word')?.value.trim() || '';
        const wordLabelNew = enteredWordNew || mediaName;
        closeAfterExportSuccess(
          d.miningExportAddedToast.replace('{word}', () => wordLabelNew),
        );
      } else if (exportMode === 'update') {
        // One-click update: findNotes → notesInfo → validate → media → updateNoteFields
        const noteIds = await client.findNotes(
          'added:1',
          abortController.signal,
        );
        if (!mountedRef.current || exportEpochRef.current !== epoch) return;
        if (abortController.signal.aborted) return;

        if (!noteIds || noteIds.length === 0) {
          notifyMiningExportError(d.exportNoCandidate);
          return;
        }

        const maxId = Math.max(...noteIds);
        const info = await client.notesInfo([maxId], abortController.signal);
        if (!mountedRef.current || exportEpochRef.current !== epoch) return;
        if (abortController.signal.aborted) return;

        if (!info || info.length === 0) {
          notifyMiningExportError(d.exportNoCandidate);
          return;
        }

        const candidate = info[0];
        if (!candidate) {
          notifyMiningExportError(d.exportNoCandidate);
          return;
        }

        // Validate target model matches saved note type
        if (candidate.modelName !== prefs.noteType) {
          notifyMiningExportError(
            `${d.exportError} (Model mismatch: expected "${prefs.noteType}", got "${candidate.modelName}")`,
          );
          return;
        }

        // Build update fields from draft (text fields only)
        // Skip empty/whitespace-only fields to preserve existing Anki content.
        const isDenChou = prefs.noteType === 'DenChou';
        const updateFields: Record<string, string> = {};
        const seen = new Set<string>();
        for (const f of miningDraftFields) {
          if (f.key === 'image' || f.key === 'audio') continue;
          if (seen.has(f.physicalName)) continue;
          seen.add(f.physicalName);
          if (f.value.trim() === '') continue;
          updateFields[f.physicalName] = isDenChou
            ? wrapDenChouField(f.key, f.value)
            : f.value;
        }

        // Upload media if available (never wipe existing) — branch on captured type
        // AnkiDroid detection cached per-client (WeakMap) — same client as new
        // path, so the second call is a no-op cache hit.
        const ankiDroidModeUpd = await detectAnkiDroidMode(client);
        if (prefs.fields.image && miningScreenshotBlobRef.current) {
          const isVideo = capturedMediaTypeRef.current === 'video';
          const blob = miningScreenshotBlobRef.current;
          const filename = await generateMediaFilename(
            isVideo ? 'entei_video' : 'entei_screenshot',
            isVideo ? 'webm' : 'jpg',
            blob,
          );
          const base64 = await blobToBase64(blob);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          const storedFilename = await client.storeMediaFile(
            filename,
            base64,
            abortController.signal,
          );
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          if (prefs.fields.image) {
            updateFields[prefs.fields.image] = buildMediaMarkup(
              isVideo ? 'video' : 'image',
              filename,
              storedFilename,
              ankiDroidModeUpd,
            );
          }
        }

        if (prefs.fields.audio && miningAudioBlobRef.current) {
          const blob = miningAudioBlobRef.current;
          const filename = await generateMediaFilename(
            'entei_audio',
            'webm',
            blob,
          );
          const base64 = await blobToBase64(blob);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          const storedFilename = await client.storeMediaFile(
            filename,
            base64,
            abortController.signal,
          );
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          if (prefs.fields.audio) {
            updateFields[prefs.fields.audio] = buildMediaMarkup(
              'sound',
              filename,
              storedFilename,
              ankiDroidModeUpd,
            );
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
        // Toast + close modal after successful update export
        const enteredWordUpd =
          miningDraftFields.find((f) => f.key === 'word')?.value.trim() || '';
        const existingWordField = prefs.fields.word
          ? candidate.fields[prefs.fields.word]?.value.trim() || ''
          : '';
        const wordLabelUpd = enteredWordUpd || existingWordField || mediaName;
        closeAfterExportSuccess(
          d.miningExportUpdatedToast.replace('{word}', () => wordLabelUpd),
        );
      }
    } catch (e) {
      if (!mountedRef.current || exportEpochRef.current !== epoch) return;
      if (e instanceof DOMException && e.name === 'AbortError') {
        // Aborted — don't set error
        trace('player', 'export_aborted', { mode: exportMode });
        return;
      }
      console.error('[AnkiExport] Export failed:', e);
      const rawMessage = e instanceof Error ? e.message : String(e);
      traceError('player', 'export_failed', e, { mode: exportMode });
      notifyMiningExportError(rawMessage || d.exportError);
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
        // AnkiDroid detection costs one apiReflect round-trip per client
        // instance. The new/update paths above share a client and cache
        // hits; this append path constructs its own fresh client (~3912),
        // so its first detectAnkiDroidMode call pays one probe.
        const ankiDroidModeApp = await detectAnkiDroidMode(client);

        if (prefs.fields.image && miningScreenshotBlobRef.current) {
          const isVideo = capturedMediaTypeRef.current === 'video';
          const blob = miningScreenshotBlobRef.current;
          const filename = await generateMediaFilename(
            isVideo ? 'entei_video' : 'entei_screenshot',
            isVideo ? 'webm' : 'jpg',
            blob,
          );
          const base64 = await blobToBase64(blob);
          if (!mountedRef.current || appendEpochRef.current !== epoch)
            return { succeeded, failed };
          if (abortController.signal.aborted) return { succeeded, failed };
          const storedFilename = await client.storeMediaFile(
            filename,
            base64,
            abortController.signal,
          );
          if (!mountedRef.current || appendEpochRef.current !== epoch)
            return { succeeded, failed };
          imageMarkup = buildMediaMarkup(
            isVideo ? 'video' : 'image',
            filename,
            storedFilename,
            ankiDroidModeApp,
          );
        }

        if (prefs.fields.audio && miningAudioBlobRef.current) {
          const blob = miningAudioBlobRef.current;
          const filename = await generateMediaFilename(
            'entei_audio',
            'webm',
            blob,
          );
          const base64 = await blobToBase64(blob);
          if (!mountedRef.current || appendEpochRef.current !== epoch)
            return { succeeded, failed };
          if (abortController.signal.aborted) return { succeeded, failed };
          const storedFilename = await client.storeMediaFile(
            filename,
            base64,
            abortController.signal,
          );
          if (!mountedRef.current || appendEpochRef.current !== epoch)
            return { succeeded, failed };
          audioMarkup = buildMediaMarkup(
            'sound',
            filename,
            storedFilename,
            ankiDroidModeApp,
          );
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
      // Use the effective media URL, which may be a torrent relay rather than
      // the local File URL.
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
        // Delegated, never `media.play()`: in native mode the element cannot
        // decode the source, so it would leave libmpv paused forever.
        togglePlayback();
      }
    },
    [isLoading, loadError, displayMediaUrl, isTouchDevice, togglePlayback],
  );

  // --- Keyboard shortcuts ---
  /**
   * Home shortcut seek. Native mode: the element is a passive shim there, so
   * the engine has to be seeked explicitly — the element's `seeking` event no
   * longer reaches libmpv.
   */
  const handleShortcutSeek = useCallback((seconds: number) => {
    const media = sharedMediaRef.current;
    if (media) media.currentTime = seconds;
    if (mpvActiveRef.current) void mpvSeek(seconds);
  }, []);

  useKeyboardShortcuts({
    videoRef: sharedMediaRef,
    cues,
    activeCueId,
    playbackRate,
    setPlaybackRate: handlePlaybackRateChange,
    onCueClick: handleCueClick,
    onTogglePlayback: togglePlayback,
    onSeekTo: handleShortcutSeek,
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
  // to hide TopBar and make the player fill 100dvh.
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

  // --- Mobile chrome auto-hide ---
  // Mirror the audio player (`entei-audio-loaded` in AudioPlayer.tsx): once
  // media is loaded — local file, magnet/torrent session, or YouTube job —
  // mark <html> so player.css hides the mobile top bar on <768px. The marker
  // is removed on unmount and whenever the media is cleared, so the entry
  // state (no media) keeps its chrome. The DOM stays mounted (SEO/app shell).
  const hasLoadedMedia = hasMedia || torrentSession.active;
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('entei-video-loaded', hasLoadedMedia);
    return () => {
      root.classList.remove('entei-video-loaded');
    };
  }, [hasLoadedMedia]);

  // --- Layout class ---
  const layoutClass = `entei-player-layout${isSubtitlePanelVisible ? ' entei-player-layout--with-panel' : ' entei-player-layout--no-panel'}`;

  // --- Mobile sticky player height observer ---
  // Sets --entei-sticky-player-height on the player container so the mobile
  // tab bar (.entei-right-panel-tabs-bar) sticks exactly beneath the sticky video.
  useEffect(() => {
    if (!hasMedia) return;
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === 'undefined') return;

    const updateHeight = (h: number) => {
      mediaContainerRef.current?.style.setProperty(
        '--entei-sticky-player-height',
        `${Math.round(h)}px`,
      );
    };

    updateHeight(surface.getBoundingClientRect().height);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height =
          entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        updateHeight(height);
      }
    });

    ro.observe(surface);
    return () => {
      ro.disconnect();
      mediaContainerRef.current?.style.removeProperty(
        '--entei-sticky-player-height',
      );
    };
  }, [hasMedia, displayMediaType, isDesktop, isLandscapeImmersive]);

  // --- Shared media area content (extracted to avoid duplication) ---
  const mediaArea = (
    <div
      ref={attachSurface}
      className="entei-player-surface"
      onClick={handleSurfaceClick}
    >
      {displayMediaType === 'video' && (
        <VideoPlayer
          ref={videoCallbackRef}
          src={displayMediaUrl!}
          isLoading={isLoading}
          error={loadError}
          // Keep the torrent video element mounted while a relay error is
          // recovering; the session owns a bounded explicit src/load retry.
          keepElementOnError={torrentSession.active && loadError !== null}
          errorLabel={dict.failedToLoadVideo}
          decodeErrorLabel={dict.videoDecodeError}
          nativeRender={isMpvNative}
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
          Separate from the torrent start-buffering overlay above. */}
      {isSeekBuffering && !isLoading && !loadError && (
        <div
          className="entei-player-buffering-overlay"
          role="status"
          aria-label="Loading"
        >
          <TypewriterLoading aria-hidden="true" />
        </div>
      )}
      {/* Torrent start buffering overlay: the relay URL is mounted but
          no current frame yet (readyState below HAVE_CURRENT_DATA /
          'waiting' for over 2 s). Shows the same "preparing video" copy
          as the pre-URL loading overlay, at a larger size, in gold with
          a black drop shadow so it reads on bright frames. Clears the
          instant the first PAINTED frame arrives (rVFC on supported
          browsers, loadeddata / canplay / playing elsewhere), on error,
          or at the 3 s safety bound. Mutually exclusive with
          the seek-buffering overlay: when both are true only the seek
          one renders, so the surface never shows two stacked loaders. */}
      {isStartBuffering &&
        !isSeekBuffering &&
        !isLoading &&
        !loadError &&
        torrentSession.active && (
          <div
            className="entei-player-buffering-overlay entei-start-buffering"
            role="status"
            aria-label="Loading"
          >
            <TypewriterLoading
              aria-hidden="true"
              className="entei-typewriter--start"
            />
            <p className="entei-player-buffering-text entei-start-buffering-text">
              {dict.torrentPreparingVideo}
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
          // The panel is collapsed in place (desktop) or unmounted (mobile /
          // immersive). Neither path remounts the media element, so no
          // position snapshot is needed and the toggle stays instant.
          setIsSubtitlePanelVisible((visible) => !visible);
        }}
        captionDisplayMode={captionDisplayMode}
        onCycleCaptionMode={handleCycleCaptionMode}
        volume={volume}
        onVolumeChange={handleVolumeChange}
        playbackRate={playbackRate}
        onPlaybackRateChange={handlePlaybackRateChange}
        onTogglePlayback={togglePlayback}
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
        externalTime={mpvTime}
        externalDuration={mpvDuration}
        nativeRender={isMpvNative}
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
      {/* P4: jimaku search modal — opened from the RightPanel button
          or the P3 auto-load fallback (title pre-filled either way). */}
      <JimakuSearchDialog
        open={isJimakuSearchOpen}
        onOpenChange={setIsJimakuSearchOpen}
        initialTitle={jimakuSearchPrefill}
        onSubtitleLoaded={handleSubtitleText}
        onMatchResolved={(match) => {
          jimakuMatchRef.current = match;
        }}
        onToast={handleJimakuToast}
        dict={dict}
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

  // SUBTITLE_SYNC.md §2.11-12: hide for YouTube; show for .mkv/.mp4.
  const hideSyncSubtitle = shouldHideSubtitleSync({
    jobKind: mediaSourceKind,
    mediaName,
  });

  // docs/JIMAKU_SUBS.md §2.2.1: Jimaku search button hidden for YouTube.
  const hideJimakuSearch = shouldHideJimakuSearch(mediaSourceKind);

  // MODULE_ARCHITECTURE.md §5.3: the empty-state picker row is the core
  // local-media button plus an extensible slot. A source module registers
  // its button here only while it is enabled — disabled means the button
  // does not exist at all (and neither does its dialog, below).
  const moduleSourceButtons: ReactNode[] = [];
  if (torrentEnabled) {
    moduleSourceButtons.push(
      <Button
        key="torrent"
        variant="outline"
        size="icon"
        type="button"
        className="entei-player-magnet-icon-btn"
        onClick={() => setIsMagnetDialogOpen(true)}
        aria-label={dict.magnetInputLabel}
        title={dict.magnetInputLabel}
      >
        <Magnet />
      </Button>,
    );
  }
  if (ytdlpEnabled) {
    moduleSourceButtons.push(
      <Button
        key="ytdlp"
        variant="outline"
        size="icon"
        type="button"
        className="entei-player-youtube-icon-btn"
        onClick={() => setIsYouTubeDialogOpen(true)}
        aria-label={dict.youtubeInputLabel}
        title={dict.youtubeInputLabel}
      >
        <YouTubeMark />
      </Button>,
    );
  }

  return (
    <div
      ref={mediaContainerRef}
      className="entei-player-container"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      data-entei-player-root=""
    >
      {/* --- Empty state --- */}
      {!hasMedia && !torrentSession.active && (
        <div className="entei-player-empty">
          <div className="entei-player-empty-cta">
            <div className="entei-player-empty-inner">
              <h2 className="entei-player-empty-title">
                {dict.selectMediaTitle}
              </h2>
              <p className="entei-player-empty-desc">{dict.selectMediaDesc}</p>
              <div className="entei-player-pickers">
                {/* Core built-in source: local media files. */}
                <MediaPicker
                  onSelect={handleMediaSelect}
                  onSelectPath={handleMediaSelectPath}
                  accept={MEDIA_ACCEPT}
                  label={dict.chooseMedia}
                />
                {/* Extensible module slot (Magnet / YouTube). */}
                {moduleSourceButtons}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Native torrent source flow: inspect metadata, then start only selected files. */}
      {torrentEnabled && (
        <MagnetInput
          open={isMagnetDialogOpen}
          onOpenChange={setIsMagnetDialogOpen}
          onJobAccepted={handleMagnetJobAccepted}
          dict={{
            magnetInputLabel: dict.magnetInputLabel,
            magnetInputPlaceholder: dict.magnetInputPlaceholder,
            magnetInputLabelTitle: dict.magnetInputLabelTitle,
            magnetErrorInvalid: dict.magnetErrorInvalid,
            magnetInputSubmit: dict.magnetInputSubmit,
            magnetInputErrorGeneric: dict.magnetInputErrorGeneric,
            magnetInputErrorMetadataTimeout: dict.magnetInputErrorMetadataTimeout,
            magnetCheckMetadata: dict.magnetCheckMetadata,
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
            magnetBreadcrumbLabel: dict.magnetBreadcrumbLabel,
            magnetBreadcrumbRoot: dict.magnetBreadcrumbRoot,
            firefoxUnsupported: dict.firefoxUnsupported,
          }}
        />
      )}

      {/* YouTube source flow: resolve and relay through the native yt-dlp plugin. */}
      {ytdlpEnabled && (
        <YouTubeInput
          open={isYouTubeDialogOpen}
          onOpenChange={setIsYouTubeDialogOpen}
          onStreamAccepted={handleYouTubeStreamAccepted}
          onVideoIdParsed={handleYouTubeVideoIdParsed}
          dict={{
            youtubeInputLabel: dict.youtubeInputLabel,
            youtubeInputTitle: dict.youtubeInputTitle,
            youtubeInputFieldLabel: dict.youtubeInputFieldLabel,
            youtubeInputCancel: dict.youtubeInputCancel,
            youtubeInputPlaceholder: dict.youtubeInputPlaceholder,
            youtubeInputSubmit: dict.youtubeInputSubmit,
            youtubeInputErrorInvalid: dict.youtubeInputErrorInvalid,
            youtubeInputErrorGeneric: dict.youtubeInputErrorGeneric,
            dialogClose: dict.dialogClose,
            firefoxUnsupported: dict.firefoxUnsupported,
          }}
        />
      )}

      {/* --- Active state ---
          The desktop branch keeps the panel group MOUNTED while the right
          panel is closed. Closing the panel collapses it in place (see the
          collapse/expand effect) instead of unmounting it, so the media
          element — and its decoder — survive the toggle: the browser never
          has to re-fetch the media and the panel opens instantly. */}
      {hasMedia && isDesktop && !isLandscapeImmersive ? (
        <ResizablePanelGroup
          id="entei-player-layout"
          elementRef={groupElementRef}
          orientation="horizontal"
          className="entei-resizable-group"
          defaultLayout={{
            'entei-main': isSubtitlePanelVisible ? panelLayout.mainPct : 100,
            'entei-side': isSubtitlePanelVisible ? panelLayout.sidePct : 0,
          }}
          onLayoutChanged={(layout, { isUserInteraction }) => {
            if (!isUserInteraction) return;
            // While the panel is closed the side column is 0% wide:
            // persisting that would store a broken layout.
            if (!isSubtitlePanelVisible) return;
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
            defaultSize={
              isSubtitlePanelVisible ? `${panelLayout.mainPct}%` : '100%'
            }
            minSize="45%"
            className="entei-resizable-panel-main"
          >
            <div className="entei-player-layout entei-player-layout--no-panel">
              <div className="entei-player-media-area">{mediaArea}</div>
              {subtitleErrorsBlock}
            </div>
          </ResizablePanel>
          <ResizableHandle
            withHandle
            className={`entei-resizable-handle${
              isSubtitlePanelVisible ? '' : ' entei-resizable-handle--hidden'
            }`}
          />
          <ResizablePanel
            id="entei-side"
            defaultSize={
              isSubtitlePanelVisible ? `${panelLayout.sidePct}%` : '0%'
            }
            minSize="10%"
            maxSize="45%"
            collapsible
            collapsedSize={0}
            panelRef={sidePanelRef}
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
              syncMode={prefsRef.current.subtitleSyncMode ?? 'auto'}
              hideSyncSubtitle={hideSyncSubtitle}
              onOpenJimakuSearch={
                hideJimakuSearch ? undefined : handleOpenJimakuSearch
              }
              onMineCue={handleMine}
              canMineRow={canMineRow}
              isMining={isMining}
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
              syncMode={prefsRef.current.subtitleSyncMode ?? 'auto'}
              hideSyncSubtitle={hideSyncSubtitle}
              onOpenJimakuSearch={
                hideJimakuSearch ? undefined : handleOpenJimakuSearch
              }
              onMineCue={handleMine}
              canMineRow={canMineRow}
              isMining={isMining}
            />
          )}
          {subtitleErrorsBlock}
        </div>
      ) : null}
    </div>
  );
}
