/**
 * Bun test preload (loaded via `bunfig.toml` → `[test].preload`).
 * ---------------------------------------------------------------------------
 * Runs once per test file, before any test module is imported.
 *
 * Four environment shims live here:
 *
 * 1. `@testing-library/react` registers its automatic `cleanup()` by checking
 *    for a global `afterEach` *at module-evaluation time*. Bun exposes the
 *    test API only through `bun:test` (there are no `globalThis.describe/
 *    it/expect/afterEach` globals), so without this shim the auto-cleanup is
 *    silently skipped and rendered trees leak between tests in the same file.
 *
 * 2. `@testing-library/jest-dom` matchers (`toBeInTheDocument`, …) are
 *    extended onto Bun's `expect` once, so test files no longer need
 *    `import '@testing-library/jest-dom/vitest'`.
 *
 * 3. React's passive effects (`useEffect`) are flushed before an async query
 *    resolves. Bun's scheduler runs the passive-effect task *after* the task
 *    that commits the DOM, so `findBy*`/`waitFor` can resolve while a
 *    component's effects (audio registration, IntersectionObserver attach)
 *    are still pending — the test then interacts with a tree whose effects
 *    have not run. Node's scheduler happened to win that race; Bun's does
 *    not. One extra `act()` pass in `asyncWrapper` closes the gap for every
 *    `findBy*`/`waitFor` call in the suite.
 *
 * 4. `window.matchMedia` is (re)installed as a plain function. jsdom has no
 *    implementation, so files assign their own mock and then call
 *    `vi.restoreAllMocks()`, which leaves a function that returns
 *    `undefined`. The jsdom `window` object is reused across files in one
 *    `bun test` run, so that broken value leaks into the next file.
 */

import { afterEach, beforeEach, expect } from 'bun:test';
import { act, configure } from '@testing-library/react';
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';

// Bun's `expect.extend` is jest-compatible; jest-dom's matcher object is
// shaped for exactly that contract.
expect.extend(jestDomMatchers as unknown as Record<string, never>);

const globals = globalThis as unknown as Record<string, unknown>;

// Expose the lifecycle hooks globally so library auto-registration (RTL's
// cleanup in particular) finds them.
globals.afterEach = afterEach;
globals.beforeEach = beforeEach;

// Required for React's `act()` to flush effects synchronously instead of
// queueing them onto the scheduler (RTL only sets this for the duration of
// its own wrappers; the custom asyncWrapper below needs it around them).
globals.IS_REACT_ACT_ENVIRONMENT = true;

configure({
  // Bun runs test files in parallel workers, so a `waitFor`/`findBy*` poll can
  // sit behind other files' work on a loaded machine. RTL's 1s default is too
  // tight for that; 3s still fails fast on a genuinely broken assertion.
  asyncUtilTimeout: 3000,
  // Mirrors RTL's default asyncWrapper (act environment disabled while the
  // query polls, so async updates don't warn) and adds one flush pass: the
  // extra `act()` drains the passive effects scheduled by the commit that
  // the query just observed.
  asyncWrapper: async (callback) => {
    let result: unknown;
    globals.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      result = await callback();
    } finally {
      globals.IS_REACT_ACT_ENVIRONMENT = true;
    }
    await act(async () => {});
    return result as never;
  },
});

if (typeof window !== 'undefined') {
  const matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia,
  });
}
