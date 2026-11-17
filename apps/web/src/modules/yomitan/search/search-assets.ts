/**
 * search-assets — Yomitan's stylesheets, scoped and injected once.
 * ---------------------------------------------------------------------------
 * The search page needs two of the three things the popups load from
 * `public/yomitan/`: the stylesheets (scoped to this page's own column) and
 * `templates-display.html` (handed to the generator). Both already have a loader
 * — `popup-assets.ts` reads them once per page load and inlines the icon URLs —
 * so this module adds the one step the popup does not need: `scopeYomitanCss`
 * re-anchors every rule at `.entei-yomitan-search` (see `scope-css.ts`).
 *
 * The scoped sheet is INJECTED ONCE per document, not rendered per island: the
 * text is ~140 KB, the page has exactly one island, and a re-injected copy on
 * every remount would duplicate it in `<head>`.
 *
 * `general.customPopupCss` is appended after the vendored sheets, exactly where
 * upstream appends it (`Display._getCustomCss`), and scoped the same way — a
 * user's own popup CSS is written against `:root`, which is the element this page
 * re-anchored those rules to.
 * ---------------------------------------------------------------------------
 */

import { loadPopupPreviewAssets } from '@/modules/yomitan/popup-preview/popup-assets';
import {
  scopeYomitanCss,
  YOMITAN_SEARCH_SCOPE,
} from '@/modules/yomitan/search/scope-css';

/** What one search page needs to draw Yomitan's own cards. */
export interface SearchAssets {
  /** The vendored sheets, re-anchored at `.entei-yomitan-search`. */
  css: string;
  /** `ext/templates-display.html`, unparsed. */
  templates: string;
}

/** The injected `<style>` — one per document, identified for the test that checks it. */
export const SEARCH_STYLE_ELEMENT_ID = 'entei-yomitan-search-styles';

/** In-flight (or finished) read, so a remount reuses it instead of re-fetching. */
let pending: Promise<SearchAssets> | null = null;

/** Append the scoped sheet to `<head>` unless this document already has it. */
function injectStyle(css: string): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SEARCH_STYLE_ELEMENT_ID) !== null) return;
  const style = document.createElement('style');
  style.id = SEARCH_STYLE_ELEMENT_ID;
  // `textContent`, never `innerHTML`: a stylesheet's text is not markup, and a
  // literal `</style>` in a user's custom CSS must not be able to close the
  // element and inject nodes into the page.
  style.textContent = css;
  document.head.append(style);
}

/**
 * Read, scope and inject Yomitan's sheets; hand back the templates.
 *
 * A failure is NOT cached (same rule as `popup-assets`): a transient 404 must be
 * retryable by reopening the page instead of being remembered for the session.
 */
export function loadSearchAssets(): Promise<SearchAssets> {
  if (pending === null) {
    pending = (async () => {
      const assets = await loadPopupPreviewAssets();
      const customCss = await readCustomPopupCss();
      const sheets =
        customCss === ''
          ? assets.css
          : `${assets.css}\n${customCss}`;
      const css = scopeYomitanCss(sheets, YOMITAN_SEARCH_SCOPE);
      injectStyle(css);
      return { css, templates: assets.templates };
    })().catch((error: unknown) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

/**
 * `general.customPopupCss` from the persisted options, or '' when unreadable.
 *
 * Swallowed on purpose: a settings tree that cannot be read costs the page the
 * user's own CSS, while throwing here would cost them the whole search page.
 */
async function readCustomPopupCss(): Promise<string> {
  try {
    const { readYomitanOptions } = await import(
      '@/modules/yomitan/yomitan-preferences'
    );
    const { activeProfileOptions } = await import(
      '@/modules/yomitan/yomitan-preferences'
    );
    const css = activeProfileOptions(readYomitanOptions()).general.customPopupCss;
    return typeof css === 'string' ? css : '';
  } catch {
    return '';
  }
}