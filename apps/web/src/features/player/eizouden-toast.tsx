/**
 * Player toasts — localized source, subtitle-sync, mining, and browser
 * notifications. Toast copy never exposes native plugin error details.
 */

'use client';

import { toast } from 'sonner';
import { CircleAlert, CircleCheck } from 'lucide-react';

export const PLAYER_INPUT_ERROR_TOAST_KEY = 'entei-player-input-error';

/** Emit a localized native player input error without exposing IPC details. */
export function notifyPlayerInputError(
  label: string,
  id: string = PLAYER_INPUT_ERROR_TOAST_KEY,
): void {
  toast.error(label, {
    id,
    icon: <CircleAlert aria-hidden="true" />,
  });
}

/** Generic subtitle-sync error toast (no base subtitle, sync failure…). */
export function notifySubtitleSyncError(label: string): void {
  toast.error(label, {
    id: 'player-subtitle-sync-error',
    icon: <CircleAlert aria-hidden="true" />,
  });
}

/** Jimaku auto-load toast (rate-limit / auth / key-missing) — info level. */
export function notifyJimakuToast(label: string): void {
  toast.info(label, {
    id: 'player-jimaku-toast',
  });
}

/** Subtitle-sync success toast. One toast per completion. */
export function notifySubtitleSyncSuccess(label: string): void {
  toast.success(label, {
    id: 'player-subtitle-sync-success',
    icon: <CircleCheck aria-hidden="true" />,
  });
}

/** Mining export success toast (new card added or card updated). */
export function notifyMiningExportSuccess(label: string): void {
  toast.success(label, {
    id: 'player-mining-export-success',
    icon: <CircleCheck aria-hidden="true" />,
  });
}

/** Mining export error toast. */
export function notifyMiningExportError(label: string): void {
  toast.error(label, {
    id: 'player-mining-export-error',
    icon: <CircleAlert aria-hidden="true" />,
  });
}

export const FIREFOX_UNSUPPORTED_TOAST_KEY = 'firefox-unsupported';

/** Emit the Firefox-unsupported warning toast. */
export function notifyFirefoxUnsupported(label: string): void {
  toast.warning(label, {
    id: FIREFOX_UNSUPPORTED_TOAST_KEY,
    icon: <CircleAlert aria-hidden="true" />,
  });
}
