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
import { yomitanSettingsTree } from '@gorakudo/yomitan-headless/settings';
import { ModuleSettingsRenderer, moduleHasSettings } from '@/components/settings/ModuleSettingsRenderer';
import {
  CORE_MODULES,
  type EnteiModuleManifest,
  type EnteiModuleSectionLayout,
} from '@/features/modules/module-registry';
import {
  readOptionPath,
  readYomitanOptions,
} from '@/modules/yomitan/yomitan-preferences';
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
    'Full-width position',
    'Scale',
    'Width (in pixels)',
    'Height (in pixels)',
    'Horizontal text positioning',
    'Vertical text positioning',
    'Horizontal text offset (px)',
    'Vertical text offset (px)',
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
    // 4 selects (Display mode, Full-width position, Horizontal/Vertical text positioning) + 5 number inputs
    expect(posSection?.querySelectorAll('.entei-module-select')).toHaveLength(4);
    expect(posSection?.querySelectorAll('input[type="number"]')).toHaveLength(5);

    const displayTrigger = posSection?.querySelector('.entei-module-select');
    expect(displayTrigger).not.toBeNull();
    fireEvent.click(displayTrigger as Element);
    expect(await screen.findByRole('option', { name: 'Full width' })).toBeTruthy();
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
    'Reading mode',
    'Frequency display style',
    'Selection indicator style',
    'Pitch accent display styles',
    'Custom popup CSS',
    'Custom outer CSS',
    'Enable Wanakana (romaji → kana)',
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
    // The five single-select rows (Compact glossaries, Term display style, Reading
    // mode, Frequency display style, Selection indicator style) add five more.
    expect(section?.querySelectorAll('.entei-module-select')).toHaveLength(9);
    expect(section?.querySelectorAll('.entei-module-selects')).toHaveLength(2);
    expect(
      section?.querySelectorAll('.entei-module-select-pair-item'),
    ).toHaveLength(4);
    // 1 (Enable Wanakana) + 3 (Compact tags, search tags, debug info) switches.
    expect(section?.querySelectorAll('.entei-module-field--switch')).toHaveLength(4);
    expect(section?.querySelectorAll('textarea')).toHaveLength(2);
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
