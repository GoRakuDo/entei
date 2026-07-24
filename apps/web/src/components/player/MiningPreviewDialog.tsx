/**
 * MiningPreviewDialog — AM-4 preview workspace for mined subtitle material.
 * ---------------------------------------------------------------------------
 * Stage 1.1: Range slider commit auto-refreshes range-derived materials.
 * No manual Update materials button — refresh fires on Radix onValueCommit
 * (thumb release / keyboard commit). No Send/export button (Stage 2).
 *
 * Shows mapped editable draft fields, screenshot/audio preview, range slider
 * with subtitle-boundary markers, and per-material errors.
 * No bottom footer — uses the top-right Dialog X close only.
 * Range area lives in a bottom dock outside the scrolling body.
 * Controlled via Dialog onOpenChange. No nested dialogs.
 * --------------------------------------------------------------------------- */

'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Play, Pause, ZoomIn, ZoomOut } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/player/ui/dialog';
import { Slider } from '@/components/player/ui/slider';
import { AspectRatio } from '@/components/player/ui/aspect-ratio';
import { formatTime } from '@/features/player/control-helpers';
import {
  computeInitialViewport,
  zoomIn as zoomInViewport,
  zoomOut as zoomOutViewport,
  canZoomIn,
  canZoomOut,
  reframeIfNeeded,
  type Viewport,
} from '@/features/player/mining-viewport';
import type { SubtitleCue } from '@/features/player/subtitle-reader';

interface DraftField {
  key: string;
  physicalName: string;
  value: string;
}

interface MiningPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draftFields: DraftField[];
  onDraftFieldChange: (index: number, value: string) => void;
  screenshotUrl: string | null;
  hasScreenshotError: boolean;
  isScreenshotUnavailable: boolean;
  audioUrl: string | null;
  audioExpectedDuration: number;
  hasAudioError: boolean;
  rangeStart: number;
  rangeEnd: number;
  mediaDuration: number;
  cues: readonly SubtitleCue[];
  isCapturing: boolean;
  isRefreshing: boolean;
  canRefresh: boolean;
  onRangeChange: (value: number[]) => void;
  onRangeCommit: (value: number[]) => void;
  onCancel: () => void;
  dict: {
    miningPreviewTitle: string;
    miningPreviewRange: string;
    miningPreviewCancel: string;
    miningPreviewClose: string;
    miningPreviewScreenshotUnavailable: string;
    miningPreviewAudioError: string;
    miningPreviewScreenshotError: string;
    miningPreviewCapturing: string;
    miningPreviewRefreshing: string;
    miningPreviewRangeInvalid: string;
    miningZoomIn: string;
    miningZoomOut: string;
    audioClipPlay: string;
    audioClipPause: string;
    audioClipNoPreview: string;
    dialogClose: string;
  };
}

function isValidDuration(d: number): boolean {
  return typeof d === 'number' && Number.isFinite(d) && d > 0;
}

