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

/**
 * The speaker buttons' playback config, embedded into the frame as JSON.
 *
 * A SANDBOXED iframe (`allow-scripts`, no `allow-same-origin`) cannot reach the
 * host's Yomitan options tree, so the host hands the frame the ONE thing its
 * bridge script needs to play audio: the configured sources (already shaped and
 * labelled by `audio-sources.ts`) and the volume. The term/reading themselves the
 * frame reads off its own card DOM (the headword), so they do not cross the
 * boundary.
 */
export interface PopupAudioSource {
  index: number;
  type: string;
  url: string;
  name: string;
  /** Which duplicate of a shared `type` this is (0-based), from `audio-sources`. */
  nameIndex: number;
  /** `name` alone identifies this source (no sibling of the same type). */
  nameUnique: boolean;
  /** Whether the frame can resolve this source on its own (see audio-resolver). */
  clientPlayable: boolean;
}

/** `audioConfig` — the frame's audio playback config (see module note above). */
export interface PopupAudioConfig {
  sources: readonly PopupAudioSource[];
  /** Stored volume, 0–100. */
  volume: number;
}

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
   * Upstream's `audio-button-popup-menu` templates (`popup-entries` extracts
   * them), embedded so the frame can instantiate the speaker button's own
   * audio-source menu. An empty string leaves the speaker button playing audio
   * without a menu (a template set without them).
   */
  audioMenuTemplates?: string;
  /**
   * The speaker buttons' playback config: the configured sources and the volume.
   * Embedded as JSON the frame's bridge script reads, because a sandboxed iframe
   * cannot reach the host's options tree. `null` disables audio in the frame.
   */
  audioConfig?: PopupAudioConfig | null;
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
 * The dataset names `resolvePopupAppearance` hands over, as `data-` ATTRIBUTES.
 *
 * `{ theme: 'dark', outerTheme: 'none' }` →
 * `{ 'data-theme': 'dark', 'data-outer-theme': 'none' }`.
 *
 * The keys are `dataset` names, which is how `ThemeController` writes them and how
 * `resolvePopupThemeAttributes` hands them back. Two conversions happen where they
 * are CONSUMED: the `data-` prefix the DOM strips on the way in, and the kebab case
 * it expects on the way out — `dataset.outerTheme` IS `data-outer-theme`, and an
 * HTML parser would lowercase `data-outerTheme` into an attribute no selector can
 * match. Attribute order follows insertion order.
 *
 * Two hosts draw these cards, and they need the same two conversions in different
 * shapes: the iframe document serializes them into markup (`renderThemeAttributes`
 * below), while `/search/` writes them on a real element in the host document
 * (`YomitanSearchApp`), where React would emit `theme="dark"` for a spread of the
 * raw record. Both read from here.
 */
