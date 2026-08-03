/**
 * Static CSS-contract tests for the magnet file table's bounded scroll.
 * ---------------------------------------------------------------------------
 * The shadcn `Table` component renders `<div data-slot="table-container">`
 * as an ANCESTOR of `<table class="entei-magnet-table">`:
 *
 *   <div class="entei-magnet-table-wrap">        ← outer frame (border/radius/clip)
 *     <div data-slot="table-container">          ← scroll container
 *       <table class="entei-magnet-table">…
 *
 * The scroll constraint must therefore be selected from the wrap's DIRECT
 * CHILD — a descendant selector rooted at the table matches nothing and the
 * inner div keeps its full content height while the wrap's overflow:hidden
 * clips the tail rows (the regression this suite pins).
 *
 * These tests read player.css as text: they verify the selector contract
 * (right selector, right caps, no inverted selector), not pixel layout —
 * the layout half is verified in the browser against a 24-row listing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vitest runs from the web workspace root (apps/web), so the stylesheet is
// at src/styles/player.css. Avoid import.meta.url — vitest's transform can
// rewrite it to a non-file scheme in the jsdom environment.
const css = readFileSync(resolve(process.cwd(), 'src/styles/player.css'), 'utf8');

/**
 * Returns the declaration text of the first rule block for `selector`.
 *
 * This is a deliberately naive parser: it reads from the first `{` after
 * the selector to the very next `}`, assuming the matched block has no
 * nested blocks and no braces inside strings. That holds for every block
 * in player.css (plain declarations only, no @-rule nesting in the magnet
 * section), so the helper stays intentionally simple.
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
    const close = css.indexOf('}', open);
    out.push(css.slice(open + 1, close));
    from = close + 1;
  }
  return out;
}

describe('Magnet table bounded-scroll CSS contract', () => {
  it('targets the inner scroll container from the wrap direct child', () => {
    expect(css).toContain(".entei-magnet-table-wrap > [data-slot='table-container']");
  });

  it('applies the desktop 20rem cap and scroll to the inner container', () => {
    const b = ruleBlock(".entei-magnet-table-wrap > [data-slot='table-container']");
    expect(b).toContain('max-height: 20rem');
    expect(b).toContain('overflow-y: auto');
  });

  it('does not rely on the inverted table-descendant selector', () => {
    expect(css).not.toContain(".entei-magnet-table [data-slot='table-container']");
  });

  it('applies the 18rem mobile cap to the same inner container', () => {
    const magnetBlock = mobileBlocks().find((b) =>
      b.includes('.entei-magnet-table-wrap > [data-slot=\'table-container\']'),
    );
    expect(magnetBlock, 'magnet rule inside a max-width:767px block').toBeTruthy();
    expect(magnetBlock).toContain('max-height: 18rem');
  });

  it('keeps the wrap as the clipped outer frame', () => {
    const b = ruleBlock('.entei-magnet-table-wrap');
    expect(b).toContain('overflow: hidden');
    expect(b).toContain('max-height: 20rem');
    expect(b).toContain('border-radius: var(--entei-radius-md)');
  });
});
