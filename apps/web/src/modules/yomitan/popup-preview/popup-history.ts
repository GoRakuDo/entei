/**
 * popup-history — the popup's back/forward stack, as data.
 * ---------------------------------------------------------------------------
 * Upstream Yomitan does not redraw a popup when the user clicks a kanji in a
 * headword; it pushes a new HISTORY ENTRY and moves a cursor (`ext/display/
 * display-history.js`, consumed by `display.js`'s `_onKanjiLookup` with
 * `historyMode: 'new'`). That is what makes the action bar's `<` and `>` mean
 * something: they step the cursor, and each end of the list disables its button.
 *
 * This is that structure with none of the DOM: a list of lookups and a cursor.
 * Both hosts need it — the settings preview and the floating popup draw the same
 * document from the same stack — and both need it to be testable without a
 * rendered frame, which is why it is PURE and lives here rather than inside a
 * component.
 *
 * What is deliberately NOT here: the entries themselves. The stack stores the
 * LOOKUP (mode + query), because the card is always re-rendered from scratch by
 * Yomitan's own generator — exactly as upstream re-renders on every history move.
 * ---------------------------------------------------------------------------
 */

/** Which of Yomitan's lookups an entry represents. */
export type PopupHistoryMode =
  /** `findTerms`: the word card. */
  | 'term'
  /** `findKanji`: one character's own card. */
  | 'kanji'
  /**
   * What a SCAN found: its term entries with its kanji cards underneath.
   *
   * Not one of upstream's two modes — it exists because this app's scanner runs
   * both lookups on the same window of text at once, and a scan of 読め legitimately
   * answers with the word AND with 読 and め. Only the first card of the floating
   * popup is ever this; a kanji clicked afterwards is a plain `kanji` entry.
   */
  | 'scan';

/** One lookup the popup can draw. */
export interface PopupHistoryItem {
  /** `term` / `kanji` / `scan` — which lookup the card is drawn from. */
  mode: PopupHistoryMode;
  /** The word that was typed/scanned, or the single clicked kanji. */
  query: string;
}

/** The stack and where the cursor sits in it. */
export interface PopupHistoryState {
  /** Oldest first; never empty. */
  items: readonly PopupHistoryItem[];
  /** Index of the entry the frame is currently drawing. */
  index: number;
}

/**
 * The longest stack kept.
 *
 * Upstream keeps whatever the session looked up. A popup that lives for the whole
 * app session would otherwise grow without bound while the user clicks through
 * kanji after kanji, so the oldest entries fall off — the cursor is normalised
 * back into range, so dropping from the FRONT never leaves it pointing at nothing.
 */
export const POPUP_HISTORY_LIMIT = 50;

/** A new stack showing `item`. */
export function createPopupHistory(item: PopupHistoryItem): PopupHistoryState {
  return { items: [item], index: 0 };
}

/** True when the cursor can still move towards the oldest entry. */
export function canGoPopupHistoryBack(state: PopupHistoryState): boolean {
  return state.index > 0;
}

/** True when the cursor can still move towards the newest entry. */
export function canGoPopupHistoryForward(state: PopupHistoryState): boolean {
  return state.index < state.items.length - 1;
}

/**
 * Move the cursor `delta` entries, clamped to the stack.
 *
 * A move that cannot happen returns the SAME state object, so a host that stores
 * it in React state does not re-render for a press on a disabled button.
 */
export function stepPopupHistory(
  state: PopupHistoryState,
  delta: number,
): PopupHistoryState {
  if (!Number.isFinite(delta) || delta === 0) return state;
  const index = Math.min(
    Math.max(state.index + Math.trunc(delta), 0),
    state.items.length - 1,
  );
  return index === state.index ? state : { ...state, index };
}

/**
 * Add `item` as the newest entry and move the cursor onto it.
 *
 * This is `historyMode: 'new'`: any forward entries the user had walked back over
 * are dropped, because a new lookup branches off the entry being looked at rather
 * than extending the abandoned one. Looking up the entry already under the cursor
 * is a no-op (same object), so a re-render cannot push a duplicate.
 */
export function pushPopupHistory(
  state: PopupHistoryState,
  item: PopupHistoryItem,
): PopupHistoryState {
  const current = state.items[state.index];
  if (current !== undefined && current.mode === item.mode && current.query === item.query) {
    return state;
  }
  const kept = state.items.slice(0, state.index + 1);
  kept.push(item);
  const overflow = Math.max(0, kept.length - POPUP_HISTORY_LIMIT);
  const items = overflow === 0 ? kept : kept.slice(overflow);
  return { items, index: items.length - 1 };
}

/** The lookup the frame is currently drawing. */
export function currentPopupHistoryItem(
  state: PopupHistoryState,
): PopupHistoryItem | undefined {
  return state.items[state.index];
}