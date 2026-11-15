/**
 * Yomitan popup preview unit tests.
 *
 * Covers the two halves that can be checked without a browser:
 *
 * - the PURE half: change keys, the font/theme resolution the extension performs
 *   at runtime, and the assembled iframe document (placeholder, escaping, cascade
 *   order);
 * - the GENERATOR half: Yomitan's own `DisplayGenerator`, driven against a
 *   JMdict-shaped entry, producing the popup's real DOM. This is the assertion
 *   that the preview is the extension's card and not a lookalike — the classes,
 *   the furigana ruby, the inflection chain, the dictionary tag and the glossary
 *   all come from `ext/templates-display.html`.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  POPUP_PREVIEW_PLACEHOLDER,
  POPUP_PREVIEW_TERM,
  buildPopupDocument,
  popupAppearanceKey,
  popupLookupKey,
  renderPopupEntriesHtml,
  resolvePopupAppearance,
  resolvePopupFontStyle,
  resolvePopupThemeAttributes,
  restoreTextGlosses,
  toPopupDictionaryInfo,
  type PopupDictionaryInfo,
} from '@/modules/yomitan/popup-preview';
import { createDefaultOptions, type Options } from '@gorakudo/yomitan-headless/settings';
import type { InstalledDictionary } from '@/modules/yomitan/dictionary-store';

/** The vendored template set, straight from `public/` (what the app serves). */
const DISPLAY_TEMPLATES = readFileSync(
  resolve(process.cwd(), 'public/yomitan/templates-display.html'),
  'utf8',
);

const EMPTY_CSS = '/* vendored upstream css */';

function withGeneral(options: Options, general: Record<string, unknown>): Options {
  return {
    ...options,
    profiles: options.profiles.map((profile, index) =>
      index === options.profileCurrent
        ? {
            ...profile,
            options: {
              ...profile.options,
              general: { ...profile.options.general, ...general },
            },
          }
        : profile,
    ),
  } as Options;
}

function withDictionaries(options: Options, names: string[]): Options {
  return {
    ...options,
    profiles: options.profiles.map((profile, index) =>
      index === options.profileCurrent
        ? {
            ...profile,
            options: {
              ...profile.options,
              dictionaries: names.map((name) => ({
                name,
                alias: name,
                enabled: true,
                allowSecondarySearches: false,
                definitionsCollapsible: 'not-collapsible',
                partsOfSpeechFilter: true,
                useDeinflections: true,
              })),
            },
          }
        : profile,
    ),
  } as Options;
}

/** One JMdict-shaped translator entry for 読め (imperative/potential of 読む). */
function termEntry(): Record<string, unknown> {
  return {
    index: 0,
    type: 'term',
    isPrimary: true,
    textProcessorRuleChainCandidates: [],
    inflectionRuleChainCandidates: [
      {
        source: 'algorithm',
        inflectionRules: [{ name: 'imperative', description: 'Imperative form' }],
      },
    ],
    score: 100,
    frequency: 'normal',
    headwords: [
      {
        index: 0,
        term: '読め',
        reading: 'よめ',
        sources: [{ originalText: '読め', matchType: 'exact', matchSource: 'term', isPrimary: true }],
        tags: [],
        wordClasses: ['v1'],
      },
    ],
    definitions: [
      {
        dictionary: 'JMdict',
        dictionaryAlias: 'JMdict',
        tags: [],
        headwordIndices: [0],
        entries: [{ type: 'text', text: 'to read' }],
        isPrimary: true,
        score: 100,
      },
    ],
    frequencies: [],
    pronunciations: [],
  };
}

describe('yomitan popup preview — change keys', () => {
  it('refetches the card when the dictionary list moves', () => {
    const base = createDefaultOptions();
    const installed = withDictionaries(base, ['JMdict']);
    expect(popupLookupKey(installed)).not.toBe(popupLookupKey(base));
  });

  it('leaves the lookup alone while only the appearance moves', () => {
    const base = createDefaultOptions();
    const themed = withGeneral(base, { popupTheme: 'dark', fontSize: 22 });
    expect(popupAppearanceKey(themed)).not.toBe(popupAppearanceKey(base));
    expect(popupLookupKey(themed)).toBe(popupLookupKey(base));
  });
});

