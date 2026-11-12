/**
 * yomitan-preferences unit tests — host persistence for the Yomitan options.
 *
 * Covers:
 * - dot-path read/write against the ACTIVE PROFILE (and root-level keys)
 * - every edit persists (localStorage write, the DB mirror is fire-and-forget)
 * - a corrupted / partial payload falls back to defaults without throwing
 * - an unaddressable path is a no-op that returns the SAME reference
 * - integer fields round (no fractional values reach the store)
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  YOMITAN_OPTIONS_KEY,
  YOMITAN_OPTIONS_SCHEMA_VERSION,
  activeProfileOptions,
  getPathValue,
  readOptionPath,
  readYomitanOptions,
  setPathValue,
  writeOptionPath,
  writeYomitanOptions,
} from '@/features/yomitan/yomitan-preferences';
import { createDefaultOptions } from '@gorakudo/yomitan-headless/settings';

describe('yomitan-preferences — defaults', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns a complete default options tree when nothing is stored', () => {
    const options = readYomitanOptions();
    expect(options.profiles.length).toBeGreaterThan(0);
    expect(typeof options.profileCurrent).toBe('number');
    expect(typeof options.global.dataTransmissionConsentShown).toBe('boolean');
  });

  it('falls back to defaults on corrupted JSON', () => {
    localStorage.setItem(YOMITAN_OPTIONS_KEY, '{not json');
    expect(() => readYomitanOptions()).not.toThrow();
    expect(readYomitanOptions().profiles.length).toBeGreaterThan(0);
  });

  it('tolerates a bare options object (no version/seed wrapper)', () => {
    localStorage.setItem(
      YOMITAN_OPTIONS_KEY,
      JSON.stringify({ profiles: [], profileCurrent: 0 }),
    );
    expect(readYomitanOptions().profiles.length).toBeGreaterThan(0);
  });
});

describe('yomitan-preferences — path helpers', () => {
  it('reads and writes a nested path immutably', () => {
    const source = { a: { b: { c: 1 } } };
    const next = setPathValue(source, 'a.b.c', 2);
    expect(getPathValue(next, 'a.b.c')).toBe(2);
    // Input is untouched.
    expect(getPathValue(source, 'a.b.c')).toBe(1);
  });

  it('creates the missing intermediate objects', () => {
    const next = setPathValue({}, 'x.y.z', 'value');
    expect(getPathValue(next, 'x.y.z')).toBe('value');
  });

  it('returns undefined for an unreachable path', () => {
    expect(getPathValue({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(getPathValue(null, 'a')).toBeUndefined();
  });
});

describe('yomitan-preferences — dot-path resolution', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads a profile field by dot-path', () => {
    const options = createDefaultOptions();
    expect(typeof readOptionPath(options, 'general.enable')).toBe('boolean');
    expect(typeof readOptionPath(options, 'anki.server')).toBe('string');
  });

  it('writes a profile field and persists it', () => {
    const options = createDefaultOptions();
    const next = writeOptionPath(options, 'general.enable', false);
    expect(readOptionPath(next, 'general.enable')).toBe(false);
    // Other fields keep their defaults.
    expect(readOptionPath(next, 'general.language')).toBe(
      readOptionPath(options, 'general.language'),
    );
    // Persisted.
    const raw = localStorage.getItem(YOMITAN_OPTIONS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      version: number;
      options: { profiles: { options: { general: { enable: boolean } } }[] };
    };
    expect(parsed.version).toBe(YOMITAN_OPTIONS_SCHEMA_VERSION);
    const profile = parsed.options.profiles[0];
    expect(profile?.options.general.enable).toBe(false);
  });

  it('writes an integer field as an integer', () => {
    const options = createDefaultOptions();
    const next = writeOptionPath(options, 'general.maxResults', 12);
    expect(readOptionPath(next, 'general.maxResults')).toBe(12);
  });

  it('addresses a root-level key (profileCurrent)', () => {
    const options = createDefaultOptions();
    const next = writeOptionPath(options, 'profileCurrent', 0);
    expect(readOptionPath(next, 'profileCurrent')).toBe(0);
  });

  it('addresses a global key (global.*)', () => {
    const options = createDefaultOptions();
    const next = writeOptionPath(
      options,
      'global.dataTransmissionConsentShown',
      true,
    );
    expect(readOptionPath(next, 'global.dataTransmissionConsentShown')).toBe(
      true,
    );
  });

  it('treats an unaddressable path as a no-op (same reference)', () => {
    const options = createDefaultOptions();
    expect(writeOptionPath(options, 'notASection.field', 1)).toBe(options);
    expect(writeOptionPath(options, 'general.notAField', 1)).toBe(options);
  });

  it('reports the active profile options', () => {
    const options = createDefaultOptions();
    const profile = activeProfileOptions(options);
    expect(profile).toBeDefined();
    expect(typeof profile.general.enable).toBe('boolean');
  });

  it('persists a whole options object through writeYomitanOptions', () => {
    const options = createDefaultOptions();
    writeYomitanOptions(options);
    const stored = readYomitanOptions();
    expect(readOptionPath(stored, 'general.enable')).toBe(
      readOptionPath(options, 'general.enable'),
    );
  });
});
