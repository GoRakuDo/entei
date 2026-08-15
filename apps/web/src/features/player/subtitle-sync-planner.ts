// SPDX-License-Identifier: Apache-2.0
//
// Decides which subomatic sync mode to run for a given source + setting
// combination (pure logic, easily testable). See docs/SUBTITLE_SYNC.md §2.

export type SyncSettingMode = 'subtitle' | 'audio' | 'auto';

export type SourceKind = 'youtube' | 'local' | 'magnet';

export type SyncPlan =
  | { kind: 'skip-youtube' }
  | { kind: 'sub-to-sub'; refText: string; refFormat: string }
  | { kind: 'sub-to-sub-auto-ref' }
  | { kind: 'sub-to-audio-local' }
  | { kind: 'sub-to-audio-magnet' }
  | { kind: 'no-reference-subtitle' };

/**
 * Decision table (§2 7-12):
 * - youtube → skip (never sync)
 * - subtitle mode → sub-to-sub if a reference subtitle exists; on Magnet,
 *   sub-to-sub-auto-ref (the torrent's embedded subtitle is auto-detected
 *   and fetched as the reference); otherwise no-reference-subtitle
 * - audio mode → sub-to-audio (local / magnet variant)
 * - auto → reference subtitle first, else fall back to sub-to-audio
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
      // Magnet: the companion can auto-detect the torrent's embedded
      // subtitle (no manual subtitle pick needed) and serve it as the
      // sub-to-sub reference.
      return source === 'magnet'
        ? { kind: 'sub-to-sub-auto-ref' }
        : { kind: 'no-reference-subtitle' };
    case 'audio':
      return source === 'local'
        ? { kind: 'sub-to-audio-local' }
        : { kind: 'sub-to-audio-magnet' };
    case 'auto':
      if (hasReferenceSubtitle) {
        return { kind: 'sub-to-sub', refText: '', refFormat: '' };
      }
      return source === 'local'
        ? { kind: 'sub-to-audio-local' }
        : { kind: 'sub-to-audio-magnet' };
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
