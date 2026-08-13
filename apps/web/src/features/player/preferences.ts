/**
 * Player Preferences — Volume, Playback Rate, Caption Display Mode, and Subtitle Appearance
 * ---------------------------------------------------------------------------
 * P1/P2 scope: only safe UI preferences in localStorage.
 * - volume (0–1, number)
 * - playbackRate (0.25–2, number)
 * - captionDisplayMode ('visible' | 'blurred' | 'hidden')
 * - subtitleFontSize (16–48, number, px)
 * - subtitleTextColor (string, canonical oklch(...))
 * - subtitleBackgroundColor (string, canonical oklch(...) with alpha)
 * - subtitleBackgroundPadding (0–32, number, px, uniform)
 * - subtitleVerticalPosition (0–200, number, px, bottom offset)
 *
 * Design:
 * - Typed with schema version for future migration.
 * - Exception-safe: never throws to caller; returns defaults on any failure.
 * - Validates ranges before persisting.
 * - Never stores File, path, blob URL, subtitle, or media data.
 * - Backwards-compatible: old v1 payloads without new fields read as defaults.
 * - ALL saved/applied colors are canonical oklch(...) strings. No hex/rgb/hsl/named.
 * --------------------------------------------------------------------------- */

import type { CaptionDisplayMode } from './control-helpers';

/** localStorage key. */
const STORAGE_KEY = 'entei.player.prefs.v1';

/** Current schema version. Bump when shape changes. */
const SCHEMA_VERSION = 1;

/** Valid playback rate values. */
const VALID_PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** Valid caption display modes. */
const VALID_CAPTION_MODES: readonly CaptionDisplayMode[] = [
  'visible',
  'blurred',
  'hidden',
];

/** Default values. */
const DEFAULT_VOLUME = 1;
const DEFAULT_PLAYBACK_RATE = 1;
const DEFAULT_CAPTION_DISPLAY_MODE: CaptionDisplayMode = 'visible';

// Subtitle appearance defaults — match current CSS appearance:
// - fontSize: body-lg (~1.125rem ≈ 18px), clamped to 16–48px range
// - textColor: oklch(98% 0 0deg) — near white
// - backgroundColor: oklch(0% 0 0 / 0.72) — black 72% opacity
// - backgroundPadding: 8px uniform (was 4px vertical / 8px horizontal; unified to 8px)
// - verticalPosition: 96px (was --entei-space-96 bottom offset)
const DEFAULT_SUBTITLE_FONT_SIZE = 18;
const DEFAULT_SUBTITLE_TEXT_COLOR = 'oklch(98% 0 0deg)';
const DEFAULT_SUBTITLE_BACKGROUND_COLOR = 'oklch(0% 0 0 / 0.72)';
const DEFAULT_SUBTITLE_BACKGROUND_PADDING = 8;
const DEFAULT_SUBTITLE_VERTICAL_POSITION = 96;
const DEFAULT_SUBTITLE_SYNC_MODE: SubtitleSyncMode = 'subtitle';

/** Persisted player preference shape (v1, extended with optional subtitle appearance fields). */
interface PlayerPreferenceData {
  schemaVersion: number;
  volume: number;
  playbackRate: number;
  captionDisplayMode?: CaptionDisplayMode;
  subtitleFontSize?: number;
  subtitleTextColor?: string;
  subtitleBackgroundColor?: string;
  subtitleBackgroundPadding?: number;
  subtitleVerticalPosition?: number;
  subtitleSyncMode?: SubtitleSyncMode;
}

/** Public interface. */
export interface PlayerPreferences {
  volume: number;
  playbackRate: number;
  captionDisplayMode: CaptionDisplayMode;
  subtitleFontSize: number;
  subtitleTextColor: string;
  subtitleBackgroundColor: string;
  subtitleBackgroundPadding: number;
  subtitleVerticalPosition: number;
  subtitleSyncMode?: SubtitleSyncMode;
}

/** Sync mode for the subomatic engine (stage ③). */
export type SubtitleSyncMode = 'subtitle' | 'audio' | 'auto';

/**
 * Read player preferences from localStorage.
 * Returns defaults if absent, corrupted, or if localStorage throws.
 * Old v1 payloads without new fields default to current appearance values.
 */