export function MiningPreviewDialog({
  open,
  onOpenChange,
  draftFields,
  onDraftFieldChange,
  screenshotUrl,
  hasScreenshotError,
  isScreenshotUnavailable,
  audioUrl,
  audioExpectedDuration,
  hasAudioError,
  rangeStart,
  rangeEnd,
  mediaDuration,
  cues,
  isCapturing,
  isRefreshing,
  canRefresh,
  onRangeChange,
  onRangeCommit,
  onCancel: _onCancel,
  dict,
}: MiningPreviewDialogProps) {
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(
    null,
  );
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(() =>
    isValidDuration(audioExpectedDuration) ? audioExpectedDuration : 0,
  );

  const durationKnown = Number.isFinite(mediaDuration) && mediaDuration > 0;

  // --- AM-4: Range viewport (memory-only, never persists) ---
  const [viewport, setViewport] = useState<Viewport>({
    viewStart: 0,
    viewEnd: 0,
  });
  const [viewportInitialized, setViewportInitialized] = useState(false);

  useEffect(() => {
    if (!open) {
      setViewportInitialized(false);
      return;
    }
    if (!durationKnown) {
      setViewport({ viewStart: 0, viewEnd: 0 });
      setViewportInitialized(true);
      return;
    }
    setViewport(
      computeInitialViewport(rangeStart, rangeEnd, mediaDuration),
    );
    setViewportInitialized(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !durationKnown || !viewportInitialized) return;
    setViewport((prev) =>
      reframeIfNeeded(prev, rangeStart, rangeEnd, mediaDuration),
    );
  }, [rangeStart, rangeEnd, mediaDuration, open, durationKnown, viewportInitialized]);

  // --- AM-4: Subtitle-boundary marker ticks within current viewport ---
  const markers = useMemo(() => {
    const span = viewport.viewEnd - viewport.viewStart;
    if (span <= 0 || !durationKnown) return [];
    return cues
      .filter(
        (c) =>
          c.start > viewport.viewStart &&
          c.start < viewport.viewEnd &&
          c.end - c.start > 0,
      )
      .map((c) => ({
        id: c.id,
        pct: ((c.start - viewport.viewStart) / span) * 100,
      }));
  }, [cues, viewport, durationKnown]);

  const sliderDisabled =
    !durationKnown || isCapturing || isRefreshing || !canRefresh;
  const zoomDisabled = !durationKnown || isCapturing || isRefreshing;
  const zoomInDisabled =
    zoomDisabled || !canZoomIn(viewport, rangeStart, rangeEnd);
  const zoomOutDisabled =
    zoomDisabled || !canZoomOut(viewport, mediaDuration);

  const handleZoomIn = useCallback(() => {
    setViewport((prev) =>
      zoomInViewport(prev, rangeStart, rangeEnd, mediaDuration),
    );
  }, [rangeStart, rangeEnd, mediaDuration]);

  const handleZoomOut = useCallback(() => {
    setViewport((prev) =>
      zoomOutViewport(prev, rangeStart, rangeEnd, mediaDuration),
    );
  }, [rangeStart, rangeEnd, mediaDuration]);

  const rangeInvalid =
    rangeStart >= rangeEnd ||
    rangeStart < 0 ||
    (durationKnown && rangeEnd > mediaDuration);

  // Sync playback state from the hidden audio element
  useEffect(() => {
    const audio = audioElement;
    if (!audio) return;

    const onPlay = () => setIsAudioPlaying(true);
    const onPause = () => setIsAudioPlaying(false);
    const onTimeUpdate = () => setAudioCurrentTime(audio.currentTime);
    const onDurationChange = () => {
      if (isValidDuration(audio.duration)) setAudioDuration(audio.duration);
    };
    const onLoadedMetadata = () => {
      if (isValidDuration(audio.duration)) setAudioDuration(audio.duration);
    };
    const onEnded = () => setIsAudioPlaying(false);

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, [audioElement]);

  useEffect(() => {
    if (open) {
      setAudioCurrentTime(0);
      setIsAudioPlaying(false);
      setAudioDuration(
        isValidDuration(audioExpectedDuration) ? audioExpectedDuration : 0,
      );
      if (audioElement) {
        audioElement.currentTime = 0;
      }
    }
  }, [open, audioUrl, audioExpectedDuration, audioElement]);

  const toggleAudioPlay = useCallback(() => {
    const audio = audioElement;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [audioElement]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="entei-mining-dialog"
        closeLabel={dict.dialogClose}
      >
        <DialogHeader>
          <DialogTitle>{dict.miningPreviewTitle}</DialogTitle>
          <DialogDescription>
            {isCapturing
              ? dict.miningPreviewCapturing
              : isRefreshing
                ? dict.miningPreviewRefreshing
                : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="entei-mining-body">
          {(isCapturing || isRefreshing) && (
            <div
              className="entei-mining-processing-overlay"
              role="status"
              aria-live="polite"
            >
              <span className="entei-mining-processing-spinner" aria-hidden />
              <span>
                {isRefreshing
                  ? dict.miningPreviewRefreshing
                  : dict.miningPreviewCapturing}
              </span>
            </div>
          )}

          {/* AM-4: Mapped editable draft fields */}
          {draftFields.map((field, index) => {
            const isPreviewOnly =
              field.key === 'image' || field.key === 'audio';
            const isTextarea =
              field.key === 'sentence' || field.key === 'definition';
            const hasImage = field.key === 'image' && screenshotUrl !== null;
            const hasImageError = field.key === 'image' && hasScreenshotError;
            const hasImageUnavailable =
              field.key === 'image' && isScreenshotUnavailable;
            const hasImageSkeleton =
              field.key === 'image' && (isCapturing || isRefreshing);
            const hasAudio = field.key === 'audio' && audioUrl !== null;
            const hasAudioErr = field.key === 'audio' && hasAudioError;

            return (
              <div key={field.key} className="entei-mining-section">
                <p className="entei-mining-label">{field.physicalName}</p>

                {!isPreviewOnly && isTextarea ? (
                  <textarea
                    className="entei-mining-input entei-mining-textarea"
                    value={field.value}
                    onChange={(e) => onDraftFieldChange(index, e.target.value)}
                    rows={field.key === 'sentence' ? 3 : 2}
                    aria-label={field.physicalName}
                  />
                ) : !isPreviewOnly ? (
                  <input
                    type="text"
                    className="entei-mining-input"
                    value={field.value}
                    onChange={(e) => onDraftFieldChange(index, e.target.value)}
                    aria-label={field.physicalName}
                  />
                ) : null}

                {hasImage && (
                  <AspectRatio ratio={16 / 9}>
                    <div className="entei-mining-image-wrap">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={screenshotUrl}
                        alt={field.physicalName}
                        className="entei-mining-image"
                        loading="eager"
                      />
                    </div>
                  </AspectRatio>
                )}
                {hasImageSkeleton && !hasImage && (
                  <AspectRatio ratio={16 / 9}>
                    <div className="entei-mining-placeholder" aria-busy>
                      <span
                        className="entei-mining-skeleton entei-mining-skeleton--image"
                        aria-hidden
                      />
                      <p>{dict.miningPreviewCapturing}</p>
                    </div>
                  </AspectRatio>
                )}
                {hasImageUnavailable && (
                  <div className="entei-mining-unavailable">
                    <p>{dict.miningPreviewScreenshotUnavailable}</p>
                  </div>
                )}
                {hasImageError && (
                  <div className="entei-mining-error" role="alert">
                    <p>{dict.miningPreviewScreenshotError}</p>
                  </div>
                )}

                {hasAudio && (
                  <div className="entei-mining-audio-player">
                    <audio
                      ref={setAudioElement}
                      src={audioUrl}
                      preload="metadata"
                      className="entei-mining-audio-native"
                    />

                    <div className="entei-mining-audio-controls">
                      <button
                        type="button"
                        className="entei-mining-audio-play-btn"
                        onClick={toggleAudioPlay}
                        aria-label={
                          isAudioPlaying
                            ? dict.audioClipPause
                            : dict.audioClipPlay
                        }
                        title={
                          isAudioPlaying
                            ? dict.audioClipPause
                            : dict.audioClipPlay
                        }
                      >
                        {isAudioPlaying ? (
                          <Pause size={20} aria-hidden />
                        ) : (
                          <Play size={20} aria-hidden />
                        )}
                      </button>

                      <span className="entei-mining-audio-time" aria-live="off">
                        {formatTime(audioCurrentTime)} /{' '}
                        {formatTime(audioDuration)}
                      </span>
                    </div>
                  </div>
                )}
                {hasAudioErr && (
                  <div className="entei-mining-error" role="alert">
                    <p>{dict.miningPreviewAudioError}</p>
                  </div>
                )}
                {field.key === 'audio' &&
                  !hasAudio &&
                  !hasAudioErr &&
                  (isCapturing || isRefreshing) && (
                    <div
                      className="entei-mining-placeholder"
                      aria-busy={isCapturing || isRefreshing}
                    >
                      <span
                        className="entei-mining-skeleton entei-mining-skeleton--audio"
                        aria-hidden
                      />
                      <p>
                        {isRefreshing
                          ? dict.miningPreviewRefreshing
                          : dict.miningPreviewCapturing}
                      </p>
                    </div>
                  )}
              </div>
            );
          })}
        </div>

        {/* --- AM-4: Range dock — outside scrolling body, always visible --- */}
        <div className="entei-mining-range-dock">
          <div className="entei-mining-range-header">
            <p className="entei-mining-label">{dict.miningPreviewRange}</p>
            <span className="entei-mining-range-time" aria-live="off">
              <span className="entei-mining-range-start">
                {formatTime(rangeStart)}
              </span>
              {' – '}
              <span className="entei-mining-range-end">
                {formatTime(rangeEnd)}
              </span>
            </span>
          </div>

          {durationKnown ? (
            <>
              <div className="entei-mining-range-slider-wrap">
                <div className="entei-mining-range-slider-container">
                  <Slider
                    className="entei-mining-range-slider"
                    value={[rangeStart, rangeEnd]}
                    min={viewport.viewStart}
                    max={viewport.viewEnd}
                    step={0.1}
                    onValueChange={onRangeChange}
                    onValueCommit={onRangeCommit}
                    aria-label={dict.miningPreviewRange}
                    disabled={sliderDisabled}
                  />
                  {/* Subtitle-boundary marker ticks — noninteractive, aria-hidden */}
                  <div
                    className="entei-mining-range-markers"
                    aria-hidden="true"
                  >
                    {markers.map((m) => (
                      <span
                        key={m.id}
                        className="entei-mining-range-marker"
                        style={{ left: `${m.pct}%` }}
                      />
                    ))}
                  </div>
                </div>
                {rangeInvalid && (
                  <p className="entei-mining-range-invalid">
                    {dict.miningPreviewRangeInvalid}
                  </p>
                )}
              </div>

              {/* Control row: ZoomOut LEFT, ZoomIn RIGHT — balanced */}
              <div className="entei-mining-range-controls">
                <button
                  type="button"
                  className="entei-mining-zoom-btn"
                  onClick={handleZoomOut}
                  disabled={zoomOutDisabled}
                  aria-label={dict.miningZoomOut}
                  title={dict.miningZoomOut}
                >
                  <ZoomOut size={18} aria-hidden />
                </button>
                <div className="entei-mining-range-controls-spacer" />
                <button
                  type="button"
                  className="entei-mining-zoom-btn"
                  onClick={handleZoomIn}
                  disabled={zoomInDisabled}
                  aria-label={dict.miningZoomIn}
                  title={dict.miningZoomIn}
                >
                  <ZoomIn size={18} aria-hidden />
                </button>
              </div>
            </>
          ) : (
            <div className="entei-mining-range-disabled">
              <p className="entei-mining-range-time">
                {formatTime(rangeStart)} – {formatTime(rangeEnd)}
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
