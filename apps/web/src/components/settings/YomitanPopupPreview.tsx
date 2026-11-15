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
 * it brings its own editor and the manifest brings only the text. It also takes
 * the module's OPTIONS TREE, because it draws from it: unlike a credential row,
 * whose whole value is one stored string, this row visualises a dozen settings and
 * has to follow them live.
 *
 * Two change keys keep that live without being expensive (see `popup-lookup`):
 * the lookup re-runs only when the dictionary set or the lookup knobs move, while
 * an appearance edit only rebuilds the document string.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Options } from '@gorakudo/yomitan-headless/settings';
import {
  POPUP_PREVIEW_TERM,
  buildPopupDocument,
  loadPopupPreviewAssets,
  lookupPopupEntries,
  popupAppearanceKey,
  popupLookupKey,
  renderPopupEntriesHtml,
  resolvePopupAppearance,
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
} as const;

export interface YomitanPopupPreviewProps {
  /** Row label (the manifest's literal English). */
  label: string;
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

  /**
   * The options of the last render whose lookup key we started work for.
   *
   * A ref, not a dependency: the effect deliberately re-runs on the LOOKUP key
   * alone, so an appearance edit never re-queries the dictionary engine. Reading
   * the options through a ref keeps that intentional asymmetry from also freezing
   * a stale tree.
   */
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let current = true;
    setFailed(false);
    void (async () => {
      try {
        const assets = await loadPopupPreviewAssets();
        const found = await lookupPopupEntries();
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
  }, [lookupKey]);

  const srcDoc = useMemo(() => {
    if (built === null) return null;
    const appearance = resolvePopupAppearance(optionsRef.current);
    return buildPopupDocument({
      css: built.css,
      themeAttributes: appearance.themeAttributes,
      fontStyle: appearance.fontStyle,
      customCss: appearance.customCss,
      entriesHtml: built.entriesHtml,
    });
    /* The document depends on the APPEARANCE key only: the markup above is
       already resolved and must not be rebuilt while a theme select settles. */
  }, [built, appearanceKey]);

  return (
    <div className="entei-module-field entei-yomitan-popup-preview">
      <div className="entei-module-field-text">
        <span className="entei-module-field-label">{label}</span>
        {description !== undefined && (
          <p className="entei-module-field-description">{description}</p>
        )}
      </div>

      <div className="entei-yomitan-popup-preview-frame">
        <p className="entei-yomitan-popup-preview-term" lang="ja">
          {POPUP_PREVIEW_TERM}
        </p>
        <div className="entei-yomitan-popup-preview-viewport">
          {srcDoc === null ? (
            <p className="entei-yomitan-popup-preview-note">{PREVIEW_COPY.loading}</p>
          ) : (
            <iframe
              title={`${label}: ${POPUP_PREVIEW_TERM}`}
              srcDoc={srcDoc}
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
    </div>
  );
}