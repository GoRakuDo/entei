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
import { resolveAudioSourcesForTerm } from '@/modules/yomitan/audio/audio-resolver';
import type { AudioSourceInfo } from '@/modules/yomitan/audio/audio-sources';

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
  | { type: 'log-debug-info'; index: number }
  /**
   * The speaker menu opened for a word: the host resolves that word's audio
   * tracks and answers with an [`audio-tracks`](AudioTracksResponse) message.
   *
   * The frame is a SANDBOXED iframe (no `allow-same-origin`): it can neither
   * fetch a `Custom URL (JSON)` payload (no CORS headers on the target) nor call
   * the native plugin. So it asks the HOST to resolve, and the host — which CAN
   * reach the native fetch — answers over this channel. `requestId` pairs the
   * answer with the open menu, so a slow answer for an old word never populates a
   * newer menu.
   */
  | { type: 'resolve-audio-tracks'; requestId: number; term: string; reading: string };

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
    case 'resolve-audio-tracks':
      return typeof record.requestId === 'number' &&
        Number.isFinite(record.requestId) &&
        typeof record.term === 'string' &&
        record.term.trim() !== '' &&
        typeof record.reading === 'string'
        ? {
            type: 'resolve-audio-tracks',
            requestId: record.requestId,
            term: record.term.trim(),
            reading: record.reading.trim(),
          }
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

/**
 * Answer the frame's `resolve-audio-tracks` request: resolve the word's tracks
 * and post them back.
 *
 * The frame is a sandboxed iframe and cannot fetch a `Custom URL (JSON)` payload
 * (no CORS on the target, no native plugin), so the HOST — which reaches the
 * native fetch through `resolveAudioSourcesForTerm` → `fetchTextDirect` — does it
 * and posts the per-source track lists back on the SAME channel. This is the one
 * resolver both hosts (floating popup + settings preview) share, so the frame's
 * menu expands identically in either.
 *
 * Posts the tracks arrays VERBATIM (one per configured source, in order); the
 * frame's own `parseAudioTracksResponse` re-validates on its side, so a resolver
 * that returns an empty group simply renders as "this source has no tracks".
 * Fire-and-forget: a failed resolution posts an all-empty list (the frame shows
 * "no tracks") rather than leaving the menu's loading row stuck.
 */
export function resolveAndPostAudioTracks(
  frame: HTMLIFrameElement,
  requestId: number,
  sources: readonly AudioSourceInfo[],
  term: string,
  reading: string,
): void {
  const target = frame.contentWindow;
  if (target === null) return;
  void resolveAudioSourcesForTerm(sources, term, reading)
    .then((resolved) => {
      target.postMessage(
        {
          channel: POPUP_FRAME_CHANNEL,
          type: 'audio-tracks',
          requestId,
          tracks: resolved,
        },
        '*',
      );
    })
    .catch(() => {
      // Resolution threw (it normally resolves to [] instead, but belt-and-braces):
      // answer with all-empty so the menu never hangs on its loading row.
      target.postMessage(
        {
          channel: POPUP_FRAME_CHANNEL,
          type: 'audio-tracks',
          requestId,
          tracks: sources.map(() => []),
        },
        '*',
      );
    });
}

/** One resolved playable track, as the frame's menu renders it.
 *
 * Mirrors the resolver's `AudioInfo` (the host resolves, the frame renders),
 * flattened to the fields the menu needs: which source (`sourceIndex`) and which
 * track within it (`subIndex`) it is, the direct media `url`, and the track's own
 * `name` when the payload carried one.
 */
export interface PopupAudioTrack {
  sourceIndex: number;
  subIndex: number;
  url: string;
  name?: string;
}

/** The host's answer to a `resolve-audio-tracks` request.
 *
 * `tracks` is the word's resolved track lists, ONE ARRAY PER CONFIGURED SOURCE in
 * source order (an empty array = that source resolved to nothing), so the frame
 * can group the menu by source exactly like `/search/` does.
 */
export interface AudioTracksResponse {
  channel: typeof POPUP_FRAME_CHANNEL;
  type: 'audio-tracks';
  /** Pairs this answer with the `resolve-audio-tracks` request that asked. */
  requestId: number;
  tracks: PopupAudioTrack[][];
}

/**
 * Parse one `message` event's data as an [`AudioTracksResponse`], or `null`.
 *
 * Runs IN THE FRAME (the sandboxed iframe), so it must be self-contained and
 * total: anything that is not our channel's `audio-tracks` reply with a numeric
 * `requestId` and an array-of-arrays `tracks` is rejected. Each track entry is
 * coerced (a row with no `url` is dropped) so a malformed payload degrades to
 * fewer tracks rather than breaking the menu.
 */
export function parseAudioTracksResponse(data: unknown): AudioTracksResponse | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.channel !== POPUP_FRAME_CHANNEL) return null;
  if (record.type !== 'audio-tracks') return null;
  if (typeof record.requestId !== 'number' || !Number.isFinite(record.requestId)) {
    return null;
  }
  if (!Array.isArray(record.tracks)) return null;
  const tracks = record.tracks.map((group) => {
    if (!Array.isArray(group)) return [] as PopupAudioTrack[];
    const out: PopupAudioTrack[] = [];
    for (const entry of group) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.url !== 'string' || row.url === '') continue;
      const sourceIndex = typeof row.sourceIndex === 'number' ? row.sourceIndex : 0;
      const subIndex = typeof row.subIndex === 'number' ? row.subIndex : out.length;
      const name = typeof row.name === 'string' && row.name !== '' ? row.name : undefined;
      out.push({ sourceIndex, subIndex, url: row.url, ...(name !== undefined ? { name } : {}) });
    }
    return out;
  });
  return { channel: POPUP_FRAME_CHANNEL, type: 'audio-tracks', requestId: record.requestId, tracks };
}