describe('yomitan popup preview — appearance', () => {
  it('writes the font options as inline document-element styles', () => {
    // Upstream `Display.setFontOptions`: an empty family is not written at all.
    expect(resolvePopupFontStyle('', 14, '1.5')).toBe('font-size:14px;line-height:1.5');
    expect(resolvePopupFontStyle('Noto Sans JP', 20, '1.5')).toBe(
      'font-family:Noto Sans JP;font-size:20px;line-height:1.5',
    );
  });

  it('resolves a concrete theme the way ThemeController does', () => {
    expect(resolvePopupThemeAttributes('light', 'none')['theme']).toBe('light');
    expect(resolvePopupThemeAttributes('dark', 'dark')['theme']).toBe('dark');
    expect(resolvePopupThemeAttributes('dark', 'none')['outerTheme']).toBe('none');
    // `siteOverride` is on for a preview, so "Site" follows the BROWSER theme,
    // which the test preload pins to light (prefers-color-scheme: dark = false).
    expect(resolvePopupThemeAttributes('site', 'site')['theme']).toBe('light');
  });

  it('reads the whole appearance off the options tree', () => {
    const options = withGeneral(createDefaultOptions(), {
      popupTheme: 'dark',
      fontFamily: 'Noto Serif JP',
      fontSize: 18,
      lineHeight: '1.7',
      customPopupCss: '.entry { outline: none; }',
    });
    const appearance = resolvePopupAppearance(options);
    expect(appearance.themeAttributes['theme']).toBe('dark');
    expect(appearance.fontStyle).toBe(
      'font-family:Noto Serif JP;font-size:18px;line-height:1.7',
    );
    expect(appearance.customCss).toBe('.entry { outline: none; }');
  });
});

describe('yomitan popup preview — document', () => {
  const theme = { 'theme': 'dark', 'outerTheme': 'none' } as const;

  it('draws Yomitan’s own placeholder when nothing was found', () => {
    const html = buildPopupDocument({
      css: EMPTY_CSS,
      themeAttributes: theme,
      fontStyle: 'font-size:14px',
      customCss: '',
      entriesHtml: '',
    });
    expect(html).toContain(POPUP_PREVIEW_PLACEHOLDER);
    expect(html).toContain('id="no-dictionaries"');
    expect(html).toContain('data-theme="dark"');
    // `dataset.outerTheme` is `data-outer-theme`, not a lowercased mash of the two.
    expect(html).toContain('data-outer-theme="none"');
    expect(html).not.toContain('outerTheme=');
    expect(html).toContain('style="font-size:14px"');
    expect(html).toContain('data-page-type="popup"');
    // No custom-CSS sheet when there is no custom CSS.
    expect(html.match(/<style>/g)?.length).toBe(2);
  });

  it('carries the generated card, the custom CSS and the frame reset', () => {
    const html = buildPopupDocument({
      css: EMPTY_CSS,
      themeAttributes: theme,
      fontStyle: '',
      customCss: '.entry{color:red}',
      entriesHtml: '<div class="entry"></div>',
    });
    expect(html).toContain('<div id="dictionary-entries"><div class="entry"></div></div>');
    expect(html).toContain('.entry{color:red}');
    expect(html).not.toContain(POPUP_PREVIEW_PLACEHOLDER);
    // Upstream's frame colours and page reset, restated for a single document.
    expect(html).toContain('background-color: #1e1e1e');
    expect(html).toContain('overflow: hidden;');
  });

  it('cannot be broken out of its stylesheet by pasted CSS', () => {
    const html = buildPopupDocument({
      css: EMPTY_CSS,
      themeAttributes: theme,
      fontStyle: '',
      customCss: 'body{display:none}</style><script>alert(1)</script>',
      entriesHtml: '',
    });
    expect(html).not.toContain('</style><script>');
    expect(html).toContain('<\\/style><script>');
  });

  it('escapes a hostile theme value instead of injecting an attribute', () => {
    const html = buildPopupDocument({
      css: EMPTY_CSS,
      themeAttributes: { theme: 'light" onload="alert(1)' },
      fontStyle: '',
      customCss: '',
      entriesHtml: '',
    });
    expect(html).toContain('data-theme="light&quot; onload=&quot;alert(1)"');
    expect(html).not.toContain('onload="alert(1)" ');
  });
});

describe('yomitan popup preview — generator output', () => {
  const dictionaries: PopupDictionaryInfo[] = [{ title: 'JMdict', revision: '1.0' }];

  it('renders nothing to draw when the lookup came back empty', async () => {
    expect(await renderPopupEntriesHtml(DISPLAY_TEMPLATES, [], dictionaries)).toBe('');
  });

  it('produces Yomitan’s own term-entry DOM for the active dictionary', async () => {
    const html = await renderPopupEntriesHtml(
      DISPLAY_TEMPLATES,
      [termEntry()],
      dictionaries,
    );
    const doc = document.createElement('div');
    doc.innerHTML = html;

    const entry = doc.querySelector('.entry');
    expect(entry?.getAttribute('data-type')).toBe('term');
    expect(entry?.getAttribute('data-format')).toBe('term');
    expect(entry?.getAttribute('data-headword-count')).toBe('1');
    expect(entry?.getAttribute('data-definition-count')).toBe('1');

    // Furigana comes from the upstream template + `distributeFurigana`.
    const ruby = doc.querySelector('.headword-term ruby');
    expect(ruby?.textContent).toBe('読よ');
    expect(ruby?.querySelector('rt')?.textContent).toBe('よ');
    expect(doc.querySelector('.headword-reading')?.textContent).toBe('よめ');
    expect(
      doc.querySelector('.headword')?.getAttribute('data-reading-is-same'),
    ).toBe('false');

    // The deinflection chain the preview is there to show.
    const inflection = doc.querySelector('.inflection-rule-chain .inflection');
    expect(inflection?.getAttribute('data-reason')).toBe('imperative');
    expect(
      doc.querySelector('.inflection-source-icon')?.getAttribute('data-inflection-source'),
    ).toBe('algorithm');

    // Glossary and the dictionary tag the entry was merged from.
    expect(doc.querySelector('.gloss-content')?.textContent).toBe('to read');
    const dictionaryTag = doc.querySelector('.definition-item .tag[data-category=dictionary]');
    expect(dictionaryTag?.querySelector('.tag-label-content')?.textContent).toBe('JMdict');

    // The queried term is also a search tag, as upstream adds it.
    const searchTags = [
      ...doc.querySelectorAll('.headword-list-tag-list .tag[data-category=search]'),
    ].map((node) => node.querySelector('.tag-label-content')?.textContent);
    expect(searchTags).toContain(POPUP_PREVIEW_TERM);
  });
});