export function readPlayerPreferences(): PlayerPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return getDefaultPreferences();
    }

    const parsed: unknown = JSON.parse(raw);

    if (!isValidPreferenceData(parsed)) {
      return getDefaultPreferences();
    }

    return {
      volume: clampVolume(parsed.volume),
      playbackRate: clampPlaybackRate(parsed.playbackRate),
      captionDisplayMode: parseCaptionDisplayMode(parsed.captionDisplayMode),
      subtitleFontSize: parseSubtitleFontSize(parsed.subtitleFontSize),
      subtitleTextColor: parseSubtitleTextColor(parsed.subtitleTextColor),
      subtitleBackgroundColor: parseSubtitleBackgroundColor(parsed.subtitleBackgroundColor),
      subtitleBackgroundPadding: parseSubtitleBackgroundPadding(parsed.subtitleBackgroundPadding),
      subtitleVerticalPosition: parseSubtitleVerticalPosition(parsed.subtitleVerticalPosition),
      subtitleSyncMode: parseSubtitleSyncMode(parsed.subtitleSyncMode),
    };
  } catch {
    // localStorage unavailable or JSON corrupted
    return getDefaultPreferences();
  }
}

function getDefaultPreferences(): PlayerPreferences {
  return {
    volume: DEFAULT_VOLUME,
    playbackRate: DEFAULT_PLAYBACK_RATE,
    captionDisplayMode: DEFAULT_CAPTION_DISPLAY_MODE,
    subtitleFontSize: DEFAULT_SUBTITLE_FONT_SIZE,
    subtitleTextColor: DEFAULT_SUBTITLE_TEXT_COLOR,
    subtitleBackgroundColor: DEFAULT_SUBTITLE_BACKGROUND_COLOR,
    subtitleBackgroundPadding: DEFAULT_SUBTITLE_BACKGROUND_PADDING,
    subtitleVerticalPosition: DEFAULT_SUBTITLE_VERTICAL_POSITION,
    subtitleSyncMode: DEFAULT_SUBTITLE_SYNC_MODE,
  };
}

/**
 * Write player preferences to localStorage.
 * Silently ignores failure (storage full, private browsing, etc.).
 */
export function writePlayerPreferences(prefs: PlayerPreferences): void {
  try {
    const data: PlayerPreferenceData = {
      schemaVersion: SCHEMA_VERSION,
      volume: clampVolume(prefs.volume),
      playbackRate: clampPlaybackRate(prefs.playbackRate),
      captionDisplayMode: parseCaptionDisplayMode(prefs.captionDisplayMode),
      subtitleFontSize: parseSubtitleFontSize(prefs.subtitleFontSize),
      subtitleTextColor: parseSubtitleTextColor(prefs.subtitleTextColor),
      subtitleBackgroundColor: parseSubtitleBackgroundColor(prefs.subtitleBackgroundColor),
      subtitleBackgroundPadding: parseSubtitleBackgroundPadding(prefs.subtitleBackgroundPadding),
      subtitleVerticalPosition: parseSubtitleVerticalPosition(prefs.subtitleVerticalPosition),
      subtitleSyncMode: parseSubtitleSyncMode(prefs.subtitleSyncMode),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage failure is non-fatal
  }
}

/**
 * Type guard for preference data shape.
 * All new fields are optional for backwards compatibility with old v1 payloads.
 */
function isValidPreferenceData(value: unknown): value is PlayerPreferenceData {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof obj.volume !== 'number') return false;
  if (typeof obj.playbackRate !== 'number') return false;
  // captionDisplayMode is optional; if present, must be a valid mode string
  if (
    obj.captionDisplayMode !== undefined &&
    !VALID_CAPTION_MODES.includes(obj.captionDisplayMode as CaptionDisplayMode)
  ) {
    return false;
  }
  // subtitleFontSize: optional, if present must be number
  if (obj.subtitleFontSize !== undefined && typeof obj.subtitleFontSize !== 'number') return false;
  // subtitleTextColor: optional, if present must be string
  if (obj.subtitleTextColor !== undefined && typeof obj.subtitleTextColor !== 'string') return false;
  // subtitleBackgroundColor: optional, if present must be string
  if (obj.subtitleBackgroundColor !== undefined && typeof obj.subtitleBackgroundColor !== 'string') return false;
  // subtitleBackgroundPadding: optional, if present must be number
  if (obj.subtitleBackgroundPadding !== undefined && typeof obj.subtitleBackgroundPadding !== 'number') return false;
  // subtitleVerticalPosition: optional, if present must be number
  if (obj.subtitleVerticalPosition !== undefined && typeof obj.subtitleVerticalPosition !== 'number') return false;
  // subtitleSyncMode: optional, if present must be subtitle | audio | auto
  if (
    obj.subtitleSyncMode !== undefined &&
    obj.subtitleSyncMode !== 'subtitle' &&
    obj.subtitleSyncMode !== 'audio' &&
    obj.subtitleSyncMode !== 'auto'
  ) {
    return false;
  }
  return true;
}

