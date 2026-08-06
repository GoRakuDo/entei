/**
 * seek-limiter — Clamp seek requests to the companion's verified byte range.
 * ---------------------------------------------------------------------------
 * When streaming from a torrent companion, the browser's video element only
 * has `duration` (seconds) and the companion reports `available` / `total`
 * (bytes). A seek beyond the verified prefix stalls the player (seeking=true,
 * readyState=1, GPU 100%) because the server's ServeContent Read blocks
 * waiting for pieces that haven't arrived yet.
 *
 * This module converts a seek target (seconds) to an equivalent byte
 * position using the linear ratio `available / total`, and clamps it if the
 * target exceeds the verified range. The clamped time is expressed back as
 * seconds so the caller can assign it to `media.currentTime`.
 *
 * The clamping is conservative: it never allows a seek beyond `available`,
 * even for the head bootstrap window. The tail-window elevation (B) means
 * Cues arrive early, but the verified prefix still grows from byte 0, so
 * clamping to `available` is the correct safe bound.
 *
 * Privacy: pure functions, no state, no side effects.
 * ---------------------------------------------------------------------------
 */

/**
 * Clamp a seek target (seconds) to the companion's verified byte range.
 *
 * @param seekSeconds - The desired seek position in seconds.
 * @param available   - Verified contiguous prefix in bytes (from companion status).
 * @param total       - Total file size in bytes (from companion status).
 * @param duration    - Media duration in seconds (from the video element).
 * @returns The clamped seek position in seconds. Returns `seekSeconds`
 *          unchanged when inputs are degenerate (total <= 0, duration <= 0,
 *          or available >= total).
 */
export function clampCompanionSeek(
  seekSeconds: number,
  available: number,
  total: number,
  duration: number,
): number {
  if (
    !Number.isFinite(seekSeconds) ||
    seekSeconds < 0 ||
    total <= 0 ||
    duration <= 0 ||
    available >= total
  ) {
    return seekSeconds;
  }
  // Convert seconds → bytes via linear ratio, then clamp, then back to seconds.
  // NOTE: linear seconds→bytes is inaccurate for VBR but intentionally conservative
  // (never allows a seek beyond `available`); revisit if VBR-aware mapping is needed.
  const targetByte = (seekSeconds / duration) * total;
  if (targetByte <= available) return seekSeconds;
  return (available / total) * duration;
}
