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
 *
 * THE ICONS ARE INLINED, and that is not cosmetic. Both hosts draw the document
 * in a SANDBOXED iframe (`sandbox=""` for the settings preview,
 * `sandbox="allow-scripts"` for the floating popup), and a sandbox without
 * `allow-same-origin` gives the document an OPAQUE origin. Chrome then refuses to
 * load the stylesheets' `url('/yomitan/images/…')` subresources — they are
 * cross-origin requests the frame is not allowed to make — so every `.icon`
 * span keeps `mask-image: none` and paints its whole box in the icon colour.
 * Measured in Chrome 151: the 40×30 action-bar buttons come out as solid blocks
 * with the URL form, and draw the real chevron/cross glyphs with the same CSS
 * rewritten to `data:` URIs.
 *
 * `inlinePopupIconUrls` does that rewrite at assembly time, so the vendored
 * stylesheets stay byte-for-byte upstream (see `public/yomitan/README.md`) and the
 * sandbox attribute stays as tight as it is: the alternative fix — adding
 * `allow-same-origin` to a frame that also runs script — would hand the frame
 * access to the host document.
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

/**
 * Every `url('/yomitan/images/…')` in the stylesheets, as upstream writes them.
 *
 * Only the single-quoted absolute form the vendored sheets use is matched, so a
 * `url()` that is already relative, already inlined or a gradient is left alone.
 */
const POPUP_ICON_URL = /url\('\/yomitan\/images\/([^']+)'\)/g;

/** Name of every icon the stylesheets reference, in first-seen order. */
function popupIconNames(css: readonly string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const sheet of css) {
    for (const [, name] of sheet.matchAll(POPUP_ICON_URL)) {
      if (name === undefined || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Encode bytes as a base64 `data:` URL without spreading a large buffer. */
function iconDataUrl(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * Rewrite the stylesheets' icon URLs into `data:` URIs.
 *
 * PURE: `readIcon` is handed in, so the substitution is testable without a
 * network. An icon that cannot be read KEEPS its original URL — that one glyph
 * falls back to the old behaviour instead of the whole rewrite failing, and the
 * vendored-asset test already fails if a referenced file is missing.
 */
export function inlinePopupIconUrls(
  css: string,
  readIcon: (name: string) => Uint8Array | null,
): string {
  return css.replace(POPUP_ICON_URL, (whole, name: string) => {
    const bytes = readIcon(name);
    return bytes === null ? whole : `url("${iconDataUrl(bytes)}")`;
  });
}

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

  // One request per DISTINCT icon (about eighty between the four sheets), which
  // the substitution above reuses by name. A failed icon is cached as `null` so a
  // missing file is not re-requested on every rebuild.
  const icons = new Map<string, Uint8Array | null>();
  await Promise.all(
    popupIconNames(sheets).map(async (name) => {
      try {
        const response = await fetch(popupAssetUrl(`images/${name}`));
        icons.set(
          name,
          response.ok ? new Uint8Array(await response.arrayBuffer()) : null,
        );
      } catch {
        icons.set(name, null);
      }
    }),
  );

  return {
    css: inlinePopupIconUrls(sheets.join('\n'), (name) => icons.get(name) ?? null),
    templates,
  };
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