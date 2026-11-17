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
 * - `popupWidth` / `popupHeight` are the frame's box (`Popup._setFrameSize`) and
 *   `popupScalingFactor` is the content scale (`Popup.setContentScale`, which
 *   writes `frame.style.fontSize = \`${scale}px\``). Neither is a stylesheet rule
 *   either, so both are resolved here and applied to the preview's frame.
 *
 * The preview document is a string (an iframe `srcdoc`), so all three are
 * resolved here, in the host document, and serialized into it: nothing has to run
 * inside the frame.
 * ---------------------------------------------------------------------------
 */

import type { Options } from '@gorakudo/yomitan-headless/settings';
import { ThemeController } from '@/modules/yomitan/vendor/js/app/theme-controller.js';
import { activeProfileOptions } from '@/modules/yomitan/yomitan-preferences';

/**
 * The outer theme, resolved to a concrete value.
 *
 * `site` / `browser` are already gone by the time this is read: what is left is
 * what the stylesheets key off, i.e. what `data-outer-theme` holds. `light` is
 * also the fallback for anything unexpected, because upstream's own
 * `popup-outer.css` paints the light shadow on `iframe.yomitan-popup` itself and
 * only overrides it for `dark` / `none`.
 */
export type ResolvedPopupOuterTheme = 'light' | 'dark' | 'none';

/** What the popup document needs to look like the user's popup. */
export interface PopupAppearance {
  /** `data-theme` and friends, to be spread onto the document element. */
  themeAttributes: Readonly<Record<string, string>>;
  /**
   * `general.popupOuterTheme`, resolved (`ThemeController`) to `light` / `dark` /
   * `none`.
   *
   * The FRAME's own attribute, not the document's: upstream's `popup-outer.css`
   * styles the `<iframe>` the extension creates (`iframe.yomitan-popup[
   * data-outer-theme=…]`), which in this host is the frame ELEMENT, outside the
   * document. The stylesheets vendored here are the popup's CONTENT only, so the
   * frame's shadow is applied by the host from this value — one resolution, read
   * by both popups (the Appearance preview and the floating one).
   */
  resolvedOuterTheme: ResolvedPopupOuterTheme;
  popupActionBarLocation: 'top' | 'bottom' | 'left' | 'right';
  popupActionBarVisibility: 'always' | 'auto';
  /** Inline `style` text for the document element ('' when all defaults). */
  fontStyle: string;
  /** `general.customPopupCss`, verbatim. */
  customCss: string;
  /**
   * The popup frame's box in CSS pixels — `general.popupWidth` /
   * `general.popupHeight`, multiplied by `general.popupScalingFactor`.
   *
   * The factor scales both, because it scales both upstream: the frame's own
   * font-size (so the content needs more room) and, with it, the box the popup
   * measures. The caller still clamps the result to the space the card has.
   */
  size: { width: number; height: number };
}

/** Upstream's own defaults for the three Position & Size numbers. */
const DEFAULT_POPUP_WIDTH = 400;
const DEFAULT_POPUP_HEIGHT = 250;
const DEFAULT_POPUP_SCALE = 1;

/**
 * The value, or the default when the field holds nothing usable.
 *
 * The number fields accept `0` and the options parser only rejects non-numbers
 * (`checkNumber(..., 0)` upstream), so a cleared or zeroed field must not
 * collapse the preview to a 0×0 box.
 */
function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
  /* In Entei's dark shell, the site theme is dark (#0b0c14). Setting siteTheme
     directly guarantees that `popupTheme: "site"` (Auto) resolves to dark
     without relying on OS prefers-color-scheme (which may be light). */
  controller.siteTheme = 'dark';
  controller.siteOverride = false;
  const browserTheme = readBrowserTheme();
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
 * The frame's outer theme, read off the attributes `ThemeController` wrote.
 *
 * NOT a second resolution: the controller has already turned `site` / `browser`
 * into `light` / `dark`, and `none` / `light` / `dark` pass through untouched
 * (`ThemeController._resolveThemeValue`), so `outerTheme` IS the answer.
 *
 * The KEY is the dataset property, not the attribute: `themeAttributes` is the
 * controller's own `element.dataset` copied out (camelCase — `popup-document`
 * is what kebab-cases it on the way into the document).
 */
