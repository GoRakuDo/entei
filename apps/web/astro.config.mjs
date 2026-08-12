import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';

const THRESHOLD = 1024; // only compress files >= 1 KB

// Already-compressed or poor-gain binary formats — skip for CPU savings.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff2', '.woff', '.ttf',
  '.otf', '.wasm', '.mp4', '.mp3', '.zip',
]);

/** Recursively collect all files under dir (symlink guard included). */
async function getAllFiles(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    const s = await stat(p);
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) await getAllFiles(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * astro:build:done hook — compress built assets with gzip + brotli after
 * Astro has finished the whole build (dist fully populated, including
 * public/ copies), so there is no writeBundle race. Node zlib only.
 */
async function compressBuild(dir, logger) {
  const distDir = fileURLToPath(dir);
  const files = await getAllFiles(distDir);
  let gz = 0;
  let br = 0;
  for (const file of files) {
    if (file.endsWith('.gz') || file.endsWith('.br')) continue; // skip prior outputs
    if (BINARY_EXT.has(extname(file))) continue;
    const { size } = await stat(file);
    if (size < THRESHOLD) continue; // only compress files >= 1 KB
    try {
      const data = await readFile(file);
      await writeFile(`${file}.gz`, gzipSync(data));
      gz++;
      await writeFile(`${file}.br`, brotliCompressSync(data));
      br++;
    } catch (err) {
      logger.warn(`Failed to compress ${file}: ${err.message}`);
    }
  }
  logger.info(`Compressed ${gz} gzip + ${br} brotli files in dist/`);
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
    mdx(),
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
    // Static gzip + brotli after the whole build (dist fully populated),
    // avoiding the vite-plugin-compression2 writeBundle race on Windows.
    {
      name: 'static-compression',
      hooks: {
        'astro:build:done': async ({ dir, logger }) => {
          await compressBuild(dir, logger);
        },
      },
    },
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