export function toDataAttributes(
  attributes: Readonly<Record<string, string>>,
): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) {
    data[`data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] = value;
  }
  return data;
}

/** `{ theme: 'dark' }` → ` data-theme="dark"` — [`toDataAttributes`], serialized. */
function renderThemeAttributes(
  attributes: Readonly<Record<string, string>>,
): string {
  return Object.entries(toDataAttributes(attributes))
    .map(([name, value]) => ` ${escapeAttribute(name)}="${escapeAttribute(value)}"`)
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
  return `<div class="entry entry-current" id="no-dictionaries"><p>${text}</p></div>`;
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

    /* ----------------------------------------------------------------
       Audio playback + the speaker button's source menu.

       The host hands the configured sources and volume in a JSON script
       (#popup-audio-config), because a sandboxed frame cannot read the host's
       options tree. The term/reading come off the card DOM (the headword), so
       they never cross the boundary. Only the client-resolvable sources actually
       play (jpod101 CDN, the user's custom URL); the rest are listed but resolve
       to nothing here, exactly like the /search/ page's resolver.
       -------------------------------------------------------------- */
    var AUDIO_CONFIG = null;
    var AUDIO_MENU_CONTAINER_ID = 'audio-button-popup-menu-template';
    var AUDIO_MENU_ITEM_ID = 'audio-button-popup-menu-item-template';
    var PLAY_AUDIO_TITLE = 'Play audio (Alt + P)';
    var currentAudio = null;
    var activeAudioMenu = null;
    /* The track that last played per headword key, so a plain click replays it
       (the same "resolved primary" memory the /search/ controller keeps). Now a
       { sourceIndex, subIndex } ref so it can point at ONE track of a custom-json
       source that expanded into several. */
    var resolvedPrimary = {};
    /* The user's explicit "Use as audio for Anki card" choice per headword key,
       also a { sourceIndex, subIndex } ref. Separate from resolvedPrimary so the
       playback auto-primary and the Anki card-audio pin stay independent. */
    var ankiPrimary = {};
    /* Resolved track lists per headword key, ONE ARRAY PER CONFIGURED SOURCE in
       source order — the same shape the host's resolveAudioSourcesForTerm returns.
       The HOST resolves the whole word (every source, including jpod101 and
       custom-json) because this sandboxed frame cannot fetch a custom-json
       payload; the tracks come over postMessage and are cached here once they
       land. An entry exists only once resolved (a missing key = not yet asked). */
    var resolvedTracks = {};
    /* The in-flight resolve-audio-tracks request, or null: { requestId, key }.
       One request at a time — the menu is singular. */
    var pendingAudioRequest = null;
    /* A play press that could not resolve (its word's custom-json tracks were not
       in yet), waiting for the host answer to fire. */
    var pendingPlay = null;
    /* The speaker button whose menu is open while its word's tracks are still
       resolving — when the host answers, the menu is re-opened with real rows. */
    var pendingMenuSource = null;
    var audioRequestSeq = 0;

    function primaryKey(term, reading) { return term + '\u0000' + reading; }

    /* The menu label for one source: the friendly name alone when it is unique,
       else the name with its 1-based duplicate number ("Custom URL 1"). */
    function sourceLabel(source) {
        return source.nameUnique === true
            ? source.name
            : source.name + ' ' + (source.nameIndex + 1);
    }

    function readAudioConfig() {
        var node = document.getElementById('popup-audio-config');
        if (node === null) { return null; }
        try { return JSON.parse(node.textContent || '{}'); } catch (e) { return null; }
    }

    /* ---- track resolution -----------------------------------------------
       The frame builds NOTHING itself any more. A custom-json source needs a
       network fetch this sandboxed frame cannot make (no CORS on the target,
       no native plugin), so the HOST resolves the WHOLE word — every source —
       and answers over postMessage (the same resolveAudioSourcesForTerm the
       /search/ page uses). The frame caches that per-source track array and
       renders the menu from it. Until it lands, a menu shows a loading row and
       a plain click is deferred (pendingPlay).
       -------------------------------------------------------------- */
    function requestTracks(key, term, reading) {
        if (resolvedTracks[key] !== undefined) { return; }
        if (pendingAudioRequest !== null && pendingAudioRequest.key === key) { return; }
        var id = ++audioRequestSeq;
        pendingAudioRequest = { requestId: id, key: key };
        send({ type: 'resolve-audio-tracks', requestId: id, term: term, reading: reading });
    }

    /* The menu label for one resolved track. A source that expanded into SEVERAL
       tracks labels each "<source> <n>: <name>" (upstream's
       "Custom URL (JSON) 1: SMK8 …"); a single-track source keeps its plain name. */
    function trackLabel(source, track, expanded) {
        var base = sourceLabel(source);
        if (!expanded) { return base; }
        return base + ' ' + (track.subIndex + 1) + (track.name !== undefined ? ': ' + track.name : '');
    }

    /* Which track a play press should play: the menu's explicit choice, else the
       track that worked before, else the first playable one. null = none. */
    function pickTrack(key, tracks, preferred) {
        if (preferred !== null && preferred !== undefined) {
            var group = tracks[preferred.sourceIndex];
            if (group !== undefined && group[preferred.subIndex] !== undefined) { return group[preferred.subIndex]; }
        }
        var remembered = resolvedPrimary[key];
        if (remembered !== undefined) {
            var rg = tracks[remembered.sourceIndex];
            if (rg !== undefined && rg[remembered.subIndex] !== undefined) { return rg[remembered.subIndex]; }
        }
        for (var i = 0; i < tracks.length; ++i) {
            if (tracks[i] !== undefined && tracks[i].length > 0) { return tracks[i][0]; }
        }
        return null;
    }

    function stopAudio() {
        if (currentAudio !== null) { currentAudio.pause(); currentAudio = null; }
    }

    function playUrl(url) {
        stopAudio();
        var audio = new Audio(url);
        audio.volume = (AUDIO_CONFIG && isFinite(AUDIO_CONFIG.volume))
            ? Math.max(0, Math.min(1, AUDIO_CONFIG.volume / 100)) : 1;
        currentAudio = audio;
        var played = audio.play();
        if (played !== undefined) {
            played.catch(function () { /* autoplay policy / interrupted: ignore. */ });
        }
    }

    /* A headword's base term (ruby base, rt readings removed) and reading. */
    function headwordOf(button) {
        var entry = button.closest('.entry');
        if (entry === null) { return null; }
        var headword = button.closest('.headword');
        var scope = headword !== null ? headword : entry.querySelector('.headword');
        if (scope === null) { return null; }
        var termNode = scope.querySelector('.headword-term');
        if (termNode === null) { return null; }
        var clone = termNode.cloneNode(true);
        var rts = clone.querySelectorAll('rt');
        for (var i = 0; i < rts.length; ++i) { rts[i].parentNode.removeChild(rts[i]); }
        var term = (clone.textContent || '').trim();
        var readingNode = scope.querySelector('.headword-reading');
        var reading = readingNode !== null ? (readingNode.textContent || '').trim() : '';
        if (term === '') { return null; }
        return { term: term, reading: reading };
    }

    function playFromButton(button, preferred) {
        if (AUDIO_CONFIG === null) { return; }
        var headword = headwordOf(button);
        if (headword === null) { return; }
        var key = primaryKey(headword.term, headword.reading);
        var tracks = resolvedTracks[key];
        if (tracks === undefined) {
            /* Tracks not resolved yet (custom-json needs the host). Ask, and fire
               this exact play when the answer lands — the press is not lost. */
            pendingPlay = { key: key, button: button, preferred: preferred };
            requestTracks(key, headword.term, headword.reading);
            return;
        }
        var track = pickTrack(key, tracks, preferred);
        if (track === null) {
            button.title = PLAY_AUDIO_TITLE + '\nCould not find audio';
            return;
        }
        var source = (AUDIO_CONFIG.sources || [])[track.sourceIndex];
        var expanded = source !== undefined && tracks[track.sourceIndex] !== undefined && tracks[track.sourceIndex].length > 1;
        playUrl(track.url);
        resolvedPrimary[key] = { sourceIndex: track.sourceIndex, subIndex: track.subIndex };
        button.title = PLAY_AUDIO_TITLE + '\nFrom ' + (source !== undefined ? trackLabel(source, track, expanded) : 'audio');
    }

    function closeAudioMenu() {
        if (activeAudioMenu === null) { return; }
        var menu = activeAudioMenu;
        activeAudioMenu = null;
        menu.container.removeEventListener('click', onAudioMenuContainerClick, false);
        window.removeEventListener('resize', onWindowResize, false);
        if (menu.container.parentNode !== null) {
            menu.container.parentNode.removeChild(menu.container);
        }
    }

    function onAudioMenuContainerClick(event) {
        if (activeAudioMenu === null || event.currentTarget !== event.target) { return; }
        closeAudioMenu();
        event.stopPropagation();
        event.preventDefault();
    }

    function renderAudioMenuItems(itemTemplate, body, sources, key, tracks) {
        var ankiPin = ankiPrimary[key];
        for (var i = 0; i < sources.length; ++i) {
            var src = sources[i];
            var group = tracks[i] !== undefined ? tracks[i] : [];
            var expanded = group.length > 1;
            if (group.length === 0) {
                /* Configured but resolved to nothing (a scraping source, or a
                   custom-json word with no tracks): one disabled row so the user
                   still sees the source is configured. */
                appendAudioMenuItem(itemTemplate, body, src, { sourceIndex: src.index, subIndex: 0, url: '' }, key, ankiPin, false, false);
                continue;
            }
            for (var t = 0; t < group.length; ++t) {
                appendAudioMenuItem(itemTemplate, body, src, group[t], key, ankiPin, true, expanded);
            }
        }
    }

    function appendAudioMenuItem(itemTemplate, body, source, track, key, ankiPin, playable, expanded) {
        var item = itemTemplate.content.firstElementChild.cloneNode(true);
        var label = item.querySelector('.popup-menu-item-label');
        if (label !== null) {
            label.textContent = playable ? trackLabel(source, track, expanded) : sourceLabel(source);
        }
        /* "Use as audio for Anki card" button: pins THIS track ({ sourceIndex,
           subIndex }) as the card-audio primary (upstream's setPrimaryAudio). */
        var setPrimary = item.querySelector('.popup-menu-item-set-primary-audio-button');
        if (setPrimary !== null) {
            var isPinned = ankiPin !== undefined && ankiPin.sourceIndex === track.sourceIndex && ankiPin.subIndex === track.subIndex;
            if (isPinned) { item.setAttribute('data-is-primary-card-audio', 'true'); }
            setPrimary.addEventListener('click', function (event) {
                event.stopPropagation();
                event.preventDefault();
                ankiPrimary[key] = { sourceIndex: track.sourceIndex, subIndex: track.subIndex };
                closeAudioMenu();
            }, false);
        }
        item.setAttribute('data-index', String(track.sourceIndex));
        item.setAttribute('data-sub-index', String(track.subIndex));
        if (!playable) { item.setAttribute('data-client-playable', 'false'); }
        body.appendChild(item);
    }

    function openAudioMenu(source) {
        if (AUDIO_CONFIG === null) { return; }
        var sources = AUDIO_CONFIG.sources || [];
        if (sources.length === 0) { return; }
        var headword = headwordOf(source);
        if (headword === null) { return; }
        var key = primaryKey(headword.term, headword.reading);
        var tracks = resolvedTracks[key];
        if (tracks === undefined) {
            /* Tracks not resolved yet (custom-json needs the host): show a loading
               row now, ask the host, and re-open with real rows when it answers. */
            pendingMenuSource = source;
            requestTracks(key, headword.term, headword.reading);
            tracks = [];
        } else {
            pendingMenuSource = null;
        }
        closeAudioMenu();
        var template = document.getElementById(AUDIO_MENU_CONTAINER_ID);
        var itemTemplate = document.getElementById(AUDIO_MENU_ITEM_ID);
        var host = document.getElementById('popup-menus');
        if (template === null || itemTemplate === null || host === null) { return; }
        var container = template.content.firstElementChild.cloneNode(true);
        var body = container.querySelector('.popup-menu-body');
        if (body === null) { return; }
        if (pendingMenuSource === source) {
            /* Loading placeholder: one disabled row while the host resolves. */
            var loading = itemTemplate.content.firstElementChild.cloneNode(true);
            var loadingLabel = loading.querySelector('.popup-menu-item-label');
            if (loadingLabel !== null) { loadingLabel.textContent = sourceLabel(sources[0]) + ' \u2026'; }
            loading.setAttribute('data-client-playable', 'false');
            var loadingButton = loading.querySelector('.popup-menu-item-audio-button');
            if (loadingButton !== null) { loadingButton.disabled = true; }
            body.appendChild(loading);
        } else {
            renderAudioMenuItems(itemTemplate, body, sources, key, tracks);
        }
        host.appendChild(container);
        activeAudioMenu = { container: container, source: source, key: key };
        positionMenu(container, source);
        container.focus();
        container.addEventListener('click', onAudioMenuContainerClick, false);
        window.addEventListener('resize', onWindowResize, false);
        var items = body.querySelectorAll('.popup-menu-item-audio-button');
        for (var j = 0; j < items.length; ++j) {
            items[j].addEventListener('click', onAudioMenuItemClick, false);
        }
    }

    /* The host's answer to a resolve-audio-tracks request: cache the word's
       per-source tracks, then fire whatever was waiting — a deferred plain-click
       play, or the open menu that showed a loading row. */
    function onAudioTracks(data) {
        if (pendingAudioRequest === null || data.requestId !== pendingAudioRequest.requestId) { return; }
        var key = pendingAudioRequest.key;
        pendingAudioRequest = null;
        resolvedTracks[key] = data.tracks || [];
        if (pendingPlay !== null && pendingPlay.key === key) {
            var play = pendingPlay;
            pendingPlay = null;
            if (play.button.isConnected) { playFromButton(play.button, play.preferred); }
            return;
        }
        if (pendingMenuSource !== null && activeAudioMenu !== null && activeAudioMenu.key === key) {
            var src = pendingMenuSource;
            pendingMenuSource = null;
            if (src.isConnected) { openAudioMenu(src); }
        }
    }

    function onAudioMenuItemClick(event) {
        var item = event.currentTarget;
        if (activeAudioMenu === null || item.disabled) { return; }
        var sourceButton = activeAudioMenu.source;
        var group = item.closest('.popup-menu-item-group');
        var sourceIndex = Number.parseInt(group ? group.getAttribute('data-index') : '', 10);
        var subIndex = Number.parseInt(group ? group.getAttribute('data-sub-index') : '', 10);
        closeAudioMenu();
        event.stopPropagation();
        event.preventDefault();
        if (Number.isFinite(sourceIndex) && Number.isFinite(subIndex)) {
            playFromButton(sourceButton, { sourceIndex: sourceIndex, subIndex: subIndex });
        }
    }

    /* The buttons are wired once: the frame's card set is drawn once per document
       (a history step redraws the WHOLE document), so a direct bind is enough and
       avoids a second delegated branch in the click handler below. */
    function bindAudioButtons() {
        AUDIO_CONFIG = readAudioConfig();
        if (AUDIO_CONFIG === null) { return; }
        var buttons = document.querySelectorAll('.action-button[data-action=play-audio]');
        for (var i = 0; i < buttons.length; ++i) {
            (function (button) {
                button.title = PLAY_AUDIO_TITLE;
                button.addEventListener('click', function (event) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.shiftKey) { openAudioMenu(button); }
                    else { playFromButton(button, null); }
                }, false);
                button.addEventListener('contextmenu', function (event) {
                    event.preventDefault();
                    event.stopPropagation();
                    openAudioMenu(button);
                }, false);
            })(buttons[i]);
        }
    }

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
            if (activeAudioMenu !== null) { closeAudioMenu(); }
        }
        if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyP') {
            event.preventDefault();
            var entry = document.querySelector('.entry-current') || document.querySelector('.entry[data-index]');
            if (entry !== null) {
                var button = entry.querySelector('.action-button[data-action=play-audio]');
                if (button !== null) { playFromButton(button, null); }
            }
            return;
        }
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

    /* The host's answer to a resolve-audio-tracks request arrives here. The frame
       is sandboxed, so it cannot fetch a custom-json payload itself — the host
       (which reaches the native plugin) resolves and posts the tracks back. */
    window.addEventListener('message', function (event) {
        var data = event.data;
        if (data === null || typeof data !== 'object') { return; }
        if (data.channel !== CHANNEL || data.type !== 'audio-tracks') { return; }
        onAudioTracks(data);
    }, false);

    bindAudioButtons();
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
    audioMenuTemplates = '',
    audioConfig = null,
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
${audioMenuTemplates}
${renderAudioConfig(audioConfig)}
<script>
${FRAME_BRIDGE_SCRIPT}
</script>
</body>
</html>`;
}

/**
 * The frame's audio config, embedded as a JSON `<script>` the bridge reads.
 *
 * A `<script type="application/json">` is inert (never executed) and is the
 * standard data-to-frame channel. The closing-tag neutralisation below keeps a
 * crafted source name from breaking out of the element; the JSON itself is
 * generated from shaped, host-validated source records, not raw user text.
 */
function renderAudioConfig(audioConfig: PopupAudioConfig | null): string {
  if (audioConfig === null) return '';
  const json = JSON.stringify(audioConfig).replace(/<\//g, '<\\/');
  return `<script type="application/json" id="popup-audio-config">${json}</script>`;
}