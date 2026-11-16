/**
 * popup-card — one history entry, drawn as an iframe document.
 * ---------------------------------------------------------------------------
 * The seam both hosts share. A popup is always showing ONE entry of its history
 * stack (`popup-history`), and turning that entry into a document is the same three
 * steps no matter who asked:
 *
 * 1. Yomitan's own `DisplayGenerator` renders the entries — `createTermEntry` for
 *    a word, `createKanjiEntry` for a single character, one method apart.
 * 2. `resolvePopupAppearance` answers the theme, font, custom CSS and frame size
 *    from the persisted options.
 * 3. `buildPopupDocument` serializes the two, with the action bar told whether
 *    `<` and `>` have anywhere to go.
 *
 * What it deliberately does NOT do is look anything up. The two hosts resolve the
 * entries themselves, because their sources differ and must stay that way: the
 * settings preview owns its term field and queries the engine, while the floating
 * popup already holds the scan's entries and must never pay for a second lookup.
 *
 * Browser-only: the generator builds real DOM nodes.
 * ---------------------------------------------------------------------------
 */

import type { Options } from '@gorakudo/yomitan-headless/settings';
import {
  buildPopupDocument,
  extractPopupMenuTemplates,
  renderPopupEntriesHtml,
  renderPopupKanjiHtml,
  resolvePopupAppearance,
  type PopupDictionaryInfo,
} from '@/modules/yomitan/popup-preview';
import {
  canGoPopupHistoryBack,
  canGoPopupHistoryForward,
  currentPopupHistoryItem,
  type PopupHistoryMode,
  type PopupHistoryState,
} from '@/modules/yomitan/popup-preview/popup-history';

/** What one rendered history entry is. */
export interface PopupCard {
  /** The iframe `srcdoc`. */
  srcDoc: string;
  /** The entry's lookup, so a host can label the frame or key a re-render. */
  mode: PopupHistoryMode;
  query: string;
}

/** What a card is drawn from. */
export interface PopupCardInput {
  /** The whole stack; the cursor decides which entry is drawn. */
  history: PopupHistoryState;
  /** The CURRENT entry's dictionary entries (resolved by the host). */
  entries: readonly unknown[];
  /**
   * The CURRENT entry's KANJI entries, for a `scan` entry only.
   *
   * A scan runs both lookups on the same text, so its first card is the term list
   * with the kanji cards under it — the same shape `popup-scanned` always drew.
   */
  kanjiEntries?: readonly unknown[];
  /** Yomitan's own stylesheets + templates (`loadPopupPreviewAssets`). */
  css: string;
  templates: string;
  /** Installed dictionaries, for the generator's dictionary tags. */
  dictionaries: readonly PopupDictionaryInfo[];
  /** The persisted options (theme, font, custom CSS, popup size). */
  options: Options;
}

/**
 * Draw the entry the cursor points at.
 *
 * The navigation attributes come off the SAME state object that picked the entry,
 * so a card can never offer a step the stack cannot take — the `<` button is
 * enabled exactly when `stepPopupHistory(state, -1)` would move.
 */
export async function renderPopupCard(input: PopupCardInput): Promise<PopupCard> {
  const { history, entries, kanjiEntries = [], css, templates, dictionaries, options } =
    input;
  const appearance = resolvePopupAppearance(options);
  const frame = {
    css,
    themeAttributes: appearance.themeAttributes,
    fontStyle: appearance.fontStyle,
    customCss: appearance.customCss,
    popupActionBarLocation: appearance.popupActionBarLocation,
    popupActionBarVisibility: appearance.popupActionBarVisibility,
    /* Upstream's own `⋮` menu templates: the frame instantiates them, so the
       entry's debug menu is the extension's markup and not a lookalike. */
    menuTemplates: extractPopupMenuTemplates(templates),
  };
  const item = currentPopupHistoryItem(history);
  // A history with no current entry is not a state `popup-history` produces; an
  // empty document is the safe answer if one is ever constructed by hand.
  if (item === undefined) {
    return {
      srcDoc: buildPopupDocument({ ...frame, entriesHtml: '' }),
      mode: 'term',
      query: '',
    };
  }

  const dictionariesForGenerator = [...dictionaries];
  const termsHtml = async (): Promise<string> =>
    await renderPopupEntriesHtml(templates, entries, dictionariesForGenerator);
  /* A `scan` card draws the kanji entries UNDER its term entries, and upstream
     numbers every entry in one sequence — so the kanji list starts after the
     term list, which is what the `⋮` menu reports. */
  const kanjiHtml = async (startIndex: number = 0): Promise<string> =>
    await renderPopupKanjiHtml(
      templates,
      kanjiEntries,
      dictionariesForGenerator,
      startIndex,
    );

  let entriesHtml: string;
  switch (item.mode) {
    case 'kanji':
      entriesHtml = await kanjiHtml();
      break;
    case 'scan':
      entriesHtml = `${await termsHtml()}${await kanjiHtml(entries.length)}`;
      break;
    default:
      entriesHtml = await termsHtml();
      break;
  }

  const srcDoc = buildPopupDocument({
    ...frame,
    entriesHtml,
    hasNavigationPrevious: canGoPopupHistoryBack(history),
    hasNavigationNext: canGoPopupHistoryForward(history),
    // A kanji lookup that found nothing is an ANSWER (the dictionaries have no
    // kanji data), not a missing dictionary — so it draws upstream's own
    // "No results found." rather than the settings preview's install sentence.
    emptyState: item.mode === 'kanji' ? 'no-results' : 'placeholder',
  });
  return { srcDoc, mode: item.mode, query: item.query };
}