/**
 * Browser detection helpers.
 * ---------------------------------------------------------------------------
 * isFirefox — detects Firefox via user-agent. Firefox does not yet support
 * video playback in Entei's player context, so media-selection buttons
 * (local / YouTube / Magnet) are blocked with a localized toast directing
 * the user to Chrome or a Chromium-based browser.
 * --------------------------------------------------------------------------- */

/**
 * Detect Firefox browser via user-agent string.
 * Firefox does not yet support video playback in Entei's player context,
 * so media-selection buttons (local / YouTube / Magnet) are blocked with
 * a localized toast directing the user to Chrome or a Chromium-based browser.
 */
export function isFirefox(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');
}