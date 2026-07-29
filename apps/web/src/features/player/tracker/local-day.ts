/**
 * IMMERSION_TRACKER — Shared local-day helper.
 * ---------------------------------------------------------------------------
 * Pure one-liner. No IndexedDB, no React, no side effects.
 *
 * Returns the current local day as YYYY-MM-DD using 'en-CA' locale,
 * which produces ISO date format regardless of the system timezone.
 * This is the canonical key for media_daily and daily stores.
 * ---------------------------------------------------------------------------
 */

export function getLocalDay(): string {
  return new Date().toLocaleDateString('en-CA');
}
