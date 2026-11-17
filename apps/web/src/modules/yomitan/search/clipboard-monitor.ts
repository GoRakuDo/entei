/**
 * clipboard-monitor — the pure decisions behind the search page's clipboard monitor.
 * ---------------------------------------------------------------------------
 * Yomitan's own search page (`ext/search.html` + `search-page-controller.js`) can
 * follow the OS clipboard: with `clipboard.enableSearchPageMonitor` on, text copied
 * anywhere else appears in the search box and is looked up. That option has always
 * been in this host's settings tree (`yomitan.module.json`, section
 * `search-window` → "Clipboard monitor"), but nothing read it — the monitor itself
 * is what was missing.
 *
 * WHY IT NEEDS A NATIVE READ. A page cannot read the clipboard: `navigator.clipboard`
 * needs a secure context and a granted permission, and on Android 10+ the OS hands
 * `getPrimaryClip()` only to the app that currently holds input focus. So the read
 * is Entei's own (`readClipboardTextDirect` → `plugin:modules|
 * modules_clipboard_read_text`), and the SAMPLING is what this module decides:
 *
 * - **Focus-gated.** Both Windows and Android only expose the clipboard to the
 *   foreground application, so the monitor samples when the window regains focus
 *   and while it is visible, never on a blind background timer.
 * - **The first sample is a BASELINE, not a search.** Copying a word, then opening
 *   `/search/`, must not fire a lookup for what happens to be on the clipboard
 *   already — upstream skips that first value too. Everything after it is compared
 *   against it.
 * - **A blank clipboard is not a query.** Neither is a value that differs from the
 *   last sample only in surrounding whitespace: both leave the field alone, and
 *   neither becomes the new baseline, so the next real copy is still detected.
 * - **Neither is anything a dictionary could not answer.** A URL, a paragraph of
 *   English or a 50 kB log line is not a lookup, and polling once a second makes
 *   "look up everything the clipboard happens to hold" expensive: text is capped
 *   at [`MAXIMUM_SEARCH_LENGTH`] and has to contain Japanese to be searched.
 *
 * PURE: no clipboard, no timer, no DOM. The React island owns the sampling; this
 * module owns the choices.
 * ---------------------------------------------------------------------------
 */

import { normalizeSearchQuery } from '@/modules/yomitan/search/search-query';

/**
 * How often the clipboard is re-read while the window is focused and visible.
 *
 * The clipboard carries no change notification on either platform, so polling is
 * the only mechanism. One second is what a copy → alt-tab → read round trip needs
 * to feel immediate, and it is cheap: the native read opens the clipboard, reads
 * one string and closes it again.
 */
export const CLIPBOARD_POLL_INTERVAL_MS = 1000;

/** What one clipboard sample means for the search field. */
export type ClipboardSample =
  /**
   * The first readable sample: remembered, never searched.
   *
   * Without this the page would look up whatever was already on the clipboard when
   * it opened — usually the sentence the user is in the middle of copying.
   */
  | { readonly kind: 'baseline' }
  /** Nothing to do: unreadable, blank, or unchanged since the last sample. */
  | { readonly kind: 'idle' }
  /** New clipboard text — put it in the field and look it up. */
  | { readonly kind: 'search'; readonly query: string };

/**
 * The longest clipboard text that may become a query.
 *
 * The clipboard can hold a whole log file, and this page would hand all of it to
 * the dictionary engine (and to the query parser's own DOM). A thousand
 * characters is far longer than any sentence worth looking up and short enough
 * that a runaway copy stays cheap; the rest is simply ignored.
 */
export const MAXIMUM_SEARCH_LENGTH = 1000;

/**
 * Hiragana, katakana and CJK ideographs — what a JMDict/KANJIDIC lookup can answer.
 *
 * Deliberately the three blocks this host's dictionaries cover, not "anything
 * non-ASCII": accented Latin, Cyrillic and emoji are as unanswerable as English,
 * and half-width katakana (U+FF66–FF9D) is left out because it is not what a
 * copy of Japanese text normally carries.
 */
