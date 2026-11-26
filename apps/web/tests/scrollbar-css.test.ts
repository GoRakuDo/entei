/**
 * Static contract test for the themed scrollbar.
 * ---------------------------------------------------------------------------
 * Approved reference: the button-coloured pill drawn ON TOP of the content
 * (true overlay scrollbar), over a transparent track, with NO layout gutter so
 * the gradient wallpaper reaches the physical window edge.
 *
 * Single source of truth — the standard pair on `:root`:
 *
 *   :root {
 *     scrollbar-width: thin;
 *     scrollbar-color: var(--entei-btn-color) transparent;
 *   }
 *
 * Tauri launches WebView2 with `--enable-features=OverlayScrollbar`
 * (src-tauri/tauri.conf.json → `additionalBrowserArgs`), so the standard pair
 * renders a zero-width overlay bar.
 *
 * `::-webkit-scrollbar` pseudo-elements are forbidden for anything that sizes
 * or paints a bar: styling them forces Chromium onto its classic (in-flow)
 * scrollbar implementation, which reserves a permanent 6px gutter and paints
 * an opaque track over the wallpaper — the black groove `4f15fe2` eliminated
 * and a later switch to pseudo-elements brought back.
 * `::-webkit-scrollbar { display: none }` stays allowed: it draws nothing and
 * reserves nothing, and it is the pre-121 belt for the intentionally hidden
 * strips (which also declare `scrollbar-width: none`).
 *
 * Pixel appearance itself is verified in the browser; this test only guards
 * the selector/declaration contract.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const stylesDir = resolve(process.cwd(), 'src/styles');
const read = (name: string) => readFileSync(resolve(stylesDir, name), 'utf8');

/** Every stylesheet under `src/styles`, so a new one cannot skip the contract. */
const cssFiles = readdirSync(stylesDir)
  .filter((name) => name.endsWith('.css'))
  .sort();

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const cssOf = (name: string) => stripComments(read(name));

/** `prop: value` pairs of a declaration block. */
function declarations(body: string): Array<[string, string]> {
  return body
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf(':');
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as [
        string,
        string,
      ];
    });
}

/** Every declaration block whose selector mentions `::-webkit-scrollbar`. */
function webkitScrollbarRules(
  css: string,
): Array<{ selector: string; body: string }> {
  const found: Array<{ selector: string; body: string }> = [];
  for (const match of css.matchAll(
    /(?:^|[},])\s*([^{}]*::-webkit-scrollbar[^{}]*)\{([^}]*)\}/gm,
  )) {
    found.push({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' });
  }
  return found;
}

/** All declaration blocks of one exact selector. */
function ruleBodies(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm');
  return [...css.matchAll(re)].map((match) => match[1] ?? '');
}

/** Thumb fill at rest: themed button color, transparent track. */
const SCROLLBAR_COLOR = 'var(--entei-btn-color) transparent';
/** Declarations that would size or paint a classic bar. */
const BAR_DECLARATIONS = new Set([
  'width',
  'height',
  'background',
  'background-color',
  'border-radius',
  'border',
  'box-shadow',
]);

describe('themed scrollbar (overlay pill, no gutter)', () => {
  it('styles/ ships at least the global and player stylesheets', () => {
    expect(cssFiles).toContain('global.css');
    expect(cssFiles).toContain('player.css');
  });

  it('global.css: :root owns the standard pair', () => {
    const blocks = ruleBodies(cssOf('global.css'), ':root');
    const pair = blocks.find((body) => body.includes('scrollbar-width'));
    expect(pair).toBeDefined();
    expect(declarations(pair!)).toEqual([
      ['scrollbar-width', 'thin'],
      ['scrollbar-color', SCROLLBAR_COLOR],
    ]);
  });

  it('global.css: no ::-webkit-scrollbar rule may exist at all', () => {
    expect(webkitScrollbarRules(cssOf('global.css'))).toEqual([]);
  });

  for (const file of cssFiles) {
    it(`${file}: ::-webkit-scrollbar only ever hides a bar`, () => {
      const offenders = webkitScrollbarRules(cssOf(file))
        .filter((rule) =>
          declarations(rule.body).some(([prop]) => BAR_DECLARATIONS.has(prop)),
        )
        .map((rule) => rule.selector);
      expect(offenders).toEqual([]);
    });

    it(`${file}: scrollbar-width is only ever \`thin\` or \`none\``, () => {
      const offenders: string[] = [];
      for (const match of cssOf(file).matchAll(/scrollbar-width\s*:\s*([^;]+);/g)) {
        const value = (match[1] ?? '').replace(/\s+/g, ' ').trim();
        // `none` is the intentional hide used by the settings tab strip and
        // the magnet breadcrumb; `thin` is the visible overlay pill.
        if (value === 'none' || value === 'thin') continue;
        offenders.push(value);
      }
      expect(offenders).toEqual([]);
    });

    it(`${file}: scrollbar-color is only the documented pair`, () => {
      const values = [
        ...cssOf(file).matchAll(/scrollbar-color\s*:\s*([^;]+);/g),
      ].map((match) => (match[1] ?? '').replace(/\s+/g, ' ').trim());
      expect(values.filter((value) => value !== SCROLLBAR_COLOR)).toEqual([]);
    });
  }

  it('player.css: the magnet list asks for the slim bar and inherits the colour', () => {
    const css = cssOf('player.css');
    const list = ruleBodies(css, '.entei-magnet-list');
    expect(list.length).toBeGreaterThan(0);
    expect(declarations(list[0]!)).toContainEqual(['scrollbar-width', 'thin']);
    expect(
      declarations(list[0]!).filter(([prop]) => prop === 'scrollbar-color'),
    ).toEqual([]);

    const scoped = webkitScrollbarRules(css).filter((rule) =>
      rule.selector.includes('.entei-magnet-list'),
    );
    expect(scoped).toEqual([]);
  });
});
