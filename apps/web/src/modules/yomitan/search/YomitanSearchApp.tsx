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
 * THE RESULTS FOLLOW THE FIELD. Typing searches on its own after a short quiet
 * period, and it REPLACES the current history entry rather than pushing one, so the
 * tab holds the word being typed instead of one entry per keystroke. Enter (or the
 * magnifier) searches at once; on the word already on screen it pushes nothing,
 * because a second identical entry would make Back look broken.
 *
 * HISTORY IS THE BROWSER'S. Opening a kanji from a headword is the navigation that
 * does push, and `popstate` re-runs the lookup, so Back returns to the word the
 * character was opened from — the same browser history upstream drives, rather than
 * a stack of its own.
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

/**
 * Quiet period before the results follow the field on their own.
 *
 * Long enough that a word typed at speed is looked up once rather than once per
 * keystroke, short enough that the cards are there by the time the user looks
 * down at them. Upstream has no such delay because upstream only ever searches on
 * Enter; this page does both (see the live-search effect).
 */
const LIVE_SEARCH_DELAY_MS = 300;

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
  /**
   * An IME composition is in flight, so the field holds the romaji the IME is
   * still converting rather than a query.
   *
   * State, not a ref: the live-search effect below has to RE-RUN when the
   * composition ends, and a ref would not wake it. The synchronous guard inside
   * onTextChange reads the event's own isComposing flag instead, so the two never
   * disagree about the keystroke in front of them.
   */
  const [composing, setComposing] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const entriesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const displayRef = useRef<SearchDisplay | null>(null);
  const dictionariesRef = useRef<readonly PopupDictionaryInfo[]>([]);
  /** Guards a slow lookup from overwriting a newer one. */
  const epochRef = useRef(0);
  /**
   * The normalized query the cards on screen were drawn from, or '' for none.
   *
   * What keeps the live search from re-running a lookup that has already
   * happened — the field being restored from history being the case that matters,
   * because there the text changes without the user having typed anything.
   */
  const lastLookupRef = useRef('');
  /** Caret to restore after the IME conversion rewrote the field. */
  const caretRef = useRef<number | null>(null);

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
    /* Recorded BEFORE the first await, so anything that changes the field while
       this lookup is still running (history navigation, above all) is already
       covered when the live-search effect re-runs. */
    lastLookupRef.current = normalizeSearchQuery(query);
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
    /* Built off-DOM, so a card the generator could not draw never leaves a
       half-replaced list behind — and appended one at a time, because one lookup
       can resolve to thousands of entries and a single spread into append() would
       put every one of them through an argument list. */
    const fragment = document.createDocumentFragment();
    try {
      for (const node of display.termNodes(entries.entries, dictionaries)) {
        fragment.append(node);
      }
      for (const node of display.kanjiNodes(entries.kanjiEntries, dictionaries)) {
        fragment.append(node);
      }
    } catch (error) {
      /* MUST NOT ESCAPE. This effect runs in the commit phase: a throw here is
         uncaught by React and unmounts the whole tree, so one entry the generator
         choked on took the entire island with it — pressing Enter did not draw
         zero cards, it erased the page. The search now survives without cards
         and the console says which draw failed. */
      console.error('[entei] Yomitan could not draw the search results', error);
    }
    container.replaceChildren(fragment);
  }, [entries, assetsReady]);

  /* ------------------------------------------------------------------------
   * Navigation: one history entry per search, Back re-runs the lookup.
   * --------------------------------------------------------------------- */
  const search = useCallback(
    (mode: SearchMode, query: string, historyMode: 'push' | 'replace' = 'push') => {
      const state: SearchHistoryState = { enteiYomitanSearch: { mode, query } };
      const current = (window.history.state as SearchHistoryState | null)
        ?.enteiYomitanSearch;
      const alreadyHere =
        current !== undefined &&
        asSearchMode(current.mode) === mode &&
        normalizeSearchQuery(current.query) === query;
      /* Enter on the query the page is ALREADY showing must not stack a second
         history entry: Back would then appear to do nothing, which is how a
         pressed-again search usually reads as broken. */
      if (historyMode === 'replace' || alreadyHere) {
        window.history.replaceState(state, '', window.location.href);
      } else {
        window.history.pushState(state, '', window.location.href);
      }
      void runLookup(mode, query);
    },
    [runLookup],
  );

  /* ------------------------------------------------------------------------
   * Live search — the results follow the field; Enter only CONFIRMS the entry.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    /* A composition is Japanese on its way in: the field's value is still the
       romaji the IME is holding, so a lookup here would search for "ka" while the
       user is typing か. Composing is a dependency, so the search arms itself
       again the moment the composition ends — no further keystroke needed. */
    if (composing) return;
    const query = normalizeSearchQuery(text);
    /* An empty field is the page's intro, not a search for the empty string. */
    if (query === '' || !assetsReady) return;
    /* Already the query on screen — Back/Forward just landed on it, or the user
       deleted their way back to the word that is drawn. Looking it up again would
       cost an engine round trip to redraw the same cards. Deliberately NOT keyed
       on the lookup mode: a kanji reached by clicking a headword is the same
       string in the field, and re-running it as a term search there would both
       redraw the wrong card and overwrite that history entry. */
    if (lastLookupRef.current === query) return;
    const timer = window.setTimeout(() => {
      /* Re-checked: a composition can still be running after this timer was
         armed, and its own end is what re-arms the search. */
      if (composing) return;
      /* 'replace', never 'push': typing is not a navigation, and one push per
         keystroke would leave Back walking through the letters of the word. The
         entries Back can step through are the ones actually navigated to — a
         kanji opened from a headword. */
      search('term', query, 'replace');
    }, LIVE_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text, composing, assetsReady, search]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent): void => {
      const state = (event.state as SearchHistoryState | null)?.enteiYomitanSearch;
      const query = normalizeSearchQuery(state?.query);
      // Stepping back past the first search: the page returns to its intro.
      epochRef.current += 1;
      /* The field follows history, so Back shows the word it went back to rather
         than the one the user had typed last. Set directly, not through
         onTextChange: this is a query being RESTORED, and running it back through
         the romaji converter would rewrite what the user actually searched for. */
      setText(query);
      if (query === '') {
        setLoading(false);
        setSearched(false);
        setEntries(EMPTY_SEARCH_ENTRIES);
        lastLookupRef.current = '';
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
  const onTextChange = (
    value: string,
    caret: number,
    isComposing: boolean,
  ): void => {
    /* A composition is Japanese already on its way in: rewriting it would
       convert the romaji the IME is still holding and mangle the candidate
       text, so the conversion only ever sees committed input. */
    if (!options.ime || isComposing) {
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
    /* Nothing is drawn any more, so the same query typed again has to search. */
    lastLookupRef.current = '';
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

  return (
    <div
      className="entei-yomitan-search"
      data-page-type="search"
      ref={rootRef}
      {...options.attributes}
    >
      {/* ALWAYS in the layout. Upstream collapses its intro block once a query
          is on screen, but this page searches as the user types: a heading that
          disappeared on the first keystroke would yank the search box up the very
          moment the results start arriving. A full page keeps its title. */}
      <div className="entei-yomitan-search-intro">
        <h1>{SEARCH_COPY.heading}</h1>
      </div>

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
                (event.nativeEvent as InputEvent).isComposing === true,
              )
            }
            onCompositionEnd={() => {
              setComposing(false);
            }}
            onCompositionStart={() => {
              setComposing(true);
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