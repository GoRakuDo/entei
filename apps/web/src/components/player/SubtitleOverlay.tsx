/**
 * SubtitleOverlay — Renders the active subtitle as selectable DOM text over video.
 * ---------------------------------------------------------------------------
 * P1.3a.1: Yomitan-compatible selectable overlay.
 * P1.3a.2: Caption display modes (visible / blurred / hidden).
 * P2.1: Configurable appearance (font size, colors, padding, position).
 *
 * Design:
 * - Renders inside .entei-player-surface, above video, below custom controls.
 * - Uses normal DOM text with user-select: text, pointer-events: auto.
 * - Explicit data-entei-subtitle-overlay attribute for Yomitan scan targeting.
 * - Does NOT stop propagation — PlayerApp surface handler ignores overlay targets.
 * - No aria-live (frequently changing text would be noisy for screen readers).
 * - No hardcoded lang; subtitle language is unknown.
 * - Renders nothing when no active cue OR mode is 'hidden'.
 * - 'blurred': CSS filter blur applied; pointer/touch reveal managed by PlayerApp.
 * - All colors are canonical oklch(...) strings.
 * --------------------------------------------------------------------------- */
'use client';

import { useMemo } from 'react';
import type { SubtitleCue } from '@/features/player/subtitle-reader';
import type { CaptionDisplayMode } from '@/features/player/control-helpers';
import { shouldTriggerBlurHover } from '@/features/player/control-helpers';

interface SubtitleAppearanceSettings {
  fontSize: number; // px
  textColor: string; // oklch(...) string
  backgroundColor: string; // oklch(...) string with alpha
  backgroundPadding: number; // px (uniform)
  verticalPosition: number; // px (bottom offset)
}

interface SubtitleOverlayProps {
  /** All parsed subtitle cues. */
  cues: readonly SubtitleCue[];
  /** ID of the currently active cue, or null. */
  activeCueId: number | null;
  /** P1.3a.2: Current caption display mode. */
  displayMode: CaptionDisplayMode;
  /**
   * P1.3a.2: Whether the blurred overlay is currently revealed (text visible).
   * Only meaningful when displayMode === 'blurred'.
   * Desktop: true while pointer is over overlay. Mobile: true while tapped.
   */
  isRevealed: boolean;
  /** Pointer enter on overlay — desktop mouse only (cancels restore timer). */
  onPointerEnter?: (e: React.PointerEvent) => void;
  /** Pointer leave on overlay — desktop mouse only (starts restore timer). */
  onPointerLeave?: (e: React.PointerEvent) => void;
  /** Touch tap on overlay (mobile — pauses media and reveals text). */
  onTouchTap?: () => void;
  /** P2.1: Configurable appearance settings. */
  appearance: SubtitleAppearanceSettings;
}

/**
 * Find the cue text for the active cue ID.
 */
function getCueText(
  cues: readonly SubtitleCue[],
  activeId: number | null,
): string {
  if (activeId === null) return '';
  const cue = cues.find((c) => c.id === activeId);
  return cue?.text ?? '';
}

export function SubtitleOverlay({
  cues,
  activeCueId,
  displayMode,
  isRevealed,
  onPointerEnter,
  onPointerLeave,
  onTouchTap,
  appearance,
}: SubtitleOverlayProps) {
  const text = useMemo(
    () => getCueText(cues, activeCueId),
    [cues, activeCueId],
  );

  // hidden mode: render nothing
  if (!text || displayMode === 'hidden') return null;

  // Build class list
  const className = [
    'entei-subtitle-overlay',
    displayMode === 'blurred' && !isRevealed
      ? 'entei-subtitle-overlay--blurred'
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Inline styles for configurable appearance (all oklch values)
  const overlayStyle: React.CSSProperties = {
    bottom: `${appearance.verticalPosition}px`,
    padding: `${appearance.backgroundPadding}px ${appearance.backgroundPadding * 2}px`,
    backgroundColor: appearance.backgroundColor,
  };

  const textStyle: React.CSSProperties = {
    fontSize: `${appearance.fontSize}px`,
    color: appearance.textColor,
  };

  return (
    <div
      className={className}
      data-entei-subtitle-overlay=""
      data-overlay-revealed={
        displayMode === 'blurred' && isRevealed ? '' : undefined
      }
      style={overlayStyle}
      onPointerEnter={(e) => {
        // Only mouse hover triggers the cancel-restore callback.
        // Touch/pen must not schedule or cancel the 1-second restore timer.
        if (shouldTriggerBlurHover(e.pointerType)) onPointerEnter?.(e);
      }}
      onPointerLeave={(e) => {
        // Only mouse hover-leave triggers the 1-second restore timer.
        // Touch/pen must not schedule the restore timer.
        if (shouldTriggerBlurHover(e.pointerType)) onPointerLeave?.(e);
      }}
      onTouchStart={onTouchTap}
    >
      <p className="entei-subtitle-overlay-text" style={textStyle}>
        {text}
      </p>
    </div>
  );
}
