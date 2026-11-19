/**
 * Yomitan Search unit tests — the pure half of `/search/`.
 *
 * Covers:
 * - `scopeYomitanCss`: Yomitan's own stylesheets re-anchored at one element
 *   (theme rules, window-level rules, `@keyframes`, declaration values)
 * - the REAL vendored sheets: after scoping, no rule can escape the column
 * - `search-display`: the bookkeeping the cards carry — `data-index` on every entry
 *   and `entry-current` on the focused one (upstream `Display._setContent` /
 *   `_entrySetCurrent`), asserted on plain nodes rather than on generator output
 * - `search-query`: the lookup order, the entry bookkeeping and the five/six
 *   states the results area can be in
 * - `clipboard-monitor`: what one sample of the OS clipboard means — the baseline
 *   that is never searched, the blank/unchanged samples that are not queries, and
 *   the focus gate the Windows/Android clipboard rules impose
 * - `query-parser`: the furigana header — the options it reads, the markup
 *   upstream's own `display.css` styles, and how a click resolves to a lookup
 *
 * The React island and the cards the generator itself builds are deliberately NOT
 * covered here: everything worth asserting about them is either a decision (this
 * file) or a rendered pixel (verified in the browser).
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultProfileOptions } from '@gorakudo/yomitan-headless/settings';
import {
  scopeSelectorList,
  scopeYomitanCss,
  YOMITAN_SEARCH_SCOPE,
} from '@/modules/yomitan/search/scope-css';
import {
  markSearchEntries,
  setCurrentEntry,
} from '@/modules/yomitan/search/search-display';
import {
  CLIPBOARD_POLL_INTERVAL_MS,
  classifyClipboardSample,
  isTextLookupWorthy,
  MAXIMUM_SEARCH_LENGTH,
  normalizeClipboardText,
  truncateSearchText,
} from '@/modules/yomitan/search/clipboard-monitor';
import {
  asSearchMode,
  countSearchEntries,
  EMPTY_SEARCH_ENTRIES,
  normalizeSearchQuery,
  resolveSearchOutcome,
  searchEntriesForMode,
  searchLookupOrder,
  searchParamsToLookup,
} from '@/modules/yomitan/search/search-query';
import {
  convertSegmentReading,
  DEFAULT_QUERY_PARSER_SETTINGS,
  queryParserOffsetAt,
  queryParserQueryAt,
  readQueryParserSettings,
  renderQueryParser,
  renderQueryParserPreview,
  type QueryParserSettings,
} from '@/modules/yomitan/search/query-parser';
import type { TermParseLine } from '@/modules/yomitan/yomitan-engine';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const YOMITAN_CSS_DIR = path.resolve(HERE, '../public/yomitan/css');

/** One vendored sheet, read from disk. */
function vendoredCss(name: string): string {
  return fs.readFileSync(path.join(YOMITAN_CSS_DIR, name), 'utf8');
}

/** Strip comments, so an assertion about a RULE cannot be satisfied by prose. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Drop every at-rule block (`@keyframes … { … }`), whose inner preludes are
 * keyframe selectors rather than rules.
 */
function withoutAtRules(css: string): string {
  let out = '';
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open === -1) return out + css.slice(index);
    const prelude = css.slice(index, open).trim();
    if (!prelude.startsWith('@')) {
      const end = css.indexOf('}', open);
      if (end === -1) return out + css.slice(index);
      out += `${css.slice(index, end + 1)} `;
      index = end + 1;
      continue;
    }
    let depth = 0;
    let end = open;
    for (; end < css.length; end += 1) {
      if (css.charAt(end) === '{') depth += 1;
      else if (css.charAt(end) === '}' && (depth -= 1) === 0) break;
    }
    index = end + 1;
  }
  return out;
}

/** Every selector of every rule in a stylesheet (top level only, verbatim). */
function selectorsOf(css: string): string[] {
  return withoutAtRules(stripComments(css))
    .split('}')
    .map((chunk) => chunk.split('{')[0] ?? '')
    .map((prelude) => prelude.trim())
    .filter((prelude) => prelude !== '' && !prelude.startsWith('@'));
}

