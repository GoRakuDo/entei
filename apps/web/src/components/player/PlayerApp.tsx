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
  surfaceClickEffect,
  nextCaptionDisplayMode,
  BLUR_RESTORE_TIMEOUT_MS,
  type CaptionDisplayMode,
} from '@/features/player/control-helpers';
import {
  type LocaleChangeDetail,
  LOCALE_CHANGE_EVENT,
} from '@i18n/locale-events';
import type { Dictionary } from '@i18n/types';
import { getDictionary } from '@i18n/index';
import { MediaPicker } from '@/components/player/MediaPicker';
import { SubtitlePicker } from '@/components/player/SubtitlePicker';
import { VideoPlayer } from '@/components/player/VideoPlayer';
import { SubtitlePanel } from '@/components/player/SubtitlePanel';
import { SubtitleOverlay } from '@/components/player/SubtitleOverlay';
import {
  PlayerControls,
  type PlayerControlsHandle,
} from '@/components/player/PlayerControls';
import { useKeyboardShortcuts } from '@/features/player/use-keyboard-shortcuts';
import { captureVideoFrame } from '@/features/player/screenshot-capture';
import { ScreenshotPreviewDialog } from '@/components/player/ScreenshotPreviewDialog';
import {
  recordAudioClip,
  cancelActiveRecording,
  checkAudioClipCapabilities,
} from '@/features/player/audio-clip';
import { AudioClipPreviewDialog } from '@/components/player/AudioClipPreviewDialog';
import { Music, AlertTriangle } from 'lucide-react';
import { formatTime } from '@/features/player/control-helpers';
import { MiningPreviewDialog } from '@/components/player/MiningPreviewDialog';
import {
  readAnkiMinerPreferences,
  writeAnkiMinerPreferences,
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
} from '@/features/player/anki-export-client';
import {
  AnkiConnectClient,
  runAnkiConnectionFlow,
} from '@/features/player/anki-connect';

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

  // --- P1.1: subtitle panel visibility ---
  const [isSubtitlePanelVisible, setIsSubtitlePanelVisible] = useState(true);

  // --- P1.3a.2: caption display mode + overlay reveal state ---
  const [captionDisplayMode, setCaptionDisplayMode] =
    useState<CaptionDisplayMode>(prefsRef.current.captionDisplayMode);
  const [isOverlayRevealed, setIsOverlayRevealed] = useState(false);
  const blurRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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
  const [isVideoMetadataReady, setIsVideoMetadataReady] = useState(false);
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
  // Ref to allow handleSessionCredentials to trigger background restart
  const attemptBgRef = useRef<() => void>(() => {});
  // Export state
  const [exportMode, setExportModeState] = useState<'new' | 'update'>(
    () => readAnkiMinerPreferences().exportMode,
  );
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

  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const controlsHandleRef = useRef<PlayerControlsHandle>(null);
  const mediaContainerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const sharedMediaRef = useRef<HTMLMediaElement | null>(null);

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
      miningScreenshotBlobRef.current = null;
      miningAudioBlobRef.current = null;
    };
  }, []);

  // Fix: Use callback refs instead of a sync effect. Callback refs fire during
  // the commit phase (before any effects), so sharedMediaRef.current is populated
  // before PlayerControls' listener effect reads it. This eliminates the
  // parent-effect-before-child-effect timing race.
  const videoCallbackRef = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el;
      sharedMediaRef.current = mediaType === 'video' ? el : null;
    },
    [mediaType],
  );

  const audioCallbackRef = useCallback(
    (el: HTMLAudioElement | null) => {
      audioRef.current = el;
      sharedMediaRef.current = mediaType === 'audio' ? el : null;
    },
    [mediaType],
  );

  // Fix #4: Apply volume using direct element refs (avoids sharedRef timing race)
  useEffect(() => {
    const media = mediaType === 'video' ? videoRef.current : audioRef.current;
    if (!media) return;
    media.volume = volume;
  }, [volume, mediaUrl, mediaType]);

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
        ...(mapping.tags
          ? [{ key: 'tags', physicalName: mapping.tags, value: '' }]
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

  /** AM-2: Reset video metadata readiness on new media. */
  const resetVideoMetadata = useCallback(() => {
    setIsVideoMetadataReady(false);
  }, []);

  const handleMediaSelect = useCallback(
    (file: File) => {
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
      // AM-2: Invalidate any prior screenshot when selecting new media
      clearScreenshot();
      // AM-3: Invalidate any prior audio clip when selecting new media
      clearAudioClip();
      // AM-4: Invalidate any prior mining preview when selecting new media
      clearMiningPreview();
      resetVideoMetadata();

      const oldUrl = activeUrlRef.current;
      const newUrl = createMediaUrl(file, oldUrl);
      activeUrlRef.current = newUrl;
      setMediaUrl(newUrl);
      setMediaType(admission.kind);
      setMediaName(file.name);
    },
    [clearScreenshot, clearAudioClip, clearMiningPreview, resetVideoMetadata],
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
    };
    reader.onerror = () => {
      setSubtitleErrors([
        { line: 0, message: dictRef.current.playerUI.failedToRead },
      ]);
    };
    reader.readAsText(file);
  }, []);

  const handleCueClick = useCallback((cue: SubtitleCue) => {
    const media = sharedMediaRef.current;
    if (!media) return;
    media.currentTime = cue.start;
    media.play().catch(() => {});
    // P2: Reveal controls when clicking a cue while they are hidden
    controlsHandleRef.current?.show();
  }, []);

  // --- P1.3a.2: Caption display mode handlers ---

  const handleCycleCaptionMode = useCallback(() => {
    setCaptionDisplayMode((prev) => {
      const next = nextCaptionDisplayMode(prev);
      // Persist the new mode together with current volume/rate
      writePlayerPreferences({
        volume: prefsRef.current.volume,
        playbackRate: prefsRef.current.playbackRate,
        captionDisplayMode: next,
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
    // AM-2: Mark video metadata ready when loadeddata fires for video
    setIsVideoMetadataReady(true);
  }, []);

  const handleError = useCallback((error: string) => {
    setIsLoading(false);
    setLoadError(error);
  }, []);

  const handleVolumeChange = useCallback((val: number) => {
    setVolume(val);
    writePlayerPreferences({
      volume: val,
      playbackRate: prefsRef.current.playbackRate,
      captionDisplayMode: prefsRef.current.captionDisplayMode,
    });
    prefsRef.current = { ...prefsRef.current, volume: val };
  }, []);

  const handlePlaybackRateChange = useCallback((rate: number) => {
    setPlaybackRate(rate);
    writePlayerPreferences({
      volume: prefsRef.current.volume,
      playbackRate: rate,
      captionDisplayMode: prefsRef.current.captionDisplayMode,
    });
    prefsRef.current = { ...prefsRef.current, playbackRate: rate };
  }, []);

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

  /** AM-2: Screenshot is possible only when video metadata is ready. */
  const canScreenshot = mediaType === 'video' && isVideoMetadataReady;

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

  /** AM-3: Audio clip is possible when media loaded, active cue exists, APIs supported,
   *  AND no AM-4 mining capture/update is in flight. */
  const canAudioClip =
    (mediaType === 'video' || mediaType === 'audio') &&
    !!mediaUrl &&
    !!activeCueId &&
    audioClipCaps.supported &&
    !isMiningCapturing &&
    !isMiningRefreshing;

  // --- AM-4: Mining capture ---
  const handleMine = useCallback(async () => {
    if (!mediaUrl || activeCueId == null) return;
    // Guard: refuse if any standalone capture (AM-2 screenshot / AM-3 audio) or AM-4 mining is in flight
    if (
      isCapturingRef.current ||
      isRecordingAudioRef.current ||
      isMiningRef.current
    )
      return;
    const activeCue = cues.find((c) => c.id === activeCueId);
    if (!activeCue) return;

    const media = sharedMediaRef.current;
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
    const sourceLabel = `${mediaName} (${formatTime(activeCue.start)} – ${formatTime(activeCue.end)})`;
    const draftFields = buildDraftFields(
      prefs.fields,
      activeCue.text,
      sourceLabel,
    );
    setMiningDraftFields(draftFields);

    setMiningRangeStart(activeCue.start);
    setMiningRangeEnd(activeCue.end);
    setMiningAudioExpectedDuration(
      Math.max(0, activeCue.end - activeCue.start),
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
    let screenshotResult: Awaited<ReturnType<typeof captureVideoFrame>> | null =
      null;
    if (mediaType === 'video' && videoRef.current) {
      try {
        screenshotResult = await captureVideoFrame(videoRef.current);
      } catch (e) {
        screenshotResult = {
          ok: false,
          error: {
            code: 'BLOB_ENCODE_FAILED',
            message:
              e instanceof Error ? e.message : 'Unexpected capture failure.',
          },
        };
      }
    }

    // Screenshot resolves before audio recording. Show it immediately instead
    // of holding a completed frame behind the still-recording audio task.
    if (!mountedRef.current || miningEpochRef.current !== epoch) return;
    if (mediaType === 'video') {
      if (screenshotResult && !screenshotResult.ok) {
        setMiningHasScreenshotError(true);
        replaceMiningScreenshotUrl(null);
        miningScreenshotBlobRef.current = null;
      } else if (screenshotResult && screenshotResult.ok) {
        miningScreenshotBlobRef.current = screenshotResult.blob;
        replaceMiningScreenshotUrl(URL.createObjectURL(screenshotResult.blob));
      }
    }

    // Audio
    const audioResult = await recordAudioClip({
      mediaUrl,
      start: activeCue.start,
      end: activeCue.end,
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
  }, [
    mediaUrl,
    activeCueId,
    cues,
    mediaType,
    mediaName,
    playbackRate,
    replaceMiningScreenshotUrl,
    replaceMiningAudioUrl,
  ]);

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
      setMiningHasScreenshotError(false);
      setMiningHasAudioError(false);

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

      // Phase 2: Screenshot — seek visible video to committedStart, capture, restore
      if (hasImage && hasVideo) {
        const video = videoRef.current!;
        const snapshotTime = miningSnapshotTimeRef.current;

        try {
          await seekVideoSafely(video, committedStart, abortController.signal);

          if (!mountedRef.current || miningEpochRef.current !== epoch) return;
          if (abortController.signal.aborted) return;

          const screenshotResult = await captureVideoFrame(video);

          if (!mountedRef.current || miningEpochRef.current !== epoch) {
            video.currentTime = snapshotTime;
            video.pause();
            return;
          }

          if (!screenshotResult.ok) {
            setMiningHasScreenshotError(true);
            replaceMiningScreenshotUrl(null);
            miningScreenshotBlobRef.current = null;
          } else {
            miningScreenshotBlobRef.current = screenshotResult.blob;
            replaceMiningScreenshotUrl(
              URL.createObjectURL(screenshotResult.blob),
            );
          }
        } catch {
          if (mountedRef.current && miningEpochRef.current === epoch) {
            setMiningHasScreenshotError(true);
            replaceMiningScreenshotUrl(null);
            miningScreenshotBlobRef.current = null;
          }
        } finally {
          video.currentTime = miningSnapshotTimeRef.current;
          video.pause();
        }
      }

      // Guard before audio phase
      if (!mountedRef.current || miningEpochRef.current !== epoch) return;
      if (abortController.signal.aborted) return;

      // Phase 3: Audio — record new range via detached element
      if (hasAudio && audioClipCaps.supported) {
        const result = await recordAudioClip({
          mediaUrl,
          start: committedStart,
          end: committedEnd,
          playbackRate,
          signal: abortController.signal,
        });

        if (!mountedRef.current) return;
        if (miningEpochRef.current !== epoch) return;

        if (!result.ok) {
          setMiningHasAudioError(true);
          replaceMiningAudioUrl(null);
          miningAudioBlobRef.current = null;
        } else {
          miningAudioBlobRef.current = result.blob;
          const url = URL.createObjectURL(result.blob);
          replaceMiningAudioUrl(url);
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
      replaceMiningScreenshotUrl,
      replaceMiningAudioUrl,
    ],
  );

  /** AM-4: Mine is possible when media loaded and active cue exists,
   *  AND no standalone AM-2 screenshot or AM-3 audio capture is in flight.
   *  Prevents Mine from cancelling an in-progress standalone capture. */
  const canMine =
    (mediaType === 'video' || mediaType === 'audio') &&
    !!mediaUrl &&
    activeCueId != null &&
    !isCapturing &&
    !isRecordingAudio &&
    !isMiningCapturing &&
    !isMiningRefreshing;

  const isMining = isMiningCapturing || isMiningRefreshing;

  // AM-4: canRefresh — true if ANY mapped field can be refreshed.
  const canRefresh = useMemo(() => {
    const prefs = readAnkiMinerPreferences();
    const hasSentence = !!prefs.fields.sentence;
    const hasSource = !!prefs.fields.source;
    const hasImage = !!prefs.fields.image && mediaType === 'video';
    const hasAudio = !!prefs.fields.audio && audioClipCaps.supported;
    return hasSentence || hasSource || hasImage || hasAudio;
  }, [mediaType, audioClipCaps.supported]);

  // --- Stage 2: Export handlers ---
  /** Handle session credentials from AnkiFieldsTab (page-lifetime, memory-only). */
  const handleSessionCredentials = useCallback(
    (creds: { endpoint: string; apiKey: string } | null) => {
      // Advance epoch so any in-flight background request is superseded
      bgConnEpochRef.current += 1;
      bgConnAbortRef.current?.abort();

      if (creds) {
        settingsSessionActiveRef.current = true;
        setAnkiSession({ endpoint: creds.endpoint, apiKey: creds.apiKey });
      } else {
        // Settings disconnected — allow background to try again
        settingsSessionActiveRef.current = false;
        setAnkiSession(null);
        // Resume background connection attempts after a brief delay
        if (bgConnTimerRef.current !== null) {
          clearTimeout(bgConnTimerRef.current);
        }
        bgConnTimerRef.current = setTimeout(() => {
          bgConnTimerRef.current = null;
          attemptBgRef.current();
        }, 1_000);
      }
    },
    [],
  );

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

  // Keep ref in sync for handleSessionCredentials to trigger background restart
  attemptBgRef.current = attemptBackgroundConnect;

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

  /** Stage 2 AM-6a: Send new note to Anki. */
  const handleExportSend = useCallback(async () => {
    const d = dictRef.current.playerUI;
    if (!ankiSession || isExporting) return;
    if (exportDisabledReason) return;

    const prefs = readAnkiMinerPreferences();
    if (!prefs.deck || !prefs.noteType || !prefs.fields.sentence) return;

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
              tags: [],
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

        // Upload media (screenshot/audio) if mapped
        const fieldMapping = prefs.fields;
        if (fieldMapping.image && miningScreenshotBlobRef.current) {
          const filename = generateMediaFilename('entei_screenshot', 'jpg');
          const base64 = await blobToBase64(miningScreenshotBlobRef.current);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          await client.storeMediaFile(filename, base64, abortController.signal);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          if (fieldMapping.image && !noteFields[fieldMapping.image]) {
            noteFields[fieldMapping.image] = `<img src="${filename}">`;
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
            tags: [],
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

        // Upload media if available (never wipe existing)
        if (prefs.fields.image && miningScreenshotBlobRef.current) {
          const filename = generateMediaFilename('entei_screenshot', 'jpg');
          const base64 = await blobToBase64(miningScreenshotBlobRef.current);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          await client.storeMediaFile(filename, base64, abortController.signal);
          if (!mountedRef.current || exportEpochRef.current !== epoch) return;
          if (prefs.fields.image) {
            updateFields[prefs.fields.image] = `<img src="${filename}">`;
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

        await client.updateNoteFields(
          candidate.noteId,
          updateFields,
          abortController.signal,
        );

        if (!mountedRef.current || exportEpochRef.current !== epoch) return;

        setExportSuccess(true);
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

  const handleAppend = useCallback(
    async (selectedIds: number[]) => {
      if (!ankiSession || isAppending || selectedIds.length === 0) {
        return { succeeded: [] as number[], failed: [] as number[] };
      }

      const prefs = readAnkiMinerPreferences();
      if (!prefs.noteType || !prefs.fields.sentence) {
        return { succeeded: [] as number[], failed: selectedIds };
      }

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
          const filename = generateMediaFilename('entei_screenshot', 'jpg');
          const base64 = await blobToBase64(miningScreenshotBlobRef.current);
          if (!mountedRef.current || appendEpochRef.current !== epoch)
            return { succeeded, failed };
          if (abortController.signal.aborted) return { succeeded, failed };
          await client.storeMediaFile(filename, base64, abortController.signal);
          if (!mountedRef.current || appendEpochRef.current !== epoch)
            return { succeeded, failed };
          imageMarkup = `<img src="${filename}">`;
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
            succeeded.push(note.noteId);
            continue;
          }

          try {
            await client.updateNoteFields(
              note.noteId,
              updates,
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
        }
        appendAbortControllerRef.current = null;
      }

      return { succeeded, failed };
    },
    [ankiSession, isAppending, miningDraftFields],
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
      const media = sharedMediaRef.current;
      if (!media || isLoading || loadError || !mediaUrl) return;

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
    [isLoading, loadError, mediaUrl, isTouchDevice],
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
  const hasMedia = mediaUrl !== null;
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

  // --- Shortcuts list for settings popover ---
  const shortcuts = [
    { key: 'Space', desc: dict.shortcutPlayPause },
    { key: '\u2190', desc: dict.shortcutPrevCue },
    { key: '\u2192', desc: dict.shortcutNextCue },
    { key: 'Home', desc: dict.shortcutSeekHome },
    { key: '[', desc: dict.shortcutSlowDown },
    { key: ']', desc: dict.shortcutSpeedUp },
  ];

  // --- Layout class ---
  const layoutClass = `entei-player-layout${isSubtitlePanelVisible ? '' : ' entei-player-layout--no-panel'}`;

  return (
    <div
      ref={mediaContainerRef}
      className="entei-player-container"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      data-entei-player-root=""
    >
      {/* --- Empty state --- */}
      {!hasMedia && (
        <div className="entei-player-empty">
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
              <SubtitlePicker
                onSelect={handleSubtitleSelect}
                accept={SUBTITLE_ACCEPT}
                label={dict.chooseSubtitle}
                disabled
              />
            </div>
          </div>
        </div>
      )}

      {/* --- Active state --- */}
      {hasMedia && (
        <div className={layoutClass}>
          {/* Media area + controls */}
          <div className="entei-player-media-area">
            <div
              ref={surfaceRef}
              className="entei-player-surface"
              onClick={handleSurfaceClick}
            >
              {mediaType === 'video' && (
                <VideoPlayer
                  ref={videoCallbackRef}
                  src={mediaUrl}
                  isLoading={isLoading}
                  error={loadError}
                  errorLabel={dict.failedToLoadVideo}
                  decodeErrorLabel={dict.videoDecodeError}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={handlePlay}
                  onPause={handlePause}
                  onLoaded={handleLoaded}
                  onError={handleError}
                />
              )}
              {mediaType === 'audio' && (
                <div className="entei-player-audio-area">
                  <div className="entei-player-audio-visual">
                    <div className="entei-player-audio-icon">
                      <Music size={64} />
                    </div>
                    <p className="entei-player-audio-name">{mediaName}</p>
                  </div>
                  <audio
                    ref={audioCallbackRef}
                    src={mediaUrl}
                    onTimeUpdate={(e) =>
                      handleTimeUpdate(e.currentTarget.currentTime)
                    }
                    onPlay={handlePlay}
                    onPause={handlePause}
                    onLoadedData={handleLoaded}
                    onError={(e) => {
                      const mediaError = e.currentTarget.error;
                      const classified = classifyMediaError(
                        mediaError,
                        'audio',
                      );
                      // P1.2: Never surface raw MediaError.message — use localized labels.
                      if (classified?.kind === 'decode') {
                        handleError(dict.audioDecodeError);
                      } else {
                        handleError(dict.failedToLoadAudio);
                      }
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

              {/* P1.3a.1: Selectable subtitle overlay over video */}
              <SubtitleOverlay
                cues={cues}
                activeCueId={activeCueId}
                displayMode={captionDisplayMode}
                isRevealed={isOverlayRevealed}
                onPointerEnter={handleOverlayPointerEnter}
                onPointerLeave={handleOverlayPointerLeave}
                onTouchTap={handleOverlayTouchTap}
              />

              {/* P1.1 Custom Controls */}
              <PlayerControls
                ref={controlsHandleRef}
                mediaRef={sharedMediaRef}
                surfaceRef={surfaceRef}
                isPlaying={isPlaying}
                isLoading={isLoading}
                error={loadError}
                hasMedia={hasMedia}
                mediaType={mediaType}
                mediaKey={mediaUrl}
                mediaName={mediaName}
                dict={dict}
                isSubtitlePanelVisible={isSubtitlePanelVisible}
                onToggleSubtitlePanel={() =>
                  setIsSubtitlePanelVisible((v) => !v)
                }
                captionDisplayMode={captionDisplayMode}
                onCycleCaptionMode={handleCycleCaptionMode}
                volume={volume}
                onVolumeChange={handleVolumeChange}
                playbackRate={playbackRate}
                onPlaybackRateChange={handlePlaybackRateChange}
                shortcuts={shortcuts}
                isTouchDevice={isTouchDevice}
                reducedMotion={reducedMotion}
                onScreenshot={handleScreenshot}
                canScreenshot={canScreenshot}
                isCapturing={isCapturing}
                onAudioClip={handleAudioClip}
                canAudioClip={canAudioClip}
                isRecordingAudio={isRecordingAudio}
                onMine={handleMine}
                canMine={canMine}
                isMining={isMining}
                onSessionCredentials={handleSessionCredentials}
              />

              {/* AM-2: Screenshot Preview Dialog */}
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

              {/* AM-3: Audio Clip Preview Dialog */}
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

              {/* AM-4: Mining Preview Dialog */}
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
              />
            </div>
          </div>

          {/* Subtitle panel */}
          {isSubtitlePanelVisible && (
            <SubtitlePanel
              cues={cues}
              activeCueId={activeCueId}
              onCueClick={handleCueClick}
              onSubtitleSelect={handleSubtitleSelect}
              subtitleAccept={SUBTITLE_ACCEPT}
              subtitlesLabel={dict.subtitles}
              cuesCountLabel={dict.cuesCount}
              noSubtitlesLabel={dict.noSubtitlesLoaded}
              seekToLabel={dict.seekTo}
              chooseSubtitleLabel={dict.chooseSubtitle}
              changeSubtitleLabel={dict.changeSubtitle}
            />
          )}

          {/* Subtitle errors */}
          {subtitleErrors.length > 0 && (
            <div className="entei-player-errors">
              <p className="entei-player-errors-title">
                <AlertTriangle size={14} className="entei-player-errors-icon" />
                {dict.subtitleWarnings}:
              </p>
              <ul className="entei-player-errors-list">
                {subtitleErrors.map((err, i) => (
                  <li key={i}>
                    {err.line > 0 ? `${dict.linePrefix} ${err.line}: ` : ''}
                    {err.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
