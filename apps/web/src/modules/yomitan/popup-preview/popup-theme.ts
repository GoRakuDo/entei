/**
 * popup-theme — the Appearance settings, applied the way Yomitan applies them.
 * ---------------------------------------------------------------------------
 * Three of Yomitan's popup appearance knobs are not stylesheet rules at all; they
 * are things the extension writes onto the popup document at runtime
 * (`Display._setTheme` / `Display.setFontOptions` in `ext/js/display/display.js`):
 *
 * - `popupTheme` / `popupOuterTheme` go through `ThemeController`, which resolves
 *   `site` / `browser` to a concrete `light` / `dark` and writes the `data-theme`
 *   family of attributes the stylesheets key off. This host reuses that class
 *   rather than re-deriving the resolution, so "Site" means the same thing here
 *   as it does upstream (with `siteOverride`, exactly like a popup preview).
 * - `fontFamily` / `fontSize` / `lineHeight` are written as INLINE styles on the
 *   document element — upstream's own comment says this is deliberate, because
 *   setting the CSS variables instead does not scale everything correctly.
 * - `customPopupCss` becomes one extra stylesheet appended after the rest.
 *
 * The preview document is a string (an iframe `srcdoc`), so all three are
 * resolved here, in the host document, and serialized into it: nothing has to run
 * inside the frame.
 * ---------------------------------------------------------------------------
 */

import type { Options } from '@gorakudo/yomitan-headless/settings';
import { ThemeController } from '@/modules/yomitan/vendor/js/app/theme-controller.js';
import { activeProfileOptions } from '@/modules/yomitan/yomitan-preferences';

/** What the popup document needs to look like the user's popup. */
export interface PopupAppearance {
  /** `data-theme` and friends, to be spread onto the document element. */
  themeAttributes: Readonly<Record<string, string>>;
  /** Inline `style` text for the document element ('' when all defaults). */
  fontStyle: string;
  /** `general.customPopupCss`, verbatim. */
  customCss: string;
}

/**
 * The browser's preferred colour scheme, or `null` when it cannot be read.
 *
 * `matchMedia` exists in every browser and in the jsdom test environment; the
 * guard is for a non-browser host, where "Browser" has no meaning and the
 * controller's own default (`light`) is the right answer.
 */
function readBrowserTheme(): 'light' | 'dark' | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return null;
  }
}

/**
 * Resolve the theme attributes `ThemeController` would write.
 *
 * The controller is driven against a throwaway element: it only ever touches
 * `element.dataset`, and `siteOverride = true` keeps it from calling
 * `getComputedStyle` (the site theme is never consulted). `prepare()` is
 * deliberately NOT called — it registers a permanent `matchMedia` listener on the
 * host window, which a settings row must not leak on every render.
 */
export function resolvePopupThemeAttributes(
  popupTheme: string,
  popupOuterTheme: string,
): Readonly<Record<string, string>> {
  const element = document.createElement('div');
  const controller = new ThemeController(element);
  controller.theme = popupTheme;
  controller.outerTheme = popupOuterTheme;
  controller.siteOverride = true;
  const browserTheme = readBrowserTheme();
  // `_browserTheme` is the controller's own backing field: upstream exposes only a
  // getter for it, because the value is normally owned by its `matchMedia`
  // listener — which `prepare()` is not called to install here.
  if (browserTheme !== null) controller._browserTheme = browserTheme;
  controller.updateTheme();

  const { dataset } = element;
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(dataset)) {
    if (value !== undefined) attributes[name] = value;
  }
  return attributes;
}

/**
 * Inline font styles for the document element (upstream `setFontOptions`).
 *
 * An empty value is skipped rather than written as an empty declaration, which is
 * what assigning `''` to a style property does upstream.
 */
export function resolvePopupFontStyle(
  fontFamily: string,
  fontSize: number,
  lineHeight: string,
): string {
  const declarations: string[] = [];
  if (fontFamily !== '') declarations.push(`font-family:${fontFamily}`);
  if (Number.isFinite(fontSize)) declarations.push(`font-size:${fontSize}px`);
  if (lineHeight !== '') declarations.push(`line-height:${lineHeight}`);
  return declarations.length > 0 ? declarations.join(';') : '';
}

/**
 * Everything the popup document's appearance depends on, read from the options.
 *
 * Note: upstream also appends each enabled dictionary's own `styles` to the popup
 * CSS (`Display._getCustomCss`). Yomitan's persisted `DictionaryOptions` has no
 * `styles` member — it is added by the extension's importer, which this host does
 * not have (dictionaries are imported by the Rust engine) — so only
 * `general.customPopupCss` is addressable here.
 */
export function resolvePopupAppearance(options: Options): PopupAppearance {
  const profile = activeProfileOptions(options);
  return {
    themeAttributes: resolvePopupThemeAttributes(
      profile.general.popupTheme,
      profile.general.popupOuterTheme,
    ),
    fontStyle: resolvePopupFontStyle(
      profile.general.fontFamily,
      profile.general.fontSize,
      profile.general.lineHeight,
    ),
    customCss: profile.general.customPopupCss,
  };
}

/**
 * The substring of `options` the appearance depends on — a cheap change key.
 *
 * A lookup is a database round trip; a theme change is not. Splitting the two
 * keys is what keeps dragging the font-size number field from re-running the
 * dictionary search on every step.
 */
export function popupAppearanceKey(options: Options): string {
  const profile = activeProfileOptions(options);
  const { popupTheme, popupOuterTheme, fontFamily, fontSize, lineHeight, customPopupCss } =
    profile.general;
  return JSON.stringify([
    popupTheme,
    popupOuterTheme,
    fontFamily,
    fontSize,
    lineHeight,
    customPopupCss,
  ]);
}