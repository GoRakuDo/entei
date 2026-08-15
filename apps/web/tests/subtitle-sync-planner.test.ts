// SPDX-License-Identifier: Apache-2.0
// Pure-logic tests for planSync (mode × source × reference-subtitle matrix)
// and the mono downsample helper.

import { describe, expect, it } from 'vitest';
import {
  detectSourceKind,
  planSync,
  type SourceKind,
  type SyncSettingMode,
} from '../src/features/player/subtitle-sync-planner';
import { downsampleMono } from '../src/features/player/audio-decoder';

describe('planSync', () => {
  const sources: SourceKind[] = ['youtube', 'local', 'magnet'];
  const modes: SyncSettingMode[] = ['subtitle', 'audio', 'auto'];

  it('always skips youtube regardless of mode / reference', () => {
    for (const mode of modes) {
      for (const ref of [false, true]) {
        expect(planSync(mode, 'youtube', ref)).toEqual({ kind: 'skip-youtube' });
      }
    }
  });

  it('subtitle mode: sub-to-sub when reference exists', () => {
    expect(planSync('subtitle', 'local', true)).toEqual({
      kind: 'sub-to-sub',
      refText: '',
      refFormat: '',
    });
    expect(planSync('subtitle', 'magnet', true)).toEqual({
      kind: 'sub-to-sub',
      refText: '',
      refFormat: '',
    });
  });

  it('subtitle mode: auto-ref on magnet, no-reference on local when none exists', () => {
    expect(planSync('subtitle', 'local', false)).toEqual({
      kind: 'no-reference-subtitle',
    });
    expect(planSync('subtitle', 'magnet', false)).toEqual({
      kind: 'sub-to-sub-auto-ref',
    });
  });

  it('audio mode: sub-to-audio-local for local', () => {
    for (const ref of [false, true]) {
      expect(planSync('audio', 'local', ref)).toEqual({
        kind: 'sub-to-audio-local',
      });
    }
  });

  it('audio mode: sub-to-audio-magnet for magnet', () => {
    for (const ref of [false, true]) {
      expect(planSync('audio', 'magnet', ref)).toEqual({
        kind: 'sub-to-audio-magnet',
      });
    }
  });

  it('auto: reference subtitle takes priority', () => {
    expect(planSync('auto', 'local', true)).toEqual({
      kind: 'sub-to-sub',
      refText: '',
      refFormat: '',
    });
    expect(planSync('auto', 'magnet', true)).toEqual({
      kind: 'sub-to-sub',
      refText: '',
      refFormat: '',
    });
  });

  it('auto without reference: embedded subtitle on magnet, audio on local', () => {
    expect(planSync('auto', 'local', false)).toEqual({
      kind: 'sub-to-audio-local',
    });
    expect(planSync('auto', 'magnet', false)).toEqual({
      kind: 'sub-to-sub-auto-ref',
      fallbackToAudio: true,
    });
  });

  it('exhausts the full mode × source × ref matrix (no unexpected plans)', () => {
    // 3 × 3 × 2 = 18 combos; youtube always skip, so 12 non-youtube combos.
    const plans = new Set<string>();
    for (const mode of modes) {
      for (const source of sources) {
        for (const ref of [false, true]) {
          plans.add(planSync(mode, source, ref).kind);
        }
      }
    }
    expect(plans.size).toBeGreaterThanOrEqual(5);
    expect(plans.has('skip-youtube')).toBe(true);
    expect(plans.has('sub-to-audio-local')).toBe(true);
    expect(plans.has('sub-to-audio-magnet')).toBe(true);
    expect(plans.has('sub-to-sub')).toBe(true);
    expect(plans.has('sub-to-sub-auto-ref')).toBe(true);
    expect(plans.has('no-reference-subtitle')).toBe(true);
  });
});

describe('detectSourceKind', () => {
  it('maps job kinds to source kinds', () => {
    expect(detectSourceKind('youtube', false)).toBe('youtube');
    expect(detectSourceKind('torrent', false)).toBe('magnet');
  });

  it('falls back to local when no companion job is active', () => {
    expect(detectSourceKind(null, true)).toBe('local');
    expect(detectSourceKind(null, false)).toBe('local');
  });
});

describe('downsampleMono', () => {
  it('returns empty when input is empty or rate is invalid', () => {
    expect(downsampleMono(new Float32Array(0), 44100).length).toBe(0);
    expect(downsampleMono(new Float32Array([1, 2]), 0).length).toBe(0);
  });

  it('keeps same-rate input unchanged', () => {
    const mono = new Float32Array([0, 0.5, 1, 0.5]);
    const out = downsampleMono(mono, 16000, 16000);
    expect(Array.from(out)).toEqual([0, 0.5, 1, 0.5]);
  });

  it('downsamples 48kHz → 16kHz with the expected length', () => {
    // 48 samples at 48 kHz == 16 samples at 16 kHz.
    const mono = new Float32Array(48).fill(1);
    const out = downsampleMono(mono, 48000, 16000);
    expect(out.length).toBe(16);
    // Constant signal survives lerp without distortion.
    expect(out.every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
  });

  it('interpolates between samples (lerp)', () => {
    // Ratio 2: pos = i*2, frac always 0, so samples are picked directly.
    const mono = new Float32Array([0, 1, 0, 1, 0, 1]);
    const out = downsampleMono(mono, 6000, 3000);
    expect(out.length).toBe(3);
    expect(out[0]).toBeCloseTo(0); // pos 0 -> mono[0]
    expect(out[1]).toBeCloseTo(0); // pos 2 -> mono[2]
    expect(out[2]).toBeCloseTo(0); // pos 4 -> mono[4]
  });

  it('interpolates with a fractional step', () => {
    // Ratio 1.5: pos = i*1.5; i=1 -> pos 1.5 (midpoint of mono[1]=1, mono[2]=0).
    const mono = new Float32Array([0, 1, 0]);
    const out = downsampleMono(mono, 3000, 2000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0); // pos 0 -> mono[0]
    expect(out[1]).toBeCloseTo(0.5); // pos 1.5 -> lerp(1, 0, 0.5)
  });
});