export function resolvePopupOuterTheme(
  value: string | undefined,
): ResolvedPopupOuterTheme {
  return value === 'dark' || value === 'none' ? value : 'light';
}

/**
 * Inline font styles for the document element (upstream `setFontOptions`).
 *
 * An empty value is skipped rather than written as an empty declaration, which is
 * what assigning `''` to a style property does upstream.
 *
 * `contentScale` is `general.popupScalingFactor`: upstream scales the popup by
 * writing the frame's `font-size`, which every `em`-based rule in Yomitan's own
 * stylesheets is relative to. The popup document carries its own root font-size
 * (`general.fontSize`), so the same factor is applied to that value here — one
 * scale over the same content.
 */
export function resolvePopupFontStyle(
  fontFamily: string,
  fontSize: number,
  lineHeight: string,
  contentScale: number = DEFAULT_POPUP_SCALE,
): string {
  const declarations: string[] = [];
  const scale = positiveOr(contentScale, DEFAULT_POPUP_SCALE);
  if (fontFamily !== '') declarations.push(`font-family:${fontFamily}`);
  if (Number.isFinite(fontSize)) {
    // Two decimals: a 0.1-step factor times a whole pixel size can land on
    // 22.000000000000004, which is the same size but a different string.
    const scaled = Math.round(fontSize * scale * 100) / 100;
    declarations.push(`font-size:${scaled}px`);
  }
  if (lineHeight !== '') declarations.push(`line-height:${lineHeight}`);
  return declarations.length > 0 ? declarations.join(';') : '';
}

/**
 * The document-level dataset attributes upstream's `Display._updateDocumentOptions`
 * writes from the options that are NOT the theme/font/size (see `display.js`).
 *
 * These are the display-mode booleans and enums Yomitan mirrors onto the popup's
 * `<html>` element so `display.css` can key its rules off them (result output mode,
 * compact glossaries, term/frequency display style, average frequency, selection
 * indicator, search tags, debug flag, the three pitch-accent pronunciation flags).
 * Each key is a `dataset` property (camelCase); `popup-document`'s `renderThemeAttributes`
 * kebab-cases it on the way into the document, exactly like the DOM does for a real
 * `element.dataset.x = …`.
 *
 * `parsing.readingMode` is deliberately NOT here: upstream passes it to the
 * `QueryParser` (how parsed text is read), it is never a `data-*` attribute and no
 * stylesheet keys off it — this host does not run the query parser in the popup, so
 * there is nothing to mirror. Kept faithful to `_updateDocumentOptions`.
 *
 * The `??` fallbacks are upstream's own defaults (`createDefaultGeneralOptions`), not
 * inventions: they only fire for a stored profile that predates a field, because
 * `normalizeOptions` passes `profile.options` through as it stands rather than merging
 * it field by field. `resultOutputMode` is one of the four enum values
 * (`group` / `merge` / `split` / `term`), and `group` is what upstream starts on.
 */
