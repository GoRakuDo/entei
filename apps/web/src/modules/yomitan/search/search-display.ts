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
 * cards into an iframe `srcdoc` and marks the first one `entry-current` — the
 * popup's own "this is the card the ⋮ menu acts on" marker, which upstream's
 * `search.html` does not have. A search page drawing through it would show the
 * popup's selection indicator on the first result of every search. So this module
 * is the same three lines of setup returning NODES instead of HTML, with no
 * marker and no menu.
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
  /** One `DisplayGenerator` card per term entry, in dictionary order. */
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
  const build = (
    create: GeneratorWithCards['createTermEntry'],
    entries: readonly unknown[],
    dictionaries: readonly PopupDictionaryInfo[],
  ): HTMLElement[] =>
    entries.map((entry) => create(restoreTextGlosses(entry), [...dictionaries]));

  return {
    termNodes: (entries, dictionaries) =>
      build(cards.createTermEntry, entries, dictionaries),
    kanjiNodes: (entries, dictionaries) =>
      build(cards.createKanjiEntry, entries, dictionaries),
  };
}