/** Persisted YouTube stream quality-strategy preference (quality or speed). */
export type YtDownloadMode = 'quality' | 'speed';

export const YT_MODE_KEY = 'entei.youtube.stream-mode.v1';

const VALID_MODES: readonly YtDownloadMode[] = ['quality', 'speed'];

export const DEFAULT_YT_MODE: YtDownloadMode = 'speed';

/** Read the persisted mode; fall back to speed on failure. */
export function readYtDownloadMode(): YtDownloadMode {
  try {
    const raw = localStorage.getItem(YT_MODE_KEY);
    if (raw === null) return DEFAULT_YT_MODE;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'string' &&
      (VALID_MODES as readonly string[]).includes(parsed)
    ) {
      return parsed as YtDownloadMode;
    }
    return DEFAULT_YT_MODE;
  } catch {
    return DEFAULT_YT_MODE;
  }
}

/** Persist the mode. Storage failures leave the preference unchanged. */
export function writeYtDownloadMode(mode: YtDownloadMode): void {
  try {
    localStorage.setItem(YT_MODE_KEY, JSON.stringify(mode));
  } catch {
    // The preference is optional when storage is unavailable.
  }
}
