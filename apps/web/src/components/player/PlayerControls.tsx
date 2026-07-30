/**
 * PlayerControls — Custom control layer for both video and audio.
 * ---------------------------------------------------------------------------
 * P1.1 Custom Control Layer:
 * - Top-left: media name (ellipsis + title) [Fix #1]
 * - Top-right: Timeline toggle, Settings popover [Fix #2, #13]
 * - Bottom: seek slider, play/pause, timestamps, volume, rate, fullscreen
 * - Visibility: auto-hide on idle (desktop + playing), throttled pointer [Fix #6]
 * - Seek: isSeeking prevents timeupdate overwriting drag [Fix #7]
 * - Volume: touch opens slider, click toggles mute [Fix #5]
 * - Fullscreen: standard + webkit fallback via helpers [Fix #3]
 * - Keyboard: Space/Enter on buttons doesn't fire global shortcuts
 * - Accessibility: ARIA labels, focus-visible, 44px targets, reduced motion
 * --------------------------------------------------------------------------- */
'use client';

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  forwardRef,
  useImperativeHandle,
  type RefObject,
} from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Gauge,
  Maximize2,
  Minimize2,
  Timeline,
  ClosedCaption,
  Captions,
  CaptionsOff,
  Pickaxe,
  FolderOpenDot,
} from 'lucide-react';
import type { Dictionary } from '@i18n/types';
import { Slider } from '@/components/player/ui/slider';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/player/ui/popover';
import {
  RadioGroup,
  RadioGroupItem,
} from '@/components/player/ui/radio-group';
import { PlayerSettingsDialog } from '@/components/player/PlayerSettingsDialog';
import {
  formatTime,
  clampSeek,
  toggleMute,
  PLAYBACK_RATES,
  nextControlsVisibility,
  shouldScheduleAutoHide,
  requestFullscreenCompat,
  exitFullscreenCompat,
  type VisibilityEvent,
  type CaptionDisplayMode,
  type PlayMode,
} from '@/features/player/control-helpers';
import type { ShortcutEntry } from '@/components/player/KeyboardShortcutsHelp';

interface PlayerControlsProps {
  mediaRef: RefObject<HTMLMediaElement | null>;
  surfaceRef: RefObject<HTMLDivElement | null>;
  isPlaying: boolean;
  isLoading: boolean;
  error: string | null;
  hasMedia: boolean;
  mediaType: 'video' | 'audio' | null;
  /**
   * P1: Stable media identity (the media URL). The listener effect uses this
   * as a dependency so it reattaches when the media element changes (video↔audio
   * switch, new file). mediaRef is a React ref object whose identity never changes,
   * so it alone cannot trigger reattachment.
   */
  mediaKey: string;
  dict: Dictionary['playerUI'];
  /** Fix #1: Displayed top-left with ellipsis + title tooltip. */
  mediaName: string;
  isSubtitlePanelVisible: boolean;
  onToggleSubtitlePanel: () => void;
  // P1.3a.2: Caption display mode
  captionDisplayMode: CaptionDisplayMode;
  onCycleCaptionMode: () => void;
  volume: number;
  onVolumeChange: (volume: number) => void;
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
  // P2.1: Playback mode
  playMode?: PlayMode;
  onPlayModeChange?: (mode: PlayMode) => void;
  shortcuts: ShortcutEntry[];
  isTouchDevice: boolean;
  /** Mobile viewport hides volume controls; desktop touch devices stay unchanged. */
  isMobileViewport?: boolean;
  reducedMotion: boolean;
  /** AM-4: Called when the Mine button is pressed. */
  onMine?: () => void;
  /** AM-4: Whether mining is currently possible (active cue + not already mining/capturing). */
  canMine?: boolean;
  /** AM-4: Whether a mining capture is currently in flight. */
  isMining?: boolean;
  /** Called when the file-open button selects a file (routed by PlayerApp). */
  onFileOpen?: (file: File) => void;
  /** Accept attribute for the file input. */
  fileAccept?: string;
  /** Localized aria-label for the file-open button. */
  fileOpenLabel?: string;
  /** Stage 2: Session credentials bridge from AnkiFieldsTab to PlayerApp. */
  onSessionCredentials?: (
    creds: { endpoint: string; apiKey: string } | null,
  ) => void;
  // P2.1: Subtitle appearance settings
  subtitleSettings?: {
    fontSize: number;
    textColor: string;
    backgroundColor: string;
    backgroundPadding: number;
    verticalPosition: number;
  };
  onSubtitleSettingsChange?: (settings: Partial<{
    fontSize: number;
    textColor: string;
    backgroundColor: string;
    backgroundPadding: number;
    verticalPosition: number;
  }>) => void;
}

