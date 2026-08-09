/**
 * eizouden-toast — Sonner toast foundation for EizouDen notifications.
 * ---------------------------------------------------------------------------
 * EIZOU_DENDENSHI.md "画質通知 (2026-08-07)": when yt-dlp finishes and the
 * media is handed to the Player, show an info toast with the selected quality
 * and mode (e.g. "360p（Speed モード）で再生します"). Quality metadata
 * arrives from the companion in a later integration; this module provides the
 * UI function and the Toaster host so wiring it up requires no further UI
 * work.
 *
 * The message template is a localized string (`playerUI.ytModeToastFormat`)
 * that the caller resolves from the active dictionary; the quality and mode
 * are substituted into the `{quality}` and `{mode}` placeholders.
 * ---------------------------------------------------------------------------
 */

'use client';

import { toast } from 'sonner';
import { CircleAlert } from 'lucide-react';

export const QUALITY_TOAST_KEY = 'eizouden-quality';

/**
 * Substitute {quality} / {mode} into a localized template.
 * e.g. "Playing {quality} ({mode} mode)" → "Playing 360p (Speed mode)".
 */
export function formatQualityToast(
  template: string,
  quality: string,
  modeLabel: string,
): string {
  return template.replaceAll('{quality}', quality).replaceAll('{mode}', modeLabel);
}

/**
 * Emit the quality-notification info toast.
 *
 * @param template - localized format string (playerUI.ytModeToastFormat).
 * @param quality  - text like "360p", "720p" or "1080p".
 * @param modeLabel - localized download-mode label ("Quality"/"Speed"/…).
 */
export function notifyQuality(
  template: string,
  quality: string,
  modeLabel: string,
): void {
  toast.info(formatQualityToast(template, quality, modeLabel), {
    id: QUALITY_TOAST_KEY + quality + modeLabel,
  });
}

export const COMPANION_ERROR_TOAST_KEY = 'eizouden-companion-error';

/**
 * Emit the companion-job failure toast ("An error occurred. Please try
 * again."). One toast per job failure: the id is fixed so a repeated
 * error re-render cannot stack multiple toasts on top of each other.
 *
 * The icon is a Lucide CircleAlert (no default Sonner circle) centered
 * with the text via the Entei toast CSS (flex + gap).
 *
 * @param label - localized message (playerUI.companionJobError).
 */
export function notifyCompanionError(label: string): void {
  toast.error(label, {
    id: COMPANION_ERROR_TOAST_KEY,
    icon: <CircleAlert aria-hidden="true" />,
  });
}
