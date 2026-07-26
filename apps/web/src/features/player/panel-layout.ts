/**
 * Panel Layout — Desktop side-panel width persistence via localStorage.
 * ---------------------------------------------------------------------------
 * Stores ONLY two percentage numbers (main %, side %) that sum to 100.
 * No media name/path, subtitle data, history data, Anki data, credentials,
 * or active tab is persisted. Versioned key for safe migration.
 *
 * Design:
 * - Typed with schema version for future migration.
 * - Exception-safe: never throws to caller; returns defaults on any failure.
 * - Validates ranges before persisting (each panel 10–90 %).
 * - Corrupt/missing/out-of-range values safely default to 76%/24%.
 * --------------------------------------------------------------------------- */

/** localStorage key. */
const STORAGE_KEY = 'entei.player.panel-layout.v1';

/** Current schema version. Bump when shape changes. */
const SCHEMA_VERSION = 1;

/** Default layout: main 76%, side 24%. */
const DEFAULT_MAIN = 76;
const DEFAULT_SIDE = 24;

/** Valid percentage range per panel (10 %–90 %). */
const MIN_PANEL_PCT = 10;
const MAX_PANEL_PCT = 90;

/** Public interface — two percentage numbers that sum to 100. */
export interface PanelLayout {
  mainPct: number;
  sidePct: number;
}

/** Persisted data shape. */
interface PanelLayoutData {
  schemaVersion: number;
  mainPct: number;
  sidePct: number;
}

/** Default layout constant. */
export const DEFAULT_LAYOUT: PanelLayout = {
  mainPct: DEFAULT_MAIN,
  sidePct: DEFAULT_SIDE,
};

/**
 * Read panel layout from localStorage.
 * Returns defaults if absent, corrupted, or if localStorage throws.
 */
export function readPanelLayout(): PanelLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_LAYOUT;

    const parsed: unknown = JSON.parse(raw);
    if (!isValidPanelLayoutData(parsed)) return DEFAULT_LAYOUT;

    return {
      mainPct: clampPanelPct(parsed.mainPct),
      sidePct: clampPanelPct(parsed.sidePct),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/**
 * Write panel layout to localStorage.
 * Silently ignores failure (storage full, private browsing, etc.).
 */
export function writePanelLayout(layout: PanelLayout): void {
  try {
    const main = clampPanelPct(layout.mainPct);
    const side = clampPanelPct(layout.sidePct);
    const data: PanelLayoutData = {
      schemaVersion: SCHEMA_VERSION,
      mainPct: main,
      sidePct: side,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage failure is non-fatal
  }
}

/**
 * Type guard for persisted shape.
 */
function isValidPanelLayoutData(value: unknown): value is PanelLayoutData {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof obj.mainPct !== 'number') return false;
  if (typeof obj.sidePct !== 'number') return false;
  return true;
}

/**
 * Clamp a percentage to [MIN_PANEL_PCT, MAX_PANEL_PCT].
 * NaN falls back to the relevant default.
 */
function clampPanelPct(v: number): number {
  if (isNaN(v)) return DEFAULT_MAIN;
  if (v < MIN_PANEL_PCT) return MIN_PANEL_PCT;
  if (v > MAX_PANEL_PCT) return MAX_PANEL_PCT;
  return v;
}
