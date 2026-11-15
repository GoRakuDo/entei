'use client';

/**
 * Yomitan's own overlay — the floating popup, drawn anywhere in the app.
 * ---------------------------------------------------------------------------
 * THIS FILE IS THE MODULE'S OVERLAY ENTRY. The host never imports it by name:
 * `features/modules/module-overlays` discovers `src/modules/<id>/overlay.tsx` for
 * every registered module and draws the ones the user has enabled, so adding a
 * module that floats over the whole app needs no layout edit and no host list.
 *
 * The scanner (installed once per page by `scripts/trace-boot.ts`) looks up the
 * Japanese text under the pointer and announces what it found on
 * `yomitan:scan-result`. This is the other half: the card that appears next to
 * that word.
 *
 * WHAT IT DRAWS. The user's actual popup, not an approximation of one: the markup
 * comes from Yomitan's own `DisplayGenerator` and the CSS is Yomitan's own
 * unmodified stylesheets, serialized into an iframe `srcdoc` (see
 * `modules/yomitan/popup-preview/`). The theme, font size, custom popup CSS and
 * the Position & Size numbers are the persisted Yomitan options, so the popup
 * looks the way the settings card shows it will. The Appearance section's SHADOW
 * is the frame's own `data-outer-theme` (upstream styles the shadow on the
 * `<iframe>`, not on the document inside it), so Light / Dark / None lift the
 * card the same way they do in the extension.
 *
 * IT IS A POPUP, NOT A POSTER. The card has a history, the way the extension's
 * does: clicking a kanji in a headword opens that character's own kanji entry
 * (upstream binds exactly this to `.headword-kanji-link`), and the action bar's
 * `<` / `>` step through what the user has looked at — which is also why the `×`
 * is there and works. The stack itself is `popup-history`; this component owns the
 * entries each step needs.
 *
 * WHY THE SCAN IS NOT LOOKED UP AGAIN. The scanner already holds the translator's
 * own entries — it looked them up to decide whether there was a hit at all — and
 * publishes them with the event, so a scan costs exactly one dictionary round trip
 * no matter how many popups read it. Only a NEW lookup (a clicked kanji) pays.
 *
 * WHY postMessage. The document lives in a SANDBOXED iframe, so this component
 * cannot read it: `contentDocument` is `null` for any frame without
 * `allow-same-origin`, and adding that flag to a frame that also runs script would
 * hand the frame the host document. The frame's own click bridge therefore
 * announces itself, and `sourceIsPopupFrame` is what decides the message is ours.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Options } from '@gorakudo/yomitan-headless/settings';
import {
  createScannedPopupHistory,
  hasScannedEntries,
  loadPopupPreviewAssets,
  pushPopupHistory,
  renderPopupCard,
  resolveScannedPopupFrame,
  stepPopupHistory,
  toPopupDictionaryInfo,
  type PopupDictionaryInfo,
  type PopupFrameRequest,
  type PopupHistoryState,
  type ResolvedPopupOuterTheme,
  parsePopupFrameRequest,
  sourceIsPopupFrame,
} from '@/modules/yomitan/popup-preview';
import {
  readOptionPath,
  readYomitanOptions,
} from '@/modules/yomitan/yomitan-preferences';
import { lookupKanji } from '@/modules/yomitan/yomitan-engine';
import { listInstalledDictionariesCached } from '@/modules/yomitan/dictionary-store';
import {
  YOMITAN_SCAN_RESULT_EVENT,
  type YomitanScanResultDetail,
} from '@/modules/yomitan/text-scanner';
import {
  nextCloseSignal,
  placePopup,
  POPUP_HORIZONTAL_OFFSET,
  POPUP_VERTICAL_OFFSET,
  POPUP_VIEWPORT_MARGIN,
  type PopupPlacement,
  type PopupPlacementOptions,
  type PopupRect,
} from '@/modules/yomitan/floating-popup';

/** English chrome of the frame (the popup's own document is upstream's). */
const POPUP_COPY = {
  title: 'Yomitan popup',
} as const;

