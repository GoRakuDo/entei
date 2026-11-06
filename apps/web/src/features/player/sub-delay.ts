/**
 * Sub-delay — sub-millisecond subtitle offset (docs/MODULE_ARCHITECTURE.md §9.3).
 * ---------------------------------------------------------------------------
 * LazySync estimates an offset by analysing audio in JS. The native engine
 * (libmpv `--sub-delay=<sec>`) instead reads the waveform timing directly and
 * hands the web layer a plain offset in seconds — decimal precision, negative
 * values allowed, no rounding and no sign conversion.
 *
 * This module is the web half of that contract:
 * - pure cue shifting in SECONDS (`shiftedStart = max(0, start + offset)`,
 *   `shiftedEnd = max(0, end + offset)`);
 * - an immutable state that always keeps the ORIGINAL base cues, so repeated
 *   adjustments never degrade the base (same rule LazySync follows);
 * - a browser-only CustomEvent bridge so the native engine can push an offset
 *   straight into the Player island without a React-tree dependency (the same
 *   narrow page-memory boundary `settings-bridge.ts` uses).
 *
 * The offset is page-memory only: it is never persisted and never logged.
 * Note: this is deliberately NOT shared with `lazy-sync.ts#shiftCuesByOffset`,
 * which works in milliseconds and drops cues that collapse to a zero length
 * (its own documented contract).
 * ---------------------------------------------------------------------------
 */

import type { SubtitleCue } from './subtitle-reader';

/** CustomEvent name for a native-engine → Player sub-delay handoff. */
export const SUB_DELAY_EVENT = 'entei:player-sub-delay';

/** |offset| above this is a broken value, not a real subtitle delay (±1 h). */
export const SUB_DELAY_MAX_SECONDS = 3600;

/** Original cues plus the offset currently applied to them. */
export interface SubDelayState {
  /** Untouched cues the offset is always applied to. */
  readonly baseCues: readonly SubtitleCue[];
  /** Current offset in seconds (negative = subtitle earlier). */
  readonly offsetSeconds: number;
}

/** Empty, zero-offset state. */
export function createSubDelayState(
  baseCues: readonly SubtitleCue[] = [],
): SubDelayState {
  return { baseCues, offsetSeconds: 0 };
}

/**
 * Validate an offset coming from an untrusted source (event payload, native
 * bridge). Returns null for non-finite or absurd values so callers fail
 * closed instead of shifting every cue into nonsense.
 */
export function sanitizeSubDelaySeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Math.abs(value) > SUB_DELAY_MAX_SECONDS) return null;
  return value;
}

/**
 * Replace the offset, keeping the base cues intact. A rejected (invalid)
 * offset leaves the state untouched.
 */
export function setSubDelayOffset(
  state: SubDelayState,
  offsetSeconds: unknown,
): SubDelayState {
  const sanitized = sanitizeSubDelaySeconds(offsetSeconds);
  if (sanitized === null) return state;
  if (sanitized === state.offsetSeconds) return state;
  return { baseCues: state.baseCues, offsetSeconds: sanitized };
}

/**
 * Swap in a new subtitle while KEEPING the current offset: the base is
 * re-anchored to the freshly loaded cues, so a later adjustment still shifts
 * the original timings rather than an already-shifted copy.
 */
export function rebaseSubDelay(
  state: SubDelayState,
  baseCues: readonly SubtitleCue[],
): SubDelayState {
  return { baseCues, offsetSeconds: state.offsetSeconds };
}

/**
 * Shift cues by a constant offset in seconds. Negative offsets clamp at 0
 * (a subtitle cannot start before the media does); cue IDs are preserved
 * because no cue is ever dropped.
 */
export function shiftCuesBySubDelay(
  cues: readonly SubtitleCue[],
  offsetSeconds: unknown,
): SubtitleCue[] {
  const offset = sanitizeSubDelaySeconds(offsetSeconds);
  if (offset === null || offset === 0) return cues.map((cue) => ({ ...cue }));

  return cues.map((cue) => ({
    ...cue,
    start: Math.max(0, cue.start + offset),
    end: Math.max(0, cue.end + offset),
  }));
}

/** The cues the Player should render for the current state. */
export function subDelayCues(state: SubDelayState): SubtitleCue[] {
  return shiftCuesBySubDelay(state.baseCues, state.offsetSeconds);
}

function isBrowser(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function' &&
    typeof CustomEvent === 'function'
  );
}

/** Push an offset from the native engine (or any owner) to the Player. */
export function dispatchSubDelay(offsetSeconds: unknown): void {
  if (!isBrowser()) return;
  const offset = sanitizeSubDelaySeconds(offsetSeconds);
  if (offset === null) return;
  window.dispatchEvent(
    new CustomEvent<number>(SUB_DELAY_EVENT, { detail: offset }),
  );
}

/** Listen for validated offsets; returns a cleanup function. */
export function listenForSubDelay(
  listener: (offsetSeconds: number) => void,
): () => void {
  if (!isBrowser()) return () => {};

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    const offset = sanitizeSubDelaySeconds(detail);
    if (offset !== null) listener(offset);
  };

  window.addEventListener(SUB_DELAY_EVENT, handler);
  return () => window.removeEventListener(SUB_DELAY_EVENT, handler);
}
