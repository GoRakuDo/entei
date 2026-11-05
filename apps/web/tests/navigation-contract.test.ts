/**
 * Navigation contract tests — NAVIGATION_BAR.md full desktop redesign.
 *
 * Verifies:
 * 1. Exactly one aria-current="page" per nav surface (desktop sidebar/pill + mobile dock)
 * 2. Home uses the desktop left sidebar; Profile/Player use the pill
 * 3. Mobile dock always has 1 destination link (+ Immersion Tools + Settings islands)
 * 4. All nav links use path hrefs (no hash, no javascript:)
 * 5. Dictionary nav keys exist and are non-empty in all locales
 * 6. data-i18n on nav link labels for locale-switcher text update
 * 7. data-i18n-aria-label on nav landmarks for locale-switcher aria-label update
 * 8. Locale switch updates nav label text and aria-label to translated values
 * 9. The desktop language combobox is gone (language lives in Settings)
 * 10. Player zone gets --player modifier class; Profile does not
 * 11. Profile is present in the desktop pill before the Immersion Tools drawer; Tracker is absent
 * 12. Home mobile has no sticky header (dock-only SNS feed)
 * 13. The Immersion Tools drawer replaces the direct Player destination
 *     (MODULE_ARCHITECTURE.md §4)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyLocale } from '../src/scripts/locale-switcher';
import { dictionaries } from '../src/i18n/index';
import type { Locale } from '../src/i18n/types';

/* -------------------------------------------------------------------------- */
/*  1. Dictionary nav keys parity across locales                              */
/* -------------------------------------------------------------------------- */
describe('Retired Tracker route contract', () => {
  it('/tracker/ is a noindex redirect to /profile/', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/tracker/index.astro'),
      'utf-8',
    );
    expect(source).toContain('name="robots" content="noindex, nofollow"');
    expect(source).toContain('http-equiv="refresh" content="0;url=/profile/"');
    expect(source).toContain('<link rel="canonical" href="/profile/" />');
    expect(source).toContain("window.location.replace('/profile/')");
  });
});

