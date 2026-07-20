import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  readPlayerPreferences,
  writePlayerPreferences,
} from '../src/features/player/preferences';

// ---------------------------------------------------------------------------
// readPlayerPreferences
// ---------------------------------------------------------------------------

describe('readPlayerPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns defaults when no data is stored', () => {
    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(1);
    expect(prefs.playbackRate).toBe(1);
  });

  it('reads valid stored preferences', () => {
    const data = {
      schemaVersion: 1,
      volume: 0.5,
      playbackRate: 1.5,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(0.5);
    expect(prefs.playbackRate).toBe(1.5);
  });

  it('returns defaults for corrupted JSON', () => {
    localStorage.setItem('entei.player.prefs.v1', 'not-json');

    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(1);
    expect(prefs.playbackRate).toBe(1);
  });

  it('returns defaults for wrong schema version', () => {
    const data = {
      schemaVersion: 99,
      volume: 0.5,
      playbackRate: 1.5,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(1);
    expect(prefs.playbackRate).toBe(1);
  });

  it('returns defaults for missing fields', () => {
    const data = { schemaVersion: 1 };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(1);
    expect(prefs.playbackRate).toBe(1);
  });

  it('clamps out-of-range volume', () => {
    const data = {
      schemaVersion: 1,
      volume: 2.5,
      playbackRate: 1,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(1);
  });

  it('clamps negative volume to 0', () => {
    const data = {
      schemaVersion: 1,
      volume: -0.5,
      playbackRate: 1,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(0);
  });

  it('rounds playback rate to nearest valid value', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1.3,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.playbackRate).toBe(1.25);
  });

  it('handles NaN volume gracefully (JSON serializes NaN as null, so defaults)', () => {
    const data = {
      schemaVersion: 1,
      volume: NaN,
      playbackRate: 1,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    // JSON.stringify turns NaN → null, so typeof null !== 'number' → invalid schema → defaults
    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(1);
  });

  it('handles NaN playbackRate gracefully (JSON serializes NaN as null, so defaults)', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: NaN,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    // JSON.stringify turns NaN → null, so typeof null !== 'number' → invalid schema → defaults
    const prefs = readPlayerPreferences();
    expect(prefs.playbackRate).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// writePlayerPreferences
// ---------------------------------------------------------------------------

describe('writePlayerPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('persists preferences to localStorage', () => {
    writePlayerPreferences({ volume: 0.75, playbackRate: 1.5 });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    expect(raw).not.toBeNull();

    const data = JSON.parse(raw!);
    expect(data.schemaVersion).toBe(1);
    expect(data.volume).toBe(0.75);
    expect(data.playbackRate).toBe(1.5);
  });

  it('clamps volume before persisting', () => {
    writePlayerPreferences({ volume: 5, playbackRate: 1 });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.volume).toBe(1);
  });

  it('clamps volume to 0 for negative', () => {
    writePlayerPreferences({ volume: -1, playbackRate: 1 });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.volume).toBe(0);
  });

  it('rounds playback rate to nearest valid value', () => {
    writePlayerPreferences({ volume: 1, playbackRate: 1.3 });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.playbackRate).toBe(1.25);
  });

  it('does not throw when localStorage throws', () => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() =>
      writePlayerPreferences({ volume: 0.5, playbackRate: 1 }),
    ).not.toThrow();

    Storage.prototype.setItem = originalSetItem;
  });
});

// ---------------------------------------------------------------------------
// readPlayerPreferences with throwing localStorage
// ---------------------------------------------------------------------------

describe('readPlayerPreferences with throwing localStorage', () => {
  it('returns defaults when localStorage.getItem throws', () => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('SecurityError');
    });

    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(1);
    expect(prefs.playbackRate).toBe(1);

    Storage.prototype.getItem = originalGetItem;
  });
});
