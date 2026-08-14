// SPDX-License-Identifier: Apache-2.0
//
// Decodes a media file to mono 16 kHz f32 PCM for subomatic sub-to-audio
// sync (stage 2a). User-confirmed target: mono + 16 kHz downsampled.

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

const TARGET_SAMPLE_RATE = 16_000;

/**
 * Linear-interpolation downsample of a mono f32 buffer to targetRate.
 * Pure function (no Web Audio dependency) so it can be unit-tested.
 * Subomatic's app.js downsample pattern (1-slice ratio + lerp) is followed.
 */
export function downsampleMono(
  mono: Float32Array,
  sourceRate: number,
  targetRate = TARGET_SAMPLE_RATE,
): Float32Array {
  if (sourceRate <= 0 || mono.length === 0) {
    return new Float32Array(0);
  }
  if (sourceRate === targetRate) {
    return mono.slice();
  }
  const ratio = sourceRate / targetRate;
  const outLen = Math.max(1, Math.floor(mono.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    // idx is always in range, but this TS config treats Float32Array index
    // reads as possibly undefined; the ?? 0 is therefore only to satisfy
    // the type system (idx+1 below is the real out-of-range guard).
    const a = mono[idx] ?? 0;
    const b = mono[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Decode a media ArrayBuffer to mono 16 kHz f32 PCM via Web Audio API.
 * All channels are averaged, then downsampled to 16 kHz. The AudioContext
 * is closed when done (or on error).
 */
export async function decodeToMono16k(
  arrayBuffer: ArrayBuffer,
): Promise<DecodedAudio> {
  if (typeof AudioContext === 'undefined') {
    throw new Error('Web Audio API is not supported in this browser');
  }
  const ctx = new AudioContext();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    if (!audioBuffer) {
      throw new Error('decodeAudioData returned no buffer');
    }
    const { numberOfChannels, length, sampleRate } = audioBuffer;
    const mono = new Float32Array(length);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      if (!data) continue;
      for (let i = 0; i < length; i++) {
        const v = data[i] ?? 0;
        const cur = mono[i] ?? 0;
        mono[i] = cur + v / numberOfChannels;
      }
    }
    const samples = downsampleMono(mono, sampleRate, TARGET_SAMPLE_RATE);
    return { samples, sampleRate: TARGET_SAMPLE_RATE };
  } finally {
    await ctx.close().catch(() => {
      // Best-effort release; an already-closed context rejects harmlessly.
    });
  }
}
