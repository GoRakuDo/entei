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
 *
 * AM-6c: Single 3-item ToggleGroup (New / Update / Append).
 * Third mode is ephemeral — not persisted to localStorage.
 * Send routes to onAppend when in third mode.
 * --------------------------------------------------------------------------- */

'use client';

import {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useId,
  useRef,
} from 'react';
import {
  Play,
  Pause,
  ZoomIn,
  ZoomOut,
  Send,
  FilePlusCorner,
  FileUp,
  Search,
  Image as ImageIcon,
  Video,
} from 'lucide-react';
import { AnkiAppendPanel } from '@/components/player/AnkiAppendPanel';
import type { AnkiNoteInfo } from '@/features/player/anki-export-client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/player/ui/dialog';
import { Slider } from '@/components/player/ui/slider';
import { AspectRatio } from '@/components/player/ui/aspect-ratio';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/player/ui/toggle-group';
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

type ToggleValue = 'new' | 'update' | 'append';

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
  // Stage 2: Export controls
  exportMode: 'new' | 'update';
  onExportModeChange: (mode: 'new' | 'update') => void;
  isExporting: boolean;
  canExport: boolean;
  exportDisabledReason: string | null;
  exportError: string | null;
  exportSuccess: boolean;
  onExportSend: () => void;
  // AM-6c: Append panel (inline, not sibling Dialog)
  onAppendSearch: (query: string) => Promise<AnkiNoteInfo[]>;
  onAppend: (
    noteIds: number[],
  ) => Promise<{ succeeded: number[]; failed: number[] }>;
  isAppending: boolean;
  appendResult: {
    succeeded: number[];
    failed: number[];
  } | null;
  appendSendDisabledReason: string | null;
  savedDeck: string;
  savedNoteType: string;
  sentenceFieldName: string | null;
  // Video Clip: media mode toggle
  mediaMode: 'image' | 'video';
  onMediaModeChange: (mode: 'image' | 'video') => void;
  mediaPreviewUrl: string | null;
  mediaPreviewType: 'image' | 'video';
  mediaUnsupported: string | null;
  isMediaRecapturing: boolean;
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
    exportModeNew: string;
    exportModeUpdate: string;
    exportSendNew: string;
    exportNoCandidate: string;
    exportSuccess: string;
    exportError: string;
    exportSendDisabledNoConnection: string;
    exportSendDisabledInvalidPreset: string;
    exportSendDisabledNoSentence: string;
    exportSendDisabledRequestActive: string;
    appendSelectLabel: string;
    // Append panel dict keys (forwarded to AnkiAppendPanel)
    appendDialogTitle: string;
    appendDialogDescription: string;
    appendSearchPlaceholder: string;
    appendSearchButton: string;
    appendSearching: string;
    appendNoResults: string;
    appendSearchError: string;
    appendNoteIdLabel: string;
    appendNoteTypeLabel: string;
    appendSuccess: string;
    appendPartialFailure: string;
    appendAllFailed: string;
    appendSelectedCount: (count: number) => string;
    mediaModeImage: string;
    mediaModeVideo: string;
    mediaModeUnsupported: string;
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
  exportMode,
  onExportModeChange,
  isExporting,
  canExport,
  exportDisabledReason,
  exportError,
  exportSuccess,
  onExportSend,
  onAppendSearch,
  onAppend,
  isAppending,
  appendResult,
  appendSendDisabledReason,
  savedDeck,
  savedNoteType,
  sentenceFieldName,
  mediaMode,
  onMediaModeChange,
  mediaPreviewUrl,
  mediaPreviewType,
  mediaUnsupported,
  isMediaRecapturing,
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

  // AM-6c: Ephemeral toggle value — 'append' is never persisted
  const [toggleValue, setToggleValue] = useState<ToggleValue>(() => exportMode);
  const isAppendMode = toggleValue === 'append';
  const appendPanelId = useId();

  // AM-6c: Lifted selection state (memory-only, ephemeral)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

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
    setViewport(computeInitialViewport(rangeStart, rangeEnd, mediaDuration));
    setViewportInitialized(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !durationKnown || !viewportInitialized) return;
    setViewport((prev) =>
      reframeIfNeeded(prev, rangeStart, rangeEnd, mediaDuration),
    );
  }, [
    rangeStart,
    rangeEnd,
    mediaDuration,
    open,
    durationKnown,
    viewportInitialized,
  ]);

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
    !durationKnown ||
    isCapturing ||
    isRefreshing ||
    !canRefresh ||
    isExporting ||
    isAppending;
  const zoomDisabled =
    !durationKnown || isCapturing || isRefreshing || isExporting;
  const zoomInDisabled =
    zoomDisabled || !canZoomIn(viewport, rangeStart, rangeEnd);
  const zoomOutDisabled = zoomDisabled || !canZoomOut(viewport, mediaDuration);

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
      // Reset toggle to persisted mode on open
      setToggleValue(exportMode);
      setSelectedIds(new Set());
    }
  }, [open, audioUrl, audioExpectedDuration, audioElement, exportMode]);

  const toggleAudioPlay = useCallback(() => {
    const audio = audioElement;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [audioElement]);

  /** AM-6c: Handle toggle value change within the single 3-item group. */
  const handleToggleChange = useCallback(
    (value: string) => {
      if (!value) return; // empty string = no selection (Radix deselection)
      if (value === 'new' || value === 'update') {
        setToggleValue(value);
        onExportModeChange(value);
      } else if (value === 'append') {
        setToggleValue('append');
      }
    },
    [onExportModeChange],
  );

  /** AM-6c: Operation identity to prevent stale completion from clearing newer selection. */
  const appendOpIdRef = useRef(0);

  /** AM-6c: Send button — routes based on current mode. After append, auto-remove only succeeded IDs. */
  const handleSendClick = useCallback(() => {
    if (isAppendMode) {
      const idsToSend = Array.from(selectedIds).filter((id) => id > 0);
      if (idsToSend.length === 0) return;
      const opId = ++appendOpIdRef.current;
      onAppend(idsToSend.sort((a, b) => a - b)).then((result) => {
        // Guard: stale operation — a newer send was initiated, don't touch state
        if (appendOpIdRef.current !== opId) return;
        if (result.succeeded.length > 0) {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const id of result.succeeded) {
              next.delete(id);
            }
            return next;
          });
        }
      });
    } else {
      onExportSend();
    }
  }, [isAppendMode, selectedIds, onAppend, onExportSend]);

  /** AM-6c: Determine Send button disabled state. */
  const sendDisabled = useMemo(() => {
    if (isAppendMode) {
      return (
        selectedIds.size === 0 || isAppending || !!appendSendDisabledReason
      );
    }
    return !canExport;
  }, [
    isAppendMode,
    selectedIds.size,
    isAppending,
    appendSendDisabledReason,
    canExport,
  ]);

  const sendLabel = useMemo(() => {
    if (isAppendMode) {
      return appendSendDisabledReason ?? dict.exportSendNew;
    }
    return exportDisabledReason ?? dict.exportSendNew;
  }, [
    isAppendMode,
    appendSendDisabledReason,
    exportDisabledReason,
    dict.exportSendNew,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="entei-mining-dialog"
        closeLabel={dict.dialogClose}
      >
        <DialogHeader>
          {/* Visually hidden title for accessible dialog naming */}
          <DialogTitle className="entei-sr-only">
            {dict.miningPreviewTitle}
          </DialogTitle>
          <DialogDescription className="entei-sr-only">
            {isCapturing
              ? dict.miningPreviewCapturing
              : isRefreshing
                ? dict.miningPreviewRefreshing
                : ''}
          </DialogDescription>
          {/* Image/Video media mode toggle — fixed in header, left-aligned */}
          <div className="entei-mining-header-media-toggle">
            <ToggleGroup
              type="single"
              value={mediaMode}
              onValueChange={(v) => {
                if (v === 'image' || v === 'video') onMediaModeChange(v);
              }}
              variant="outline"
              aria-label={dict.mediaModeImage + ' / ' + dict.mediaModeVideo}
            >
              <ToggleGroupItem
                value="image"
                aria-label={dict.mediaModeImage}
                title={dict.mediaModeImage}
                disabled={isExporting || isAppending}
              >
                <ImageIcon size={16} aria-hidden />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="video"
                aria-label={dict.mediaModeVideo}
                title={dict.mediaModeVideo}
                disabled={isExporting || isAppending}
              >
                <Video size={16} aria-hidden />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
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
            // Single resolved media source: prefer mediaPreviewUrl, fall back to screenshotUrl
            const mediaSrc =
              field.key === 'image' ? (mediaPreviewUrl ?? screenshotUrl) : null;
            const hasImage = field.key === 'image' && mediaSrc !== null;
            const hasImageError = field.key === 'image' && hasScreenshotError;
            const hasImageUnavailable =
              field.key === 'image' && isScreenshotUnavailable;
            const hasImageSkeleton =
              field.key === 'image' &&
              (isCapturing || isRefreshing || isMediaRecapturing);
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

                {hasImage &&
                  mediaPreviewType === 'video' &&
                  mediaPreviewUrl && (
                    <AspectRatio ratio={16 / 9}>
                      <div className="entei-mining-image-wrap">
                        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                        <video
                          src={mediaPreviewUrl}
                          muted
                          controls
                          playsInline
                          className="entei-mining-media-video"
                        />
                      </div>
                    </AspectRatio>
                  )}
                {hasImage &&
                  (mediaPreviewType !== 'video' || !mediaPreviewUrl) &&
                  mediaSrc && (
                    <AspectRatio ratio={16 / 9}>
                      <div className="entei-mining-image-wrap">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={mediaSrc}
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
                {/* Video fallback explanation — inside Picture field so it's always visible */}
                {field.key === 'image' &&
                  mediaMode === 'video' &&
                  mediaUnsupported && (
                    <div className="entei-media-unsupported" role="status">
                      <p>{mediaUnsupported}</p>
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

          {/* AM-6c: Single 3-item centered ToggleGroup — New + Update + Append */}
          <div className="entei-mining-controls-row">
            <ToggleGroup
              type="single"
              value={toggleValue}
              onValueChange={handleToggleChange}
              disabled={isExporting || isAppending}
              variant="outline"
              aria-label="Export mode"
            >
              <ToggleGroupItem
                value="new"
                aria-label={dict.exportModeNew}
                disabled={isExporting || isAppending}
              >
                <FilePlusCorner size={16} aria-hidden />
                <span>{dict.exportModeNew}</span>
              </ToggleGroupItem>
              <ToggleGroupItem
                value="update"
                aria-label={dict.exportModeUpdate}
                disabled={isExporting || isAppending}
              >
                <FileUp size={16} aria-hidden />
                <span>{dict.exportModeUpdate}</span>
              </ToggleGroupItem>
              <ToggleGroupItem
                value="append"
                aria-label={dict.appendSelectLabel}
                title={dict.appendSelectLabel}
                disabled={isExporting || isAppending}
              >
                <Search size={16} aria-hidden />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* AM-6c: Inline append panel (collapsible, ephemeral) */}
          <AnkiAppendPanel
            open={isAppendMode}
            dict={dict}
            savedNoteType={savedNoteType}
            savedDeck={savedDeck}
            sentenceFieldName={sentenceFieldName}
            onSearch={onAppendSearch}
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
            id={appendPanelId}
          />

          {/* Append result feedback */}
          {appendResult && (
            <div
              className="entei-mining-append-result"
              role="status"
              aria-live="polite"
            >
              {appendResult.failed.length > 0 &&
              appendResult.succeeded.length > 0 ? (
                <p className="entei-mining-append-partial">
                  {dict.appendPartialFailure} ({appendResult.succeeded.length}/
                  {appendResult.succeeded.length + appendResult.failed.length})
                </p>
              ) : appendResult.failed.length > 0 ? (
                <p className="entei-mining-append-error">
                  {dict.appendAllFailed}
                </p>
              ) : (
                <p className="entei-mining-append-success">
                  {dict.appendSuccess}
                </p>
              )}
            </div>
          )}
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

              {/* Control row: ZoomOut LEFT, Send CENTER, ZoomIn RIGHT */}
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
                <button
                  type="button"
                  className="entei-mining-export-send-btn"
                  onClick={handleSendClick}
                  disabled={sendDisabled}
                  aria-label={dict.exportSendNew}
                  title={sendLabel}
                >
                  <Send size={16} aria-hidden />
                  <span>{dict.exportSendNew}</span>
                </button>
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

              {/* Stage 2: Export status (error/success) */}
              <div className="entei-mining-export-status">
                {/* Error/success status */}
                {exportError && (
                  <p className="entei-mining-export-error" role="alert">
                    {exportError}
                  </p>
                )}
                {exportSuccess && (
                  <p
                    className="entei-mining-export-success"
                    role="status"
                    aria-live="polite"
                  >
                    {dict.exportSuccess}
                  </p>
                )}
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
