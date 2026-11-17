/**
 * search-display — Yomitan's own generator, run for the search page.
 * ---------------------------------------------------------------------------
 * The result cards on `/search/` are not drawn by Entei. `DisplayGenerator`
 * (`ext/js/display/display-generator.js`, vendored under `modules/yomitan/vendor`)
 * is the code that draws the extension's popup, and it is run unchanged: it
 * instantiates the upstream `<template>` set, distributes furigana, groups
 * pronunciations into pitch-accent graphs, resolves tags, disambiguations,
 * inflection chains and frequencies, and applies the glossary layout.
 *
 * WHY NOT `popup-entries.ts`, which already does this. That module serializes the
 * cards into an iframe `srcdoc` for the Appearance preview, which is not what a
 * page needs: this module is the same three lines of setup returning NODES instead
 * of HTML, with no frame and no ⋮ menu (`#popup-menus` — the one thing upstream's
 * `search.html` really does lack).
 *
 * THE SELECTION INDICATOR BELONGS HERE. Upstream marks the current entry ON THE
 * ENTRY ITSELF: `Display._setContentTermsOrKanji` writes `entry.dataset.index` on
 * every card it draws, and the focused one carries `entry-current`
 * (`_entrySetCurrent`) — which is what `display.css` keys the bar / dot / triangle
 * indicator off (`.entry.entry-current .entry-current-indicator`). Upstream's SEARCH
 * page runs exactly that code: `SearchDisplayController._search` always focuses the
 * first result (`state.focusEntry = 0`), so its result list shows the indicator on
 * the first card, and a click moves it (`Display._onEntryClick` reads
 * `dataset.index` off the clicked entry). Both halves live here — `markSearchEntries`
 * when the cards are built, `setCurrentEntry` when one is clicked. Without them the
 * page drew cards with NO indicator at all, whatever `popupCurrentIndicatorMode`
 * said.
 *
 * The two upstream workarounds are the same ones `popup-entries` documents, and
 * both are forced by the host:
 *
 * 1. TEMPLATES ARE LOADED DIRECTLY. Upstream's only public entry point is
 *    `DisplayGenerator.prepare()`, which fetches `templates-display.html` through
 *    `chrome.runtime.getURL` — a WebExtension API this app does not have.
 * 2. THE CONTENT MANAGER IS A STUB. Dictionary media lives in the Rust engine and
 *    is not served to the web layer, so an image gloss renders as Yomitan's empty
 *    image box, exactly as it does for a dictionary whose media has not loaded.
 *
 * `restoreTextGlosses` (from `popup-entries`) is reused rather than repeated: it
 * is the one place that knows `yomitan-engine` rewrites bare glossary strings into
 * `{type: 'text', text}` nodes upstream's generator would otherwise skip.
 * ---------------------------------------------------------------------------
 */

import {
  restoreTextGlosses,
  type PopupDictionaryInfo,
} from '@/modules/yomitan/popup-preview/popup-entries';

/**
 * The host stub `DisplayContentManager` needs.
 *
 * The generator calls `prepareLink` unconditionally and reaches for
 * `application.api` only when a gloss carries media.
 */
const CONTENT_MANAGER_HOST = {
  application: {
    api: {
      drawMedia: () => {},
      getMedia: async () => [],
    },
  },
};

/** What the search page draws its cards with. */
export interface SearchDisplay {
  /**
   * One `DisplayGenerator` card per term entry, in dictionary order.
   *
   * Every node comes back with upstream's own bookkeeping applied (see
   * `markSearchEntries`): `data-index` for the click handler, and `entry-current`
   * on the first card.
   */
  termNodes: (
    entries: readonly unknown[],
    dictionaries: readonly PopupDictionaryInfo[],
  ) => HTMLElement[];
  /** One card per kanji entry (onyomi / kunyomi, meanings, the glyph's tags). */
  kanjiNodes: (
    entries: readonly unknown[],
    dictionaries: readonly PopupDictionaryInfo[],
  ) => HTMLElement[];
}