describe('scopeYomitanCss — selector re-anchoring', () => {
  it('retargets the theme variables onto the scoped element', () => {
    const css = ':root { --text-color: #000000; }';
    expect(scopeYomitanCss(css, '.scope')).toBe(
      '.scope { --text-color: #000000; }',
    );
  });

  it('keeps the theme attributes and the rest of a root-anchored selector', () => {
    const css = ':root[data-theme=dark] .tag { color: white; }';
    expect(scopeYomitanCss(css, '.scope')).toBe(
      '.scope[data-theme=dark] .tag { color: white; }',
    );
  });

  it('handles :root inside a negation', () => {
    const css = ':root:not([data-theme=light]) .scrollbar { width: auto; }';
    expect(scopeYomitanCss(css, '.scope')).toBe(
      '.scope:not([data-theme=light]) .scrollbar { width: auto; }',
    );
  });

  it('makes a window-level selector a descendant nothing can match', () => {
    // `body { overflow: hidden }` must not reach the page that hosts the results.
    const css = 'body {\n    overflow: hidden;\n}';
    expect(scopeYomitanCss(css, '.scope')).toBe(
      '.scope body {\n    overflow: hidden;\n}',
    );
  });

  it('prefixes an ordinary rule', () => {
    expect(scopeYomitanCss('.entry { display: block; }', '.scope')).toBe(
      '.scope .entry { display: block; }',
    );
  });

  it('re-anchors every member of a selector list independently', () => {
    const css = ':root[data-theme=dark] .a,\nh2,\n:root .b { margin: 0; }';
    expect(scopeYomitanCss(css, '.scope')).toBe(
      '.scope[data-theme=dark] .a,\n.scope h2,\n.scope .b { margin: 0; }',
    );
  });

  it('never splits a selector list inside :is() / :not() / attribute values', () => {
    expect(scopeSelectorList(':is(.a, .b) > :not(.c, .d)', '.scope')).toBe(
      '.scope :is(.a, .b) > :not(.c, .d)',
    );
  });
});

describe('scopeYomitanCss — blocks it must not rewrite', () => {
  it('copies @keyframes verbatim, so the four animations keep working', () => {
    const css = [
      '@keyframes progress-bar-indeterminant1a {',
      '    0% { left: 100%; }',
      '    25% { left: 0; }',
      '    100% { left: 0; }',
      '}',
      '.bar::before {',
      '    animation: progress-bar-indeterminant1a 2s infinite;',
      '}',
    ].join('\n');
    const scoped = scopeYomitanCss(css, '.scope');
    expect(scoped).toContain(css.slice(0, css.indexOf('.bar')));
    expect(scoped).toContain('.scope .bar::before {');
    // The animation NAME still resolves to the untouched keyframes.
    expect(scoped).toContain('animation: progress-bar-indeterminant1a 2s infinite');
  });

  it('recurses into an at-rule that does contain rules', () => {
    const css = '@media (min-width: 40em) { .entry { color: red; } }';
    expect(scopeYomitanCss(css, '.scope')).toBe(
      '@media (min-width: 40em) { .scope .entry { color: red; } }',
    );
  });

  it('reads an at-rule behind its leading comment, not the comment as a selector', () => {
    // A stylesheet puts `/* Progress bar */` on the line above the block, so the
    // comment is part of that prelude. Classified by its first character it would
    // read as a selector and swallow the keyframes into a rule matching nothing.
    const css = [
      '/* Progress bar */',
      '@keyframes a {',
      '    0% { left: 0; }',
      '    100% { left: 100%; }',
      '}',
      '.bar {',
      '    animation: a 2s infinite;',
      '}',
    ].join('\n');
    expect(scopeYomitanCss(css, '.scope')).toBe(
      [
        '/* Progress bar */',
        '@keyframes a {',
        '    0% { left: 0; }',
        '    100% { left: 100%; }',
        '}',
        '.scope .bar {',
        '    animation: a 2s infinite;',
        '}',
      ].join('\n'),
    );
  });

  it('leaves a statement at-rule alone', () => {
    expect(scopeYomitanCss('@import "x.css";\n.a { color: red; }', '.scope')).toBe(
      '@import "x.css";\n.scope .a { color: red; }',
    );
  });

  it('does not mistake a semicolon inside a value for the end of a statement', () => {
    const css = '.a { background: url("data:image/svg+xml;base64,PHN2Zz4="); }';
    expect(scopeYomitanCss(css, '.scope')).toBe(`.scope ${css}`);
  });

  it('does not mistake a brace inside a string for a block edge', () => {
    const css = '.a { --content: "{" content: "}"; }';
    expect(scopeYomitanCss(css, '.scope')).toBe(`.scope ${css}`);
  });

  it('copies a trailing fragment instead of dropping it', () => {
    expect(scopeYomitanCss('.a { color: red; }\n\n/* tail', '.scope')).toBe(
      '.scope .a { color: red; }\n\n/* tail',
    );
  });
});

