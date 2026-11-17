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
  extractPopupMenuTemplates,
  inlinePopupIconUrls,
  popupAppearanceKey,
  popupLookupKey,
  createPopupHistory,
  pushPopupHistory,
  renderPopupCard,
  renderPopupEntriesHtml,
  renderPopupKanjiHtml,
  resolvePopupAppearance,
  resolvePopupFontStyle,
  resolvePopupOuterTheme,
  resolvePopupThemeAttributes,
  resolvePreviewTerm,
  restoreTextGlosses,
  stepPopupHistory,
  toDataAttributes,
  toPopupDictionaryInfo,
  type PopupDictionaryInfo,
} from '@/modules/yomitan/popup-preview';
import { POPUP_FRAME_CHANNEL } from '@/modules/yomitan/popup-preview/popup-frame';
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

function withScanning(
  options: Options,
  scanning: Record<string, unknown>,
): Options {
  return {
    ...options,
    profiles: options.profiles.map((profile, index) =>
      index === options.profileCurrent
        ? {
            ...profile,
            options: {
              ...profile.options,
              scanning: { ...profile.options.scanning, ...scanning },
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

/** One KANJIDIC-shaped translator entry for 読. */
function kanjiEntry(): Record<string, unknown> {
  return {
    index: 0,
    type: 'kanji',
    character: '読',
    dictionary: 'KANJIDIC',
    dictionaryAlias: 'KANJIDIC',
    onyomi: ['ドク', 'トク', 'トウ'],
    kunyomi: ['よ.む'],
    definitions: ['read'],
    tags: [],
    frequencies: [],
    stats: { misc: [], class: [], code: [], index: [] },
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

  /* Position & Size is another SECTION of the same options tree: the numbers are
     edited there and the frame lives here, so they belong on this key — without
     them the card would keep the old box until some other setting moved. */
  it('redraws the frame when the popup size moves, without re-looking-up', () => {
    const base = createDefaultOptions();
    const resized = withGeneral(base, {
      popupWidth: 520,
      popupHeight: 180,
      popupScalingFactor: 1.5,
    });
    expect(popupAppearanceKey(resized)).not.toBe(popupAppearanceKey(base));
    expect(popupLookupKey(resized)).toBe(popupLookupKey(base));
  });
});

describe('yomitan popup preview — editable term', () => {
  it('looks the typed term up, trimmed', () => {
    expect(resolvePreviewTerm('食べる')).toBe('食べる');
    expect(resolvePreviewTerm('  猫  ')).toBe('猫');
  });

  /* A cleared field is a half-finished edit, not a request to search for
     nothing: it falls back to upstream's example word, which is also what
     the field shows as its placeholder. */
  it('falls back to the example word for an empty field', () => {
    expect(resolvePreviewTerm('')).toBe(POPUP_PREVIEW_TERM);
    expect(resolvePreviewTerm('   ')).toBe(POPUP_PREVIEW_TERM);
    expect(resolvePreviewTerm(undefined)).toBe(POPUP_PREVIEW_TERM);
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
    // In Entei's dark shell, "Site" (siteOverride=false with siteTheme='dark')
    // resolves to 'dark' regardless of OS prefers-color-scheme.
    expect(resolvePopupThemeAttributes('site', 'site')['theme']).toBe('dark');
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

  /* Upstream `Display._updateDocumentOptions` mirrors the display-mode knobs onto
     the popup's `<html>` as `data-*` attributes, and `display.css` keys its rules
     off them (compact glossaries, term/frequency display style, selection
     indicator, search tags, debug flag, the three pitch-accent flags). This is that
     mapping, verified field by field. */
  it('mirrors the display-mode options as dataset attributes', () => {
    const options = withScanning(
      withGeneral(createDefaultOptions(), {
        resultOutputMode: 'merge',
        glossaryLayoutMode: 'compact',
        compactTags: true,
        averageFrequency: true,
        debugInfo: true,
        termDisplayMode: 'term-and-reading',
        frequencyDisplayMode: 'list',
        popupCurrentIndicatorMode: 'bar-left',
        showPitchAccentDownstepNotation: false,
        showPitchAccentPositionNotation: false,
        showPitchAccentGraph: true,
      }),
      { enableSearchTags: true },
    );
    const attrs = resolvePopupAppearance(options).themeAttributes;
    expect(attrs['resultOutputMode']).toBe('merge');
    expect(attrs['glossaryLayoutMode']).toBe('compact');
    expect(attrs['compactTags']).toBe('true');
    expect(attrs['averageFrequency']).toBe('true');
    expect(attrs['enableSearchTags']).toBe('true');
    expect(attrs['debug']).toBe('true');
    expect(attrs['termDisplayMode']).toBe('term-and-reading');
    expect(attrs['frequencyDisplayMode']).toBe('list');
    expect(attrs['popupCurrentIndicatorMode']).toBe('bar-left');
    expect(attrs['showPronunciationText']).toBe('false');
    expect(attrs['showPronunciationDownstepPosition']).toBe('false');
    expect(attrs['showPronunciationGraph']).toBe('true');
    /* `parsing.readingMode` is a QueryParser setting, never a `data-*` attribute
       upstream — so it must NOT appear here. */
    expect(attrs['readingMode']).toBeUndefined();
  });

  it('carries upstream’s defaults when no display mode is set', () => {
    const attrs = resolvePopupAppearance(createDefaultOptions()).themeAttributes;
    /* `group` is upstream's own starting point (`createDefaultGeneralOptions`),
       not `split`: the default decides which of `display.css`'s
       `data-result-output-mode` rules apply. */
    expect(attrs['resultOutputMode']).toBe('group');
    expect(attrs['glossaryLayoutMode']).toBe('default');
    expect(attrs['compactTags']).toBe('false');
    expect(attrs['averageFrequency']).toBe('false');
    expect(attrs['termDisplayMode']).toBe('ruby');
    expect(attrs['frequencyDisplayMode']).toBe('split-tags-grouped');
    expect(attrs['popupCurrentIndicatorMode']).toBe('triangle');
    expect(attrs['showPronunciationText']).toBe('true');
    expect(attrs['showPronunciationDownstepPosition']).toBe('true');
    expect(attrs['showPronunciationGraph']).toBe('false');
  });

  /* A display-mode change redraws the frame but must NOT re-run the dictionary
     lookup — the same split the Position & Size numbers rely on. */
  it('redraws the frame when a display mode moves, without re-looking-up', () => {
    const base = createDefaultOptions();
    const restyled = withGeneral(base, { termDisplayMode: 'term-only' });
    expect(popupAppearanceKey(restyled)).not.toBe(popupAppearanceKey(base));
    expect(popupLookupKey(restyled)).toBe(popupLookupKey(base));
  });

  it('redraws the frame when the search-tag toggle moves, without re-looking-up', () => {
    const base = createDefaultOptions();
    const tagged = withScanning(base, { enableSearchTags: true });
    expect(popupAppearanceKey(tagged)).not.toBe(popupAppearanceKey(base));
    expect(popupLookupKey(tagged)).toBe(popupLookupKey(base));
  });

  /* The two knobs that were missing from the attributes: they belong on the
     APPEARANCE key, or the frame would keep the old `data-*` value until some other
     display mode happened to move. `resultOutputMode` is on the LOOKUP key too —
     `popupLookupKey` already lists it, because group / merge / split change the shape
     of the entries the translator returns, not just how they are styled. */
  it('redraws the frame when the result output mode or the frequency average moves', () => {
    const base = createDefaultOptions();
    const merged = withGeneral(base, { resultOutputMode: 'merge' });
    const averaged = withGeneral(base, { averageFrequency: true });
    expect(popupAppearanceKey(merged)).not.toBe(popupAppearanceKey(base));
    expect(popupLookupKey(merged)).not.toBe(popupLookupKey(base));
    // A frequency-display choice is styling only: the entries are the same.
    expect(popupAppearanceKey(averaged)).not.toBe(popupAppearanceKey(base));
    expect(popupLookupKey(averaged)).toBe(popupLookupKey(base));
  });

  /* The SHADOW setting is the FRAME's, not the document's: upstream styles
     `iframe.yomitan-popup[data-outer-theme=…]`, and the appearance resolution is
     what turns the setting into that attribute (rule: one resolution, both
     popups). `site` / `browser` must arrive resolved — the test preload pins the
     browser to light. */
  it('resolves the outer theme the frame’s shadow is keyed off', () => {
    const outer = (popupOuterTheme: string) =>
      resolvePopupAppearance(
        withGeneral(createDefaultOptions(), { popupOuterTheme }),
      ).resolvedOuterTheme;

    expect(outer('light')).toBe('light');
    expect(outer('dark')).toBe('dark');
    expect(outer('none')).toBe('none');
    expect(outer('site')).toBe('dark');
    expect(outer('browser')).toBe('light');
    /* Nothing usable in the field: upstream paints the light halo on the frame
       itself and only overrides it for dark / none, so light IS the fallback. */
    expect(resolvePopupOuterTheme(undefined)).toBe('light');
    expect(resolvePopupOuterTheme('nonsense')).toBe('light');
  });

  it('draws the frame at the popup’s own width and height', () => {
    const defaults = resolvePopupAppearance(createDefaultOptions());
    // Upstream's defaults: a 400×250 popup at scale 1.
    expect(defaults.size).toEqual({ width: 400, height: 250 });

    const resized = resolvePopupAppearance(
      withGeneral(createDefaultOptions(), {
        popupWidth: 520,
        popupHeight: 180,
      }),
    );
    expect(resized.size).toEqual({ width: 520, height: 180 });
  });

  it('scales the frame and the type by the scaling factor', () => {
    const scaled = resolvePopupAppearance(
      withGeneral(createDefaultOptions(), { popupScalingFactor: 1.5, fontSize: 20 }),
    );
    expect(scaled.size).toEqual({ width: 600, height: 375 });
    // The factor is applied where upstream applies it: to the type, which is what
    // the popup's `em`-based rules are relative to.
    expect(scaled.fontStyle).toContain('font-size:30px');
  });

  /* The number fields accept 0, and a cleared field parses as 0: the card must
     fall back to upstream's size rather than to a 0×0 box. */
  it('falls back to the default size for an unusable field', () => {
    const cleared = resolvePopupAppearance(
      withGeneral(createDefaultOptions(), {
        popupWidth: 0,
        popupHeight: Number.NaN,
        popupScalingFactor: 0,
      }),
    );
    expect(cleared.size).toEqual({ width: 400, height: 250 });
    expect(resolvePopupFontStyle('', 20, '')).toBe('font-size:20px');
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

  it('draws the active sidebar action bar and active indicator by default', () => {
    const html = buildPopupDocument({
      css: EMPTY_CSS,
      themeAttributes: theme,
      fontStyle: '',
      customCss: '',
      entriesHtml: '',
    });
    expect(html).toContain('data-popup-action-bar-location="top"');
    expect(html).toContain('data-popup-action-bar-visibility="always"');
    expect(html).toContain('id="content-sidebar"');
    expect(html).toContain('data-action="close"');
    expect(html).toContain('data-action="navigate-previous"');
    expect(html).toContain('data-action="navigate-next"');
    expect(html).toContain('class="entry entry-current"');
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

  /* The dataset properties resolvePopupAppearance hands over are kebab-cased on
     the way into the document (`dataset.glossaryLayoutMode` → `data-glossary-
     layout-mode`), exactly as a real `element.dataset.x = …` serialises. */
  it('writes the display-mode attributes kebab-cased onto the document element', () => {
    const html = buildPopupDocument({
      css: EMPTY_CSS,
      themeAttributes: {
        theme: 'dark',
        outerTheme: 'none',
        glossaryLayoutMode: 'compact',
        termDisplayMode: 'term-and-reading',
        showPronunciationGraph: 'true',
      },
      fontStyle: '',
      customCss: '',
      entriesHtml: '',
    });
    expect(html).toContain('data-glossary-layout-mode="compact"');
    expect(html).toContain('data-term-display-mode="term-and-reading"');
    expect(html).toContain('data-show-pronunciation-graph="true"');
    // The dataset name never leaks as a lowercased mash (no camelCase attribute).
    expect(html).not.toContain('glossaryLayoutMode=');
  });

  /* The same two conversions the document performs, as an attribute MAP: the host
     that draws these cards on a real element (`/search/`) hands them to React, which
     would lowercase an unknown prop into `themeglossary…`-style noise instead. */
  it('converts dataset names to kebab-cased data attributes', () => {
    expect(
      toDataAttributes({
        theme: 'dark',
        outerTheme: 'none',
        glossaryLayoutMode: 'compact',
      }),
    ).toEqual({
      'data-theme': 'dark',
      'data-outer-theme': 'none',
      'data-glossary-layout-mode': 'compact',
    });
    // Order follows insertion order, so the serialized document is unchanged.
    expect(Object.keys(toDataAttributes({ theme: 'dark', outerTheme: 'none' }))).toEqual([
      'data-theme',
      'data-outer-theme',
    ]);
    expect(toDataAttributes({})).toEqual({});
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

  /* Upstream numbers every entry it appends (`entry.dataset.index = i`), and the
     frame's `⋮` menu reports the entry it was opened from by that number — so the
     markup has to carry it, or the host has nothing to resolve. */
  it('numbers the entries the ⋮ menu reports', async () => {
    const doc = document.createElement('div');
    doc.innerHTML = await renderPopupEntriesHtml(
      DISPLAY_TEMPLATES,
      [termEntry(), termEntry()],
      dictionaries,
    );
    const entries = [...doc.querySelectorAll('.entry')];
    expect(entries.map((node) => node.getAttribute('data-index'))).toEqual(['0', '1']);
    // Only the first entry of the card is the current one.
    expect(entries[0]?.className).toContain('entry-current');
    expect(entries[1]?.className).not.toContain('entry-current');

    // A kanji list drawn UNDER a term list continues the same sequence.
    const kanji = await renderPopupKanjiHtml(
      DISPLAY_TEMPLATES,
      [kanjiEntry()],
      dictionaries,
      1,
    );
    const kanjiDoc = document.createElement('div');
    kanjiDoc.innerHTML = kanji;
    expect(
      [...kanjiDoc.querySelectorAll('.entry')].map((node) => node.getAttribute('data-index')),
    ).toEqual(['1']);
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

describe('yomitan popup preview — action bar and history', () => {
  const theme = { theme: 'dark', outerTheme: 'none' } as const;

  function document_(
    overrides: Partial<Parameters<typeof buildPopupDocument>[0]> = {},
  ): string {
    return buildPopupDocument({
      css: EMPTY_CSS,
      themeAttributes: theme,
      fontStyle: '',
      customCss: '',
      entriesHtml: '<div class="entry entry-current"></div>',
      ...overrides,
    });
  }

  it('starts with both history buttons disabled and the bar hidden', () => {
    const html = document_();
    // Upstream keys the sidebar's visibility off these two attributes, and greys
    // each glyph out with `disabled` on its button.
    expect(html).toContain('data-has-navigation-previous="false"');
    expect(html).toContain('data-has-navigation-next="false"');
    expect(html).toContain('data-action="navigate-previous" disabled');
    expect(html).toContain('data-action="navigate-next" disabled');
    // The close button is never disabled: there is always something to close.
    expect(html).toContain('data-action="close" id="close-button"');
  });

  it('enables only the end of the stack that has somewhere to go', () => {
    const back = document_({ hasNavigationPrevious: true });
    expect(back).toContain('data-has-navigation-previous="true"');
    expect(back).toContain('data-has-navigation-next="false"');
    expect(back).toContain('data-action="navigate-previous" id=');
    expect(back).toContain('data-action="navigate-next" disabled');

    const both = document_({ hasNavigationPrevious: true, hasNavigationNext: true });
    expect(both).toContain('data-has-navigation-next="true"');
    expect(both).not.toContain('data-action="navigate-next" disabled');
  });

  it('draws No results found. for a lookup that answered nothing', () => {
    const html = document_({ entriesHtml: '', emptyState: 'no-results' });
    // A kanji lookup outside KANJIDIC is an ANSWER, so the "install a dictionary"
    // placeholder would be the wrong message.
    expect(html).not.toContain(POPUP_PREVIEW_PLACEHOLDER);
    expect(html).toContain('id="no-results"><div class="entry"><p>No results found.</p>');
    expect(html).not.toContain('id="no-results" hidden');
  });

  it('hides No results found. whenever there is a card to draw', () => {
    expect(document_()).toContain('id="no-results" hidden');
  });

  it('bridges the frame’s clicks to its host', () => {
    const html = document_();
    // The host cannot read a sandboxed document, so the document announces itself.
    expect(html).toContain(`var CHANNEL = ${JSON.stringify(POPUP_FRAME_CHANNEL)}`);
    expect(html).toContain("window.parent.postMessage(message, '*')");
    expect(html).toContain(".headword-kanji-link");
    expect(html).toContain("case 'navigate-previous'");
    expect(html).toContain("case 'navigate-next'");
    expect(html).toContain("case 'close'");
    // A disabled button is not a request.
    expect(html).toContain('button.disabled');
  });

  /* Upstream's `⋮` menu (`Display._onMenuButtonClick` + `dom/popup-menu.js`) is
     drawn INSIDE the document: its markup is the extension's own template, its
     styles are the extension's own `material.css` already loaded in the frame,
     and it is positioned against the button that opened it. Only the finished
     action — print this entry's data — crosses to the host. */
  it('carries upstream’s own ⋮ menu templates, and draws the menu in the frame', () => {
    const templates = extractPopupMenuTemplates(DISPLAY_TEMPLATES);
    expect(templates).toContain('id="dictionary-entry-popup-menu-template"');
    expect(templates).toContain('id="dictionary-entry-popup-menu-item-template"');

    const html = document_({ menuTemplates: templates });
    // Upstream's own host node for open menus (`ext/popup.html`).
    expect(html).toContain('<div id="popup-menus"></div>');
    expect(html).toContain("var MENU_ITEM_ACTION = 'log-debug-info';");
    expect(html).toContain("send({ type: 'log-debug-info', index: index })");
    // The button it opens from, and the four ways it closes.
    expect(html).toContain("'.action-button[data-action=menu]'");
    expect(html).toContain('onMenuContainerClick');
    expect(html).toContain("event.key === 'Escape'");
    expect(html).toContain("window.addEventListener('resize', onWindowResize, false)");
  });

  /* A template set without them (an older vendored file) must leave the button
     inert rather than open an empty box. */
  it('extracts nothing from a template set that has no menu', () => {
    expect(extractPopupMenuTemplates('<template id="term-entry-template"></template>')).toBe('');
    expect(extractPopupMenuTemplates('')).toBe('');
    expect(document_()).toContain('<div id="popup-menus"></div>');
  });
});

describe('yomitan popup preview — inlined icons', () => {
  /**
   * The document is drawn in a SANDBOXED iframe, so Chrome refuses to load the
   * stylesheets' `url('/yomitan/images/…')` subresources and every `.icon` span
   * paints its whole box instead of a glyph — a solid block where the action
   * bar's `<` `>` `×` should be. Inlining the SVGs is what fixes that without
   * widening the sandbox.
   */
  const sheets = [
    'material.css',
    'display.css',
    'display-pronunciation.css',
    'structured-content.css',
  ].map((name) =>
    readFileSync(resolve(process.cwd(), 'public/yomitan/css', name), 'utf8'),
  );
  const allCss = sheets.join('\n');

  it('rewrites every icon url() into a data: URI', () => {
    const seen: string[] = [];
    const out = inlinePopupIconUrls(allCss, (name) => {
      seen.push(name);
      return new TextEncoder().encode('<svg/>');
    });
    expect(out).not.toContain("url('/yomitan/images/");
    // Every icon the sheets reference is resolved; the resolver is called once per
    // OCCURRENCE, so a repeated icon is read more than once (cheap — the loader
    // looks them up in a map).
    expect(new Set(seen).size).toBeGreaterThan(60);
    expect(seen).toContain('cross.svg');
    expect(seen).toContain('left-chevron.svg');
    expect(seen).toContain('right-chevron.svg');
    expect(out).toContain('url("data:image/svg+xml;base64,');
  });

  it('leaves an icon it could not read alone rather than dropping the sheet', () => {
    const out = inlinePopupIconUrls(
      ".a{--icon-image:url('/yomitan/images/cross.svg')}.b{--icon-image:url('/yomitan/images/missing.svg')}",
      (name) => (name === 'cross.svg' ? new TextEncoder().encode('<svg/>') : null),
    );
    expect(out).toContain('data:image/svg+xml;base64,');
    expect(out).toContain("url('/yomitan/images/missing.svg')");
  });

  it('does not touch a gradient, a relative url() or anything else', () => {
    const css = [
      '.g{background-image:linear-gradient(red,blue)}',
      ".h{background-image:url('data:image/png;base64,AAAA')}",
      ".i{background-image:url(../images/x.png)}",
    ].join('\n');
    expect(inlinePopupIconUrls(css, () => new TextEncoder().encode('<svg/>'))).toBe(css);
  });
});

describe('yomitan popup card — one history entry, drawn', () => {
  const options = createDefaultOptions();
  const dictionaries: PopupDictionaryInfo[] = [{ title: 'JMdict', revision: '1.0' }];

  function card(
    history: ReturnType<typeof createPopupHistory>,
    entries: readonly unknown[],
    kanjiEntries: readonly unknown[] = [],
  ) {
    return renderPopupCard({
      history,
      entries,
      kanjiEntries,
      css: EMPTY_CSS,
      templates: DISPLAY_TEMPLATES,
      dictionaries,
      options,
    });
  }

  it('draws the entry the cursor points at, with the ends of the stack disabled', async () => {
    const first = createPopupHistory({ mode: 'term', query: POPUP_PREVIEW_TERM });
    const two = pushPopupHistory(first, { mode: 'kanji', query: '読' });

    const kanjiCard = await card(two, [], [kanjiEntry()]);
    // The clicked character's own card, with `<` available and `>` not.
    expect(kanjiCard.srcDoc).toContain('kanji-entry');
    expect(kanjiCard.srcDoc).toContain('data-has-navigation-previous="true"');
    expect(kanjiCard.srcDoc).toContain('data-has-navigation-next="false"');
    expect(kanjiCard.mode).toBe('kanji');
    expect(kanjiCard.query).toBe('読');

    const backCard = await card(stepPopupHistory(two, -1), [termEntry()]);
    expect(backCard.srcDoc).toContain('headword-term');
    expect(backCard.srcDoc).toContain('data-has-navigation-previous="false"');
    expect(backCard.srcDoc).toContain('data-has-navigation-next="true"');
  });

  it('draws No results found. for a kanji no dictionary has', async () => {
    const empty = createPopupHistory({ mode: 'kanji', query: '鬱' });
    const drawn = await card(empty, [], []);
    // An ANSWER from the dictionaries, not a missing dictionary.
    expect(drawn.srcDoc).not.toContain(POPUP_PREVIEW_PLACEHOLDER);
    expect(drawn.srcDoc).toContain('id="no-results"><div class="entry"><p>No results found.</p>');
  });

  it('keeps a scan’s term card and its kanji cards on one card', async () => {
    const scan = createPopupHistory({ mode: 'scan', query: POPUP_PREVIEW_TERM });
    const drawn = await card(scan, [termEntry()], [kanjiEntry()]);
    // The scanner runs both lookups on one window of text; its first card is the
    // word with the kanji under it, exactly as the popup drew it before the
    // action bar existed.
    expect(drawn.srcDoc).toContain('data-type="term"');
    expect(drawn.srcDoc).toContain('kanji-entry');
  });

  /* One card, one sequence: the `⋮` menu on the kanji entry under a term must
     report the index that kanji actually has on this card, not its own 0. */
  it('numbers a scan card’s term entry and its kanji entries in one sequence', async () => {
    const scan = createPopupHistory({ mode: 'scan', query: POPUP_PREVIEW_TERM });
    const drawn = await card(scan, [termEntry()], [kanjiEntry()]);
    const parsed = new DOMParser().parseFromString(drawn.srcDoc, 'text/html');
    const entries = [...parsed.querySelectorAll('#dictionary-entries > .entry')];
    expect(entries.map((node) => node.getAttribute('data-index'))).toEqual(['0', '1']);
    expect(entries.map((node) => node.getAttribute('data-type'))).toEqual([
      'term',
      'kanji',
    ]);
  });
});
