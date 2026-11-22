/**
 * popup-preview — the Yomitan Appearance section's live popup card.
 * ---------------------------------------------------------------------------
 * Public surface of the feature. Everything a host needs is here; nothing outside
 * this directory has to know how the card is produced.
 *
 * The pipeline, in order:
 *
 * 1. `popup-assets` reads Yomitan's own stylesheets and templates once, with the
 *    icon URLs inlined so they survive a sandboxed frame.
 * 2. `popup-lookup` resolves one lookup against the active dictionary set.
 * 3. `popup-entries` runs Yomitan's own `DisplayGenerator` over that result.
 * 4. `popup-theme` resolves the appearance settings exactly as Yomitan does.
 * 5. `popup-document` assembles the four into the iframe's `srcdoc`.
 *
 * Steps 4 and 5 are pure and browser-free; the split is what makes the document
 * (theme resolution, escaping, placeholder) unit-testable without a DOM. So are
 * `popup-history` (the back/forward stack) and `popup-frame` (the message parser
 * the sandboxed document talks to its host through).
 *
 * `popup-card` is the seam both hosts call: one history entry in, one `srcdoc`
 * out. The FLOATING popup differs only in step 2 — `popup-scanned` feeds the
 * generator the entries the scan already looked up, so the same steps 3-5 draw the
 * same card from a different source.
 * ---------------------------------------------------------------------------
 */

export {
  POPUP_PREVIEW_PLACEHOLDER,
  POPUP_PREVIEW_TERM,
  buildPopupDocument,
  toDataAttributes,
  type PopupAudioConfig,
} from '@/modules/yomitan/popup-preview/popup-document';
export { loadPopupPreviewAssets } from '@/modules/yomitan/popup-preview/popup-assets';
export { inlinePopupIconUrls } from '@/modules/yomitan/popup-preview/popup-assets';
export {
  lookupPopupEntries,
  lookupPopupKanji,
  popupLookupKey,
  resolvePreviewTerm,
  type PopupPreviewEntries,
  type PopupPreviewKanji,
} from '@/modules/yomitan/popup-preview/popup-lookup';
export {
  renderPopupCard,
  type PopupCard,
  type PopupCardInput,
} from '@/modules/yomitan/popup-preview/popup-card';
export {
  POPUP_HISTORY_LIMIT,
  canGoPopupHistoryBack,
  canGoPopupHistoryForward,
  createPopupHistory,
  currentPopupHistoryItem,
  pushPopupHistory,
  stepPopupHistory,
  type PopupHistoryItem,
  type PopupHistoryMode,
  type PopupHistoryState,
} from '@/modules/yomitan/popup-preview/popup-history';
export {
  POPUP_FRAME_CHANNEL,
  logPopupEntryDebugInfo,
  parsePopupFrameRequest,
  sourceIsPopupFrame,
  resolveAndPostAudioTracks,
  type PopupFrameRequest,
  type AudioTracksResponse,
  type PopupAudioTrack,
} from '@/modules/yomitan/popup-preview/popup-frame';
export {
  POPUP_MENU_TEMPLATE_IDS,
  extractPopupMenuTemplates,
  extractAudioMenuTemplates,
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
  createScannedPopupHistory,
  hasScannedEntries,
  resolveScannedPopupFrame,
} from '@/modules/yomitan/popup-preview/popup-scanned';
