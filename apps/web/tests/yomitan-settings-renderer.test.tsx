/**
 * YomitanSettingsRenderer tests — descriptor-tree settings page.
 * ---------------------------------------------------------------------------
 * - every manifest section renders with its leading section icon when the
 *   manifest sets `showSectionIcons`, and with none when it does not
 * - the description lives inside the toggle button (one clean target)
 * - host-locked fields (master switch / lookup language / welcome guide /
 *   advanced+debug toggles) are never rendered, and a group they empty
 *   disappears with them
 * - expanding a section shows only the editable, non-locked fields
 * - a section the manifest lays out (`sectionLayouts`) draws the declared rows
 *   through the app's standard layouts: the installed-item list with its own
 *   header (its import action belongs to the desktop dictionary engine), the
 *   scan-input cards of the `inputs` layout, plain field rows, and the
 *   host-measured usage row
 * - a field laid out that way is claimed: it is not drawn twice in its own tree
 *   group
 * - nothing is hard-coded per module: a `list` row with an unknown `source`
 *   stays on the generic read-only note
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { yomitanSettingsTree } from '@gorakudo/yomitan-headless/settings';
import { YomitanSettingsRenderer } from '@/components/settings/YomitanSettingsRenderer';
import { CORE_MODULES } from '@/features/modules/module-registry';
import {
  readOptionPath,
  readYomitanOptions,
  writeYomitanOptions,
} from '@/features/yomitan/yomitan-preferences';
import { en } from '@/i18n/locales/en';

const LABELS = {
  notEditable: en.yomitanSettings.notEditable,
  toggleSection: en.yomitanSettings.toggleSection,
};

const COPY = en.yomitanSettings;

/** Yomitan's own manifest declaration of its Dictionaries section. */
const SECTION_LAYOUTS =
  CORE_MODULES.find((module) => module.id === 'yomitan')?.sectionLayouts ?? [];

