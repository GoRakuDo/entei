import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  PREFERENCES_KEY,
  PREFERENCES_SCHEMA_VERSION,
} from '../src/i18n/index';
import {
  getSavedLocale,
  readPreference,
  validatePreference,
  writePreference,
} from '../src/i18n/preferences';

/**
 * Preference storage tests — PHASE0.md 8.210-225, 20.538-541.
 *
 * Verifies:
 * - Empty localStorage → falls back to `id`.
 * - Corrupted JSON → falls back to `id`.
 * - Unknown locale → falls back to `id`.
 * - Old schema version → falls back to `id`.
 * - Missing schemaVersion → falls back to `id`.
 * - Valid preference → returns the saved locale.
 * - writePreference round-trips through readPreference.
 * - If localStorage throws, functions return safe fallbacks.
 */

describe('validatePreference', () => {
  it('accepts a valid preference with schemaVersion 1 and locale id', () => {
    const result = validatePreference({
      schemaVersion: 1,
      locale: 'id',
    });
    expect(result).toEqual({ schemaVersion: 1, locale: 'id' });
  });

  it('accepts ja and en locales', () => {
    expect(validatePreference({ schemaVersion: 1, locale: 'ja' })?.locale).toBe(
      'ja',
    );
    expect(validatePreference({ schemaVersion: 1, locale: 'en' })?.locale).toBe(
      'en',
    );
  });

  it('rejects unknown locale', () => {
    expect(
      validatePreference({ schemaVersion: 1, locale: 'ko' as unknown }),
    ).toBeNull();
    expect(
      validatePreference({ schemaVersion: 1, locale: 'ID' as unknown }),
    ).toBeNull();
  });

  it('rejects wrong schemaVersion', () => {
    expect(validatePreference({ schemaVersion: 0, locale: 'id' })).toBeNull();
    expect(validatePreference({ schemaVersion: 2, locale: 'id' })).toBeNull();
    expect(validatePreference({ schemaVersion: '1', locale: 'id' })).toBeNull();
  });

  it('rejects non-object values', () => {
    expect(validatePreference(null)).toBeNull();
    expect(validatePreference(undefined)).toBeNull();
    expect(validatePreference('id')).toBeNull();
    expect(validatePreference(1)).toBeNull();
    expect(validatePreference([])).toBeNull();
  });

  it('rejects objects missing required fields', () => {
    expect(validatePreference({})).toBeNull();
    expect(validatePreference({ locale: 'id' })).toBeNull();
    expect(validatePreference({ schemaVersion: 1 })).toBeNull();
  });
});

describe('readPreference with localStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns null when localStorage is empty (first visit)', () => {
    expect(readPreference()).toBeNull();
  });

  it('returns null for corrupted JSON', () => {
    localStorage.setItem(PREFERENCES_KEY, '{not valid json');
    expect(readPreference()).toBeNull();
  });

  it('returns null for unknown locale', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 1, locale: 'fr' }),
    );
    expect(readPreference()).toBeNull();
  });

  it('returns null for old schema version', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 0, locale: 'ja' }),
    );
    expect(readPreference()).toBeNull();
  });

  it('returns the preference for valid ja locale', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 1, locale: 'ja' }),
    );
    const result = readPreference();
    expect(result).toEqual({ schemaVersion: 1, locale: 'ja' });
  });

  it('returns the preference for valid en locale', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 1, locale: 'en' }),
    );
    const result = readPreference();
    expect(result).toEqual({ schemaVersion: 1, locale: 'en' });
  });

  it('returns the preference for valid id locale', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 1, locale: 'id' }),
    );
    const result = readPreference();
    expect(result).toEqual({ schemaVersion: 1, locale: 'id' });
  });
});

describe('getSavedLocale', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns DEFAULT_LOCALE (id) when no preference exists', () => {
    expect(getSavedLocale()).toBe(DEFAULT_LOCALE);
    expect(getSavedLocale()).toBe('id');
  });

  it('returns DEFAULT_LOCALE for corrupted JSON', () => {
    localStorage.setItem(PREFERENCES_KEY, 'null');
    expect(getSavedLocale()).toBe('id');
  });

  it('returns saved ja locale when preference is valid', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 1, locale: 'ja' }),
    );
    expect(getSavedLocale()).toBe('ja');
  });

  it('returns saved en locale when preference is valid', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 1, locale: 'en' }),
    );
    expect(getSavedLocale()).toBe('en');
  });

  it('falls back to id when locale is unknown', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 1, locale: 'de' }),
    );
    expect(getSavedLocale()).toBe('id');
  });

  it('falls back to id when schemaVersion is wrong', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 99, locale: 'ja' }),
    );
    expect(getSavedLocale()).toBe('id');
  });
});

describe('writePreference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('persists a valid locale and returns true', () => {
    const result = writePreference('ja');
    expect(result).toBe(true);

    const raw = localStorage.getItem(PREFERENCES_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      schemaVersion: number;
      locale: string;
    };
    expect(parsed.schemaVersion).toBe(PREFERENCES_SCHEMA_VERSION);
    expect(parsed.locale).toBe('ja');
  });

  it('round-trips through readPreference', () => {
    writePreference('en');
    const result = readPreference();
    expect(result).toEqual({ schemaVersion: 1, locale: 'en' });
  });

  it('overwrites a previous preference', () => {
    writePreference('ja');
    writePreference('en');
    expect(getSavedLocale()).toBe('en');
  });

  it('writes schemaVersion 1 (PHASE0.md 8.214)', () => {
    writePreference('id');
    const raw = localStorage.getItem(PREFERENCES_KEY);
    const parsed = JSON.parse(raw!) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(1);
  });
});

describe('Storage-unavailable fallback (PHASE0.md 8.224)', () => {
  // Simulate localStorage being unavailable (e.g., privacy mode, cookies blocked)
  let originalLocalStorage: Storage;

  beforeEach(() => {
    originalLocalStorage = window.localStorage;
    // Replace localStorage with a proxy that throws on access.
    // jsdom allows redefining window.localStorage.
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new DOMException('localStorage unavailable');
        },
        setItem: () => {
          throw new DOMException('localStorage unavailable');
        },
        removeItem: () => {
          throw new DOMException('localStorage unavailable');
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it('readPreference returns null when localStorage throws', () => {
    expect(readPreference()).toBeNull();
  });

  it('getSavedLocale falls back to DEFAULT_LOCALE when storage is unavailable', () => {
    expect(getSavedLocale()).toBe('id');
  });

  it('writePreference returns false but does not throw', () => {
    expect(() => writePreference('ja')).not.toThrow();
    expect(writePreference('ja')).toBe(false);
  });
});
