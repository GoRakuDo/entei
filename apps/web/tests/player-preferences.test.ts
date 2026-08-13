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
    // New subtitle appearance defaults
    expect(prefs.subtitleFontSize).toBe(18);
    expect(prefs.subtitleTextColor).toBe('oklch(98% 0 0deg)');
    expect(prefs.subtitleBackgroundColor).toBe('oklch(0% 0 0 / 0.72)');
    expect(prefs.subtitleBackgroundPadding).toBe(8);
    expect(prefs.subtitleVerticalPosition).toBe(96);
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
    // New fields also default
    expect(prefs.subtitleFontSize).toBe(18);
    expect(prefs.subtitleTextColor).toBe('oklch(98% 0 0deg)');
    expect(prefs.subtitleBackgroundColor).toBe('oklch(0% 0 0 / 0.72)');
    expect(prefs.subtitleBackgroundPadding).toBe(8);
    expect(prefs.subtitleVerticalPosition).toBe(96);
  });

  it('returns defaults for corrupted JSON', () => {
    localStorage.setItem('entei.player.prefs.v1', 'not-json');

    const prefs = readPlayerPreferences();
    expect(prefs.volume).toBe(1);
    expect(prefs.playbackRate).toBe(1);
    expect(prefs.captionDisplayMode).toBe('visible');
    expect(prefs.subtitleFontSize).toBe(18);
    expect(prefs.subtitleTextColor).toBe('oklch(98% 0 0deg)');
    expect(prefs.subtitleBackgroundColor).toBe('oklch(0% 0 0 / 0.72)');
    expect(prefs.subtitleBackgroundPadding).toBe(8);
    expect(prefs.subtitleVerticalPosition).toBe(96);
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

  // --- subtitle appearance tests ---

  it('reads stored subtitleFontSize', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleFontSize: 24,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleFontSize).toBe(24);
  });

  it('clamps subtitleFontSize to [16, 48]', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleFontSize: 100,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleFontSize).toBe(48);
  });

  it('clamps subtitleFontSize minimum to 16', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleFontSize: 10,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleFontSize).toBe(16);
  });

  it('reads stored subtitleTextColor (oklch)', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleTextColor: 'oklch(50% 0.1 200deg)',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleTextColor).toBe('oklch(50% 0.1 200deg)');
  });

  it('falls back to default for invalid subtitleTextColor', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleTextColor: '#ff0000', // hex not allowed
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleTextColor).toBe('oklch(98% 0 0deg)');
  });

  it('reads stored subtitleBackgroundColor (oklch with alpha)', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleBackgroundColor: 'oklch(20% 0.05 270deg / 0.5)',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleBackgroundColor).toBe('oklch(20% 0.05 270deg / 0.5)');
  });

  it('falls back to default for invalid subtitleBackgroundColor', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleBackgroundColor: 'rgba(0,0,0,0.5)', // not oklch
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleBackgroundColor).toBe('oklch(0% 0 0 / 0.72)');
  });

  it('reads stored subtitleBackgroundPadding', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleBackgroundPadding: 12,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleBackgroundPadding).toBe(12);
  });

  it('clamps subtitleBackgroundPadding to [0, 32]', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleBackgroundPadding: 50,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleBackgroundPadding).toBe(32);
  });

  it('reads stored subtitleVerticalPosition', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleVerticalPosition: 120,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleVerticalPosition).toBe(120);
  });

  it('clamps subtitleVerticalPosition to [0, 200]', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleVerticalPosition: 300,
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleVerticalPosition).toBe(200);
  });

  // --- P2: tightened oklch regex (malformed decimals) ---

  it('falls back to default for oklch with malformed decimal L (1.2.3)', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleTextColor: 'oklch(1.2.3% 0.5 200deg)',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleTextColor).toBe('oklch(98% 0 0deg)');
  });

  it('falls back to default for oklch with malformed decimal C (0..1)', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleTextColor: 'oklch(50% 0..1 200deg)',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleTextColor).toBe('oklch(98% 0 0deg)');
  });

  it('falls back to default for oklch with malformed decimal alpha (0.7.2)', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleBackgroundColor: 'oklch(20% 0.05 270deg / 0.7.2)',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleBackgroundColor).toBe('oklch(0% 0 0 / 0.72)');
  });

  it('accepts valid oklch with decimal components', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleTextColor: 'oklch(50.5% 0.123 200.5deg)',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleTextColor).toBe('oklch(50.5% 0.123 200.5deg)');
  });

  // --- P0: alpha preservation in background color ---

  it('preserves alpha in background color through read/write round-trip', () => {
    writePlayerPreferences({
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'visible',
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(30% 0.1 180deg / 0.45)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
    });

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleBackgroundColor).toBe('oklch(30% 0.1 180deg / 0.45)');
  });

  it('accepts background color with full opacity (no / alpha)', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleBackgroundColor: 'oklch(50% 0.1 200deg)',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleBackgroundColor).toBe('oklch(50% 0.1 200deg)');
  });

  // --- Bug fix: canonical alpha inside parentheses ---

  it('stores and reads back canonical inside-alpha format', () => {
    writePlayerPreferences({
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'visible',
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(0% 0 0deg / 0.44)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
    });

    const prefs = readPlayerPreferences();
    // Must preserve inside-alpha format, NOT produce outside-alpha
    expect(prefs.subtitleBackgroundColor).toBe('oklch(0% 0 0deg / 0.44)');
    // Alpha must NOT be outside parentheses
    expect(prefs.subtitleBackgroundColor).not.toMatch(/\)\s*\//);
  });

  it('44% alpha round-trip through write/read', () => {
    writePlayerPreferences({
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'visible',
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(20% 0.05 270deg / 0.44)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
    });

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleBackgroundColor).toBe('oklch(20% 0.05 270deg / 0.44)');
  });

  it('35% alpha round-trip through write/read', () => {
    writePlayerPreferences({
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'visible',
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(20% 0.05 270deg / 0.35)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
    });

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleBackgroundColor).toBe('oklch(20% 0.05 270deg / 0.35)');
  });

  // --- Bug fix: legacy outside-alpha repair ---

  it('repairs legacy outside-alpha background color to canonical inside-alpha', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      // Legacy broken format from short-lived build: alpha OUTSIDE parentheses
      subtitleBackgroundColor: 'oklch(0% 0 0deg) / 0.44',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    // Must repair to canonical inside-alpha format
    expect(prefs.subtitleBackgroundColor).toBe('oklch(0% 0 0deg / 0.44)');
  });

  it('repairs legacy outside-alpha with no angle suffix', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleBackgroundColor: 'oklch(20% 0.05 270) / 0.35',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    expect(prefs.subtitleBackgroundColor).toBe('oklch(20% 0.05 270 / 0.35)');
  });

  it('does not display 100% for repaired outside-alpha value', () => {
    const data = {
      schemaVersion: 1,
      volume: 1,
      playbackRate: 1,
      subtitleBackgroundColor: 'oklch(0% 0 0deg) / 0.44',
    };
    localStorage.setItem('entei.player.prefs.v1', JSON.stringify(data));

    const prefs = readPlayerPreferences();
    // The value should be repaired, not default
    expect(prefs.subtitleBackgroundColor).not.toBe('oklch(0% 0 0 / 0.72)');
    expect(prefs.subtitleBackgroundColor).toBe('oklch(0% 0 0deg / 0.44)');
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
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    expect(raw).not.toBeNull();

    const data = JSON.parse(raw!);
    expect(data.schemaVersion).toBe(1);
    expect(data.volume).toBe(0.75);
    expect(data.playbackRate).toBe(1.5);
    expect(data.captionDisplayMode).toBe('visible');
    expect(data.subtitleFontSize).toBe(18);
    expect(data.subtitleTextColor).toBe('oklch(98% 0 0deg)');
    expect(data.subtitleBackgroundColor).toBe('oklch(0% 0 0 / 0.72)');
    expect(data.subtitleBackgroundPadding).toBe(8);
    expect(data.subtitleVerticalPosition).toBe(96);
  });

  it('persists captionDisplayMode blurred', () => {
    writePlayerPreferences({
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'blurred',
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
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
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.captionDisplayMode).toBe('hidden');
  });

  it('write payload contains exactly all expected keys', () => {
    writePlayerPreferences({
      volume: 0.5,
      playbackRate: 1,
      captionDisplayMode: 'blurred',
      subtitleFontSize: 20,
      subtitleTextColor: 'oklch(90% 0.05 200deg)',
      subtitleBackgroundColor: 'oklch(10% 0.02 270deg / 0.8)',
      subtitleBackgroundPadding: 10,
      subtitleVerticalPosition: 100,
      subtitleSyncMode: 'auto',
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    const keys = Object.keys(data).sort();
    expect(keys).toEqual([
      'captionDisplayMode',
      'playbackRate',
      'schemaVersion',
      'subtitleBackgroundColor',
      'subtitleBackgroundPadding',
      'subtitleFontSize',
      'subtitleSyncMode',
      'subtitleTextColor',
      'subtitleVerticalPosition',
      'volume',
    ]);
  });

  it('write payload contains no media/file/blob/path data', () => {
    writePlayerPreferences({
      volume: 0.5,
      playbackRate: 1,
      captionDisplayMode: 'visible',
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    expect(raw).not.toContain('blob');
    expect(raw).not.toContain('path');
    expect(raw).not.toContain('file');
    // No subtitle cue text or media content should be stored
    expect(raw).not.toContain('cues');
    expect(raw).not.toContain('.srt');
    expect(raw).not.toContain('.vtt');
    expect(raw).not.toContain('.mp4');
    expect(raw).not.toContain('.mp3');
  });

  it('clamps volume before persisting', () => {
    writePlayerPreferences({
      volume: 5,
      playbackRate: 1,
      captionDisplayMode: 'visible',
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
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
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
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
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.playbackRate).toBe(1.25);
  });

  it('clamps subtitleFontSize before persisting', () => {
    writePlayerPreferences({
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'visible',
      subtitleFontSize: 100,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 96,
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.subtitleFontSize).toBe(48);
  });

  it('clamps subtitleBackgroundPadding before persisting', () => {
    writePlayerPreferences({
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'visible',
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
      subtitleBackgroundPadding: 50,
      subtitleVerticalPosition: 96,
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.subtitleBackgroundPadding).toBe(32);
  });

  it('clamps subtitleVerticalPosition before persisting', () => {
    writePlayerPreferences({
      volume: 1,
      playbackRate: 1,
      captionDisplayMode: 'visible',
      subtitleFontSize: 18,
      subtitleTextColor: 'oklch(98% 0 0deg)',
      subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
      subtitleBackgroundPadding: 8,
      subtitleVerticalPosition: 300,
    });

    const raw = localStorage.getItem('entei.player.prefs.v1');
    const data = JSON.parse(raw!);
    expect(data.subtitleVerticalPosition).toBe(200);
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
        subtitleFontSize: 18,
        subtitleTextColor: 'oklch(98% 0 0deg)',
        subtitleBackgroundColor: 'oklch(0% 0 0 / 0.72)',
        subtitleBackgroundPadding: 8,
        subtitleVerticalPosition: 96,
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