describe('yomitan popup preview — glossary normalization', () => {
  it('gives the generator back the bare string the engine rewrote', () => {
    // `yomitan-engine` stores `{type: 'text'}`; upstream renders a bare string.
    const entry = termEntry();
    expect(
      restoreTextGlosses(entry),
    ).toEqual({
      ...termEntry(),
      definitions: [
        {
          ...(termEntry() as { definitions: Record<string, unknown>[] }).definitions[0],
          entries: ['to read'],
        },
      ],
    });
  });

  it('leaves an entry with nothing to rewrite untouched', () => {
    const plain = { ...termEntry(), definitions: [] };
    expect(restoreTextGlosses(plain)).toBe(plain);
    const structured = {
      ...termEntry(),
      definitions: [
        {
          dictionary: 'JMdict',
          dictionaryAlias: 'JMdict',
          tags: [],
          headwordIndices: [0],
          entries: [{ type: 'structured-content', data: { tag: 'div', content: [] } }],
        },
      ],
    };
    expect(restoreTextGlosses(structured)).toBe(structured);
  });
});

describe('yomitan popup preview — dictionary info', () => {
  function installed(
    overrides: Partial<InstalledDictionary>,
  ): InstalledDictionary {
    return {
      id: 'jmdict',
      name: 'JMdict',
      version: '3.6.1',
      enabled: true,
      importedAt: '2026-01-01T00:00:00.000Z',
      hasFrequencyData: false,
      ...overrides,
    };
  }

  it('maps only what the card prints, and omits an empty author', () => {
    expect(toPopupDictionaryInfo([installed({ author: '' })])).toEqual([
      { title: 'JMdict', revision: '3.6.1' },
    ]);
    expect(toPopupDictionaryInfo([installed({ author: 'Electronic Dictionary Project' })])).toEqual([
      { title: 'JMdict', revision: '3.6.1', author: 'Electronic Dictionary Project' },
    ]);
  });
});
describe('yomitan popup preview — vendored assets', () => {
  /**
   * The card is only as good as the files it is served: a mistyped or missing SVG
   * is a silent 404 and an invisible icon, which no amount of DOM testing would
   * catch. These two assertions are what stand in for looking at it.
   */
  const PUBLIC_DIR = resolve(process.cwd(), 'public/yomitan');
  const STYLESHEETS = [
    'material.css',
    'display.css',
    'display-pronunciation.css',
    'structured-content.css',
  ];

  it('points every stylesheet url() at a file that exists', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const name of STYLESHEETS) {
      const css = readFileSync(resolve(PUBLIC_DIR, 'css', name), 'utf8');
      for (const [, url] of css.matchAll(/url\(\s*'?([^'")]+)'?\s*\)/g)) {
        if (url === undefined || !url.startsWith('/yomitan/')) continue;
        checked += 1;
        const file = resolve(PUBLIC_DIR, url.slice('/yomitan/'.length));
        if (!existsSync(file)) missing.push(`${name} → ${url}`);
      }
    }
    // Guards the guard: a rename that matched nothing would pass vacuously.
    expect(checked).toBeGreaterThan(60);
    expect(missing).toEqual([]);
  });

  it('ships every template the term-entry path instantiates', () => {
    const parsed = new DOMParser().parseFromString(DISPLAY_TEMPLATES, 'text/html');
    const ids = new Set(
      [...parsed.querySelectorAll('template')].map((node) => node.id),
    );
    const required = [
      'term-entry-template',
      'headword-template',
      'definition-item-template',
      'definition-disambiguation-template',
      'gloss-item-template',
      'gloss-item-image-description-template',
      'inflection-rule-chain-template',
      'inflection-template',
      'frequency-group-item-template',
      'term-frequency-item-template',
      'pronunciation-group-template',
      'pronunciation-template',
      'pronunciation-disambiguation-template',
      'tag-template',
    ];
    expect(required.filter((id) => !ids.has(id))).toEqual([]);
  });
});
