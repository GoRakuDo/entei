/**
 * Yomitan popup history + frame bridge — unit tests.
 * ---------------------------------------------------------------------------
 * Two pure pieces hold the popup's behaviour together, and both are testable
 * without a rendered frame:
 *
 * - `popup-history` is the stack behind the action bar. What matters is the part
 *   a user notices: `<` and `>` are enabled exactly when a step would move, a new
 *   lookup BRANCHES (the abandoned forward entries go away), and re-looking-up the
 *   entry under the cursor does not push a duplicate.
 * - `popup-frame` is the boundary the sandboxed document talks across. A
 *   `postMessage` listener sees every frame on the page, so the parser has to be
 *   strict: anything that is not one of the five requests, or a kanji request
 *   with no character, is rejected rather than half-trusted.
 * ---------------------------------------------------------------------------
 */

import { describe, expect, it } from 'bun:test';
import {
  POPUP_HISTORY_LIMIT,
  canGoPopupHistoryBack,
  canGoPopupHistoryForward,
  createPopupHistory,
  createScannedPopupHistory,
  currentPopupHistoryItem,
  logPopupEntryDebugInfo,
  parsePopupFrameRequest,
  pushPopupHistory,
  stepPopupHistory,
} from '@/modules/yomitan/popup-preview';
import { POPUP_FRAME_CHANNEL } from '@/modules/yomitan/popup-preview/popup-frame';

const READ = { mode: 'term', query: '読め' } as const;
const EAT = { mode: 'term', query: '食べる' } as const;
const KANJI = { mode: 'kanji', query: '読' } as const;

describe('popup history — the stack behind the action bar', () => {
  it('starts with one entry and nowhere to go', () => {
    const state = createPopupHistory(READ);
    expect(currentPopupHistoryItem(state)).toEqual(READ);
    expect(canGoPopupHistoryBack(state)).toBe(false);
    expect(canGoPopupHistoryForward(state)).toBe(false);
  });

  it('enables back after a second lookup and forward only while it is ahead', () => {
    const two = pushPopupHistory(createPopupHistory(READ), EAT);
    expect(two).toEqual({ items: [READ, EAT], index: 1 });
    expect(canGoPopupHistoryBack(two)).toBe(true);
    expect(canGoPopupHistoryForward(two)).toBe(false);

    // `<` → the first entry: forward becomes available, back does not.
    const back = stepPopupHistory(two, -1);
    expect(currentPopupHistoryItem(back)).toEqual(READ);
    expect(canGoPopupHistoryBack(back)).toBe(false);
    expect(canGoPopupHistoryForward(back)).toBe(true);

    // `>` → forward again.
    expect(currentPopupHistoryItem(stepPopupHistory(back, 1))).toEqual(EAT);
  });

  it('clamps at both ends and hands back the SAME state when it cannot move', () => {
    const state = createPopupHistory(READ);
    // Identity, not equality: a press on a disabled button must not re-render.
    expect(stepPopupHistory(state, -1)).toBe(state);
    expect(stepPopupHistory(state, 0)).toBe(state);
    expect(stepPopupHistory(state, Number.NaN)).toBe(state);

    const two = pushPopupHistory(state, EAT);
    expect(stepPopupHistory(two, 5)).toEqual({ items: [READ, EAT], index: 1 });
    expect(stepPopupHistory(two, -5)).toEqual({ items: [READ, EAT], index: 0 });
  });

  it('opens a kanji as a new entry, three deep', () => {
    const state = pushPopupHistory(pushPopupHistory(createPopupHistory(READ), EAT), KANJI);
    expect(state.items).toEqual([READ, EAT, KANJI]);
    expect(currentPopupHistoryItem(state)).toEqual(KANJI);
    expect(stepPopupHistory(stepPopupHistory(state, -1), -1)).toEqual({
      items: [READ, EAT, KANJI],
      index: 0,
    });
  });

  it('branches: a lookup made after stepping back drops the abandoned forward entries', () => {
    const two = pushPopupHistory(createPopupHistory(READ), EAT);
    const back = stepPopupHistory(two, -1);
    const branched = pushPopupHistory(back, KANJI);
    // EAT is gone: the kanji was looked up FROM 読め, not from 食べる.
    expect(branched).toEqual({ items: [READ, KANJI], index: 1 });
    expect(canGoPopupHistoryForward(branched)).toBe(false);
  });

  it('does not push the entry already under the cursor', () => {
    const state = createPopupHistory(READ);
    expect(pushPopupHistory(state, READ)).toBe(state);
    const two = pushPopupHistory(state, EAT);
    expect(pushPopupHistory(stepPopupHistory(two, -1), READ)).not.toBe(two);
    expect(pushPopupHistory(two, EAT)).toBe(two);
  });

  it('drops the oldest entry past the limit and keeps the cursor in range', () => {
    let state = createPopupHistory(READ);
    for (let index = 0; index < POPUP_HISTORY_LIMIT + 10; index += 1) {
      state = pushPopupHistory(state, { mode: 'kanji', query: `漢${index}` });
    }
    expect(state.items.length).toBe(POPUP_HISTORY_LIMIT);
    // The cursor points at the entry just pushed, not at a fallen-off one.
    expect(currentPopupHistoryItem(state)).toEqual({
      mode: 'kanji',
      query: `漢${POPUP_HISTORY_LIMIT + 9}`,
    });
    expect(canGoPopupHistoryBack(state)).toBe(true);
  });
});

