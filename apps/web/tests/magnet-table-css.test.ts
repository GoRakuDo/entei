/**
 * Static CSS-contract tests for the magnet dialog's file list and shell.
 * ---------------------------------------------------------------------------
 * The ED-2G dialog was redesigned to the mockup: a joined magnet input group,
 * a breadcrumb strip, plain file/folder rows (no <table>) and a Cancel |
 * Stream Now action pair. These tests read player.css as text and pin the
 * layout contract that the component relies on:
 *
 *  - the file list is the bounded scroll container (desktop 20rem cap),
 *  - the breadcrumb stays on one line (horizontal scroll, never wrap),
 *  - on mobile the form scrolls inside the 100dvh sheet so the actions stay
 *    reachable,
 *  - the old table shell is gone (no dead selectors left behind),
 *  - every colour in the magnet section is an OKLCH value or an Entei token
 *    (project rule: no HEX/RGB/HSL/named colours).
 *
 * Pixel layout itself is verified in the browser; these tests only pin the
 * selector/declaration contract.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// `bun test` runs from the web workspace root (apps/web), so the stylesheets
// live under src/styles/. Avoid import.meta.url — Bun's transform can
// rewrite it to a non-file scheme in the jsdom environment.
const css = readFileSync(resolve(process.cwd(), 'src/styles/player.css'), 'utf8');
const globalCss = readFileSync(
  resolve(process.cwd(), 'src/styles/global.css'),
  'utf8',
);

/**
 * Returns the declaration text of the first rule block for `selector`.
 *
 * Deliberately naive parser: it reads from the first `{` after the selector
 * to the very next `}`. That holds for every magnet block (plain declarations
 * only, no nested @-rule).
 */
function ruleBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `rule block for ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/** Returns the declaration text of every `@media (max-width: 767px)` block. */
function mobileBlocks(): string[] {
  const out: string[] = [];
  const needle = '@media (max-width: 767px) {';
  let from = 0;
  for (;;) {
    const start = css.indexOf(needle, from);
    if (start < 0) break;
    const open = css.indexOf('{', start);
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const close = i - 1;
    out.push(css.slice(open + 1, close));
    from = close + 1;
  }
  return out;
}

/** Text of the magnet shell section (from its banner to the YouTube section). */
function magnetSection(): string {
  const start = css.indexOf('/* --- ED-2G magnet source dialog');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('/* --- ED-2F YouTube source dialog --- */', start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

describe('Magnet dialog CSS contract (mockup shell)', () => {
  it('keeps the file list as the bounded desktop scroll container', () => {
    const b = ruleBlock('.entei-magnet-list');
    expect(b).toContain('max-height: 20rem');
    expect(b).toContain('overflow-y: auto');
  });

  it('renders rows as flex items with a touch-sized hit area', () => {
    const b = ruleBlock('.entei-magnet-item');
    expect(b).toContain('min-height: var(--entei-touch-min)');
    expect(b).toContain('display: flex');
  });

  it('keeps the breadcrumb on one line (horizontal scroll, no wrap)', () => {
    const b = ruleBlock('.entei-magnet-breadcrumb');
    expect(b).toContain('overflow-x: auto');
    expect(b).not.toContain('flex-wrap');
    const crumb = ruleBlock('.entei-magnet-crumb');
    expect(crumb).toContain('text-overflow: ellipsis');
    expect(crumb).toContain('white-space: nowrap');
  });

  it('joins the magnet input and the create button into one group', () => {
    const group = ruleBlock('.entei-magnet-input-row');
    expect(group).toContain('border-radius: var(--entei-radius-md)');
    expect(group).toContain('overflow: hidden');
    const input = ruleBlock('.entei-magnet-input-row .entei-magnet-input');
    expect(input).toContain('background-color: transparent');
    expect(input).toContain('border: none');
    // The inset focus ring lives on the focus-visible rule of the group.
    const focus = /(\.entei-magnet-input-row [^{]*:focus-visible[^{]*)\{([^}]*)\}/.exec(
      magnetSection(),
    );
    expect(focus).not.toBeNull();
    expect(focus![1]).toContain('.entei-magnet-input-row .entei-magnet-input:focus-visible');
    expect(focus![2]).toContain('outline-offset: -2px');
  });

  it('joins Cancel | Stream Now with a single divider on desktop', () => {
    const section = magnetSection();
    const desktop = section.slice(section.indexOf('@media (min-width: 768px) {'));
    expect(desktop).toContain('.entei-magnet-actions > .entei-magnet-cancel');
    expect(desktop).toContain('.entei-magnet-actions > .entei-magnet-select-play');
    expect(desktop).toContain('flex-direction: row-reverse');
    // Only the Stream Now side draws the seam.
    const cancel = ruleBlock('.entei-magnet-actions > .entei-magnet-cancel');
    expect(cancel).toContain('border-right-width: 0');
    // Both buttons hold a fixed rail: the Cancel label also swaps to the
    // typewriter loading text while `settling`, so it needs the same
    // no-layout-shift guarantee (DESIGN.md 8.1).
    expect(cancel).toContain('width: 7rem');
    expect(cancel).not.toContain('min-width');
  });

  it('locks the desktop Stream Now width so the loading label cannot shrink it', () => {
    // The label swaps to the typewriter loading text while submitting; a
    // content-sized button would animate its own shrink. Fixed `width` keeps
    // the button (and its Cancel neighbour) pixel-stable.
    const section = magnetSection();
    const desktop = section.slice(section.indexOf('@media (min-width: 768px) {'));
    const play = /(\.entei-magnet-actions > \.entei-magnet-select-play)\s*\{([^}]*)\}/.exec(
      desktop,
    );
    expect(play).not.toBeNull();
    expect(play![2]).toContain('width: 12rem');
    expect(play![2]).not.toContain('min-width');
  });

  it('stacks the actions vertically on mobile', () => {
    const magnetMobile = mobileBlocks().filter((b) => b.includes('.entei-magnet-actions'));
    expect(magnetMobile.length).toBeGreaterThan(0);
    const combined = magnetMobile.join('\n');
    expect(combined).toContain('flex-direction: column');
    expect(combined).toContain('min-height: var(--entei-touch-min)');
  });

  it('lets the form scroll inside the mobile 100dvh sheet', () => {
    const formBlocks = mobileBlocks().filter((b) =>
      b.includes('.entei-magnet-dialog .entei-magnet-form'),
    );
    expect(formBlocks.length).toBeGreaterThan(0);
    const combined = formBlocks.join('\n');
    expect(combined).toContain('flex: 1');
    expect(combined).toContain('min-height: 0');
    expect(combined).toContain('overflow-y: auto');
  });

  it('leaves no dead table shell behind', () => {
    expect(css).not.toContain('.entei-magnet-table');
    expect(css).not.toContain('.entei-magnet-shell');
    expect(css).not.toContain('.entei-magnet-browser-bottom');
    expect(css).not.toContain('.entei-magnet-folder-btn');
    // Idle dialog is a pure input shell: the empty-state body copy and the
    // tracker consent paragraph moved to the app ToS, so their selectors are
    // dead too.
    expect(css).not.toContain('.entei-magnet-empty-body');
    expect(css).not.toContain('.entei-magnet-consent-text');
  });

  it('uses only OKLCH colours and Entei tokens in the magnet section', () => {
    const section = magnetSection().replace(/\/\*[\s\S]*?\*\//g, '');
    const colourValues = [
      ...section.matchAll(/(?:^|[\s:(,])(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/gm),
    ];
    expect(colourValues).toHaveLength(0);
  });

  it('pins the single global checked-state colour contract on the checkbox root', () => {
    const start = globalCss.indexOf("[data-slot='checkbox'][data-state='checked']");
    expect(start).toBeGreaterThanOrEqual(0);
    const open = globalCss.indexOf('{', start);
    const contract = globalCss.slice(open + 1, globalCss.indexOf('}', open));
    expect(contract).toContain('background-color: var(--entei-btn-color)');
    expect(contract).toContain('color: var(--entei-status-locked)');
  });

  it('gives the create button its shared fill at rest, not only on hover', () => {
    const base = ruleBlock('.entei-magnet-add-btn');
    expect(base).toContain('background-color: var(--entei-btn-color)');
    expect(base).toContain('color: var(--entei-status-locked)');
    // Hover only lifts the same fill (no colour swap, no transparent flash).
    const hover = ruleBlock('.entei-magnet-add-btn:hover:not(:disabled)');
    expect(hover).toContain('filter: brightness(1.12)');
    expect(hover).not.toContain('background-color: transparent');
  });

  it('lets the list own the breadcrumb spacing (no negative-margin hack)', () => {
    // The trail is the list's first child, so the list's own column flex/gap
    // is the only spacing between it and the first row.
    const crumb = ruleBlock('.entei-magnet-breadcrumb');
    expect(crumb).not.toContain('margin-bottom');
    expect(crumb).not.toContain('margin-top');
    const list = ruleBlock('.entei-magnet-list');
    expect(list).toContain('display: flex');
    expect(list).toContain('flex-direction: column');
    expect(list).toContain('gap: var(--entei-space-4)');
  });

  it('spaces the breadcrumb trail and its separators at 8px', () => {
    // 4px between a › glyph and the folder name read as cramped; both the
    // trail gap and the separator gap are now one --entei-space-8 step.
    expect(ruleBlock('.entei-magnet-breadcrumb')).toContain(
      'gap: var(--entei-space-8)',
    );
    expect(ruleBlock('.entei-magnet-crumb-slot')).toContain(
      'gap: var(--entei-space-8)',
    );
  });

  it('needs no stacking hack: the trail no longer overlaps the rows', () => {
    // The trail used to be pulled over the first row with a negative margin,
    // which forced position: relative + z-index. Inside the list it is a plain
    // flex item, so both declarations are gone.
    const crumb = ruleBlock('.entei-magnet-breadcrumb');
    expect(crumb).not.toContain('z-index');
    expect(crumb).not.toContain('position: relative');
  });

  it('seats the row checkbox inside the row padding (no negative-margin hack)', () => {
    // The box used to be pulled out of the row with a negative right margin,
    // which pushed it outside the hover/selected fill. It is now a plain flex
    // child: no negative margins, so the row's 8px padding is the only inset
    // and the fill wraps icon + box evenly.
    const check = ruleBlock('.entei-magnet-item-check');
    expect(check).not.toContain('margin');
    expect(check).toContain('flex-shrink: 0');
    expect(check).toContain('align-self: center');
    // The row owns the gutter on both sides.
    const row = ruleBlock('.entei-magnet-item');
    expect(row).toContain('padding: var(--entei-space-8)');
  });

  it('seats the leading row icon in a centred square box', () => {
    const icon = ruleBlock('.entei-magnet-item-icon');
    expect(icon).toContain('align-items: center');
    expect(icon).toContain('justify-content: center');
    expect(icon).toContain('width: var(--entei-space-20)');
    expect(icon).toContain('height: var(--entei-space-20)');
    // Same gutter left and right of the icon: row padding === row gap.
    expect(ruleBlock('.entei-magnet-item')).toContain(
      'gap: var(--entei-space-8)',
    );
  });

  it('renders folder/file names and the current crumb in secondary text', () => {
    expect(ruleBlock('.entei-magnet-crumb')).toContain(
      'color: var(--entei-text-secondary)',
    );
    expect(ruleBlock('.entei-magnet-crumb--current')).toContain(
      'color: var(--entei-text-secondary)',
    );
    expect(ruleBlock('.entei-magnet-item-name')).toContain(
      'color: var(--entei-text-secondary)',
    );
  });

  it('keeps the row checkbox visible, centred and on the shared checked palette', () => {
    const check = ruleBlock('.entei-magnet-item-check');
    expect(check).toContain('border-color: oklch(100% 0 0deg / 0.3)');
    expect(check).toContain('align-self: center');
    const checked = ruleBlock(
      ".entei-magnet-item-check[data-state='checked'],\n.entei-magnet-item-check[data-state='indeterminate']",
    );
    expect(checked).toContain('border-color: var(--entei-btn-color)');
    expect(checked).toContain('background-color: var(--entei-btn-color)');
    expect(checked).toContain('color: var(--entei-status-locked)');
    expect(checked).not.toContain('var(--entei-accent)');
  });

  it('pins the metadata-check skeleton bones and their shimmer', () => {
    const section = magnetSection();
    expect(section).toContain('.entei-magnet-skeleton-crumb');
    expect(section).toContain('.entei-magnet-skeleton-list');
    expect(section).toContain('.entei-magnet-skeleton-row');
    expect(section).toContain('.entei-magnet-skeleton-icon');
    expect(section).toContain('.entei-magnet-skeleton-name');
    // Reuses the player's shared shimmer keyframes instead of a new one.
    expect(section).toContain('animation: entei-skeleton-shimmer 1.6s');
    expect(section).toContain('@media (prefers-reduced-motion: reduce)');
    // The status copy no longer owns the wait state; the bones do.
    const checking = ruleBlock('.entei-magnet-checking');
    expect(checking).toContain('flex-direction: column');
  });
});
