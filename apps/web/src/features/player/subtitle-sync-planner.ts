// SPDX-License-Identifier: Apache-2.0
//
// Decides which subomatic sync mode to run for a given source + setting
// combination (pure logic, easily testable). See docs/SUBTITLE_SYNC.md §2.

export type SyncSettingMode = 'subtitle' | 'audio' | 'auto';

export type SourceKind = 'youtube' | 'local' | 'magnet';

export type SyncPlan =
  | { kind: 'skip-youtube' }
  | { kind: 'sub-to-sub'; refText: string; refFormat: string }
  | { kind: 'sub-to-audio-local' }
  | { kind: 'sub-to-audio-magnet' }
  | { kind: 'no-reference-subtitle' };

/**
 * Decision table (§2 7-12):
 * - youtube → skip (never sync)
 * - subtitle mode → sub-to-sub if a reference subtitle exists, else
 *   no-reference-subtitle (toast: nothing to sync against)
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
      return hasReferenceSubtitle
        ? { kind: 'sub-to-sub', refText: '', refFormat: '' }
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
