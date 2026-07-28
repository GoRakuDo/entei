/**
 * control-helpers — Pure helpers for the custom PlayerControls layer.
 * ---------------------------------------------------------------------------
 * P1.1: Format time, clamp seek, mute toggle, visibility state machine,
 * fullscreen utilities, rate list, and control target detection.
 *
 * Fix #11: nextControlsVisibility no longer accepts a reducedMotion argument.
 * Fix #12: Canonical source for PLAYBACK_RATES and formatTime.
 * Fix #3:  requestFullscreenCompat handles standard + webkit fallback.
 * Fix #8:  isControlTarget includes Radix Popover portal content.
 * --------------------------------------------------------------------------- */

/** P1.1: Playback rate values. Exposed here and re-used by controls + shortcuts. */
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * Format seconds into MM:SS or HH:MM:SS.
 * Returns '--:--' for NaN, Infinity, or negative values.
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';

  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');

  if (h > 0) {
    return `${h}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Clamp a seek time to valid range [0, duration].
 * Handles NaN, Infinity, negative, and exceeds-duration.
 */
export function clampSeek(time: number, duration: number): number {
  if (!Number.isFinite(time) || time < 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return time;
  return Math.min(time, duration);
}

/**
 * Toggle mute. If currently muted (volume === 0), restore to prevVolume.
 * If currently unmuted, set volume to 0 and remember the old value.
 * Returns { volume, restored } where restored > 0 means unmute happened.
 */
export function toggleMute(
  currentVolume: number,
  prevVolume: number,
): { volume: number; restored: number } {
  if (currentVolume > 0) {
    return { volume: 0, restored: 0 };
  }
  // Unmuting — restore to prevVolume (minimum 0.01 to avoid edge case)
  return { volume: Math.max(prevVolume, 0.01), restored: prevVolume };
}

// --- Visibility state machine ---

export type VisibilityEvent =
  | { type: 'pointer-move' }
  | { type: 'pointer-leave' }
  | { type: 'media-played' }
  | { type: 'media-paused' }
  | { type: 'media-ended' }
  | { type: 'media-error' }
  | { type: 'seek-start' }
  | { type: 'seek-end' }
  | { type: 'keyboard-focus' }
  | { type: 'timer-expired' };

/**
 * Pure next-state function for controls visibility.
 * Fix #11: removed the unused _reducedMotion parameter.
 * Returns { visible: boolean } based on the current state + event.
 */
export function nextControlsVisibility(
  event: VisibilityEvent,
  isPlaying: boolean,
  currentVisible: boolean,
): { visible: boolean } {
  // Always visible when paused, error, or ended
  if (!isPlaying) return { visible: true };

  switch (event.type) {
    case 'media-paused':
    case 'media-ended':
    case 'media-error':
      return { visible: true };

    case 'pointer-move':
    case 'seek-start':
    case 'seek-end':
    case 'keyboard-focus':
      return { visible: true };

    case 'timer-expired':
      return { visible: false };

    case 'pointer-leave':
      // Don't hide immediately — let timer handle it
      return { visible: currentVisible };

    default:
      return { visible: currentVisible };
  }
}

// --- Fullscreen utilities ---

/**
 * Check if fullscreen API is available on the given element.
 * Fix #3: checks on the actual target element, not just document.documentElement.
 */
export function isFullscreenAvailable(el?: Element | null): boolean {
  if (typeof document === 'undefined') return false;
  const target = el ?? document.documentElement;
  return (
    typeof target.requestFullscreen === 'function' ||
    typeof (target as unknown as { webkitRequestFullscreen?: unknown })
      .webkitRequestFullscreen === 'function'
  );
}

/**
 * Check if the document is currently in fullscreen mode.
 * Checks standard + webkit prefix.
 */
export function isDocumentFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  return (
    document.fullscreenElement != null ||
    (document as unknown as { webkitFullscreenElement?: Element | null })
      .webkitFullscreenElement != null
  );
}

// --- Fullscreen request with webkit fallback ---

/**
 * Request fullscreen on the given element, with standard → webkit fallback.
 * Returns a Promise that resolves on success or rejects with a string error.
 * Fix #3: actual request matches availability checks.
 */
export async function requestFullscreenCompat(el: Element): Promise<void> {
  if (typeof el.requestFullscreen === 'function') {
    await el.requestFullscreen();
    return;
  }
  const webkitEl = el as unknown as {
    webkitRequestFullscreen?: () => Promise<void>;
  };
  if (typeof webkitEl.webkitRequestFullscreen === 'function') {
    await webkitEl.webkitRequestFullscreen();
    return;
  }
  throw new Error('Fullscreen API not available on this element');
}

// --- Exit fullscreen with webkit fallback ---

export async function exitFullscreenCompat(): Promise<void> {
  if (typeof document.exitFullscreen === 'function') {
    await document.exitFullscreen();
    return;
  }
  const doc = document as unknown as {
    webkitExitFullscreen?: () => Promise<void>;
  };
  if (typeof doc.webkitExitFullscreen === 'function') {
    await doc.webkitExitFullscreen();
    return;
  }
}

// --- Control target detection ---

/**
 * Whether the auto-hide timer should be scheduled.
 * Auto-hide fires on all pointer devices unless reduced motion is active.
 * Touch and desktop behave the same for auto-hide timing.
 */
export function shouldScheduleAutoHide(
  _isTouchDevice: boolean,
  reducedMotion: boolean,
): boolean {
  return !reducedMotion;
}

/**
 * Determine the effect of a bare media surface click.
 * Touch: toggle control visibility (show if hidden, hide if shown).
 *        Never toggle play/pause — playback goes through custom buttons only.
 * Desktop: reveal controls AND toggle play/pause.
 */
export function surfaceClickEffect(
  isTouchDevice: boolean,
  isVisible: boolean,
): {
  togglePlay: boolean;
  setVisibility: 'show' | 'hide' | null;
} {
  if (isTouchDevice) {
    return isVisible
      ? { togglePlay: false, setVisibility: 'hide' }
      : { togglePlay: false, setVisibility: 'show' };
  }
  return { togglePlay: true, setVisibility: 'show' };
}

/**
 * Check if an event target is a control element (button, slider, switch, etc.)
 * that should NOT trigger the global Space/Enter shortcut for play/pause.
 *
 * Fix #8: also checks for ancestors inside Radix Popover portal content
 * (data-radix-popover-content) so pressing Space on a rate option doesn't
 * trigger global play/pause.
 */
export function isControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  // Fix #8: If target is inside a Radix Popover portal, treat as control
  if (target.closest('[data-radix-popover-content]') !== null) return true;

  const tag = target.tagName.toLowerCase();
  const role = target.getAttribute('role');

  return (
    tag === 'button' ||
    tag === 'select' ||
    role === 'button' ||
    role === 'slider' ||
    role === 'switch' ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'menuitem' ||
    role === 'menuitemcheckbox' ||
    role === 'menuitemradio' ||
    role === 'tab' ||
    role === 'toolbar' ||
    role === 'combobox' ||
    role === 'option' ||
    target.closest('[role="slider"]') !== null ||
    target.closest('button') !== null
  );
}

// --- P2.1: Play Mode --------------------------------------------------------

/** Playback mode — mutually exclusive. */
export type PlayMode = 'normal' | 'condensed' | 'fast-forward';

/** P2.1: Constants for play mode behavior. */
export const CONDENSED_SKIP_THRESHOLD_MS = 1000;
export const FAST_FORWARD_GAP_THRESHOLD_MS = 600;
export const FAST_FORWARD_RATE = 3;

function roundedMilliseconds(seconds: number): number {
  return Math.round(seconds * 1000);
}

/**
 * P2.1: Find the next cue after the given time.
 * Returns undefined if no cue starts after `time`.
 */
export function findNextCue(
  cues: { start: number; end: number; id: number }[],
  time: number,
): { start: number; end: number; id: number } | undefined {
  return cues.find((c) => c.start > time);
}

/**
 * P2.1: Determine whether Condensed mode should seek to the next cue.
 * Conditions: playing, cues loaded, no active cue, next cue exists,
 * gap > 1000ms, not paused, not mining/capturing, not seeking.
 */
export function shouldCondensedSeek(
  mode: PlayMode,
  isPlaying: boolean,
  isPaused: boolean,
  isMiningOrCapturing: boolean,
  isSeeking: boolean,
  isCondensedSeekInFlight: boolean,
  cues: { start: number; end: number; id: number }[],
  currentTime: number,
): boolean {
  if (mode !== 'condensed') return false;
  if (!isPlaying || isPaused) return false;
  if (isMiningOrCapturing) return false;
  if (isSeeking || isCondensedSeekInFlight) return false;
  if (cues.length === 0) return false;

  const active = cues.find(
    (c) => c.start <= currentTime && c.end > currentTime,
  );
  if (active) return false;

  const next = findNextCue(cues, currentTime);
  if (!next) return false;

  const gapMs = roundedMilliseconds(next.start - currentTime);
  return gapMs > CONDENSED_SKIP_THRESHOLD_MS;
}

/**
 * P2.1: Determine whether Fast-forward mode should apply 3x rate.
 * Conditions: mode is fast-forward, no cue is active,
 * both nearest previous cue end AND next cue start are > 600ms away.
 * During/within 600ms of subtitles → 1x.
 */
export function shouldFastForward(
  mode: PlayMode,
  cues: { start: number; end: number; id: number }[],
  currentTime: number,
): boolean {
  if (mode !== 'fast-forward') return false;
  if (cues.length === 0) return false;

  const active = cues.find(
    (c) => c.start <= currentTime && c.end > currentTime,
  );
  if (active) return false;

  // Find nearest previous cue end
  let prevCueEnd: number | undefined;
  for (let i = cues.length - 1; i >= 0; i--) {
    if (cues[i]!.end <= currentTime) {
      prevCueEnd = cues[i]!.end;
      break;
    }
  }

  // Find nearest next cue start
  const nextCue = findNextCue(cues, currentTime);
  const nextCueStart = nextCue?.start;

  const previousOffsetMs =
    prevCueEnd !== undefined
      ? roundedMilliseconds(currentTime - prevCueEnd)
      : Infinity;
  const nextOffsetMs =
    nextCueStart !== undefined
      ? roundedMilliseconds(nextCueStart - currentTime)
      : Infinity;

  return (
    previousOffsetMs > FAST_FORWARD_GAP_THRESHOLD_MS &&
    nextOffsetMs > FAST_FORWARD_GAP_THRESHOLD_MS
  );
}

// --- P1.3a.2: Caption Display Mode ------------------------------------------

/** Overlay display mode — cycled by the caption mode button. */
export type CaptionDisplayMode = 'visible' | 'blurred' | 'hidden';

/**
 * Transition to the next caption display mode.
 * Cycle: visible → blurred → hidden → visible.
 */
export function nextCaptionDisplayMode(
  mode: CaptionDisplayMode,
): CaptionDisplayMode {
  switch (mode) {
    case 'visible':
      return 'blurred';
    case 'blurred':
      return 'hidden';
    case 'hidden':
      return 'visible';
  }
}

/** Duration (ms) before a blurred overlay restores after pointer leaves. */
export const BLUR_RESTORE_TIMEOUT_MS = 1000;

/**
 * P1.3a.2: Determine whether a pointer event should trigger desktop hover
 * callbacks for the blurred overlay (cancel restore / schedule restore).
 *
 * Only `mouse` pointerType triggers these callbacks. Touch and pen events
 * must not schedule or cancel the 1-second restore timer — on touch the
 * overlay stays revealed until playback resumes.
 */
export function shouldTriggerBlurHover(pointerType: string): boolean {
  return pointerType === 'mouse';
}

/**
 * P1.3a.2: Detect an actual playback resume (isPlaying false→true transition).
 * Used to re-blur the overlay only on user-initiated resume, not on renders
 * where isPlaying is already true but the state hasn't caught up yet.
 */
export function isPlaybackResume(
  wasPlaying: boolean,
  isPlayingNow: boolean,
): boolean {
  return !wasPlaying && isPlayingNow;
}
