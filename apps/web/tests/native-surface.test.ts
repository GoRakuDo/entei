/**
 * Native surface contract — the wallpaper hole and the plugin rectangle.
 * ---------------------------------------------------------------------------
 * libmpv paints the picture into a child HWND that lives BEHIND the WebView2
 * (the webview is created with `transparent: true`). The page therefore has
 * to satisfy two contracts at once:
 *
 *  - the media frame stays transparent, so the native picture can come
 *    through the webview, and
 *  - every other pixel stays opaque, so the desktop never shows through the
 *    transparent Tauri window.
 *
 * The wallpaper therefore carries a rectangular hole at the media frame, and
 * that hole is built from the very same measurement the plugin is given.
 * These tests pin the pure helpers and the stylesheet contract that keeps
 * the two apart: the page background and the native wallpaper layer share
 * one set of wallpaper variables, so they cannot drift into two different
 * pictures.
 * ---------------------------------------------------------------------------
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildNativePictureHole,
  NATIVE_HOLE_PROPERTY,
  toPhysicalSurfaceBounds,
} from '../src/features/player/native-surface';

// `bun test` runs from the web workspace root (apps/web).
const playerCss = readFileSync(
  resolve(process.cwd(), 'src/styles/player.css'),
  'utf8',
);
const globalCss = readFileSync(
  resolve(process.cwd(), 'src/styles/global.css'),
  'utf8',
);
const playerApp = readFileSync(
  resolve(process.cwd(), 'src/components/player/PlayerApp.tsx'),
  'utf8',
);

/**
 * Returns the declaration text of the rule block that starts at `selector`.
 *
 * Deliberately naive parser: it reads from the first `{` after the selector
 * to its matching `}` (nested blocks included).
 */
function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(selector);
  expect(start, `rule block for ${selector}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 1;
  let i = open + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return source.slice(open + 1, i - 1);
}

/** Returns the whole rule (selector list included) that starts at `selector`. */
function ruleText(source: string, selector: string): string {
  const start = source.indexOf(selector);
  expect(start, `rule block for ${selector}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 1;
  let i = open + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return source.slice(start, i);
}

describe('native surface rectangle (plugin side)', () => {
  it('scales the CSS-pixel media frame into physical pixels', () => {
    expect(
      toPhysicalSurfaceBounds(
        { left: 10, top: 20, width: 800, height: 450 },
        2,
      ),
    ).toEqual({ x: 20, y: 40, width: 1600, height: 900 });
  });

  it('rounds fractional physical pixels (the IPC rejects them)', () => {
    expect(
      toPhysicalSurfaceBounds(
        { left: 10.4, top: 20.6, width: 800.5, height: 450.2 },
        1,
      ),
    ).toEqual({ x: 10, y: 21, width: 801, height: 450 });
  });

  it('falls back to 1x for an unusable device pixel ratio', () => {
    expect(
      toPhysicalSurfaceBounds({ left: 0, top: 0, width: 320, height: 180 }, 0),
    ).toEqual({ x: 0, y: 0, width: 320, height: 180 });
    expect(
      toPhysicalSurfaceBounds(
        { left: 0, top: 0, width: 320, height: 180 },
        Number.NaN,
      ),
    ).toEqual({ x: 0, y: 0, width: 320, height: 180 });
  });

  it('rejects a frame without area — that is a hide request, not a position', () => {
    expect(
      toPhysicalSurfaceBounds({ left: 0, top: 0, width: 0, height: 0 }, 1),
    ).toBeNull();
    expect(
      toPhysicalSurfaceBounds({ left: 0, top: 0, width: 320, height: 0 }, 1),
    ).toBeNull();
    expect(
      toPhysicalSurfaceBounds(
        { left: Number.NaN, top: 0, width: 320, height: 180 },
        1,
      ),
    ).toBeNull();
  });
});

describe('native surface hole (wallpaper side)', () => {
  it('builds an even-odd path with the media frame as the hole', () => {
    const path = buildNativePictureHole({
      left: 100,
      top: 50,
      width: 800,
      height: 450,
    });
    expect(path.startsWith('path(evenodd, "')).toBe(true);
    // The hole sub-path traces the media frame: left top → right top →
    // right bottom → left bottom.
    expect(path).toContain('M100 50H900V500H100Z');
  });

  it('rounds the hole to whole CSS pixels', () => {
    const path = buildNativePictureHole({
      left: 10.4,
      top: 20.6,
      width: 800.5,
      height: 450.2,
    });
    expect(path).toContain('M10 21H811V471H10Z');
  });

  it('uses the custom property the stylesheet reads', () => {
    expect(NATIVE_HOLE_PROPERTY).toBe('--entei-native-hole');
    expect(playerCss).toContain(`var(${NATIVE_HOLE_PROPERTY}, none)`);
  });
});

describe('native wallpaper CSS contract', () => {
  it('punches the hole into a fixed wallpaper layer behind the page', () => {
    const layer = ruleBody(playerCss, 'html.entei-native-video body::before');
    expect(layer).toContain('position: fixed');
    expect(layer).toContain('inset: 0');
    expect(layer).toContain('z-index: -1');
    expect(layer).toContain('pointer-events: none');
    expect(layer).toContain(`clip-path: var(${NATIVE_HOLE_PROPERTY}, none)`);
    expect(layer).toContain('background-image: var(--entei-bg-image)');
  });

  it('keeps the root and the body transparent so the hole can show through', () => {
    const shell = ruleBody(playerCss, 'html.entei-native-video body');
    expect(shell).toContain('background-color: transparent');
    expect(shell).toContain('background-image: none');
  });

  it('keeps the media frame itself transparent (the picture lives behind it)', () => {
    const frame = ruleText(
      playerCss,
      'html.entei-native-video .entei-player-container',
    );
    expect(frame).toContain('background-color: transparent');
    expect(frame).toContain('.entei-player-media-area');
    expect(frame).toContain('.entei-player-surface');
    expect(frame).toContain('.entei-player-video-wrapper');
  });

  it('shares one wallpaper between the page and the native layer', () => {
    expect(globalCss).toContain(
      "--entei-bg-image: url('/brand/entei-gradient-background.webp')",
    );
    expect(globalCss).toMatch(/background-image:\s*var\(--entei-bg-image\)/);
    expect(globalCss).toMatch(/background-size:\s*var\(--entei-bg-size\)/);
    expect(globalCss).toMatch(
      /background-position:\s*var\(--entei-bg-position\)/,
    );
    // The mobile variant moves with the same variables.
    expect(globalCss).toMatch(/--entei-bg-size:\s*auto 100dvh/);
    expect(globalCss).toMatch(/--entei-bg-position:\s*center center/);
  });

  it('wires the surface rectangle and the hole from one measurement', () => {
    // Regression guard: the plugin call and the hole were dropped once, which
    // left the native picture behind an opaque page.
    expect(playerApp).toContain('mpvSetBounds(');
    expect(playerApp).toContain('buildNativePictureHole(');
    expect(playerApp).toContain('NATIVE_HOLE_PROPERTY');
  });
});
