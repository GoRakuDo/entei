# Vendored Yomitan popup assets

The Yomitan settings page shows a **live popup preview** in its Appearance
section. Entei reproduces it exactly: the preview renders the popup through
Yomitan's own `DisplayGenerator` (vendored under
`src/modules/yomitan/vendor/`) against Entei's own dictionary lookups, and this
directory holds the stylesheet / template / icon files that generator's output
needs.

Nothing here is hand-written. Every file is a byte-for-byte copy from the pinned
Yomitan checkout, except for the three rewrites listed below.

## Provenance

| | |
|---|---|
| Upstream | <https://github.com/yomidevs/yomitan> |
| Pinned at | `ac1d839f9fe4d7f852381b693bba2b159b5c943a` (`26.11.2.0`), consumed as the `vendor/yomitan` submodule of [`@gorakudo/yomitan-headless`](https://github.com/GoRakuDo/yomitan-headless) |
| License | GPL-3.0-or-later — every copied file keeps its upstream copyright header |
| Path in upstream | `ext/` |

## Contents

| Here | Upstream | Why the preview needs it |
|---|---|---|
| `css/material.css` | `ext/css/material.css` | icon masks (`[data-icon=…]`) and the tag/button base the popup is built from — `ext/popup.html` loads it first |
| `css/display.css` | `ext/css/display.css` | the popup's own layout, term-entry, headword, tag, pitch-accent and structured-content styling |
| `css/display-pronunciation.css` | `ext/css/display-pronunciation.css` | pitch-accent graph / downstep notation |
| `css/structured-content.css` | `ext/css/structured-content.css` | `<details>`/`<table>`/gloss-image structured content |
| `templates-display.html` | `ext/templates-display.html` | the `<template>` set `DisplayGenerator` instantiates every entry from |
| `images/*.svg` | `ext/images/*.svg` | every `url(…)` the stylesheets above reference |

Upstream also has `ext/css/popup-preview.css` and `ext/css/popup-outer.css`, which
styled the preview PAGE and the popup's host `<iframe>`. Neither is copied: a
`srcdoc` preview is one document, so there is no host frame to style, and the two
rules that document still needs (the `html, body` reset and the frame's
`#ffffff` / `#1e1e1e` background) are restated verbatim in `popup-document.ts`.

## Deliberate deviations

1. **`/images/…` → `/yomitan/images/…`** in `material.css` and `display.css`.
   Entei serves this directory from `public/`, so the upstream absolute paths
   would 404. No selector or declaration was touched.
2. **The `kanji-stroke-orders` `@font-face` is removed from `display.css`.** Its
   source font is 18 MB and is only used by `.kanji-entry .kanji-glyph`, which a
   term-entry preview never draws. The upstream rule is replaced in place by a
   comment saying so.

## Do not edit by hand

These files are copied, not authored. To move to a newer Yomitan, re-run the
copy from the new submodule commit and re-apply the three rewrites above; a
hand-patch here would be silently lost and would drift the preview away from
upstream.