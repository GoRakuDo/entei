/// <reference types="vite/client" />

/**
 * Ambient types for the web app.
 *
 * `vite/client` is the declaration that types `import.meta.glob` (plus the
 * asset/CSS-module shims). Astro already pulls it in transitively through
 * `astro/client`, but the module registry calls `import.meta.glob` directly, so
 * the dependency is referenced here explicitly instead of relying on that
 * transitive path — otherwise a change in Astro's client typings would surface
 * as a TS2339 in `module-registry.ts` with no obvious cause.
 */