function resolvePopupContentAttributes(
  profile: ReturnType<typeof activeProfileOptions>,
): Record<string, string> {
  const { general, scanning } = profile;
  return {
    resultOutputMode: String(general.resultOutputMode ?? 'group'),
    glossaryLayoutMode: String(general.glossaryLayoutMode),
    compactTags: String(general.compactTags),
    averageFrequency: String(general.averageFrequency ?? false),
    enableSearchTags: String(scanning.enableSearchTags),
    debug: String(general.debugInfo),
    termDisplayMode: String(general.termDisplayMode),
    frequencyDisplayMode: String(general.frequencyDisplayMode),
    popupCurrentIndicatorMode: String(general.popupCurrentIndicatorMode),
    showPronunciationText: String(general.showPitchAccentDownstepNotation),
    showPronunciationDownstepPosition: String(
      general.showPitchAccentPositionNotation,
    ),
    showPronunciationGraph: String(general.showPitchAccentGraph),
  };
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
  const {
    popupTheme,
    popupOuterTheme,
    fontFamily,
    fontSize,
    lineHeight,
    customPopupCss,
    popupWidth,
    popupHeight,
    popupScalingFactor,
    popupActionBarLocation = 'top',
    popupActionBarVisibility = 'always',
  } = profile.general;
  const scale = positiveOr(popupScalingFactor, DEFAULT_POPUP_SCALE);
  /* ThemeController's own `data-theme` family, then the display-mode attributes
     upstream writes onto the same element (`_updateDocumentOptions`). One record,
     because both land on the popup's `<html>`. */
  const themeAttributes: Record<string, string> = {
    ...resolvePopupThemeAttributes(popupTheme, popupOuterTheme),
    ...resolvePopupContentAttributes(profile),
  };
  const rawLocation = String(popupActionBarLocation).toLowerCase();
  const validLocation = ['top', 'bottom', 'left', 'right'].includes(rawLocation)
    ? (rawLocation as 'top' | 'bottom' | 'left' | 'right')
    : 'top';
  const rawVisibility = String(popupActionBarVisibility).toLowerCase();
  const validVisibility = rawVisibility === 'never' || rawVisibility === 'auto'
    ? (rawVisibility as 'always' | 'auto')
    : 'always';
  return {
    themeAttributes,
    resolvedOuterTheme: resolvePopupOuterTheme(themeAttributes.outerTheme),
    popupActionBarLocation: validLocation,
    popupActionBarVisibility: validVisibility,
    fontStyle: resolvePopupFontStyle(fontFamily, fontSize, lineHeight, scale),
    customCss: customPopupCss,
    size: {
      width: Math.round(positiveOr(popupWidth, DEFAULT_POPUP_WIDTH) * scale),
      height: Math.round(positiveOr(popupHeight, DEFAULT_POPUP_HEIGHT) * scale),
    },
  };
}

/**
 * The substring of `options` the appearance depends on — a cheap change key.
 *
 * A lookup is a database round trip; a theme change is not. Splitting the two
 * keys is what keeps dragging the font-size number field from re-running the
 * dictionary search on every step. The Position & Size numbers belong on THIS
 * key, not the lookup one: they are edited in another section, and dragging them
 * must redraw the frame without re-querying the dictionary engine.
 */
export function popupAppearanceKey(options: Options): string {
  const profile = activeProfileOptions(options);
  const {
    popupTheme,
    popupOuterTheme,
    fontFamily,
    fontSize,
    lineHeight,
    customPopupCss,
    popupWidth,
    popupHeight,
    popupScalingFactor,
    popupActionBarLocation,
    popupActionBarVisibility,
    resultOutputMode,
    glossaryLayoutMode,
    compactTags,
    averageFrequency,
    termDisplayMode,
    frequencyDisplayMode,
    popupCurrentIndicatorMode,
    debugInfo,
    showPitchAccentDownstepNotation,
    showPitchAccentPositionNotation,
    showPitchAccentGraph,
  } = profile.general;
  return JSON.stringify([
    popupTheme,
    popupOuterTheme,
    fontFamily,
    fontSize,
    lineHeight,
    customPopupCss,
    popupWidth,
    popupHeight,
    popupScalingFactor,
    popupActionBarLocation,
    popupActionBarVisibility,
    resultOutputMode,
    glossaryLayoutMode,
    compactTags,
    averageFrequency,
    termDisplayMode,
    frequencyDisplayMode,
    popupCurrentIndicatorMode,
    debugInfo,
    showPitchAccentDownstepNotation,
    showPitchAccentPositionNotation,
    showPitchAccentGraph,
    profile.scanning.enableSearchTags,
  ]);
}