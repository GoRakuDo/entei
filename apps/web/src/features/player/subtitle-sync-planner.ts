// SPDX-License-Identifier: Apache-2.0
//
// Chooses the subtitle sync path for a source and user preference.

export type SyncSettingMode = 'subtitle' | 'audio' | 'auto';
export type SourceKind = 'youtube' | 'local' | 'magnet';

export type SyncPlan =
  | { kind: 'skip-youtube' }
  | { kind: 'sub-to-sub'; refText: string; refFormat: string }
  | { kind: 'sub-to-audio-local' }
  | { kind: 'sub-to-audio-magnet' }
  | { kind: 'no-reference-subtitle' };

/**
 * Choose the source-compatible sync path; torrent audio extraction is not
 * provided by the local-only native player.
 */
export function planSync(
  mode: SyncSettingMode,
  source: SourceKind,
  hasReferenceSubtitle: boolean,
): SyncPlan {
  if (source === 'youtube') return { kind: 'skip-youtube' };
  if (mode === 'audio') {
    return source === 'magnet'
      ? { kind: 'sub-to-audio-magnet' }
      : { kind: 'sub-to-audio-local' };
  }
  if (hasReferenceSubtitle) {
    return { kind: 'sub-to-sub', refText: '', refFormat: '' };
  }
  if (mode === 'subtitle' || source === 'magnet') {
    return { kind: 'no-reference-subtitle' };
  }
  return { kind: 'sub-to-audio-local' };
}
