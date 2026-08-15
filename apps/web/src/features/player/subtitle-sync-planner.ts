// SPDX-License-Identifier: Apache-2.0
//
// Decides which subomatic sync mode to run for a given source + setting
// combination (pure logic, easily testable). See docs/SUBTITLE_SYNC.md §2.

export type SyncSettingMode = 'subtitle' | 'audio' | 'auto';

export type SourceKind = 'youtube' | 'local' | 'magnet';

export type SyncPlan =
  | { kind: 'skip-youtube' }
  | { kind: 'sub-to-sub'; refText: string; refFormat: string }
  /** Magnet embedded-subtitle reference. In auto mode (fallbackToAudio)
   *  a missing embedded subtitle falls back to sub-to-audio. */
  | { kind: 'sub-to-sub-auto-ref'; fallbackToAudio?: boolean }
  | { kind: 'sub-to-audio-local' }
  | { kind: 'sub-to-audio-magnet' }
  /**
   * Retired — no planner path produces this anymore (local files are
   * covered by mkvgo via sub-to-sub-auto-ref). Kept only for defensive
   * narrowing in callers.
   */
  | { kind: 'no-reference-subtitle' };

/**
 * Decision table (§2 7-12):
 * - youtube → skip (never sync)
 * - subtitle mode → sub-to-sub if a reference subtitle exists; otherwise
 *   sub-to-sub-auto-ref (the embedded subtitle is auto-detected and used as
 *   the reference — Magnet via the companion, local files via mkvgo)
 * - audio mode → sub-to-audio (local / magnet variant)
 * - auto → reference subtitle first; otherwise the embedded subtitle as
 *   the reference (sub-to-sub-auto-ref, local + magnet alike), falling
 *   back to sub-to-audio when no embedded subtitle exists
 */
export function planSync(
  mode: SyncSettingMode,
  source: SourceKind,
  hasReferenceSubtitle: boolean,
): SyncPlan {
  if (source === 'youtube') {
    return { kind: 'skip-youtube' };
  }
  switch (mode) {
    case 'subtitle':
      if (hasReferenceSubtitle) {
        return { kind: 'sub-to-sub', refText: '', refFormat: '' };
      }
      // Embedded-subtitle reference without a manual pick: Magnet via the
      // companion, local files via mkvgo (both run at sync time).
      return { kind: 'sub-to-sub-auto-ref' };
    case 'audio':
      return source === 'local'
        ? { kind: 'sub-to-audio-local' }
        : { kind: 'sub-to-audio-magnet' };
    case 'auto':
      if (hasReferenceSubtitle) {
        return { kind: 'sub-to-sub', refText: '', refFormat: '' };
      }
      // Embedded-subtitle reference first (subtitle sync is more accurate
      // than audio); fall back to audio when no embedded subtitle exists.
      // Local and magnet both take this path — the runtime source decides
      // how the reference is fetched and how the audio fallback runs.
      return { kind: 'sub-to-sub-auto-ref', fallbackToAudio: true };
    default: {
      // Exhaustive: forces a type error if SyncSettingMode grows a new value.
      const _exhaustive: never = mode;
      return _exhaustive as never;
    }
  }
}

/**
 * Maps a job session to the source kind the planner works with:
 * youtube → 'youtube', torrent → 'magnet', everything else (local file)
 * → 'local'. A subtitle is only syncable when media is present, so a
 * missing job with local media still counts as 'local'.
 */
export function detectSourceKind(
  jobKind: 'youtube' | 'torrent' | null,
  hasLocalMedia: boolean,
): SourceKind {
  if (jobKind === 'youtube') return 'youtube';
  if (jobKind === 'torrent') return 'magnet';
  // No companion session → local media (subtitles imply media is loaded).
  void hasLocalMedia;
  return 'local';
}