describe('popup frame — what the sandboxed document may ask for', () => {
  it('accepts the three action-bar buttons', () => {
    expect(parsePopupFrameRequest({ channel: POPUP_FRAME_CHANNEL, type: 'close' })).toEqual({
      type: 'close',
    });
    expect(parsePopupFrameRequest({ channel: POPUP_FRAME_CHANNEL, type: 'previous' })).toEqual({
      type: 'previous',
    });
    expect(parsePopupFrameRequest({ channel: POPUP_FRAME_CHANNEL, type: 'next' })).toEqual({
      type: 'next',
    });
  });

  it('accepts a kanji request, trimmed', () => {
    expect(
      parsePopupFrameRequest({ channel: POPUP_FRAME_CHANNEL, type: 'kanji', character: ' 読 ' }),
    ).toEqual({ type: 'kanji', character: '読' });
  });

  /* The entry's own `⋮` menu → "Log debug info". The index is what the frame read
     off the entry's `data-index`, and -1 (upstream's "not inside an entry") must
     not become a lookup of the entry before the first one. */
  it('accepts a debug-info request for one entry', () => {
    expect(
      parsePopupFrameRequest({
        channel: POPUP_FRAME_CHANNEL,
        type: 'log-debug-info',
        index: 2,
      }),
    ).toEqual({ type: 'log-debug-info', index: 2 });

    const refused: unknown[] = [
      { channel: POPUP_FRAME_CHANNEL, type: 'log-debug-info' },
      { channel: POPUP_FRAME_CHANNEL, type: 'log-debug-info', index: -1 },
      { channel: POPUP_FRAME_CHANNEL, type: 'log-debug-info', index: 1.5 },
      { channel: POPUP_FRAME_CHANNEL, type: 'log-debug-info', index: '2' },
    ];
    for (const data of refused) {
      expect(parsePopupFrameRequest(data)).toBeNull();
    }
  });

  it('rejects anything that is not one of its own five requests', () => {
    const not: unknown[] = [
      null,
      undefined,
      'close',
      42,
      {},
      { type: 'close' }, // no channel
      { channel: 'some-other-popup', type: 'close' },
      { channel: POPUP_FRAME_CHANNEL },
      { channel: POPUP_FRAME_CHANNEL, type: 'navigate-parent' },
      // A click on an anchor the generator left blank is not a lookup.
      { channel: POPUP_FRAME_CHANNEL, type: 'kanji', character: '' },
      { channel: POPUP_FRAME_CHANNEL, type: 'kanji', character: '   ' },
      { channel: POPUP_FRAME_CHANNEL, type: 'kanji' },
      { channel: POPUP_FRAME_CHANNEL, type: 'kanji', character: 5 },
    ];
    for (const data of not) {
      expect(parsePopupFrameRequest(data)).toBeNull();
    }
  });
});

describe('popup frame — upstream’s one debug menu item', () => {
  it('prints the entry it resolved, and refuses an index it cannot', () => {
    /* A hand-rolled swap rather than a spy framework: all this asserts is what
       reached the console, and the format is upstream's (a plain log of the
       entry). */
    const original = console.info;
    const printed: unknown[][] = [];
    console.info = (...args: unknown[]): void => {
      printed.push(args);
    };
    try {
      const entry = { type: 'term', headwords: [{ term: '読め' }] };
      expect(logPopupEntryDebugInfo(1, [{}, entry])).toBe(true);
      expect(printed.length).toBe(1);
      expect(printed[0]?.[1]).toBe(entry);

      /* A stale message (the card moved on) is upstream's own early return for an
         out-of-range index: nothing is printed as if it were an entry. */
      expect(logPopupEntryDebugInfo(0, [])).toBe(false);
      expect(logPopupEntryDebugInfo(-1, [entry])).toBe(false);
      expect(printed.length).toBe(1);
    } finally {
      console.info = original;
    }
  });
});
describe('popup history — where a scan starts', () => {
  const anchor = { top: 0, left: 0, width: 1, height: 1 };

  function detail(entries: unknown[], kanjiEntries: unknown[]) {
    return {
      text: '読め',
      offset: 0,
      matchLength: 2,
      anchor,
      terms: [],
      kanji: [],
      kanjiEntries,
      entries,
      x: 0,
      y: 0,
    };
  }

  it('starts a mixed scan on the combined card', () => {
    // The scanner runs BOTH lookups on one window of text, so a scan of 読め comes
    // back with the word AND with 読 and め — one card, not a choice between them.
    expect(currentPopupHistoryItem(createScannedPopupHistory(detail([{}], [{}])))).toEqual({
      mode: 'scan',
      query: '読め',
    });
  });

  it('starts a term-only scan on the term card and a kanji-only scan on the kanji card', () => {
    expect(currentPopupHistoryItem(createScannedPopupHistory(detail([{}], [])))).toEqual({
      mode: 'term',
      query: '読め',
    });
    expect(currentPopupHistoryItem(createScannedPopupHistory(detail([], [{}])))).toEqual({
      mode: 'kanji',
      query: '読め',
    });
  });

  it('starts with the action bar disabled at both ends', () => {
    const state = createScannedPopupHistory(detail([{}], [{}]));
    expect(canGoPopupHistoryBack(state)).toBe(false);
    expect(canGoPopupHistoryForward(state)).toBe(false);
  });
});
