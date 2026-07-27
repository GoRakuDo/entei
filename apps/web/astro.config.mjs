import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const webTorrentBrowserBundlePath = require.resolve(
  'webtorrent/dist/webtorrent.min.js',
);

/**
 * WebTorrent's browser distribution is an ESM module. Emit and serve it raw
 * so the Player can dynamically import it without Vite selecting the Node
 * package entry in either dev or static production output.
 */
function webTorrentBrowserBundle() {
  const assetPath = '/webtorrent.min.js';

  return {
    name: 'entei-webtorrent-browser-bundle',
    configureServer(server) {
      server.middlewares.use(assetPath, (request, response, next) => {
        if (request.method !== 'GET') return next();
        response.setHeader('Content-Type', 'application/javascript');
        response.end(readFileSync(webTorrentBrowserBundlePath));
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: assetPath.slice(1),
        source: readFileSync(webTorrentBrowserBundlePath),
      });
    },
  };
}

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
    plugins: [tailwindcss(), webTorrentBrowserBundle()],
    build: {
      target: 'es2022',
      cssCodeSplit: true,
      sourcemap: false,
    },
  },
});
