/**
 * eizouden-toast — Sonner toast foundation for EizouDen notifications.
 * ---------------------------------------------------------------------------
 * EIZOU_DENDENSHI.md "画質通知 (2026-08-07)": when yt-dlp finishes and the
 * media is handed to the Player, show an info toast with the selected quality
 * and mode (e.g. "スピードモード - 360p をすぐに再生します"). Quality metadata
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
import { CircleAlert, CircleCheck, Info } from 'lucide-react';

export const QUALITY_TOAST_KEY = 'eizouden-quality';

/**
 * Substitute {quality} / {mode} into a localized template.
 * e.g. "{mode} Mode - {quality} will start playing"
 *      → "Speed Mode - 360p will start playing".
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
 * The icon is a Lucide Info (no default Sonner blue circle);
 * centered with the text via the Entei toast CSS ([data-icon] flex + gap,
 * same treatment as notifyCompanionError).
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
    icon: <Info aria-hidden="true" />,
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

/** Generic subtitle-sync error toast (no base subtitle, sync failure…). */
export function notifySubtitleSyncError(label: string): void {
  toast.error(label, {
    id: 'eizouden-subtitle-sync-error',
    icon: <CircleAlert aria-hidden="true" />,
  });
}

/** LazySync toggle notice ("LazySync enabled"/"disabled"). Neutral info
 *  toast with a fixed id so toggling cannot stack duplicates. */
export function notifyLazySyncInfo(label: string): void {
  toast.info(label, {
    id: 'eizouden-lazy-sync',
    icon: <Info aria-hidden="true" />,
  });
}

/**
 * Subtitle-sync success toast (sub-to-sub / sub-to-audio completed and the
 * synced cues were applied). One toast per completion: the id is fixed so a
 * repeated success cannot stack multiple toasts on top of each other.
 *
 * The icon is a Lucide CircleCheck (no default Sonner circle) centered with
 * the text via the Entei toast CSS (flex + gap).
 *
 * @param label - localized message (playerUI.subtitleSyncSuccess).
 */
export function notifySubtitleSyncSuccess(label: string): void {
  toast.success(label, {
    id: 'eizouden-subtitle-sync-success',
    icon: <CircleCheck aria-hidden="true" />,
  });
}

export const HEVC_UNSUPPORTED_TOAST_KEY = 'eizouden-hevc-unsupported';

/**
 * Emit the HEVC-unsupported warning toast.
 *
 * Shown when the user selects an HEVC H.265 video file but the browser
 * does not support HEVC playback (standard Chrome/Firefox/Edge).
 * Thorium and Safari are the only browsers that support HEVC.
 *
 * @param label - localized message (playerUI.hevcUnsupported).
 */
export function notifyHEVCUnsupported(label: string): void {
  toast.warning(label, {
    id: HEVC_UNSUPPORTED_TOAST_KEY,
    icon: <CircleAlert aria-hidden="true" />,
  });
}