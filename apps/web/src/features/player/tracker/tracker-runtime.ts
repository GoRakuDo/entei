/**
 * IMMERSION_TRACKER — Non-visual runtime hook for PlayerApp.
 * ---------------------------------------------------------------------------
 * Stage 2a: React hook that manages tracker lifecycle without any UI.
 *
 * Responsibilities:
 * - Compute/update local-file media fingerprint (SHA-256 of sample)
 * - Compute/update subtitle digest when subtitle changes
 * - Maintain current learning set identity (mediaId + subtitleId)
 * - Exclude WebTorrent sessions from tracker runtime records
 * - Exclude background/hidden playback from runtime state
 * - End prior context and start new context on subtitle change
 * - Flush on visibility change, media change, pagehide
 * - Provide segment start/end for the accumulator engine
 *
 * This hook does NOT render any UI, does NOT add CSS classes, does NOT
 * modify the DOM. It is purely side-effect-based integration wiring.
 * ---------------------------------------------------------------------------
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import {
  computeVideoFingerprint,
  computeSubtitleDigestFromText,
} from './identity';
import { makeLearningSetId, noSubtitleLearningSetId, cellKey } from './types';
import type { PlaybackMode } from './types';
import {
  createAccumulatorState,
  createSegment,
  distributeSegmentToCells,
  applyContributions,
} from './engine';
import type { SegmentAccumulatorState, TimeTotals, ExposureCell } from './types';
import { isTrackerEnabled } from './tracker-enabled';

/* ------------------------------------------------------------------------ */
/* Public types                                                             */
/* ------------------------------------------------------------------------ */

export interface TrackerRuntimeState {
  /** Current mediaId (null if not computed yet or unavailable). */
  mediaId: string | null;
  /** Current subtitleId (null if no subtitle loaded). */
  subtitleId: string | null;
  /** Current learningSetId (derived from mediaId + subtitleId). */
  learningSetId: string | null;
  /** Whether the current media is a local file (not WebTorrent). */
  isLocalFile: boolean;
  /** Current accumulator state (cells + totals for this session). */
  accumulator: SegmentAccumulatorState;
  /** Session-seen cell keys (for pass dedup). */
  sessionSeenCells: Set<string>;
  /** Callback invoked when tracker needs to flush data. */
  onFlush: OnTrackerFlush;
  /**
   * Increment mineCount on the cell covering the given media time.
   * Called after successful Anki export to track mining events.
   * Fire-and-forget: no return value, no error propagation.
   *
   * TODO(STAGE-3): manualBackwardSeekCount increment — the current
   * segment-based architecture doesn't expose intermediate seek events.
   * To support this, the runtime would need to poll media.currentTime
   * during playback and detect backward jumps via isManualBackwardSeek().
   * That polling approach is deferred to Stage 3 when playback monitoring
   * is added to the runtime.
   */
  recordMine: (mediaTimeSeconds: number) => void;
}

/** Callback invoked when the tracker needs to flush accumulated data. */
export type OnTrackerFlush = (
  cells: Map<string, ExposureCell>,
  totals: TimeTotals,
  learningSetId: string,
) => Promise<void>;

export interface UseTrackerRuntimeOptions {
  /** Whether the current media is from WebTorrent (excluded from tracking). */
  isTorrentSource: boolean;
  /** Whether the current media is a local file. */
  isLocalFile: boolean;
  /** The media File object (only available for local files). */
  mediaFile: File | null;
  /** Current media display name. */
  mediaName: string;
  /** Whether subtitles are loaded. */
  hasSubtitles: boolean;
  /** Subtitle text content (for digest computation). */
  subtitleText: string | null;
  /** Current playback mode. */
  playMode: PlaybackMode;
  /** Current playback rate. */
  playbackRate: number;
  /** Whether media is currently playing. */
  isPlaying: boolean;
  /** Whether media is paused. */
  isPaused: boolean;
  /** Whether media is buffering. */
  isBuffering: boolean;
  /** Current media element ref. */
  mediaRef: React.RefObject<HTMLMediaElement | null>;
  /** Callback invoked when tracker needs to flush data. */
  onFlush: OnTrackerFlush;
}

