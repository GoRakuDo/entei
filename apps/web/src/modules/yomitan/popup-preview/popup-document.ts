/**
 * popup-document — the iframe document the popup preview shows.
 * ---------------------------------------------------------------------------
 * Upstream, the Appearance preview is TWO documents in TWO frames: a preview page
 * (`ext/popup-preview.html`) with an editable example term, and the real popup
 * (`ext/popup.html`) floating inside it. An iframe `srcdoc` can only be one
 * document, so this is the popup one — the half that carries the dictionary
 * content and every appearance setting.
 *
 * What makes the card identical to Yomitan's is not this file: the markup comes
 * from Yomitan's own `DisplayGenerator` (see `popup-entries.ts`) and the CSS is
 * Yomitan's own unmodified stylesheets (see `public/yomitan/README.md`). This
 * module only assembles them, and it is PURE — a string in, a string out — so the
 * whole document is unit-testable without a browser.
 *
 * The one block of CSS written here is the page reset and the popup frame's own
 * colours, which upstream lives in the HOST page's stylesheets
 * (`popup-preview.css`'s `html, body` reset and `popup-outer.css`'s
 * `iframe.yomitan-popup` colours). Those declarations are restated verbatim and
 * re-targeted to this document's root, because a `srcdoc` preview has no host
 * frame to style.
 * ---------------------------------------------------------------------------
 */

/** The term every lookup of this preview runs (upstream's own example word). */
export const POPUP_PREVIEW_TERM = '読め';

/**
 * Shown in place of the card when no dictionary can answer.
 *
 * Upstream's own `popup-preview.html` sentence — the preview's "nothing to show"
 * message, kept word for word.
 */
export const POPUP_PREVIEW_PLACEHOLDER =
  'This page uses the dictionaries you have installed in order to show a preview. If you see this message, make sure you have a dictionary installed.';

/**
 * Page reset + popup frame colours, restated from upstream.
 *
 * - `html, body` is `ext/css/popup-preview.css`'s rule, verbatim.
 * - the two `background-color` values are `ext/css/popup-outer.css`'s
 *   `iframe.yomitan-popup` / `[data-theme=dark]` colours, verbatim.
 *
 * Without the reset the browser's default 8px body margin would offset the whole
 * card; without the colours the frame would be transparent, since upstream the
 * POPUP document is transparent and the frame element paints the background.
 */
const FRAME_RESET_CSS = `
html, body {
    margin: 0;
    padding: 0;
    border: 0;
    overflow: hidden;
    width: 100%;
    height: 100%;
}
html {
    background-color: #ffffff;
}
html[data-theme=dark] {
    background-color: #1e1e1e;
}
`.trim();

/** What the document is assembled from. */
export interface PopupDocumentInput {
  /** Yomitan's own stylesheets, concatenated in cascade order. */
  css: string;
  /** `data-theme` and friends for the document element. */
  themeAttributes: Readonly<Record<string, string>>;
  /** Inline font styles for the document element (may be empty). */
  fontStyle: string;
  /** `general.customPopupCss` (may be empty). */
  customCss: string;
  /** `data-popup-action-bar-location` value. */
  popupActionBarLocation?: 'top' | 'bottom' | 'left' | 'right';
  /** `data-popup-action-bar-visibility` value. */
  popupActionBarVisibility?: 'always' | 'auto';
  /**
   * Markup of the dictionary entries, from Yomitan's `DisplayGenerator`. An empty
   * string draws the placeholder instead.
   */
  entriesHtml: string;
}

/**
 * Neutralise a sequence that would end a `<style>` element early.
 *
 * The custom CSS is user input pasted into a settings field; the upstream
 * extension injects it as a text node, but here it is serialized into a document
 * string. Escaping the closing tag's slash keeps it CSS-identical for every
 * legitimate rule while making it impossible to break out of the stylesheet.
 */
