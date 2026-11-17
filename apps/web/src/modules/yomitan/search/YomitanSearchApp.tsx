/**
 * YomitanSearchApp — the Yomitan module's own dictionary search page (`/search/`).
 * ---------------------------------------------------------------------------
 * WHAT THIS IS. Upstream ships a standalone dictionary search page
 * (`ext/search.html`): a search box, and below it the SAME definition cards the
 * popup draws. This is that page, hosted inside Entei: the box, the two buttons,
 * the progress bar and the result column are upstream's own elements and class
 * names, and the cards are upstream's own `DisplayGenerator` output styled by
 * upstream's own stylesheets (see `search-display.ts` / `search-assets.ts`).
 *
 * The module pipeline is what puts it on screen: the manifest declares
 * `tool: { href: '/search/' }`, the Immersion Tools drawer draws a card for it,
 * and this island is the destination.
 *
 * TWO LOOKUPS, IN UPSTREAM'S ORDER. A query starts as a TERM lookup and only
 * falls back to the kanji dictionaries when no term matched; a kanji clicked in a
 * headword starts as a KANJI lookup and falls back to terms. That order is
 * `searchLookupOrder` (`search-query.ts`), with the reasoning written there.
 *
 * HISTORY IS THE BROWSER'S. Every search is a `history.pushState`, and `popstate`
 * re-runs the lookup, so Back steps through the words and characters the way it
 * does in the extension's own tab — same as upstream, which drives the browser
 * history rather than a stack of its own.
 *
 * THE IME CONVERSION IS THE USER'S SETTING. Romaji → kana on a field with no IME
 * is upstream's `general.enableWanakana`, which the Yomitan settings tree already
 * exposes; this page reads it rather than adding a switch of its own, so turning
 * it off in Settings turns it off here too.
 *
 * The lookups themselves are Entei's (`yomitan-engine`, over the Rust dictionary
 * database). Outside the desktop app there is no engine, which reads as "no
 * dictionaries installed" and lands on upstream's own `#no-dictionaries` block.
 * ---------------------------------------------------------------------------
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import './search.css';
import { convertToKanaIME } from '@/modules/yomitan/vendor/js/language/ja/japanese-wanakana.js';
import { listInstalledDictionariesCached } from '@/modules/yomitan/dictionary-store';
import {
  toPopupDictionaryInfo,
  type PopupDictionaryInfo,
} from '@/modules/yomitan/popup-preview/popup-entries';
import { resolvePopupAppearance } from '@/modules/yomitan/popup-preview/popup-theme';
import {
  activeProfileOptions,
  readYomitanOptions,
} from '@/modules/yomitan/yomitan-preferences';
import { lookupKanji, lookupTerms } from '@/modules/yomitan/yomitan-engine';
import { loadSearchAssets } from '@/modules/yomitan/search/search-assets';
import {
  createSearchDisplay,
  type SearchDisplay,
} from '@/modules/yomitan/search/search-display';
import {
  asSearchMode,
  EMPTY_SEARCH_ENTRIES,
  normalizeSearchQuery,
  resolveSearchOutcome,
  searchEntriesForMode,
  searchLookupOrder,
  type SearchEntries,
  type SearchMode,
  type SearchOutcome,
} from '@/modules/yomitan/search/search-query';

/**
 * This page's own English strings.
 *
 * Same reasoning as `module-copy` / the popup preview: a host-owned control's
 * chrome is not manifest data, and this page sits inside the Yomitan module's own
 * English UI.
 */
const SEARCH_COPY = {
  heading: 'Yomitan Search',
  /** Upstream's `#no-dictionaries` sentence, kept word for word. */
  noDictionaries:
    'No dictionaries have been installed or enabled yet.',
  /** Upstream's `#no-results` block. */
  noResults: 'No results found.',
  /** Shown only when Yomitan's own assets could not be read. */
  unavailable:
    'Yomitan’s own stylesheets could not be loaded, so results cannot be drawn.',
  search: 'Search',
  clear: 'Clear',
} as const;

/** The state pushed for one search (what `popstate` reads back). */
interface SearchHistoryState {
  enteiYomitanSearch: { mode: SearchMode; query: string };
}

/** What the page reads from the persisted Yomitan options before searching. */
interface SearchOptions {
  /** Yomitan's theme / display-mode attributes, for the scoped element. */
  attributes: Readonly<Record<string, string>>;
  /** Inline font styles for the scoped element (`general.fontFamily` & co). */
  fontStyle: string;
  /** `general.enableWanakana` — convert typed romaji to kana. */
  ime: boolean;
}

/** Upstream's own default for `general.enableWanakana` (`settings/defaults.ts`). */
const IME_DEFAULT = true;

/**
 * Read the page's appearance and IME setting from the persisted options.
 *
 * Falls back to the vendored sheets' own light theme with the conversion on
 * (upstream's default): a settings tree that cannot be read costs the page the
 * user's theme, while throwing here would cost them the page.
 */
