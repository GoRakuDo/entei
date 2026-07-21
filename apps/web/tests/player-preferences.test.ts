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
    expect(prefs.captionDisplayMode).toBe('visible');
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
    expect(prefs.captionDisplayMode).toBe('visible'); // missing → default
  });

  it('returns defaults for corrupted JSON', () => {
    localStorage.setItem('entei.player.prefs.v1', 'not-json');

    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(1);
    expect(prefs.playbackRate).toBe(1);
    expect(prefs.captionDisplayMode).toBe('visible');
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
    expect(prefs.captionDisplayMode).toBe('visible');
  });

  it('returns defaults for missing fields', () => {
    const data = { schemaVersion: 1 };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(1);
    expect(prefs.playbackRate).toBe(1);
    expect(prefs.captionDisplayMode).toBe('visible');
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

  // --- captionDisplayMode tests ---

  it('reads stored captionDisplayMode visible', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'visible',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.captionDisplayMode).toBe('visible');
  });

  it('reads stored captionDisplayMode blurred', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'blurred',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.captionDisplayMode).toBe('blurred');
  });

  it('reads stored captionDisplayMode hidden', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'hidden',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.captionDisplayMode).toBe('hidden');
  });

  it('falls back to visible for invalid captionDisplayMode string', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'invalid',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.captionDisplayMode).toBe('visible');
  });

  it('falls back to visible for missing captionDisplayMode (old v1 payload)', () => {
    const data = {
      schemaVersion: 1,
      volume: 0.5,
      playbackRate: 1.5,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.captionDisplayMode).toBe('visible');
    // existing volume/rate still preserved
    expect(prefs.volume).toBe(0.5);
    expect(prefs.playbackRate).toBe(1.5);
  });

  it('does not reject old v1 payload with only volume/rate', () => {
    // Old v1 payload — must not throw or return all defaults
    const data = {
      schemaVersion: 1,
      volume: 0.75,
      playbackRate: 0.5,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(0.75);
    expect(prefs.playbackRate).toBe(0.5);
    expect(prefs.captionDisplayMode).toBe('visible');
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
    writePlayerPreferences({
      volume: 0.75,
      playbackRate: 1.5,
      captionDisplayMode: 'visible',
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    expect(raw).not.toBeNull();

    const data = JSON.parse(raw!);
    expect(data.schemaVersion).toBe(1);
    expect(data.volume).toBe(0.75);
    expect(data.playbackRate).toBe(1.5);
    expect(data.captionDisplayMode).toBe('visible');
  });

  it('persists captionDisplayMode blurred', () => {
    writePlayerPreferences({
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'blurred',
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.captionDisplayMode).toBe('blurred');
  });

  it('persists captionDisplayMode hidden', () => {
    writePlayerPreferences({
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'hidden',
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.captionDisplayMode).toBe('hidden');
  });

  it('write payload contains exactly schemaVersion/volume/playbackRate/captionDisplayMode', () => {
    writePlayerPreferences({
      volume: 0.5,
      playbackRate: 1,
      captionDisplayMode: 'blurred',
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    const keys = Object.keys(data).sort();
    expect(keys).toEqual([
      'captionDisplayMode',
      'playbackRate',
      'schemaVersion',
      'volume',
    ]);
  });

  it('write payload contains no media/subtitle/file data', () => {
    writePlayerPreferences({
      volume: 0.5,
      playbackRate: 1,
      captionDisplayMode: 'visible',
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    expect(raw).not.toContain('blob');
    expect(raw).not.toContain('path');
    expect(raw).not.toContain('subtitle');
    expect(raw).not.toContain('file');
  });

  it('clamps volume before persisting', () => {
    writePlayerPreferences({
      volume: 5,
      playbackRate: 1,
      captionDisplayMode: 'visible',
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.volume).toBe(1);
  });

  it('clamps volume to 0 for negative', () => {
    writePlayerPreferences({
      volume: -1,
      playbackRate: 1,
      captionDisplayMode: 'visible',
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.volume).toBe(0);
  });

  it('rounds playback rate to nearest valid value', () => {
    writePlayerPreferences({
      volume: 1,
      playbackRate: 1.3,
      captionDisplayMode: 'visible',
    });

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
      writePlayerPreferences({
        volume: 0.5,
        playbackRate: 1,
        captionDisplayMode: 'visible',
      }),
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
    expect(prefs.captionDisplayMode).toBe('visible');

    Storage.prototype.getItem = originalGetItem;
  });
});
