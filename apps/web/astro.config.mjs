import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

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

  // Astro 7.2 experimental incremental static builds (2026-08-07):
  // skips re-rendering prerendered pages whose code and data haven't changed.
  // Routes opt in per-path via getStaticPaths() cacheKey; paths without a
  // cacheKey are always rendered, so existing behavior is unchanged until a
  // route opts in. Cache lives in cacheDir (node_modules/.astro/), so CI that
  // persists that directory can reuse it across runs.
  experimental: {
    incrementalBuild: true,
  },

  // Clean asset URLs (matches GoRakuDo convention).
  build: {
    assets: '_astro',
    inlineStylesheets: 'auto',
  },

  publicDir: 'public',

  integrations: [
    react(),
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
    plugins: [tailwindcss()],
    build: {
      target: 'es2022',
      cssCodeSplit: true,
      sourcemap: false,
    },
  },
});