/**
 * Upper bound on the frame.
 *
 * The popup's own document has no max-height of its own — upstream grows the
 * frame with the card and the user sets the box. Over the app's text, a card
 * taller than the space below the word would run off the bottom of the screen, so
 * the box is capped at half the viewport height and the card scrolls inside it
 * (Yomitan's own `.content-scroll` container is what scrolls).
 */
const MAX_VIEWPORT_HEIGHT_RATIO = 0.5;

/**
 * How many resolved entry sets are kept before the oldest is dropped.
 *
 * Going BACK and FORWARD over a stack the user has already walked must not re-query
 * the dictionary engine, so each visited entry keeps its entries here. The stack
 * itself is bounded (`POPUP_HISTORY_LIMIT`), and a kanji card is small, so this
 * only guards against a long session of repeated visits.
 */
const ENTRY_CACHE_LIMIT = 64;

/** Cache key for one history entry. */
function entryKey(mode: string, query: string): string {
  return `${mode}:${query}`;
}

/**
 * One history entry's resolved answer.
 *
 * Both halves, because a `scan` entry is drawn from both: the scanner runs the term
 * and the kanji lookup on the same text, and the popup shows the one under the other.
 */
interface CachedEntries {
  entries: readonly unknown[];
  kanjiEntries: readonly unknown[];
}

/** What the frame is currently showing, plus the anchor it was placed from. */
interface OpenPopup {
  /** The iframe document (upstream markup + stylesheets). */
  srcDoc: string;
  /** Frame box in CSS pixels (the user's Position & Size numbers). */
  size: { width: number; height: number };
  /**
   * The user's Shadow setting, resolved — written on the frame as
   * `data-outer-theme`, which is what upstream's own `popup-outer.css` keys the
   * frame's shadow off. It belongs HERE and not in the document: the stylesheet
   * vendored for the document is the popup's CONTENT, and the shadow is the
   * frame's.
   */
  outerTheme: ResolvedPopupOuterTheme;
  /** The scanned word's rectangle, in viewport coordinates. */
  anchor: PopupRect;
  /** The user's two distance knobs, in pixels. */
  offsets: PopupPlacementOptions;
  /** What was scanned — carried so a re-placement does not need the event. */
  text: string;
}

