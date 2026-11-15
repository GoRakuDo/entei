/**
 * popup-scanned — the floating popup's document, built from a SCAN's own result.
 * ---------------------------------------------------------------------------
 * `popup-document` builds the Appearance preview: one term the preview looked up
 * itself, rendered through Yomitan's generator and stylesheets. This is the same
 * pipeline for the OTHER popup — the one that appears next to the word the user
 * just scanned anywhere in the app.
 *
 * Nothing is re-derived and nothing is looked up again. The scanner already holds
 * the translator's own entries (it looked them up to decide whether there was a
 * hit at all) and publishes them with the event, so the two steps here are:
 *
 * 1. `renderPopupEntriesHtml` / `renderPopupKanjiHtml` run Yomitan's
 *    `DisplayGenerator` over them, exactly as the preview does — the card is
 *    upstream's markup, not a re-implementation.
 * 2. `buildPopupDocument` serializes that markup with the user's theme, font and
 *    custom CSS into the iframe document.
 *
 * Browser-only, like `popup-entries`: the generator builds real DOM nodes.
 * ---------------------------------------------------------------------------
 */

import type { Options } from '@gorakudo/yomitan-headless/settings';
import {
  buildPopupDocument,
  renderPopupEntriesHtml,
  renderPopupKanjiHtml,
  resolvePopupAppearance,
  toPopupDictionaryInfo,
  type PopupDictionaryInfo,
} from '@/modules/yomitan/popup-preview';
import type { YomitanScanResultDetail } from '@/modules/yomitan/text-scanner';

/** What a scanned popup is drawn from: the scan's own result. */
export interface ScannedPopupInput {
  /** The scan result, as published on `yomitan:scan-result`. */
  detail: YomitanScanResultDetail;
  /** Yomitan's own stylesheets + templates (`loadPopupPreviewAssets`). */
  css: string;
  templates: string;
  /** Installed dictionaries, for the generator's dictionary tags. */
  dictionaries: readonly PopupDictionaryInfo[];
  /** The persisted options (theme, font, custom CSS, popup size). */
  options: Options;
}

/**
 * True when the scan found something a popup can draw.
 *
 * PURE and exported so the host can decide to open on the same condition that
 * decides to render — a popup frame with no entries would draw Yomitan's own
 * "no dictionaries" placeholder, which is the wrong message for a scan that
 * simply missed.
 */
export function hasScannedEntries(detail: YomitanScanResultDetail): boolean {
  return detail.entries.length > 0 || detail.kanjiEntries.length > 0;
}

/**
 * Build the iframe document for one scan result.
 *
 * TERMS are what Yomitan's generator draws (`createTermEntry`), and the scan's
 * own translator entries go straight in — nothing is looked up again.
 *
 * A KANJI hit is the same generator's own block: the popup's document is one
 * list, and upstream draws a kanji entry with the same `DisplayGenerator` the
 * preview card uses. Anything hand-written here would be an approximation of a
 * card the user knows from the extension, so the generator draws both.
 */
export async function buildScannedPopupDocument(
  input: ScannedPopupInput,
): Promise<string> {
  const { detail, css, templates, dictionaries, options } = input;
  const entries =
    detail.entries.length === 0
      ? []
      : await renderPopupEntriesHtml(templates, detail.entries, [
          ...dictionaries,
        ]);
  const kanjiHtml =
    detail.kanjiEntries.length === 0
      ? ''
      : await renderPopupKanjiHtml(templates, detail.kanjiEntries, [
          ...dictionaries,
        ]);
  const appearance = resolvePopupAppearance(options);
  return buildPopupDocument({
    css,
    themeAttributes: appearance.themeAttributes,
    fontStyle: appearance.fontStyle,
    customCss: appearance.customCss,
    entriesHtml: `${entries}${kanjiHtml}`,
  });
}

/**
 * The popup frame's box for the user's Position & Size numbers.
 *
 * Resolved here (not read off `resolvePopupAppearance` by the host) so the frame
 * element and the document inside it are sized from one resolution.
 */
export function resolveScannedPopupSize(options: Options): {
  width: number;
  height: number;
} {
  return resolvePopupAppearance(options).size;
}

/** Re-exported so a popup host needs one import for the generator's inputs. */
export { toPopupDictionaryInfo };
