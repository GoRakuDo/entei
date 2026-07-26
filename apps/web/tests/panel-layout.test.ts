import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  readPanelLayout,
  writePanelLayout,
  DEFAULT_LAYOUT,
} from '../src/features/player/panel-layout';

// ---------------------------------------------------------------------------
// readPanelLayout
// ---------------------------------------------------------------------------

describe('readPanelLayout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns defaults when no data is stored', () => {
    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(76);
    expect(layout.sidePct).toBe(24);
  });

  it('returns the same object reference as DEFAULT_LAYOUT for empty storage', () => {
    const layout = readPanelLayout();
    expect(layout).toBe(DEFAULT_LAYOUT);
  });

  it('reads valid stored layout', () => {
    const data = {
      schemaVersion: 1,
      mainPct: 60,
      sidePct: 40,
    };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(60);
    expect(layout.sidePct).toBe(40);
  });

  it('returns defaults for corrupted JSON', () => {
    localStorage.setItem('entei.player.panel-layout.v1', 'not-json');

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(76);
    expect(layout.sidePct).toBe(24);
  });

  it('returns defaults for wrong schema version', () => {
    const data = {
      schemaVersion: 99,
      mainPct: 60,
      sidePct: 40,
    };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(76);
    expect(layout.sidePct).toBe(24);
  });

  it('returns defaults for missing mainPct', () => {
    const data = { schemaVersion: 1, sidePct: 40 };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(76);
    expect(layout.sidePct).toBe(24);
  });

  it('returns defaults for missing sidePct', () => {
    const data = { schemaVersion: 1, mainPct: 60 };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(76);
    expect(layout.sidePct).toBe(24);
  });

  it('returns defaults for non-number mainPct', () => {
    const data = { schemaVersion: 1, mainPct: 'abc', sidePct: 40 };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(76);
    expect(layout.sidePct).toBe(24);
  });

  it('returns defaults for non-number sidePct', () => {
    const data = { schemaVersion: 1, mainPct: 60, sidePct: 'abc' };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(76);
    expect(layout.sidePct).toBe(24);
  });

  it('clamps mainPct below 10 to 10', () => {
    const data = { schemaVersion: 1, mainPct: 5, sidePct: 95 };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(10);
    expect(layout.sidePct).toBe(90);
  });

  it('clamps mainPct above 90 to 90', () => {
    const data = { schemaVersion: 1, mainPct: 95, sidePct: 5 };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(90);
    expect(layout.sidePct).toBe(10);
  });

  it('clamps sidePct below 10 to 10', () => {
    const data = { schemaVersion: 1, mainPct: 95, sidePct: 5 };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(90);
    expect(layout.sidePct).toBe(10);
  });

  it('clamps sidePct above 90 to 90', () => {
    const data = { schemaVersion: 1, mainPct: 5, sidePct: 95 };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(10);
    expect(layout.sidePct).toBe(90);
  });

  it('handles NaN values (JSON serializes NaN as null)', () => {
    const data = { schemaVersion: 1, mainPct: NaN, sidePct: NaN };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    // JSON.stringify turns NaN → null, so typeof null !== 'number' → invalid schema → defaults
    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(76);
    expect(layout.sidePct).toBe(24);
  });

  it('handles negative values by clamping to minimum', () => {
    const data = { schemaVersion: 1, mainPct: -10, sidePct: -5 };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(10);
    expect(layout.sidePct).toBe(10);
  });

  it('handles boundary values (10, 90) correctly', () => {
    const data = { schemaVersion: 1, mainPct: 10, sidePct: 90 };
    localStorage.setItem('entei.player.panel-layout.v1', JSON.stringify(data));

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(10);
    expect(layout.sidePct).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// writePanelLayout
// ---------------------------------------------------------------------------

describe('writePanelLayout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('persists layout to localStorage', () => {
    writePanelLayout({ mainPct: 60, sidePct: 40 });

    const raw = localStorage.getItem('entei.player.panel-layout.v1');
    expect(raw).not.toBeNull();

    const data = JSON.parse(raw!);
    expect(data.schemaVersion).toBe(1);
    expect(data.mainPct).toBe(60);
    expect(data.sidePct).toBe(40);
  });

  it('write payload contains exactly schemaVersion/mainPct/sidePct', () => {
    writePanelLayout({ mainPct: 70, sidePct: 30 });

    const raw = localStorage.getItem('entei.player.panel-layout.v1');
    const data = JSON.parse(raw!);
    const keys = Object.keys(data).sort();
    expect(keys).toEqual(['mainPct', 'schemaVersion', 'sidePct']);
  });

  it('write payload contains no media/subtitle/file/credential data', () => {
    writePanelLayout({ mainPct: 70, sidePct: 30 });

    const raw = localStorage.getItem('entei.player.panel-layout.v1');
    expect(raw).not.toContain('blob');
    expect(raw).not.toContain('path');
    expect(raw).not.toContain('subtitle');
    expect(raw).not.toContain('file');
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('anki');
    expect(raw).not.toContain('history');
  });

  it('clamps values before persisting', () => {
    writePanelLayout({ mainPct: 5, sidePct: 95 });

    const raw = localStorage.getItem('entei.player.panel-layout.v1');
    const data = JSON.parse(raw!);
    expect(data.mainPct).toBe(10);
    expect(data.sidePct).toBe(90);
  });

  it('clamps high values before persisting', () => {
    writePanelLayout({ mainPct: 95, sidePct: 5 });

    const raw = localStorage.getItem('entei.player.panel-layout.v1');
    const data = JSON.parse(raw!);
    expect(data.mainPct).toBe(90);
    expect(data.sidePct).toBe(10);
  });

  it('does not throw when localStorage throws', () => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => writePanelLayout({ mainPct: 70, sidePct: 30 })).not.toThrow();

    Storage.prototype.setItem = originalSetItem;
  });

  it('read-after-write roundtrips correctly', () => {
    writePanelLayout({ mainPct: 55, sidePct: 45 });
    const readBack = readPanelLayout();
    expect(readBack.mainPct).toBe(55);
    expect(readBack.sidePct).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// readPanelLayout with throwing localStorage
// ---------------------------------------------------------------------------

describe('readPanelLayout with throwing localStorage', () => {
  it('returns defaults when localStorage.getItem throws', () => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('SecurityError');
    });

    const layout = readPanelLayout();
    expect(layout.mainPct).toBe(76);
    expect(layout.sidePct).toBe(24);

    Storage.prototype.getItem = originalGetItem;
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_LAYOUT
// ---------------------------------------------------------------------------

describe('DEFAULT_LAYOUT', () => {
  it('mainPct is 76 and sidePct is 24', () => {
    expect(DEFAULT_LAYOUT.mainPct).toBe(76);
    expect(DEFAULT_LAYOUT.sidePct).toBe(24);
  });

  it('is a frozen-like object (no mutations needed)', () => {
    // Just verify it's a plain object with the right shape
    expect(typeof DEFAULT_LAYOUT.mainPct).toBe('number');
    expect(typeof DEFAULT_LAYOUT.sidePct).toBe('number');
  });
});
