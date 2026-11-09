// SPDX-License-Identifier: Apache-2.0
// Pure-logic tests for the subtitle sync source/mode matrix and PCM downsampling.

import { describe, expect, it } from 'bun:test';
import {
  planSync,
  type SourceKind,
  type SyncSettingMode,
} from '../src/features/player/subtitle-sync-planner';
import { downsampleMono } from '../src/features/player/audio-decoder';

describe('planSync', () => {
  const sources: SourceKind[] = ['youtube', 'local', 'magnet'];
  const modes: SyncSettingMode[] = ['subtitle', 'audio', 'auto'];

  it('always skips YouTube', () => {
    for (const mode of modes) {
      for (const hasReference of [false, true]) {
        expect(planSync(mode, 'youtube', hasReference)).toEqual({ kind: 'skip-youtube' });
      }
    }
  });

  it('uses a selected reference subtitle in subtitle and auto modes', () => {
    expect(planSync('subtitle', 'local', true)).toEqual({ kind: 'sub-to-sub', refText: '', refFormat: '' });
    expect(planSync('auto', 'local', true)).toEqual({ kind: 'sub-to-sub', refText: '', refFormat: '' });
    expect(planSync('subtitle', 'magnet', true)).toEqual({ kind: 'sub-to-sub', refText: '', refFormat: '' });
    expect(planSync('auto', 'magnet', true)).toEqual({ kind: 'sub-to-sub', refText: '', refFormat: '' });
  });

  it('requires a selected reference in subtitle mode', () => {
    expect(planSync('subtitle', 'local', false)).toEqual({ kind: 'no-reference-subtitle' });
    expect(planSync('subtitle', 'magnet', false)).toEqual({ kind: 'no-reference-subtitle' });
  });

  it('allows audio sync only for local media', () => {
    expect(planSync('audio', 'local', false)).toEqual({ kind: 'sub-to-audio-local' });
    expect(planSync('audio', 'local', true)).toEqual({ kind: 'sub-to-audio-local' });
    expect(planSync('audio', 'magnet', false)).toEqual({ kind: 'sub-to-audio-magnet' });
    expect(planSync('audio', 'magnet', true)).toEqual({ kind: 'sub-to-audio-magnet' });
  });

  it('auto mode falls back to local audio but never downloads magnet PCM', () => {
    expect(planSync('auto', 'local', false)).toEqual({ kind: 'sub-to-audio-local' });
    expect(planSync('auto', 'magnet', false)).toEqual({ kind: 'no-reference-subtitle' });
  });

  it('exhausts the source/mode/reference matrix without unexpected plans', () => {
    const plans = new Set<string>();
    for (const mode of modes) {
      for (const source of sources) {
        for (const hasReference of [false, true]) {
          plans.add(planSync(mode, source, hasReference).kind);
        }
      }
    }
    expect([...plans].sort()).toEqual([
      'no-reference-subtitle',
      'skip-youtube',
      'sub-to-audio-local',
      'sub-to-audio-magnet',
      'sub-to-sub',
    ]);
  });
});

describe('downsampleMono', () => {
  it('returns empty when input is empty or rate is invalid', () => {
    expect(downsampleMono(new Float32Array(0), 44100).length).toBe(0);
    expect(downsampleMono(new Float32Array([1, 2]), 0).length).toBe(0);
  });

  it('keeps same-rate input unchanged', () => {
    const mono = new Float32Array([0, 0.5, 1, 0.5]);
    expect(Array.from(downsampleMono(mono, 16000, 16000))).toEqual([0, 0.5, 1, 0.5]);
  });

  it('downsamples 48 kHz to 16 kHz with the expected length and amplitude', () => {
    const mono = new Float32Array(48).fill(1);
    const out = downsampleMono(mono, 48000, 16000);
    expect(out).toHaveLength(16);
    expect(out.every((value) => Math.abs(value - 1) < 1e-6)).toBe(true);
  });

  it('interpolates fractional sample positions', () => {
    const out = downsampleMono(new Float32Array([0, 1, 0]), 3000, 2000);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(0.5);
  });
});
