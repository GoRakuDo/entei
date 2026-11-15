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
 * ---------------------------------------------------------------------------
 */

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
  | { type: 'kanji'; character: string };

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
    default:
      return null;
  }
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