beforeEach(() => {
  localStorage.clear();
  global.ResizeObserver = vi.fn(function () {
    return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  });
  // Radix scrolls the selected option into view when a Select opens; this DOM
  // implementation has no `scrollIntoView`.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderSettings(
  showSectionIcons = false,
  sectionLayouts = SECTION_LAYOUTS,
) {
  /**
   * The page's own wiring (SettingsApp): the persisted tree in state, every edit
   * written through the preferences store AND fed back into the render. Without
   * the state the cards would write and never move.
   */
  function Harness() {
    const [options, setOptions] = useState(readYomitanOptions);
    return (
      <YomitanSettingsRenderer
        sections={yomitanSettingsTree}
        sectionLayouts={sectionLayouts}
        showSectionIcons={showSectionIcons}
        options={options}
        onChange={(next) => {
          writeYomitanOptions(next);
          setOptions(next);
        }}
        labels={LABELS}
        copy={COPY}
      />
    );
  }
  return render(<Harness />);
}

/** The scan-input card at one position (cards are positional, not data). */
function scanInputCard(container: HTMLElement, index: number): HTMLElement {
  const card = container.querySelectorAll('.entei-scan-input-card')[index];
  if (card === undefined) throw new Error(`no scan-input card at ${index}`);
  return card as HTMLElement;
}

/** Open one section card by its visible label. */
function openSection(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('YomitanSettingsRenderer — sections', () => {
  it('renders one collapsible section per manifest entry', () => {
    renderSettings();
    const toggles = screen.getAllByRole('button', { expanded: false });
    expect(toggles).toHaveLength(yomitanSettingsTree.length);
  });

  it('gives every section header a leading icon when the manifest asks for it', () => {
    const { container } = renderSettings(true);
    const headers = container.querySelectorAll('.entei-module-section-toggle');
    expect(headers.length).toBe(yomitanSettingsTree.length);
    for (const header of headers) {
      const icon = header.querySelector('.entei-module-section-icon');
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('renders no section icon when the manifest leaves it off', () => {
    const { container } = renderSettings(false);
    expect(container.querySelectorAll('.entei-module-section-icon')).toHaveLength(
      0,
    );
  });

  it('keeps the description inside the toggle target', () => {
    const { container } = renderSettings(true);
    const toggle = container.querySelector('.entei-module-section-toggle');
    expect(toggle).not.toBeNull();
    const description = toggle?.querySelector(
      '.entei-module-section-description',
    );
    expect(description).not.toBeNull();
    expect(description?.tagName).toBe('SPAN');
    // The description is the toggle's accessible description, not its name.
    expect(toggle?.getAttribute('aria-describedby')).toBe(
      description?.getAttribute('id'),
    );
  });
});

describe('YomitanSettingsRenderer — locked fields', () => {
  it('never renders the host-locked general fields', () => {
    renderSettings();
    expect(screen.queryByText('Enable Yomitan')).toBeNull();
    expect(screen.queryByText('Show welcome guide')).toBeNull();
    // The section keeps its other language-independent rows.
    expect(screen.queryByText('Language')).toBeNull();
  });

  it('drops the groups the locked fields emptied', () => {
    const { container } = renderSettings();
    openSection(/General/i);
    const groupLabels = Array.from(
      container.querySelectorAll('.entei-module-group-label'),
    ).map((node) => node.textContent);
    expect(groupLabels).not.toContain('Enable');
    expect(groupLabels).not.toContain('Language');
    expect(groupLabels).not.toContain('Welcome');
    expect(groupLabels).toContain('Results');
    // Pinned-on host options have no toggle; the trace gate keeps its own.
    expect(screen.queryByText('Show advanced settings')).toBeNull();
    expect(screen.queryByText('Show debug settings')).toBeNull();
    expect(screen.getByText('Show debug information')).toBeTruthy();
    expect(groupLabels).toContain('Debug');
  });

  it('renders no control bound to a locked path', () => {
    const { container } = renderSettings();
    openSection(/General/i);
    // Every remaining switch is an editable general field (context menu,
    // API, debug) — the master switch is gone.
    const switches = container.querySelectorAll('[data-slot="switch"]');
    expect(switches.length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Enable Yomitan')).toBeNull();
  });
});

describe('YomitanSettingsRenderer — manifest-laid-out Dictionaries section', () => {
  function openDictionaries() {
    openSection(/Dictionaries/i);
  }

  it('draws the installed-item list with its header, and no import outside the desktop engine', async () => {
    const { container } = renderSettings();
    openDictionaries();

    // Block header: title + description on the left, import on the right — the
    // import action belongs to the desktop engine (a native path picker), so a
    // browser pass draws the header without it.
    expect(screen.getByText(COPY.dictionaries.installedTitle)).toBeTruthy();
    expect(
      screen.getByText(COPY.dictionaries.installedDescription),
    ).toBeTruthy();
    const header = container.querySelector('.entei-module-list-header');
    expect(header).not.toBeNull();
    expect(
      header?.querySelector('.entei-module-list-toolbar button'),
    ).toBeNull();

    // The generic read-only note is gone for this field, replaced by the empty
    // state: `bun test` has no Tauri runtime, so the engine reports nothing and
    // there are no reorderable rows to draw.
    expect(screen.queryByText(COPY.notEditable)).toBeNull();
    expect(await screen.findByText(COPY.dictionaries.empty)).toBeTruthy();
    expect(container.querySelectorAll('.entei-module-list-rows')).toHaveLength(
      0,
    );
  });

  it('draws the prefix-wildcard switch and the frequency select', async () => {
    const { container } = renderSettings();
    openDictionaries();

    expect(screen.getByText(COPY.dictionaries.prefixWildcards)).toBeTruthy();
    expect(
      screen.getByText(COPY.dictionaries.sortFrequency),
    ).toBeTruthy();
    expect(
      screen.getByText(COPY.dictionaries.sortFrequencyDescription),
    ).toBeTruthy();

    /* The wildcard row is a switch and nothing else: the section-wide option
       list must not draw a combobox beside the toggle. */
    const wildcardRow = screen
      .getByText(COPY.dictionaries.prefixWildcards)
      .closest('.entei-module-field');
    expect(
      wildcardRow?.querySelector('[data-slot="switch"]'),
    ).not.toBeNull();
    expect(wildcardRow?.querySelector('.entei-module-select')).toBeNull();
    // ...so the frequency dictionary is the section's only combobox.
    expect(container.querySelectorAll('.entei-module-select')).toHaveLength(1);

    // The select's leading option is the host-resolved `None` (no frequency
    // dictionary chosen); no dictionary is installed in a test run, so it is
    // the only choice. Radix mounts the items when the trigger opens.
    const trigger = container.querySelector('.entei-module-select');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger as Element);
    /* The open popup repeats the trigger's own value, so the option is matched
       by role instead of by text. */
    expect(
      await screen.findByRole('option', {
        name: COPY.dictionaries.sortFrequencyNone,
      }),
    ).toBeTruthy();
  });

  it('measures storage through the host source and refreshes on demand', async () => {
    const estimate = vi.fn(async () => ({ usage: 1_700_000_000, quota: 117_200_000_000 }));
    Object.defineProperty(globalThis.navigator, 'storage', {
      value: { estimate },
      configurable: true,
    });

    renderSettings();
    openDictionaries();

    expect(screen.getByText(COPY.dictionaries.storage)).toBeTruthy();
    // "Yomitan is using approximately 1.7GB of 117.2GB."
    const usage = await screen.findByText(
      COPY.dictionaries.storageUsage.replace('{used}', '1.7GB').replace(
        '{total}',
        '117.2GB',
      ),
    );
    expect(usage).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: COPY.dictionaries.refresh }),
    );
    expect(estimate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('never draws a claimed field twice (tree group + declared row)', () => {
    const { container } = renderSettings();
    // `general.sortFrequencyDictionary` is a row of the Dictionaries section...
    openSection(/Dictionaries/i);
    expect(
      screen.getAllByText(COPY.dictionaries.sortFrequency),
    ).toHaveLength(1);

    // ...so its own tree group ("Frequency Sorting") loses that field.
    openSection(/Result Display/i);
    expect(screen.queryByText('Sort frequency dictionary')).toBeNull();
    expect(screen.queryByText('Sort order')).toBeTruthy();
    expect(container.querySelectorAll('.entei-module-rows')).toHaveLength(1);
  });

  it('falls back to the read-only note for an unknown data source', () => {
    renderSettings(false, [
      {
        section: 'dictionaries',
        rows: [
          {
            layout: 'list',
            field: 'dictionaries',
            source: 'nope',
          },
        ],
      },
    ]);
    openDictionaries();

    expect(screen.getByText(COPY.notEditable)).toBeTruthy();
    expect(screen.queryByText(COPY.dictionaries.empty)).toBeNull();
  });

  it('draws nothing for a row naming a field the tree does not have', () => {
    renderSettings(false, [
      {
        section: 'dictionaries',
        rows: [{ layout: 'field', field: 'general.doesNotExist' }],
      },
    ]);
    openDictionaries();

    expect(screen.queryByText(COPY.notEditable)).toBeNull();
    expect(screen.queryByLabelText('Show debug information')).toBeNull();
  });
});

describe('YomitanSettingsRenderer — manifest-laid-out Scanning section', () => {
  function openScanning() {
    openSection(/Scanning/i);
  }

  it('draws the declared scanning rows, including the virtual scan modifier', () => {
    renderSettings();
    openScanning();

    // Host-declared virtual field: a path the app derives (Yomitan stores a scan
    // modifier inside `scanning.inputs[]`), so the tree has no descriptor for it.
    expect(screen.getByText(COPY.scanning.modifierKey)).toBeTruthy();
    // Real tree fields the manifest lays out keep their own descriptors.
    expect(screen.getByText(COPY.scanning.delay)).toBeTruthy();
    expect(screen.getByText(COPY.scanning.length)).toBeTruthy();
    expect(screen.getByText(COPY.scanning.scanWithoutMousemove)).toBeTruthy();
    expect(screen.getByText(COPY.scanning.selectText)).toBeTruthy();
    // The two that used to be host-locked are rows of their own now.
    expect(screen.getByText(COPY.scanning.deepDomScan)).toBeTruthy();
    expect(screen.getByText(COPY.scanning.normalizeCssZoom)).toBeTruthy();
    // "Wildcard scanning" is Yomitan's own label for the prefix match type.
    expect(screen.getByText(COPY.scanning.wildcardScanning)).toBeTruthy();
    // Neither virtual path falls back to the read-only note.
    expect(screen.queryByText(COPY.notEditable)).toBeNull();
  });

  it('offers the locale-labelled modifiers and writes the scan input', async () => {
    const { container } = renderSettings();
    openScanning();

    const trigger = container.querySelector('.entei-module-select');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger as Element);
    fireEvent.click(
      await screen.findByRole('option', { name: COPY.scanning.modifierCtrl }),
    );

    // The knob wrote Yomitan's own field, and the persisted tree reads back.
    const inputs = readOptionPath(readYomitanOptions(), 'scanning.inputs') as {
      include: string;
    }[];
    expect(inputs[0]?.include).toBe('ctrl');
    expect(readOptionPath(readYomitanOptions(), 'scanning.modifierKey')).toBe(
      'ctrl',
    );
  });

  it('never offers the rows the blueprint drops, nor the prevent families', () => {
    renderSettings();
    openScanning();

    // Yomitan rows this host does not expose: the middle-button trigger (it is a
    // token in a scan-input card now), the scan resolution, the alphanumeric
    // search, the layout-aware toggle.
    expect(screen.queryByText(COPY.scanning.modifierShift)).toBeNull();
    expect(screen.queryByText('Scan resolution')).toBeNull();
    expect(screen.queryByText('Scan alphanumeric characters')).toBeNull();
    expect(screen.queryByText('Layout-aware scan')).toBeNull();
    // Host-locked, so no editor exists for them at all.
    expect(screen.queryByText('Prevent middle mouse')).toBeNull();
    expect(screen.queryByText('Prevent back/forward')).toBeNull();
  });

  it('draws one card per persisted scan input, with the count in its heading', () => {
    const { container } = renderSettings();
    openScanning();

    const heading = `${COPY.scanning.advancedInputs} (${COPY.scanning.advancedInputsCount.replace('{count}', '2')})`;
    expect(screen.getByText(heading)).toBeTruthy();
    expect(
      screen.getByText(COPY.scanning.advancedInputsDescription),
    ).toBeTruthy();
    // Yomitan ships two definitions: a mouse one and a touch/pen one.
    expect(container.querySelectorAll('.entei-scan-input-card')).toHaveLength(
      2,
    );
    expect(screen.getAllByText(COPY.scanning.requiredInputs)).toHaveLength(2);
    expect(screen.getAllByText(COPY.scanning.excludedInputs)).toHaveLength(2);
  });

  it('adds a key on demand and persists it', () => {
    const { container } = renderSettings();
    openScanning();

    fireEvent.click(screen.getByRole('button', { name: COPY.scanning.addKey }));

    const inputs = readOptionPath(readYomitanOptions(), 'scanning.inputs') as {
      include: string;
      types: { mouse: boolean };
    }[];
    expect(inputs).toHaveLength(3);
    // A new card starts as a mouse card with no required input.
    expect(inputs[2]?.include).toBe('');
    expect(inputs[2]?.types.mouse).toBe(true);
    expect(container.querySelectorAll('.entei-scan-input-card')).toHaveLength(
      3,
    );
    expect(
      screen.getByText(
        `${COPY.scanning.advancedInputs} (${COPY.scanning.advancedInputsCount.replace('{count}', '3')})`,
      ),
    ).toBeTruthy();
  });

  it('deletes a card and persists the shorter list', () => {
    const { container } = renderSettings();
    openScanning();

    fireEvent.click(
      screen.getByRole('button', {
        name: `${COPY.scanning.removeInput} 1`,
      }),
    );

    expect(
      readOptionPath(readYomitanOptions(), 'scanning.inputs'),
    ).toHaveLength(1);
    expect(container.querySelectorAll('.entei-scan-input-card')).toHaveLength(
      1,
    );
  });

  it('keeps one pointer type per card and shows the touch rows for it only', () => {
    const { container } = renderSettings();
    openScanning();

    /* The first default card is a mouse card: Yomitan's mouse trigger is
       "hold the required inputs and move", so it has no press or release. The
       second one serves touch, so its own card does show them. */
    const mouseCard = scanInputCard(container, 0);
    expect(within(mouseCard).queryByText(COPY.scanning.scanOn)).toBeNull();
    expect(
      within(mouseCard).queryByText(COPY.scanning.minimumTouchTime),
    ).toBeNull();
    expect(
      within(scanInputCard(container, 1)).getByText(COPY.scanning.scanOn),
    ).toBeTruthy();

    fireEvent.click(
      within(mouseCard).getByRole('radio', { name: COPY.scanning.touch }),
    );

    const touched = scanInputCard(container, 0);
    expect(within(touched).getByText(COPY.scanning.scanOn)).toBeTruthy();
    expect(
      within(touched).getByText(COPY.scanning.preventScrolling),
    ).toBeTruthy();
    expect(
      within(touched).getByText(COPY.scanning.minimumTouchTime),
    ).toBeTruthy();
    // Exactly one type is persisted — the single-select rule.
    const inputs = readOptionPath(readYomitanOptions(), 'scanning.inputs') as {
      types: { mouse: boolean; touch: boolean; pen: boolean };
    }[];
    expect(inputs[0]?.types).toEqual({
      mouse: false,
      touch: true,
      pen: false,
    });
  });

  it('makes the trigger choice authoritative for the flags it replaces', () => {
    const { container } = renderSettings();
    openScanning();

    const mouseCard = scanInputCard(container, 0);
    fireEvent.click(
      within(mouseCard).getByRole('radio', { name: COPY.scanning.touch }),
    );
    fireEvent.click(
      within(scanInputCard(container, 0)).getByRole('radio', {
        name: COPY.scanning.release,
      }),
    );

    // Touch tap/move are not in this UI, so picking a trigger writes them off:
    // what the card says is what the scanner does.
    const inputs = readOptionPath(readYomitanOptions(), 'scanning.inputs') as {
      options: Record<string, boolean>;
    }[];
    expect(inputs[0]?.options.scanOnTouchRelease).toBe(true);
    expect(inputs[0]?.options.scanOnTouchPress).toBe(false);
    expect(inputs[0]?.options.scanOnTouchTap).toBe(false);
    expect(inputs[0]?.options.scanOnTouchMove).toBe(false);
    // Term and kanji are always both searched.
    expect(inputs[0]?.options.searchTerms).toBe(true);
    expect(inputs[0]?.options.searchKanji).toBe(true);
  });
});