/** The viewport a placement is computed against. */
function readViewport(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/**
 * The user's two distance knobs (`general.popupHorizontalOffset` /
 * `popupVerticalOffset`), in pixels.
 *
 * Non-numbers fall back to upstream's own defaults rather than to `0`: a hand
 * edited options tree that cleared a knob must not glue the card to the word.
 */
function readPlacementOffsets(options: Options): PopupPlacementOptions {
  const read = (path: string, fallback: number): number => {
    const value = readOptionPath(options, path);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  return {
    horizontalOffset: read('general.popupHorizontalOffset', POPUP_HORIZONTAL_OFFSET),
    verticalOffset: read('general.popupVerticalOffset', POPUP_VERTICAL_OFFSET),
  };
}

/** The dictionaries the generator prints on its dictionary tags. */
async function readDictionaries(): Promise<PopupDictionaryInfo[]> {
  try {
    return toPopupDictionaryInfo(await listInstalledDictionariesCached());
  } catch {
    // No engine to answer (a browser pass, the plugin failing to start): the card
    // draws without dictionary tags rather than not at all.
    return [];
  }
}

/** The frame box this open is drawn at: the user's numbers, capped by the viewport. */
function clampFrameHeight(height: number, viewportHeight: number): number {
  if (viewportHeight <= 0) return height;
  const cap = Math.max(
    POPUP_VIEWPORT_MARGIN * 2,
    Math.floor(viewportHeight * MAX_VIEWPORT_HEIGHT_RATIO),
  );
  return Math.min(height, cap);
}

export function YomitanPopup() {
  const [open, setOpen] = useState<OpenPopup | null>(null);
  const [placement, setPlacement] = useState<PopupPlacement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  /** The `<iframe>` element, so an incoming message can be checked against it. */
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /** One scan in flight at a time: a second scan replaces the first's answer. */
  const epochRef = useRef(0);
  /** The stack the action bar steps through, and the entries each step draws. */
  const [history, setHistory] = useState<PopupHistoryState | null>(null);
  const entriesRef = useRef(new Map<string, CachedEntries>());
  /**
   * The anchor and knobs the OPEN popup was placed from.
   *
   * Held in refs so that a history step (which re-renders the card) re-places the
   * frame from the same word instead of recomputing them from an event that has
   * already gone.
   */
  const anchorRef = useRef<PopupRect>({ top: 0, left: 0, width: 0, height: 0 });
  const offsetsRef = useRef<PopupPlacementOptions>({});

  /* ---------------------------------------------------------------------
   * Draw: one history entry, from the entries resolved for it.
   * ------------------------------------------------------------------- */
  const draw = useCallback(
    async (state: PopupHistoryState, text: string): Promise<OpenPopup | null> => {
      const item = state.items[state.index];
      if (item === undefined) return null;
      const epoch = epochRef.current;
      const cached = entriesRef.current.get(entryKey(item.mode, item.query));
      const [assets, dictionaries] = await Promise.all([
        loadPopupPreviewAssets(),
        readDictionaries(),
      ]);
      const options = readYomitanOptions();
      const frameBox = resolveScannedPopupFrame(options);
      const card = await renderPopupCard({
        history: state,
        entries: cached?.entries ?? [],
        kanjiEntries: cached?.kanjiEntries ?? [],
        css: assets.css,
        templates: assets.templates,
        dictionaries,
        options,
      });
      if (epoch !== epochRef.current) return null;
      return {
        srcDoc: card.srcDoc,
        size: frameBox.size,
        outerTheme: frameBox.outerTheme,
        // The scanner measures the MATCHED WORD, not the window it read, so the
        // card sits under the word the user is looking at.
        anchor: anchorRef.current,
        offsets: offsetsRef.current,
        text,
      };
    },
    [],
  );

  /* ---------------------------------------------------------------------
   * Open on a scan hit, from the scan's own entries (no second lookup).
   * ------------------------------------------------------------------- */
  useEffect(() => {
    const onScanResult = (event: Event): void => {
      const detail = (event as CustomEvent<YomitanScanResultDetail>).detail;
      if (detail === undefined || !hasScannedEntries(detail)) {
        // A miss (or an empty hit): the previous card belongs to another word.
        epochRef.current += 1;
        setHistory(null);
        setOpen(null);
        setPlacement(null);
        return;
      }
      const epoch = ++epochRef.current;
      const options = readYomitanOptions();
      const state = createScannedPopupHistory(detail);
      const item = state.items[0];
      // The scan's OWN entries, filed under the entry the stack starts on: this is
      // what keeps the first card free of a second dictionary round trip.
      if (item !== undefined) {
        entriesRef.current = new Map([
          [
            entryKey(item.mode, item.query),
            { entries: detail.entries, kanjiEntries: detail.kanjiEntries },
          ],
        ]);
      }
      anchorRef.current = detail.anchor;
      offsetsRef.current = readPlacementOffsets(options);
      setHistory(state);
      void (async () => {
        try {
          const next = await draw(state, detail.text);
          if (epoch !== epochRef.current || next === null) return;
          setOpen(next);
        } catch {
          // No vendored assets or no generator: a popup that cannot draw the
          // card must not leave an empty frame over the page.
          if (epoch !== epochRef.current) return;
          setHistory(null);
          setOpen(null);
          setPlacement(null);
        }
      })();
    };

    window.addEventListener(YOMITAN_SCAN_RESULT_EVENT, onScanResult);
    return () =>
      window.removeEventListener(YOMITAN_SCAN_RESULT_EVENT, onScanResult);
  }, [draw]);

  /* ---------------------------------------------------------------------
   * History: a clicked kanji, and the action bar's `<` / `>`.
   * ------------------------------------------------------------------- */
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!sourceIsPopupFrame(event.source, iframeRef.current)) return;
      const request: PopupFrameRequest | null = parsePopupFrameRequest(event.data);
      if (request === null || history === null) return;
      void (async () => {
        const epoch = epochRef.current;
        let next: PopupHistoryState;
        if (request.type === 'close') {
          epochRef.current += 1;
          setHistory(null);
          setOpen(null);
          setPlacement(null);
          return;
        }
        if (request.type === 'previous') {
          next = stepPopupHistory(history, -1);
        } else if (request.type === 'next') {
          next = stepPopupHistory(history, 1);
        } else {
          // Upstream's own behaviour for a kanji in a headword: look that ONE
          // character up and open it as a new history entry.
          try {
            const found = await lookupKanji(request.character);
            if (epoch !== epochRef.current) return;
            entriesRef.current.set(entryKey('kanji', request.character), {
              entries: [],
              kanjiEntries: found,
            });
            if (entriesRef.current.size > ENTRY_CACHE_LIMIT) {
              const oldest = entriesRef.current.keys().next().value;
              if (oldest !== undefined) entriesRef.current.delete(oldest);
            }
          } catch {
            // No engine to answer: nothing to show, so the card stays as it is
            // rather than turning into an error the popup has no way to draw.
            return;
          }
          next = pushPopupHistory(history, {
            mode: 'kanji',
            query: request.character,
          });
        }
        if (next === history) return;
        setHistory(next);
        try {
          const drawn = await draw(next, next.items[next.index]?.query ?? '');
          if (epoch !== epochRef.current) return;
          if (drawn !== null) setOpen(drawn);
        } catch {
          /* A failed redraw leaves the current card up: the user can still read
             what is on screen and step back. */
        }
      })();
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [history, draw]);

  /* ---------------------------------------------------------------------
   * Placement: next to the word, clamped to the viewport, on every resize.
   * ------------------------------------------------------------------- */
  useEffect(() => {
    if (open === null) return;
    const place = (): void => {
      const viewport = readViewport();
      setPlacement(
        placePopup(
          open.anchor,
          open.size.width,
          clampFrameHeight(open.size.height, viewport.height),
          viewport,
          open.offsets,
        ),
      );
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  /* ---------------------------------------------------------------------
   * Close: Escape, a press outside the frame, or another scan replacing it.
   * ------------------------------------------------------------------- */
  const close = useCallback(() => {
    // The epoch bump also cancels a scan whose document has not arrived yet, so
    // a popup closed before it drew never re-opens itself.
    epochRef.current += 1;
    setHistory(null);
    setOpen(null);
    setPlacement(null);
  }, []);

  useEffect(() => {
    if (open === null) return;
    const onEvent = (event: Event): void => {
      const target = event.target as Node | null;
      const signal = nextCloseSignal({
        type: event.type,
        key: (event as KeyboardEvent).key,
        inside:
          target !== null &&
          frameRef.current !== null &&
          frameRef.current.contains(target),
      });
      if (signal === null) return;
      // `nextCloseSignal` already excludes a press inside the frame: that is the
      // user reading or selecting the card's own text.
      if (signal.type === 'escape') event.preventDefault();
      close();
    };

    document.addEventListener('keydown', onEvent, true);
    document.addEventListener('pointerdown', onEvent, true);
    return () => {
      document.removeEventListener('keydown', onEvent, true);
      document.removeEventListener('pointerdown', onEvent, true);
    };
  }, [open, close]);

  if (open === null) return null;
  const viewport = readViewport();

  return (
    <div
      ref={frameRef}
      className="entei-yomitan-popup"
      data-side={placement?.side ?? 'below'}
      data-outer-theme={open.outerTheme}
      style={{
        top: `${placement?.top ?? open.anchor.top + open.anchor.height + (open.offsets.verticalOffset ?? POPUP_VERTICAL_OFFSET)}px`,
        left: `${placement?.left ?? open.anchor.left + (open.offsets.horizontalOffset ?? POPUP_HORIZONTAL_OFFSET)}px`,
        width: `${open.size.width}px`,
        height: `${clampFrameHeight(open.size.height, viewport.height)}px`,
      }}
    >
      <iframe
        ref={iframeRef}
        title={`${POPUP_COPY.title}: ${open.text}`}
        srcDoc={open.srcDoc}
        /* Static markup plus the frame's own click bridge: nothing in the frame
           reaches the host except the four messages `popup-frame` parses, and
           the document carries user CSS and dictionary text. */
        sandbox="allow-scripts"
      />
    </div>
  );
}

export default YomitanPopup;