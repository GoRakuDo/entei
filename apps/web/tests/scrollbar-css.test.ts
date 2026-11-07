/**
 * Static contract test for the themed scrollbar.
 * ---------------------------------------------------------------------------
 * Chromium/WebView2 drops EVERY ::-webkit-scrollbar rule for an element as
 * soon as `scrollbar-width` or `scrollbar-color` is set to a non-auto value
 * on it. The old global.css set both on `html` and `*`, so the 6px pill and
 * the `--entei-btn-color` hover/active thumb were silently ignored and the
 * chunky default bar stayed in place.
 *
 * These assertions pin the fix: the standard properties may only appear
 * inside the Firefox `@supports` fallback, and the WebKit hover/active rule
 * must use the bright accent token as a plain `background-color` so the
 * hover/drag state stays visible against the dark track and the resting
 * translucent thumb (a dark fill plus a box-shadow highlight used to be
 * invisible there).
 *
 * The fallback gate is `@supports not selector(::-webkit-scrollbar) or
 * (-moz-appearance: none)`: the second branch keeps Firefox on the standard
 * properties even after it ships ::-webkit-scrollbar support (Bug 2031468).
 *
 * Pixel appearance itself is verified in the browser; this test only guards
 * the selector/declaration contract that Chromium silently punishes.
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

const fallbackNeedle =
  '@supports (not selector(::-webkit-scrollbar)) or (-moz-appearance: none)';

/**
 * Removes every Firefox `@supports` scrollbar fallback block, so what remains
 * is exactly the cascade that Chromium sees for scrollbar styling.
 */
function withoutWebkitFallback(css: string): string {
  let out = css;
  for (;;) {
    const start = out.indexOf(fallbackNeedle);
    if (start < 0) return out;
    const open = out.indexOf('{', start);
    let depth = 1;
    let i = open + 1;
    while (i < out.length && depth > 0) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') depth--;
      i++;
    }
    out = out.slice(0, start) + out.slice(i);
  }
}

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

describe('themed scrollbar (Chromium keeps ::-webkit-scrollbar)', () => {
  it('styles/ ships at least the global and player stylesheets', () => {
    expect(cssFiles).toContain('global.css');
    expect(cssFiles).toContain('player.css');
  });

  for (const file of cssFiles) {
    it(`${file}: no standard scrollbar props outside the Firefox fallback`, () => {
      const chromiumCascade = stripComments(withoutWebkitFallback(read(file)));
      // `scrollbar-width: none` is the intentional hide used by the settings
      // tab strip, the magnet breadcrumb and the settings dialog body;
      // anything else must not exist.
      const offenders: string[] = [];
      for (const match of chromiumCascade.matchAll(
        /(scrollbar-width|scrollbar-color)\s*:\s*([^;]+);/g,
      )) {
        const prop = match[1] ?? '';
        const value = (match[2] ?? '').trim();
        if (prop === 'scrollbar-width' && value === 'none') continue;
        offenders.push(`${prop}: ${value}`);
      }
      expect(offenders).toEqual([]);
    });
  }

  it('global.css: Firefox gets the thin standard scrollbar as fallback', () => {
    const css = stripComments(read('global.css'));
    const fallback = css.slice(css.indexOf(fallbackNeedle));
    expect(fallback).toContain('scrollbar-width: thin');
    expect(fallback).toContain(
      'scrollbar-color: oklch(100% 0 0deg / 0.18) transparent',
    );
  });

  it('the Firefox fallback also survives ::-webkit-scrollbar landing in Firefox', () => {
    const gate =
      '@supports (not selector(::-webkit-scrollbar)) or (-moz-appearance: none) {';
    expect(stripComments(read('global.css'))).toContain(gate);
    expect(stripComments(read('player.css'))).toContain(gate);
  });

  it('global.css: hover and drag turn the thumb into the bright accent', () => {
    const css = stripComments(read('global.css'));
    const rule =
      /::-webkit-scrollbar-thumb:hover,\s*::-webkit-scrollbar-thumb:active\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain(
      'background-color: var(--entei-accent-hover)',
    );
    // The state change must be a plain fill: the dark --entei-btn-color plus a
    // box-shadow highlight was unreadable on the dark track.
    expect(rule![1]).not.toContain('--entei-btn-color');
    expect(rule![1]).not.toContain('box-shadow');
  });

  it('global.css: the bar itself is a 6px pill', () => {
    const css = stripComments(read('global.css'));
    const body = ruleBody(css, '::-webkit-scrollbar');
    expect(body).not.toBeNull();
    const decls = declarations(body!);
    expect(decls).toContainEqual(['width', '6px']);
    expect(decls).toContainEqual(['height', '6px']);
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

  it('player.css: the magnet list keeps its own 6px pill + bright hover fill', () => {
    const css = stripComments(read('player.css'));
    const thumb =
      /\.entei-magnet-list::-webkit-scrollbar-thumb:hover,\s*\.entei-magnet-list::-webkit-scrollbar-thumb:active\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(thumb).not.toBeNull();
    expect(thumb![1]).toContain(
      'background-color: var(--entei-accent-hover)',
    );
    expect(thumb![1]).not.toContain('--entei-btn-color');
    expect(thumb![1]).not.toContain('box-shadow');
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