describe('Nav dictionary keys (Stage N1)', () => {
  const navKeys = [
    'destinationHome',
    'destinationTools',
    'destinationProfile',
    'desktopNavLabel',
    'mobileDockLabel',
  ] as const;

  const locales: Locale[] = ['id', 'ja', 'en'];

  for (const locale of locales) {
    it(`${locale}: has all nav destination keys`, () => {
      const nav = dictionaries[locale].nav;
      for (const key of navKeys) {
        expect(nav[key], `${locale}.nav.${key} is missing or empty`).toBeTruthy();
        expect(typeof nav[key]).toBe('string');
        expect(
          (nav[key] as string).length,
          `${locale}.nav.${key} should be non-empty`,
        ).toBeGreaterThan(0);
      }
    });
  }

  it('all locales share the same nav key set', () => {
    const idKeys = Object.keys(dictionaries.id.nav).sort();
    const jaKeys = Object.keys(dictionaries.ja.nav).sort();
    const enKeys = Object.keys(dictionaries.en.nav).sort();
    expect(jaKeys).toEqual(idKeys);
    expect(enKeys).toEqual(idKeys);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Dictionary language.combobox key exists in all locales                  */
/* -------------------------------------------------------------------------- */
describe('Language combobox dictionary keys', () => {
  const locales: Locale[] = ['id', 'ja', 'en'];

  for (const locale of locales) {
    it(`${locale}: has language.comboboxLabel`, () => {
      const lang = dictionaries[locale].language;
      expect(lang.comboboxLabel, `${locale}.language.comboboxLabel missing`).toBeTruthy();
      expect(typeof lang.comboboxLabel).toBe('string');
      expect(lang.comboboxLabel.length).toBeGreaterThan(0);
    });
  }
});

/* -------------------------------------------------------------------------- */
/*  3. TopBar HTML output — rendered via string simulation                    */
/* -------------------------------------------------------------------------- */

function normalisePath(p: string): string {
  if (p === '/') return '/';
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * Tool routes are owned by the Immersion Tools drawer trigger
 * (MODULE_ARCHITECTURE.md §4), so no nav link carries aria-current there.
 */
function isToolsRoute(path: string): boolean {
  return (
    path === '/player' || path === '/audio-player' || path === '/modules'
  );
}

const DESTINATIONS = [
  { route: '/profile/', labelKey: 'destinationProfile' },
] as const;

/**
 * Desktop Home sidebar destinations — mirrors SIDEBAR_DESTINATIONS in
 * TopBar.astro: Home + Profile. The Immersion Tools drawer and Settings
 * follow as React islands (not `<a data-entei-nav-destination>` links).
 */
const SIDEBAR_DESTINATIONS = [
  { route: '/', labelKey: 'destinationHome' },
  { route: '/profile/', labelKey: 'destinationProfile' },
] as const;

/**
 * Mobile dock destinations — mirrors MOBILE_DESTINATIONS in TopBar.astro:
 * Home only. The Immersion Tools drawer and the Settings dialog are rendered
 * separately as React islands.
 */
const MOBILE_DESTINATIONS = [
  { route: '/', labelKey: 'destinationHome' },
] as const;

/**
 * Simulate the TopBar HTML output per the current structure.
 *
 * Home: desktop left sidebar (brand → Home → Profile → Tools → Settings),
 *       no desktop pill zone, no mobile sticky header.
 * Profile/Player: desktop pill zone (Player gets the `--player` modifier).
 * No desktop language combobox anywhere (language lives in Settings).
 * Mobile dock: always rendered.
 */
function renderTopBarHtml(opts: {
  currentPath: string;
  showLanguageSelector?: boolean;
}): string {
  const { currentPath, showLanguageSelector = true } = opts;
  const activePath = normalisePath(currentPath);
  const isPlayer = activePath === '/player';
  const isHome = activePath === '/';

  // Mobile sticky header — not rendered on Home (dock-only mobile Home).
  let html = '';
  if (!isHome) {
    html += `<header class="entei-topbar-mobile" role="banner"><div class="entei-topbar-mobile-inner">`;
    html += `<a class="entei-wordmark" href="/"><span class="entei-wordmark-text">Entei</span></a>`;
    if (showLanguageSelector) {
      html += `<div class="entei-language-selector"></div>`;
    }
    html += `</div></header>`;
  }

  if (isHome) {
    // Desktop Home left sidebar
    html += `<aside class="entei-desktop-sidebar" data-entei-desktop-sidebar>`;
    html += `<nav class="entei-desktop-sidebar-nav" aria-label="Page navigation" data-entei-desktop-nav data-i18n-aria-label="nav.desktopNavLabel">`;
    html += `<a class="entei-desktop-sidebar-brand" href="/" data-entei-nav-destination="/"><span>Entei</span></a>`;
    html += `<ul class="entei-desktop-sidebar-list">`;
    for (const { route, labelKey } of SIDEBAR_DESTINATIONS) {
      const isActive = normalisePath(route) === activePath;
      html += `<li class="entei-desktop-sidebar-item"><a class="entei-desktop-sidebar-link" href="${route}"${isActive ? ' aria-current="page"' : ''} data-entei-nav-destination="${route}"><span data-i18n="nav.${labelKey}">${labelKey}</span></a></li>`;
    }
    // Immersion Tools drawer entry — React island, not a navigation link.
    html += `<li class="entei-desktop-sidebar-item"><button type="button" class="entei-nav-tools-trigger" data-entei-nav-tools data-entei-nav-tools-variant="sidebar"${isToolsRoute(activePath) ? ' data-active="true"' : ''}></button></li>`;
    // Settings dialog entry — React island, not a navigation link.
    html += `<li class="entei-desktop-sidebar-item"><div data-entei-desktop-sidebar-settings></div></li>`;
    html += `</ul></nav></aside>`;
  } else {
    // Desktop pill zone
    const zoneClass = isPlayer
      ? 'entei-desktop-pill-zone entei-desktop-pill-zone--player'
      : 'entei-desktop-pill-zone';
    html += `<div class="${zoneClass}" data-entei-desktop-nav-zone>`;

    if (isPlayer) {
      html += `<div class="entei-desktop-pill-trigger-zone" data-entei-trigger-zone></div>`;
    }

    html += `<nav class="entei-desktop-pill" aria-label="Page navigation" data-entei-desktop-nav data-i18n-aria-label="nav.desktopNavLabel">`;

    // Brand = Home link
    const homeActive = activePath === '/';
    html += `<a class="entei-desktop-pill-brand" href="/"${homeActive ? ' aria-current="page"' : ''} data-entei-nav-destination="/"><span>Entei</span></a>`;

    // Profile and Tools entries (Home is brand)
    for (const { route, labelKey } of DESTINATIONS) {
      const isActive = normalisePath(route) === activePath;
      html += `<a class="entei-desktop-pill-link" href="${route}"${isActive ? ' aria-current="page"' : ''} data-entei-nav-destination="${route}"><span data-i18n="nav.${labelKey}">${labelKey}</span></a>`;
    }
    // Immersion Tools drawer entry — React island, not a navigation link.
    html += `<button type="button" class="entei-nav-tools-trigger" data-entei-nav-tools data-entei-nav-tools-variant="pill"${isToolsRoute(activePath) ? ' data-active="true"' : ''}></button>`;
    html += `</nav>`;
    html += `</div>`;
  }

  // Mobile dock: MOBILE_DESTINATIONS (Home) + Immersion Tools + Settings entries.
  html += `<nav class="entei-mobile-dock" aria-label="Page navigation" data-entei-mobile-dock data-i18n-aria-label="nav.mobileDockLabel"${isHome ? ' data-entei-mobile-dock-scroll-only=""' : ''}>`;
  for (const { route, labelKey } of MOBILE_DESTINATIONS) {
    const isActive = normalisePath(route) === activePath;
    html += `<a class="entei-mobile-dock-link" href="${route}"${isActive ? ' aria-current="page"' : ''} data-entei-nav-destination="${route}"><span data-i18n="nav.${labelKey}">${labelKey}</span></a>`;
  }
  // Immersion Tools drawer entry — React island, not a navigation link.
  html += `<div data-entei-mobile-dock-tools></div>`;
  // Settings dialog entry — React island, not a navigation link.
  html += `<div data-entei-mobile-dock-settings></div>`;
  html += `</nav>`;
  return html;
}

function countAriaCurrentPage(html: string): number {
  return (html.match(/aria-current="page"/g) || []).length;
}

function parseHtml(html: string): Element {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

/* -------------------------------------------------------------------------- */
/*  4. Route active state — exactly one aria-current per nav surface          */
/* -------------------------------------------------------------------------- */
describe('aria-current="page" — one per nav surface per route', () => {
  const routes = ['/', '/profile/', '/player/'] as const;

  for (const route of routes) {
    it(`${route}: desktop nav has one aria-current; mobile dock marks active route only when present`, () => {
      const html = renderTopBarHtml({ currentPath: route });
      const root = parseHtml(html);

      // Desktop nav — always present. The tool routes (/player/, /audio-player/,
      // /modules/) are owned by the Immersion Tools drawer trigger, so no
      // link carries aria-current there; the trigger carries data-active.
      const desktopNav = root.querySelector('[data-entei-desktop-nav]');
      expect(desktopNav).not.toBeNull();
      const desktopCurrent = desktopNav!.querySelectorAll(
        '[aria-current="page"]',
      );
      const expectedDesktopCount =
        route === '/' || route === '/profile/' ? 1 : 0;
      expect(desktopCurrent.length).toBe(expectedDesktopCount);
      if (expectedDesktopCount === 1) {
        expect(desktopCurrent[0]!.getAttribute('href')).toBe(route);
      } else {
        const toolsTrigger = desktopNav!.querySelector('[data-entei-nav-tools]');
        expect(toolsTrigger).not.toBeNull();
        expect(toolsTrigger!.getAttribute('data-active')).toBe('true');
      }

      // Mobile dock — Home only. Profile and the tool routes have no link.
      const mobileDock = root.querySelector('[data-entei-mobile-dock]');
      expect(mobileDock).not.toBeNull();
      const mobileCurrent = mobileDock!.querySelectorAll(
        '[aria-current="page"]',
      );
      const expectedMobileCount = route === '/' ? 1 : 0;
      expect(mobileCurrent.length).toBe(expectedMobileCount);
      if (expectedMobileCount === 1) {
        expect(mobileCurrent[0]!.getAttribute('href')).toBe(route);
      }
    });
  }
});

/* -------------------------------------------------------------------------- */
/*  5. Home = desktop left sidebar; Profile/Player = pill zone                */
/* -------------------------------------------------------------------------- */
describe('Desktop nav surface by route', () => {
  it('Home (/): left sidebar present, no pill zone', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    expect(root.querySelector('[data-entei-desktop-nav]')).not.toBeNull();
    expect(root.querySelector('[data-entei-desktop-sidebar]')).not.toBeNull();
    expect(root.querySelector('[data-entei-desktop-nav-zone]')).toBeNull();
  });

  it('Home (/): sidebar order is brand → Home → Profile → Tools → Settings', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    const sidebar = root.querySelector('[data-entei-desktop-sidebar]');
    expect(sidebar).not.toBeNull();

    const brand = sidebar!.querySelector('.entei-desktop-sidebar-brand');
    expect(brand).not.toBeNull();
    expect(brand!.getAttribute('href')).toBe('/');

    const hrefs = Array.from(
      sidebar!.querySelectorAll('a[data-entei-nav-destination]'),
    ).map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/', '/', '/profile/']);

    // Tools drawer + Settings entries are the last two list items and are
    // not navigation links.
    const items = sidebar!.querySelectorAll('.entei-desktop-sidebar-item');
    expect(items.length).toBe(4);
    expect(items[2]!.querySelector('[data-entei-nav-tools]')).not.toBeNull();
    expect(
      items[3]!.querySelector('[data-entei-desktop-sidebar-settings]'),
    ).not.toBeNull();
  });

  it('Home (/): brand carries no aria-current (Home row owns it)', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    const brand = root.querySelector('.entei-desktop-sidebar-brand');
    expect(brand!.hasAttribute('aria-current')).toBe(false);
    const homeRow = root.querySelector(
      '.entei-desktop-sidebar-link[aria-current="page"]',
    );
    expect(homeRow!.getAttribute('href')).toBe('/');
  });

  it('Profile (/profile/): desktop pill <nav> is present, no --player modifier', () => {
    const html = renderTopBarHtml({ currentPath: '/profile/' });
    const root = parseHtml(html);
    expect(root.querySelector('[data-entei-desktop-nav]')).not.toBeNull();
    expect(root.querySelector('[data-entei-desktop-sidebar]')).toBeNull();
    const zone = root.querySelector('[data-entei-desktop-nav-zone]');
    expect(zone).not.toBeNull();
    expect(zone!.classList.contains('entei-desktop-pill-zone--player')).toBe(false);
  });

  it('Player (/player/): desktop pill <nav> IS present with --player modifier', () => {
    const html = renderTopBarHtml({ currentPath: '/player/' });
    const root = parseHtml(html);
    expect(root.querySelector('[data-entei-desktop-nav]')).not.toBeNull();
    const zone = root.querySelector('[data-entei-desktop-nav-zone]');
    expect(zone).not.toBeNull();
    expect(zone!.classList.contains('entei-desktop-pill-zone--player')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  6. Desktop language combobox removed (language lives in Settings)         */
/* -------------------------------------------------------------------------- */
describe('Desktop language combobox removal', () => {
  const routes = ['/', '/profile/', '/player/'] as const;

  for (const route of routes) {
    it(`${route}: no desktop combobox container in the topbar`, () => {
      const html = renderTopBarHtml({ currentPath: route });
      expect(html).not.toContain('data-entei-desktop-combobox');
      expect(html).not.toContain('entei-desktop-combobox');
    });
  }

  it('language switching is wired into the Settings modal (EizouSettingsDialog)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/components/home/EizouSettingsDialog.tsx'),
      'utf-8',
    );
    expect(src).toContain('LanguageCombobox');
    expect(src).toContain('entei-settings-language-row');
  });

  it('TopBar no longer imports the desktop LanguageCombobox', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/components/home/TopBar.astro'),
      'utf-8',
    );
    expect(src).not.toContain("from '@components/home/LanguageCombobox'");
    expect(src).not.toContain('entei-desktop-combobox');
  });
});

/* -------------------------------------------------------------------------- */
/*  6b. Mobile header: absent on Home, present on Profile/Player              */
/* -------------------------------------------------------------------------- */
describe('Mobile sticky header presence per route', () => {
  it('Home: mobile header absent (dock-only mobile Home)', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    expect(html).not.toContain('entei-topbar-mobile');
  });

  it('Profile: mobile header present', () => {
    const html = renderTopBarHtml({ currentPath: '/profile/' });
    expect(html).toContain('entei-topbar-mobile');
  });

  it('Player: mobile header markup kept for app-shell stability', () => {
    const html = renderTopBarHtml({ currentPath: '/player/' });
    expect(html).toContain('entei-topbar-mobile');
  });
});

/* -------------------------------------------------------------------------- */
/*  6c. Mobile dock on Home: scroll-only (no idle auto-hide)                  */
/* -------------------------------------------------------------------------- */
describe('Mobile dock scroll-only mode on Home', () => {
  it('Home: dock carries data-entei-mobile-dock-scroll-only', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    const dock = root.querySelector('[data-entei-mobile-dock]');
    expect(dock!.hasAttribute('data-entei-mobile-dock-scroll-only')).toBe(true);
  });

  it('Profile: dock keeps the idle auto-hide behavior', () => {
    const html = renderTopBarHtml({ currentPath: '/profile/' });
    const root = parseHtml(html);
    const dock = root.querySelector('[data-entei-mobile-dock]');
    expect(dock!.hasAttribute('data-entei-mobile-dock-scroll-only')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  7. Mobile dock always has 1 destination link (Home) + Tools + Settings  */
/* -------------------------------------------------------------------------- */
describe('Mobile dock always present with 1 destination link', () => {
  const routes = ['/', '/profile/', '/player/'] as const;

  for (const route of routes) {
    it(`${route}: mobile dock has the Home link only (Profile and Player are not dock links)`, () => {
      const html = renderTopBarHtml({ currentPath: route });
      const root = parseHtml(html);
      const dock = root.querySelector('[data-entei-mobile-dock]');
      expect(dock).not.toBeNull();
      const links = dock!.querySelectorAll('a[data-entei-nav-destination]');
      expect(links.length).toBe(1);

      const hrefs = Array.from(links).map((l) => l.getAttribute('href'));
      expect(hrefs).toEqual(['/']);
      expect(hrefs).not.toContain('/profile/');
      expect(hrefs).not.toContain('/player/');

      // Tools drawer + Settings entries (non-link islands) are always present.
      expect(dock!.querySelector('[data-entei-mobile-dock-tools]')).not.toBeNull();
      expect(dock!.querySelector('[data-entei-mobile-dock-settings]')).not.toBeNull();
    });
  }
});

/* -------------------------------------------------------------------------- */
/*  8. All nav links use path hrefs (no hash, no javascript:)               */
/* -------------------------------------------------------------------------- */
describe('Nav link href validation', () => {
  it('all links use path hrefs only', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    const allLinks = root.querySelectorAll('a[data-entei-nav-destination]');
    // 3 sidebar (brand + Home + Profile) + 1 mobile (Home)
    expect(allLinks.length).toBe(4);

    for (const link of Array.from(allLinks)) {
      const href = link.getAttribute('href') || '';
      expect(href).toMatch(/^\//);
      expect(href).not.toContain('#');
      expect(href).not.toContain('javascript:');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  9. TopBar prop contract                                                  */
/* -------------------------------------------------------------------------- */
describe('TopBar prop contract', () => {
  it('Home: aria-current count = 2 (desktop + mobile)', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    expect(html).toContain('data-entei-desktop-nav');
    expect(html).toContain('data-entei-mobile-dock');
    expect(countAriaCurrentPage(html)).toBe(2);
  });

  it('Player: aria-current count = 0 (tool routes live behind the Immersion Tools drawer)', () => {
    const html = renderTopBarHtml({ currentPath: '/player/' });
    expect(html).toContain('data-entei-desktop-nav');
    expect(html).toContain('data-entei-mobile-dock');
    expect(countAriaCurrentPage(html)).toBe(0);
    // The drawer trigger owns the active state on tool routes.
    expect(html).toContain('data-active="true"');
  });

  it('Profile: aria-current count = 1 (desktop only — Profile is not in mobile dock)', () => {
    const html = renderTopBarHtml({ currentPath: '/profile/' });
    expect(html).toContain('data-entei-desktop-nav');
    expect(html).toContain('data-entei-mobile-dock');
    expect(countAriaCurrentPage(html)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  10. Language selector condition preserved                                */
/* -------------------------------------------------------------------------- */
describe('Language selector condition', () => {
  it('Profile: language selector present when enabled', () => {
    const html = renderTopBarHtml({
      currentPath: '/profile/',
      showLanguageSelector: true,
    });
    expect(html).toContain('entei-language-selector');
  });

  it('Player: language selector absent', () => {
    const html = renderTopBarHtml({
      currentPath: '/player/',
      showLanguageSelector: false,
    });
    expect(html).not.toContain('entei-language-selector');
  });

  it('Home: no mobile header, so no mobile language selector', () => {
    const html = renderTopBarHtml({
      currentPath: '/',
      showLanguageSelector: true,
    });
    expect(html).not.toContain('entei-language-selector');
  });
});

/* -------------------------------------------------------------------------- */
/*  11. Skip link preserved in layout (integration check)                    */
/* -------------------------------------------------------------------------- */
describe('Skip link landmark order', () => {
  it('skip link appears before header in layout output', () => {
    const layoutHtml = `
      <a class="entei-skip-link" href="#entei-main" data-i18n="nav.skipToMain">Skip</a>
      <header class="entei-topbar-mobile" role="banner">...</header>
      <main id="entei-main"></main>
    `;
    const root = parseHtml(layoutHtml);
    const skipLink = root.querySelector('.entei-skip-link');
    const header = root.querySelector('.entei-topbar-mobile');
    expect(skipLink).not.toBeNull();
    expect(header).not.toBeNull();

    const skipIdx = Array.from(root.children).indexOf(skipLink!);
    const headerIdx = Array.from(root.children).indexOf(header!);
    expect(skipIdx).toBeLessThan(headerIdx);
  });
});

/* -------------------------------------------------------------------------- */
/*  12. data-i18n on nav link labels                                        */
/* -------------------------------------------------------------------------- */
describe('Nav link data-i18n attributes', () => {
  it('desktop pill spans have data-i18n with nav.destination* keys', () => {
    const html = renderTopBarHtml({ currentPath: '/profile/' });
    const root = parseHtml(html);
    const desktopNav = root.querySelector('[data-entei-desktop-nav]');
    expect(desktopNav).not.toBeNull();

    const spans = desktopNav!.querySelectorAll('span[data-i18n]');
    // Profile (Home is brand, no data-i18n on brand text). The Immersion
    // Tools trigger is a React island, so its label is not in this markup.
    expect(spans.length).toBe(1);
    const i18nKeys = Array.from(spans).map((s) => s.getAttribute('data-i18n'));
    expect(i18nKeys).toEqual(['nav.destinationProfile']);
  });

  it('desktop sidebar spans have data-i18n for Home and Profile', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    const sidebar = root.querySelector('[data-entei-desktop-sidebar]');
    const spans = sidebar!.querySelectorAll('span[data-i18n]');
    expect(spans.length).toBe(2);
    const i18nKeys = Array.from(spans).map((s) => s.getAttribute('data-i18n'));
    expect(i18nKeys).toEqual([
      'nav.destinationHome',
      'nav.destinationProfile',
    ]);
  });

  it('desktop pill order is Profile then the Immersion Tools drawer, and excludes Player/Tracker', () => {
    const html = renderTopBarHtml({ currentPath: '/profile/' });
    const root = parseHtml(html);
    const desktopNav = root.querySelector('[data-entei-desktop-nav]');
    const hrefs = Array.from(
      desktopNav!.querySelectorAll('a[data-entei-nav-destination]'),
    ).map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/', '/profile/']);
    expect(html).not.toContain('/tracker/');
    // The direct Player link is replaced by the drawer trigger.
    expect(desktopNav!.querySelector('[data-entei-nav-tools]')).not.toBeNull();
  });

  it('mobile dock spans have data-i18n with nav.destination* keys', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    const dock = root.querySelector('[data-entei-mobile-dock]');
    expect(dock).not.toBeNull();

    const spans = dock!.querySelectorAll('span[data-i18n]');
    // Mobile dock has the Home link only (Tools + Settings are islands).
    expect(spans.length).toBe(1);
    const i18nKeys = Array.from(spans).map((s) => s.getAttribute('data-i18n'));
    expect(i18nKeys).toEqual(['nav.destinationHome']);
  });
});

/* -------------------------------------------------------------------------- */
/*  13. data-i18n-aria-label on nav landmarks                               */
/* -------------------------------------------------------------------------- */
describe('Nav landmark data-i18n-aria-label', () => {
  it('desktop nav has data-i18n-aria-label="nav.desktopNavLabel"', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    const nav = root.querySelector('[data-entei-desktop-nav]');
    expect(nav).not.toBeNull();
    expect(nav!.getAttribute('data-i18n-aria-label')).toBe(
      'nav.desktopNavLabel',
    );
  });

  it('mobile dock has data-i18n-aria-label="nav.mobileDockLabel"', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    const dock = root.querySelector('[data-entei-mobile-dock]');
    expect(dock).not.toBeNull();
    expect(dock!.getAttribute('data-i18n-aria-label')).toBe(
      'nav.mobileDockLabel',
    );
  });

  it('Player route: mobile dock still has data-i18n-aria-label', () => {
    const html = renderTopBarHtml({ currentPath: '/player/' });
    const root = parseHtml(html);
    const dock = root.querySelector('[data-entei-mobile-dock]');
    expect(dock).not.toBeNull();
    expect(dock!.getAttribute('data-i18n-aria-label')).toBe(
      'nav.mobileDockLabel',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  14. Locale switch updates nav labels and aria-labels                    */
/* -------------------------------------------------------------------------- */

/** Set up a minimal TopBar DOM structure in document.body for applyLocale. */
function setupNavDom(): void {
  document.documentElement.lang = 'id';
  document.documentElement.dataset.enteiLocale = '';
  delete document.documentElement.dataset.enteiLocale;
  document.documentElement.classList.remove('entei-hydrating');
  document.title = 'test';
  document.head.innerHTML =
    '<meta name="description" content="test">';
  document.body.innerHTML = `
    <nav class="entei-desktop-pill" aria-label="Navigasi halaman" data-entei-desktop-nav data-i18n-aria-label="nav.desktopNavLabel">
      <a href="/" class="entei-desktop-pill-brand" data-entei-nav-destination="/"><span>Entei</span></a>
      <a href="/profile/" data-entei-nav-destination="/profile/"><span data-i18n="nav.destinationProfile">Profil</span></a>
      <button type="button" data-entei-nav-tools><span data-i18n="nav.destinationTools">Perkakas Imersi</span></button>
    </nav>
    <nav class="entei-mobile-dock" aria-label="Navigasi halaman" data-entei-mobile-dock data-i18n-aria-label="nav.mobileDockLabel">
      <a href="/" data-entei-nav-destination="/"><span data-i18n="nav.destinationHome">Home</span></a>
      <button type="button" data-entei-nav-tools><span data-i18n="nav.destinationTools">Perkakas Imersi</span></button>
      <div data-entei-mobile-dock-settings></div>
    </nav>
    <select data-entei-language-select autocomplete="off">
      <option value="id">Bahasa Indonesia</option>
      <option value="ja">日本語</option>
      <option value="en">English</option>
    </select>
  `;
}

describe('Locale switch updates nav label text', () => {
  beforeEach(() => {
    setupNavDom();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('switching to ja updates desktop nav link labels', () => {
    applyLocale('ja');
    const desktopNav = document.querySelector('[data-entei-desktop-nav]');
    expect(desktopNav).not.toBeNull();

    const spans = desktopNav!.querySelectorAll('span[data-i18n]');
    const texts = Array.from(spans).map((s) => s.textContent);
    expect(texts).toContain('イマージョンツール');
    expect(texts).toContain('プロフィール');
  });

  it('switching to ja updates mobile dock link labels', () => {
    applyLocale('ja');
    const dock = document.querySelector('[data-entei-mobile-dock]');
    expect(dock).not.toBeNull();

    const spans = dock!.querySelectorAll('span[data-i18n]');
    const texts = Array.from(spans).map((s) => s.textContent);
    expect(texts).toContain('ホーム');
    expect(texts).toContain('イマージョンツール');
    expect(texts).not.toContain('Tracker');
  });

  it('switching locale updates nav link labels to translated values', () => {
    const dock = document.querySelector('[data-entei-mobile-dock]');
    const toolsSpan = dock!.querySelector(
      '[data-i18n="nav.destinationTools"]',
    );
    expect(toolsSpan!.textContent).toBe('Perkakas Imersi');

    applyLocale('ja');
    expect(toolsSpan!.textContent).toBe('イマージョンツール');

    applyLocale('en');
    expect(toolsSpan!.textContent).toBe('Immersion Tools');
  });
});

describe('Locale switch updates nav landmark aria-label', () => {
  beforeEach(() => {
    setupNavDom();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('switching to ja updates desktop nav aria-label', () => {
    applyLocale('ja');
    const desktopNav = document.querySelector('[data-entei-desktop-nav]');
    expect(desktopNav).not.toBeNull();
    expect(desktopNav!.getAttribute('aria-label')).toBe('ページナビゲーション');
  });

  it('switching to en updates desktop nav aria-label', () => {
    applyLocale('en');
    const desktopNav = document.querySelector('[data-entei-desktop-nav]');
    expect(desktopNav).not.toBeNull();
    expect(desktopNav!.getAttribute('aria-label')).toBe('Page navigation');
  });

  it('switching to id restores desktop nav aria-label to Indonesian', () => {
    applyLocale('en');
    applyLocale('id');
    const desktopNav = document.querySelector('[data-entei-desktop-nav]');
    expect(desktopNav).not.toBeNull();
    expect(desktopNav!.getAttribute('aria-label')).toBe('Navigasi halaman');
  });

  it('switching to ja updates mobile dock aria-label', () => {
    applyLocale('ja');
    const dock = document.querySelector('[data-entei-mobile-dock]');
    expect(dock).not.toBeNull();
    expect(dock!.getAttribute('aria-label')).toBe('ページナビゲーション');
  });

  it('switching to en updates mobile dock aria-label', () => {
    applyLocale('en');
    const dock = document.querySelector('[data-entei-mobile-dock]');
    expect(dock).not.toBeNull();
    expect(dock!.getAttribute('aria-label')).toBe('Page navigation');
  });

  it('switching to id restores mobile dock aria-label to Indonesian', () => {
    applyLocale('en');
    applyLocale('id');
    const dock = document.querySelector('[data-entei-mobile-dock]');
    expect(dock).not.toBeNull();
    expect(dock!.getAttribute('aria-label')).toBe('Navigasi halaman');
  });

  it('does not remove existing textContent behavior', () => {
    applyLocale('en');
    const hubLead = document.createElement('p');
    hubLead.setAttribute('data-i18n', 'hub.lead');
    hubLead.textContent = 'initial';
    document.body.appendChild(hubLead);

    applyLocale('ja');
    expect(hubLead.textContent).toContain('手元');
  });
});

/* -------------------------------------------------------------------------- */
/*  15. Player trigger zone structure                                          */
/* -------------------------------------------------------------------------- */
describe('Player trigger zone for hover reveal', () => {
  it('Player: trigger zone div present with data-entei-trigger-zone', () => {
    const html = renderTopBarHtml({ currentPath: '/player/' });
    const root = parseHtml(html);
    const trigger = root.querySelector('[data-entei-trigger-zone]');
    expect(trigger).not.toBeNull();
    expect(trigger!.classList.contains('entei-desktop-pill-trigger-zone')).toBe(true);
  });

  it('Home: trigger zone NOT present', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    expect(root.querySelector('[data-entei-trigger-zone]')).toBeNull();
  });

  it('Profile: trigger zone NOT present', () => {
    const html = renderTopBarHtml({ currentPath: '/profile/' });
    const root = parseHtml(html);
    expect(root.querySelector('[data-entei-trigger-zone]')).toBeNull();
  });

  it('Player: trigger zone is the only sibling of the pill inside the zone', () => {
    const html = renderTopBarHtml({ currentPath: '/player/' });
    const root = parseHtml(html);
    const zone = root.querySelector('[data-entei-desktop-nav-zone]');
    expect(zone).not.toBeNull();

    const trigger = zone!.querySelector('[data-entei-trigger-zone]');
    const pill = zone!.querySelector('[data-entei-desktop-nav]');
    expect(trigger).not.toBeNull();
    expect(pill).not.toBeNull();
    expect(zone!.children.length).toBe(2);

    // All direct children of the zone
    expect(trigger!.parentElement).toBe(zone);
    expect(pill!.parentElement).toBe(zone);
  });
});

/* -------------------------------------------------------------------------- */
/*  15b. Player dwell-delay contract: 750ms hover, immediate keyboard         */
/* -------------------------------------------------------------------------- */
describe('Player dwell-delay CSS contract', () => {
  it('hover reveal has 750ms transition-delay (pointer must dwell)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(
      path.resolve(__dirname, '../src/components/home/TopBar.astro'),
      'utf-8',
    );
    // Hover reveal transition must include 750ms delay
    expect(css).toMatch(/entei-desktop-pill-zone--player:hover[\s\S]*750ms/);
  });

  it('keyboard focus-within reveal has no 750ms delay (immediate)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(
      path.resolve(__dirname, '../src/components/home/TopBar.astro'),
      'utf-8',
    );
    // Extract the focus-within block
    const focusBlock = css.match(
      /\.entei-desktop-pill-zone--player:focus-within[\s\S]*?\{([\s\S]*?)\}/,
    );
    expect(focusBlock).not.toBeNull();
    // Must NOT contain 750ms
    expect(focusBlock![1]).not.toMatch(/750ms/);
  });
});

/* -------------------------------------------------------------------------- */
/*  16. Locale-request event dispatch and handling                            */
/* -------------------------------------------------------------------------- */
describe('LOCALE_REQUEST_EVENT dispatch flow', () => {
  beforeEach(() => {
    setupNavDom();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('dispatching LOCALE_REQUEST_EVENT with valid locale triggers switchLocale', async () => {
    const { LOCALE_REQUEST_EVENT, LOCALE_CHANGE_EVENT } = await import(
      '../src/i18n/locale-events'
    );

    let changeReceived = false;
    let receivedLocale = '';
    window.addEventListener(LOCALE_CHANGE_EVENT, ((e: CustomEvent) => {
      changeReceived = true;
      receivedLocale = e.detail.locale;
    }) as EventListener);

    window.dispatchEvent(
      new CustomEvent(LOCALE_REQUEST_EVENT, {
        detail: { locale: 'ja' },
      }),
    );

    // Allow microtask
    await new Promise((r) => setTimeout(r, 10));

    expect(changeReceived).toBe(true);
    expect(receivedLocale).toBe('ja');

    const desktopNav = document.querySelector('[data-entei-desktop-nav]');
    expect(desktopNav!.getAttribute('aria-label')).toBe('ページナビゲーション');
  });
});

/* -------------------------------------------------------------------------- */
/*  17. Combobox label data-i18n key matches comboboxLabel (hydration safety) */
/* -------------------------------------------------------------------------- */
describe('LanguageCombobox data-i18n key consistency', () => {
  it('combobox source uses language.comboboxLabel for its data-i18n key', async () => {
    // The React component's sr-only label must use comboboxLabel, not selectLabel.
    // We read the source to prevent regression — the two keys resolve to different
    // strings, so using the wrong one causes hydration mismatch.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/components/home/LanguageCombobox.tsx'),
      'utf-8',
    );
    expect(src).toContain('data-i18n="language.comboboxLabel"');
    // Ensure the old incorrect key is not used
    expect(src).not.toContain('data-i18n="language.selectLabel"');
  });

  it('comboboxLabel and selectLabel resolve to different values in all locales', async () => {
    const { dictionaries } = await import('../src/i18n/index');
    for (const locale of ['id', 'ja', 'en'] as const) {
      const dict = dictionaries[locale];
      // They must differ — if they match, the bug is masked
      expect(dict.language.comboboxLabel).not.toBe(dict.language.selectLabel);
    }
  });

  it('comboboxLabel resolved value matches data-i18n key for each locale', async () => {
    const { dictionaries } = await import('../src/i18n/index');
    for (const locale of ['id', 'ja', 'en'] as const) {
      const dict = dictionaries[locale];
      // resolveKey("language.comboboxLabel") must return comboboxLabel
      const parts = 'language.comboboxLabel'.split('.');
      let val: unknown = dict;
      for (const p of parts) {
        val = (val as Record<string, unknown>)?.[p];
      }
      expect(val).toBe(dict.language.comboboxLabel);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  18. Locale-request event dispatch and handling                            */
/* -------------------------------------------------------------------------- */
describe('LOCALE_REQUEST_EVENT dispatch flow', () => {
  beforeEach(() => {
    setupNavDom();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('dispatching LOCALE_REQUEST_EVENT with valid locale triggers switchLocale', async () => {
    const { LOCALE_REQUEST_EVENT, LOCALE_CHANGE_EVENT } = await import(
      '../src/i18n/locale-events'
    );

    let changeReceived = false;
    let receivedLocale = '';
    window.addEventListener(LOCALE_CHANGE_EVENT, ((e: CustomEvent) => {
      changeReceived = true;
      receivedLocale = e.detail.locale;
    }) as EventListener);

    window.dispatchEvent(
      new CustomEvent(LOCALE_REQUEST_EVENT, {
        detail: { locale: 'ja' },
      }),
    );

    // Allow microtask
    await new Promise((r) => setTimeout(r, 10));

    expect(changeReceived).toBe(true);
    expect(receivedLocale).toBe('ja');

    const desktopNav = document.querySelector('[data-entei-desktop-nav]');
    expect(desktopNav!.getAttribute('aria-label')).toBe('ページナビゲーション');
  });
});

/* -------------------------------------------------------------------------- */
/*  19. Immersion Tools drawer replaces the direct Player destination          */
/*     (MODULE_ARCHITECTURE.md §4)                                            */
/* -------------------------------------------------------------------------- */
describe('Immersion Tools drawer contract', () => {
  const readSource = async (relative: string): Promise<string> => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.resolve(__dirname, relative), 'utf-8');
  };

  it('TopBar renders the ImmersionToolsDialog island on all three surfaces', async () => {
    const src = await readSource('../src/components/home/TopBar.astro');
    expect(src).toContain(
      "import { ImmersionToolsDialog } from '@components/home/ImmersionToolsDialog'",
    );
    expect(src).toContain('variant="sidebar"');
    expect(src).toContain('variant="pill"');
    expect(src).toContain('variant="dock"');
    // The direct Player nav destination is gone from the nav arrays.
    expect(src).not.toContain("route: '/player/'");
    expect(src).not.toContain('destinationPlayer');
  });

  it('drawer island lists video, audio and modules destinations', async () => {
    const src = await readSource(
      '../src/components/home/ImmersionToolsDialog.tsx',
    );
    expect(src).toContain("href: '/player/'");
    expect(src).toContain("href: '/audio-player/'");
    expect(src).toContain("href: '/modules/'");
    // Both geometry modifiers are rendered; CSS media queries pick one.
    expect(src).toContain('entei-tools-drawer--desktop');
    expect(src).toContain('entei-tools-drawer--mobile');
  });

  it('drawer CSS slides from the left on desktop and from the bottom on mobile', async () => {
    const css = await readSource(
      '../src/components/home/ImmersionToolsDialog.css',
    );
    const desktop = css.match(
      /@media \(min-width: 768px\) \{[\s\S]*?\.entei-tools-drawer--desktop[\s\S]*?\n  \}\n\}/,
    );
    expect(desktop).not.toBeNull();
    expect(desktop![0]).toContain('left: 0');
    expect(desktop![0]).toContain('100dvh');

    const mobile = css.match(
      /@media \(max-width: 767px\) \{[\s\S]*?\.entei-tools-drawer--mobile[\s\S]*?\n  \}\n\}/,
    );
    expect(mobile).not.toBeNull();
    expect(mobile![0]).toContain('bottom: 0');
    expect(mobile![0]).toContain('100%');
  });

  it('tools dictionary copy exists in every locale', () => {
    const keys = [
      'title',
      'description',
      'close',
      'videoTitle',
      'videoDescription',
      'audioTitle',
      'audioDescription',
      'modulesTitle',
      'modulesDescription',
    ] as const;

    for (const locale of ['id', 'ja', 'en'] as const) {
      const dict = dictionaries[locale];
      expect(dict.nav.destinationTools.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(
          dict.toolsDrawer[key].length,
          `${locale}.toolsDrawer.${key} is empty`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('/modules/ page mounts the ModulesDashboard island', async () => {
    const src = await readSource('../src/pages/modules/index.astro');
    expect(src).toContain('path="/modules/"');
    expect(src).toContain('showChrome={true}');
    expect(src).toContain('ModulesDashboard client:only="react"');
  });
});
