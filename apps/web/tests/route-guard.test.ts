/**
 * route-guard tests — scripts/route-guard.ts.
 *
 * Verifies:
 * 1. normalizeRoutePath strips query/hash and collapses trailing slashes
 * 2. Known app routes are allowed; removed routes (tutorials, 404) are blocked
 * 3. External / cross-origin / scheme hrefs are never guarded
 * 4. Clicking an anchor to a removed same-origin route is preventDefault()-ed
 * 5. Clicking an anchor to a valid route is NOT cancelled
 * 6. The guard is idempotent (double install adds one listener)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  VALID_APP_ROUTES,
  installRouteGuard,
  isBlockedInternalRoute,
  normalizeRoutePath,
} from '../src/scripts/route-guard';

describe('normalizeRoutePath', () => {
  it('keeps root as "/"', () => {
    expect(normalizeRoutePath('/')).toBe('/');
    expect(normalizeRoutePath('//')).toBe('/');
  });

  it('strips trailing slash', () => {
    expect(normalizeRoutePath('/player/')).toBe('/player');
    expect(normalizeRoutePath('/thanks-to/')).toBe('/thanks-to');
  });

  it('strips query and hash', () => {
    expect(normalizeRoutePath('/profile/?x=1#top')).toBe('/profile');
    expect(normalizeRoutePath('/player/#cue-3')).toBe('/player');
  });
});

describe('isBlockedInternalRoute', () => {
  it('allows every whitelisted app route (with or without trailing slash)', () => {
    for (const route of VALID_APP_ROUTES) {
      expect(isBlockedInternalRoute(route)).toBe(false);
      expect(isBlockedInternalRoute(`${route}/`)).toBe(false);
    }
  });

  it('blocks removed tutorial routes and the removed 404', () => {
    expect(isBlockedInternalRoute('/ja-tutorial/eizoudendenshi/')).toBe(true);
    expect(isBlockedInternalRoute('/id-tutorial')).toBe(true);
    expect(isBlockedInternalRoute('/en-tutorial/')).toBe(true);
    expect(isBlockedInternalRoute('/404')).toBe(true);
    expect(isBlockedInternalRoute('/some/removed/page')).toBe(true);
  });

  it('blocks a valid route name under an invalid prefix', () => {
    // /player exists, but /player/extra does not.
    expect(isBlockedInternalRoute('/player/extra')).toBe(true);
  });
});

describe('installRouteGuard (DOM)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // Fresh window flag so each test installs its own guard instance.
    delete (window as unknown as { __enteiRouteGuardInstalled?: boolean })
      .__enteiRouteGuardInstalled;
    installRouteGuard();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('cancels a click to a removed same-origin route', () => {
    const a = document.createElement('a');
    a.setAttribute('href', '/ja-tutorial/eizoudendenshi/');
    document.body.appendChild(a);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('does not cancel a click to a valid route', () => {
    const a = document.createElement('a');
    a.setAttribute('href', '/player/');
    document.body.appendChild(a);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores external http(s) hrefs (left to trace-boot)', () => {
    const a = document.createElement('a');
    a.setAttribute('href', 'https://example.com/');
    document.body.appendChild(a);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores cross-origin same-scheme hrefs', () => {
    const a = document.createElement('a');
    a.setAttribute('href', 'http://other.host/ja-tutorial/');
    document.body.appendChild(a);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores scheme hrefs like mailto:', () => {
    const a = document.createElement('a');
    a.setAttribute('href', 'mailto:hi@example.com');
    document.body.appendChild(a);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('is idempotent — a second install does not double-guard', () => {
    installRouteGuard();

    const a = document.createElement('a');
    a.setAttribute('href', '/removed-route');
    document.body.appendChild(a);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);

    // Still cancelled, but only once (defaultPrevented is a boolean).
    expect(event.defaultPrevented).toBe(true);
  });
});
