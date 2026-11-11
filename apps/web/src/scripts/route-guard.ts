/**
 * route-guard — blocks navigation to routes that no longer exist.
 * ---------------------------------------------------------------------------
 * The Tauri app ships a fixed set of static pages. Any internal `<a href>`
 * pointing at a removed route (e.g. the deleted `/xx-tutorial/…` pages or the
 * old 404 page) would land on a blank/broken view, so we intercept the click
 * at the capture phase and `preventDefault()` it — the user simply stays put.
 *
 * A build-time whitelist is used instead of runtime HEAD-probing because every
 * valid route is known when the app is built: the whitelist is deterministic,
 * needs no network, and has no async race. Add a route to `VALID_APP_ROUTES`
 * when a new page is added under `src/pages/`.
 *
 * External URLs (`http:`/`https:` on another host) are NOT handled here —
 * `trace-boot.ts` already opens those in the OS browser. This guard only
 * decides same-origin path navigation.
 * ---------------------------------------------------------------------------
 */

/**
 * Every route that produces a real page in the built app. Keep in sync with
 * `src/pages/`. Paths are normalised (see `normalizeRoutePath`) before
 * comparison, so `/thanks-to` and `/thanks-to/` are equivalent.
 */
export const VALID_APP_ROUTES: readonly string[] = [
  '/',
  '/player',
  '/audio-player',
  '/profile',
  '/settings',
  '/modules',
  '/thanks-to',
  '/tracker', // noindex redirect to /profile/ — still a real served page
];

/** Strip query + hash and collapse a trailing slash (root `/` is kept). */
export function normalizeRoutePath(pathname: string): string {
  const withoutQueryHash = pathname.split('?')[0]!.split('#')[0]!;
  if (withoutQueryHash.length <= 1) return '/';
  return withoutQueryHash.replace(/\/+$/, '') || '/';
}

/**
 * True when `pathname` is a same-origin path the app does not serve (i.e. a
 * would-be 404). External URLs are never evaluated by this helper.
 */
export function isBlockedInternalRoute(pathname: string): boolean {
  const target = normalizeRoutePath(pathname);
  return !VALID_APP_ROUTES.some((route) => normalizeRoutePath(route) === target);
}

/** A href that is a bare path / relative URL the app should route internally. */
function isInternalHref(raw: string): boolean {
  const trimmed = raw.trim();
  // Any explicit scheme (http:, https:, mailto:, tel:, javascript:, …) or a
  // protocol-relative "//host" href is not an internal app path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  if (/^\/\//.test(trimmed)) return false;
  return true;
}

/**
 * Install a capture-phase click listener that cancels navigation to any
 * same-origin path outside `VALID_APP_ROUTES`. Idempotent per document.
 */
export function installRouteGuard(): void {
  if (typeof window === 'undefined') return;
  if ((window as unknown as { __enteiRouteGuardInstalled?: boolean }).__enteiRouteGuardInstalled) {
    return;
  }
  (window as unknown as { __enteiRouteGuardInstalled?: boolean }).__enteiRouteGuardInstalled = true;

  window.addEventListener(
    'click',
    (e) => {
      // Never second-guess a handler that already cancelled the event.
      if (e.defaultPrevented) return;
      const anchor = (e.target as HTMLElement | null)?.closest('a[href]');
      if (!anchor) return;
      const raw = anchor.getAttribute('href');
      if (!raw || !isInternalHref(raw)) return;

      let url: URL;
      try {
        url = new URL(raw, window.location.href);
      } catch {
        return; // unresolvable href — leave it alone
      }

      // Only guard same-origin navigation; cross-origin is out of scope.
      if (url.origin !== window.location.origin) return;

      if (isBlockedInternalRoute(url.pathname)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true, // capture phase: intercept before React / native navigation
  );
}
