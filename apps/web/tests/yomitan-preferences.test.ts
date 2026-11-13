/**
 * yomitan-preferences unit tests — host persistence for the Yomitan options.
 *
 * Covers:
 * - dot-path read/write against the ACTIVE PROFILE (and root-level keys)
 * - every edit persists (localStorage write, the DB mirror is fire-and-forget)
 * - a corrupted / partial payload falls back to defaults without throwing
 * - an unaddressable path is a no-op that returns the SAME reference
 * - host-locked paths (master switch / lookup language / welcome guide /
 *   advanced+debug toggles) ignore any foreign stored value and refuse writes
 * - integer fields round (no fractional values reach the store)
 * - the module → trace pipeline is gated on `general.debugInfo`
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  YOMITAN_OPTIONS_KEY,
  YOMITAN_OPTIONS_SCHEMA_VERSION,
  activeProfileOptions,
  getPathValue,
  isLockedOptionPath,
  isYomitanDebugInfoEnabled,
  readOptionPath,
  readYomitanOptions,
  setPathValue,
  traceYomitan,
  writeOptionPath,
  writeYomitanOptions,
} from '@/features/yomitan/yomitan-preferences';
import {
  getTraceRecent,
  resetTraceState,
} from '@/features/trace/trace-logger';
import {
  createDefaultOptions,
  createDefaultProfileOptions,
} from '@gorakudo/yomitan-headless/settings';

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
    const next = writeOptionPath(
      options,
      'anki.server',
      'http://127.0.0.1:8766',
    );
    expect(readOptionPath(next, 'anki.server')).toBe('http://127.0.0.1:8766');
    // Other fields keep their defaults.
    expect(readOptionPath(next, 'general.maxResults')).toBe(
      readOptionPath(options, 'general.maxResults'),
    );
    // Persisted.
    const raw = localStorage.getItem(YOMITAN_OPTIONS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      version: number;
      options: { profiles: { options: { anki: { server: string } } }[] };
    };
    expect(parsed.version).toBe(YOMITAN_OPTIONS_SCHEMA_VERSION);
    const profile = parsed.options.profiles[0];
    expect(profile?.options.anki.server).toBe('http://127.0.0.1:8766');
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

describe('yomitan-preferences — host-locked options', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('pins enable=true, language=ja, showGuide=false on a default read', () => {
    const general = activeProfileOptions(readYomitanOptions()).general;
    expect(general.enable).toBe(true);
    expect(general.language).toBe('ja');
    expect(general.showGuide).toBe(false);
  });

  it('pins showAdvanced / showDebug on and keeps them out of the UI', () => {
    const general = activeProfileOptions(readYomitanOptions()).general;
    expect(general.showAdvanced).toBe(true);
    expect(general.showDebug).toBe(true);
    // Locked = the renderer skips the toggle, so there is no way back to off.
    expect(isLockedOptionPath('general.showAdvanced')).toBe(true);
    expect(isLockedOptionPath('general.showDebug')).toBe(true);
    // "Show debug information" stays a user decision (it gates module tracing).
    expect(isLockedOptionPath('general.debugInfo')).toBe(false);
  });

  it('overrides a stored payload that carries foreign locked values', () => {
    const defaults = createDefaultProfileOptions();
    const stored = {
      version: 1,
      options: {
        ...createDefaultOptions(),
        profiles: [
          {
            name: 'Default',
            conditionGroups: [],
            options: {
              ...defaults,
              general: {
                ...defaults.general,
                enable: false,
                language: 'en',
                showGuide: true,
                showAdvanced: false,
                showDebug: false,
              },
            },
          },
        ],
      },
    };
    localStorage.setItem(YOMITAN_OPTIONS_KEY, JSON.stringify(stored));

    const general = activeProfileOptions(readYomitanOptions()).general;
    expect(general.enable).toBe(true);
    expect(general.language).toBe('ja');
    expect(general.showGuide).toBe(false);
    expect(general.showAdvanced).toBe(true);
    expect(general.showDebug).toBe(true);
  });

  it('refuses a write to a locked path (same reference, nothing stored)', () => {
    const options = createDefaultOptions();
    expect(writeOptionPath(options, 'general.enable', false)).toBe(options);
    expect(writeOptionPath(options, 'general.language', 'en')).toBe(options);
    expect(writeOptionPath(options, 'general.showGuide', true)).toBe(options);
    expect(writeOptionPath(options, 'general.showAdvanced', false)).toBe(options);
    expect(writeOptionPath(options, 'general.showDebug', false)).toBe(options);
    expect(localStorage.getItem(YOMITAN_OPTIONS_KEY)).toBeNull();
  });
});

describe('yomitan-preferences — module trace pipeline', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTraceState();
    readYomitanOptions(); // gate back to false for a clean case
  });

  afterEach(() => {
    localStorage.clear();
    resetTraceState();
    readYomitanOptions();
  });

  /** Persist an options tree whose `general.debugInfo` is `value`. */
  function storeDebugInfo(value: boolean): void {
    const defaults = createDefaultProfileOptions();
    localStorage.setItem(
      YOMITAN_OPTIONS_KEY,
      JSON.stringify({
        version: YOMITAN_OPTIONS_SCHEMA_VERSION,
        options: {
          ...createDefaultOptions(),
          profiles: [
            {
              name: 'Default',
              conditionGroups: [],
              options: {
                ...defaults,
                general: { ...defaults.general, debugInfo: value },
              },
            },
          ],
        },
      }),
    );
  }

  it('stays silent while general.debugInfo is off', () => {
    storeDebugInfo(false);
    expect(isYomitanDebugInfoEnabled()).toBe(false); // stale cache…
    readYomitanOptions();
    expect(isYomitanDebugInfoEnabled()).toBe(false);
    traceYomitan('scan', { found: 3 });
    expect(getTraceRecent()).toHaveLength(0);
  });

  it('appends to the trace journal once debug info is on', () => {
    storeDebugInfo(true);
    readYomitanOptions();
    expect(isYomitanDebugInfoEnabled()).toBe(true);

    traceYomitan('scan', { found: 3, apiKey: 'super-secret' });
    const record = getTraceRecent().at(-1);
    expect(record?.area).toBe('module');
    expect(record?.event).toBe('scan');
    expect(record?.data.module).toBe('yomitan');
    expect(record?.data.found).toBe(3);
    // Rule #2453: an API key never reaches the file.
    expect(record?.data.apiKey).toBe('[redacted]');
  });

  it('follows a live toggle written through writeOptionPath', () => {
    const options = readYomitanOptions();
    expect(isYomitanDebugInfoEnabled()).toBe(false);

    const next = writeOptionPath(options, 'general.debugInfo', true);
    expect(next).not.toBe(options);
    expect(isYomitanDebugInfoEnabled()).toBe(true);

    traceYomitan('scan', { found: 1 });
    expect(getTraceRecent()).toHaveLength(1);
  });
});
