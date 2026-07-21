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
