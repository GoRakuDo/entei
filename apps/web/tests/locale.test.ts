import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  PREFERENCES_KEY,
  PREFERENCES_SCHEMA_VERSION,
  dictionaries,
  isLocale,
} from '../src/i18n/index';
import { id } from '../src/i18n/locales/id';
import { ja } from '../src/i18n/locales/ja';
import { en } from '../src/i18n/locales/en';
import type { Locale } from '../src/i18n/types';

describe('Locale type guard', () => {
  it('accepts exactly id, ja, en', () => {
    expect(isLocale('id')).toBe(true);
    expect(isLocale('ja')).toBe(true);
    expect(isLocale('en')).toBe(true);
  });

  it('rejects strings outside the allowed set', () => {
    expect(isLocale('ko')).toBe(false);
    expect(isLocale('ID')).toBe(false);
    expect(isLocale('ja-JP')).toBe(false);
    expect(isLocale('')).toBe(false);
    expect(isLocale('id ')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(1)).toBe(false);
    expect(isLocale({ locale: 'id' })).toBe(false);
    expect(isLocale(['id'])).toBe(false);
  });
});

describe('Locale constants', () => {
  it('DEFAULT_LOCALE is id (Bahasa Indonesia)', () => {
    expect(DEFAULT_LOCALE).toBe('id');
  });

  it('LOCALE_LABELS has exactly 3 entries', () => {
    const keys = Object.keys(LOCALE_LABELS) as Locale[];
    expect(keys).toHaveLength(3);
    expect(keys).toContain('id');
    expect(keys).toContain('ja');
    expect(keys).toContain('en');
  });

  it('LOCALE_LABELS shows each language in its own name (PHASE0.md 8.205)', () => {
    expect(LOCALE_LABELS.id).toBe('Bahasa Indonesia');
    expect(LOCALE_LABELS.ja).toBe('日本語');
    expect(LOCALE_LABELS.en).toBe('English');
  });

  it('PREFERENCES_KEY is versioned (PHASE0.md 8.219)', () => {
    expect(PREFERENCES_KEY).toBe('entei.preferences.v1');
  });

  it('PREFERENCES_SCHEMA_VERSION is 1 (PHASE0.md 8.214)', () => {
    expect(PREFERENCES_SCHEMA_VERSION).toBe(1);
  });
});

describe('Dictionary key parity (PHASE0.md 8.197)', () => {
  /**
   * All three locale dictionaries must expose the same key set.
   * The test flattens nested objects to dot-notation key paths and
   * compares the sets. This catches missing translations.
   */
  function flattenKeys(obj: unknown, prefix = ''): string[] {
    if (typeof obj !== 'object' || obj === null) {
      return prefix ? [prefix] : [];
    }
    const keys: string[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      keys.push(...flattenKeys(v, path));
    }
    return keys;
  }

  it('all three dictionaries have the same key set', () => {
    const idKeys = flattenKeys(id).sort();
    const jaKeys = flattenKeys(ja).sort();
    const enKeys = flattenKeys(en).sort();

    expect(jaKeys).toEqual(idKeys);
    expect(enKeys).toEqual(idKeys);
  });

  it('all dictionary values are non-empty strings', () => {
    function assertNonEmpty(obj: unknown, path = ''): void {
      if (typeof obj === 'string') {
        expect(obj.length, `empty value at ${path}`).toBeGreaterThan(0);
        return;
      }
      if (typeof obj === 'object' && obj !== null) {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          assertNonEmpty(v, path ? `${path}.${k}` : k);
        }
      }
    }
    assertNonEmpty(id, 'id');
    assertNonEmpty(ja, 'ja');
    assertNonEmpty(en, 'en');
  });

  it('dictionaries object has all three locales', () => {
    expect(dictionaries.id).toBeDefined();
    expect(dictionaries.ja).toBeDefined();
    expect(dictionaries.en).toBeDefined();
  });
});
