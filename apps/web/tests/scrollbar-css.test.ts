/**
 * Static contract test for the themed scrollbar.
 * ---------------------------------------------------------------------------
 * Approved reference (Tailwind Play): the thumb is the vivid accent at rest,
 * the track is fully transparent, the bar is `thin`/6px.
 *
 *   scrollbar-width: thin;
 *   scrollbar-color: var(--entei-accent-hover) transparent;
 *
 * Both the standard properties (Chromium 121+, WebView2, Firefox) and the
 * ::-webkit-scrollbar pseudo-elements carry the same colours, so every engine
 * lands on the same thin accent pill. The standard properties are therefore
 * expected in the plain cascade now — the old contract that banned them
 * outside a Firefox `@supports` gate is gone on purpose.
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
  const match = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(
    css,
  );
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
      return [
        part.slice(0, at).trim(),
        part.slice(at + 1).trim(),
      ] as [string, string];
    });
}

/** Every declaration that would paint the scrollbar track. */
const backgroundDeclarations = (body: string) =>
  declarations(body).filter(
    ([prop]) => prop === 'background' || prop === 'background-color',
  );

const ACCENT_THUMB = 'var(--entei-accent-hover)';
const TRACK = 'transparent';

describe('themed scrollbar (thin accent pill, transparent track)', () => {
  it('styles/ ships at least the global and player stylesheets', () => {
    expect(cssFiles).toContain('global.css');
    expect(cssFiles).toContain('player.css');
  });

  for (const file of cssFiles) {
    it(`${file}: every standard scrollbar declaration is the approved pair`, () => {
      const css = stripComments(read(file));
      const offenders: string[] = [];
      for (const match of css.matchAll(
        /(scrollbar-width|scrollbar-color)\s*:\s*([^;]+);/g,
      )) {
        const prop = match[1] ?? '';
        const value = (match[2] ?? '').replace(/\s+/g, ' ').trim();
        // `scrollbar-width: none` is the intentional hide used by the settings
        // tab strip, the magnet breadcrumb and the settings dialog body.
        if (prop === 'scrollbar-width' && value === 'none') continue;
        if (prop === 'scrollbar-width' && value === 'thin') continue;
        if (prop === 'scrollbar-color' && value === `${ACCENT_THUMB} ${TRACK}`)
          continue;
        offenders.push(`${prop}: ${value}`);
      }
      expect(offenders).toEqual([]);
    });
  }

  it('global.css: html and * carry the thin accent standard scrollbar', () => {
    const css = stripComments(read('global.css'));
    const body = ruleBody(css, 'html,\n*') ?? ruleBody(css, 'html, *');
    expect(body).not.toBeNull();
    const decls = declarations(body!);
    expect(decls).toContainEqual(['scrollbar-width', 'thin']);
    expect(decls).toContainEqual([
      'scrollbar-color',
      `${ACCENT_THUMB} ${TRACK}`,
    ]);
  });

  it('global.css: the bar itself is a 6px pill', () => {
    const css = stripComments(read('global.css'));
    const body = ruleBody(css, '::-webkit-scrollbar');
    expect(body).not.toBeNull();
    const decls = declarations(body!);
    expect(decls).toContainEqual(['width', '6px']);
    expect(decls).toContainEqual(['height', '6px']);
  });

  it('global.css: the resting thumb is the accent, not translucent white', () => {
    const css = stripComments(read('global.css'));
    const body = ruleBody(css, '::-webkit-scrollbar-thumb');
    expect(body).not.toBeNull();
    expect(backgroundDeclarations(body!)).toEqual([
      ['background-color', ACCENT_THUMB],
    ]);
  });

  it('global.css: hover and drag brighten the same accent thumb', () => {
    const css = stripComments(read('global.css'));
    const rule =
      /::-webkit-scrollbar-thumb:hover,\s*::-webkit-scrollbar-thumb:active\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain(`background-color: ${ACCENT_THUMB}`);
    expect(rule![1]).toContain('filter: brightness(1.15)');
    // The state change must stay a plain fill: the dark --entei-btn-color plus
    // a box-shadow highlight was unreadable on the dark track.
    expect(rule![1]).not.toContain('--entei-btn-color');
    expect(rule![1]).not.toContain('box-shadow');
  });

  it('global.css: track and corner stay fully transparent, no background colour', () => {
    const css = stripComments(read('global.css'));
    // User requirement: the track must never get a fill of its own.
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

  it('player.css: the magnet list keeps its own 6px accent pill', () => {
    const css = stripComments(read('player.css'));
    const list = ruleBody(css, '.entei-magnet-list');
    expect(list).not.toBeNull();
    const decls = declarations(list!);
    expect(decls).toContainEqual(['scrollbar-width', 'thin']);
    expect(decls).toContainEqual([
      'scrollbar-color',
      `${ACCENT_THUMB} ${TRACK}`,
    ]);

    const thumb = ruleBody(css, '.entei-magnet-list::-webkit-scrollbar-thumb');
    expect(thumb).not.toBeNull();
    expect(backgroundDeclarations(thumb!)).toEqual([
      ['background-color', ACCENT_THUMB],
    ]);

    const hover =
      /\.entei-magnet-list::-webkit-scrollbar-thumb:hover,\s*\.entei-magnet-list::-webkit-scrollbar-thumb:active\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(hover).not.toBeNull();
    expect(hover![1]).toContain(`background-color: ${ACCENT_THUMB}`);
    expect(hover![1]).toContain('filter: brightness(1.15)');
    expect(hover![1]).not.toContain('--entei-btn-color');
    expect(hover![1]).not.toContain('box-shadow');

    // Size and track are pinned per rule block, not by a loose whole-file grep.
    const size = ruleBody(css, '.entei-magnet-list::-webkit-scrollbar');
    expect(size).not.toBeNull();
    expect(declarations(size!)).toContainEqual(['width', '6px']);
    expect(declarations(size!)).toContainEqual(['height', '6px']);
    const track = ruleBody(css, '.entei-magnet-list::-webkit-scrollbar-track');
    expect(track).not.toBeNull();
    expect(backgroundDeclarations(track!)).toEqual([
      ['background', 'transparent'],
    ]);
  });
});
