/* tslint:disable */
/* eslint-disable */

/**
 * Align `input` to speech detected in mono PCM `samples` at `sample_rate` Hz
 * (the caller decodes the audio in the browser), returning the re-timed
 * subtitle.
 *
 * `out_format` chooses the output format (`""` keeps the input's). `vad`
 * chooses the speech detector: `"energy"` for the fast loudness-based detector,
 * anything else (including `""`) for the sharper neural `"earshot"` default —
 * energy misfires on music/effects-heavy audio. `on_progress(stage, fraction)`
 * reports the two phases — `"speech"` (voice detection) then `"align"` (the
 * timing search) — each with a `0.0..=1.0` `fraction`, so the page can keep a
 * progress bar moving while the heavy work runs off the main thread (in a Web
 * Worker).
 */
export function sync_to_audio(input: string, format: string, samples: Float32Array, sample_rate: number, fps: number, out_format: string, vad: string, on_progress: Function): string;

/**
 * Align `input` (format: `"srt"`, `"vtt"`, or `"sub"`) to a reference
 * subtitle's timings, returning the re-timed subtitle.
 *
 * `out_format` chooses the output format (`"srt"`/`"vtt"`/`"sub"`/`"ass"`/
 * `"ssa"`); pass `""` to keep the input's format. `on_progress(stage,
 * fraction)` is called as the work advances — `stage` is `"align"`, `fraction`
 * runs `0.0..=1.0` — so the page can show a real progress bar.
 */
export function sync_to_reference(input: string, format: string, reference_text: string, reference_format: string, fps: number, out_format: string, on_progress: Function): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly sync_to_audio: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: any) => [number, number, number, number];
    readonly sync_to_reference: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: any) => [number, number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