/* ------------------------------------------------------------------------ */
/* Hook                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Non-visual hook that manages tracker runtime lifecycle.
 *
 * Call this in PlayerApp. It handles:
 * - Media fingerprint computation (async, on media change)
 * - Subtitle digest computation (async, on subtitle change)
 * - Learning set identity maintenance
 * - Segment boundary detection (play/pause/seek/visibility/subtitle change)
 * - Background/hidden exclusion
 * - WebTorrent exclusion
 * - Flush on various lifecycle events
 *
 * Returns a stable state object that can be read by other hooks/effects.
 * No visual output whatsoever.
 */
export function useTrackerRuntime({
  isTorrentSource,
  isLocalFile,
  mediaFile,
  mediaName: _mediaName,
  hasSubtitles,
  subtitleText,
  playMode,
  playbackRate,
  isPlaying,
  isPaused,
  isBuffering,
  mediaRef,
  onFlush,
}: UseTrackerRuntimeOptions): TrackerRuntimeState {
  // --- Identity STATE (drives effect re-evaluation on change) ---
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [subtitleId, setSubtitleId] = useState<string | null>(null);

  // Derived learningSetId — computed from mediaId + subtitleId
  const learningSetId =
    mediaId !== null
      ? subtitleId !== null
        ? makeLearningSetId(mediaId, subtitleId)
        : noSubtitleLearningSetId(mediaId)
      : null;

  // --- Ref copies for synchronous access in callbacks ---
  const mediaIdRef = useRef<string | null>(null);
  const subtitleIdRef = useRef<string | null>(null);
  const learningSetIdRef = useRef<string | null>(null);
  const isLocalFileRef = useRef(isLocalFile);

  // Keep refs in sync with current render values (safe: idempotent assignment)
  mediaIdRef.current = mediaId;
  subtitleIdRef.current = subtitleId;
  learningSetIdRef.current = learningSetId;

  // --- Accumulator state ---
  const accumulatorRef = useRef<SegmentAccumulatorState>(createAccumulatorState());
  const sessionSeenCellsRef = useRef<Set<string>>(new Set());

  // --- Segment tracking ---
  const segmentStartWallRef = useRef<number>(0);
  const segmentStartMediaRef = useRef<number>(0);
  const segmentModeRef = useRef<PlaybackMode>('normal');
  const segmentRateRef = useRef<number>(1);
  const hasActiveSegmentRef = useRef(false);
  // Captured learningSetId at segment start — used by endSegment to avoid
  // misattributing accumulated data when subtitle/media changes mid-session.
  const segmentLearningSetIdRef = useRef<string | null>(null);

  // --- Previous state for transition detection ---
  const prevIsPlayingRef = useRef(false);
  const prevMediaIdRef = useRef<string | null>(null);
  const prevSubtitleIdRef = useRef<string | null>(null);
  const prevMediaFileRef = useRef<File | null>(null);

  // --- Visibility tracking ---
  const isDocumentVisibleRef = useRef(
    typeof document !== 'undefined' ? document.visibilityState === 'visible' : true,
  );

  // Keep isLocalFile ref in sync
  isLocalFileRef.current = isLocalFile;

  // --- Media fingerprint computation ---
  useEffect(() => {
    if (!isLocalFile || !mediaFile || isTorrentSource) {
      setMediaId(null);
      return;
    }

    let cancelled = false;

    const compute = async () => {
      try {
        const fingerprint = await computeVideoFingerprint(mediaFile);
        if (cancelled) return;
        setMediaId(fingerprint);
        // learningSetId is derived from mediaId + subtitleId in render,
        // so it updates automatically when mediaId state changes.
      } catch {
        if (!cancelled) {
          setMediaId(null);
        }
      }
    };

    compute();
    return () => { cancelled = true; };
  }, [isLocalFile, mediaFile, isTorrentSource]);

  // --- Subtitle digest computation ---
  useEffect(() => {
    if (!hasSubtitles || !subtitleText || isTorrentSource) {
      setSubtitleId(null);
      // learningSetId reverts to no-subtitle automatically via derived computation
      return;
    }

    let cancelled = false;

    const compute = async () => {
      try {
        const digest = await computeSubtitleDigestFromText(subtitleText);
        if (cancelled) return;
        setSubtitleId(digest);
        // learningSetId is derived from mediaId + subtitleId in render,
        // so it updates automatically when subtitleId state changes.
      } catch {
        if (!cancelled) {
          setSubtitleId(null);
        }
      }
    };

    compute();
    return () => { cancelled = true; };
  }, [hasSubtitles, subtitleText, isTorrentSource]);

  // --- Segment boundary detection ---
  // Start a new segment when playback begins or state transitions
  const startSegment = useCallback(() => {
    if (!isTrackerEnabled()) return;
    if (isTorrentSource) return;
    if (!mediaIdRef.current) return;
    if (!mediaRef.current) return;

    const media = mediaRef.current;
    segmentStartWallRef.current = performance.now();
    segmentStartMediaRef.current = media.currentTime;
    segmentModeRef.current = playMode;
    segmentRateRef.current = playbackRate;
    segmentLearningSetIdRef.current = learningSetIdRef.current;
    hasActiveSegmentRef.current = true;
  }, [isTorrentSource, mediaRef, playMode, playbackRate]);

  // End current segment and flush if needed
  const endSegment = useCallback(() => {
    if (!hasActiveSegmentRef.current) return;
    if (!mediaRef.current) return;
    // Use the CAPTURED learningSetId from segment start, not the current one.
    // This prevents misattribution when subtitle/media changes mid-session.
    const capturedLsid = segmentLearningSetIdRef.current;
    if (!capturedLsid) return;

    const media = mediaRef.current;
    const wallEndMs = performance.now();
    const mediaEnd = media.currentTime;

    const segment = createSegment(
      segmentStartWallRef.current,
      wallEndMs,
      segmentStartMediaRef.current,
      mediaEnd,
      segmentRateRef.current,
      segmentModeRef.current,
      capturedLsid,
    );

    // Distribute to cells
    const contributions = distributeSegmentToCells(
      segment,
      accumulatorRef.current.cells,
      sessionSeenCellsRef.current,
    );

    // Apply contributions
    const isPause = isPaused && !isBuffering;
    applyContributions(
      accumulatorRef.current,
      contributions,
      capturedLsid,
      segmentModeRef.current,
      isPause,
      sessionSeenCellsRef.current,
    );

    hasActiveSegmentRef.current = false;
  }, [mediaRef, isPaused, isBuffering]);

  // --- Play/pause transitions ---
  useEffect(() => {
    const wasPlaying = prevIsPlayingRef.current;
    prevIsPlayingRef.current = isPlaying;

    if (isPlaying && !wasPlaying) {
      // Started playing → start new segment
      startSegment();
    } else if (!isPlaying && wasPlaying) {
      // Stopped playing → end segment
      endSegment();
    }
  }, [isPlaying, startSegment, endSegment]);

  // --- Visibility change → flush ---
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const onVisibilityChange = () => {
      const visible = document.visibilityState === 'visible';

      if (!visible && isDocumentVisibleRef.current) {
        // Became hidden → end segment
        endSegment();
      } else if (visible && !isDocumentVisibleRef.current) {
        // Became visible → start new segment (if playing)
        if (isPlaying && !isTorrentSource && mediaIdRef.current) {
          startSegment();
        }
      }

      isDocumentVisibleRef.current = visible;
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [isPlaying, isTorrentSource, startSegment, endSegment]);

  // --- Pagehide → flush ---
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onPageHide = () => {
      endSegment();
      // Flush accumulator under the CAPTURED learningSetId
      const flushLsid = segmentLearningSetIdRef.current ?? learningSetIdRef.current;
      if (accumulatorRef.current.cells.size > 0 && flushLsid) {
        try {
          onFlush(
            accumulatorRef.current.cells,
            accumulatorRef.current.totals,
            flushLsid,
          );
        } catch {
          // Flush failure is non-fatal
        }
        // Reset accumulator
        accumulatorRef.current = createAccumulatorState();
        sessionSeenCellsRef.current = new Set();
      }
    };

    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [endSegment, onFlush]);

  // --- Media change detection → flush old + reset ---
  useEffect(() => {
    const prevFile = prevMediaFileRef.current;
    prevMediaFileRef.current = mediaFile;

    // Only act on actual media change (not first mount)
    if (prevFile === null && mediaFile === null) return;
    if (prevFile === mediaFile) return;

    // End any active segment (uses captured learningSetId internally)
    endSegment();

    // Flush accumulator under the CAPTURED learningSetId (the old one),
    // not the current learningSetId which may have already changed.
    const flushLsid = segmentLearningSetIdRef.current ?? learningSetIdRef.current;
    if (accumulatorRef.current.cells.size > 0 && flushLsid) {
      try {
        onFlush(
          accumulatorRef.current.cells,
          accumulatorRef.current.totals,
          flushLsid,
        );
      } catch {
        // Flush failure is non-fatal
      }
    }

    // Reset for new media
    accumulatorRef.current = createAccumulatorState();
    sessionSeenCellsRef.current = new Set();
    prevMediaIdRef.current = mediaIdRef.current;
  }, [mediaFile, endSegment, onFlush]);

  // --- Subtitle change detection → end prior context, start new ---
  useEffect(() => {
    const prevSubtitle = prevSubtitleIdRef.current;
    prevSubtitleIdRef.current = subtitleId;

    // Only act on actual subtitle change (not first mount)
    if (prevSubtitle === null && subtitleId === null) return;
    if (prevSubtitle === subtitleId) return;

    // End any active segment (uses captured learningSetId internally)
    endSegment();

    // Flush accumulator under the CAPTURED learningSetId (the old one),
    // not the current learningSetId which may have already changed.
    const flushLsid = segmentLearningSetIdRef.current ?? learningSetIdRef.current;
    if (accumulatorRef.current.cells.size > 0 && flushLsid) {
      try {
        onFlush(
          accumulatorRef.current.cells,
          accumulatorRef.current.totals,
          flushLsid,
        );
      } catch {
        // Flush failure is non-fatal
      }
    }

    // Reset for new learning set context
    accumulatorRef.current = createAccumulatorState();
    sessionSeenCellsRef.current = new Set();

    // Start new segment if currently playing
    if (isPlaying && !isTorrentSource && mediaIdRef.current) {
      startSegment();
    }
  }, [subtitleId, isPlaying, isTorrentSource, endSegment, onFlush, startSegment]);

  // --- Unmount cleanup ---
  useEffect(() => {
    return () => {
      endSegment();
      // Flush under the CAPTURED learningSetId
      const flushLsid = segmentLearningSetIdRef.current ?? learningSetIdRef.current;
      if (accumulatorRef.current.cells.size > 0 && flushLsid) {
        try {
          onFlush(
            accumulatorRef.current.cells,
            accumulatorRef.current.totals,
            flushLsid,
          );
        } catch {
          // Flush failure is non-fatal
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on unmount
  }, []);

  // --- mineCount increment (called after successful Anki export) ---
  const recordMine = useCallback((mediaTimeSeconds: number) => {
    if (!hasActiveSegmentRef.current) return;
    const lsid = segmentLearningSetIdRef.current;
    if (!lsid) return;

    const roundedSecond = Math.round(mediaTimeSeconds);
    const rk = cellKey(lsid, roundedSecond);
    const cell = accumulatorRef.current.cells.get(rk);
    if (cell) {
      cell.mineCount += 1;
    }
    // If cell doesn't exist yet in accumulator, skip — the mine event
    // happened outside the tracked segment window. This is correct:
    // mineCount only tracks cells that have actual watch-time exposure.
  }, []);

  return {
    mediaId,
    subtitleId,
    learningSetId,
    isLocalFile,
    accumulator: accumulatorRef.current,
    sessionSeenCells: sessionSeenCellsRef.current,
    onFlush,
    recordMine,
  };
}
