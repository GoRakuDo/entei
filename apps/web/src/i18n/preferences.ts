import {
  DEFAULT_LOCALE,
  PREFERENCES_KEY,
  PREFERENCES_SCHEMA_VERSION,
  isLocale,
} from './index';
import type { Locale, LocalePreference } from './types';

/**
 * Entei Locale Preference Storage
 * -----------------------------------------------------------------------------
 * PHASE0.md 8.210-225:
 * - Key: `entei.preferences.v1`
 * - Read, parse, and save all wrap exceptions.
 * - `locale` outside `id | ja | en` is ignored and falls back to `id`.
 * - First visit (no preference) → Indonesian, no browser-language guessing.
 * - If localStorage is unavailable, in-page switching still works but does not
 *   persist.
 * ---------------------------------------------------------------------------*/

/**
 * Safely read the persisted locale preference.
 * Returns `null` if storage is unavailable, the key is absent, JSON is
 * corrupted, the schema version mismatches, or the locale is invalid.
 */
export function readPreference(): LocalePreference | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  let raw: string | null;
  try {
    raw = localStorage.getItem(PREFERENCES_KEY);
  } catch {
    // localStorage access throws in some privacy modes or when disabled.
    return null;
  }

  if (raw === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted JSON — ignore, fall back to default.
    return null;
  }

  return validatePreference(parsed);
}

/**
 * Validate an untrusted parsed value as a `LocalePreference`.
 * Checks: object shape, `schemaVersion` is a number and matches current,
 * `locale` is one of `id | ja | en`. Returns `null` if invalid.
 */
export function validatePreference(value: unknown): LocalePreference | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.schemaVersion !== 'number' ||
    candidate.schemaVersion !== PREFERENCES_SCHEMA_VERSION
  ) {
    return null;
  }

  if (!isLocale(candidate.locale)) {
    return null;
  }

  return {
    schemaVersion: candidate.schemaVersion,
    locale: candidate.locale,
  };
}

/**
 * Persist the locale preference. Silently no-ops if localStorage is
 * unavailable — in-page switching still works, persistence does not.
 */
export function writePreference(locale: Locale): boolean {
  if (typeof localStorage === 'undefined') {
    return false;
  }

  const preference: LocalePreference = {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    locale,
  };

  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preference));
    return true;
  } catch {
    // Quota exceeded, privacy mode, or storage disabled.
    return false;
  }
}

/**
 * Read the saved locale, falling back to `DEFAULT_LOCALE` (`id`) when the
 * preference is absent, corrupted, or has an invalid locale.
 * This is the single entry point for "what locale should I show on load?"
 */
export function getSavedLocale(): Locale {
  const preference = readPreference();
  if (preference === null) {
    return DEFAULT_LOCALE;
  }
  return preference.locale;
}
