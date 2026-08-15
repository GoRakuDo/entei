// SPDX-License-Identifier: MIT
// Adapted from gravity-zero/mkvgo (MIT) — web/mkvgo.ts + web/react.ts.
//
// Typed wrapper around the mkvgo WebAssembly build. The wasm module (built
// with `make wasm` → dist/wasm/mkvgo.wasm + wasm_exec.js) registers a global
// `MkvGo` object; this wrapper loads it once and exposes the subset Entei
// needs: probe() (head-only metadata, any file size via ranged Blob reads)
// and extractSubtitleVTT() (embedded MKV/MP4 subtitle tracks as WebVTT).
//
// The wasm files live in public/wasm/ (mkvgo.wasm + wasm_exec.js) and are
// served statically; loadMkvGo is idempotent so the module loads at most once.
// Zero runtime dependencies beyond react (for the useMkvGo convenience hook).

import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Result types — property names mirror the JSON the Go side emits (the same
// `json:` tags the CLI's -json output uses, so shapes are interchangeable).
// ---------------------------------------------------------------------------

export type TrackType = 'video' | 'audio' | 'subtitle';

/** One media track. Optional fields are omitted when absent, like the CLI JSON. */
export interface Track {
  id: number;
  type: TrackType;
  codec: string;
  language?: string;
  language_bcp47?: string;
  name?: string;
  is_default: boolean;
  is_forced: boolean;
  width?: number;
  height?: number;
  display_width?: number;
  display_height?: number;
  channels?: number;
  sample_rate?: number;
  output_sample_rate?: number;
  bit_depth?: number;
  video_bit_depth?: number;
  codec_delay?: number;
  seek_pre_roll?: number;
  frame_rate?: number;
  frame_count?: number;
  duration_ms?: number;
  bitrate?: number;
  profile?: string;
  level?: number;
  pixel_format?: string;
  field_order?: string;
  rotation?: number;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_range?: string;
  hdr?: unknown;
  dolby_vision?: unknown;
  /** Derived display fields (same as the CLI -json output). */
  codec_long_name?: string;
  channel_layout?: string;
  avg_frame_rate?: number;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  /** Colour code points as the conventional prober strings (e.g. "bt2020nc", "smpte2084"). */
  color_space_name?: string;
  color_transfer_name?: string;
  color_primaries_name?: string;
  color_range_name?: string;
  /**
   * One-word dynamic-range classification: "dolby-vision" | "hdr10" | "hlg" |
   * "sdr"; absent when unknown or not video.
   */
  hdr_format?: string;
  stereo_mode_name?: string;
  /** The track's effective language (BCP-47 when present, else the legacy tag). */
  resolved_language?: string;
  /** Remaining probe fields; see the mkvgo library Track reference. */
  [key: string]: unknown;
}

export interface Chapter {
  id: number;
  title: string;
  start_ms: number;
  end_ms: number;
  sub_chapters?: Chapter[];
  [key: string]: unknown;
}

export interface ProbeResult {
  /** Sniffed container: 'mkv' covers Matroska/WebM, 'mp4' covers MP4/MOV. */
  format: 'mkv' | 'mp4';
  info: { title: string; muxing_app: string; writing_app: string; [key: string]: unknown };
  duration_ms: number;
  tracks: Track[];
  chapters: Chapter[];
  attachments: { id: number; name: string; mime_type: string; size: number; [key: string]: unknown }[];
  tags: unknown[];
  /** Video keyframe timestamps (ms), when requested via options.keyframes. */
  keyframes?: number[];
  /** MP4 only: tracks the probe saw but does not carry (e.g. cover art). */
  dropped_tracks?: DroppedTrack[];
  [key: string]: unknown;
}

export interface DroppedTrack {
  ID: number;
  Type: TrackType;
  Codec: string;
  Reason: string;
}

export interface AbortOptions {
  /** Abort the in-flight operation (e.g. from an effect cleanup). */
  signal?: AbortSignal;
}

export interface ProbeOptions extends AbortOptions {
  /** Build the keyframe index (MKV: full scan when the file has no Cues). */
  keyframes?: boolean;
  /** Read per-track BPS statistics tags (MKV; head-only via SeekHead→Tags). */
  bitrate?: boolean;
  /** Parse in-band SPS for colour when container metadata is absent. */
  inbandColour?: boolean;
}

/** The subset of the mkvgo wasm API Entei consumes (see web/mkvgo.ts upstream
 * for the full surface: remux/HLS/ABR/analyze/…). */
export interface MkvGoApi {
  version(): string;
  /**
   * Read a file's full metadata. A Uint8Array is read in place; a Blob/File is
   * read through ranged slices — head-only, so probing works on files far
   * larger than memory (a 40 GB File transfers a few hundred kilobytes).
   */
  probe(input: Uint8Array | Blob, options?: ProbeOptions): Promise<ProbeResult>;
  /** Extract one subtitle track as a WebVTT string (MKV or MP4 input). */
  extractSubtitleVTT(input: Uint8Array, trackId: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface LoadOptions {
  /** URL of mkvgo.wasm (browser; fetched with instantiateStreaming). */
  wasmUrl?: string;
  /** The wasm binary itself (Node, or a custom fetch). */
  wasmBytes?: ArrayBuffer | Uint8Array;
  /**
   * URL of Go's wasm_exec.js runtime, injected as a <script> when
   * globalThis.Go is not already defined (browser convenience). In Node or a
   * bundler, load wasm_exec.js yourself before calling loadMkvGo.
   */
  wasmExecUrl?: string;
}

declare global {
  // Provided by Go's wasm_exec.js.
  var Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> };
  var MkvGo: MkvGoApi | undefined;
}

let loaded: Promise<MkvGoApi> | null = null;

/**
 * Load the mkvgo wasm module (idempotent — subsequent calls return the same
 * instance). Provide either wasmUrl (browser) or wasmBytes (Node). A failed
 * load clears the cached promise so a later call can retry.
 */
export function loadMkvGo(options: LoadOptions): Promise<MkvGoApi> {
  if (!loaded) {
    loaded = doLoad(options).catch((err) => {
      loaded = null; // transient failure — allow a later call to retry
      throw err;
    });
  }
  return loaded;
}

async function doLoad(options: LoadOptions): Promise<MkvGoApi> {
  if (typeof globalThis.Go === 'undefined') {
    if (!options.wasmExecUrl) throw new Error('mkvgo: load wasm_exec.js first, or pass wasmExecUrl');
    await injectScript(options.wasmExecUrl);
  }
  const go = new globalThis.Go();
  let instance: WebAssembly.Instance;
  if (options.wasmBytes) {
    ({ instance } = await WebAssembly.instantiate(options.wasmBytes as BufferSource, go.importObject));
  } else if (options.wasmUrl) {
    ({ instance } = await WebAssembly.instantiateStreaming(fetch(options.wasmUrl), go.importObject));
  } else {
    throw new Error('mkvgo: pass wasmUrl or wasmBytes');
  }
  void go.run(instance); // runs for the module's lifetime
  // The wasm registers globalThis.MkvGo asynchronously. Poll with a
  // deadline so a broken wasm build fails fast instead of busy-waiting
  // forever; 50 ms pacing keeps the wait loop cheap while it spins.
  const deadline = Date.now() + 30_000;
  while (typeof globalThis.MkvGo === 'undefined') {
    if (Date.now() > deadline) {
      throw new Error('mkvgo: init timed out — MkvGo not defined');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return globalThis.MkvGo;
}

/** wasm_exec.js loads whose <script> is still in flight, keyed by URL. */
const scriptLoads = new Map<string, Promise<void>>();

/**
 * Inject Go's wasm_exec.js runtime as a <script> (browser only). It is a
 * one-time global: executing it defines globalThis.Go and installs the
 * Node-compatible globalThis.fs shim the wasm module uses for file I/O, so
 * loading it twice is pure waste (and would clobber window.fs). Concurrent
 * loadMkvGo callers share a single in-flight load; a failed script is
 * removed and dropped from the map so a retry can inject a fresh copy.
 */
function injectScript(url: string): Promise<void> {
  if (typeof document === 'undefined') {
    return Promise.reject(
      new Error('mkvgo: no document — load wasm_exec.js manually in this environment'),
    );
  }
  let pending = scriptLoads.get(url);
  if (!pending) {
    pending = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => {
        s.remove(); // allow a later retry to inject a fresh copy
        reject(new Error(`mkvgo: failed to load ${url}`));
      };
      document.head.appendChild(s);
    }).finally(() => {
      scriptLoads.delete(url);
    });
    scriptLoads.set(url, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// React convenience hook (mirrors upstream web/react.ts)
// ---------------------------------------------------------------------------

/** Load the wasm module once; null until ready. */
export function useMkvGo(options: LoadOptions): MkvGoApi | null {
  const [api, setApi] = useState<MkvGoApi | null>(null);
  const opts = useRef(options);
  useEffect(() => {
    // [] deps: loadMkvGo caches the module instance (singleton), so the
    // effect only needs to run once per mount. The options are snapshotted
    // in opts.current, so a caller re-creating the options object each
    // render never re-triggers the load.
    let live = true;
    loadMkvGo(opts.current)
      .then((m) => {
        if (live) setApi(m);
      })
      .catch(() => {
        // Load failures surface at the loadMkvGo() call site; keep the hook
        // quiet so a mount/unmount race never triggers an unhandled rejection.
      });
    return () => {
      live = false;
    };
  }, []);
  return api;
}
