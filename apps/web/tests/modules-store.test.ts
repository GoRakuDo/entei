/**
 * modules-store unit tests — MODULE_ARCHITECTURE.md §5.
 *
 * Covers the persistence contract of `entei.modules.v1`:
 * - defaults are all-on when storage is empty
 * - round-trip write → read
 * - corrupted / unknown payloads fall back to defaults (never throw)
 * - unknown module ids and non-boolean values are dropped
 * - toggleModuleState is pure (returns a new object, does not persist)
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  CORE_MODULES,
  DEFAULT_MODULE_STATE,
  MODULES_KEY,
  MODULES_SCHEMA_VERSION,
  readModuleState,
  toggleModuleState,
  writeModuleState,
} from '@/features/modules/modules-store';

describe('modules-store — manifests', () => {
  it('ships the five official core modules', () => {
    expect(CORE_MODULES.map((module) => module.id)).toEqual([
      'ytdlp',
      'torrent',
      'yomitan',
      'jimaku',
      'nadeshiko',
    ]);
    expect(CORE_MODULES.every((module) => module.builtIn)).toBe(true);
    expect(CORE_MODULES.every((module) => module.defaultEnabled)).toBe(true);
  });

  it('categorises source modules and the dictionary modules', () => {
    const byId = Object.fromEntries(
      CORE_MODULES.map((module) => [module.id, module.category]),
    );
    expect(byId.ytdlp).toBe('source');
    expect(byId.torrent).toBe('source');
    expect(byId.jimaku).toBe('source');
    expect(byId.yomitan).toBe('dictionary');
    expect(byId.nadeshiko).toBe('dictionary');
  });

  it('defaults to every module enabled', () => {
    expect(DEFAULT_MODULE_STATE).toEqual({
      ytdlp: true,
      torrent: true,
      yomitan: true,
      jimaku: true,
      nadeshiko: true,
    });
  });
});

describe('modules-store — persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns defaults when nothing is stored', () => {
    expect(readModuleState()).toEqual(DEFAULT_MODULE_STATE);
  });

  it('round-trips the enabled state', () => {
    writeModuleState({
      ytdlp: false,
      torrent: true,
      yomitan: false,
      jimaku: true,
      nadeshiko: false,
    });
    expect(readModuleState()).toEqual({
      ytdlp: false,
      torrent: true,
      yomitan: false,
      jimaku: true,
      nadeshiko: false,
    });
  });

  it('persists under the versioned key', () => {
    writeModuleState({ ytdlp: false, torrent: true, yomitan: true });
    const raw = localStorage.getItem(MODULES_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      version: MODULES_SCHEMA_VERSION,
      enabled: { ytdlp: false, torrent: true, yomitan: true },
    });
  });

  it('falls back to defaults on corrupted JSON', () => {
    localStorage.setItem(MODULES_KEY, '{not json');
    expect(readModuleState()).toEqual(DEFAULT_MODULE_STATE);
  });

  it('falls back to defaults when the payload shape is wrong', () => {
    localStorage.setItem(MODULES_KEY, JSON.stringify({ enabled: 'yes' }));
    expect(readModuleState()).toEqual(DEFAULT_MODULE_STATE);
  });

  it('drops non-boolean values but keeps unknown ids', () => {
    localStorage.setItem(
      MODULES_KEY,
      JSON.stringify({
        version: MODULES_SCHEMA_VERSION,
        enabled: { ytdlp: false, removed: true, torrent: 'nope' },
      }),
    );
    const state = readModuleState();
    expect(state).toEqual({
      ...DEFAULT_MODULE_STATE,
      ytdlp: false,
      torrent: true, // invalid value → default
      // Unknown ids are KEPT: an imported manifest may legitimately appear
      // between sessions (modules-store.ts header contract).
      removed: true,
    });
  });
});

describe('modules-store — toggle', () => {
  it('returns a new state without mutating the input', () => {
    const before = { ...DEFAULT_MODULE_STATE };
    const after = toggleModuleState(before, 'torrent');
    expect(after).toEqual({ ...DEFAULT_MODULE_STATE, torrent: false });
    expect(before).toEqual(DEFAULT_MODULE_STATE);
    expect(after).not.toBe(before);
  });

  it('does not persist on its own', () => {
    localStorage.clear();
    toggleModuleState(DEFAULT_MODULE_STATE, 'yomitan');
    expect(localStorage.getItem(MODULES_KEY)).toBeNull();
  });
});
