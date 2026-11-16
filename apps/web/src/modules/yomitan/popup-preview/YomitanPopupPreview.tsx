'use client';

/**
 * YomitanPopupPreview — the Appearance section's live popup card.
 * ---------------------------------------------------------------------------
 * Renders the user's actual popup: Yomitan's own `DisplayGenerator` drawing the
 * active dictionary set's answer for one term, through Yomitan's own stylesheets,
 * with the theme / font / custom-CSS settings applied the way the extension
 * applies them. Nothing about the card is approximated here — see
 * `modules/yomitan/popup-preview/` for the pipeline.
 *
 * HOST-OWNED FIELD ROW: the row is bound by the manifest as a `field` source, so
 * it brings its own editor and declares no text of its own — the card is the
 * whole block. It also takes
 * the module's OPTIONS TREE, because it draws from it: unlike a credential row,
 * whose whole value is one stored string, this row visualises a dozen settings and
 * has to follow them live.
 *
 * TWO STACKED BANDS, both the block's full width: the term field on top (the
 * app's standard settings input), and under it the stage the real popup card is
 * drawn on. Neither is squeezed into a side-by-side split — the card is the point
 * of the section, so it gets the whole width and open space around it.
 *
 * IT BEHAVES LIKE THE POPUP, INCLUDING THE ACTION BAR. Clicking a kanji in the
 * card's headword opens that character's kanji entry, and the bar's `<` / `>`
 * step back and forward through what has been looked at — the same stack the
 * floating popup uses (`popup-history`), so the two cannot drift apart. The bar's
 * `×` resets the card to the example word, which is what a preview with no popup
 * to dismiss should do.
 *
 * Its own styling travels with it (`preview.css`, imported below) instead of
 * sitting in the shared settings stylesheet: no other feature draws this block.
 *
 * Two change keys keep that live without being expensive (see `popup-lookup`):
 * the lookup re-runs only when the dictionary set, the lookup knobs or the entry
 * being drawn move, while an appearance edit only rebuilds the document string.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import './preview.css';
import type { Options } from '@gorakudo/yomitan-headless/settings';
import { Input } from '@/components/player/ui/input';
import {
  POPUP_PREVIEW_TERM,
  createPopupHistory,
  loadPopupPreviewAssets,
  logPopupEntryDebugInfo,
  lookupPopupEntries,
  lookupPopupKanji,
  parsePopupFrameRequest,
  popupAppearanceKey,
  popupLookupKey,
  pushPopupHistory,
  renderPopupCard,
  resolvePopupAppearance,
  resolvePreviewTerm,
  sourceIsPopupFrame,
  stepPopupHistory,
  type PopupDictionaryInfo,
  type PopupHistoryState,
} from '@/modules/yomitan/popup-preview';

/**
 * This row's own English strings.
 *
 * Same reasoning as `module-copy`: a host-owned control's chrome is not manifest
 * data, and these sit inside the upstream tool's own English UI.
 */
const PREVIEW_COPY = {
  loading: 'Loading preview…',
  unavailable:
    'Preview unavailable — the card above shows Yomitan’s own placeholder.',
  /** Accessible name of the term field: this row declares no text of its own. */
  term: 'Preview term',
} as const;

/**
 * Idle time before a half-typed term is looked up.
 *
 * A lookup crosses the Tauri IPC boundary and rebuilds the translator, so it runs
 * once the field has settled rather than on every keystroke: one lookup per word
 * typed, not one per letter.
 */
const TERM_DEBOUNCE_MS = 300;

export interface YomitanPopupPreviewProps {
  /** Row label (the manifest's literal English); the row may declare none. */
  label?: string;
  /** Sentence under the label. */
  description?: string;
  /** The module's whole options tree — what the card is drawn from. */
  options: Options;
}

/**
 * What one lookup produced, kept so an APPEARANCE edit can redraw without paying
 * for the dictionary round trip again.
 *
 * `key` is the change key the answer belongs to: a mismatch means the dictionary
 * set moved and the entries on hand belong to the previous one.
 */
