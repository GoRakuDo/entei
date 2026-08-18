/**
 * HEVC H.265 Detection
 * ---------------------------------------------------------------------------
 * Detects HEVC H.265 video from filename and checks browser playback support.
 * Only Thorium (Chromium fork) and Safari support HEVC in browsers.
 * Standard Chrome, Firefox, and Edge do not support HEVC playback.
 *
 * Used by PlayerApp (local file) and MagnetInput (torrent file selection)
 * to block unsupported HEVC files with a user-facing toast message.
 * --------------------------------------------------------------------------- */

/**
 * Detect HEVC H.265 from filename.
 * Matches common encoding tags: x265, HEVC, H.265, h265 (case-insensitive).
 */
export function isHEVC(filename: string): boolean {
  return /x265|hevc|h\.?265/i.test(filename);
}

/**
 * Check if the current browser supports HEVC playback.
 * Thorium (Chromium fork) and Safari support HEVC.
 * Standard Chrome/Firefox/Edge do not.
 *
 * Uses MediaSource.isTypeSupported for codec-level detection and
 * falls back to a Thorium user-agent heuristic.
 */
export function isHEVCSupported(): boolean {
  // Safari supports HEVC natively (not via MediaSource), so check UA first
  const ua = navigator.userAgent;
  const isSafari = ua.includes('Safari') && !ua.includes('Chrome');
  if (isSafari) return true;
  if (typeof MediaSource === 'undefined') return false;
  return (
    MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"') ||
    ua.includes('Thorium')
  );
}

/**
 * Detect Firefox browser via user-agent string.
 * Firefox does not yet support video playback in Entei's player context,
 * so media-selection buttons (local / YouTube / Magnet) are blocked with
 * a localized toast directing the user to Chrome or a Chromium-based browser.
 */
export function isFirefox(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');
}