export interface PlayerControlsHandle {
  /** P2: Imperatively reveal controls (e.g. on cue click while hidden). */
  show: () => void;
  /** Hide controls (used by touch surface tap to toggle off). */
  hide: () => void;
  /** Check if controls are currently visible (read-only check). */
  getVisible: () => boolean;
}

export const PlayerControls = forwardRef<
  PlayerControlsHandle,
  PlayerControlsProps
>(function PlayerControls(
  {
    mediaRef,
    surfaceRef,
    isPlaying,
    isLoading,
    error,
    hasMedia,
    mediaType,
    mediaKey,
    dict,
    mediaName,
    isSubtitlePanelVisible,
    onToggleSubtitlePanel,
    captionDisplayMode,
    onCycleCaptionMode,
    volume,
    onVolumeChange,
    playbackRate,
    onPlaybackRateChange,
    playMode = 'normal',
    onPlayModeChange = () => {},
    shortcuts,
    isTouchDevice,
    isMobileViewport = false,
    reducedMotion,
    onMine,
    canMine,
    isMining,
    onFileOpen,
    fileAccept,
    fileOpenLabel,
    onSessionCredentials,
    subtitleSettings,
    onSubtitleSettingsChange,
  },
  ref,
) {
  // --- Local state ---
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isVisible, setIsVisible] = useState(true);
  const [prevVolume, setPrevVolume] = useState(volume > 0 ? volume : 0.5);
  const [isVolumeOpen, setIsVolumeOpen] = useState(false);
  const [isRateOpen, setIsRateOpen] = useState(false);
  // AM-1: Dialog-based Settings Modal
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  // Fix #7: isSeeking prevents timeupdate from overwriting dragged seek value
  const [isSeeking, setIsSeeking] = useState(false);
  // Fix #1 (review): Dedicated seekValue for continuous drag position —
  // never passes value={[]}. seekStartFiredRef ensures showControls only fires once.
  const seekValueRef = useRef<number | null>(null);
  const seekStartFiredRef = useRef(false);
  // Fix #6: Ref for throttling pointer move
  const lastPointerMoveRef = useRef(0);

  // --- Refs ---
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- File open handler ---
  const handleFileOpenClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && onFileOpen) {
        onFileOpen(file);
      }
      // Reset so selecting the same file again triggers onChange
      e.target.value = '';
    },
    [onFileOpen],
  );

  // --- Sync media time to state (paused during seek) ---
  // P1: mediaKey is the media URL — a stable identity for the current media.
  // When it changes (new file, video↔audio switch), this effect reattaches
  // listeners to the newly mounted element via mediaRef.current.
  useEffect(() => {
    // Reset state immediately when media changes to avoid stale display
    setCurrentTime(0);
    setDuration(0);

    const media = mediaRef.current;
    if (!media) return;
    const onTimeUpdate = () => {
      // Fix #7: Don't overwrite while user is dragging the seek slider
      if (!isSeeking) setCurrentTime(media.currentTime);
    };
    const onDurationChange = () => {
      const d = media.duration;
      setDuration(Number.isFinite(d) ? d : 0);
    };
    const onEnded = () => {
      setIsVisible(true);
      clearHideTimer();
    };
    const onError = () => {
      setIsVisible(true);
      clearHideTimer();
    };
    const onLoadedMetadata = () => {
      const d = media.duration;
      setDuration(Number.isFinite(d) ? d : 0);
    };

    media.addEventListener('timeupdate', onTimeUpdate);
    media.addEventListener('durationchange', onDurationChange);
    media.addEventListener('ended', onEnded);
    media.addEventListener('error', onError);
    media.addEventListener('loadedmetadata', onLoadedMetadata);
    onDurationChange();
    onTimeUpdate();

    return () => {
      media.removeEventListener('timeupdate', onTimeUpdate);
      media.removeEventListener('durationchange', onDurationChange);
      media.removeEventListener('ended', onEnded);
      media.removeEventListener('error', onError);
      media.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  }, [mediaRef, mediaKey, hasMedia, isSeeking]);

  // --- Fullscreen change listener (standard + webkit) ---
  useEffect(() => {
    const onFullscreenChange = () => {
      if (typeof document === 'undefined') return;
      const isFs =
        document.fullscreenElement != null ||
          (document as unknown as { webkitFullscreenElement?: Element | null })
            .webkitFullscreenElement != null;
      setIsFullscreen(isFs);
      // Add/remove class on document.body for CSS to hide mobile dock during fullscreen
      if (isFs) {
        document.body.classList.add('entei-fullscreen-active');
      } else {
        document.body.classList.remove('entei-fullscreen-active');
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener(
      'webkitfullscreenchange',
      onFullscreenChange as EventListener,
    );
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener(
        'webkitfullscreenchange',
        onFullscreenChange as EventListener,
      );
      // Clean up body class on unmount so it cannot leak after component removal.
      document.body.classList.remove('entei-fullscreen-active');
    };
  }, []);

  // --- Fix #9: Keep prevVolume synced when volume prop changes externally ---
  useEffect(() => {
    if (volume > 0) setPrevVolume(volume);
  }, [volume]);

  // --- Auto-hide timer ---
  const clearHideTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startHideTimer = useCallback(() => {
    clearHideTimer();
    if (!isPlaying || !shouldScheduleAutoHide(isTouchDevice, reducedMotion))
      return;
    timerRef.current = setTimeout(() => {
      const next = nextControlsVisibility(
        { type: 'timer-expired' },
        true,
        true,
      );
      if (!next.visible) setIsVisible(false);
    }, 2500);
  }, [isPlaying, reducedMotion, isTouchDevice, clearHideTimer]);

  // P2: Expose show/hide/getVisible handles for imperative control.
  useImperativeHandle(ref, () => ({
    show: () => {
      setIsVisible(true);
      clearHideTimer();
      if (isPlaying && shouldScheduleAutoHide(isTouchDevice, reducedMotion))
        startHideTimer();
    },
    hide: () => {
      setIsVisible(false);
      clearHideTimer();
    },
    getVisible: () => isVisible,
  }));

  useEffect(() => {
    if (
      isPlaying &&
      isVisible &&
      shouldScheduleAutoHide(isTouchDevice, reducedMotion)
    ) {
      startHideTimer();
    } else {
      clearHideTimer();
    }
    return clearHideTimer;
  }, [
    isPlaying,
    isVisible,
    isTouchDevice,
    reducedMotion,
    startHideTimer,
    clearHideTimer,
  ]);

  // --- Show controls helper ---
  const showControls = useCallback(
    (event?: VisibilityEvent) => {
      const next = nextControlsVisibility(
        event ?? { type: 'pointer-move' },
        isPlaying,
        isVisible,
      );
      if (next.visible) {
        setIsVisible(true);
        if (isPlaying && shouldScheduleAutoHide(isTouchDevice, reducedMotion))
          startHideTimer();
      }
    },
    [isPlaying, isVisible, isTouchDevice, reducedMotion, startHideTimer],
  );

  // --- Fix #6: Throttled pointer move (~100ms) ---
  const handlePointerMove = useCallback(() => {
    const now = Date.now();
    if (now - lastPointerMoveRef.current < 100) return;
    lastPointerMoveRef.current = now;
    showControls({ type: 'pointer-move' });
  }, [showControls]);

  // --- Play/Pause ---
  const handlePlayPause = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const media = mediaRef.current;
      if (!media || isLoading || error) return;
      if (media.paused) {
        media.play().catch(() => {});
      } else {
        media.pause();
      }
      showControls({ type: isPlaying ? 'media-paused' : 'media-played' });
    },
    [mediaRef, isLoading, error, isPlaying, showControls],
  );

  // --- Seek (Fix #1+7: seekValue ref for continuous drag, single seek-start) ---
  const handleSeekStart = useCallback(() => {
    // Only fire controls show + hide-timer-reset once per drag
    if (!seekStartFiredRef.current) {
      seekStartFiredRef.current = true;
      setIsSeeking(true);
      showControls({ type: 'seek-start' });
    }
  }, [showControls]);

  const handleSeekValueChange = useCallback(
    (value: number[]) => {
      const t = value[0];
      if (t !== undefined) {
        seekValueRef.current = clampSeek(t, duration);
        setCurrentTime(seekValueRef.current);
        handleSeekStart();
      }
    },
    [duration, handleSeekStart],
  );

  const handleSeekEnd = useCallback(
    (value: number[]) => {
      const media = mediaRef.current;
      const seekTime = value[0];
      if (media && seekTime !== undefined) {
        const clamped = clampSeek(seekTime, duration);
        media.currentTime = clamped;
        // Sync state immediately so slider doesn't show stale time
        // before the next timeupdate fires.
        setCurrentTime(clamped);
      }
      seekValueRef.current = null;
      seekStartFiredRef.current = false;
      setIsSeeking(false);
      showControls({ type: 'seek-end' });
    },
    [mediaRef, duration, showControls],
  );

  // Compute seek slider value: during drag use seekValueRef, otherwise media currentTime
  const seekSliderValue =
    isSeeking && seekValueRef.current !== null
      ? seekValueRef.current
      : currentTime;

  // --- Volume (Fix #2: touch = disclosure only; desktop = mute/unmute + hover) ---
  const handleVolumeButtonClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isTouchDevice) {
        // Touch: icon acts as slider disclosure — toggle open only, no mute
        setIsVolumeOpen((prev) => !prev);
      } else {
        // Desktop: icon toggles mute/unmute (hover reveals slider)
        const { volume: newVol, restored } = toggleMute(volume, prevVolume);
        onVolumeChange(newVol);
        if (restored > 0) setPrevVolume(restored);
      }
    },
    [volume, prevVolume, onVolumeChange, isTouchDevice],
  );

  const handleVolumeChange = useCallback(
    (value: number[]) => {
      const v = value[0];
      if (v !== undefined) {
        onVolumeChange(v);
        if (v > 0) setPrevVolume(v);
      }
    },
    [onVolumeChange],
  );

  // --- Rate ---
  const handleRateSelect = useCallback(
    (rate: number) => {
      onPlaybackRateChange(rate);
    },
    [onPlaybackRateChange],
  );

  // --- Fullscreen (Fix #3: standard + webkit fallback via helpers) ---
  const handleFullscreenToggle = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setFullscreenError(null);
      const el = surfaceRef.current;
      if (!el) return;

      try {
        if (isFullscreen) {
          await exitFullscreenCompat();
        } else {
          await requestFullscreenCompat(el);
        }
      } catch {
        setFullscreenError(dict.fullscreenError);
      }
    },
    [surfaceRef, isFullscreen, dict],
  );

  // --- Clear fullscreen error after 3 seconds ---
  useEffect(() => {
    if (!fullscreenError) return;
    const t = setTimeout(() => setFullscreenError(null), 3000);
    return () => clearTimeout(t);
  }, [fullscreenError]);

  // --- Prevent event propagation on all control interactions ---
  const stopProp = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  // --- Keyboard handler for Space/Enter on controls ---
  const handleControlKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.stopPropagation();
    }
  }, []);

  // --- Current formatted time ---
  const formattedCurrent = useMemo(
    () => formatTime(currentTime),
    [currentTime],
  );
  const formattedDuration = useMemo(() => formatTime(duration), [duration]);

  // --- Fix #2: Close volume/rate when Settings opens ---
  const handleSettingsOpenChange = useCallback((open: boolean) => {
    setIsSettingsOpen(open);
    if (open) {
      setIsVolumeOpen(false);
      setIsRateOpen(false);
    }
  }, []);

  // Fix #2: Also close Settings when volume/rate opens
  useEffect(() => {
    if (isVolumeOpen || isRateOpen) setIsSettingsOpen(false);
  }, [isVolumeOpen, isRateOpen]);

  // --- Whether controls should render ---
  if (!hasMedia) return null;

  return (
    <div
      ref={controlsRef}
      className={`entei-controls-layer${isVisible ? '' : ' entei-controls-layer--hidden'}`}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => showControls({ type: 'pointer-leave' })}
      onKeyDown={handleControlKeyDown}
      onClick={stopProp}
      role="toolbar"
      aria-label={dict.controlsShow}
    >
      {/* --- Top bar: name + timeline + settings --- */}
      <div className="entei-controls-top">
        {/* Fix #1: Media name rendered top-left with ellipsis + title */}
        {mediaName && (
          <span className="entei-controls-media-name" title={mediaName}>
            {mediaName}
          </span>
        )}
        <div className="entei-controls-top-right">
          {/* AM-4: Mine — for video/audio, before caption mode */}
          {(mediaType === 'video' || mediaType === 'audio') && (
            <button
              type="button"
              className="entei-controls-btn"
              onClick={(e) => {
                e.stopPropagation();
                onMine?.();
              }}
              aria-label={
                isMining ? dict.mineButtonCapturing : dict.mineButtonLabel
              }
              title={
                isMining
                  ? dict.mineButtonCapturing
                  : canMine === false
                    ? dict.mineButtonDisabled
                    : dict.mineButtonLabel
              }
              disabled={canMine === false || isMining === true}
            >
              <Pickaxe size={18} />
            </button>
          )}

          {/* File open — opens native picker, routes via PlayerApp */}
          {onFileOpen && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept={fileAccept}
                onChange={handleFileInputChange}
                className="entei-sr-only"
                aria-label={fileOpenLabel}
                tabIndex={-1}
              />
              <button
                type="button"
                className="entei-controls-btn"
                onClick={handleFileOpenClick}
                aria-label={fileOpenLabel}
                title={fileOpenLabel}
              >
                <FolderOpenDot size={18} />
              </button>
            </>
          )}

          {/* Fix #13: Timeline button hidden via CSS in landscape immersive */}
          <button
            type="button"
            className="entei-controls-btn entei-controls-timeline-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSubtitlePanel();
            }}
            aria-pressed={isSubtitlePanelVisible}
            aria-label={
              isSubtitlePanelVisible ? dict.timelineHide : dict.timelineShow
            }
            title={dict.timelineToggle}
          >
            <Timeline size={18} />
          </button>

          {/* AM-1: Settings Dialog replacing Popover */}
          <PlayerSettingsDialog
            dict={dict}
            shortcuts={shortcuts}
            open={isSettingsOpen}
            onOpenChange={handleSettingsOpenChange}
            onSessionCredentials={onSessionCredentials}
            subtitleSettings={subtitleSettings}
            onSubtitleSettingsChange={onSubtitleSettingsChange}
          />
        </div>
      </div>

      {/* --- Two-row bottom bar: seek on top, controls below --- */}
      <div className="entei-controls-bottom">
        <div className="entei-controls-seek">
          <Slider
            className="entei-controls-seek-slider"
            value={[seekSliderValue]}
            defaultValue={[0]}
            max={duration > 0 ? duration : 100}
            step={0.1}
            onValueChange={handleSeekValueChange}
            onValueCommit={handleSeekEnd}
            aria-label={dict.seekAriaLabel}
          />
        </div>
        <div className="entei-controls-bottom-row">
          <div className="entei-controls-bottom-left">
            <button
              type="button"
              className="entei-controls-btn entei-controls-play-btn"
              onClick={handlePlayPause}
              aria-label={isPlaying ? dict.pauseLabel : dict.playLabel}
              title={isPlaying ? dict.pauseLabel : dict.playLabel}
            >
              {isPlaying ? <Pause size={22} /> : <Play size={22} />}
            </button>
            <span className="entei-controls-time">
              <span className="entei-controls-time-current">
                {formattedCurrent}
              </span>
              <span className="entei-controls-time-sep"> / </span>
              <span className="entei-controls-time-total">
                {formattedDuration}
              </span>
            </span>

            {/* Volume — desktop only; mobile media is always full volume. */}
            {!isMobileViewport && (
              <div className="entei-controls-volume-group">
                <button
                  type="button"
                  className="entei-controls-btn"
                  onClick={handleVolumeButtonClick}
                  aria-label={
                    isTouchDevice
                      ? isVolumeOpen
                        ? dict.hideVolume
                        : dict.showVolume
                      : volume > 0
                        ? dict.muteAriaLabel
                        : dict.unmuteAriaLabel
                  }
                  title={
                    isTouchDevice
                      ? isVolumeOpen
                        ? dict.hideVolume
                        : dict.showVolume
                      : volume > 0
                        ? dict.muteAriaLabel
                        : dict.unmuteAriaLabel
                  }
                >
                  {volume > 0 ? <Volume2 size={18} /> : <VolumeX size={18} />}
                </button>
                {/* Absolutely positioned popout — zero layout space when closed */}
                <div
                  className={`entei-controls-volume-popup${isVolumeOpen ? ' entei-controls-volume-popup--open' : ''}`}
                  onMouseEnter={() => !isTouchDevice && setIsVolumeOpen(true)}
                  onMouseLeave={() => !isTouchDevice && setIsVolumeOpen(false)}
                  onFocus={() => setIsVolumeOpen(true)}
                  onBlur={() => setIsVolumeOpen(false)}
                >
                  <Slider
                    className="entei-controls-volume-slider"
                    value={[volume]}
                    min={0}
                    max={1}
                    step={0.01}
                    onValueChange={handleVolumeChange}
                    aria-label={dict.volumeSliderAriaLabel}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="entei-controls-bottom-right">
            {/* Rate — icon only */}
            <Popover open={isRateOpen} onOpenChange={setIsRateOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="entei-controls-btn entei-controls-rate-btn"
                  aria-label={`${dict.rateAriaLabel}: ${playbackRate}x`}
                  title={dict.rateLabel}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Gauge size={18} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="entei-rate-popover"
                side="top"
                align="center"
                onClick={stopProp}
                onPointerDown={stopProp}
              >
                <p className="entei-rate-popover-title">{dict.rateLabel}</p>
                <div className="entei-rate-list">
                  {PLAYBACK_RATES.map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      className={`entei-rate-option${rate === playbackRate ? ' entei-rate-option--active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRateSelect(rate);
                        setIsRateOpen(false);
                      }}
                      aria-label={`${rate}x`}
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
                {/* P2.1: Playback mode radio group */}
                <div className="entei-rate-popover-divider" />
                <p className="entei-rate-popover-title">
                  {dict.playModeLabel}
                </p>
                <RadioGroup
                  value={playMode}
                  onValueChange={(value) => {
                    onPlayModeChange(value as PlayMode);
                  }}
                  className="entei-play-mode-group"
                >
                  <label className="entei-play-mode-option">
                    <RadioGroupItem
                      value="normal"
                      aria-label={dict.playModeNormal}
                    />
                    <span>{dict.playModeNormal}</span>
                  </label>
                  <label className="entei-play-mode-option">
                    <RadioGroupItem
                      value="condensed"
                      aria-label={dict.playModeCondensed}
                    />
                    <span>{dict.playModeCondensed}</span>
                  </label>
                  <label className="entei-play-mode-option">
                    <RadioGroupItem
                      value="fast-forward"
                      aria-label={dict.playModeFastForward}
                    />
                    <span>{dict.playModeFastForward}</span>
                  </label>
                </RadioGroup>
              </PopoverContent>
            </Popover>

            {/* P1.3a.2: Caption display mode cycle button — bottom-right. */}
            <button
              type="button"
              className="entei-controls-btn"
              onClick={(e) => {
                e.stopPropagation();
                onCycleCaptionMode();
              }}
              aria-label={
                captionDisplayMode === 'visible'
                  ? dict.captionModeVisible
                  : captionDisplayMode === 'blurred'
                    ? dict.captionModeBlurred
                    : dict.captionModeHidden
              }
              title={
                captionDisplayMode === 'visible'
                  ? dict.captionModeVisible
                  : captionDisplayMode === 'blurred'
                    ? dict.captionModeBlurred
                    : dict.captionModeHidden
              }
            >
              {captionDisplayMode === 'visible' && <ClosedCaption size={18} />}
              {captionDisplayMode === 'blurred' && <Captions size={18} />}
              {captionDisplayMode === 'hidden' && <CaptionsOff size={18} />}
            </button>

            {/* Fullscreen — only for video */}
            {mediaType === 'video' && (
              <button
                type="button"
                className="entei-controls-btn"
                onClick={handleFullscreenToggle}
                aria-label={
                  isFullscreen ? dict.fullscreenExit : dict.fullscreenEnter
                }
                title={
                  isFullscreen ? dict.fullscreenExit : dict.fullscreenEnter
                }
              >
                {isFullscreen ? (
                  <Minimize2 size={18} />
                ) : (
                  <Maximize2 size={18} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* --- Fullscreen error feedback --- */}
      {fullscreenError && (
        <div className="entei-controls-feedback" role="alert">
          {fullscreenError}
        </div>
      )}
    </div>
  );
});
