/**
 * Yomitan's entry `⋮` menu — the frame's own behaviour, executed.
 * ---------------------------------------------------------------------------
 * Upstream draws this menu inside the popup document (`Display._onMenuButtonClick`
 * instantiating `dictionary-entry-popup-menu`, positioned by
 * `dom/popup-menu.js`), and so does Entei: the frame script `popup-document`
 * embeds is what opens it, closes it and reports the one item the host has to act
 * on. String assertions cannot show that it works — a menu that never opens, an
 * item that reports the wrong entry or a backdrop that swallows the next click all
 * look identical in a `srcdoc`.
 *
 * So this file RUNS the script: the real document (upstream's templates + the
 * frame's bridge) is loaded into a jsdom window, the `⋮` button is clicked, and
 * what the document did is read back off its DOM. The only seam is `postMessage` —
 * the boundary the sandboxed frame talks to its host across — which is captured
 * instead of delivered.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  POPUP_FRAME_CHANNEL,
  buildPopupDocument,
  extractPopupMenuTemplates,
  renderPopupEntriesHtml,
  type PopupDictionaryInfo,
} from '@/modules/yomitan/popup-preview';

/** The vendored template set, straight from `public/` (what the app serves). */
const DISPLAY_TEMPLATES = readFileSync(
  resolve(process.cwd(), 'public/yomitan/templates-display.html'),
  'utf8',
);

const DICTIONARIES: PopupDictionaryInfo[] = [{ title: 'JMdict', revision: '1.0' }];

/** One JMdict-shaped entry: enough for the generator to draw a real card. */
function termEntry(term: string): Record<string, unknown> {
  return {
    index: 0,
    type: 'term',
    isPrimary: true,
    textProcessorRuleChainCandidates: [],
    inflectionRuleChainCandidates: [],
    score: 100,
    frequency: 'normal',
    headwords: [
      {
        index: 0,
        term,
        reading: term,
        sources: [{ originalText: term, matchType: 'exact', matchSource: 'term', isPrimary: true }],
        tags: [],
        wordClasses: [],
      },
    ],
    definitions: [
      {
        dictionary: 'JMdict',
        dictionaryAlias: 'JMdict',
        tags: [],
        headwordIndices: [0],
        entries: ['to read'],
        isPrimary: true,
        score: 100,
      },
    ],
    frequencies: [],
    pronunciations: [],
  };
}

/** One open document, with the frame's own script running in it. */
function openFrame(entriesHtml: string): {
  window: Window & typeof globalThis;
  document: Document;
  sent: Record<string, unknown>[];
} {
  const srcDoc = buildPopupDocument({
    css: '/* vendored upstream css */',
    themeAttributes: { theme: 'dark', outerTheme: 'none', debug: 'true' },
    fontStyle: '',
    customCss: '',
    entriesHtml,
    menuTemplates: extractPopupMenuTemplates(DISPLAY_TEMPLATES),
  });

  const sent: Record<string, unknown>[] = [];
  const dom = new JSDOM(srcDoc, {
    runScripts: 'dangerously',
    /* The frame is sandboxed, so its `window.parent` is the HOST window — which
       is the only place its messages go. Here that host is this shim, and the
       test reads what it was told. */
    beforeParse(window) {
      const host = { postMessage: (message: unknown) => sent.push(message as Record<string, unknown>) };
      Object.defineProperty(window, 'parent', {
        configurable: true,
        value: host,
      });
    },
  });
  return {
    window: dom.window as unknown as Window & typeof globalThis,
    document: dom.window.document,
    sent,
  };
}

/** Press a mouse button on an element, the way a user does. */
function click(window: Window & typeof globalThis, target: Element): void {
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** The entry's own `⋮` button (upstream only shows it with `data-debug=true`). */
function menuButton(document: Document, index = 0): HTMLElement {
  const entries = document.querySelectorAll<HTMLElement>('#dictionary-entries > .entry');
  const button = entries[index]?.querySelector<HTMLElement>('.action-button[data-action=menu]');
  /* NOT an `instanceof` check: the node belongs to the jsdom window the document
     was built in, so its prototypes are another realm's. */
  if (button === undefined || button === null) throw new Error('no menu button');
  return button;
}

describe('yomitan entry menu — opening and closing', () => {
  it('opens upstream’s own menu under the button that was pressed', async () => {
    const entries = await renderPopupEntriesHtml(
      DISPLAY_TEMPLATES,
      [termEntry('読め')],
      DICTIONARIES,
    );
    const { window, document } = openFrame(entries);

    expect(document.querySelector('.dictionary-entry-popup-menu')).toBeNull();
    click(window, menuButton(document));

    const menu = document.querySelector('.dictionary-entry-popup-menu');
    expect(menu).not.toBeNull();
    // Upstream's own item, and its label comes from `display.js`.
    const label = menu?.querySelector('.popup-menu-item-label');
    expect(label?.textContent).toBe('Log debug info');
    // The menu is hosted in the popup's own container (`ext/popup.html`).
    expect(menu?.parentElement?.id).toBe('popup-menus');
    // Positioned against the button: a fixed backdrop with the menu placed on it.
    expect(menu?.querySelector('.popup-menu')?.getAttribute('style')).toContain('px');
  });

  it('closes on a second press, on the backdrop, on Escape and on a resize', async () => {
    const entries = await renderPopupEntriesHtml(
      DISPLAY_TEMPLATES,
      [termEntry('読め')],
      DICTIONARIES,
    );
    const { window, document } = openFrame(entries);
    const menu = (): Element | null => document.querySelector('.dictionary-entry-popup-menu');

    // A second press on the button replaces the open menu, it does not stack.
    click(window, menuButton(document));
    click(window, menuButton(document));
    expect(document.querySelectorAll('.dictionary-entry-popup-menu').length).toBe(1);

    // The backdrop covers the frame: a press on it is a press outside the menu.
    const container = menu();
    if (container === null) throw new Error('no menu');
    click(window, container);
    expect(menu()).toBeNull();

    click(window, menuButton(document));
    window.document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(menu()).toBeNull();

    click(window, menuButton(document));
    window.dispatchEvent(new window.Event('resize'));
    expect(menu()).toBeNull();
  });
});

describe('yomitan entry menu — what it reports to the host', () => {
  it('sends the index of the entry it was opened from', async () => {
    const entries = await renderPopupEntriesHtml(
      DISPLAY_TEMPLATES,
      [termEntry('食べる'), termEntry('読め')],
      DICTIONARIES,
    );
    const { window, document, sent } = openFrame(entries);

    click(window, menuButton(document, 1));
    const item = document.querySelector('.popup-menu-item');
    if (item === null) throw new Error('no menu item');
    click(window, item);

    expect(sent).toEqual([
      { type: 'log-debug-info', index: 1, channel: POPUP_FRAME_CHANNEL },
    ]);
    // Upstream closes the menu before it logs.
    expect(document.querySelector('.dictionary-entry-popup-menu')).toBeNull();
  });

  /* Upstream's `_logDictionaryEntryIndex` answers -1 for a button outside any
     numbered entry, and `_logDictionaryEntryData` returns early on it. */
  it('says nothing when the button belongs to no numbered entry', async () => {
    const { window, document, sent } = openFrame(
      '<div class="entry"><div class="entry-header"><button type="button" class="action-button" data-action="menu" data-menu-position="left below h-cover v-cover"></button></div></div>',
    );
    click(window, menuButton(document));
    const item = document.querySelector('.popup-menu-item');
    if (item === null) throw new Error('no menu item');
    click(window, item);

    expect(sent).toEqual([]);
  });
});