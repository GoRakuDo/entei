/**
 * scope-css — Yomitan's own stylesheets, retargeted at ONE element.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS. `/search/` draws its result cards with Yomitan's own
 * `DisplayGenerator`, so it needs Yomitan's own stylesheets. Every other host
 * that draws them today (the settings preview, the floating popup) puts them in
 * an iframe `srcdoc`, where they cannot reach the page around them. A search page
 * inside Entei's document has no frame, and the sheets are written for the
 * extension's WHOLE WINDOW: `body { overflow: hidden }`, `a`, `select`,
 * `textarea`, `input[…]`, `ol, ul`, `h2`, `h3`, `h5`, and every theme variable on
 * `:root`. Injected as-is they would restyle the Top Bar, the drawer and the
 * toaster of the page that hosts them.
 *
 * So each rule is re-anchored here, and nothing else about it changes:
 *
 * - a selector that STARTS from the document root (`:root[data-theme=dark] .tag`,
 *   `:root:not([data-theme=light]) .scrollbar`) has that `:root` replaced by the
 *   scope selector, which is how the theme/display-mode attributes reach the same
 *   rules — the page writes `data-theme` and friends on the scoped element rather
 *   than on `<html>` (see `popup-theme.ts`, reused unchanged);
 * - every other selector is a DESCENDANT of the scope selector, so `body {…}`
 *   becomes `.entei-yomitan-search body {…}` — a selector nothing can match
 *   (a `<body>` is never inside the results column), which is the intended way
 *   for a window-level rule to disappear instead of leaking;
 * - `@keyframes` blocks are copied verbatim: their `from` / `to` / `0%` preludes
 *   are keyframe selectors, not rules, and prefixing them would break the four
 *   animations `display.css` ships.
 *
 * It is a deliberately small transform, not a CSS parser: the pinned Yomitan
 * sheets use no `@media`, no `@supports` and no nesting (verified against
 * `public/yomitan/css/`), so a block is either an at-rule with a verbatim body,
 * an at-rule with rules inside, or a rule with declarations. A construct this
 * does not know is copied through untouched rather than half-rewritten, and the
 * unit test pins the three shapes above.
 *
 * PURE — no DOM, no options. The component owns the injection; this owns the
 * rewriting.
 * ---------------------------------------------------------------------------
 */

/** The selector every vendored rule is re-anchored to (Entei's results column). */
export const YOMITAN_SEARCH_SCOPE = '.entei-yomitan-search';

/** Upstream's own document-root anchor, as the sheets write it. */
const ROOT_ANCHOR = ':root';

/**
 * Split a rule prelude into its leading trivia and the statement itself.
 *
 * Comments matter here: a stylesheet writes `/* Progress bar *\/` on the line
 * ABOVE a block, so the comment belongs to that block's prelude. Classifying the
 * prelude by its first character would read the comment as a selector and turn
 * `@keyframes …` into a selector list — which is exactly how the four progress-bar
 * animations would have been swallowed into a rule that matches nothing.
 */
function splitTrivia(prelude: string): { trivia: string; statement: string } {
  const trivia = /^(?:\s|\/\*[\s\S]*?\*\/)*/.exec(prelude)?.[0] ?? '';
  return { trivia, statement: prelude.slice(trivia.length) };
}

/** True when an at-rule's block is NOT a rule list (its preludes must survive).
 *
 * `@keyframes` is the only one the pinned sheets contain; the pattern accepts a
 * vendor prefix so a future sheet cannot silently have its keyframes rewritten.
 */
function isVerbatimAtRule(prelude: string): boolean {
  return /^@(?:-[a-z]+-)?keyframes\b/.test(prelude);
}

/** True for the two characters that open a rule prelude or terminate a statement. */
function isPreludeEnd(char: string): boolean {
  return char === '{' || char === ';';
}

/**
 * Index of the `}` closing the block opened at `openIndex` (or the text length).
 *
 * Skips strings and comments so a brace inside a declaration value — a `url()`
 * payload, a `--content: "{"` — cannot end the block early.
 */
function findBlockEnd(css: string, openIndex: number): number {
  let depth = 0;
  let quote = '';
  for (let index = openIndex; index < css.length; index += 1) {
    const char = css.charAt(index);
    if (quote !== '') {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '/' && css.charAt(index + 1) === '*') {
      const end = css.indexOf('*/', index + 2);
      index = end === -1 ? css.length : end + 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return css.length;
}

/** Index of the next top-level `{`, `;` or end of text, starting at `from`. */
function findPreludeEnd(css: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let index = from; index < css.length; index += 1) {
    const char = css.charAt(index);
    if (quote !== '') {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '/' && css.charAt(index + 1) === '*') {
      const end = css.indexOf('*/', index + 2);
      index = end === -1 ? css.length : end + 1;
      continue;
    }
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (depth === 0 && isPreludeEnd(char)) return index;
  }
  return css.length;
}

/** Split a selector list on its top-level commas (never inside `:is(…)` / `[…]`). */
function splitSelectorList(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let index = 0; index < prelude.length; index += 1) {
    const char = prelude.charAt(index);
    if (quote !== '') {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(prelude.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(prelude.slice(start));
  return parts;
}

/** All occurrences of `:root` in one selector replaced by the scope selector. */
function replaceRootAnchor(selector: string, scopeSelector: string): string {
  return selector.split(ROOT_ANCHOR).join(scopeSelector);
}

/**
 * One rule's selector list, re-anchored at `scopeSelector`.
 *
 * PURE and total: an empty prelude comes back empty (a stray `{` in the sheet
 * cannot produce a selector-less rule).
 */
export function scopeSelectorList(prelude: string, scopeSelector: string): string {
  const parts = splitSelectorList(prelude)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return '';

  const scoped = parts.map((part) =>
    part.includes(ROOT_ANCHOR)
      ? replaceRootAnchor(part, scopeSelector)
      : `${scopeSelector} ${part}`,
  );
  return scoped.join(',\n');
}

/**
 * Rewrite every rule in `css` so it applies inside `scopeSelector` only.
 *
 * PURE and total: text this does not recognise (an at-rule it has no rule list
 * for, a trailing fragment without a block) is copied through unchanged, so a
 * malformed input degrades to "less scoped" rather than to dropped CSS.
 */
export function scopeYomitanCss(css: string, scopeSelector: string): string {
  let out = '';
  let index = 0;

  while (index < css.length) {
    const preludeEnd = findPreludeEnd(css, index);
    const prelude = css.slice(index, preludeEnd);

    /* Statement at-rule (`@import …;`) or the tail of the sheet: verbatim. */
    if (preludeEnd >= css.length || css.charAt(preludeEnd) === ';') {
      out += prelude + (preludeEnd >= css.length ? '' : ';');
      index = preludeEnd + 1;
      continue;
    }

    const blockEnd = findBlockEnd(css, preludeEnd);
    const body = css.slice(preludeEnd + 1, blockEnd);
    const { trivia, statement } = splitTrivia(prelude);

    if (statement.startsWith('@')) {
      out += isVerbatimAtRule(statement)
        ? `${prelude}{${body}`
        : `${prelude}{${scopeYomitanCss(body, scopeSelector)}`;
    } else {
      const selector = scopeSelectorList(statement, scopeSelector);
      out +=
        selector === ''
          ? `${prelude}{${body}`
          : `${trivia}${selector} {${body}`;
    }

    out += blockEnd < css.length ? '}' : '';
    index = blockEnd + 1;
  }

  return out;
}