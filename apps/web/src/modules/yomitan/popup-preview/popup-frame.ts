/**
 * popup-frame — what the iframe tells its host, and what it refuses to.
 * ---------------------------------------------------------------------------
 * The popup's document is drawn in a SANDBOXED iframe, so its host cannot read it.
 * `iframe.contentDocument` is `null` for any frame whose sandbox does not include
 * `allow-same-origin`, which means the earlier wiring (an `onLoad` handler that
 * attached a click listener straight to the document) never ran at all. The only
 * channel that crosses the boundary is `postMessage`.
 *
 * So the frame owns one small script (emitted by `popup-document`) that turns
 * clicks into messages, and both hosts parse them here. Keeping the PARSER pure is
 * what makes the boundary testable — and it is also the whole security check: a
 * host must never act on a message that came from anywhere but its own frame.
 *
 * `sourceIsPopupFrame` is that check. A `postMessage` listener on `window` sees
 * every frame and every other tab, so "did this come from MY popup" is answered by
 * identity (`event.source` is the frame's own `contentWindow`), never by the
 * message's contents.
 *
 * ONE REQUEST IS ANSWERED HERE rather than by each host: `log-debug-info` is
 * upstream's only debug menu item, and both hosts would fulfil it with the same
 * three lines (resolve the entry, print it, trace it). `logPopupEntryDebugInfo` is
 * those three lines, so the console format cannot drift between the floating popup
 * and the settings preview.
 * ---------------------------------------------------------------------------
 */

import { traceYomitan } from '@/modules/yomitan/yomitan-preferences';

/** Every message the popup document sends, under this channel name. */
export const POPUP_FRAME_CHANNEL = 'entei-yomitan-popup';

/** What the frame can ask its host to do. */
export type PopupFrameRequest =
  /** The `×` button: the host closes the popup. */
  | { type: 'close' }
  /** `<`: step the history back. */
  | { type: 'previous' }
  /** `>`: step the history forward. */
  | { type: 'next' }
  /** A kanji in a headword was clicked: look that character up. */
  | { type: 'kanji'; character: string }
  /**
   * The entry's `⋮` menu → "Log debug info": print that entry's raw data.
   *
   * The index is the entry's own `data-index` (`popup-entries` writes it, the way
   * upstream's `Display` does), so the host resolves the entry it actually drew.
   * `-1` is upstream's own "not inside an entry" answer and is rejected here.
   */
  | { type: 'log-debug-info'; index: number };

/**
 * Parse one `message` event's data, or `null` when it is not ours.
 *
 * PURE and total: anything that is not a plain object carrying the channel and a
 * known action is rejected, including a `kanji` request with an empty character
 * (a click on an anchor the generator left blank is not a lookup).
 */
export function parsePopupFrameRequest(data: unknown): PopupFrameRequest | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.channel !== POPUP_FRAME_CHANNEL) return null;
  switch (record.type) {
    case 'close':
    case 'previous':
    case 'next':
      return { type: record.type };
    case 'kanji':
      return typeof record.character === 'string' && record.character.trim() !== ''
        ? { type: 'kanji', character: record.character.trim() }
        : null;
    case 'log-debug-info':
      return typeof record.index === 'number' &&
        Number.isInteger(record.index) &&
        record.index >= 0
        ? { type: 'log-debug-info', index: record.index }
        : null;
    default:
      return null;
  }
}

/**
 * Print one dictionary entry's raw data — upstream's "Log debug info".
 *
 * Upstream ends `_logDictionaryEntryData` with `log.log({dictionaryEntry})`, i.e.
 * a plain `console.log` of the entry it resolved. This is that line, plus the
 * entry in Entei's own 24h trace journal (which is gated on the SAME
 * `general.debugInfo` toggle that makes the `⋮` button visible at all).
 *
 * Returns `false` for an index the caller cannot resolve, which is upstream's own
 * early return for an out-of-range index — a stale message must not print
 * `undefined` as if it were an entry.
 */
export function logPopupEntryDebugInfo(
  index: number,
  entries: readonly unknown[],
): boolean {
  const entry = entries[index];
  if (entry === undefined) return false;
  console.info(`[Yomitan] Dictionary entry data (index ${index}):`, entry);
  traceYomitan('popup_log_debug_info', { index, entry });
  return true;
}

/**
 * True when a `message` event came from `frame`.
 *
 * `null` is rejected rather than allowed: a message with no source is not from a
 * window this host opened, and the popup is the only window it ever listens for.
 */
export function sourceIsPopupFrame(
  source: MessageEventSource | null,
  frame: HTMLIFrameElement | null,
): boolean {
  return frame !== null && source === frame.contentWindow;
}