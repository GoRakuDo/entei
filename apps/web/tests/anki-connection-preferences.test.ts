import { describe, expect, it, vi, beforeEach, afterEach } from 'bun:test';
import {
  readAnkiConnectionPreferences,
  writeAnkiConnectionPreferences,
  updateAnkiConnectionPreferences,
  DEFAULT_ANKI_CONNECTION_PREFERENCES,
  DEFAULT_ANKI_SERVER,
  ANKI_CONNECTION_PREFS_KEY,
} from '../src/features/player/anki-connection-preferences';

const STORAGE_KEY = ANKI_CONNECTION_PREFS_KEY;

describe('readAnkiConnectionPreferences', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('returns defaults when nothing is stored', () => {
    const prefs = readAnkiConnectionPreferences();
    expect(prefs.server).toBe(DEFAULT_ANKI_SERVER);
    expect(prefs.apiKey).toBe('');
    expect(prefs.forceSync).toBe(false);
  });

  it('reads valid stored preferences', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        server: 'http://localhost:9999',
        apiKey: 'secret',
        forceSync: true,
      }),
    );
    const prefs = readAnkiConnectionPreferences();
    expect(prefs.server).toBe('http://localhost:9999');
    expect(prefs.apiKey).toBe('secret');
    expect(prefs.forceSync).toBe(true);
  });

  it('returns defaults for corrupted JSON', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json');
    expect(readAnkiConnectionPreferences()).toEqual(
      DEFAULT_ANKI_CONNECTION_PREFERENCES,
    );
  });

  it('returns defaults when a field has the wrong type', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        server: 'http://localhost:9999',
        apiKey: 123,
        forceSync: false,
      }),
    );
    expect(readAnkiConnectionPreferences()).toEqual(
      DEFAULT_ANKI_CONNECTION_PREFERENCES,
    );
  });


  it('returns defaults when localStorage.getItem throws', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('SecurityError');
    });
    expect(readAnkiConnectionPreferences()).toEqual(
      DEFAULT_ANKI_CONNECTION_PREFERENCES,
    );
    Storage.prototype.getItem = original;
  });
});

describe('writeAnkiConnectionPreferences', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('persists preferences to localStorage under the settings key', () => {
    writeAnkiConnectionPreferences({
      server: 'http://127.0.0.1:8765',
      apiKey: 'k',
      forceSync: true,
    });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!);
    expect(data.server).toBe('http://127.0.0.1:8765');
    expect(data.apiKey).toBe('k');
    expect(data.forceSync).toBe(true);
  });

  it('write payload contains only the expected keys', () => {
    writeAnkiConnectionPreferences({
      ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
      apiKey: 'k',
    });
    const keys = Object.keys(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).sort();
    expect(keys).toEqual(['apiKey', 'forceSync', 'server']);
  });

  it('does not throw when localStorage.setItem throws', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() =>
      writeAnkiConnectionPreferences(DEFAULT_ANKI_CONNECTION_PREFERENCES),
    ).not.toThrow();
    Storage.prototype.setItem = original;
  });
});

describe('updateAnkiConnectionPreferences', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('merges a partial change and persists it', () => {
    updateAnkiConnectionPreferences({ server: 'http://h:1', apiKey: 'a' });
    updateAnkiConnectionPreferences({ forceSync: true });
    const prefs = readAnkiConnectionPreferences();
    expect(prefs.server).toBe('http://h:1');
    expect(prefs.apiKey).toBe('a');
    expect(prefs.forceSync).toBe(true);
    // untouched field keeps its default
  });

});

describe('settings-store registration', () => {
  it('registers the Anki connection key for the desktop SQLite mirror', async () => {
    const { SETTINGS_STORAGE_KEYS } = await import(
      '../src/features/settings/settings-store'
    );
    expect(SETTINGS_STORAGE_KEYS).toContain(ANKI_CONNECTION_PREFS_KEY);
  });
});
