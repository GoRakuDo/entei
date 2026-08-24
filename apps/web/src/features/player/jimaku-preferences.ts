/**
 * jimaku-preferences — jimaku.cc auto-load preferences.
 * ---------------------------------------------------------------------------
 * Persisted in localStorage under `entei.jimaku.v1` (design: docs/JIMAKU_SUBS.md
 * §2.1). Stores the API key (read-only usage), the auto-load Switch, the
 * no-key toast counter (max 7), and the anime/drama search toggle.
 *
 * Privacy: the API key is kept in localStorage only — never logged, never put
 * into URLs or error surfaces (design §9).
 * ---------------------------------------------------------------------------
 */

export interface JimakuPreferences {
  apiKey: string;
  autoLoadEnabled: boolean;
  toastCount: number;
  searchAnime: boolean;
}

export const JIMAKU_PREFS_KEY = 'entei.jimaku.v1';

/** Max number of "set your API key" toasts before going silent (design §2.2.6). */
export const JIMAKU_TOAST_MAX = 7;

export const DEFAULT_JIMAKU_PREFERENCES: JimakuPreferences = {
  apiKey: '',
  autoLoadEnabled: true,
  toastCount: 0,
  searchAnime: true,
};

function isJimakuPreferences(value: unknown): value is JimakuPreferences {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.apiKey !== 'string') return false;
  if (typeof v.autoLoadEnabled !== 'boolean') return false;
  if (typeof v.toastCount !== 'number' || !Number.isFinite(v.toastCount)) return false;
  if (typeof v.searchAnime !== 'boolean') return false;
  return true;
}

/** Read the persisted preferences; falls back to defaults on any failure. */
export function readJimakuPreferences(): JimakuPreferences {
  try {
    const raw = localStorage.getItem(JIMAKU_PREFS_KEY);
    if (raw === null) return { ...DEFAULT_JIMAKU_PREFERENCES };
    const parsed = JSON.parse(raw) as unknown;
    if (!isJimakuPreferences(parsed)) return { ...DEFAULT_JIMAKU_PREFERENCES };
    return parsed;
  } catch {
    return { ...DEFAULT_JIMAKU_PREFERENCES }; // storage unavailable or corrupted
  }
}

/** Persist the preferences. Failures are silently ignored (preference only). */
export function writeJimakuPreferences(data: JimakuPreferences): void {
  try {
    localStorage.setItem(JIMAKU_PREFS_KEY, JSON.stringify(data));
  } catch {
    // storage unavailable — ignore (preference only)
  }
}

/** Set just the API key (read-only jimaku usage). */
export function setJimakuApiKey(apiKey: string): JimakuPreferences {
  const next = { ...readJimakuPreferences(), apiKey };
  writeJimakuPreferences(next);
  return next;
}

/** Toggle the auto-load Switch. */
export function setJimakuAutoLoad(enabled: boolean): JimakuPreferences {
  const next = { ...readJimakuPreferences(), autoLoadEnabled: enabled };
  writeJimakuPreferences(next);
  return next;
}

/** Toggle the anime/drama search mode (defaults to anime). */
export function setJimakuSearchAnime(anime: boolean): JimakuPreferences {
  const next = { ...readJimakuPreferences(), searchAnime: anime };
  writeJimakuPreferences(next);
  return next;
}

/**
 * Increment the no-key toast counter (capped at JIMAKU_TOAST_MAX).
 * Returns the new count so the caller can decide whether to toast.
 */
export function incrementJimakuToastCount(): number {
  const prefs = readJimakuPreferences();
  const toastCount = Math.min(prefs.toastCount + 1, JIMAKU_TOAST_MAX);
  writeJimakuPreferences({ ...prefs, toastCount });
  return toastCount;
}

/** Whether the no-key toast should still be shown (< max). */
export function shouldShowJimakuToast(): boolean {
  return readJimakuPreferences().toastCount < JIMAKU_TOAST_MAX;
}
