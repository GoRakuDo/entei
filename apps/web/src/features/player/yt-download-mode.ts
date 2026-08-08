/**
 * yt-download-mode — YouTube download mode preference (ED-2F Quality/Speed).
 * ---------------------------------------------------------------------------
 * Persisted in localStorage under `entei.eizou.yt-mode.v1` (documented in
 * docs/EIZOU_DENDENSHI.md "YouTube 再生モード設定"). Default: speed
 * (instant-playback first; changed from quality on 2026-08-08 per user).
 *
 * Privacy: stores only the mode string, never the URL, cookie, or job id.
 * ---------------------------------------------------------------------------
 */

/** Download strategy for YouTube jobs. */
export type YtDownloadMode = 'quality' | 'speed';

export const YT_MODE_KEY = 'entei.eizou.yt-mode.v1';

const VALID_MODES: readonly YtDownloadMode[] = ['quality', 'speed'];

export const DEFAULT_YT_MODE: YtDownloadMode = 'speed';

/** Read the persisted mode; falls back to speed on any failure. */
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
    return DEFAULT_YT_MODE; // storage unavailable or corrupted — safe default
  }
}

/** Persist the mode. Failures are silently ignored (preference only). */
export function writeYtDownloadMode(mode: YtDownloadMode): void {
  try {
    localStorage.setItem(YT_MODE_KEY, JSON.stringify(mode));
  } catch {
    // storage unavailable — preference just won't persist
  }
}