/**
 * The entry bookkeeping upstream does while it appends a result list.
 *
 * Two things, both of them upstream's: the INDEX attribute
 * (`Display._setContentTermsOrKanji` sets `entry.dataset.index` on every entry and
 * `_onEntryClick` reads it back off the clicked one) and the marker on the focused
 * entry (`_entrySetCurrent` puts `entry-current` there). `focusIndex` is upstream's
 * `focusEntry`, which the search page always passes as 0
 * (`SearchDisplayController._search`).
 *
 * Mutates and returns the same nodes: they are the generator's own DOM, already
 * built, and a drawn card is never worth copying.
 */
export function markSearchEntries(
  nodes: readonly HTMLElement[],
  focusIndex: number = 0,
): HTMLElement[] {
  nodes.forEach((node, index) => {
    node.dataset.index = `${index}`;
    node.classList.toggle('entry-current', index === focusIndex);
  });
  return [...nodes];
}

/**
 * Move the selection indicator onto `entry` (upstream `Display._entrySetCurrent`).
 *
 * Called from the page's own click handler: the cards are the generator's DOM under
 * a React-delegated `onClick`, so the marker moves here rather than in state. Only
 * the entry handed over gains `entry-current`, and only the entry that held it
 * loses it — which is what keeps exactly one entry current.
 */
export function setCurrentEntry(container: Element, entry: Element): void {
  const previous = container.querySelector(':scope > .entry-current');
  if (previous !== null && previous !== entry) {
    previous.classList.remove('entry-current');
  }
  entry.classList.add('entry-current');
}

type GeneratorWithCards = {
  createTermEntry: (
    entry: unknown,
    dictionaries: PopupDictionaryInfo[],
  ) => HTMLElement;
  createKanjiEntry: (
    entry: unknown,
    dictionaries: PopupDictionaryInfo[],
  ) => HTMLElement;
};

/**
 * Build the generator against Yomitan's own template set.
 *
 * The vendor modules are dynamic imports, as they are for the popups: the display
 * code is only needed once a query has actually matched something, and it must not
 * sit in the island's initial chunk.
 */
export async function createSearchDisplay(
  templates: string,
): Promise<SearchDisplay> {
  const [{ DisplayGenerator }, { DisplayContentManager }] = await Promise.all([
    import('@/modules/yomitan/vendor/js/display/display-generator.js'),
    import('@/modules/yomitan/vendor/js/display/display-content-manager.js'),
  ]);

  const generator = new DisplayGenerator(
    new DisplayContentManager(CONTENT_MANAGER_HOST),
    null,
  );
  generator._templates.load(
    new DOMParser().parseFromString(templates, 'text/html'),
  );
  // This host looks up Japanese only (`general.language` is host-locked to `ja`).
  generator.updateLanguage('ja');

  const cards = generator as unknown as GeneratorWithCards;
  /* BOUND, and this is the whole reason this module exists next to
     `popup-entries.ts`.

     `createTermEntry` / `createKanjiEntry` are PROTOTYPE METHODS: their first
     statement is `this._instantiate('term-entry')` (`display-generator.js`).
     Handed to a callback detached — `(e, d) => cards.createTermEntry(e, d)` or
     `build(cards.createTermEntry, …)` — `this` is `undefined` and every single
     search threw `TypeError: Cannot read properties of undefined (reading
     '_instantiate')`. The throw escaped the island's commit phase, so React
     unmounted the tree: pressing Enter did not draw zero cards, it erased the
     page. `popup-entries` never hit this because it keeps the generator as the
     receiver (`generator.createTermEntry(…)`). */
  const createTermEntry = cards.createTermEntry.bind(cards);
  const createKanjiEntry = cards.createKanjiEntry.bind(cards);

  const build = (
    create: GeneratorWithCards['createTermEntry'],
    entries: readonly unknown[],
    dictionaries: readonly PopupDictionaryInfo[],
  ): HTMLElement[] =>
    /* Numbered from 0 in both cases, which is safe because a search resolves to
       EITHER term entries or kanji entries and never both
       (`searchEntriesForMode`): index 0 is the first card on screen either way. */
    markSearchEntries(
      entries.map((entry) => create(restoreTextGlosses(entry), [...dictionaries])),
    );

  return {
    termNodes: (entries, dictionaries) =>
      build(createTermEntry, entries, dictionaries),
    kanjiNodes: (entries, dictionaries) =>
      build(createKanjiEntry, entries, dictionaries),
  };
}