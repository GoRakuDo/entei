import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_JIMAKU_PREFERENCES,
  JIMAKU_PREFS_KEY,
  JIMAKU_TOAST_MAX,
  incrementJimakuToastCount,
  readJimakuPreferences,
  setJimakuApiKey,
  setJimakuAutoLoad,
  setJimakuSearchAnime,
  shouldShowJimakuToast,
  writeJimakuPreferences,
} from '../src/features/player/jimaku-preferences';

describe('jimaku-preferences', () => {
  beforeEach(() => localStorage.clear());

  it('returns defaults when nothing is stored', () => {
    expect(readJimakuPreferences()).toEqual(DEFAULT_JIMAKU_PREFERENCES);
  });

  it('reads back written preferences', () => {
    writeJimakuPreferences({
      apiKey: 'key-1',
      autoLoadEnabled: false,
      toastCount: 3,
      searchAnime: false,
    });
    expect(readJimakuPreferences()).toEqual({
      apiKey: 'key-1',
      autoLoadEnabled: false,
      toastCount: 3,
      searchAnime: false,
    });
  });

  it('falls back to defaults on corrupted JSON', () => {
    localStorage.setItem(JIMAKU_PREFS_KEY, '{not valid json');
    expect(readJimakuPreferences()).toEqual(DEFAULT_JIMAKU_PREFERENCES);
  });

  it('falls back to defaults on a wrong-shape object', () => {
    localStorage.setItem(JIMAKU_PREFS_KEY, JSON.stringify({ apiKey: 123 }));
    expect(readJimakuPreferences()).toEqual(DEFAULT_JIMAKU_PREFERENCES);
  });

  it('falls back to defaults when localStorage throws', () => {
    const original = localStorage.getItem;
    localStorage.getItem = () => {
      throw new Error('denied');
    };
    try {
      expect(readJimakuPreferences()).toEqual(DEFAULT_JIMAKU_PREFERENCES);
    } finally {
      localStorage.getItem = original;
    }
  });

  it('setJimakuApiKey updates only the key', () => {
    const prefs = setJimakuApiKey('new-key');
    expect(prefs.apiKey).toBe('new-key');
    expect(prefs.autoLoadEnabled).toBe(true); // default unchanged
    expect(readJimakuPreferences().apiKey).toBe('new-key');
  });

  it('setJimakuAutoLoad toggles and persists', () => {
    setJimakuAutoLoad(false);
    expect(readJimakuPreferences().autoLoadEnabled).toBe(false);
  });

  it('setJimakuSearchAnime toggles and persists', () => {
    setJimakuSearchAnime(false);
    expect(readJimakuPreferences().searchAnime).toBe(false);
  });

  it('incrementJimakuToastCount caps at JIMAKU_TOAST_MAX', () => {
    for (let i = 1; i <= JIMAKU_TOAST_MAX + 2; i++) {
      incrementJimakuToastCount();
    }
    expect(readJimakuPreferences().toastCount).toBe(JIMAKU_TOAST_MAX);
  });

  it('shouldShowJimakuToast is true before the cap and false at it', () => {
    expect(shouldShowJimakuToast()).toBe(true);
    for (let i = 0; i < JIMAKU_TOAST_MAX; i++) incrementJimakuToastCount();
    expect(shouldShowJimakuToast()).toBe(false);
  });
});
