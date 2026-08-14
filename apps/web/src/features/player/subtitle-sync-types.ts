// SPDX-License-Identifier: Apache-2.0
// Types shared between the subtitle-sync client helper and the subomatic
// worker (which itself is plain JS served from public/). Kept in src/ so the
// client never imports across the public/ boundary.

export type SubtitleSyncMode = 'audio' | 'reference';

export interface SubtitleSyncJob {
  mode: SubtitleSyncMode;
  subText: string;
  subFormat: string;
  /** audio mode */
  samples?: Float32Array;
  sampleRate?: number;
  /** reference mode */
  refText?: string;
  refFormat?: string;
  fps?: number;
  outFormat?: string;
  /** "energy" (fast) or "" / "earshot" (accurate, default) */
  vad?: string;
}

export interface SubtitleSyncProgress {
  type: 'progress';
  stage: string;
  fraction: number;
}

export interface SubtitleSyncDone {
  type: 'done';
  result: string;
}

export interface SubtitleSyncError {
  type: 'error';
  message: string;
}

export type SubtitleSyncWorkerMessage =
  | SubtitleSyncProgress
  | SubtitleSyncDone
  | SubtitleSyncError;
