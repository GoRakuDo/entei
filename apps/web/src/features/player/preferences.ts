/**
 * Player Preferences — Volume, Playback Rate, and Caption Display Mode
 * ---------------------------------------------------------------------------
 * P1 scope: only safe UI preferences in localStorage.
 * - volume (0–1, number)
 * - playbackRate (0.25–2, number)
 * - captionDisplayMode ('visible' | 'blurred' | 'hidden')
 *
 * Design:
 * - Typed with schema version for future migration.
 * - Exception-safe: never throws to caller; returns defaults on any failure.
 * - Validates ranges before persisting.
 * - Never stores File, path, blob URL, subtitle, or media data.
 * - Backwards-compatible: old v1 payloads without captionDisplayMode read as 'visible'.
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

/** Persisted player preference shape (v1, extended with optional captionDisplayMode). */
interface PlayerPreferenceData {
  schemaVersion: number;
  volume: number;
  playbackRate: number;
  captionDisplayMode?: CaptionDisplayMode;
}

/** Public interface. */
export interface PlayerPreferences {
  volume: number;
  playbackRate: number;
  captionDisplayMode: CaptionDisplayMode;
}

/**
 * Read player preferences from localStorage.
 * Returns defaults if absent, corrupted, or if localStorage throws.
 * Old v1 payloads without captionDisplayMode default to 'visible'.
 */
export function readPlayerPreferences(): PlayerPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return {
        volume: DEFAULT_VOLUME,
        playbackRate: DEFAULT_PLAYBACK_RATE,
        captionDisplayMode: DEFAULT_CAPTION_DISPLAY_MODE,
      };
    }

    const parsed: unknown = JSON.parse(raw);

    if (!isValidPreferenceData(parsed)) {
      return {
        volume: DEFAULT_VOLUME,
        playbackRate: DEFAULT_PLAYBACK_RATE,
        captionDisplayMode: DEFAULT_CAPTION_DISPLAY_MODE,
      };
    }

    return {
      volume: clampVolume(parsed.volume),
      playbackRate: clampPlaybackRate(parsed.playbackRate),
      captionDisplayMode: parseCaptionDisplayMode(parsed.captionDisplayMode),
    };
  } catch {
    // localStorage unavailable or JSON corrupted
    return {
      volume: DEFAULT_VOLUME,
      playbackRate: DEFAULT_PLAYBACK_RATE,
      captionDisplayMode: DEFAULT_CAPTION_DISPLAY_MODE,
    };
  }
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
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage failure is non-fatal
  }
}

/**
 * Type guard for preference data shape.
 * captionDisplayMode is optional for backwards compatibility with old v1 payloads.
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