const JAPANESE_LOOKUP_PATTERN = /[\u3040-\u30ff\u4e00-\u9fff]/;

/**
 * True when `text` holds at least one character a dictionary could look up.
 *
 * A guard against work, not a language opinion: with the monitor sampling once a
 * second, "look up whatever is on the clipboard" would otherwise run a full
 * engine round trip for a copied URL every time the user copies one.
 */
export function isTextLookupWorthy(text: string): boolean {
  return JAPANESE_LOOKUP_PATTERN.test(text);
}

/**
 * [`MAXIMUM_SEARCH_LENGTH`] UTF-16 units of `text`, never half a character.
 *
 * Counting units rather than code points keeps this O(1) however large the
 * clipboard is (a copied log file must not cost an array of its characters once a
 * second), with one correction: a cut that lands on a HIGH SURROGATE would send half
 * of an emoji's surrogate pair to the engine — a lone surrogate that JSON cannot
 * carry, so the lookup would fail instead of showing nothing. That half is dropped.
 */
export function truncateSearchText(text: string): string {
  if (text.length <= MAXIMUM_SEARCH_LENGTH) return text;
  const clipped = text.slice(0, MAXIMUM_SEARCH_LENGTH);
  const lastUnit = clipped.charCodeAt(clipped.length - 1);
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? clipped.slice(0, -1) : clipped;
}

/**
 * The one form a clipboard sample is compared, stored and searched in.
 *
 * Exported because the caller has to remember the sample in EXACTLY this form:
 * storing the raw clipboard text while searching the shortened one would make a
 * long value differ from itself on every poll, i.e. re-run the same lookup once
 * a second forever.
 */
export function normalizeClipboardText(raw: string | null | undefined): string {
  return truncateSearchText(normalizeSearchQuery(raw));
}

/**
 * Decide what one sample of the clipboard means.
 *
 * `previous` is the last sample that was ACCEPTED (the baseline, then every text
 * that produced a search), in the form [`normalizeClipboardText`] returns;
 * `null` means nothing has been accepted yet.
 *
 * The comparison is on the NORMALIZED text, so a clipboard that gained or lost
 * trailing whitespace is not "new text" — but the query handed back is normalized
 * too, which is exactly what the engine would have received anyway.
 *
 * ORDER: the length and language guards run AFTER the baseline, so whatever was
 * already on the clipboard when the page opened is remembered (and skipped) even
 * when it is a URL — which is what makes the first Japanese copy after that a
 * search instead of a second baseline.
 */
export function classifyClipboardSample(
  previous: string | null,
  current: string | null,
): ClipboardSample {
  // Unreadable (a locked clipboard, a denied permission, a background app).
  if (current === null) return { kind: 'idle' };
  const query = normalizeClipboardText(current);
  // First readable value: the baseline the next one is compared against.
  if (previous === null) return { kind: 'baseline' };
  // A clipboard that was just cleared, or holds only whitespace, is not a query.
  if (query === '') return { kind: 'idle' };
  // Nothing a dictionary could answer (a URL, a paragraph of English).
  if (!isTextLookupWorthy(query)) return { kind: 'idle' };
  // Same word again — the common case, since this runs once a second.
  if (query === normalizeSearchQuery(previous)) return { kind: 'idle' };
  return { kind: 'search', query };
}

/**
 * True while this page is allowed to read the clipboard.
 *
 * A platform condition, not a preference: Windows and Android both hand the
 * clipboard to the FOREGROUND app only, so a sample taken while the window is
 * unfocused or hidden comes back empty (Android) or reports whatever the app that
 * does have focus copied last (Windows) — which would paste a stranger's clipboard
 * into the field the moment the user comes back.
 *
 * The focus and visibility listeners are what re-sample the instant this turns
 * true again, so no copy is missed while the page waits.
 */
export function isSearchPageActive(
  hasFocus: boolean,
  visibilityState: string,
): boolean {
  return hasFocus && visibilityState === 'visible';
}
