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
 * must keep the shared button fill plus the 1px inner highlight that makes
 * that fill readable inside dark dialogs (the fill and the resting thumb are
 * almost the same lightness).
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

  it('global.css: hover and drag turn the thumb into the shared button fill', () => {
    const css = stripComments(read('global.css'));
    const rule =
      /::-webkit-scrollbar-thumb:hover,\s*::-webkit-scrollbar-thumb:active\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain('background-color: var(--entei-btn-color)');
    // The fill alone is ~L31.5% against a ~L31.7% resting thumb, so the state
    // change needs the inner highlight to be visible at all.
    expect(rule![1]).toContain(
      'box-shadow: inset 0 0 0 1px oklch(100% 0 0deg / 0.35)',
    );
  });

  it('player.css: the magnet list keeps its own 6px pill + hover fill', () => {
    const css = stripComments(read('player.css'));
    const thumb =
      /\.entei-magnet-list::-webkit-scrollbar-thumb:hover,\s*\.entei-magnet-list::-webkit-scrollbar-thumb:active\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(thumb).not.toBeNull();
    expect(thumb![1]).toContain('background-color: var(--entei-btn-color)');
    expect(thumb![1]).toContain(
      'box-shadow: inset 0 0 0 1px oklch(100% 0 0deg / 0.35)',
    );
    expect(css).toContain('.entei-magnet-list::-webkit-scrollbar {');
  });
});
