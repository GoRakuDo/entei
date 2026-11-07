/**
 * Static contract test for the themed scrollbar.
 * ---------------------------------------------------------------------------
 * Approved reference: a faint translucent pill at rest that turns into the
 * button colour while hovered/dragged, over a FULLY TRANSPARENT track so the
 * gradient wallpaper shows through.
 *
 *   ::-webkit-scrollbar        → 6px, transparent box
 *   ::-webkit-scrollbar-track  → transparent
 *   ::-webkit-scrollbar-corner → transparent
 *   ::-webkit-scrollbar-thumb  → oklch(100% 0 0deg / 0.18)
 *   :hover / :active           → var(--entei-btn-color)
 *
 * The standard `scrollbar-width`/`scrollbar-color` pair is deliberately NOT
 * declared for visible bars: on Chromium 121+ setting either one to a
 * non-initial value makes the engine ignore ::-webkit-scrollbar and paint its
 * own standard bar, whose track rendered as an opaque black gutter on top of
 * the wallpaper. `scrollbar-width: none` stays allowed for the intentionally
 * hidden strips.
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

/**
 * Returns the declaration block of one exact selector, or null when absent.
 * Anchored on a block boundary so `::-webkit-scrollbar` does not match
 * `::-webkit-scrollbar-track` (and `.foo::-webkit-scrollbar` stays separate).
 */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`,
    'm',
  ).exec(css);
  return match?.[1] ?? null;
}

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

/** Every declaration that would paint the scrollbar track. */
const backgroundDeclarations = (body: string) =>
  declarations(body).filter(
    ([prop]) => prop === 'background' || prop === 'background-color',
  );

/** Thumb fill at rest: faint translucent white, OKLCH only (rule #1621). */
const RESTING_THUMB = 'oklch(100% 0 0deg / 0.18)';
/** Thumb fill while hovered or dragged. */
const ACTIVE_THUMB = 'var(--entei-btn-color)';

describe('themed scrollbar (translucent pill, transparent track)', () => {
  it('styles/ ships at least the global and player stylesheets', () => {
    expect(cssFiles).toContain('global.css');
    expect(cssFiles).toContain('player.css');
  });

  for (const file of cssFiles) {
    it(`${file}: never declares scrollbar-color (it kills the webkit track)`, () => {
      const css = stripComments(read(file));
      const offenders = [...css.matchAll(/scrollbar-color\s*:\s*([^;]+);/g)].map(
        (m) => m[1]?.trim() ?? '',
      );
      expect(offenders).toEqual([]);
    });

    it(`${file}: scrollbar-width is only ever \`none\``, () => {
      const css = stripComments(read(file));
      const offenders: string[] = [];
      for (const match of css.matchAll(/scrollbar-width\s*:\s*([^;]+);/g)) {
        const value = (match[1] ?? '').replace(/\s+/g, ' ').trim();
        // `none` is the intentional hide used by the settings tab strip, the
        // magnet breadcrumb and the settings dialog body.
        if (value === 'none') continue;
        offenders.push(value);
      }
      expect(offenders).toEqual([]);
    });
  }

  it('global.css: the bar is a 6px transparent box', () => {
    const css = stripComments(read('global.css'));
    const body = ruleBody(css, '::-webkit-scrollbar');
    expect(body).not.toBeNull();
    const decls = declarations(body!);
    expect(decls).toContainEqual(['width', '6px']);
    expect(decls).toContainEqual(['height', '6px']);
    expect(decls).toContainEqual(['background', 'transparent']);
  });

  it('global.css: the resting thumb is the faint translucent white', () => {
    const css = stripComments(read('global.css'));
    const body = ruleBody(css, '::-webkit-scrollbar-thumb');
    expect(body).not.toBeNull();
    expect(backgroundDeclarations(body!)).toEqual([
      ['background-color', RESTING_THUMB],
    ]);
  });

  it('global.css: hover and drag swap the thumb to --entei-btn-color', () => {
    const css = stripComments(read('global.css'));
    const rule =
      /::-webkit-scrollbar-thumb:hover,\s*::-webkit-scrollbar-thumb:active\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(rule).not.toBeNull();
    expect(backgroundDeclarations(rule![1]!)).toEqual([
      ['background-color', ACTIVE_THUMB],
    ]);
    // No brightness/glow trickery: the state change is a plain fill swap.
    expect(rule![1]).not.toContain('filter');
    expect(rule![1]).not.toContain('box-shadow');
  });

  it('global.css: track and corner stay fully transparent, no black gutter', () => {
    const css = stripComments(read('global.css'));
    for (const selector of [
      '::-webkit-scrollbar-track',
      '::-webkit-scrollbar-corner',
    ]) {
      const body = ruleBody(css, selector);
      expect(body).not.toBeNull();
      expect(backgroundDeclarations(body!)).toEqual([
        ['background', 'transparent'],
      ]);
    }
  });

  it('player.css: the magnet list keeps its own 6px pill', () => {
    const css = stripComments(read('player.css'));
    const list = ruleBody(css, '.entei-magnet-list');
    expect(list).not.toBeNull();
    const decls = declarations(list!);
    expect(decls).not.toContainEqual(['scrollbar-width', 'thin']);

    const size = ruleBody(css, '.entei-magnet-list::-webkit-scrollbar');
    expect(size).not.toBeNull();
    expect(declarations(size!)).toContainEqual(['width', '6px']);
    expect(declarations(size!)).toContainEqual(['height', '6px']);
    expect(declarations(size!)).toContainEqual(['background', 'transparent']);

    const track = ruleBody(css, '.entei-magnet-list::-webkit-scrollbar-track');
    expect(track).not.toBeNull();
    expect(backgroundDeclarations(track!)).toEqual([
      ['background', 'transparent'],
    ]);

    const thumb = ruleBody(css, '.entei-magnet-list::-webkit-scrollbar-thumb');
    expect(thumb).not.toBeNull();
    expect(backgroundDeclarations(thumb!)).toEqual([
      ['background-color', RESTING_THUMB],
    ]);

    const hover =
      /\.entei-magnet-list::-webkit-scrollbar-thumb:hover,\s*\.entei-magnet-list::-webkit-scrollbar-thumb:active\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(hover).not.toBeNull();
    expect(backgroundDeclarations(hover![1]!)).toEqual([
      ['background-color', ACTIVE_THUMB],
    ]);
    expect(hover![1]).not.toContain('filter');
  });
});
