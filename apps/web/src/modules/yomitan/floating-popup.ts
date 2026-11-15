/**
 * floating-popup — where the scanned popup sits, and when it goes away.
 * ---------------------------------------------------------------------------
 * The floating Yomitan popup (the card that opens beside the word the user just
 * scanned, anywhere in the app) has two pieces of arithmetic that have nothing to
 * do with Yomitan and everything to do with the viewport, and both are PURE:
 *
 * - `placePopup` puts the frame next to the scanned word — under it when there is
 *   room, above it when there is not — and then clamps the result to the
 *   viewport, so a 400px-wide popup at the right edge of a subtitle panel stays
 *   fully on screen instead of being clipped in half.
 * - `nextCloseSignal` decides what the host closes on. Escape and a press outside
 *   the frame close it; a press INSIDE it never does (the user may be reading or
 *   selecting the card's text). Scrolling does not either: the scanner
 *   re-announces on scroll, so the popup follows the word instead of blinking out
 *   from under the pointer, and the popup's own document is what scrolls when the
 *   card is taller than the frame.
 *
 * Keeping these here — rather than inside the component — is what makes them
 * testable without a rendered frame or a pointer event.
 * ---------------------------------------------------------------------------
 */

/** The box a placement is computed for. */
export interface PopupRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The viewport a placement is clamped to. */
export interface PopupViewport {
  width: number;
  height: number;
}

/** A placed popup, in viewport coordinates (`position: fixed`). */
export interface PopupPlacement {
  top: number;
  left: number;
  /**
   * Which side of the anchor the frame ended up on.
   *
   * `above` is reported when there was not enough room below, even if clamping
   * then moved the frame back down to a position that overlaps the anchor — the
   * label describes the attempt, which is what a caller animating an entrance
   * needs to know.
   */
  side: 'above' | 'below';
}

/** Room left between the frame and the viewport edge. */
export const POPUP_VIEWPORT_MARGIN = 8;

/** Room between the anchor and the frame. */
export const POPUP_ANCHOR_GAP = 6;

/** What closes the popup (the event's own type, so the host can switch on it). */
export type PopupCloseSignal = { type: 'escape' } | { type: 'outside-press' };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Place a `width`×`height` frame next to `anchor`, inside `viewport`.
 *
 * The anchor is centred horizontally under (or over) the scanned word, then the
 * whole box is clamped so nothing hangs off any edge. When the viewport is
 * narrower than the frame — a 400px popup on a 360px phone — the frame is pinned
 * to the left margin and left to shrink to the viewport in CSS, rather than being
 * given a negative offset that would hide its left half.
 */
export function placePopup(
  anchor: PopupRect,
  width: number,
  height: number,
  viewport: PopupViewport,
  gap: number = POPUP_ANCHOR_GAP,
  margin: number = POPUP_VIEWPORT_MARGIN,
): PopupPlacement {
  const maxLeft = Math.max(margin, viewport.width - width - margin);
  const left = clamp(
    anchor.left + anchor.width / 2 - width / 2,
    margin,
    maxLeft,
  );

  const anchorBottom = anchor.top + anchor.height;
  const roomBelow = viewport.height - anchorBottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const below = roomBelow >= height || roomBelow >= roomAbove;

  if (below) {
    const maxTop = Math.max(margin, viewport.height - height - margin);
    return {
      top: clamp(anchorBottom + gap, margin, maxTop),
      left,
      side: 'below',
    };
  }
  // Above, but never off the top edge: a tall frame under a word near the top of
  // the viewport is pinned to the margin and simply covers the anchor.
  const maxTop = Math.max(margin, anchor.top - gap - height);
  return {
    top: clamp(anchor.top - gap - height, margin, maxTop),
    left,
    side: 'above',
  };
}

/**
 * What a DOM event closes the popup on, or `null` when it does not.
 *
 * PURE over the three facts the decision needs — the event type, the key, and
 * whether the press landed inside the frame — so the contract is testable without
 * dispatching synthetic events at a rendered popup.
 */
export function nextCloseSignal(event: {
  type: string;
  key?: string;
  inside?: boolean;
}): PopupCloseSignal | null {
  switch (event.type) {
    case 'keydown':
      return event.key === 'Escape' || event.key === 'Esc'
        ? { type: 'escape' }
        : null;
    case 'pointerdown':
    case 'mousedown':
      // A press inside the frame is the user reading or selecting the card's own
      // text; it is never a dismissal.
      return event.inside === true ? null : { type: 'outside-press' };
    default:
      return null;
  }
}
