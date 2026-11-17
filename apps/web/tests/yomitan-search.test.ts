/**
 * Yomitan Search unit tests — the pure half of `/search/`.
 *
 * Covers:
 * - `scopeYomitanCss`: Yomitan's own stylesheets re-anchored at one element
 *   (theme rules, window-level rules, `@keyframes`, declaration values)
 * - the REAL vendored sheets: after scoping, no rule can escape the column
 * - `search-query`: the lookup order, the entry bookkeeping and the five/six
 *   states the results area can be in
 *
 * The React island and the DOM the generator builds are deliberately NOT covered
 * here: everything worth asserting about them is either a decision (this file) or
 * a rendered pixel (verified in the browser).
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scopeSelectorList,
  scopeYomitanCss,
  YOMITAN_SEARCH_SCOPE,
} from '@/modules/yomitan/search/scope-css';
import {
  asSearchMode,
  countSearchEntries,
  EMPTY_SEARCH_ENTRIES,
  normalizeSearchQuery,
  resolveSearchOutcome,
  searchEntriesForMode,
  searchLookupOrder,
} from '@/modules/yomitan/search/search-query';

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