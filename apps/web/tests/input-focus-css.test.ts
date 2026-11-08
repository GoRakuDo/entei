/**
 * Static contract test for the global text-input focus boundary (DESIGN.md 8.13).
 * ---------------------------------------------------------------------------
 * Approved reference: one 2px INSET outline in --entei-focus-ring, no outer
 * 3px ring. The old stack was:
 *
 *   global.css  :focus-visible            → unlayered 3px OUTER outline
 *   input.tsx   focus-visible:ring-[3px] → Tailwind utility 3px box-shadow
 *   input.tsx   focus-visible:border-ring → purple border
 *
 * Unlayered CSS beats @layer utilities, so `outline-none` in the component
 * could not remove the outer outline. In a ButtonGroup the ring also escaped
 * over the neighbouring eye/key button. The fix is a single unlayered inset
 * rule in global.css, declared AFTER the base :focus-visible rule.
 *
 * Review regressions pinned below:
 *   - A zero-specificity `:where()` rule lost to later-loaded player.css /
 *     profile.css base rules whose `outline: none` erased the ring by source
 *     order. The contract now uses explicit element selectors.
 *   - An `aria-invalid="true"` field was repainted purple on focus because the
 *     unlayered border-color beat the shadcn destructive utility.
 *   - The base `:focus-visible` 4px radius shrank 8px fields on focus.
 *
 * Pixel appearance is verified in the rendered browser; this test only pins
 * the selector/declaration/cascade-order contract against regressions.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const stylesDir = resolve(process.cwd(), 'src/styles');
const readStyles = (name: string) =>
  readFileSync(resolve(stylesDir, name), 'utf8');
const inputTsx = readFileSync(
  resolve(process.cwd(), 'src/components/player/ui/input.tsx'),
  'utf8',
);
const globalCss = readStyles('global.css');
const playerCss = readStyles('player.css');
const profileCss = readStyles('profile.css');

/* Selector lists span several lines; block() only needs the first line to
 * locate the declaration block. */
const VALID_RULE =
  "input:focus-visible:not([type='range']):not([type='checkbox']):not([type='radio']):not([aria-invalid='true']),";
const INVALID_RULE =
  "input:focus-visible:not([type='range']):not([type='checkbox']):not([type='radio'])[aria-invalid='true'],";
const RADIUS_RULE = ':focus-visible:where(:not(input, textarea, select))';
const GROUP_RULE = "[data-slot='button-group'] :focus-visible";

/** Declaration block of one plain rule (no nested at-rules). */
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `rule starting at ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start + selector.length);
  expect(open, `opening brace for ${selector}`).toBeGreaterThan(start);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('text input focus (DESIGN.md 8.13)', () => {
  it('shadcn Input no longer ships a thick outer ring', () => {
    expect(inputTsx).not.toContain('ring-[3px]');
    expect(inputTsx).not.toContain('ring-ring/50');
    expect(inputTsx).not.toContain('aria-invalid:ring-destructive');
    expect(inputTsx).toContain('focus-visible:border-ring');
    expect(inputTsx).toContain('aria-invalid:border-destructive');
  });

  it('global.css declares one inset boundary for every valid text control', () => {
    expect(globalCss).not.toContain(
      ':where(input, textarea, select):focus-visible',
    );
    const rule = block(globalCss, VALID_RULE);
    expect(rule).toContain('outline: 2px solid var(--entei-focus-ring)');
    expect(rule).toContain('outline-offset: -2px');
    expect(rule).toContain('box-shadow: none');
    expect(rule).toContain('border-color: var(--entei-focus-ring)');
  });

  it('explicit element selectors outrank later-loaded single-class rules', () => {
    expect(VALID_RULE).toContain('input:focus-visible');
    expect(globalCss).toContain(
      "textarea:focus-visible:not([aria-invalid='true'])",
    );
    expect(globalCss).toContain(
      "select:focus-visible:not([aria-invalid='true'])",
    );
    expect(VALID_RULE).toContain(":not([type='range'])");
    expect(VALID_RULE).toContain(":not([type='checkbox'])");
    expect(VALID_RULE).toContain(":not([type='radio'])");
  });

  it('the inset override wins the unlayered cascade by source order', () => {
    const base = globalCss.indexOf(':focus-visible {\n  outline: 3px solid');
    const override = globalCss.indexOf(VALID_RULE);
    expect(base).toBeGreaterThanOrEqual(0);
    expect(override).toBeGreaterThan(base);
  });

  it('no later-loaded base rule erases the inset outline with outline: none', () => {
    const bases = [
      ['.entei-anki-input', playerCss],
      ['.entei-mining-input', playerCss],
      ['.entei-profile-textarea', profileCss],
    ] as const;
    for (const [selector, css] of bases) {
      expect(block(css, selector), selector).not.toMatch(
        /\boutline:\s*none\s*;/,
      );
    }
  });

  it('aria-invalid keeps a destructive border and inset outline on focus', () => {
    const rule = block(globalCss, INVALID_RULE);
    expect(rule).toContain('border-color: var(--color-destructive)');
    expect(rule).toContain('outline: 2px solid var(--color-destructive)');
    expect(rule).toContain('outline-offset: -2px');
    expect(rule).toContain('box-shadow: none');
    expect(VALID_RULE).toContain(":not([aria-invalid='true'])");
    expect(globalCss).toContain("textarea:focus-visible[aria-invalid='true']");
    expect(globalCss).toContain("select:focus-visible[aria-invalid='true']");
  });

  it('focusing a text control does not shrink its corner radius', () => {
    const baseStart = globalCss.indexOf(':focus-visible {\n');
    expect(baseStart).toBeGreaterThanOrEqual(0);
    const base = globalCss.slice(
      baseStart,
      globalCss.indexOf('}', baseStart),
    );
    expect(base).not.toContain('border-radius');
    const radius = block(globalCss, RADIUS_RULE);
    expect(radius).toContain('border-radius: var(--entei-radius-sm)');
    expect(RADIUS_RULE).toContain(':where(');
    expect(RADIUS_RULE).toContain(':not(input, textarea, select)');
  });

  it('joined ButtonGroups use the same inset boundary with no outer ring', () => {
    const rule = block(globalCss, GROUP_RULE);
    expect(rule).toContain('outline: 2px solid var(--entei-focus-ring)');
    expect(rule).toContain('outline-offset: -2px');
    expect(rule).toContain('box-shadow: none');
  });

  it('no 3px outer focus ring survives on text inputs', () => {
    const selectors = [
      '.entei-anki-input:focus-visible',
      '.entei-mining-input:focus-visible',
      ".entei-mining-input[aria-invalid='true']:focus-visible",
      '.entei-profile-textarea:focus-visible',
    ];
    for (const name of ['player.css', 'eizouden-settings.css', 'profile.css']) {
      const css = readStyles(name);
      for (const selector of selectors) {
        if (!css.includes(`${selector} {`)) continue;
        expect(block(css, selector), `${name} ${selector}`).not.toContain(
          '0 0 0 3px',
        );
      }
    }
  });

  it('new focus declarations use OKLCH tokens only (rule #1621)', () => {
    for (const rule of [
      block(globalCss, VALID_RULE),
      block(globalCss, INVALID_RULE),
      block(globalCss, RADIUS_RULE),
      block(globalCss, GROUP_RULE),
    ]) {
      expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(rule).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\s*\(/i);
    }
  });
});
