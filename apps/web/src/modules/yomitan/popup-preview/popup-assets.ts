/**
 * popup-assets — the vendored Yomitan popup files, read once.
 * ---------------------------------------------------------------------------
 * `public/yomitan/` holds Yomitan's own stylesheets, display templates and icons
 * (see that directory's README for provenance and the three rewrites). They are
 * PUBLIC files rather than bundled ones because they have to be complete,
 * unmodified upstream text: the preview injects them into an iframe document, and
 * a bundler that fingerprints or tree-shakes a stylesheet would defeat the point.
 *
 * They are also LARGE (about 140 KB of CSS), so they are read on demand and then
 * kept: the module-level promise below means a settings page opened and closed
 * ten times fetches them once. A rejected read clears the slot, so a transient
 * failure is retryable by reopening the section instead of being cached forever.
 * ---------------------------------------------------------------------------
 */

/** Directory the vendored files are served from (see `public/yomitan/README.md`). */
export const YOMITAN_ASSET_BASE = '/yomitan/';

/**
 * Stylesheets the popup document needs, in `ext/popup.html`'s own order.
 *
 * `material.css` first: the icon masks and tag/button base everything else is
 * layered on top of. Then the display rules, then the two add-on sheets.
 */
const POPUP_STYLESHEETS = [
  'css/material.css',
  'css/display.css',
  'css/display-pronunciation.css',
  'css/structured-content.css',
] as const;

/** `ext/templates-display.html` — the `<template>` set the generator fills. */
const DISPLAY_TEMPLATES = 'templates-display.html';

/** Everything the popup document is built from. */
export interface PopupPreviewAssets {
  /** Concatenated upstream CSS, in cascade order. */
  css: string;
  /** Upstream `templates-display.html`, unparsed. */
  templates: string;
}

/** Absolute URL of one vendored file. */
function popupAssetUrl(relativePath: string): string {
  return `${YOMITAN_ASSET_BASE}${relativePath}`;
}

let pending: Promise<PopupPreviewAssets> | null = null;

async function readAssets(): Promise<PopupPreviewAssets> {
  const [sheets, templates] = await Promise.all([
    Promise.all(
      POPUP_STYLESHEETS.map(async (path) => {
        const response = await fetch(popupAssetUrl(path));
        if (!response.ok) {
          throw new Error(`Failed to load ${path}: ${response.status}`);
        }
        return await response.text();
      }),
    ),
    (async () => {
      const response = await fetch(popupAssetUrl(DISPLAY_TEMPLATES));
      if (!response.ok) {
        throw new Error(`Failed to load ${DISPLAY_TEMPLATES}: ${response.status}`);
      }
      return await response.text();
    })(),
  ]);
  return { css: sheets.join('\n'), templates };
}

/**
 * Read the vendored files, at most once per page load.
 *
 * A failure is NOT cached: the slot is cleared so the next caller retries.
 */
export function loadPopupPreviewAssets(): Promise<PopupPreviewAssets> {
  if (pending === null) {
    pending = readAssets().catch((error: unknown) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}