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
 * Two change keys keep that live without being expensive (see `popup-lookup`):
 * the lookup re-runs only when the dictionary set, the lookup knobs or the term
 * field move, while an appearance edit only rebuilds the document string.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useMemo, useState } from 'react';
import type { Options } from '@gorakudo/yomitan-headless/settings';
import { Input } from '@/components/player/ui/input';
import {
  POPUP_PREVIEW_TERM,
  buildPopupDocument,
  loadPopupPreviewAssets,
  lookupPopupEntries,
  popupAppearanceKey,
  popupLookupKey,
  renderPopupEntriesHtml,
  resolvePopupAppearance,
  resolvePreviewTerm,
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

/** What the card has been built from, ready to serialize. */
interface BuiltPreview {
  css: string;
  entriesHtml: string;
}

export function YomitanPopupPreview({
  label,
  description,
  options,
}: YomitanPopupPreviewProps) {
  const lookupKey = popupLookupKey(options);
  const appearanceKey = popupAppearanceKey(options);
  const [built, setBuilt] = useState<BuiltPreview | null>(null);
  const [failed, setFailed] = useState(false);
  /* `term` is what the field shows, `query` is what was looked up: the card keeps
     drawing the last answer while the field is being edited. */
  const [term, setTerm] = useState(POPUP_PREVIEW_TERM);
  const [query, setQuery] = useState(POPUP_PREVIEW_TERM);

  useEffect(() => {
    const next = resolvePreviewTerm(term);
    if (next === query) return;
    const timer = setTimeout(() => setQuery(next), TERM_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, query]);

  useEffect(() => {
    let current = true;
    setFailed(false);
    void (async () => {
      try {
        const assets = await loadPopupPreviewAssets();
        const found = await lookupPopupEntries(query);
        const entriesHtml = await renderPopupEntriesHtml(
          assets.templates,
          found.entries,
          found.dictionaries,
        );
        if (!current) return;
        setBuilt({ css: assets.css, entriesHtml });
      } catch {
        // No engine to answer (a browser pass, the plugin failing to start) or a
        // vendored asset that did not load: the frame still draws Yomitan's own
        // placeholder rather than going blank.
        if (!current) return;
        setBuilt({ css: '', entriesHtml: '' });
        setFailed(true);
      }
    })();
    return () => {
      current = false;
    };
  }, [lookupKey, query]);

  /* Resolved on the APPEARANCE key alone, so an appearance edit re-serializes the
     document without re-querying the dictionary engine (see `popup-lookup`). The
     box the frame is drawn at comes off the same resolution. */
  const appearance = useMemo(
    () => resolvePopupAppearance(options),
    [appearanceKey],
  );

  const srcDoc = useMemo(() => {
    if (built === null) return null;
    return buildPopupDocument({
      css: built.css,
      themeAttributes: appearance.themeAttributes,
      fontStyle: appearance.fontStyle,
      customCss: appearance.customCss,
      popupActionBarLocation: appearance.popupActionBarLocation,
      popupActionBarVisibility: appearance.popupActionBarVisibility,
      entriesHtml: built.entriesHtml,
    });
  }, [built, appearance]);

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
            title={label === undefined ? query : `${label}: ${query}`}
            srcDoc={srcDoc}
            /* The FRAME's outer theme (upstream `popup-outer.css` styles the
               extension's own `<iframe>`, not the document inside it), so the
               card's shadow follows the Appearance section's Shadow setting. */
            data-outer-theme={appearance.resolvedOuterTheme}
            style={{
              width: `${appearance.size.width}px`,
              height: `${appearance.size.height}px`,
            }}
            /* Static markup: nothing in the frame needs to run, and the
               document carries user CSS and dictionary text. */
            sandbox=""
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