function readSearchOptions(): SearchOptions {
  try {
    const options = readYomitanOptions();
    const appearance = resolvePopupAppearance(options);
    return {
      attributes: appearance.themeAttributes,
      fontStyle: appearance.fontStyle,
      ime: activeProfileOptions(options).general.enableWanakana,
    };
  } catch {
    return { attributes: {}, fontStyle: '', ime: IME_DEFAULT };
  }
}

/** The character a `.headword-kanji-link` stands for (its base text, not `rt`). */
function kanjiLinkCharacter(link: Element): string {
  const base = [...link.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join('')
    .trim();
  if (base !== '') return base;
  // A ruby base with the character wrapped in its own element: fall back to the
  // first character, because `<rt>` holds the READING and is never the answer.
  return [...(link.textContent ?? '')].find((character) => character.trim() !== '') ?? '';
}

/** One search page island. */
export function YomitanSearchApp() {
  const [text, setText] = useState('');
  const [options, setOptions] = useState<SearchOptions>({
    attributes: {},
    fontStyle: '',
    ime: IME_DEFAULT,
  });
  const [assetsReady, setAssetsReady] = useState(false);
  const [hasDictionaries, setHasDictionaries] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [entries, setEntries] = useState<SearchEntries>(EMPTY_SEARCH_ENTRIES);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const entriesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const displayRef = useRef<SearchDisplay | null>(null);
  const dictionariesRef = useRef<readonly PopupDictionaryInfo[]>([]);
  /** Guards a slow lookup from overwriting a newer one. */
  const epochRef = useRef(0);
  /** Caret to restore after the IME conversion rewrote the field. */
  const caretRef = useRef<number | null>(null);
  /** True while an IME composition is in flight — such a field is not romaji. */
  const composingRef = useRef(false);

  /* ------------------------------------------------------------------------
   * Boot: the scoped Yomitan sheets, its generator and the dictionary list.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    setOptions(readSearchOptions());
    void (async () => {
      try {
        const [assets, installed] = await Promise.all([
          loadSearchAssets(),
          // No engine (a browser pass): the same state as an empty install.
          listInstalledDictionariesCached().catch(() => []),
        ]);
        if (cancelled) return;
        const display = await createSearchDisplay(assets.templates);
        if (cancelled) return;
        displayRef.current = display;
        dictionariesRef.current = toPopupDictionaryInfo(installed);
        setHasDictionaries(installed.some((entry) => entry.enabled));
        setAssetsReady(true);
      } catch {
        // Asset read failed — `resolveSearchOutcome` says so instead of drawing
        // cards with no stylesheet.
        if (!cancelled) setAssetsReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Theme attributes land on the SCOPED element, not on <html>: `scope-css.ts`
     re-anchored `:root[data-theme=dark] …` onto this same element. */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    root.style.cssText = options.fontStyle;
    return () => {
      root.style.cssText = '';
    };
  }, [options]);

  /* The IME conversion rewrote the value; put the caret where the converter
     says it went (upstream returns `newSelectionStart` for exactly this). */
  useLayoutEffect(() => {
    const caret = caretRef.current;
    const node = textareaRef.current;
    if (caret === null || node === null || document.activeElement !== node) return;
    caretRef.current = null;
    node.setSelectionRange(caret, caret);
  }, [text]);

  /* ------------------------------------------------------------------------
   * One lookup, in upstream's order.
   * --------------------------------------------------------------------- */
  const runLookup = useCallback(async (mode: SearchMode, query: string) => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    setLoading(true);
    setEntries(EMPTY_SEARCH_ENTRIES);

    let resolved = EMPTY_SEARCH_ENTRIES;
    for (const step of searchLookupOrder(mode)) {
      let found: readonly unknown[] = [];
      try {
        found =
          step === 'kanji' ? await lookupKanji(query) : await lookupTerms(query);
      } catch {
        // No engine to answer: fall through to "nothing found", which is what
        // the caller can render.
        found = [];
      }
      if (epoch !== epochRef.current) return;
      if (found.length > 0) {
        resolved = searchEntriesForMode(step, found);
        break;
      }
    }
    if (epoch !== epochRef.current) return;
    setEntries(resolved);
    setSearched(true);
    setLoading(false);
  }, []);

  /* Draw the resolved entries with Yomitan's own generator.
     Imperative on purpose: the cards are DOM the generator built (with its own
     templates, furigana and pitch-accent graphs), so they are appended rather
     than re-created by React on every render. */
  useEffect(() => {
    const container = entriesRef.current;
    const display = displayRef.current;
    if (container === null || display === null) return;
    const dictionaries = dictionariesRef.current;
    const nodes = [
      ...display.termNodes(entries.entries, dictionaries),
      ...display.kanjiNodes(entries.kanjiEntries, dictionaries),
    ];
    container.replaceChildren(...nodes);
  }, [entries, assetsReady]);

  /* ------------------------------------------------------------------------
   * Navigation: one history entry per search, Back re-runs the lookup.
   * --------------------------------------------------------------------- */
  const search = useCallback(
    (mode: SearchMode, query: string) => {
      const state: SearchHistoryState = { enteiYomitanSearch: { mode, query } };
      window.history.pushState(state, '', window.location.href);
      void runLookup(mode, query);
    },
    [runLookup],
  );

  useEffect(() => {
    const onPopState = (event: PopStateEvent): void => {
      const state = (event.state as SearchHistoryState | null)?.enteiYomitanSearch;
      const query = normalizeSearchQuery(state?.query);
      // Stepping back past the first search: the page returns to its intro.
      epochRef.current += 1;
      if (query === '') {
        setLoading(false);
        setSearched(false);
        setEntries(EMPTY_SEARCH_ENTRIES);
        return;
      }
      void runLookup(asSearchMode(state?.mode ?? 'term'), query);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [runLookup]);

  /* ------------------------------------------------------------------------
   * Field handlers.
   * --------------------------------------------------------------------- */
  const onTextChange = (value: string, caret: number): void => {
    /* A composition is Japanese already on its way in: rewriting it would
       convert the romaji the IME is still holding and mangle the candidate
       text, so the conversion only ever sees committed input. */
    if (!options.ime || composingRef.current) {
      setText(value);
      return;
    }
    const { kanaString, newSelectionStart } = convertToKanaIME(value, caret);
    caretRef.current = newSelectionStart;
    setText(kanaString);
  };

  const clear = (): void => {
    epochRef.current += 1;
    setLoading(false);
    setSearched(false);
    setEntries(EMPTY_SEARCH_ENTRIES);
    setText('');
    caretRef.current = 0;
    textareaRef.current?.focus();
  };

  /** A kanji inside a headword opens that character (upstream's kanji link). */
  const onEntriesClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('.headword-kanji-link');
    if (link === null) return;
    const character = kanjiLinkCharacter(link);
    if (character === '') return;
    // Never navigate: the anchor exists for the pointer and the semantics, the
    // character is looked up here.
    event.preventDefault();
    search('kanji', character);
  };

  const outcome: SearchOutcome = resolveSearchOutcome({
    loading,
    assetsReady,
    searched,
    hasDictionaries,
    entries,
  });
  const showIntro = !searched && outcome !== 'loading';

  return (
    <div
      className="entei-yomitan-search"
      data-page-type="search"
      ref={rootRef}
      {...options.attributes}
    >
      {showIntro ? (
        <div className="entei-yomitan-search-intro">
          <h1>{SEARCH_COPY.heading}</h1>
        </div>
      ) : null}

      <div className="entei-yomitan-search-header">
        <div className="top-progress-bar-container" aria-hidden="true">
          <div
            className="progress-bar-indeterminant"
            data-active={loading}
            hidden={!loading}
          />
        </div>
        <form
          className="search-textbox-container"
          onSubmit={(event) => {
            event.preventDefault();
            search('term', text);
          }}
        >
          <textarea
            aria-label={SEARCH_COPY.search}
            className="search-textbox"
            id="search-textbox"
            placeholder={SEARCH_COPY.search}
            ref={textareaRef}
            rows={1}
            spellCheck={false}
            value={text}
            onChange={(event) =>
              onTextChange(
                event.currentTarget.value,
                event.currentTarget.selectionStart ?? 0,
              )
            }
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onKeyDown={(event) => {
              /* Enter searches, Shift+Enter is a newline, and a keystroke that
                 is still part of an IME composition is never a submit. */
              if (event.key !== 'Enter' || event.shiftKey) return;
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              search('term', event.currentTarget.value);
            }}
          />
          <button
            className="clear-button"
            title={SEARCH_COPY.clear}
            type="button"
            onClick={clear}
          >
            <span aria-hidden="true" className="icon" data-icon="cross" />
          </button>
          <button
            className="search-button"
            title={SEARCH_COPY.search}
            type="submit"
          >
            <span
              aria-hidden="true"
              className="icon"
              data-icon="magnifying-glass"
            />
          </button>
        </form>
      </div>

      <div className="content-outer">
        <div className="content">
          <div className="content-scroll">
            <div className="content-body">
              <div className="content-body-inner">
                <div
                  aria-live="polite"
                  aria-busy={loading}
                  id="dictionary-entries"
                  ref={entriesRef}
                  onClick={onEntriesClick}
                />
                <div
                  className="entry"
                  hidden={outcome !== 'no-dictionaries'}
                  id="no-dictionaries"
                >
                  <p>{SEARCH_COPY.noDictionaries}</p>
                </div>
                <div className="entry" hidden={outcome !== 'no-results'} id="no-results">
                  <p>{SEARCH_COPY.noResults}</p>
                </div>
                <div className="entry" hidden={outcome !== 'unavailable'}>
                  <p>{SEARCH_COPY.unavailable}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}