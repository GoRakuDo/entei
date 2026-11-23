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
    expect(prefs.checkForDuplicates).toBe(true);
    expect(prefs.checkAllModels).toBe(false);
    expect(prefs.duplicateScope).toBe('collection');
    expect(prefs.duplicateBehavior).toBe('allow');
    expect(prefs.suspendNewCards).toBe(false);
    expect(prefs.openNoteViewer).toBe('note-editor');
    expect(typeof prefs.cardTemplates).toBe('string');
    expect(prefs.cardTemplates.length).toBeGreaterThan(0);
  });

  it('falls back enum fields to defaults on an out-of-union stored value', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
        duplicateScope: 'galaxy',
        duplicateBehavior: 'detonate',
        openNoteViewer: 'telescope',
      }),
    );
    const prefs = readAnkiConnectionPreferences();
    expect(prefs.duplicateScope).toBe('collection');
    expect(prefs.duplicateBehavior).toBe('allow');
    expect(prefs.openNoteViewer).toBe('note-editor');
    expect(prefs.checkForDuplicates).toBe(true);
  });

  it('reads valid stored preferences', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
        server: 'http://localhost:9999',
        apiKey: 'secret',
        forceSync: true,
        duplicateScope: 'deck-root',
        suspendNewCards: true,
      }),
    );
    const prefs = readAnkiConnectionPreferences();
    expect(prefs.server).toBe('http://localhost:9999');
    expect(prefs.apiKey).toBe('secret');
    expect(prefs.forceSync).toBe(true);
    expect(prefs.duplicateScope).toBe('deck-root');
    expect(prefs.suspendNewCards).toBe(true);
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

  it('seeds the two default card-format profiles and png screenshots', () => {
    const prefs = readAnkiConnectionPreferences();
    expect(prefs.screenshotFormat).toBe('png');
    expect(prefs.cardFormats.map((f) => f.id)).toEqual(['default', 'denchou']);
    const defaultProfile = prefs.cardFormats[0];
    expect(defaultProfile?.fields.Front).toBe('{expression}');
    const denchouProfile = prefs.cardFormats[1];
    expect(denchouProfile?.fields.sentenceFurigana).toBe(
      '{sentence-furigana}',
    );
  });

  it('falls back screenshotFormat to png on an out-of-union stored value', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
        screenshotFormat: 'webp',
      }),
    );
    expect(readAnkiConnectionPreferences().screenshotFormat).toBe('png');
  });

  it('seeds default cardFormats when a pre-existing row lacks them', () => {
    const { cardFormats: _omit, screenshotFormat: _omitToo, ...legacy } =
      DEFAULT_ANKI_CONNECTION_PREFERENCES;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
    const prefs = readAnkiConnectionPreferences();
    expect(prefs.screenshotFormat).toBe('png');
    expect(prefs.cardFormats.map((f) => f.id)).toEqual(['default', 'denchou']);
  });

  it('keeps a valid stored cardFormats list and drops invalid entries', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
        cardFormats: [
          {
            id: 'custom',
            name: 'Custom',
            type: 'kanji',
            icon: 'big-diamond',
            deck: 'Mining',
            model: 'Kanji',
            fields: { Front: '{expression}' },
            junk: 'ignored',
          },
          { name: 'no-id' },
          'garbage',
        ],
      }),
    );
    const prefs = readAnkiConnectionPreferences();
    expect(prefs.cardFormats.length).toBe(1);
    const customEntry = prefs.cardFormats[0];
    expect(customEntry).toBeDefined();
    expect(customEntry!.id).toBe('custom');
    expect(customEntry!.type).toBe('kanji');
    expect(customEntry!.icon).toBe('big-diamond');
    expect(customEntry!.fields.Front).toBe('{expression}');
    expect('junk' in customEntry!).toBe(false);
  });

  it('falls back to default profiles when every stored entry is invalid', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
        cardFormats: [{ name: 'no-id' }, 'garbage'],
      }),
    );
    expect(readAnkiConnectionPreferences().cardFormats.map((f) => f.id)).toEqual(
      ['default', 'denchou'],
    );
  });
});

describe('writeAnkiConnectionPreferences', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('persists preferences to localStorage under the settings key', () => {
    writeAnkiConnectionPreferences({
      ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
      server: 'http://127.0.0.1:8765',
      apiKey: 'k',
      forceSync: true,
      suspendNewCards: true,
      duplicateBehavior: 'prevent',
    });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!);
    expect(data.server).toBe('http://127.0.0.1:8765');
    expect(data.apiKey).toBe('k');
    expect(data.forceSync).toBe(true);
    expect(data.suspendNewCards).toBe(true);
    expect(data.duplicateBehavior).toBe('prevent');
  });

  it('write payload contains only the expected keys', () => {
    writeAnkiConnectionPreferences({
      ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
      apiKey: 'k',
    });
    const keys = Object.keys(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).sort();
    expect(keys).toEqual([
      'apiKey',
      'cardFormats',
      'cardTemplates',
      'checkAllModels',
      'checkForDuplicates',
      'duplicateBehavior',
      'duplicateScope',
      'forceSync',
      'openNoteViewer',
      'screenshotFormat',
      'server',
      'suspendNewCards',
    ]);
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

  it('merges Card Management fields without dropping prior ones', () => {
    updateAnkiConnectionPreferences({ suspendNewCards: true });
    updateAnkiConnectionPreferences({ duplicateScope: 'deck' });
    const prefs = readAnkiConnectionPreferences();
    expect(prefs.suspendNewCards).toBe(true);
    expect(prefs.duplicateScope).toBe('deck');
    expect(prefs.duplicateBehavior).toBe('allow'); // untouched keeps default
    expect(prefs.checkForDuplicates).toBe(true); // untouched keeps default
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
