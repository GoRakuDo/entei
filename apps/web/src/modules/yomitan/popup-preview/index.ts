/**
 * popup-preview — the Yomitan Appearance section's live popup card.
 * ---------------------------------------------------------------------------
 * Public surface of the feature. Everything a host needs is here; nothing outside
 * this directory has to know how the card is produced.
 *
 * The pipeline, in order:
 *
 * 1. `popup-assets` reads Yomitan's own stylesheets and templates once.
 * 2. `popup-lookup` resolves the preview term against the active dictionary set.
 * 3. `popup-entries` runs Yomitan's own `DisplayGenerator` over that result.
 * 4. `popup-theme` resolves the appearance settings exactly as Yomitan does.
 * 5. `popup-document` assembles the four into the iframe's `srcdoc`.
 *
 * Steps 4 and 5 are pure and browser-free; the split is what makes the document
 * (theme resolution, escaping, placeholder) unit-testable without a DOM.
 *
 * The FLOATING popup (the one that opens beside a scanned word) is step 2 skipped:
 * `popup-scanned` feeds the generator the entries the scan already looked up, so
 * the same steps 3-5 draw the same card from a different source.
 * ---------------------------------------------------------------------------
 */

export {
  POPUP_PREVIEW_PLACEHOLDER,
  POPUP_PREVIEW_TERM,
  buildPopupDocument,
} from '@/modules/yomitan/popup-preview/popup-document';
export { loadPopupPreviewAssets } from '@/modules/yomitan/popup-preview/popup-assets';
export {
  lookupPopupEntries,
  popupLookupKey,
  resolvePreviewTerm,
} from '@/modules/yomitan/popup-preview/popup-lookup';
export {
  renderPopupEntriesHtml,
  renderPopupKanjiHtml,
  restoreTextGlosses,
  toPopupDictionaryInfo,
  type PopupDictionaryInfo,
} from '@/modules/yomitan/popup-preview/popup-entries';
export {
  popupAppearanceKey,
  resolvePopupAppearance,
  resolvePopupFontStyle,
  resolvePopupOuterTheme,
  resolvePopupThemeAttributes,
  type ResolvedPopupOuterTheme,
} from '@/modules/yomitan/popup-preview/popup-theme';
export {
  buildScannedPopupDocument,
  hasScannedEntries,
  resolveScannedPopupFrame,
  type ScannedPopupInput,
} from '@/modules/yomitan/popup-preview/popup-scanned';
