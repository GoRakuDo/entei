/**
 * Floating popup placement — where the scanned popup sits.
 * ---------------------------------------------------------------------------
 * The placement is the one piece of the floating popup that is arithmetic rather
 * than rendering, so it is tested directly:
 *
 *  - the frame goes under the word when there is room below it;
 *  - it flips above the word when there is not;
 *  - it is always fully inside the viewport — a 400px popup at the right edge, a
 *    250px one at the bottom edge, and the degenerate case of a frame wider than
 *    the viewport itself;
 *  - closing is decided on three signals only, and a press INSIDE the frame is
 *    never one of them.
 * ---------------------------------------------------------------------------
 */

import { describe, expect, it } from 'bun:test';
import {
  nextCloseSignal,
  placePopup,
  POPUP_ANCHOR_GAP,
  POPUP_VIEWPORT_MARGIN,
  type PopupRect,
} from '@/modules/yomitan/floating-popup';

/** A word sitting in the middle of a 1280×720 viewport. */
const CENTERED_WORD: PopupRect = { top: 360, left: 640, width: 40, height: 20 };
const VIEWPORT = { width: 1280, height: 720 };

describe('placePopup — the frame next to the scanned word', () => {
  it('goes under the word when there is room below it', () => {
    const placed = placePopup(CENTERED_WORD, 400, 250, VIEWPORT);
    expect(placed.side).toBe('below');
    expect(placed.top).toBe(
      CENTERED_WORD.top + CENTERED_WORD.height + POPUP_ANCHOR_GAP,
    );
    /* Centred on the word, not on its left edge. */
    expect(placed.left).toBe(
      CENTERED_WORD.left + CENTERED_WORD.width / 2 - 200,
    );
  });

  it('flips above the word when there is no room below it', () => {
    const word: PopupRect = { top: 700, left: 640, width: 40, height: 20 };
    const placed = placePopup(word, 400, 250, VIEWPORT);
    expect(placed.side).toBe('above');
    expect(placed.top).toBe(word.top - POPUP_ANCHOR_GAP - 250);
  });

  it('prefers below when the room below merely ties the room above', () => {
    /* 720 - 350 - 6 - 8 = 356 below, 350 - 6 - 8 = 336 above: neither fits, and
       the tie is resolved toward the reading order (under the word). */
    const word: PopupRect = { top: 350, left: 100, width: 40, height: 20 };
    expect(placePopup(word, 400, 250, VIEWPORT).side).toBe('below');
  });

  it('stays fully inside the viewport at the right edge', () => {
    const word: PopupRect = { top: 360, left: 1270, width: 8, height: 20 };
    const placed = placePopup(word, 400, 250, VIEWPORT);
    expect(placed.left).toBe(VIEWPORT.width - 400 - POPUP_VIEWPORT_MARGIN);
    expect(placed.left + 400).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('stays fully inside the viewport at the left edge', () => {
    const word: PopupRect = { top: 360, left: 0, width: 8, height: 20 };
    expect(placePopup(word, 400, 250, VIEWPORT).left).toBe(
      POPUP_VIEWPORT_MARGIN,
    );
  });

  it('pins a frame wider than the viewport to the left margin instead of a negative offset', () => {
    const word: PopupRect = { top: 100, left: 340, width: 20, height: 20 };
    const placed = placePopup(word, 400, 250, { width: 360, height: 640 });
    expect(placed.left).toBe(POPUP_VIEWPORT_MARGIN);
  });

  it('never lets the frame run off the bottom edge', () => {
    const word: PopupRect = { top: 10, left: 100, width: 40, height: 20 };
    /* A 700px frame under a word at the top of a 720px viewport: it is clamped to
       the bottom margin and simply covers the word. */
    const placed = placePopup(word, 400, 700, VIEWPORT);
    expect(placed.top).toBe(VIEWPORT.height - 700 - POPUP_VIEWPORT_MARGIN);
    expect(placed.side).toBe('below');
  });
});

describe('nextCloseSignal — what closes the popup', () => {
  it('closes on Escape, and only on Escape', () => {
    expect(nextCloseSignal({ type: 'keydown', key: 'Escape' })).toEqual({
      type: 'escape',
    });
    expect(nextCloseSignal({ type: 'keydown', key: 'a' })).toBeNull();
    expect(nextCloseSignal({ type: 'keydown', key: 'Tab' })).toBeNull();
  });

  it('closes on a press outside the frame and not on a press inside it', () => {
    expect(nextCloseSignal({ type: 'pointerdown', inside: false })).toEqual({
      type: 'outside-press',
    });
    expect(nextCloseSignal({ type: 'mousedown' })).toEqual({
      type: 'outside-press',
    });
    expect(nextCloseSignal({ type: 'pointerdown', inside: true })).toBeNull();
  });

  it('ignores events it has no opinion about', () => {
    expect(nextCloseSignal({ type: 'scroll' })).toBeNull();
    expect(nextCloseSignal({ type: 'pointermove', inside: false })).toBeNull();
  });
});
