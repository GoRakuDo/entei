# Entei

Game-hub style home for the GoRakuDo local-first Japanese learning toolkit.

**Canonical URL:** `https://entei.gorakudo.org`
**Phase:** 0 — Home Hub Foundation (code implemented, awaiting Yosia review)

## What Entei is

Entei is the welcoming entrance to the GoRakuDo learning toolkit. It is **not**
the media player, EPUB reader, or Anki integration — those come in later phases.
Phase 0 delivers:

- A single Home route at `/` with Indonesian as the initial language
- In-page language switching between Bahasa Indonesia, 日本語, and English
- A dominant Audio & Video Player destination linking to a ready-state page
- A visibly present but non-interactive EPUB Reader marked "Coming Soon"
- localStorage-based language preference with safe fallback
- WCAG 2.2 AA accessibility target, mobile-first responsive layout

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Astro 7.1.1 (static output, no client framework runtime) |
| Language | TypeScript 6.0.3 (strict mode) |
| Styling | Plain CSS + Astro scoped styles (no Tailwind in Phase 0) |
| Fonts | Gen Interface JP / Display, Pixelify Sans (self-hosted via @fontsource) |
| Package manager | npm 11.15.0 |
| Testing | Vitest 4.1.10 + jsdom |
| Future host | GitHub Pages (custom domain, deploy not yet executed) |

## Project structure

```
Entei/
├─ apps/
│  └─ web/                    # Astro project
│     ├─ public/
│     │  ├─ brand/             # favicon.svg, emblem.svg
│     │  ├─ og/                # og-image.svg (pre-deploy: rasterize to PNG)
│     │  ├─ robots.txt
│     │  └─ CNAME              # entei.gorakudo.org
│     ├─ src/
│     │  ├─ components/
│     │  │  ├─ home/           # TopBar, HubIdentity, DestinationDock, etc.
│     │  │  ├─ icons/           # HubEmblem, PlayerIcon, ReaderIcon (inline SVG)
│     │  │  ├─ LanguageSelector.astro
│     │  │  └─ SeoHead.astro
│     │  ├─ i18n/
│     │  │  ├─ types.ts         # Locale type, LocalePreference, Dictionary
│     │  │  ├─ locales/        # id.ts, ja.ts, en.ts
│     │  │  ├─ index.ts        # dictionaries, metadata, isLocale, getDictionary
│     │  │  └─ preferences.ts   # localStorage read/validate/write
│     │  ├─ layouts/
│     │  │  └─ BaseLayout.astro
│     │  ├─ pages/
│     │  │  ├─ index.astro     # Home (the only indexed route)
│     │  │  ├─ player/
│     │  │  │  └─ index.astro  # Player ready-state (noindex)
│     │  │  └─ 404.astro       # 404 (Indonesian, noindex)
│     │  ├─ scripts/
│     │  │  └─ locale-switcher.ts  # FOUC-safe locale application
│     │  └─ styles/
│     │     ├─ tokens.css      # GoRakuDo palette snapshot (9 OKLCH tokens)
│     │     ├─ fonts.css       # Self-hosted @fontsource imports
│     │     └─ global.css      # Reset, FOUC prevention, a11y helpers
│     ├─ tests/
│     │  ├─ locale.test.ts     # Type guard, key parity, constants
│     │  └─ preferences.test.ts # Read/write/validate/fallback
│     ├─ astro.config.mjs
│     ├─ tsconfig.json
│     ├─ vitest.config.ts
│     └─ package.json
├─ docs/
│  └─ PHASE0.md                # Authoritative spec and implementation log
├─ package.json                # Workspace root
├─ .gitignore
└─ .prettierrc.json
```

## Commands

```bash
# From the Entei root:
npm install              # Install all dependencies
npm run dev              # Start dev server (http://localhost:4321)
npm run build            # Production build → apps/web/dist/
npm run preview          # Preview production build locally
npm run check            # TypeScript + Astro type check
npm run test             # Run Vitest tests
npm run format           # Prettier write
npm run format:check     # Prettier check (CI gate)
```

## Design decisions (recorded in PHASE0.md Section 23)

- **Single URL `/`** — no locale routing, no `/ja/` or `/en/`. Language switches
  in-page via native `<select>`.
- **Plain CSS** over Tailwind v4 — Phase 0 has only 3 pages; Tailwind's utility
  classes would add dependency weight without proportional benefit. Design token
  values are identical to GoRakuDo (snapshot copy), so visual consistency holds.
- **Astro 7.1.1** (latest stable as of 2026-07-19), not pinned to GoRakuDo's
  Astro 5.13.0 — new project, no upgrade burden.
- **GitHub Pages** as future host — `site` is set to
  `https://entei.gorakudo.org`, `base` is unset (custom domain requires no
  prefix). Deploy automation is intentionally NOT included.

## Pre-deploy TODOs

These remain as documented manual steps, not automated:

1. **OG image rasterization** — `public/og/og-image.svg` should be converted to
   PNG/WebP (1200×630) for broader social-platform support. Some platforms
   render SVG OG images inconsistently.
2. **favicon.ico** — a fallback `.ico` file for legacy browsers. The SVG
   favicon works in all modern browsers.
3. **GitHub Pages setup** — create the repository, push, enable Pages, add the
   custom domain, configure DNS. The `public/CNAME` file is already in place.
4. **Security headers** — GitHub Pages response headers are limited. CSP via
   `<meta>` tag is the fallback if server-side headers are not configurable.
5. **Manual verification matrix** — Lighthouse, axe, keyboard, screen reader,
   zoom, and viewport testing across the Chromium matrix (320/360/390/768/
   1024/1280/1440px) must be run before declaring Implementation Complete.

## Reference-only dependencies

This project references but does **not** modify or runtime-import:

- `D:\GoRakuDo` — palette values and font roles were snapshot-copied into
  `apps/web/src/styles/tokens.css` and `fonts.css`. No runtime import.
- `D:\GoRakudo_Projects\園庭プロジェクトの書き下ろし.md` — product vision and
  roadmap. Read-only reference.

## License

To be determined. See PHASE0.md for project governance.