describe('scopeYomitanCss — the real vendored sheets', () => {
  const sheets = [
    'material.css',
    'display.css',
    'display-pronunciation.css',
    'structured-content.css',
  ];

  it('leaves no rule outside the scoped element', () => {
    for (const name of sheets) {
      const scoped = scopeYomitanCss(vendoredCss(name), YOMITAN_SEARCH_SCOPE);
      for (const selector of selectorsOf(scoped)) {
        // Every selector either IS the scope (a `:root` rule) or sits under it.
        const inside =
          selector === YOMITAN_SEARCH_SCOPE ||
          selector.startsWith(`${YOMITAN_SEARCH_SCOPE} `) ||
          selector.startsWith(`${YOMITAN_SEARCH_SCOPE}.`) ||
          selector.startsWith(`${YOMITAN_SEARCH_SCOPE}[`) ||
          selector.startsWith(`${YOMITAN_SEARCH_SCOPE}:`);
        expect(inside).toBe(true);
      }
      // The two rules that would have restyled the HOST page are gone.
      expect(scoped).not.toMatch(/(^|\})\s*body\s*\{/);
      expect(scoped).not.toMatch(/(^|\})\s*:root\s*\{/);
    }
  });

  it('keeps the theme blocks, which is what makes the cards follow the theme', () => {
    const material = scopeYomitanCss(vendoredCss('material.css'), YOMITAN_SEARCH_SCOPE);
    const display = scopeYomitanCss(vendoredCss('display.css'), YOMITAN_SEARCH_SCOPE);
    expect(material).toContain(`${YOMITAN_SEARCH_SCOPE} {`);
    expect(material).toContain(`${YOMITAN_SEARCH_SCOPE}[data-theme=dark] {`);
    expect(display).toContain(`${YOMITAN_SEARCH_SCOPE} .entry`);
  });

  it('leaves the vendored stylesheets themselves untouched', () => {
    // The rewrite happens at load time; a hand-patched sheet would drift.
    expect(vendoredCss('display.css')).toMatch(/^:root \{/m);
    expect(vendoredCss('material.css')).toMatch(/^body \{/m);
  });
});

describe('search-display — the selection indicator', () => {
  /** One stand-in for a card the generator drew. */
  function card(): HTMLElement {
    const node = document.createElement('div');
    node.className = 'entry';
    return node;
  }

  it('numbers every card and marks the first one current', () => {
    const cards = [card(), card(), card()];
    const marked = markSearchEntries(cards);
    // The generator's own nodes, not copies: a drawn card is never rebuilt.
    expect(marked.length).toBe(3);
    expect(marked[0]).toBe(cards[0]);
    expect(cards.map((node) => node.dataset.index)).toEqual(['0', '1', '2']);
    /* Upstream's search page always focuses the first result
       (`SearchDisplayController._search` → `state.focusEntry = 0`), and
       `display.css` keys the indicator off `.entry.entry-current`. */
    expect(
      cards.map((node) => node.classList.contains('entry-current')),
    ).toEqual([true, false, false]);
  });

  it('marks the entry upstream would focus, not blindly the first', () => {
    const cards = [card(), card(), card()];
    markSearchEntries(cards, 1);
    expect(
      cards.map((node) => node.classList.contains('entry-current')),
    ).toEqual([false, true, false]);
  });

  it('moves the marker onto the clicked card and off the previous one', () => {
    const first = card();
    const second = card();
    const container = document.createElement('div');
    container.append(first, second);
    markSearchEntries([first, second]);

    setCurrentEntry(container, second);

    expect(first.classList.contains('entry-current')).toBe(false);
    expect(second.classList.contains('entry-current')).toBe(true);
    expect(second.dataset.index).toBe('1');
  });

  it('only ever moves the marker between the result list’s own cards', () => {
    // An `.entry` nested INSIDE a card is part of that card, not a result: `:scope >`
    // is what keeps a click deep in a glossary from stealing the marker.
    const nested = card();
    nested.classList.add('entry-current');
    const first = card();
    const second = card();
    second.append(nested);
    const container = document.createElement('div');
    container.append(first, second);
    markSearchEntries([first, second]);

    setCurrentEntry(container, first);

    expect(nested.classList.contains('entry-current')).toBe(true);
    expect(second.classList.contains('entry-current')).toBe(false);
    expect(first.classList.contains('entry-current')).toBe(true);
  });
});

describe('search-query — one search', () => {
  it('trims what the engine is handed', () => {
    expect(normalizeSearchQuery('  落ちる \n')).toBe('落ちる');
    expect(normalizeSearchQuery(undefined)).toBe('');
  });

  it('starts a typed query as a term lookup, with kanji as the fallback', () => {
    expect(searchLookupOrder('term')).toEqual(['term', 'kanji']);
  });

  it('starts a clicked kanji as a kanji lookup, with terms as the fallback', () => {
    expect(searchLookupOrder('kanji')).toEqual(['kanji', 'term']);
  });

  it('files an answer under the mode that produced it, never both', () => {
    expect(searchEntriesForMode('term', [{ a: 1 }])).toEqual({
      entries: [{ a: 1 }],
      kanjiEntries: [],
    });
    expect(searchEntriesForMode('kanji', [{ k: 1 }])).toEqual({
      entries: [],
      kanjiEntries: [{ k: 1 }],
    });
  });

  it('counts both kinds', () => {
    expect(countSearchEntries(EMPTY_SEARCH_ENTRIES)).toBe(0);
    expect(
      countSearchEntries({ entries: [{}, {}], kanjiEntries: [{}] }),
    ).toBe(3);
  });

  it('narrows a history mode to the two this page can draw', () => {
    expect(asSearchMode('kanji')).toBe('kanji');
    expect(asSearchMode('term')).toBe('term');
    expect(asSearchMode('scan')).toBe('term');
  });
});

describe('search-query — internal gloss links', () => {
  it('parses dictionary internal link parameters into a search lookup', () => {
    expect(searchParamsToLookup({ type: 'kanji', query: '法' })).toEqual({
      mode: 'kanji',
      query: '法',
    });
  });

  it("reads upstream's own `type=terms`, which is the value a real link carries", () => {
    /* Upstream writes its CONTENT TYPE into the URL, not this page's mode name:
       `Display._createSearchParams` sets `params.type = type` and
       `Display._onStateChanged` switches on `case 'terms': case 'kanji':`. The
       singular `term` is Entei's own name and appears in no dictionary link, so the
       form worth asserting is the plural one. */
    expect(searchParamsToLookup({ type: 'terms', query: '法人' })).toEqual({
      mode: 'term',
      query: '法人',
    });
    expect(searchParamsToLookup({ type: 'terms', query: '  法人 ' })).toEqual({
      mode: 'term',
      query: '法人',
    });
    // A link with no `type` at all (`?query=…`) is a term lookup too.
    expect(searchParamsToLookup({ query: '法人' })).toEqual({
      mode: 'term',
      query: '法人',
    });
  });

  it('trims whitespace in internal link query parameters', () => {
    expect(searchParamsToLookup({ type: 'terms', query: '  法人 \n' })).toEqual({
      mode: 'term',
      query: '法人',
    });
  });

  it('defaults to term mode when type is missing or unrecognized', () => {
    expect(searchParamsToLookup({ query: '法人' })).toEqual({
      mode: 'term',
      query: '法人',
    });
    expect(searchParamsToLookup({ type: 'unknown', query: '法人' })).toEqual({
      mode: 'term',
      query: '法人',
    });
  });

  it('returns null when internal link query is missing or blank', () => {
    expect(searchParamsToLookup({ type: 'term' })).toBeNull();
    expect(searchParamsToLookup({ type: 'term', query: '' })).toBeNull();
    expect(searchParamsToLookup({ type: 'term', query: '   \n' })).toBeNull();
    expect(searchParamsToLookup({})).toBeNull();
  });
});

describe('search-query — the results area', () => {
  const ready = {
    loading: false,
    assetsReady: true,
    searched: false,
    hasDictionaries: true,
    entries: EMPTY_SEARCH_ENTRIES,
  };

  it('waits for the first query', () => {
    expect(resolveSearchOutcome(ready)).toBe('idle');
  });

  it('shows its own progress while a lookup is in flight', () => {
    expect(resolveSearchOutcome({ ...ready, loading: true, searched: true })).toBe(
      'loading',
    );
  });

  it('reports missing Yomitan assets before anything else', () => {
    expect(
      resolveSearchOutcome({ ...ready, assetsReady: false, hasDictionaries: false }),
    ).toBe('unavailable');
  });

  it('reports an empty dictionary set even before the first search', () => {
    expect(
      resolveSearchOutcome({ ...ready, hasDictionaries: false }),
    ).toBe('no-dictionaries');
  });

  it('says "no results" only once the dictionaries have answered', () => {
    expect(resolveSearchOutcome({ ...ready, searched: true })).toBe('no-results');
  });

  it('draws the entries', () => {
    const entries = searchEntriesForMode('term', [{ headwords: [] }]);
    expect(resolveSearchOutcome({ ...ready, searched: true, entries })).toBe(
      'results',
    );
  });
});

/* ---------------------------------------------------------------------------
 * Clipboard monitor — the search page following the OS clipboard.
 *
 * `clipboard.enableSearchPageMonitor` (Settings → Yomitan → Search window) has
 * been in this host's tree since the beginning; what is asserted here is the
 * sampling contract the React island is built on.
 * ------------------------------------------------------------------------- */

describe('clipboard-monitor — one sample', () => {
  it('treats the first readable value as a baseline, never as a query', () => {
    // Copying a word and THEN opening /search/ must not look that word up.
    expect(classifyClipboardSample(null, '落ちる')).toEqual({ kind: 'baseline' });
  });

  it('never spends a real copy as the baseline', () => {
    /* The host reads the clipboard as the monitor starts and stores THAT as the
       baseline, so by the time a copy arrives `previous` is a string. This is the
       regression for "the monitor is one copy behind": a baseline of '' (an empty
       clipboard at open, or an unreadable one) differs from every lookup-worthy
       text, so the first copy is a search instead of a second baseline. */
    expect(classifyClipboardSample('', '落ちる')).toEqual({
      kind: 'search',
      query: '落ちる',
    });
  });

  it('ignores a sample it could not read', () => {
    // A locked clipboard, a refused permission, or Android's background app: the
    // monitor keeps polling, and the baseline survives so the next copy is news.
    expect(classifyClipboardSample(null, null)).toEqual({ kind: 'idle' });
    expect(classifyClipboardSample('犬', null)).toEqual({ kind: 'idle' });
  });

  it('searches text that is new since the last accepted sample', () => {
    expect(classifyClipboardSample('犬', '猫')).toEqual({
      kind: 'search',
      query: '猫',
    });
  });

  it('is quiet while the clipboard holds the same word (the once-a-second case)', () => {
    expect(classifyClipboardSample('猫', '猫')).toEqual({ kind: 'idle' });
  });

  it('does not read a difference in surrounding whitespace as new text', () => {
    // The clipboard is re-read every second, so an editor that re-copies the same
    // selection with a newline attached must not re-run the lookup.
    expect(classifyClipboardSample('猫', '猫 ')).toEqual({ kind: 'idle' });
    expect(classifyClipboardSample('猫 ', '猫')).toEqual({ kind: 'idle' });
  });

  it('hands the engine a trimmed query', () => {
    expect(classifyClipboardSample('犬', '  猫 \n')).toEqual({
      kind: 'search',
      query: '猫',
    });
  });

  it('refuses a clipboard that was cleared or holds only whitespace', () => {
    // Clearing the clipboard is not a query, and an empty field is this page's
    // intro rather than a search for the empty string.
    expect(classifyClipboardSample('猫', '')).toEqual({ kind: 'idle' });
    expect(classifyClipboardSample('猫', ' \n ')).toEqual({ kind: 'idle' });
  });
});

describe('clipboard-monitor — what is worth a lookup', () => {
  it('refuses text no dictionary could answer', () => {
    // Sampling runs twice a second, so "look up whatever the clipboard holds"
    // would cost an engine round trip every time the user copies a URL.
    expect(
      classifyClipboardSample('猫', 'https://example.com/very/long/path'),
    ).toEqual({
      kind: 'idle',
    });
    expect(classifyClipboardSample('猫', 'just some english sentence')).toEqual({
      kind: 'idle',
    });
    expect(classifyClipboardSample('猫', '🎉🎉')).toEqual({ kind: 'idle' });
  });

  it('still searches Japanese, in any of the three scripts', () => {
    expect(isTextLookupWorthy('落ちる')).toBe(true);
    expect(isTextLookupWorthy('カタカナ')).toBe(true);
    expect(isTextLookupWorthy('漢字')).toBe(true);
    expect(isTextLookupWorthy('🍣')).toBe(false);
  });

  it('does not turn the baseline into a skipped search', () => {
    // Whatever was already on the clipboard when the page opened is remembered
    // even when it is a URL, so the FIRST Japanese copy after that is a search
    // rather than a second baseline.
    expect(classifyClipboardSample(null, 'https://example.com')).toEqual({
      kind: 'baseline',
    });
    expect(
      classifyClipboardSample(
        'https://example.com',
        'https://example.com',
      ),
    ).toEqual({ kind: 'idle' });
  });

  it('caps a runaway clipboard instead of searching all of it', () => {
    const pasted = `${'あ'.repeat(MAXIMUM_SEARCH_LENGTH)}末尾`;
    const decision = classifyClipboardSample('犬', pasted);
    expect(decision).toEqual({
      kind: 'search',
      query: 'あ'.repeat(MAXIMUM_SEARCH_LENGTH),
    });
  });

  it('is quiet about a long value it has already searched', () => {
    /* The caller stores what THIS function searched, so a clipboard longer than
       the cap must compare equal to itself on the next poll: comparing the raw
       text instead would re-run the same lookup every second, forever. */
    const pasted = `${'猫'.repeat(MAXIMUM_SEARCH_LENGTH)}`;
    const decision = classifyClipboardSample('犬', pasted);
    expect(decision.kind).toBe('search');
    const stored = decision.kind === 'search' ? decision.query : null;
    expect(classifyClipboardSample(stored, pasted)).toEqual({ kind: 'idle' });
  });

  it('normalizes a sample into the one form the caller compares and stores', () => {
    expect(normalizeClipboardText('  猫 落ちる\n')).toBe('猫 落ちる');
    expect(normalizeClipboardText(null)).toBe('');
    expect(normalizeClipboardText('あ'.repeat(MAXIMUM_SEARCH_LENGTH + 5))).toBe(
      'あ'.repeat(MAXIMUM_SEARCH_LENGTH),
    );
  });

  it('never cuts a surrogate pair in half at the cap', () => {
    // Half a pair is a lone surrogate: JSON cannot carry it, so the lookup would
    // fail instead of simply being shortened.
    const head = 'あ'.repeat(MAXIMUM_SEARCH_LENGTH - 1);
    const rounded = truncateSearchText(`${head}🍣`);
    expect(rounded).toBe(head);
    // No high surrogate left without its low half.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(rounded)).toBe(false);
  });
});

describe('clipboard-monitor — when a sample is taken', () => {
  it('polls, because neither platform announces a clipboard change', () => {
    /* Copying in ANOTHER app is the whole point, and the page has no focus while
       that happens: the poll is the only thing that can see the copy, so it has to
       be fast enough to read as immediate (and cheap enough to keep running). */
    expect(CLIPBOARD_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(250);
    expect(CLIPBOARD_POLL_INTERVAL_MS).toBeLessThanOrEqual(500);
  });
});

/* ---------------------------------------------------------------------------
 * Query parser — the furigana header under the box.
 *
 * Upstream's `ext/js/display/query-parser.js`. What is asserted here is its
 * contract rather than its pixels: which element carries which class, where the
 * offsets land (a click is resolved against them), and what each `readingMode`
 * writes into the `<rt>`.
 * ------------------------------------------------------------------------- */

/** The header's markup as a string, so a class name can be asserted verbatim. */
function htmlOf(fragment: DocumentFragment): string {
  const host = document.createElement('div');
  host.append(fragment);
  return host.innerHTML;
}

/** One parsed term: a single word, optionally with a reading over it. */
function line(text: string, reading = ''): TermParseLine {
  return [{ text, reading }];
}

describe('query-parser — settings', () => {
  it('reads the four options the header depends on', () => {
    const profile = createDefaultProfileOptions();
    profile.parsing.termSpacing = false;
    profile.parsing.readingMode = 'katakana';
    profile.scanning.length = 4;

    expect(readQueryParserSettings(profile)).toEqual({
      enabled: true,
      termSpacing: false,
      readingMode: 'katakana',
      scanLength: 4,
    });
  });

  it('falls back to the shipped defaults rather than to an unusable window', () => {
    // A window of 0 would make every parse loop forever without advancing.
    const profile = createDefaultProfileOptions();
    profile.scanning.length = 0;
    expect(readQueryParserSettings(profile).scanLength).toBe(
      DEFAULT_QUERY_PARSER_SETTINGS.scanLength,
    );
  });
});

describe('query-parser — the reading written over a segment', () => {
  it('follows the reading mode', () => {
    expect(convertSegmentReading('猫', 'ネコ', 'hiragana')).toBe('ねこ');
    expect(convertSegmentReading('猫', 'ねこ', 'katakana')).toBe('ネコ');
    expect(convertSegmentReading('猫', 'ねこ', 'romaji')).toBe('neko');
    // 'none' is the switch that turns ruby off without turning parsing off.
    expect(convertSegmentReading('猫', 'ねこ', 'none')).toBe('');
    // Upstream's `default:` case: the reading as the dictionary wrote it.
    expect(convertSegmentReading('猫', 'ねこ', 'dictionary-reading')).toBe('ねこ');
  });

  it('transliterates a kana headword from the term when it has no reading', () => {
    // A kana headword is its own reading, so the translator hands back '' — and
    // romaji mode still has to say something.
    expect(convertSegmentReading('ねこ', '', 'romaji')).toBe('neko');
  });
});

describe('query-parser — markup', () => {
  const settings: QueryParserSettings = { ...DEFAULT_QUERY_PARSER_SETTINGS };

  it('draws a ruby segment with upstream’s own class names', () => {
    const html = htmlOf(renderQueryParser([line('猫', 'ねこ')], settings));
    expect(html).toBe(
      '<span class="query-parser-term" data-offset="0">' +
        '<ruby class="query-parser-segment">' +
        '<span class="query-parser-segment-text" data-offset="0">猫</span>' +
        '<rt class="query-parser-segment-reading">ねこ</rt>' +
        '</ruby></span>',
    );
  });

  it('writes a segment with no reading as plain text, not as an empty ruby', () => {
    const html = htmlOf(renderQueryParser([line('とて')], settings));
    expect(html).toBe(
      '<span class="query-parser-term" data-offset="0">とて</span>',
    );
  });

  it('counts offsets across terms, so a click anywhere names a real position', () => {
    const fragment = renderQueryParser(
      [line('猫', 'ねこ'), [{ text: 'と', reading: '' }]],
      settings,
    );
    const terms = [...fragment.querySelectorAll('.query-parser-term')];
    expect(terms.map((term) => term.getAttribute('data-offset'))).toEqual([
      '0',
      '1',
    ]);
    // The base text only — an `<rt>` contributes its reading to `textContent`.
    const bases = document.createElement('div');
    bases.append(fragment.cloneNode(true));
    for (const reading of bases.querySelectorAll('rt')) reading.remove();
    expect(bases.textContent).toBe('猫と');
  });

  it('condenses trailing whitespace inside a term and trims only the last one', () => {
    /* Upstream's `trimTrailingWhitespacePlusSpace`: a gap between two segments of
       one term survives as ONE space, while the end of the whole parse loses it
       (there is nothing after it to separate). */
    const fragment = renderQueryParser(
      [
        [
          { text: '猫  ', reading: '' },
          { text: 'と', reading: '' },
        ],
        [{ text: 'ね ', reading: '' }],
      ],
      settings,
    );
    const terms = [...fragment.querySelectorAll('.query-parser-term')];
    expect(terms[0]?.innerHTML).toBe('猫 と');
    expect(terms[1]?.innerHTML).toBe('ね');
  });

  it('previews the raw text while the parse is still running', () => {
    const fragment = renderQueryParserPreview('猫と　ねこ  ');
    const term = fragment.querySelector('.query-parser-term');
    expect(term?.getAttribute('data-offset')).toBe('0');
    // Trailing whitespace trimmed, ruby absent, and the text untouched otherwise.
    expect(term?.textContent).toBe('猫と　ねこ');
    expect(fragment.querySelector('ruby')).toBeNull();
  });
});

describe('query-parser — a click becomes a lookup', () => {
  function header(lines: TermParseLine[]): HTMLElement {
    const host = document.createElement('div');
    host.id = 'query-parser-content';
    host.append(renderQueryParser(lines, DEFAULT_QUERY_PARSER_SETTINGS));
    return host;
  }

  it('reads the offset off the segment that was clicked', () => {
    const host = header([line('猫', 'ねこ'), line('犬', 'いぬ')]);
    const second = host.querySelectorAll('.query-parser-segment-text')[1];
    expect(second).toBeDefined();
    expect(
      queryParserOffsetAt(host, second ?? null),
    ).toBe(1);
  });

  it('falls back to the offset of the term that was clicked', () => {
    const host = header([line('猫', 'ねこ'), line('犬', 'いぬ')]);
    const secondTerm = host.querySelectorAll('.query-parser-term')[1];
    expect(secondTerm).toBeDefined();
    // A click on the term span itself (its plain text, or its padding).
    expect(queryParserOffsetAt(host, secondTerm ?? null)).toBe(1);
  });

  it('refuses a click outside the header', () => {
    const host = header([line('猫', 'ねこ')]);
    expect(queryParserOffsetAt(host, null)).toBeNull();
    expect(queryParserOffsetAt(host, document.createElement('button'))).toBeNull();
    // An offset that belongs to ANOTHER container is not this header's business.
    const stranger = document.createElement('span');
    stranger.dataset.offset = '7';
    host.append(stranger);
    const outside = document.createElement('div');
    outside.id = 'elsewhere';
    outside.append(stranger);
    expect(queryParserOffsetAt(document.createElement('main'), stranger)).toBeNull();
  });

  /**
   * jsdom has no caret API, so the pointer's own resolution (`caretPointAt`, which
   * reads `caretRangeFromPoint`) is stubbed at the range it returns — everything
   * below it is the real path.
   */
  function stubCaretAt(node: Node, offset: number): () => void {
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const previous = doc.caretRangeFromPoint;
    doc.caretRangeFromPoint = () => {
      const range = document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      return range;
    };
    return () => {
      doc.caretRangeFromPoint = previous;
    };
  }

  it('refines a click to the character the pointer is over', () => {
    const host = header([line('猫と犬', 'ねこといぬ')]);
    const segment = host.querySelector('.query-parser-segment-text');
    const text = segment?.firstChild;
    expect(text).toBeDefined();
    const restore = stubCaretAt(text as Node, 1);
    try {
      // The segment starts at 0, and the caret sits on its second character.
      expect(queryParserOffsetAt(host, segment ?? null, 10, 10)).toBe(1);
      // Without coordinates (a keyboard-generated click) the segment's own start is
      // the answer, which is upstream's behaviour.
      expect(queryParserOffsetAt(host, segment ?? null)).toBe(0);
    } finally {
      restore();
    }
  });

  it('counts a term’s own plain text from the term’s offset', () => {
    /* Two segments: a ruby word, then unparsed text belonging to the TERM rather
       than to any segment — the case a segment's offset alone cannot answer. */
    const host = document.createElement('div');
    host.append(
      renderQueryParser(
        [
          [{ text: '猫', reading: 'ねこ' }],
          [
            { text: 'と', reading: '' },
            { text: '犬', reading: 'いぬ' },
          ],
        ],
        DEFAULT_QUERY_PARSER_SETTINGS,
      ),
    );
    const term = host.querySelectorAll('.query-parser-term')[1];
    const plain = term?.firstChild;
    expect(term?.getAttribute('data-offset')).toBe('1');
    const restore = stubCaretAt(plain as Node, 1);
    try {
      // The caret sits AFTER 「と」, which is where 「犬」 starts.
      expect(queryParserOffsetAt(host, term ?? null, 10, 10)).toBe(2);
    } finally {
      restore();
    }
  });

  it('ignores a pointer that is over a reading', () => {
    const host = header([line('猫', 'ねこ'), line('犬', 'いぬ')]);
    const segment = host.querySelectorAll('.query-parser-segment-text')[1];
    const reading = host.querySelectorAll('rt')[1]?.firstChild;
    expect(reading).toBeDefined();
    const restore = stubCaretAt(reading as Node, 0);
    try {
      // A reading contributes nothing to the sentence, so the click names the word
      // written under it rather than an offset inside the ruby text.
      expect(queryParserOffsetAt(host, segment ?? null, 10, 10)).toBe(1);
    } finally {
      restore();
    }
  });

  it('looks up the scan window that starts at the click', () => {
    // Not just the clicked character: the window is `scanning.length` long, so an
    // inflected stem still reaches the deinflector.
    expect(queryParserQueryAt('食べた spaghetti', 0, 3)).toBe('食べた');
    expect(queryParserQueryAt('食べて', 2, 10)).toBe('て');
    // A window of none still names the clicked character, never an empty query.
    expect(queryParserQueryAt('猫', 0, 0)).toBe('猫');
  });
});