interface BuiltPreview {
  key: string;
  css: string;
  templates: string;
  entries: readonly unknown[];
  dictionaries: readonly PopupDictionaryInfo[];
}

export function YomitanPopupPreview({
  label,
  description,
  options,
}: YomitanPopupPreviewProps) {
  const lookupKey = popupLookupKey(options);
  const appearanceKey = popupAppearanceKey(options);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /* `term` is what the field shows, `query` is what was looked up: the card keeps
     drawing the last answer while the field is being edited. */
  const [term, setTerm] = useState(POPUP_PREVIEW_TERM);
  const [query, setQuery] = useState(POPUP_PREVIEW_TERM);
  /** The stack the card and the action bar move through. */
  const [history, setHistory] = useState<PopupHistoryState>(() =>
    createPopupHistory({ mode: 'term', query: POPUP_PREVIEW_TERM }),
  );
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const builtRef = useRef<BuiltPreview | null>(null);

  const item = history.items[history.index];
  const itemKey = item === undefined ? '' : `${item.mode}:${item.query}`;
  /* The frame is named after the entry it is DRAWING, not after the field: after a
     kanji is clicked the card is that character, and a screen reader should hear
     that rather than the word it was reached from. */
  const drawn = item?.query ?? query;

  useEffect(() => {
    const next = resolvePreviewTerm(term);
    if (next === query) return;
    const timer = setTimeout(() => {
      setQuery(next);
      // A typed term is a NEW lookup, the way typing into the extension's own
      // preview field is: it becomes the newest history entry, so `<` walks back
      // to whatever was on the card before.
      setHistory((previous) => pushPopupHistory(previous, { mode: 'term', query: next }));
    }, TERM_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, query]);

  useEffect(() => {
    let current = true;
    void (async () => {
      /* A failed lookup is NOT a failed frame: the document still draws, with no
         card in it, which is Yomitan's own placeholder — the same "install a
         dictionary" state a browser pass or a stopped engine produces. */
      /* A failed LOOKUP is not a failed frame. The vendored stylesheets are read
         on their own, so the document still draws Yomitan's own "install a
         dictionary" placeholder — fully styled, the way the extension's own page
         looks with no dictionary enabled. Only a missing vendored asset leaves
         the frame with nothing to draw. */
      let built = builtRef.current;
      let unavailable = false;
      try {
        const assets = await loadPopupPreviewAssets();
        let entries: readonly unknown[] = [];
        let dictionaries: readonly PopupDictionaryInfo[] = [];
        if (built !== null && built.key === lookupKey) {
          // Nothing moved since the last answer: keep it rather than re-querying.
          entries = built.entries;
          dictionaries = built.dictionaries;
        } else {
          try {
            const found =
              item?.mode === 'kanji'
                ? await lookupPopupKanji(item.query)
                : await lookupPopupEntries(item?.query);
            entries = found.entries;
            dictionaries = found.dictionaries;
          } catch {
            // No engine to answer (a browser pass, the plugin failing to start).
            unavailable = true;
          }
        }
        built = {
          key: lookupKey,
          css: assets.css,
          templates: assets.templates,
          entries,
          dictionaries,
        };
        builtRef.current = built;
      } catch {
        // No vendored assets: there is nothing to draw the card with at all.
        built = null;
        unavailable = true;
      }

      try {
        const card = await renderPopupCard({
          history,
          entries: built?.entries ?? [],
          kanjiEntries: item?.mode === 'kanji' ? built?.entries ?? [] : [],
          css: built?.css ?? '',
          templates: built?.templates ?? '',
          dictionaries: built?.dictionaries ?? [],
          options,
        });
        if (!current) return;
        setSrcDoc(card.srcDoc);
        setFailed(unavailable);
      } catch {
        if (!current) return;
        setFailed(true);
      }
    })();
    return () => {
      current = false;
    };
    /* `lookupKey` covers the dictionary set and the lookup knobs, `itemKey` the
       entry being drawn, `appearanceKey` everything the document is styled with —
       and none of them is a superset of another, which is the point. */
  }, [lookupKey, itemKey, appearanceKey]);

  /* The card's own three buttons and its kanji links, announced from inside the
     sandboxed document (see `popup-frame` for why it has to be a message). */
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!sourceIsPopupFrame(event.source, iframeRef.current)) return;
      const request = parsePopupFrameRequest(event.data);
      if (request === null) return;
      /* The entry the card is DRAWN from — the lookup answer this frame was built
         with, which is what the frame's `data-index` points into. */
      if (request.type === 'log-debug-info') {
        logPopupEntryDebugInfo(request.index, builtRef.current?.entries ?? []);
        return;
      }
      if (request.type === 'close') {
        // There is no popup to dismiss in a settings preview: the close button
        // puts the example word back on the card.
        setTerm(POPUP_PREVIEW_TERM);
        setQuery(POPUP_PREVIEW_TERM);
        setHistory(createPopupHistory({ mode: 'term', query: POPUP_PREVIEW_TERM }));
        return;
      }
      if (request.type === 'kanji') {
        setHistory((previous) =>
          pushPopupHistory(previous, { mode: 'kanji', query: request.character }),
        );
        return;
      }
      setHistory((previous) =>
        stepPopupHistory(previous, request.type === 'previous' ? -1 : 1),
      );
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /* Resolved on the APPEARANCE key alone, so an appearance edit re-serializes the
     document without re-querying the dictionary engine (see `popup-lookup`). The
     box the frame is drawn at comes off the same resolution. */
  const appearance = useMemo(
    () => resolvePopupAppearance(options),
    [appearanceKey],
  );

  return (
    <div className="entei-module-field entei-yomitan-popup-preview">
      {/* A row the manifest gave no text draws none: the card IS the block, so a
          caption above it would only repeat what the card already shows. */}
      {label !== undefined && (
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">{label}</span>
          {description !== undefined && (
            <p className="entei-module-field-description">{description}</p>
          )}
        </div>
      )}

      {/* What was looked up, editable — upstream's preview page has the same
          field. An empty one falls back to the example word (`resolvePreviewTerm`),
          which is what the placeholder shows. */}
      <Input
        className="entei-module-input entei-yomitan-popup-preview-term-input"
        type="text"
        value={term}
        lang="ja"
        placeholder={POPUP_PREVIEW_TERM}
        autoComplete="off"
        spellCheck={false}
        aria-label={PREVIEW_COPY.term}
        onChange={(event) => setTerm(event.target.value)}
      />

      <div className="entei-yomitan-popup-preview-stage">
        {/* The frame carries the user's own Position & Size numbers: the width and
            height are `general.popupWidth` / `general.popupHeight` (scaled), and
            the stylesheet clamps them to the stage, so a 2000px popup does not
            widen the settings column. */}
        {srcDoc === null ? (
          <p className="entei-yomitan-popup-preview-note">{PREVIEW_COPY.loading}</p>
        ) : (
          <iframe
            ref={iframeRef}
            title={label === undefined ? drawn : `${label}: ${drawn}`}
            srcDoc={srcDoc}
            /* The FRAME's outer theme (upstream `popup-outer.css` styles the
               extension's own `<iframe>`, not the document inside it), so the
               card's shadow follows the Appearance section's Shadow setting. */
            data-outer-theme={appearance.resolvedOuterTheme}
            style={{
              width: `${appearance.size.width}px`,
              height: `${appearance.size.height}px`,
            }}
            /* The card's own click bridge, and nothing else: the document is
               sandboxed to a unique origin, so the three action buttons and the
               headword's kanji links reach React only as `popup-frame` messages. */
            sandbox="allow-scripts"
          />
        )}
      </div>

      {failed && (
        <p className="entei-yomitan-popup-preview-note" role="status">
          {PREVIEW_COPY.unavailable}
        </p>
      )}
    </div>
  );
}