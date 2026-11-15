# Vendored Yomitan display code

The transitive **relative-import closure** of Yomitan's popup card renderer, copied
verbatim so that no import path inside any file has to be rewritten. The layout
mirrors upstream's `ext/`, which is what keeps those paths valid.

Nothing here is authored by Entei and nothing here is patched. It exists so the
Appearance section's popup preview can run Yomitan's OWN `DisplayGenerator`
against Entei's dictionary lookups — see `../popup-preview/` for the driver and
`../../../../public/yomitan/README.md` for the stylesheets, templates and icons it
pairs with.

## Provenance

| | |
|---|---|
| Upstream | <https://github.com/yomidevs/yomitan> |
| Pinned at | `ac1d839f9fe4d7f852381b693bba2b159b5c943a` (`26.11.2.0`), consumed as the `vendor/yomitan` submodule of [`@gorakudo/yomitan-headless`](https://github.com/GoRakuDo/yomitan-headless) |
| License | GPL-3.0-or-later — every file keeps its upstream copyright header |
| Path in upstream | `ext/js/` for `js/**`, and `ext/data/` for `data/anki-compact-gloss-style.js` |

## Files

| Upstream | Why it is in the closure |
|---|---|
| `js/display/display-generator.js` | the card renderer — the entry point |
| `js/display/pronunciation-generator.js` | pitch-accent text, downstep notation, accent graph |
| `js/display/structured-content-generator.js` | structured-content glossaries |
| `js/display/display-content-manager.js` | the content manager the generator requires |
| `js/dictionary/dictionary-data-util.js` | headword/definition/frequency/tag grouping |
| `js/dom/html-template-collection.js` | `<template>` instantiation |
| `js/app/theme-controller.js` | `popupTheme` / `popupOuterTheme` resolution |
| `js/language/**` | furigana distribution, pitch categories, kana morae |
| `js/templates/anki-template-renderer-content-manager.js`, `js/data/anki-note-data-creator.js` | required by the structured-content generator |
| `js/core/**`, `js/data/*-util*.js` | utilities the above import |

## Two consequences for the host

1. **`allowJs` is on** in `apps/web/tsconfig.json`. These are `.js` files with
   JSDoc types; `checkJs` stays off, so they are consumed but not type-checked.
2. **Load is lazy.** The closure is about 230 KB of unminified ESM, so it is only
   reached through the dynamic `import()` in `popup-entries.ts` — opening the
   Appearance section, not the settings page, is what fetches it.

`js/core/fetch-utilities.js` is the one file that touches a WebExtension API
(`chrome.runtime.getURL`). It is only reached through
`DisplayGenerator.prepare()`, which the driver deliberately does not call — the
templates are handed to the collection directly, because this host has no
`chrome.*`.