function neutralizeStyleBreakout(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

/** Escape text for an HTML attribute value delimited by double quotes. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * `{ theme: 'dark', outerTheme: 'none' }` → ` data-theme="dark" data-outer-theme="none"`.
 *
 * The keys are `dataset` names, which is how `ThemeController` writes them and how
 * `resolvePopupThemeAttributes` hands them back. Two conversions happen here, at
 * the one place that serializes them: the `data-` prefix the DOM strips on the way
 * in, and the kebab case it expects on the way out — `dataset.outerTheme` IS
 * `data-outer-theme`, and an HTML parser would lowercase `data-outerTheme` into an
 * attribute no selector can match. Attribute order follows insertion order.
 */
function renderThemeAttributes(
  attributes: Readonly<Record<string, string>>,
): string {
  return Object.entries(attributes)
    .map(([name, value]) => {
      const attribute = `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      return ` ${escapeAttribute(attribute)}="${escapeAttribute(value)}"`;
    })
    .join('');
}

/**
 * The empty state, as the popup itself would draw a message entry.
 *
 * `#no-dictionaries` is `ext/popup.html`'s own block; only its sentence is
 * replaced by the preview's, which is the one that explains what the preview is.
 */
function renderPlaceholder(): string {
  const text = escapeAttribute(POPUP_PREVIEW_PLACEHOLDER);
  return `<div class="entry active" id="no-dictionaries"><p>${text}</p></div>`;
}

/**
 * Build the preview document.
 *
 * Structure follows `ext/popup.html`'s body: the scroll container, the content
 * body, the entry list, and the content-sidebar (action bar with `<`, `>`, `×`
 * buttons) configured via `data-popup-action-bar-location` and
 * `data-popup-action-bar-visibility`.
 */
export function buildPopupDocument(input: PopupDocumentInput): string {
  const {
    css,
    themeAttributes,
    fontStyle,
    customCss,
    entriesHtml,
    popupActionBarLocation = 'top',
    popupActionBarVisibility = 'always',
  } = input;
  const style = fontStyle === '' ? '' : ` style="${escapeAttribute(fontStyle)}"`;
  const hasEntries = entriesHtml !== '';
  const body = hasEntries ? entriesHtml : renderPlaceholder();

  const sheets = [
    `<style>\n${neutralizeStyleBreakout(css)}\n</style>`,
    `<style>\n${FRAME_RESET_CSS}\n</style>`,
  ];
  if (customCss.trim() !== '') {
    sheets.push(`<style>\n${neutralizeStyleBreakout(customCss)}\n</style>`);
  }

  return `<!DOCTYPE html>
<html lang="ja" data-page-type="popup" data-popup-action-bar-location="${escapeAttribute(popupActionBarLocation)}" data-popup-action-bar-visibility="${escapeAttribute(popupActionBarVisibility)}"${renderThemeAttributes(themeAttributes)}${style}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yomitan Popup Preview</title>
${sheets.join('\n')}
</head>
<body>
<div class="content-outer"><div class="content"><div class="content-scroll contain-overscroll scrollbar" id="content-scroll"><div class="content-body" id="content-body"><div class="content-body-inner">
<span tabindex="-1" id="content-scroll-focus"></span>
<div class="search-header"></div>
<div id="dictionary-entries">${body}</div>
<div id="no-results"${hasEntries ? ' hidden' : ''}><div class="entry"><p>No results found.</p></div></div>
</div></div></div></div><div class="content-sidebar scrollbar" id="content-sidebar"><div class="content-sidebar-inner"><div class="content-sidebar-top-pre"><button class="sidebar-button danger" data-action="close" id="close-button" title="Close popup"><span class="sidebar-button-icon icon" data-icon="cross"></span></button></div><div class="content-sidebar-top"><button class="sidebar-button" data-action="navigate-previous" disabled id="navigate-previous-button" title="Previous definition"><span class="sidebar-button-icon icon" data-icon="left-chevron"></span></button><button class="sidebar-button" data-action="navigate-next" disabled id="navigate-next-button" title="Next definition"><span class="sidebar-button-icon icon" data-icon="right-chevron"></span></button></div></div></div></div>
</body>
</html>`;
}