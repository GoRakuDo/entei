/**
 * Static contract test for the shared gold hover/focus rule set
 * (choice ToggleGroups, Select/Combobox triggers, text fields).
 * ---------------------------------------------------------------------------
 * Approved behaviour: all three families light their value text AND any Lucide
 * icon inside with --entei-status-locked —
 *   - ToggleGroup items: gold on hover AND while latched on (data-state="on"),
 *     because a latched item is the current mode, not just a hovered one.
 *   - Select triggers and the language Combobox: gold on hover, chevron
 *     included (shadcn mutes the chevron through a utility class).
 *   - Inputs / textareas: gold on hover and focus; placeholders keep their
 *     muted tone (`color` on the element never reaches ::placeholder).
 *
 * The rules must live in ONE unlayered place with explicit element/attribute
 * selectors: settings-shared.css is imported before `@import 'tailwindcss'`, and
 * player.css / settings.css / profile.css load after global.css, so a
 * single-class or `:where()` rule loses to their base `color` declarations.
 *
 * Regression pins below:
 *   - player.css / settings-shared.css used to repaint hovered and latched
 *     ToggleGroup items --entei-text-secondary, which beat the shared rule by
 *     source order (player.css loads after global.css).
 *   - The old "mirror" copies of the toggle block must not drift back to
 *     text-secondary.
 *   - Non-text input types keep their own treatment (range/checkbox/radio/
 *     colour/file/button).
 *
 * Pixel appearance is verified in the rendered browser; this test only pins the
 * selector/declaration/cascade contract against regressions.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const stylesDir = resolve(process.cwd(), 'src/styles');
const readStyles = (name: string) =>
  readFileSync(resolve(stylesDir, name), 'utf8');

const globalCss = readStyles('global.css');
const playerCss = readStyles('player.css');
const settingsSharedCss = readStyles('settings-shared.css');

const GOLD = 'color: var(--entei-status-locked)';

const TOGGLE_HOVER =
  "[data-slot='toggle-group'] button:hover:not(:disabled)";
const TOGGLE_ITEM_HOVER =
  "[data-slot='toggle-group'] [data-slot='toggle-group-item']:hover:not(:disabled)";
const TOGGLE_ON_RESTING = "[data-slot='toggle-group'] button[data-state='on']";
const SELECT_TRIGGER_HOVER = "[data-slot='select-trigger']:hover:not(:disabled)";
const FIELD_HOVER_FOCUS = 'input:is(:hover, :focus, :focus-visible)';
const TEXTAREA_HOVER_FOCUS = 'textarea:is(:hover, :focus, :focus-visible)';

/** Declaration body of the rule whose selector list starts with `selector`. */
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `rule starting at ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  expect(close, `closing brace for ${selector}`).toBeGreaterThan(open);
  return css.slice(open + 1, close).trim().replace(/;$/, '');
}

/** Whole rule — selector list plus declarations — starting at `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `rule starting at ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start) + 1);
}

describe('gold hover for buttongroups, comboboxes and text fields', () => {
  it('hovered ToggleGroup items paint label and icon gold', () => {
    const rules = [
      `${TOGGLE_HOVER},\n${TOGGLE_ITEM_HOVER}`,
      `${TOGGLE_HOVER} svg,\n${TOGGLE_ITEM_HOVER} svg`,
    ];
    for (const selector of rules) {
      expect(block(globalCss, selector), selector).toContain(GOLD);
    }
  });

  it('active ToggleGroup items stay text-secondary when resting and go gold only on hover', () => {
    // Resting active item must NOT be gold: it stays text-secondary
    expect(globalCss).not.toContain(`${TOGGLE_ON_RESTING},`);
    for (const [name, css] of [
      ['player.css', playerCss],
      ['settings-shared.css', settingsSharedCss],
    ] as const) {
      const resting = block(css, `${TOGGLE_ON_RESTING} {`);
      expect(resting, `${name} resting active`).toContain('--entei-text-secondary');
      expect(resting, `${name} resting active`).not.toContain('--entei-status-locked');

      const hovered = block(css, `${TOGGLE_ON_RESTING}:hover:not(:disabled) {`);
      expect(hovered, `${name} hovered active`).toContain('--entei-status-locked');
    }
  });

  it('item selectors stay scoped under the group root to outrank class rules', () => {
    // settings.css declares `.entei-scan-input-card
    // [data-slot='toggle-group-item']` (and its svg) in --entei-text-secondary
    // and loads after global.css: a bare item selector would tie with it and
    // lose on source order, so every item selector carries the group root.
    for (const selector of [
      TOGGLE_ITEM_HOVER,
      `${TOGGLE_ITEM_HOVER} svg`,
    ]) {
      expect(selector.startsWith("[data-slot='toggle-group'] "), selector).toBe(
        true,
      );
    }
  });

  it('no later-loaded toggle rule repaints hover back to secondary', () => {
    for (const [name, css] of [
      ['player.css', playerCss],
      ['settings-shared.css', settingsSharedCss],
    ] as const) {
      for (const selector of [
        "[data-slot='toggle-group'] button[data-state='off']:hover:not(:disabled) {",
        `${TOGGLE_ON_RESTING}:hover:not(:disabled) {`,
      ]) {
        if (!css.includes(selector)) continue;
        const rule = block(css, selector);
        expect(rule, `${name} ${selector}`).toContain('--entei-status-locked');
        expect(rule, `${name} ${selector}`).not.toContain(
          '--entei-text-secondary',
        );
      }
    }
  });

  it('Select triggers and the Combobox chevron go gold on hover', () => {
    expect(block(globalCss, `${SELECT_TRIGGER_HOVER} {`)).toContain(GOLD);
    const iconRule = rule(
      globalCss,
      `${SELECT_TRIGGER_HOVER} svg,\n.entei-combobox-trigger:hover svg`,
    );
    expect(iconRule.startsWith(`${SELECT_TRIGGER_HOVER} svg,`)).toBe(true);
    expect(iconRule).toContain('.entei-combobox-trigger:hover svg');
    expect(iconRule).toContain(GOLD);
    expect(block(globalCss, '.entei-combobox-trigger:hover svg')).toContain(
      GOLD,
    );
  });

  it('inputs and textareas go gold on hover and focus, non-text types exempt', () => {
    const fieldRule = rule(globalCss, FIELD_HOVER_FOCUS);
    expect(fieldRule).toContain(GOLD);
    expect(rule(globalCss, TEXTAREA_HOVER_FOCUS)).toContain(GOLD);

    for (const type of ['range', 'checkbox', 'radio', 'color', 'file']) {
      expect(fieldRule, `excludes input[type=${type}]`).toContain(
        `:not([type='${type}'])`,
      );
    }
    expect(fieldRule).toContain(':not(:disabled)');
    expect(globalCss).not.toMatch(/::placeholder\s*\{[^}]*status-locked/s);
  });

  it('the shared rule set stays OKLCH-token only (rule #1621)', () => {
    const rules = [
      `${TOGGLE_HOVER},\n${TOGGLE_ITEM_HOVER}`,
      `${TOGGLE_HOVER} svg,\n${TOGGLE_ITEM_HOVER} svg`,
      `${SELECT_TRIGGER_HOVER} {`,
      FIELD_HOVER_FOCUS,
      TEXTAREA_HOVER_FOCUS,
    ].map((selector) => block(globalCss, selector).trim());
    for (const declarations of rules) {
      expect(declarations).toBe(GOLD);
    }
  });

  it('the shared rule set outranks later single-class base colours', () => {
    // Unlayered source order: settings-shared.css (imported at the top of
    // global.css) → global.css → player.css / settings.css / profile.css.
    // The field selector therefore has to carry element + pseudo-class
    // specificity instead of a single class or :where().
    const fieldRuleText = rule(globalCss, FIELD_HOVER_FOCUS);
    expect(
      fieldRuleText.startsWith(
        "input:is(:hover, :focus, :focus-visible):not([type='range'])",
      ),
    ).toBe(true);
    expect(globalCss).not.toContain(':where(input, textarea):is(:hover');
    const tailwindImport = globalCss.indexOf("@import 'tailwindcss'");
    const goldRules = globalCss.indexOf('GOLD HOVER FOR CHOICE GROUPS');
    expect(tailwindImport).toBeGreaterThanOrEqual(0);
    expect(goldRules).toBeGreaterThan(tailwindImport);
  });
});