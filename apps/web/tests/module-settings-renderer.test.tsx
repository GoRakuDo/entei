/**
 * ModuleSettingsRenderer tests — descriptor-tree settings page.
 * ---------------------------------------------------------------------------
 * The page is asked for one module's settings and never names it: every case
 * below drives it with a MANIFEST (Yomitan's own tree, or a synthetic row layout),
 * which is the only input an imported module gets too.
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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  createDefaultOptions,
  yomitanSettingsTree,
  type Options,
} from '@gorakudo/yomitan-headless/settings';
import { ModuleSettingsRenderer, moduleHasSettings } from '@/components/settings/ModuleSettingsRenderer';
import {
  CORE_MODULES,
  type EnteiModuleManifest,
  type EnteiModuleSectionLayout,
} from '@/features/modules/module-registry';
import {
  readOptionPath,
  readYomitanOptions,
  writeYomitanOptions,
} from '@/modules/yomitan/yomitan-preferences';
import { createDictionaryOptionEntry } from '@/modules/yomitan/dictionary-store';
import { readJimakuPreferences } from '@/features/player/jimaku-preferences';
import { en } from '@/i18n/locales/en';
import {
  DICTIONARIES_COPY,
  SCANNING_INPUTS_COPY,
} from '@/components/settings/module-copy';

/**
 * The renderer's own chrome is localised by the dictionary it is handed;
 * everything a ROW draws is the manifest's literal English text plus the app's
 * English layout tables — the dictionary has no entry for those any more.
 */
const LABELS = {
  notEditable: en.yomitanSettings.notEditable,
  toggleSection: en.yomitanSettings.toggleSection,
};

/** The strings under test. */
const COPY = {
  notEditable: LABELS.notEditable,
  dictionaries: {
    installedTitle: 'Installed Dictionaries',
    installedDescription:
      'Dictionary entries are managed at runtime. The settings tree exposes per-dictionary fields once a dictionary is installed.',
    empty: DICTIONARIES_COPY.empty,
    prefixWildcards: 'Enable support for prefix wildcard searches',
    storage: 'Storage',
    storageUsage: 'Yomitan is using approximately {used} of {total}.',
    refresh: 'Refresh',
    sortFrequency: 'Frequency sorting dictionary',
    sortFrequencyDescription: 'Sort results using a frequency dictionary.',
    sortFrequencyNone: 'None',
  },
  scanning: {
    modifierKey: 'Scan modifier key',
    modifierCtrl: 'Ctrl',
    advancedInputs: 'Configure advanced scanning inputs...',
    advancedInputsDescription:
      'Scanning inputs are used to define when text scanning should occur.',
    addKey: SCANNING_INPUTS_COPY.add,
    requiredInputs: SCANNING_INPUTS_COPY.required,
    excludedInputs: SCANNING_INPUTS_COPY.excluded,
    removeInput: SCANNING_INPUTS_COPY.remove,
    delay: 'Scan delay (in ms)',
    length: 'Text scan length',
    scanWithoutMousemove: 'Scan without mouse move',
    selectText: 'Select matched text',
    deepDomScan: 'Deep content scanning',
    normalizeCssZoom: 'Normalize CSS zoom',
    wildcardScanning: 'Wildcard scanning',
    scanOn: SCANNING_INPUTS_COPY.scanOn,
    searchFor: SCANNING_INPUTS_COPY.searchFor,
    touch: SCANNING_INPUTS_COPY.touch,
    preventScrolling: SCANNING_INPUTS_COPY.preventScrolling,
    minimumTouchTime: SCANNING_INPUTS_COPY.minimumTouchTime,
    release: SCANNING_INPUTS_COPY.release,
  },
};

/** The inputs layout's card count, as it composes its heading (`{count} defined`). */
function inputsCount(count: number): string {
  return SCANNING_INPUTS_COPY.count.replace('{count}', String(count));
}

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
  sectionLayouts: readonly EnteiModuleSectionLayout[] = SECTION_LAYOUTS,
) {
  /**
   * The manifest is the renderer's ONLY input: its tree, its row layouts and its
   * own section-icon flag. The options tree the edits write to is owned by the
   * renderer itself (localStorage, mirrored to the desktop DB upstream), so the
   * assertions read it back through `readYomitanOptions()`.
   */
  const manifest: EnteiModuleManifest = {
    id: 'yomitan',
    version: 'test',
    author: 'Entei',
    category: 'dictionary',
    builtIn: true,
    defaultEnabled: true,
    settingsSchema: yomitanSettingsTree,
    sectionLayouts,
    showSectionIcons,
  };
  return render(<ModuleSettingsRenderer module={manifest} dict={en} />);
}

/** The scan-input card at one position (cards are positional, not data). */
function scanInputCard(container: HTMLElement, index: number): HTMLElement {
  const card = container.querySelectorAll('.entei-module-input-card')[index];
  if (card === undefined) throw new Error(`no scan-input card at ${index}`);
  return card as HTMLElement;
}

