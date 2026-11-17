/**
 * search-query — the pure decisions behind the dictionary search page (`/search/`).
 * ---------------------------------------------------------------------------
 * The page itself is a React island, but everything it DECIDES lives here, away
 * from the DOM and the dictionary engine:
 *
 * - which of Yomitan's two lookups a search runs first, and in which order it
 *   falls back (`searchLookupOrder` / `searchEntriesForMode`),
 * - which of the four things the results area can show right now
 *   (`resolveSearchOutcome`),
 * - the conversion between this page's own two lookup modes and the popup's
 *   history stack, which is shared with the floating popup and therefore has a
 *   third member this page never pushes (`asSearchMode`).
 *
 * The ORDER is not arbitrary — it is upstream's own `Display._findDictionaryEntries`:
 * the search page starts every query as a TERM lookup and only asks the kanji
 * dictionaries when no term matched, while a kanji clicked in a headword starts as
 * a KANJI lookup and falls back to terms. Getting this backwards is invisible for a
 * word in JMdict and obvious for a single character outside KANJIDIC, so it is
 * written down once here rather than implied by an `if` inside the component.
 *
 * PURE: no window, no options, no engine. The component owns the lookups; this
 * module owns the choices.
 * ---------------------------------------------------------------------------
 */

import type {
  PopupHistoryMode,
} from '@/modules/yomitan/popup-preview/popup-history';

/**
 * Which of Yomitan's two lookups a history entry is drawn from.
 *
 * A subset of `PopupHistoryMode`: the popup's third mode (`scan`) is what a scan
 * of a window of text found, and the search page always looks a query up whole.
 */
export type SearchMode = 'term' | 'kanji';

/** Narrow a history entry's mode to the two this page can draw. */
export function asSearchMode(mode: PopupHistoryMode): SearchMode {
  return mode === 'kanji' ? 'kanji' : 'term';
}

/**
 * The query of one search, as the engine receives it.
 *
 * Upstream's `_search` is exactly this: `this._queryInput.value.trim()`. The
 * leading/trailing whitespace of a pasted sentence is not part of what the user
 * asked for, and the kanji fallback would otherwise be handed a padded string.
 */
export function normalizeSearchQuery(raw: string | null | undefined): string {
  return (raw ?? '').trim();
}

/**
 * The lookup order for one history entry.
 *
 * A two-element tuple, not a set: the first entry is what runs, the second is the
 * fallback, and the caller must stop at the first one that answered. Upstream
 * returns the kanji entries as soon as they are non-empty, and otherwise falls
 * through to the terms — see `Display._findDictionaryEntries`.
 */
export function searchLookupOrder(mode: SearchMode): readonly [SearchMode, SearchMode] {
  return mode === 'kanji' ? ['kanji', 'term'] : ['term', 'kanji'];
}

/** One resolved search: whichever of the two lists actually answered. */
export interface SearchEntries {
  /** Term entries (empty when the KANJI lookup is the one that answered). */
  entries: readonly unknown[];
  /** Kanji entries (empty when the TERM lookup answered). */
  kanjiEntries: readonly unknown[];
}

/** Nothing found — the value a search starts from and ends on when both miss. */
export const EMPTY_SEARCH_ENTRIES: SearchEntries = {
  entries: [],
  kanjiEntries: [],
};

/**
 * File one lookup's answer under the mode that produced it.
 *
 * Exactly one of the two lists is ever non-empty: upstream draws ONE kind of
 * result for a query, so a kanji answer must not also be appended under the term
 * entries (which would draw the same character twice).
 */
export function searchEntriesForMode(
  mode: SearchMode,
  found: readonly unknown[],
): SearchEntries {
  return mode === 'kanji'
    ? { entries: [], kanjiEntries: found }
    : { entries: found, kanjiEntries: [] };
}

/** How many dictionary entries a resolved search holds, of either kind. */
export function countSearchEntries(value: SearchEntries): number {
  return value.entries.length + value.kanjiEntries.length;
}

/** What the results area shows. */
export type SearchOutcome =
  /** Nothing searched yet — the page is waiting for its first query. */
  | 'idle'
  /** A lookup is in flight. */
  | 'loading'
  /**
   * Yomitan's own stylesheets / templates could not be loaded, so no card could
   * be drawn.
   *
   * Kept apart from `no-dictionaries` because the advice differs: this one is a
   * failed asset read (`public/yomitan/` unreachable), not an empty dictionary
   * list, and telling a user to install a dictionary would be wrong.
   */
  | 'unavailable'
  /** No dictionary is installed or enabled, so no lookup can answer. */
  | 'no-dictionaries'
  /** The dictionaries answered, and had nothing. */
  | 'no-results'
  /** Entries to draw. */
  | 'results';

/** Everything the outcome depends on — all of it already resolved by the caller. */
export interface SearchOutcomeInput {
  /** A lookup is in flight for the entry being drawn. */
  loading: boolean;
  /** Yomitan's own sheets and templates were read (see `search-assets`). */
  assetsReady: boolean;
  /** At least one search has been submitted (a history exists). */
  searched: boolean;
  /** The engine has at least one enabled dictionary. */
  hasDictionaries: boolean;
  /** What the current entry resolved to. */
  entries: SearchEntries;
}

/**
 * Which of the page's states to render.
 *
 * ORDER MATTERS and mirrors upstream's own `#no-dictionaries` / `#no-results`
 * blocks: a page with nothing installed says so even before the first search (a
 * lookup there could not have answered), and "No results found." is only ever
 * shown once the dictionaries HAVE answered — otherwise a fresh install would be
 * told its word does not exist.
 *
 * `loading` is checked before everything else so a first search still shows its
 * own progress bar rather than the empty intro, and `assetsReady` next: without
 * Yomitan's sheets a result could not be drawn, so no other state is useful.
 */
export function resolveSearchOutcome(input: SearchOutcomeInput): SearchOutcome {
  if (input.loading) return 'loading';
  if (!input.assetsReady) return 'unavailable';
  if (!input.hasDictionaries) return 'no-dictionaries';
  if (!input.searched) return 'idle';
  return countSearchEntries(input.entries) > 0 ? 'results' : 'no-results';
}