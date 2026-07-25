/**
 * DenChou Fixed Scene Wrapper — code-side automatic wrapping
 * ---------------------------------------------------------------------------
 * When noteType === 'DenChou', the semantic fields `sentence` and `source`
 * are automatically wrapped in `<span class="group">…</span>` at final Anki
 * payload construction. This is NOT configurable — there is no Settings UI,
 * no preferences persistence, and no user-owned HTML.
 *
 * Applied only at Anki payload construction, never in React DOM.
 * Non-DenChou note types never call these functions.
 * --------------------------------------------------------------------------- */

/** Fixed before/after HTML for DenChou scene wrapping. */
const DENCHOU_SPAN_OPEN = '<span class="group">';
const DENCHOU_SPAN_CLOSE = '</span>';

/** DenChou semantic keys that receive automatic wrapping. */
type DenChouWrapTarget = 'sentence' | 'source';
const DENCHOU_WRAP_TARGETS: readonly DenChouWrapTarget[] = [
  'sentence',
  'source',
];

/** Check whether a semantic key is a DenChou wrap target. */
export function isDenChouWrapTarget(key: string): key is DenChouWrapTarget {
  return (DENCHOU_WRAP_TARGETS as readonly string[]).includes(key);
}

/**
 * Apply the fixed DenChou `<span class="group">…</span>` wrapper.
 * Returns the wrapped value for sentence/source, or the original value
 * for any other semantic key.
 *
 * This function is only meaningful when noteType === 'DenChou'.
 * Caller is responsible for that check.
 */
export function wrapDenChouField(key: string, value: string): string {
  if (!isDenChouWrapTarget(key)) return value;
  return `${DENCHOU_SPAN_OPEN}${value}${DENCHOU_SPAN_CLOSE}`;
}

/**
 * Check if a semantic key is a DenChou wrap target AND is actively used.
 * Used to decide whether to skip `<br>` separator in append mode.
 * Returns true for sentence/source (the two fixed targets).
 */
export function isDenChouActiveTarget(key: string): boolean {
  return isDenChouWrapTarget(key);
}
