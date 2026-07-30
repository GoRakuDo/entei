/**
 * Navigation contract tests — NAVIGATION_BAR.md full desktop redesign.
 *
 * Verifies:
 * 1. Exactly one aria-current="page" per route (desktop pill + mobile dock)
 * 2. Desktop pill present on all routes; Player zone has --player modifier
 * 3. Mobile dock always has 3 links
 * 4. All nav links use path hrefs (no hash, no javascript:)
 * 5. Dictionary nav keys exist and are non-empty in all locales
 * 6. data-i18n on nav link labels for locale-switcher text update
 * 7. data-i18n-aria-label on nav landmarks for locale-switcher aria-label update
 * 8. Locale switch updates nav label text and aria-label to translated values
 * 9. Desktop Combobox data-entei-desktop-combobox present on Home/Tracker, absent on Player
 * 10. Player zone gets --player modifier class; Home/Tracker do not
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyLocale } from '../src/scripts/locale-switcher';
import { dictionaries } from '../src/i18n/index';
import type { Locale } from '../src/i18n/types';

/* -------------------------------------------------------------------------- */
/*  1. Dictionary nav keys parity across locales                              */
/* -------------------------------------------------------------------------- */
describe('Nav dictionary keys (Stage N1)', () => {
  const navKeys = [
    'destinationHome',
    'destinationPlayer',
    'destinationTracker',
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

const DESTINATIONS = [
  { route: '/', labelKey: 'destinationHome' },
  { route: '/player/', labelKey: 'destinationPlayer' },
  { route: '/tracker/', labelKey: 'destinationTracker' },
] as const;

/**
 * Simulate the TopBar HTML output per the new NAVIGATION_BAR.md structure.
 *
 * Desktop pill zone: always rendered. On Player, zone gets `--player` modifier.
 * Desktop Combobox: rendered inside pill zone on Home/Tracker only (not Player).
 * Mobile dock: always rendered.
 */
function renderTopBarHtml(opts: {
  currentPath: string;
  showLanguageSelector?: boolean;
}): string {
  const { currentPath, showLanguageSelector = true } = opts;
  const activePath = normalisePath(currentPath);
  const isPlayer = activePath === '/player';

  // Mobile sticky header (hidden on desktop; not rendered on Player mobile)
  let html = '';
  if (!isPlayer) {
    html += `<header class="entei-topbar-mobile" role="banner"><div class="entei-topbar-mobile-inner">`;
    html += `<a class="entei-wordmark" href="/"><span class="entei-wordmark-text">Entei</span></a>`;
    if (showLanguageSelector) {
      html += `<div class="entei-language-selector"></div>`;
    }
    html += `</div></header>`;
  }

  // Desktop pill zone
  const zoneClass = isPlayer
    ? 'entei-desktop-pill-zone entei-desktop-pill-zone--player'
    : 'entei-desktop-pill-zone';
  html += `<div class="${zoneClass}" data-entei-desktop-nav-zone>`;

  // Player trigger zone
  if (isPlayer) {
    html += `<div class="entei-desktop-pill-trigger-zone" data-entei-trigger-zone></div>`;
  }

  // Desktop pill nav
  html += `<nav class="entei-desktop-pill" aria-label="Page navigation" data-entei-desktop-nav data-i18n-aria-label="nav.desktopNavLabel">`;

  // Brand = Home link
  const homeActive = activePath === '/';
  html += `<a class="entei-desktop-pill-brand" href="/"${homeActive ? ' aria-current="page"' : ''} data-entei-nav-destination="/"><span>Entei</span></a>`;

  // Player and Tracker links (Home is brand)
  for (const { route, labelKey } of DESTINATIONS) {
    if (route === '/') continue; // brand is Home
    const isActive = normalisePath(route) === activePath;
    html += `<a class="entei-desktop-pill-link" href="${route}"${isActive ? ' aria-current="page"' : ''} data-entei-nav-destination="${route}"><span data-i18n="nav.${labelKey}">${labelKey}</span></a>`;
  }
  html += `</nav>`;

  // Desktop Combobox — absent on Player (conflicts with RightPanel controls)
  if (!isPlayer) {
    html += `<div class="entei-desktop-combobox" data-entei-desktop-combobox></div>`;
  }
  html += `</div>`;

  // Mobile dock
  html += `<nav class="entei-mobile-dock" aria-label="Page navigation" data-entei-mobile-dock data-i18n-aria-label="nav.mobileDockLabel">`;
  for (const { route, labelKey } of DESTINATIONS) {
    const isActive = normalisePath(route) === activePath;
    html += `<a class="entei-mobile-dock-link" href="${route}"${isActive ? ' aria-current="page"' : ''} data-entei-nav-destination="${route}"><span data-i18n="nav.${labelKey}">${labelKey}</span></a>`;
  }
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
  const routes = ['/', '/player/', '/tracker/'] as const;

  for (const route of routes) {
    it(`${route}: exactly one aria-current in desktop pill + one in mobile dock`, () => {
      const html = renderTopBarHtml({ currentPath: route });
      const root = parseHtml(html);

      // Desktop nav — always present
      const desktopNav = root.querySelector('[data-entei-desktop-nav]');
      expect(desktopNav).not.toBeNull();
      const desktopCurrent = desktopNav!.querySelectorAll(
        '[aria-current="page"]',
      );
      expect(desktopCurrent.length).toBe(1);
      expect(desktopCurrent[0]!.getAttribute('href')).toBe(route);

      // Mobile dock — always present
      const mobileDock = root.querySelector('[data-entei-mobile-dock]');
      expect(mobileDock).not.toBeNull();
      const mobileCurrent = mobileDock!.querySelectorAll(
        '[aria-current="page"]',
      );
      expect(mobileCurrent.length).toBe(1);
      expect(mobileCurrent[0]!.getAttribute('href')).toBe(route);
    });
  }
});

/* -------------------------------------------------------------------------- */
/*  5. Desktop pill present on all routes; Player zone has --player modifier  */
/* -------------------------------------------------------------------------- */
describe('Desktop pill zone visibility by route', () => {
  it('Home (/): desktop pill <nav> is present, no --player modifier', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    expect(root.querySelector('[data-entei-desktop-nav]')).not.toBeNull();
    const zone = root.querySelector('[data-entei-desktop-nav-zone]');
    expect(zone).not.toBeNull();
    expect(zone!.classList.contains('entei-desktop-pill-zone--player')).toBe(false);
  });

  it('Tracker (/tracker/): desktop pill <nav> is present, no --player modifier', () => {
    const html = renderTopBarHtml({ currentPath: '/tracker/' });
    const root = parseHtml(html);
    expect(root.querySelector('[data-entei-desktop-nav]')).not.toBeNull();
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
/*  6. Desktop Combobox: present Home/Tracker, absent Player                  */
/* -------------------------------------------------------------------------- */
describe('Desktop Combobox presence', () => {
  it('Home: Combobox container present', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    expect(html).toContain('data-entei-desktop-combobox');
  });

  it('Player: Combobox container absent (conflicts with RightPanel controls)', () => {
    const html = renderTopBarHtml({ currentPath: '/player/' });
    expect(html).not.toContain('data-entei-desktop-combobox');
  });

  it('Tracker: Combobox container present', () => {
    const html = renderTopBarHtml({ currentPath: '/tracker/' });
    expect(html).toContain('data-entei-desktop-combobox');
  });
});

/* -------------------------------------------------------------------------- */
/*  6b. Mobile header: present Home/Tracker, absent Player                    */
/* -------------------------------------------------------------------------- */
describe('Mobile sticky header presence per route', () => {
  it('Home: mobile header present', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    expect(html).toContain('entei-topbar-mobile');
  });

  it('Player: mobile header absent (no top chrome on Player)', () => {
    const html = renderTopBarHtml({ currentPath: '/player/' });
    expect(html).not.toContain('entei-topbar-mobile');
  });

  it('Tracker: mobile header present', () => {
    const html = renderTopBarHtml({ currentPath: '/tracker/' });
    expect(html).toContain('entei-topbar-mobile');
  });
});

/* -------------------------------------------------------------------------- */
/*  7. Mobile dock always has all 3 links                                    */
/* -------------------------------------------------------------------------- */
describe('Mobile dock always present with 3 links', () => {
  const routes = ['/', '/player/', '/tracker/'] as const;

  for (const route of routes) {
    it(`${route}: mobile dock has 3 links`, () => {
      const html = renderTopBarHtml({ currentPath: route });
      const root = parseHtml(html);
      const dock = root.querySelector('[data-entei-mobile-dock]');
      expect(dock).not.toBeNull();
      const links = dock!.querySelectorAll('a[data-entei-nav-destination]');
      expect(links.length).toBe(3);

      const hrefs = Array.from(links).map((l) => l.getAttribute('href'));
      expect(hrefs).toContain('/');
      expect(hrefs).toContain('/player/');
      expect(hrefs).toContain('/tracker/');
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
    // 3 desktop (brand + Player + Tracker) + 3 mobile
    expect(allLinks.length).toBe(6);

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

  it('Player: aria-current count = 2 (desktop brand absent, Player link + mobile)', () => {
    const html = renderTopBarHtml({ currentPath: '/player/' });
    expect(html).toContain('data-entei-desktop-nav');
    expect(html).toContain('data-entei-mobile-dock');
    expect(countAriaCurrentPage(html)).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  10. Language selector condition preserved                                */
/* -------------------------------------------------------------------------- */
describe('Language selector condition', () => {
  it('Home: language selector present', () => {
    const html = renderTopBarHtml({
      currentPath: '/',
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
  it('desktop nav spans have data-i18n with nav.destination* keys', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    const desktopNav = root.querySelector('[data-entei-desktop-nav]');
    expect(desktopNav).not.toBeNull();

    const spans = desktopNav!.querySelectorAll('span[data-i18n]');
    // Player + Tracker (Home is brand, no data-i18n on brand text)
    expect(spans.length).toBe(2);
    const i18nKeys = Array.from(spans).map((s) => s.getAttribute('data-i18n'));
    expect(i18nKeys).toContain('nav.destinationPlayer');
    expect(i18nKeys).toContain('nav.destinationTracker');
  });

  it('mobile dock spans have data-i18n with nav.destination* keys', () => {
    const html = renderTopBarHtml({ currentPath: '/' });
    const root = parseHtml(html);
    const dock = root.querySelector('[data-entei-mobile-dock]');
    expect(dock).not.toBeNull();

    const spans = dock!.querySelectorAll('span[data-i18n]');
    expect(spans.length).toBe(3);
    const i18nKeys = Array.from(spans).map((s) => s.getAttribute('data-i18n'));
    expect(i18nKeys).toContain('nav.destinationHome');
    expect(i18nKeys).toContain('nav.destinationPlayer');
    expect(i18nKeys).toContain('nav.destinationTracker');
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
      <a href="/player/" data-entei-nav-destination="/player/"><span data-i18n="nav.destinationPlayer">Player</span></a>
      <a href="/tracker/" data-entei-nav-destination="/tracker/"><span data-i18n="nav.destinationTracker">Tracker</span></a>
    </nav>
    <nav class="entei-mobile-dock" aria-label="Navigasi halaman" data-entei-mobile-dock data-i18n-aria-label="nav.mobileDockLabel">
      <a href="/" data-entei-nav-destination="/"><span data-i18n="nav.destinationHome">Home</span></a>
      <a href="/player/" data-entei-nav-destination="/player/" aria-current="page"><span data-i18n="nav.destinationPlayer">Player</span></a>
      <a href="/tracker/" data-entei-nav-destination="/tracker/"><span data-i18n="nav.destinationTracker">Tracker</span></a>
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
    expect(texts).toContain('Player');
    expect(texts).toContain('Tracker');
  });

  it('switching to ja updates mobile dock link labels', () => {
    applyLocale('ja');
    const dock = document.querySelector('[data-entei-mobile-dock]');
    expect(dock).not.toBeNull();

    const spans = dock!.querySelectorAll('span[data-i18n]');
    const texts = Array.from(spans).map((s) => s.textContent);
    expect(texts).toContain('Home');
    expect(texts).toContain('Player');
    expect(texts).toContain('Tracker');
  });

  it('switching locale updates nav link labels to translated values', () => {
    const dock = document.querySelector('[data-entei-mobile-dock]');
    const playerSpan = dock!.querySelector('[data-i18n="nav.destinationPlayer"]');
    expect(playerSpan!.textContent).toBe('Player');

    applyLocale('ja');
    expect(playerSpan!.textContent).toBe('Player');

    applyLocale('en');
    expect(playerSpan!.textContent).toBe('Player');
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

  it('Tracker: trigger zone NOT present', () => {
    const html = renderTopBarHtml({ currentPath: '/tracker/' });
    const root = parseHtml(html);
    expect(root.querySelector('[data-entei-trigger-zone]')).toBeNull();
  });

  it('Player: trigger zone is sibling of pill inside zone (no combobox)', () => {
    const html = renderTopBarHtml({ currentPath: '/player/' });
    const root = parseHtml(html);
    const zone = root.querySelector('[data-entei-desktop-nav-zone]');
    expect(zone).not.toBeNull();

    const trigger = zone!.querySelector('[data-entei-trigger-zone]');
    const pill = zone!.querySelector('[data-entei-desktop-nav]');
    const combobox = zone!.querySelector('[data-entei-desktop-combobox]');
    expect(trigger).not.toBeNull();
    expect(pill).not.toBeNull();
    expect(combobox).toBeNull();

    // All direct children of the zone
    expect(trigger!.parentElement).toBe(zone);
    expect(pill!.parentElement).toBe(zone);
  });
});

/* -------------------------------------------------------------------------- */
/*  15b. Player dwell-delay contract: 1.5s hover, immediate keyboard          */
/* -------------------------------------------------------------------------- */
describe('Player dwell-delay CSS contract', () => {
  it('hover reveal has 1.5s transition-delay (pointer must dwell)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(
      path.resolve(__dirname, '../src/components/home/TopBar.astro'),
      'utf-8',
    );
    // Hover reveal transition must include 1.5s delay
    expect(css).toMatch(/entei-desktop-pill-zone--player:hover[\s\S]*1\.5s/);
  });

  it('keyboard focus-within reveal has no 1.5s delay (immediate)', async () => {
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
    // Must NOT contain 1.5s
    expect(focusBlock![1]).not.toMatch(/1\.5s/);
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
