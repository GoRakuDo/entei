import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Entei — game-hub home for the GoRakuDo local-first Japanese learning toolkit.
// Phase 0 scope: static Home `/`, Player ready-state `/player/` (noindex), 404 (noindex).
// Canonical domain: https://entei.gorakudo.org (custom domain via GitHub Pages).
// `site` is safe to set now because the custom domain is the confirmed future host.
// `base` is intentionally unset: a custom domain does not require a repo-name prefix.
// Deploy automation (GitHub Actions) is NOT included — Yosia approves deploy separately.

export default defineConfig({
  site: 'https://entei.gorakudo.org',
  output: 'static',
  trailingSlash: 'ignore',

  // Clean asset URLs (matches GoRakuDo convention).
  build: {
    assets: '_astro',
    inlineStylesheets: 'auto',
  },

  publicDir: 'public',

  integrations: [
    sitemap({
      // Phase 0: only the Home route `/` is indexable. Player preview and 404 are noindex.
      filter: (page) => {
        const url = new URL(page);
        const path = url.pathname.replace(/\/$/, '') || '/';
        return path === '/';
      },
      changefreq: 'monthly',
      priority: 1.0,
      lastmod: new Date('2026-07-19T00:00:00Z'),
    }),
  ],

  vite: {
    build: {
      target: 'es2022',
      cssCodeSplit: true,
      sourcemap: false,
    },
  },
});
