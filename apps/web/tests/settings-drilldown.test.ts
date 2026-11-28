/**
 * Settings mobile drill-down contract (unit, source-level).
 * ---------------------------------------------------------------------------
 * The `/settings/` shell has two layouts driven by ONE state:
 *
 * - Desktop (≥768px): always two panes, so a bare `/settings/` URL must still
 *   paint General in the content pane (`effectiveGroup` fallback).
 * - Mobile (<768px): the bare `/settings/` URL IS the full-screen menu of
 *   groups. Selecting a group drills into its detail pane, and the Modul row
 *   expands its child list inline instead of navigating away.
 *
 * These are the invariants that were broken before (the bare URL used to
 * resolve straight to `general`, so mobile opened General's detail pane and
 * never showed the menu). They are asserted against the shipped source because
 * the behaviour is a pure state/URL mapping with no runtime seam to import.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const readRepoFile = (relative: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf-8');

const appSource = readRepoFile('src/components/settings/SettingsApp.tsx');
const settingsCss = readRepoFile('src/styles/settings.css');

/** Slice a top-level function/const body out of a source file. */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Slice the `@media (max-width: 767px)` block that contains `marker`.
 *  Nested rules are indented, so a `}` at column 0 closes the media block. */
function mobileBlockContaining(source: string, marker: string): string {
  const header = '@media (max-width: 767px) {';
  for (let at = source.indexOf(header); at !== -1; ) {
    const end = source.indexOf('\n}', at);
    expect(end).toBeGreaterThan(at);
    const block = source.slice(at, end);
    if (block.includes(marker)) return block;
    at = source.indexOf(header, at + 1);
  }
  throw new Error(`no mobile block contains ${marker}`);
}

describe('Settings mobile drill-down — selection state', () => {
  it('a bare /settings/ URL is the MENU, not General', () => {
    const body = bodyOf(appSource, 'function readSelectionFromUrl()');
    // No default group: the mobile menu screen is `group: null`.
    expect(body).not.toContain("group: 'general'");
    expect(body).toContain('{ group: null, item: null }');
  });

  it('the mobile menu depth is exactly "no group selected"', () => {
    const body = bodyOf(appSource, 'function isMobileMenu(');
    expect(body).toContain('return selection.group === null;');
  });

  it('desktop resolves a missing group to General at render time', () => {
    // `isMobile ? null : 'general'` — desktop keeps both panes, mobile keeps
    // the menu. A plain `?? 'general'` would re-break the mobile menu.
    expect(appSource).toMatch(
      /selection\.group \?\? \(isMobile \? null : 'general'\)/,
    );
  });

  it('navigating to the menu pushes the parameterless /settings/ URL', () => {
    const body = bodyOf(appSource, 'const navigate = useCallback(');
    expect(body).toContain("query === '' ? '/settings/' : `/settings/?${query}`");
    // No `group` param is written for the menu (it would re-open a detail).
    expect(body).toContain('if (group !== null) {');
  });
});

describe('Settings mobile drill-down — back navigation', () => {
  const back = appSource.slice(appSource.indexOf('function backToMenu()'));

  it('a module settings page backs out to the Modules grid', () => {
    expect(back).toContain("navigate('module', null, { replace: true, fromMenu })");
  });

  it('any group backs out to the top-level menu', () => {
    expect(back).toContain('navigate(null, null, { replace: true })');
  });

  it('returning to the menu does not stack a second menu entry', () => {
    // When the entry below IS the menu, "←" pops instead of pushing — so the
    // menu's own "←" leaves the page instead of re-entering the pane.
    expect(back).toContain('if (fromMenu) {');
    expect(back).toContain('window.history.back()');
  });

  it('the top-level menu backs out of the settings page entirely', () => {
    expect(back).toContain("window.location.href = '/'");
  });
});

describe('Settings mobile drill-down — Modul accordion', () => {
  it('tapping Modul on mobile only expands the inline child list', () => {
    const start = appSource.indexOf('if (isMobile) {');
    expect(start).toBeGreaterThan(-1);
    const branch = appSource.slice(start, start + 400);
    expect(branch).toContain('toggleModuleExpanded();');
    expect(branch).toContain('return;');
  });

  it('the mobile stylesheet keeps the chevron and child list visible', () => {
    // Both used to be `display: none` under the mobile breakpoint, which is
    // what made the Modul row a dead end on phones. The desktop collapsed
    // rail still hides them (a different, scoped rule).
    const mobile = mobileBlockContaining(
      settingsCss,
      ".entei-settings-shell[data-depth='menu']",
    );
    expect(mobile).not.toMatch(
      /\.entei-settings-nav-chevron\s*\{\s*display:\s*none/,
    );
    expect(mobile).not.toMatch(
      /\.entei-settings-nav-children\s*\{\s*display:\s*none/,
    );
  });

  it('menu and detail panes still toggle from data-depth', () => {
    expect(settingsCss).toContain(
      ".entei-settings-shell[data-depth='menu'] .entei-settings-content",
    );
    expect(settingsCss).toContain(
      ".entei-settings-shell[data-depth='detail'] .entei-settings-nav",
    );
  });

  it('mobile menu sets gap to 24px and nav item background to --entei-surface', () => {
    const mobile = mobileBlockContaining(
      settingsCss,
      ".entei-settings-shell[data-depth='menu']",
    );
    expect(mobile).toMatch(
      /\.entei-settings-nav\s*\{[^}]*gap:\s*var\(--entei-space-24\)/,
    );
    expect(mobile).toMatch(
      /\.entei-settings-nav-item\s*\{[^}]*background-color:\s*var\(--entei-surface\)/,
    );
    expect(mobile).toMatch(
      /\.entei-settings-shell\[data-depth='menu'\]\s*\.entei-settings-nav-item\[aria-current='page'\]\s*\{[^}]*background-color:\s*var\(--entei-surface\)/,
    );
  });
});