/** Open one section card by its visible label. */
function openSection(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('ModuleSettingsRenderer — sections', () => {
  it('renders one collapsible section per manifest entry', () => {
    renderSettings();
    const toggles = screen.getAllByRole('button', { expanded: false });
    // sentence-parsing is hidden via sectionLayouts (migrated to Parsing); 18 tree sections - 1 hidden = 17
    expect(toggles).toHaveLength(yomitanSettingsTree.length - 1);
  });

  it('gives every section header a leading icon when the manifest asks for it', () => {
    const { container } = renderSettings(true);
    const headers = container.querySelectorAll('.entei-module-section-toggle');
    // sentence-parsing is hidden via sectionLayouts; 18 tree sections - 1 hidden = 17
    expect(headers.length).toBe(yomitanSettingsTree.length - 1);
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

describe('ModuleSettingsRenderer — a section heading the manifest re-texts', () => {
  /**
   * A layout entry may re-text the section it takes over. Upstream's headings
   * describe the EXTENSION's surface, so a host that fills a section with rows about
   * its own page needs a heading that says so — without giving up the tree as the
   * fallback (a layout that says nothing must leave the wording exactly as it was).
   */
  const CLIPBOARD_INDEX = yomitanSettingsTree.findIndex(
    (section) => section.key === 'clipboard',
  );

  function clipboardCard(container: HTMLElement): HTMLElement {
    const card = container.querySelectorAll('.entei-module-section')[
      CLIPBOARD_INDEX
    ];
    if (card === undefined) throw new Error('no clipboard section card');
    return card as HTMLElement;
  }

  it('replaces both the label and the description', () => {
    const { container } = renderSettings(false, [
      {
        section: 'clipboard',
        label: 'Monitoring',
        description: 'Watch the clipboard for new queries.',
        rows: [
          {
            layout: 'field',
            field: 'clipboard.enableSearchPageMonitor',
            label: 'Clipboard monitor',
          },
        ],
      },
    ]);
    openSection(/^Toggle section: Monitoring$/i);

    const card = clipboardCard(container);
    expect(card.querySelector('.entei-module-section-label')?.textContent).toBe(
      'Monitoring',
    );
    expect(
      card.querySelector('.entei-module-section-description')?.textContent,
    ).toBe('Watch the clipboard for new queries.');
    // The tree's own wording is gone, not merely outranked.
    expect(card.textContent).not.toContain('Clipboard monitoring');
    expect(card.textContent).not.toContain('Enable search page monitor');
  });

  it('keeps the accessible name and description in step with the copy', () => {
    const { container } = renderSettings(false, [
      {
        section: 'clipboard',
        label: 'Monitoring',
        description: 'Watch the clipboard for new queries.',
        rows: [
          {
            layout: 'field',
            field: 'clipboard.enableSearchPageMonitor',
            label: 'Clipboard monitor',
          },
        ],
      },
    ]);

    /* The heading is the toggle's accessible NAME and its description is the
       referenced node: a card renamed in one place only would be announced under
       its old name. */
    const card = clipboardCard(container);
    const toggle = card.querySelector('.entei-module-section-toggle');
    const description = card.querySelector(
      '.entei-module-section-description',
    );
    expect(toggle?.getAttribute('aria-label')).toBe('Toggle section: Monitoring');
    expect(toggle?.getAttribute('aria-describedby')).toBe(
      description?.getAttribute('id'),
    );
  });

  it('leaves the heading alone when the layout re-texts nothing', () => {
    const { container } = renderSettings(false, [
      {
        section: 'clipboard',
        rows: [
          {
            layout: 'field',
            field: 'clipboard.enableSearchPageMonitor',
            label: 'Clipboard monitor',
          },
        ],
      },
    ]);
    openSection(/^Toggle section: Clipboard$/i);

    const card = clipboardCard(container);
    expect(card.querySelector('.entei-module-section-label')?.textContent).toBe(
      'Clipboard',
    );
    expect(
      card.querySelector('.entei-module-section-description')?.textContent,
    ).toBe('Clipboard monitoring for auto-search.');
  });
});

describe('ModuleSettingsRenderer — locked fields', () => {
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
    /* `general.debugInfo` is now claimed by the Appearance section (upstream shows
       "Show debug information" there), so it no longer renders in General — the
       General "Debug" group held only it plus the locked `showDebug`, so that
       group empties out and disappears with it. */
    expect(screen.queryByText('Show debug information')).toBeNull();
    expect(groupLabels).not.toContain('Debug');
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

describe('ModuleSettingsRenderer — manifest-laid-out Dictionaries section', () => {
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
    // ...so the frequency dictionary and sorting mode are the section's comboboxes.
    expect(container.querySelectorAll('.entei-module-select')).toHaveLength(2);

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
    expect(screen.queryByText('Sort order')).toBeNull();
    // Both cards now lay their rows out, and both are open.
    expect(container.querySelectorAll('.entei-module-rows')).toHaveLength(2);
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

describe('ModuleSettingsRenderer — manifest-laid-out Scanning section', () => {
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
    expect(screen.queryByText('Shift')).toBeNull();
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

    const heading = `${COPY.scanning.advancedInputs} (${inputsCount(2)})`;
    expect(screen.getByText(heading)).toBeTruthy();
    expect(
      screen.getByText(COPY.scanning.advancedInputsDescription),
    ).toBeTruthy();
    // Yomitan ships two definitions: a mouse one and a touch/pen one.
    expect(container.querySelectorAll('.entei-module-input-card')).toHaveLength(
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
    expect(container.querySelectorAll('.entei-module-input-card')).toHaveLength(
      3,
    );
    expect(
      screen.getByText(`${COPY.scanning.advancedInputs} (${inputsCount(3)})`),
    ).toBeTruthy();
  });

  it('never renders a remove button on the first card and deletes additional cards from the bottom button', () => {
    const { container } = renderSettings();
    openScanning();

    const firstCard = scanInputCard(container, 0);
    const secondCard = scanInputCard(container, 1);
    expect(within(firstCard).queryByRole('button', { name: COPY.scanning.removeInput })).toBeNull();
    expect(within(secondCard).getByRole('button', { name: COPY.scanning.removeInput })).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', {
        name: COPY.scanning.removeInput,
      }),
    );

    expect(
      readOptionPath(readYomitanOptions(), 'scanning.inputs'),
    ).toHaveLength(1);
    expect(container.querySelectorAll('.entei-module-input-card')).toHaveLength(
      1,
    );
  });

  it('shows unified option rows across all cards including mouse and persists single pointer type', () => {
    const { container } = renderSettings();
    openScanning();

    const mouseCard = scanInputCard(container, 0);
    expect(within(mouseCard).getByText(COPY.scanning.scanOn)).toBeTruthy();
    expect(within(mouseCard).getByText(COPY.scanning.searchFor)).toBeTruthy();
    expect(within(mouseCard).getByText(COPY.scanning.preventScrolling)).toBeTruthy();
    expect(
      within(mouseCard).getByText(COPY.scanning.minimumTouchTime),
    ).toBeTruthy();
    expect(
      within(scanInputCard(container, 1)).getByText(COPY.scanning.scanOn),
    ).toBeTruthy();

    fireEvent.click(
      within(mouseCard).getByRole('radio', { name: COPY.scanning.touch }),
    );

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
      within(scanInputCard(container, 0)).getByRole('button', {
        name: COPY.scanning.release,
      }),
    );

    // Touch tap/move are in this UI as multiple triggers, so picking release sets it:
    const inputs = readOptionPath(readYomitanOptions(), 'scanning.inputs') as {
      options: Record<string, boolean>;
    }[];
    expect(inputs[0]?.options.scanOnTouchRelease).toBe(true);
    expect(inputs[0]?.options.scanOnTouchPress).toBe(false);
  });
});

describe('ModuleSettingsRenderer — manifest-laid-out Popup Behavior & Position & Size sections', () => {
  const POPUP_BEHAVIOR_LABELS = [
    'Allow scanning search page content',
    'Allow scanning popup content',
    'Maximum number of child popups',
    'Allow scanning popup source terms',
    'Auto-hide search popup',
    'Auto-hide Delay (in ms)',
    'Hide popup on cursor exit',
    'Reduced motion scrolling',
    'Show iframe popups in the root frame',
  ];

  const POSITION_SIZE_LABELS = [
    'Display mode',
    'Popup position',
    'Scale',
    'Auto-scale',
    'Size',
    'Horizontal text positioning',
    'Vertical text positioning',
    'Horizontal text offset',
    'Vertical text offset',
  ];

  it('draws only the Yomitan-aligned Popup Behavior rows and removes them from Scanning', () => {
    const { container } = renderSettings();
    openSection(/Popup Behavior/i);
    openSection(/Scanning/i);

    for (const label of POPUP_BEHAVIOR_LABELS) {
      expect(screen.getAllByText(label)).toHaveLength(1);
    }

    const popupSection = container.querySelectorAll('.entei-module-section')[3];
    expect(popupSection?.querySelectorAll('.entei-module-rows')).toHaveLength(1);
    // 7 switches + 2 number inputs (Maximum number of child popups, Delay in ms)
    expect(popupSection?.querySelectorAll('.entei-module-field--switch')).toHaveLength(7);
    expect(popupSection?.querySelectorAll('input[type="number"]')).toHaveLength(2);

    // Claimed scanning fields no longer appear in the Scanning section
    expect(screen.queryByText('Scan on search page')).toBeNull();
    expect(screen.queryByText('Enable popup search')).toBeNull();
    expect(screen.queryByText('Popup nesting max depth')).toBeNull();
    expect(screen.queryByText('Hide delay (ms)')).toBeNull();
    expect(screen.queryByText('Reduced motion scrolling (Scale)')).toBeNull();
  });

  it('draws only the Yomitan-aligned Position & Size rows with descriptor selects and numbers', async () => {
    const { container } = renderSettings();
    openSection(/Position & Size/i);

    for (const label of POSITION_SIZE_LABELS) {
      expect(screen.getAllByText(label)).toHaveLength(1);
    }

    const posSection = container.querySelectorAll('.entei-module-section')[6];
    expect(posSection?.querySelectorAll('.entei-module-rows')).toHaveLength(1);
    // 5 selects (Display mode, Popup position, Scale, Horizontal/Vertical text
    // positioning) + 6 number inputs (Size's Width + Height, and an x/y pair on
    // each of the two text offsets — upstream groups each pair into ONE row).
    expect(posSection?.querySelectorAll('.entei-module-select')).toHaveLength(5);
    expect(posSection?.querySelectorAll('input[type="number"]')).toHaveLength(6);
    expect(posSection?.querySelectorAll('.entei-module-numbers')).toHaveLength(3);
    expect(
      posSection?.querySelectorAll('.entei-module-number-pair-item'),
    ).toHaveLength(6);
    // ...and Auto-scale is one two-choice buttongroup.
    expect(posSection?.querySelectorAll('.entei-choice-group')).toHaveLength(1);
    expect(
      posSection?.querySelectorAll(
        '.entei-choice-group [data-slot="toggle-group-item"]',
      ),
    ).toHaveLength(2);

    const displayTrigger = posSection?.querySelector('.entei-module-select');
    expect(displayTrigger).not.toBeNull();
    fireEvent.click(displayTrigger as Element);
    expect(await screen.findByRole('option', { name: 'Full width' })).toBeTruthy();
  });

  it('offers Scale as upstream percentage choices and writes the choice as a NUMBER', async () => {
    renderSettings();
    openSection(/Position & Size/i);

    /* Upstream's Scale is a percentage select over a numeric option, not a free
       numeric input: the tree stores `popupScalingFactor` as a number, so the
       picked choice must land there as one (the popup preview scales by it). */
    const scaleRow = screen.getByText('Scale').closest('.entei-module-field');
    const scale = scaleRow?.querySelector('.entei-module-select');
    expect(scale).not.toBeNull();
    fireEvent.click(scale as Element);
    expect(await screen.findByRole('option', { name: '25%' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '500%' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: '125%' }));

    expect(
      readOptionPath(readYomitanOptions(), 'general.popupScalingFactor'),
    ).toBe(1.25);
  });

  it('groups popup Size into one Width/Height row that writes numbers', () => {
    renderSettings();
    openSection(/Position & Size/i);

    // Upstream's `Size` row: one label, two mini-labelled pixel inputs.
    const width = screen.getByLabelText('Width');
    const height = screen.getByLabelText('Height');
    expect(width.getAttribute('type')).toBe('number');
    expect(height.getAttribute('type')).toBe('number');
    expect(width.getAttribute('min')).toBe('0');

    fireEvent.change(width, { target: { value: '800' } });
    fireEvent.change(height, { target: { value: '600' } });

    expect(readOptionPath(readYomitanOptions(), 'general.popupWidth')).toBe(800);
    expect(readOptionPath(readYomitanOptions(), 'general.popupHeight')).toBe(600);
  });

  it('writes the Auto-scale toggles and the paired text offsets', () => {
    renderSettings();
    openSection(/Position & Size/i);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom level' }));
    expect(
      readOptionPath(
        readYomitanOptions(),
        'general.popupScaleRelativeToPageZoom',
      ),
    ).toBe(true);
    expect(
      readOptionPath(
        readYomitanOptions(),
        'general.popupScaleRelativeToVisualViewport',
      ),
    ).toBe(true);

    // The offsets are upstream's x/y pairs, one row each.
    const offsetX = screen.getAllByLabelText('x')[0] as HTMLInputElement;
    const offsetY = screen.getAllByLabelText('y')[0] as HTMLInputElement;
    fireEvent.change(offsetX, { target: { value: '25' } });
    fireEvent.change(offsetY, { target: { value: '-5' } });

    expect(
      readOptionPath(readYomitanOptions(), 'general.popupHorizontalOffset'),
    ).toBe(25);
    expect(
      readOptionPath(readYomitanOptions(), 'general.popupVerticalOffset'),
    ).toBe(-5);
  });
});

describe('ModuleSettingsRenderer — host-owned field row', () => {
  /** Jimaku.cc declares its own two-row tree; nothing here names the module. */
  const jimaku = CORE_MODULES.find((module) => module.id === 'jimaku');
  const apiKey = { name: /API key/i };

  function renderJimaku() {
    if (jimaku === undefined) throw new Error('jimaku is not registered');
    return render(<ModuleSettingsRenderer module={jimaku} dict={en} />);
  }

  it('draws a credential row from the manifest, with the host editor its source binds', () => {
    renderJimaku();
    openSection(/JIMAKU\.CC/i);

    // The row's text is the manifest's own; the control is the host's, because
    // the key lives in jimaku's own store rather than in an options tree.
    expect(screen.getByText('API key')).toBeTruthy();
    const input = screen.getByLabelText(apiKey.name);
    expect(input.getAttribute('type')).toBe('password');
    expect(input.getAttribute('placeholder')).toBe(
      'Enter your jimaku.cc API key',
    );
    expect(screen.getByText('No key saved')).toBeTruthy();

    // Autosave: the keystroke lands in the module's store, and the row says so.
    fireEvent.change(input, { target: { value: 'secret-key' } });
    expect(readJimakuPreferences().apiKey).toBe('secret-key');
    expect(screen.getByText('Key saved')).toBeTruthy();
  });

  it('renders every registered module that declares settings through this one call', () => {
    /* The unification itself: the page makes ONE call for every module, so any
       manifest with a tree has to produce a settings surface here — no module is
       special-cased in the page any more. */
    const withSettings = CORE_MODULES.filter(moduleHasSettings);
    expect(withSettings.map((module) => module.id).sort()).toEqual([
      'jimaku',
      'nadeshiko',
      'yomitan',
    ]);
    for (const module of withSettings) {
      const { container } = render(
        <ModuleSettingsRenderer module={module} dict={en} />,
      );
      expect(
        container.querySelectorAll('.entei-module-section').length,
      ).toBeGreaterThan(0);
      cleanup();
    }
  });

  it('falls back to the standard row when no source binds an editor', () => {
    if (jimaku === undefined) throw new Error('jimaku is not registered');
    const { settingsSchema: tree, ...rest } = jimaku;
    const manifest: EnteiModuleManifest = {
      ...rest,
      settingsSchema: tree,
      sectionLayouts: [
        {
          section: 'general',
          rows: [{ layout: 'field', field: 'apiKey' }],
        },
      ],
    };
    render(<ModuleSettingsRenderer module={manifest} dict={en} />);
    openSection(/JIMAKU\.CC/i);

    // Same row, no binding: the standard input, and no saved-state line (there
    // is no store behind it to report on).
    expect(screen.getByText('API key')).toBeTruthy();
    expect(screen.queryByText('No key saved')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });
});

describe('ModuleSettingsRenderer — the shipped Appearance layout', () => {
  /**
   * The one section whose first row is not a setting at all: Yomitan's popup
   * preview. These assertions drive the renderer with the manifest the app
   * actually ships (`CORE_MODULES`), not a synthetic row list, so a row dropped
   * by validation or a field silently left to the generic group walk fails here.
   */
  const APPEARANCE_LABELS = [
    'Theme',
    'Body',
    'Shadow',
    'Action bar appearance',
    'Visibility',
    'Location',
    'Font family',
    'Font size (px)',
    'Line height',
    'Compact glossaries',
    'Compact tags',
    'Show tags for expressions and their readings',
    'Show debug information',
    'Term display style',
    'Frequency display style',
    'Selection indicator style',
    'Pitch accent display styles',
    'Custom popup CSS',
  ];

  function renderShipped() {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    if (yomitan === undefined) throw new Error('yomitan is not registered');
    return render(
      <ModuleSettingsRenderer
        module={{ ...yomitan, showSectionIcons: true }}
        dict={en}
      />,
    );
  }

  it('leads with the host-owned preview and draws every appearance row once', async () => {
    const { container } = renderShipped();
    openSection(/Appearance/i);

    for (const label of APPEARANCE_LABELS) {
      expect(screen.getAllByText(label)).toHaveLength(1);
    }

    const section = container.querySelectorAll('.entei-module-section')[4];
    expect(section?.querySelectorAll('.entei-module-rows')).toHaveLength(1);
    // 2 paired selects on the Theme row and 2 on Action bar appearance —
    // upstream groups each pair into ONE row, so this is two rows, four controls.
    // The four single-select rows (Compact glossaries, Term display style,
    // Frequency display style, Selection indicator style) add four more.
    expect(section?.querySelectorAll('.entei-module-select')).toHaveLength(8);
    expect(section?.querySelectorAll('.entei-module-selects')).toHaveLength(2);
    expect(
      section?.querySelectorAll('.entei-module-select-pair-item'),
    ).toHaveLength(4);
    // 3 (Compact tags, search tags, debug info) switches: Wanakana is laid out in
    // the Search Window card.
    expect(section?.querySelectorAll('.entei-module-field--switch')).toHaveLength(3);
    // Custom popup CSS is the section's one textarea: the OUTER one is gone.
    expect(section?.querySelectorAll('textarea')).toHaveLength(1);
    expect(section?.querySelectorAll('input[type="number"]')).toHaveLength(1);
    // The pitch-accent group is one multi-select buttongroup of three choices.
    expect(
      section?.querySelectorAll('.entei-choice-group'),
    ).toHaveLength(1);
    expect(
      section?.querySelectorAll(
        '.entei-choice-group [data-slot="toggle-group-item"]',
      ),
    ).toHaveLength(3);

    /* The preview row is a host-owned block, not a bound control. Its frame is
       drawn as soon as the vendored assets have been read (they fail soft to the
       placeholder document outside the desktop app), so the frame is awaited. */
    const preview = section?.querySelector('.entei-yomitan-popup-preview');
    expect(preview).not.toBeNull();
    /* A host-owned BLOCK: the manifest gives it no text, so the row draws none —
       a caption above the card would only repeat what the card shows. */
    expect(preview?.querySelector('.entei-module-field-text')).toBeNull();
    /* The card's own term field is the row's one control (upstream's preview page
       has the same one), and it is the only text input in the section. */
    expect(
      preview?.querySelectorAll('.entei-yomitan-popup-preview-term-input'),
    ).toHaveLength(1);
    expect(preview?.querySelectorAll('input')).toHaveLength(1);
    await waitFor(() =>
      expect(preview?.querySelectorAll('iframe')).toHaveLength(1),
    );
  });

  it('claims every Appearance field, so none is drawn a second time', () => {
    const { container } = renderShipped();
    openSection(/Appearance/i);

    const section = container.querySelectorAll('.entei-module-section')[4];
    // The declared rows replaced the group walk entirely: no group headings.
    expect(section?.querySelectorAll('.entei-module-group')).toHaveLength(0);
  });

  it('moves the action bar knobs out of Popup Behavior into the paired Appearance row', () => {
    renderShipped();
    openSection(/Popup Behavior/i);

    /* Both paths are claimed by the Appearance row, so Popup Behavior's own
       "Action Bar" group is left empty and disappears instead of repeating them. */
    expect(screen.queryByText('Action bar visibility')).toBeNull();
    expect(screen.queryByText('Action bar location')).toBeNull();
    expect(screen.queryByText('Action Bar')).toBeNull();
  });
});

describe('ModuleSettingsRenderer — the shipped Parsing layout', () => {
  /**
   * Upstream Yomitan puts its parser switches and the furigana reading mode in ONE
   * settings section. The descriptor tree this host renders describes them as two
   * sections (parsing + general), so the manifest lays the Parsing section out
   * itself: the rows are the app's own English, and readingMode is CLAIMED here
   * instead of in Appearance, where the tree groups would otherwise leave it. The
   * romaji → kana switch is NOT here any more: it belongs to the input the user
   * types into, so the manifest moved it to the Search Window card (see below).
   * The two parser toggles (internal parser + MeCab) are also left OUT of the
   * UI: they keep their upstream defaults, so only the presentation rows are
   * declared here — term spacing + reading mode, plus two more the app pulls in
   * from sibling tree sections: sentenceParsing.scanExtent (from Sentence
   * Parsing) and translation.searchResolution (from Translation). Claiming them
   * here hides their original cards' copies.
   */
  const PARSING_LABELS = [
    'Show space between parsed words',
    'Sentence scanning extent',
    'Lookup resolution',
    'Reading mode',
  ];

  function renderShipped() {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    if (yomitan === undefined) throw new Error('yomitan is not registered');
    return render(
      <ModuleSettingsRenderer
        module={{ ...yomitan, showSectionIcons: true }}
        dict={en}
      />,
    );
  }

  /** The Parsing card's position, read from the rendered (reordered) schema. */
  function parsingIndex(): number {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    if (yomitan === undefined) throw new Error('yomitan is not registered');
    return (yomitan.settingsSchema ?? []).findIndex(
      (section) => section.key === 'parsing',
    );
  }

  it('draws the declared rows once each', () => {
    const { container } = renderShipped();
    // The section is called Parsing; Sentence Parsing is a different card, so the
    // accessible name has to be matched exactly.
    openSection(/^Toggle section: Parsing$/i);

    const section =
      container.querySelectorAll('.entei-module-section')[parsingIndex()];
    expect(section?.querySelectorAll('.entei-module-rows')).toHaveLength(1);
    // The declared rows replaced the group walk entirely: no group headings.
    expect(section?.querySelectorAll('.entei-module-group')).toHaveLength(0);

    for (const label of PARSING_LABELS) {
      expect(screen.getAllByText(label)).toHaveLength(1);
    }
    // The parser toggles are hidden: one switch (term spacing), two comboboxes
    // (lookup resolution + reading mode), one number input (scan extent).
    expect(section?.querySelectorAll('.entei-module-field--switch')).toHaveLength(1);
    expect(section?.querySelectorAll('.entei-module-select')).toHaveLength(2);
    // No stray textarea; the single number input is scan extent.
    expect(section?.querySelectorAll('textarea')).toHaveLength(0);
    expect(section?.querySelectorAll('input[type="number"]')).toHaveLength(1);
  });

  it('keeps the lookup resolution choices in upstream order', () => {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    const parsing = yomitan?.sectionLayouts?.find(
      (layout) => layout.section === 'parsing',
    );
    const resolution = parsing?.rows.find(
      (row) => row.field === 'translation.searchResolution',
    );
    expect(resolution?.label).toBe('Lookup resolution');
    expect(resolution?.options?.map((option) => option.value)).toEqual([
      'letter',
      'word',
    ]);
  });

  it('declares sentence scanning extent with the app\'s own wording', () => {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    const parsing = yomitan?.sectionLayouts?.find(
      (layout) => layout.section === 'parsing',
    );
    const extent = parsing?.rows.find(
      (row) => row.field === 'sentenceParsing.scanExtent',
    );
    expect(extent?.label).toBe('Sentence scanning extent');
    expect(extent?.description).toBe(
      'Adjust how many characters are bidirectionally scanned to form a sentence.',
    );
  });

  it('keeps the reading mode choices in upstream order', () => {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    const parsing = yomitan?.sectionLayouts?.find(
      (layout) => layout.section === 'parsing',
    );
    const reading = parsing?.rows.find((row) => row.field === 'parsing.readingMode');
    expect(reading?.label).toBe('Reading mode');
    expect(reading?.options?.map((option) => option.value)).toEqual([
      'none',
      'hiragana',
      'katakana',
      'romaji',
      'dictionary-reading',
    ]);
  });

  it('leaves Reading mode out of Appearance', () => {
    const { container } = renderShipped();
    openSection(/Appearance/i);
    openSection(/^Toggle section: Parsing$/i);

    // The path lives in the tree's Appearance groups, so a card that did NOT claim
    // it would draw it a second time: it is on the page exactly once, and that one
    // copy is in the Parsing card.
    const sections = container.querySelectorAll('.entei-module-section');
    const appearance = sections[4]?.textContent ?? '';
    const parsing = sections[parsingIndex()]?.textContent ?? '';

    expect(parsing).toContain('Reading mode');
    expect(appearance).not.toContain('Reading mode');
  });

  it('no longer carries the romaji → kana switch', () => {
    const { container } = renderShipped();
    openSection(/^Toggle section: Parsing$/i);

    const parsing =
      container.querySelectorAll('.entei-module-section')[parsingIndex()];
    expect(parsing?.textContent).not.toContain('Automatic kana conversion');
  });

  it('drops Custom outer CSS entirely', () => {
    // No row declares it any more, and Appearance is laid out by the manifest, so
    // the tree group that would otherwise draw it never runs. The popup one stays.
    const { container } = renderShipped();
    openSection(/Appearance/i);

    const appearance = container.querySelectorAll('.entei-module-section')[4];
    expect(appearance?.textContent).not.toContain('Custom outer CSS');
    expect(appearance?.textContent).toContain('Custom popup CSS');
    expect(screen.queryByText('Custom outer CSS')).toBeNull();
  });
});

describe('ModuleSettingsRenderer — the shipped Search Window layout', () => {
  /**
   * Upstream's Search Window section is the EXTENSION's own chrome: the standalone
   * window's Width / Height / Left / Top and its window type and state
   * (`popupWindow.*`), none of which exists in a page of this app. The manifest
   * therefore lays the section out itself and shows only the three switches that
   * DO mean something here — the pinned search header, the romaji → kana
   * conversion of the search field, and the clipboard monitor.
   */
  const SEARCH_WINDOW_LABELS = [
    'Sticky search header',
    'Automatic kana conversion',
    'Clipboard monitor',
  ];

  /** The extension-only rows that must not survive the layout. */
  const EXTENSION_ONLY_LABELS = [
    'Width (px)',
    'Height (px)',
    'Left (px)',
    'Top (px)',
    'Window type',
    'Window state',
  ];

  function renderShipped() {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    if (yomitan === undefined) throw new Error('yomitan is not registered');
    return render(
      <ModuleSettingsRenderer
        module={{ ...yomitan, showSectionIcons: true }}
        dict={en}
      />,
    );
  }

  /** The Search Window card's position, read from the tree rather than hard-coded. */
  function searchWindowIndex(): number {
    return yomitanSettingsTree.findIndex(
      (section) => section.key === 'search-window',
    );
  }

  function searchWindow(container: HTMLElement): Element | undefined {
    return container.querySelectorAll('.entei-module-section')[
      searchWindowIndex()
    ];
  }

  it('draws the three declared rows once each, with no group walk left', () => {
    const { container } = renderShipped();
    openSection(/^Toggle section: Search Window$/i);

    const section = searchWindow(container);
    expect(section?.querySelectorAll('.entei-module-rows')).toHaveLength(1);
    expect(section?.querySelectorAll('.entei-module-group')).toHaveLength(0);

    for (const label of SEARCH_WINDOW_LABELS) {
      expect(screen.getAllByText(label)).toHaveLength(1);
    }
    // Three switches and nothing else: no dimension inputs in this section.
    expect(section?.querySelectorAll('.entei-module-field--switch')).toHaveLength(
      3,
    );
    expect(section?.querySelectorAll('textarea')).toHaveLength(0);
    expect(section?.querySelectorAll('input[type="number"]')).toHaveLength(0);
    /* The section is re-texted by the same layout: upstream heads it with the
       standalone window's geometry, which is exactly what this card does NOT show. */
    expect(
      section?.querySelector('.entei-module-section-description')?.textContent,
    ).toBe('Search page behavior and settings.');
    expect(screen.queryByText(/Standalone search window dimensions/)).toBeNull();
  });

  it('hides the standalone window geometry everywhere on the page', () => {
    const { container } = renderShipped();
    openSection(/^Toggle section: Search Window$/i);

    for (const label of EXTENSION_ONLY_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
    /* The rows are gone, so the section is the only thing left: the declared rows
       replaced the group walk that would otherwise draw `popupWindow.*`. */
    expect(searchWindow(container)?.textContent).not.toContain('popupWindow');
  });

  it('declares the three rows in the manifest order', () => {
    const rows = (
      CORE_MODULES.find((module) => module.id === 'yomitan')
        ?.sectionLayouts?.find((layout) => layout.section === 'search-window')?.rows ?? []
    ).map((row) => row.field);

    expect(rows).toEqual([
      'general.stickySearchHeader',
      'general.enableWanakana',
      'clipboard.enableSearchPageMonitor',
    ]);
  });

  it('carries the three labels and descriptions upstream does not', () => {
    const layout = CORE_MODULES.find((module) => module.id === 'yomitan')
      ?.sectionLayouts?.find((entry) => entry.section === 'search-window');

    expect(layout?.rows.map((row) => row.label)).toEqual([
      'Sticky search header',
      'Automatic kana conversion',
      'Clipboard monitor',
    ]);
    expect(layout?.rows.map((row) => row.description)).toEqual([
      'Keep the search input header fixed at the top of the search window.',
      'Convert typed romaji to kana (Wanakana).',
      'The query on the search page will be automatically updated with text in the clipboard.',
    ]);
  });

  it('claims the romaji → kana switch, so Parsing and Clipboard lose their copies', () => {
    const { container } = renderShipped();
    openSection(/^Toggle section: Parsing$/i);
    openSection(/^Toggle section: Clipboard$/i);
    openSection(/^Toggle section: Search Window$/i);

    // The path lives in the tree's Parsing and Search Header groups, and the
    // clipboard monitor in Clipboard: a card that did NOT claim them would draw
    // them a second time, so each is on the page exactly once.
    expect(screen.getAllByText('Automatic kana conversion')).toHaveLength(1);
    expect(screen.getAllByText('Clipboard monitor')).toHaveLength(1);
    expect(
      screen.queryByText('Enable Wanakana (romaji → kana)'),
    ).toBeNull();
    expect(screen.queryByText('Enable search page monitor')).toBeNull();

    const sections = container.querySelectorAll('.entei-module-section');
    const searchWindow =
      sections[searchWindowIndex()]?.textContent ?? '';
    expect(searchWindow).toContain('Automatic kana conversion');
    expect(searchWindow).toContain('Clipboard monitor');
  });
});

describe('ModuleSettingsRenderer — a section the manifest turns into a link empty state', () => {
  /**
   * A section whose editor has moved elsewhere in the app (Yomitan's Anki, now on
   * the dedicated Anki page) declares a `link` row: the manifest replaces the
   * section's residual descriptor-tree form with ONE centered card naming the move
   * and a button that navigates to the new home. Nothing here is a setting, so the
   * card claims no field and the old form must not survive.
   */
  function renderAnki(onNavigate?: (target: string) => void) {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    if (yomitan === undefined) throw new Error('yomitan is not registered');
    return render(
      <ModuleSettingsRenderer
        module={{ ...yomitan, showSectionIcons: true }}
        dict={en}
        onNavigate={onNavigate}
      />,
    );
  }

  it('draws the move notice and suppresses the old form entirely', () => {
    const { container } = renderAnki();
    openSection(/Anki/i);

    expect(screen.getByText('Anki settings have moved')).toBeTruthy();
    expect(
      screen.getByText(
        'Anki connection and card profile settings are now managed in the dedicated Anki section.',
      ),
    ).toBeTruthy();
    // The empty-state card is a signpost, not a row: no field control remains.
    const card = container.querySelector('.entei-module-empty-card');
    expect(card).not.toBeNull();
    expect(card?.querySelectorAll('input, textarea, [data-slot="switch"]')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Enable Anki integration' })).toBeNull();
  });

  it('navigates to the declared target group when the button is pressed', () => {
    const onNavigate = vi.fn();
    renderAnki(onNavigate);
    openSection(/Anki/i);

    fireEvent.click(screen.getByRole('button', { name: 'Open Anki Settings' }));
    expect(onNavigate).toHaveBeenCalledWith('anki');
  });
});

describe('ModuleSettingsRenderer — the shipped Result Display layout', () => {
  /**
   * The grouping mode and the dictionaries it merges live in ONE upstream section,
   * so the manifest lays this section out too. Two things are asserted here: the
   * four grouping choices carry upstream's own wording (the descriptor only says
   * Group / Merge / Split / Term), and the dictionary picker under them is the host
   * editor that writes TWO settings at once — the primary dictionary and every
   * per-dictionary secondary-search flag.
   */
  const PICKER = 'Group related terms by dictionaries';

  const RESULT_DISPLAY_LABELS = [
    'Result grouping mode',
    'Average frequencies',
  ];

  function renderShipped() {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    if (yomitan === undefined) throw new Error('yomitan is not registered');
    return render(
      <ModuleSettingsRenderer
        module={{ ...yomitan, showSectionIcons: true }}
        dict={en}
      />,
    );
  }

  /** The Result Display card's position, read from the tree rather than hard-coded. */
  function resultDisplayIndex(): number {
    return yomitanSettingsTree.findIndex(
      (section) => section.key === 'result-display',
    );
  }

  /**
   * A merge-mode tree with two dictionaries installed and neither selected.
   *
   * Stored through the production writer, so the row reads back exactly what a
   * real session would hold. A test run has no dictionary engine, which is why the
   * offered choices come from the options tree itself.
   */
  function storeMergeOptions(): void {
    const base = createDefaultOptions();
    const profile = base.profiles[base.profileCurrent]!;
    const options: Options = {
      ...base,
      profiles: base.profiles.map((entry, index) =>
        index === base.profileCurrent
          ? {
              ...entry,
              options: {
                ...profile.options,
                general: {
                  ...profile.options.general,
                  resultOutputMode: 'merge',
                },
                dictionaries: [
                  createDictionaryOptionEntry('JMdict'),
                  createDictionaryOptionEntry('KANJIDIC2'),
                ],
              },
            }
          : entry,
      ),
    };
    writeYomitanOptions(options);
  }

  /** The stored per-dictionary flags, as the engine reads them. */
  function storedDictionaries(): {
    name: string;
    allowSecondarySearches: boolean;
  }[] {
    return readOptionPath(
      readYomitanOptions(),
      'dictionaries',
    ) as { name: string; allowSecondarySearches: boolean }[];
  }

  it('draws every declared row once, with no group walk left', () => {
    const { container } = renderShipped();
    openSection(/Result Display/i);

    const section =
      container.querySelectorAll('.entei-module-section')[resultDisplayIndex()];
    expect(section?.querySelectorAll('.entei-module-rows')).toHaveLength(1);
    expect(section?.querySelectorAll('.entei-module-group')).toHaveLength(0);

    for (const label of RESULT_DISPLAY_LABELS) {
      expect(screen.getAllByText(label)).toHaveLength(1);
    }
  });

  it('names the grouping choices the way upstream does', () => {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    const mode = yomitan?.sectionLayouts
      ?.find((layout) => layout.section === 'result-display')
      ?.rows.find((row) => row.field === 'general.resultOutputMode');

    expect(mode?.label).toBe('Result grouping mode');
    expect(mode?.description).toBe('Change how related results are grouped.');
    expect(mode?.options).toEqual([
      { value: 'split', label: 'No grouping' },
      { value: 'group', label: 'Group term-reading pairs' },
      { value: 'term', label: 'Group by term' },
      { value: 'merge', label: 'Group related terms' },
    ]);
  });

  it('offers the dictionary picker only for Group related terms', async () => {
    // The default grouping (`group`) ignores both merge settings, so the row would
    // be a control that changes nothing.
    const grouped = renderShipped();
    openSection(/Result Display/i);
    expect(screen.queryByText(PICKER)).toBeNull();
    grouped.unmount();

    storeMergeOptions();
    const merged = renderShipped();
    openSection(/Result Display/i);
    /* Awaited: the row reads the installed dictionary list once on mount, and that
       answer lands a microtask after the render. */
    await waitFor(() => expect(screen.getByText(PICKER)).toBeTruthy());
    expect(
      merged.container.querySelectorAll('.entei-module-tag-select'),
    ).toHaveLength(1);
  });

  it('writes the primary dictionary and the secondary-search flags from one control', async () => {
    storeMergeOptions();
    const { container } = renderShipped();
    openSection(/Result Display/i);

    // Nothing selected: the row reads like an empty select. (Awaited: the
    // installed list lands a microtask after the render.)
    await waitFor(() =>
      expect(screen.getByText('Select dictionaries')).toBeTruthy(),
    );
    const trigger = container.querySelector(
      '.entei-module-tag-select .entei-module-select',
    );
    expect(trigger).not.toBeNull();

    // First pick IS the primary dictionary...
    fireEvent.click(trigger as Element);
    fireEvent.click(await screen.findByRole('option', { name: 'KANJIDIC2' }));
    expect(readOptionPath(readYomitanOptions(), 'general.mainDictionary')).toBe(
      'KANJIDIC2',
    );
    /* Awaited: every write re-reads the installed dictionary list, so the chip is
       a microtask behind the click. */
    await waitFor(() =>
      expect(
        container.querySelectorAll('.entei-module-tag'),
      ).toHaveLength(1),
    );
    expect(
      container
        .querySelectorAll('.entei-module-tag')[0]
        ?.getAttribute('data-role'),
    ).toBe('primary');

    // ...every later one is a secondary search. The dropdown stays open, so a
    // multi-selection is a few clicks rather than a click per dictionary.
    fireEvent.click(screen.getByRole('option', { name: 'JMdict' }));
    expect(readOptionPath(readYomitanOptions(), 'general.mainDictionary')).toBe(
      'KANJIDIC2',
    );
    await waitFor(() =>
      expect(
        container.querySelectorAll('.entei-module-tag'),
      ).toHaveLength(2),
    );
    expect(
      container
        .querySelectorAll('.entei-module-tag')[1]
        ?.getAttribute('data-role'),
    ).toBe('secondary');
    expect(
      storedDictionaries().find((entry) => entry.name === 'JMdict')
        ?.allowSecondarySearches,
    ).toBe(true);
    expect(
      storedDictionaries().find((entry) => entry.name === 'KANJIDIC2')
        ?.allowSecondarySearches,
    ).toBe(false);

    // A chip's × removes that dictionary again; the primary stays the primary.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove JMdict' }));
    await waitFor(() =>
      expect(
        container.querySelectorAll('.entei-module-tag'),
      ).toHaveLength(1),
    );
    expect(
      storedDictionaries().find((entry) => entry.name === 'JMdict')
        ?.allowSecondarySearches,
    ).toBe(false);
  });
});
