/**
 * popup-entries — Yomitan's own generator, run against Entei's own lookups.
 * ---------------------------------------------------------------------------
 * The preview does NOT re-implement Yomitan's card. `DisplayGenerator`
 * (`ext/js/display/display-generator.js`, vendored under `modules/yomitan/vendor`)
 * is the code that draws the extension's popup, and it is run here unchanged: it
 * instantiates the upstream `<template>` set, distributes furigana, groups
 * pronunciations into pitch-accent graphs, resolves tags, disambiguations,
 * inflection chains and frequencies, and applies the glossary layout.
 *
 * That is why there is no "renderer" in this directory beyond this file: anything
 * hand-written here would be an approximation of a card the user already knows,
 * and would drift from upstream on the next Yomitan bump.
 *
 * Two deliberate deviations, both forced by the host:
 *
 * 1. TEMPLATES ARE LOADED DIRECTLY. Upstream's only public entry point is
 *    `DisplayGenerator.prepare()`, which fetches `templates-display.html` through
 *    `chrome.runtime.getURL` — a WebExtension API this app does not have. The
 *    file is already in hand (`popup-assets`), so it is parsed and handed to the
 *    collection the generator owns.
 * 2. THE CONTENT MANAGER IS A STUB. Upstream's `DisplayContentManager` loads
 *    dictionary media through the extension's `api`. Dictionary media lives in the
 *    Rust engine and is not served to a settings preview, so the manager only
 *    provides what the generator calls unconditionally (`prepareLink`); an image
 *    gloss therefore renders as Yomitan's empty image box, exactly as it does for
 *    a dictionary whose media has not loaded.
 *
 * And one host-side normalization, because the two sides disagree on a shape:
 * `yomitan-engine` rewrites every bare glossary string into `{type: 'text', text}`
 * so that its downstream readers see a single node type, while upstream's
 * generator renders a bare string, structured content and images — and skips a
 * `text` node. `restoreTextGlosses` converts that one node back before the entry
 * is handed over, so the card shows the definitions the engine found.
 *
 * Browser-only: the generator builds real DOM nodes in THIS document, which are
 * then serialized into the iframe document (see `popup-document.ts`).
 * ---------------------------------------------------------------------------
 */

import type { InstalledDictionary } from '@/modules/yomitan/dictionary-store';

/**
 * One dictionary as `DisplayGenerator` reads it (`dictionary-importer`'s `Summary`).
 *
 * Only the fields the card prints are mapped; `counts` is not available from the
 * Rust engine's summary, so the dictionary tag omits its "Term Count" line the
 * same way upstream omits it for a summary without counts.
 */
export interface PopupDictionaryInfo {
  title: string;
  revision: string;
  author?: string;
}

/** Reshape the installed-dictionary list for the generator. */
export function toPopupDictionaryInfo(
  dictionaries: readonly InstalledDictionary[],
): PopupDictionaryInfo[] {
  const info: PopupDictionaryInfo[] = [];
  for (const entry of dictionaries) {
    const summary: PopupDictionaryInfo = {
      title: entry.name,
      revision: entry.version,
    };
    if (entry.author !== undefined && entry.author !== '') {
      summary.author = entry.author;
    }
    info.push(summary);
  }
  return info;
}

/**
 * The `display` stand-in `DisplayContentManager` needs.
 *
 * `prepareLink` is the only member the generator calls during generation (it sets
 * `href` / `target` / `rel`; its click listener dies with the element when the
 * markup is serialized). `loadMedia` / `executeMediaRequests` / `openMediaInTab`
 * exist so a media-carrying dictionary cannot crash the preview; nothing ever
 * executes a queued request.
 */
const CONTENT_MANAGER_HOST = {
  application: {
    api: {
      drawMedia: () => {},
      getMedia: async () => [],
    },
  },
};

/** A glossary node as the engine normalizes a bare string into. */
interface TextGlossaryNode {
  type: 'text';
  text: string;
}

function isTextGlossaryNode(node: unknown): node is TextGlossaryNode {
  if (typeof node !== 'object' || node === null) return false;
  const record = node as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string';
}

/**
 * Hand the generator the glossary shape it renders.
 *
 * Non-mutating and minimal: an entry with no `text` node is returned untouched, so
 * a plain-text dictionary pays nothing and a structured-content glossary is passed
 * through exactly as stored.
 */
export function restoreTextGlosses(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) return entry;
  const record = entry as Record<string, unknown>;
  const definitions = record.definitions;
  if (!Array.isArray(definitions)) return entry;

  let definitionsChanged = false;
  const nextDefinitions = definitions.map((definition) => {
    if (typeof definition !== 'object' || definition === null) return definition;
    const definitionRecord = definition as Record<string, unknown>;
    const glosses = definitionRecord.entries;
    if (!Array.isArray(glosses)) return definition;
    let glossesChanged = false;
    const nextGlosses = glosses.map((gloss) => {
      if (!isTextGlossaryNode(gloss)) return gloss;
      glossesChanged = true;
      return gloss.text;
    });
    if (!glossesChanged) return definition;
    definitionsChanged = true;
    return { ...definitionRecord, entries: nextGlosses };
  });

  if (!definitionsChanged) return entry;
  return { ...record, definitions: nextDefinitions };
}

/**
 * The generator every card in this directory is drawn with.
 *
 * It instantiates upstream's own template set and nothing else, so both renderers
 * build it the same way rather than each carrying its own copy of the setup.
 */
async function createPopupGenerator(templates: string): Promise<{
  createTermEntry: (
    entry: unknown,
    dictionaries: PopupDictionaryInfo[],
  ) => HTMLElement;
  createKanjiEntry: (
    entry: unknown,
    dictionaries: PopupDictionaryInfo[],
  ) => HTMLElement;
}> {
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
  return generator as unknown as {
    createTermEntry: (
      entry: unknown,
      dictionaries: PopupDictionaryInfo[],
    ) => HTMLElement;
    createKanjiEntry: (
      entry: unknown,
      dictionaries: PopupDictionaryInfo[],
    ) => HTMLElement;
  };
}

/**
 * Serialize one lookup result set into popup markup.
 *
 * `entries` is what `lookupTerms` returned — the translator's own dictionary
 * entries, already deinflected and merged. An empty array yields an empty string,
 * which is the caller's signal to draw the placeholder.
 */
export async function renderPopupEntriesHtml(
  templates: string,
  entries: readonly unknown[],
  dictionaries: readonly PopupDictionaryInfo[],
): Promise<string> {
  if (entries.length === 0) return '';
  const generator = await createPopupGenerator(templates);

  return entries
    .map((entry) =>
      generator
        .createTermEntry(restoreTextGlosses(entry), [...dictionaries])
        .outerHTML,
    )
    .join('');
}

/**
 * Serialize one lookup's KANJI entries into popup markup.
 *
 * The same generator and the same templates as the term list, one method over:
 * upstream's popup draws a kanji entry with `createKanjiEntry` (onyomi / kunyomi,
 * meanings, the kanji's own tags and frequencies), so a kanji scan gets the
 * extension's kanji card rather than a hand-made block. An empty array yields an
 * empty string, which `buildPopupDocument` draws as the placeholder.
 */
export async function renderPopupKanjiHtml(
  templates: string,
  entries: readonly unknown[],
  dictionaries: readonly PopupDictionaryInfo[],
): Promise<string> {
  if (entries.length === 0) return '';
  const generator = await createPopupGenerator(templates);

  return entries
    .map((entry) => generator.createKanjiEntry(entry, [...dictionaries]).outerHTML)
    .join('');
}
