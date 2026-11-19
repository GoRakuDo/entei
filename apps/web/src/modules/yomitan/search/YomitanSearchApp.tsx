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
 * THE CLIPBOARD CAN FILL THE FIELD BY ITSELF. `clipboard.enableSearchPageMonitor`
 * (Settings → Yomitan → Search window → "Clipboard monitor") makes this page follow
 * the OS clipboard: text copied in another app shows up in the box and is looked up.
 * The read is native, because a page cannot read the clipboard
 * (`readClipboardTextDirect` → `plugin:modules|modules_clipboard_read_text`); what
 * is sampled and when is `use-clipboard-monitor.ts`, and its rules matter here — the
 * monitor reads the clipboard as it opens and remembers THAT as its baseline, so the
 * text that was already there is never searched, while the first thing copied
 * afterwards is (a baseline left empty until the first sample would drop exactly
 * that copy).
 *
 * The lookups themselves are Entei's (`yomitan-engine`, over the Rust dictionary
 * database). Outside the desktop app there is no engine, which reads as "no
 * dictionaries installed" and lands on upstream's own `#no-dictionaries` block.
 *
 * THE TEXT IS ALSO PARSED, NOT ONLY LOOKED UP. Under the box sits upstream's own
 * `#query-parser-container`: the same text again, segmented word by word with a
 * reading over each segment, so a sentence reads as Japanese rather than as a wall
 * of kanji. Clicking a word there looks THAT word up and leaves the box alone —
 * the sentence stays where the user typed it (see `search/query-parser.ts`, and
 * `yomitan-engine.parseTextScanning` for the parser itself).
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
import { toDataAttributes } from '@/modules/yomitan/popup-preview/popup-document';
import { resolvePopupAppearance } from '@/modules/yomitan/popup-preview/popup-theme';
import {
  activeProfileOptions,
  readYomitanOptions,
} from '@/modules/yomitan/yomitan-preferences';
import {
  lookupKanji,
  lookupTerms,
  parseTextScanning,
} from '@/modules/yomitan/yomitan-engine';
import { loadSearchAssets } from '@/modules/yomitan/search/search-assets';
import {
  DEFAULT_QUERY_PARSER_SETTINGS,
  queryParserOffsetAt,
  queryParserQueryAt,
  readQueryParserSettings,
  renderQueryParser,
  renderQueryParserPreview,
  type QueryParserSettings,
} from '@/modules/yomitan/search/query-parser';
import {
  createSearchDisplay,
  setCurrentEntry,
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
import { useClipboardMonitor } from '@/modules/yomitan/search/use-clipboard-monitor';

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

/**
 * Quiet period before the furigana header re-parses the sentence.
 *
 * The live search's own window (`LIVE_SEARCH_DELAY_MS`), on purpose: parsing is one
 * dictionary round trip per window of the text, so parsing on every keystroke ran a
 * pass over the whole sentence for a header that is about to be replaced — and tying
 * it to the same delay makes the header and the cards settle on the same keystroke.
 */
const QUERY_PARSER_DELAY_MS = LIVE_SEARCH_DELAY_MS;

/** The state pushed for one search (what `popstate` reads back). */
interface SearchHistoryState {
  enteiYomitanSearch: { mode: SearchMode; query: string };
}

/** What the page reads from the persisted Yomitan options before searching. */
interface SearchOptions {
  /**
   * Yomitan's theme / display-mode values under their `dataset` NAMES (`theme`,
   * `outerTheme`, …) — the shape `ThemeController` writes, which
   * `toDataAttributes` turns into the attributes the scoped stylesheets match.
   */
  attributes: Readonly<Record<string, string>>;
  /** Inline font styles for the scoped element (`general.fontFamily` & co). */
  fontStyle: string;
  /** `general.enableWanakana` — convert typed romaji to kana. */
  ime: boolean;
  /**
   * `general.stickySearchHeader` — pin the box to the top while the cards scroll.
   *
   * Upstream means this literally (its search window scrolls its own result
   * column under a fixed header); here it is the same intent on a page that
   * scrolls with the document — see the `[data-sticky-search-header]` rule in
   * `search.css`.
   */
  stickyHeader: boolean;
  /** The furigana header's switches (`parsing.*` and the scan window). */
  queryParser: QueryParserSettings;
  /**
   * `clipboard.enableSearchPageMonitor` — follow the OS clipboard.
   *
   * Upstream's own switch, already in this host's Yomitan settings tree; this
   * page is the surface that finally acts on it.
   */
  clipboardMonitor: boolean;
}

/** Upstream's own default for `general.enableWanakana` (`settings/defaults.ts`). */
const IME_DEFAULT = true;

/** Upstream's own default for `general.stickySearchHeader` (off). */
const STICKY_HEADER_DEFAULT = false;

/** Upstream's own default for `clipboard.enableSearchPageMonitor` (off). */
const CLIPBOARD_MONITOR_DEFAULT = false;

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
    const profile = activeProfileOptions(options);
    return {
      attributes: appearance.themeAttributes,
      fontStyle: appearance.fontStyle,
      ime: profile.general.enableWanakana,
      stickyHeader: profile.general.stickySearchHeader,
      queryParser: readQueryParserSettings(profile),
      clipboardMonitor: profile.clipboard.enableSearchPageMonitor,
    };
  } catch {
    return {
      attributes: {},
      fontStyle: '',
      ime: IME_DEFAULT,
      stickyHeader: STICKY_HEADER_DEFAULT,
      queryParser: DEFAULT_QUERY_PARSER_SETTINGS,
      clipboardMonitor: CLIPBOARD_MONITOR_DEFAULT,
    };
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
    stickyHeader: STICKY_HEADER_DEFAULT,
    queryParser: DEFAULT_QUERY_PARSER_SETTINGS,
    clipboardMonitor: CLIPBOARD_MONITOR_DEFAULT,
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
  /** Upstream's `#query-parser-content` — the header the parse is drawn into. */
  const parserRef = useRef<HTMLDivElement | null>(null);
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
   * The furigana header — upstream's `#query-parser-container`.
   * ----------------------------------------------------------------------- */
  useEffect(() => {
    const container = parserRef.current;
    if (container === null) return;
    const settings = options.queryParser;
    /* Upstream's own dataset switches, read by the vendored `display.css`:
       `data-term-spacing` is what puts a gap between parsed terms, and
       `data-parsed` says whether the ruby on screen is real or a preview. */
    container.dataset.termSpacing = `${settings.termSpacing}`;
    container.dataset.parsed = 'false';
    /* The unparsed text goes in FIRST, the way upstream's `_setPreview` does: the
       header then always shows the sentence, so a slow parse (or one that fails)
       costs the ruby rather than the whole header. */
    container.replaceChildren(renderQueryParserPreview(text));
    /* Deliberately NOT gated on `composing`: the header is the sentence as it is
       typed, and holding the preview back for the whole composition only made the
       ruby appear (and the header jump) at the moment the composition ENDED. The
       parse is debounced instead, so an in-flight composition costs no extra work. */
    if (!assetsReady) return;
    if (!settings.enabled) return;
    if (normalizeSearchQuery(text) === '') return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void parseTextScanning(text, { scanLength: settings.scanLength })
        .then((lines) => {
          if (cancelled) return;
          container.replaceChildren(renderQueryParser(lines, settings));
          container.dataset.parsed = 'true';
        })
        .catch((error: unknown) => {
          /* MUST NOT ESCAPE — same reasoning as the card drawing below: this runs
             in the commit phase, where a throw unmounts the whole island. The preview
             already on screen is the fallback. */
          if (cancelled) return;
          console.error('[entei] Yomitan could not parse the search text', error);
        });
    }, QUERY_PARSER_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text, options, assetsReady]);

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
   * Clipboard monitor — `clipboard.enableSearchPageMonitor`.
   * -----------------------------------------------------------------------
   * The field follows the OS clipboard, which only the native side can read, and it
   * follows it whether or not this window has focus (see `clipboard-monitor.ts`).
   * What is on the clipboard as the page opens is remembered as the baseline and
   * never searched; the first thing copied afterwards is.
   *
   * The monitor starts at mount, before dictionary assets finish loading, so a
   * copy made while those assets load is already part of its baseline. The lookup
   * itself still waits for assetsReady in search(), so an early copy is not searched
   * before cards can be drawn.
   *
   * The query comes from the clipboard, so it is NOT run back through the romaji
   * converter the way a keystroke is (nothing was typed) and no caret is placed (this
   * fires while the user is in ANOTHER window, and a caret parked for a field that is
   * not focused would fire later, on the next keystroke somewhere else in the box).
   * 'replace', never 'push' — a clipboard sample is not a navigation, and one history
   * entry per copy would leave Back walking through everything the clipboard held. */
  const onClipboardSearch = useCallback(
    (query: string) => {
      setText(query);
      search('term', query, 'replace');
    },
    [search],
  );
  useClipboardMonitor({
    enabled: options.clipboardMonitor,
    onSearch: onClipboardSearch,
  });

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

  /**
   * A click in the results: the selection indicator follows it, and a kanji inside a
   * headword opens that character.
   *
   * Moving the indicator is upstream's own `Display._onEntryClick` →
   * `_entrySetCurrent` (it reads `dataset.index` off the clicked entry). It is done
   * here rather than in state because the cards are the generator's own DOM, appended
   * imperatively under this one delegated handler. Both of upstream's listeners also
   * fire for a kanji link — the link's own and then the entry's — so there the
   * indicator moves AND the character is looked up.
   */
  const onEntriesClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const container = event.currentTarget;
    const entry = target.closest('.entry[data-index]');
    /* Only a card THIS page appended: upstream's `#no-results` style placeholders
       are `.entry` too, but they sit outside this container, and a nested `.entry`
       inside a card is not a result. */
    if (entry !== null && entry.parentElement === container) {
      setCurrentEntry(container, entry);
    }
    const link = target.closest('.headword-kanji-link');
    if (link === null) return;
    const character = kanjiLinkCharacter(link);
    if (character === '') return;
    // Never navigate: the anchor exists for the pointer and the semantics, the
    // character is looked up here.
    event.preventDefault();
    search('kanji', character);
  };

  /**
   * A click in the furigana header: look the clicked WORD up.
   *
   * Upstream's own link between the two (its `TextScanner` is created over
   * `#query-parser-content` with `searchOnClick: true`, and `Display._onQueryParserSearch`
   * searches `textSource.text()`). The window is `scanning.length` characters from the
   * clicked segment, so an inflected stem still resolves through the deinflector.
   *
   * The BOX is deliberately left untouched: the header is the sentence the user typed,
   * and rewriting the field to the clicked word would take the sentence away — which
   * is what this page's own contract says (see the module header). This is a
   * navigation, so it PUSHES a history entry: Back returns to the sentence.
   *
   * The pointer's own coordinates go with the click (`clientX` / `clientY`), so the
   * offset is the CHARACTER under the pointer and not merely the segment's start —
   * clicking the middle of a ruby word looks THAT character up.
   */
  const onQueryParserClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    const offset = queryParserOffsetAt(
      event.currentTarget,
      target instanceof Element ? target : null,
      event.clientX,
      event.clientY,
    );
    if (offset === null) return;
    const query = normalizeSearchQuery(
      queryParserQueryAt(text, offset, options.queryParser.scanLength),
    );
    if (query === '') return;
    search('term', query);
  };

  const outcome: SearchOutcome = resolveSearchOutcome({
    loading,
    assetsReady,
    searched,
    hasDictionaries,
    entries,
  });

  /* The dataset names `resolvePopupAppearance` returns become real `data-`
     attributes here. Spread as-is they would reach React as unknown props and be
     lowercased by `setAttribute` into `theme="dark"` / `outertheme="dark"` —
     attributes no selector matches: every vendored rule is anchored on
     `:root[data-theme=dark]`, which `scope-css` re-anchored onto THIS element, so
     the whole page drew light whatever the user's theme was. */
  const themeAttributes = toDataAttributes(options.attributes);

  return (
    <div
      className="entei-yomitan-search"
      data-page-type="search"
      ref={rootRef}
      {...themeAttributes}
    >
      <div
        className="entei-yomitan-search-header"
        /* `general.stickySearchHeader`, read once with the rest of the options:
           the attribute is what the sheet keys the pinned header on, so the page
           adds no second source of truth for it. */
        data-sticky-search-header={options.stickyHeader ? 'true' : 'false'}
      >
        {/* The heading is INSIDE this block, as its first child, and stays there at
            every scroll position — that is the whole point of it being here rather
            than in a block of its own above.

            Two things went wrong with the sibling `#intro` div this replaces. Its
            own box ended at the heading, while this block's `padding-block-start`
            is the clearance for the page's chrome (the floating desktop pill / the
            sticky mobile TopBar) — so that whole 72px band was spent BETWEEN the
            title and the search box and read as dead space. And once
            `stickySearchHeader` pinned this block, the title stayed at the top of
            the document while the box scrolled away underneath it.

            Upstream collapses its intro block once a query is on screen; this page
            keeps the title always (a heading that vanished on the first keystroke
            would yank the box up as the results arrive), and inside this block the
            chrome clearance is the space ABOVE the title, which is what the pill
            occupies. */}
        <h1>{SEARCH_COPY.heading}</h1>

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

        {/* Upstream's own query-parser block (`ext/search.html`): the text of the
            box again, segmented with furigana, where a click looks that word up.
            No `scrollbar` class — the vendored dark `.scrollbar` rules would bring
            back the chunky light bar this app replaces globally with its own 6px
            one. */}
        <div
          hidden={composing || text.length === 0}
          id="query-parser-container"
        >
          <div
            id="query-parser-content"
            lang="ja"
            ref={parserRef}
            onClick={onQueryParserClick}
          />
        </div>
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