/** Clamp volume to [0, 1]. */
function clampVolume(v: number): number {
  if (isNaN(v) || v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Clamp playback rate to the nearest valid value. */
function clampPlaybackRate(r: number): number {
  if (isNaN(r)) return DEFAULT_PLAYBACK_RATE;
  if (VALID_PLAYBACK_RATES.includes(r)) return r;
  // Find nearest valid rate
  let closest = DEFAULT_PLAYBACK_RATE;
  let minDist = Infinity;
  for (const valid of VALID_PLAYBACK_RATES) {
    const dist = Math.abs(r - valid);
    if (dist < minDist) {
      minDist = dist;
      closest = valid;
    }
  }
  return closest;
}

/** Parse captionDisplayMode with fallback to default. */
function parseCaptionDisplayMode(value: unknown): CaptionDisplayMode {
  if (
    typeof value === 'string' &&
    VALID_CAPTION_MODES.includes(value as CaptionDisplayMode)
  ) {
    return value as CaptionDisplayMode;
  }
  return DEFAULT_CAPTION_DISPLAY_MODE;
}

/** Parse subtitleFontSize with fallback to default (clamped to [16, 48]. */
function parseSubtitleFontSize(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const clamped = Math.round(Math.max(16, Math.min(48, value)));
    return clamped;
  }
  return DEFAULT_SUBTITLE_FONT_SIZE;
}

/** Parse subtitleTextColor - repair legacy outside-alpha, then validate oklch, fallback to default. */
function parseSubtitleTextColor(value: unknown): string {
  if (typeof value === 'string') {
    const repaired = repairOklchOutsideAlpha(value.trim());
    if (isValidOklch(repaired)) {
      return repaired;
    }
  }
  return DEFAULT_SUBTITLE_TEXT_COLOR;
}

/** Parse subtitleBackgroundColor - repair legacy outside-alpha, then validate oklch, fallback to default. */
function parseSubtitleBackgroundColor(value: unknown): string {
  if (typeof value === 'string') {
    // Repair malformed legacy outside-alpha format from short-lived broken build
    // "oklch(L% C Hdeg) / alpha" → "oklch(L% C Hdeg / alpha)"
    const repaired = repairOklchOutsideAlpha(value.trim());
    if (isValidOklch(repaired)) {
      return repaired;
    }
  }
  return DEFAULT_SUBTITLE_BACKGROUND_COLOR;
}

/** Parse subtitleBackgroundPadding with fallback to default, clamped to [0, 32]. */
function parseSubtitleBackgroundPadding(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(32, Math.round(value)));
  }
  return DEFAULT_SUBTITLE_BACKGROUND_PADDING;
}

/** Parse subtitleVerticalPosition with fallback to default, clamped to [0, 200]. */
function parseSubtitleVerticalPosition(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(200, Math.round(value)));
  }
  return DEFAULT_SUBTITLE_VERTICAL_POSITION;
}

/** Sync mode (subtitle | audio | auto); anything else falls back to subtitle. */
function parseSubtitleSyncMode(value: unknown): SubtitleSyncMode {
  return value === 'audio' || value === 'auto' ? value : DEFAULT_SUBTITLE_SYNC_MODE;
}

/**
 * Repair a malformed oklch string where alpha is OUTSIDE the closing parenthesis:
 *   "oklch(L% C Hdeg) / alpha" → "oklch(L% C Hdeg / alpha)"
 * Returns the original string if no outside-alpha pattern is found.
 */
function repairOklchOutsideAlpha(value: string): string {
  const match = value.match(/^oklch\(([^)]+)\)\s*\/\s*([\d.]+)%?\s*$/);
  if (match && match[1] && match[2]) {
    return `oklch(${match[1]} / ${match[2]})`;
  }
  return value;
}

/** Basic validation that a string is a canonical oklch(...) color. */
function isValidOklch(value: string): boolean {
  // Use RegExp constructor to avoid OXC parse issues with regex literal escapes.
  // Tightened: numeric components use \d+(\.\d+)? to reject malformed decimals
  // like "1.2.3". Each component is a non-negative integer or decimal.
  const num = String.raw`\d+(?:\.\d+)?`;
  const angle = String.raw`(?:deg|rad|turn)`;
  const oklchPattern = String.raw`^oklch\(\s*${num}%?\s+${num}\s+${num}${angle}?\s*(?:/\s*${num}%?)?\s*\)$`;
  const oklchRegex = new RegExp(oklchPattern, 'i');
  return oklchRegex.test(value.trim());
}
