/**
 * Native surface contract — the permanent wallpaper layer and the plugin
 * rectangle.
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
 * The wallpaper itself is a PERMANENT layer (`html::before` in global.css):
 * it is painted on every route and in every state, native playback or not,
 * and no rule may ever peel it away. The layer carries the rectangular hole
 * for the native picture, and that hole is built from the very same
 * measurement the plugin is given.
 *
 * These tests pin the pure helpers and the stylesheet contract that keeps
 * the two apart: the wallpaper stays painted, and the hole never grows
 * bigger than the picture that shows through it.
 * ---------------------------------------------------------------------------
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildNativePictureHole,
  computeNativePictureRect,
  intersectRects,
  NATIVE_HOLE_PROPERTY,
  planNativeSurfaceUpdate,
  toPhysicalSurfaceBounds,
  type NativePictureState,
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

/** Removes CSS comments so a rule lookup cannot hit a comment. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
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
    expect(stripComments(globalCss)).toContain(
      `clip-path: var(${NATIVE_HOLE_PROPERTY}, none)`,
    );
  });
});

describe('native picture rectangle (what the hole may cover)', () => {
  it('keeps a 16:9 frame unchanged for a 16:9 file', () => {
    const frame = { left: 0, top: 144, width: 1600, height: 900 };
    expect(computeNativePictureRect(frame, 1920, 1080)).toEqual(frame);
  });

  it('letterboxes the picture inside a frame that is not 16:9', () => {
    // libmpv letterboxes like `object-fit: contain`; the hole may only cover
    // the letterboxed rectangle, otherwise the desktop shows through the
    // pillarbox strips.
    const picture = computeNativePictureRect(
      { left: 0, top: 29, width: 1920, height: 1051 },
      1920,
      1080,
    );
    expect(picture.height).toBeCloseTo(1051, 5);
    expect(picture.width).toBeCloseTo(1868.48, 1);
    expect(picture.left).toBeCloseTo(25.76, 1);
    expect(picture.top).toBeCloseTo(29, 5);
  });

  it('falls back to the frame when the media size is unknown', () => {
    const frame = { left: 0, top: 144, width: 1457, height: 819 };
    expect(computeNativePictureRect(frame, 0, 0)).toEqual(frame);
    expect(computeNativePictureRect(frame, null, null)).toEqual(frame);
  });
});

describe('native hole overlap', () => {
  it('returns the shared strip of two overlapping rectangles', () => {
    expect(
      intersectRects(
        { left: 0, top: 0, width: 100, height: 100 },
        { left: 50, top: 50, width: 100, height: 100 },
      ),
    ).toEqual({ left: 50, top: 50, width: 50, height: 50 });
  });

  it('returns null when the rectangles do not overlap', () => {
    expect(
      intersectRects(
        { left: 0, top: 0, width: 10, height: 10 },
        { left: 50, top: 50, width: 10, height: 10 },
      ),
    ).toBeNull();
    // Touching edges share no area either.
    expect(
      intersectRects(
        { left: 0, top: 0, width: 10, height: 10 },
        { left: 10, top: 0, width: 10, height: 10 },
      ),
    ).toBeNull();
  });
});

describe('native surface update order (no desktop through the hole)', () => {
  const narrow: NativePictureState = {
    bounds: { x: 0, y: 29, width: 1457, height: 1051 },
    picture: { left: 0, top: 29, width: 1457, height: 1051 },
  };
  const wide: NativePictureState = {
    bounds: { x: 0, y: 29, width: 1920, height: 1051 },
    picture: { left: 0, top: 29, width: 1920, height: 1051 },
  };
  const moved: NativePictureState = {
    bounds: { x: 0, y: 200, width: 1457, height: 1051 },
    picture: { left: 0, top: 200, width: 1457, height: 1051 },
  };

  it('opens the hole right away when the picture already sits in the frame', () => {
    const plan = planNativeSurfaceUpdate(narrow, narrow);
    expect(plan.movePicture).toBeNull();
    expect(plan.holeAfterMove).toBe(plan.holeDuringMove);
    expect(plan.holeAfterMove).toContain('M0 29H1457V1080H0Z');
  });

  it('keeps the hole inside the picture while a growing frame moves', () => {
    // The old hole lies inside the new (bigger) picture, so it may stay
    // open: the picture simply grows into it.
    const plan = planNativeSurfaceUpdate(narrow, wide);
    expect(plan.movePicture).toEqual(wide.bounds);
    expect(plan.holeDuringMove).toContain('M0 29H1457V1080H0Z');
    expect(plan.holeAfterMove).toContain('M0 29H1920V1080H0Z');
  });

  it('shrinks the hole to the new picture when the frame shrinks', () => {
    const plan = planNativeSurfaceUpdate(wide, narrow);
    expect(plan.movePicture).toEqual(narrow.bounds);
    expect(plan.holeDuringMove).toContain('M0 29H1457V1080H0Z');
    expect(plan.holeAfterMove).toContain('M0 29H1457V1080H0Z');
  });

  it('shrinks the hole to the overlap when the frame moves', () => {
    // The desktop leaked through exactly here: the hole stayed on the old
    // position while the picture had already moved away from it.
    const plan = planNativeSurfaceUpdate(narrow, moved);
    expect(plan.movePicture).toEqual(moved.bounds);
    expect(plan.holeDuringMove).toContain('M0 200H1457V1080H0Z');
    expect(plan.holeAfterMove).toContain('M0 200H1457V1251H0Z');
  });

  it('closes the wall while the first picture is placed', () => {
    const plan = planNativeSurfaceUpdate(null, narrow);
    expect(plan.movePicture).toEqual(narrow.bounds);
    expect(plan.holeDuringMove).toBe('');
    expect(plan.holeAfterMove).toContain('M0 29H1457V1080H0Z');
  });
});

describe('native wallpaper CSS contract', () => {
  const globalRules = stripComments(globalCss);
  const playerRules = stripComments(playerCss);

  it('paints the wallpaper on a permanent layer behind every page', () => {
    const layer = ruleBody(globalRules, 'html::before {');
    expect(layer).toContain('position: fixed');
    expect(layer).toContain('top: 0');
    expect(layer).toContain('left: 0');
    expect(layer).toContain('bottom: 0');
    // 100vw reaches the transparent scrollbar track: a strip that showed
    // the desktop through the transparent Tauri window.
    expect(layer).toContain('width: 100vw');
    expect(layer).toContain('z-index: -1');
    expect(layer).toContain('pointer-events: none');
    expect(layer).toContain('background-image: var(--entei-bg-image)');
    expect(layer).toContain(`clip-path: var(${NATIVE_HOLE_PROPERTY}, none)`);
  });

  it('never peels the wallpaper away', () => {
    // The wallpaper is painted in EVERY state. No rule may remove the
    // background image or switch the page background off: that is what made
    // the desktop show through the transparent Tauri window for a few
    // milliseconds while the wallpaper was late.
    expect(playerRules).not.toContain('background-image: none');
    expect(globalRules).not.toContain('background-image: none');
    // `<body>` paints no background at all — not in the normal state and
    // not in the native state.
    expect(globalRules).not.toMatch(/^body\s*\{[^}]*background/m);
    expect(playerRules).not.toMatch(
      /html\.entei-native-video[^{]*\{[^}]*background-image/m,
    );
  });

  it('keeps the media frame itself transparent (the picture lives behind it)', () => {
    const frame = ruleText(
      playerRules,
      'html.entei-native-video .entei-player-container',
    );
    expect(frame).toContain('background-color: transparent');
    expect(frame).toContain('.entei-player-media-area');
    expect(frame).toContain('.entei-player-surface');
    expect(frame).toContain('.entei-player-video-wrapper');
  });

  it('shares one wallpaper between the layer and the native hole', () => {
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
    expect(playerApp).toContain('computeNativePictureRect(');
    expect(playerApp).toContain('NATIVE_HOLE_PROPERTY');
  });

  it('shrinks the hole while the picture moves and opens it afterwards', () => {
    // The hole is the ONE place where the desktop can come through, so it
    // may never be bigger than the picture — not even for the few
    // milliseconds the picture move takes.
    expect(playerApp).toContain('planNativeSurfaceUpdate(');
    expect(playerApp).toMatch(
      /void mpvSetBounds\([\s\S]*?\.then\(\(\) => \{[\s\S]*?setHole\(holeAfterMove\)/,
    );
    // The hole that holds the move is written BEFORE the move is issued.
    expect(playerApp).toMatch(
      /setHole\(holeDuringMove\);[\s\S]*?mpvSetBounds\(/,
    );
    // A failed move keeps the wall closed — the desktop cannot come through.
    expect(playerApp).toMatch(/\.catch\(\(\) => \{[\s\S]*?setHole\(''\)/);
  });

  it('re-measures the surface when the layout changes', () => {
    // The right panel toggle remounts the media area: without a re-measure
    // the hole keeps the old frame while the picture follows the new one.
    expect(playerApp).toMatch(
      /nativeSurfaceSyncRef\.current\?\.\(\);\s*\}, \[isSubtitlePanelVisible/,
    );
  });

  it('keeps the right panel column opaque', () => {
    // The panel column sits next to the media frame. The wallpaper layer
    // covers it, and the panel paints its own opaque surface on top.
    expect(playerCss).toMatch(
      /\.entei-right-panel-inner\s*\{[^}]*background-color:\s*var\(--entei-surface\)/,
    );
    expect(playerCss).toMatch(
      /\.entei-right-panel-content\s*\{[^}]*background-color:\s*var\(--entei-surface\)/,
    );
    expect(playerCss).toMatch(
      /\.entei-resizable-panel-side\s*\{[^}]*background-color:\s*var\(--entei-surface\)/,
    );
  });
});
