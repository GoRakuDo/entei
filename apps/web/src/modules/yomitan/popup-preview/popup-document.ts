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

import { POPUP_FRAME_CHANNEL } from '@/modules/yomitan/popup-preview/popup-frame';

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
 * - the trailing `.action-button[data-action=menu]` rule is Entei's OWN override
 *   (not upstream): the per-entry `⋮` debug menu has no place in Entei's popup,
 *   so it is hidden in this one document — the single srcdoc both the settings
 *   preview and the floating popup render through, so both lose the button.
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
/* Hide the per-entry ⋮ (kebab) menu button in the popup. */
.action-button[data-action=menu] {
    display: none !important;
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
  /**
   * Whether the history stack can still step BACK (`<`).
   *
   * Written on the document element as `data-has-navigation-previous`, which is
   * what upstream's own `display.css` keys the sidebar's visibility off, and
   * mirrored on the button's `disabled`. Both, because upstream does both: the
   * attribute decides whether the bar exists at all under
   * `data-popup-action-bar-visibility=auto`, the attribute on the button is what
   * greys the glyph out.
   */
  hasNavigationPrevious?: boolean;
  /**
   * Whether the history stack can still step FORWARD (`>`).
   */
  hasNavigationNext?: boolean;
  /**
   * Upstream's `dictionary-entry-popup-menu` templates (`popup-entries`
   * extracts them), embedded so the frame can instantiate the entry's own `⋮`
   * menu. An empty string leaves that button inert, which is what a template set
   * without them gets.
   */
  menuTemplates?: string;
  /**
   * What to draw when `entriesHtml` is empty.
   *
   * `placeholder` (the default) is the settings preview's "install a dictionary"
   * sentence — correct when there was nothing to look the text up WITH.
   * `no-results` is upstream's own `#no-results` block — correct when the
   * dictionaries answered and had nothing, which is what a kanji lookup outside
   * KANJIDIC returns.
   */
  emptyState?: 'placeholder' | 'no-results';
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
 * The bridge script the frame runs.
 *
 * The host cannot listen to a sandboxed document (`contentDocument` is `null`),
 * so every click that means something is forwarded as a `postMessage`. Three
 * targets: a kanji in a headword (upstream's `.headword-kanji-link`, which the
 * generator already emits and `display.js` already binds a lookup to), the action
 * bar's three buttons, and the entry's `⋮` button.
 *
 * THE `⋮` MENU IS DRAWN HERE, not in the host, because it belongs to the DOCUMENT:
 * its markup is upstream's own template, its styles are upstream's own
 * `material.css` already loaded in this frame, and it is positioned against the
 * button that opened it. Only the one thing the frame cannot do — print the
 * entry's data, which lives in the host — crosses the boundary. This is upstream's
 * `PopupMenu` + `Display._onMenuButtonClick` reduced to what a popup needs:
 * instantiate, position, close on an item / an outside press / Escape / a resize.
 *
 * Deliberately dependency-free and evaluated once per document. It reports, it
 * does not decide: the history stack, the lookups and the re-render all belong to
 * the host, because only the host can reach the dictionary engine.
 */
const FRAME_BRIDGE_SCRIPT = `
(function () {
    var CHANNEL = ${JSON.stringify(POPUP_FRAME_CHANNEL)};
    var MENU_CONTAINER_ID = 'dictionary-entry-popup-menu-template';
    var MENU_ITEM_ID = 'dictionary-entry-popup-menu-item-template';
    var MENU_ITEM_ACTION = 'log-debug-info';
    var MENU_ITEM_LABEL = 'Log debug info';
    /* The OPEN menu, or null. NOT called openMenu: upstream keeps this state in
       PopupMenu.openMenus precisely so it cannot collide with the function that
       opens one — a var of the same name would overwrite the hoisted function and
       the second press would throw. */
    var activeMenu = null;

    function send(message) {
        message.channel = CHANNEL;
        if (window.parent !== window) {
            window.parent.postMessage(message, '*');
        }
    }

    /* Upstream Display.getElementDictionaryEntryIndex: the index popup-entries
       wrote on the entry this button belongs to, or -1 outside any entry. */
    function entryIndex(node) {
        var entry = node.closest('.entry');
        if (entry === null) { return -1; }
        var value = entry.getAttribute('data-index');
        if (value === null) { return -1; }
        var index = Number.parseInt(value, 10);
        return Number.isFinite(index) ? index : -1;
    }

    function closeMenu() {
        if (activeMenu === null) { return; }
        var menu = activeMenu;
        activeMenu = null;
        menu.container.removeEventListener('click', onMenuContainerClick, false);
        menu.item.removeEventListener('click', onMenuItemClick, false);
        window.removeEventListener('resize', onWindowResize, false);
        if (menu.container.parentNode !== null) {
            menu.container.parentNode.removeChild(menu.container);
        }
    }

    function onMenuContainerClick(event) {
        /* A press on the backdrop rather than on the menu: upstream closes on it. */
        if (activeMenu === null || event.currentTarget !== event.target) { return; }
        closeMenu();
        event.stopPropagation();
        event.preventDefault();
    }

    function onMenuItemClick(event) {
        var item = event.currentTarget;
        if (activeMenu === null || item.disabled) { return; }
        var action = item.getAttribute('data-menu-action');
        var index = entryIndex(activeMenu.source);
        closeMenu();
        event.stopPropagation();
        event.preventDefault();
        if (action === MENU_ITEM_ACTION && index >= 0) {
            send({ type: 'log-debug-info', index: index });
        }
    }

    function onWindowResize() {
        closeMenu();
    }

    /* Upstream PopupMenu._setPosition: the flags come off the BUTTON
       ('left below h-cover v-cover'), and the result is clamped inside the
       container so a menu near the frame's edge cannot hang outside it. */
    function positionMenu(container, source) {
        var menu = container.querySelector('.popup-menu');
        var body = container.querySelector('.popup-menu-body');
        if (menu === null || body === null) { return; }
        var horizontal = 1;
        var vertical = 1;
        var horizontalCover = 1;
        var verticalCover = 1;
        var info = source.getAttribute('data-menu-position');
        if (info !== null) {
            var flags = info.split(' ');
            if (flags.indexOf('left') >= 0) { horizontal = -1; }
            else if (flags.indexOf('right') >= 0) { horizontal = 1; }
            else if (flags.indexOf('h-center') >= 0) { horizontal = 0; }
            if (flags.indexOf('above') >= 0) { vertical = -1; }
            else if (flags.indexOf('below') >= 0) { vertical = 1; }
            else if (flags.indexOf('v-center') >= 0) { vertical = 0; }
            if (flags.indexOf('cover') >= 0) { horizontalCover = 1; verticalCover = 1; }
            else if (flags.indexOf('no-cover') >= 0) { horizontalCover = -1; verticalCover = -1; }
            if (flags.indexOf('h-cover') >= 0) { horizontalCover = 1; }
            else if (flags.indexOf('no-h-cover') >= 0) { horizontalCover = -1; }
            if (flags.indexOf('v-cover') >= 0) { verticalCover = 1; }
            else if (flags.indexOf('no-v-cover') >= 0) { verticalCover = -1; }
        }
        var containerRect = container.getBoundingClientRect();
        var sourceRect = source.getBoundingClientRect();
        var menuRect = menu.getBoundingClientRect();
        var top = menuRect.top;
        var bottom = menuRect.bottom;
        if (verticalCover === 1) {
            var bodyRect = body.getBoundingClientRect();
            top = bodyRect.top;
            bottom = bodyRect.bottom;
        }
        var x = sourceRect.left + sourceRect.width * ((-horizontal * horizontalCover + 1) * 0.5) + menuRect.width * ((-horizontal + 1) * -0.5);
        var y = sourceRect.top + (menuRect.top - top) + sourceRect.height * ((-vertical * verticalCover + 1) * 0.5) + (bottom - top) * ((-vertical + 1) * -0.5);
        x = Math.max(0, Math.min(containerRect.width - menuRect.width, x));
        y = Math.max(0, Math.min(containerRect.height - menuRect.height, y));
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    }

    function openMenu(source) {
        /* Upstream allows one open menu at a time: a second menu-button press
           replaces it. */
        closeMenu();
        var template = document.getElementById(MENU_CONTAINER_ID);
        var itemTemplate = document.getElementById(MENU_ITEM_ID);
        var host = document.getElementById('popup-menus');
        if (template === null || itemTemplate === null || host === null) { return; }
        var container = template.content.firstElementChild.cloneNode(true);
        var item = itemTemplate.content.firstElementChild.cloneNode(true);
        var label = item.querySelector('.popup-menu-item-label');
        if (label !== null) { label.textContent = MENU_ITEM_LABEL; }
        item.setAttribute('data-menu-action', MENU_ITEM_ACTION);
        var body = container.querySelector('.popup-menu-body');
        if (body === null) { return; }
        body.appendChild(item);
        host.appendChild(container);
        activeMenu = { container: container, item: item, source: source };
        positionMenu(container, source);
        container.focus();
        container.addEventListener('click', onMenuContainerClick, false);
        item.addEventListener('click', onMenuItemClick, false);
        window.addEventListener('resize', onWindowResize, false);
    }

    document.addEventListener('keydown', function (event) {
        if (activeMenu === null) { return; }
        if (event.key === 'Escape') {
            event.preventDefault();
            closeMenu();
        }
    }, false);

    document.addEventListener('click', function (event) {
        var target = event.target;
        if (target === null || typeof target.closest !== 'function') { return; }
        var kanji = target.closest('.headword-kanji-link');
        if (kanji !== null) {
            event.preventDefault();
            var character = (kanji.textContent || '').trim();
            if (character !== '') { send({ type: 'kanji', character: character }); }
            return;
        }
        var menuButton = target.closest('.action-button[data-action=menu]');
        if (menuButton !== null) {
            event.preventDefault();
            openMenu(menuButton);
            return;
        }
        var button = target.closest('button[data-action]');
        if (button === null || button.disabled) { return; }
        switch (button.getAttribute('data-action')) {
            case 'close': send({ type: 'close' }); break;
            case 'navigate-previous': send({ type: 'previous' }); break;
            case 'navigate-next': send({ type: 'next' }); break;
        }
    });
})();
`.trim();

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
    hasNavigationPrevious = false,
    hasNavigationNext = false,
    menuTemplates = '',
    emptyState = 'placeholder',
  } = input;
  const style = fontStyle === '' ? '' : ` style="${escapeAttribute(fontStyle)}"`;
  const hasEntries = entriesHtml !== '';
  const body = hasEntries
    ? entriesHtml
    : emptyState === 'no-results'
      ? ''
      : renderPlaceholder();
  const showNoResults = !hasEntries && emptyState === 'no-results';

  const sheets = [
    `<style>\n${neutralizeStyleBreakout(css)}\n</style>`,
    `<style>\n${FRAME_RESET_CSS}\n</style>`,
  ];
  if (customCss.trim() !== '') {
    sheets.push(`<style>\n${neutralizeStyleBreakout(customCss)}\n</style>`);
  }

  return `<!DOCTYPE html>
<html lang="ja" data-page-type="popup" data-popup-action-bar-location="${escapeAttribute(popupActionBarLocation)}" data-popup-action-bar-visibility="${escapeAttribute(popupActionBarVisibility)}" data-has-navigation-previous="${hasNavigationPrevious}" data-has-navigation-next="${hasNavigationNext}"${renderThemeAttributes(themeAttributes)}${style}>
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
<div id="no-results"${showNoResults ? '' : ' hidden'}><div class="entry"><p>No results found.</p></div></div>
</div></div></div></div><div class="content-sidebar scrollbar" id="content-sidebar"><div class="content-sidebar-inner"><div class="content-sidebar-top-pre"><button type="button" class="sidebar-button danger" data-action="close" id="close-button" title="Close popup"><span class="sidebar-button-icon icon" data-icon="cross"></span></button></div><div class="content-sidebar-top"><button type="button" class="sidebar-button" data-action="navigate-previous"${hasNavigationPrevious ? '' : ' disabled'} id="navigate-previous-button" title="Previous definition"><span class="sidebar-button-icon icon" data-icon="left-chevron"></span></button><button type="button" class="sidebar-button" data-action="navigate-next"${hasNavigationNext ? '' : ' disabled'} id="navigate-next-button" title="Next definition"><span class="sidebar-button-icon icon" data-icon="right-chevron"></span></button></div></div></div></div>
<div id="popup-menus"></div>
${menuTemplates}
<script>
${FRAME_BRIDGE_SCRIPT}
</script>
</body>
</html>`;
}