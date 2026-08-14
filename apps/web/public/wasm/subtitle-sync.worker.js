// SPDX-License-Identifier: Apache-2.0
//
// Worker that runs the subomatic WASM sync off the main thread, so the page
// stays responsive and a progress bar can animate while the (synchronous,
// possibly multi-second) alignment runs. Audio is decoded on the main thread
// (the Web Audio API isn't available in workers) and the PCM is transferred
// here. Custom build: the subomatic credit cue is removed (see
// vendor/subomatic/crates/subomatic-wasm/src/lib.rs).
//
// This file is served raw from Astro's public/ (no bundler transform), so it
// must stay plain JavaScript. The job shape is documented in
// src/features/player/subtitle-sync-types.ts.

// The wasm JS lives in Astro's public/ (served at /wasm/), so it cannot be a
// static import. Dynamic import at runtime fetches the published asset; the
// Vite ignore comment keeps the bundler from attempting to resolve the
// absolute URL at build time.
let wasmPromise = null;

function loadWasm() {
  if (!wasmPromise) {
    // The wasm JS exposes the wrapper functions (sync_to_audio /
    // sync_to_reference) as top-level exports AND a default init
    // (__wbg_init). We must run the init first (it creates the WASM
    // instance), then use the top-level wrapper exports — NOT the raw
    // instance exports returned by default(), which are native functions
    // that bypass the argument/return encoding (causing array-shaped
    // garbage instead of strings).
    wasmPromise = import(/* @vite-ignore */ '/wasm/subomatic_wasm.js').then(
      async (m) => {
        if (typeof m.default === 'function') {
          await m.default();
        } else {
          throw new Error(
            'subomatic_wasm.js: default export is not a function — WASM init failed',
          );
        }
        return m;
      },
    );
  }
  return wasmPromise;
}

self.onmessage = async (event) => {
  const job = event.data;
  try {
    const wasm = await loadWasm();
    // Forwarded to Rust as `on_progress(stage, fraction)`; relay each tick to
    // the page. Rust already throttles these to ~1% steps per phase.
    const onProgress = (stage, fraction) => {
      self.postMessage({ type: 'progress', stage, fraction });
    };

    // `outFormat` is an extension string ("srt"/"vtt"/"sub"/"ass"); "" keeps
    // the input's format. `vad` is "energy" (fast) or "" / "earshot".
    const outFormat = job.outFormat ?? '';
    const vad = job.vad ?? '';
    // SRT/VTT/ASS don't depend on fps, but the Rust engine validates it
    // (check_fps) and rejects 0 ("fps must be positive and finite, got 0").
    // 25 is the general-purpose default when the caller doesn't supply one.
    const fps = job.fps ?? 25;
    let result;
    if (job.mode === 'audio') {
      // Use the transferred buffer directly (zero-copy); no copy of the
      // PCM that the main thread transferred via postMessage transfer list.
      const samples = job.samples ?? new Float32Array(0);
      result = wasm.sync_to_audio(
        job.subText,
        job.subFormat,
        samples,
        job.sampleRate ?? 0,
        fps,
        outFormat,
        vad,
        onProgress,
      );
    } else {
      result = wasm.sync_to_reference(
        job.subText,
        job.subFormat,
        job.refText ?? '',
        job.refFormat ?? '',
        fps,
        outFormat,
        onProgress,
      );
    }
    self.postMessage({ type: 'done', result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: String(error?.message ?? error),
    });
  }
};
