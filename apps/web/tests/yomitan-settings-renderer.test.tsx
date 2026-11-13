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
 *   header and import action, plain field rows, and the host-measured usage row
 * - a field laid out that way is claimed: it is not drawn twice in its own tree
 *   group
 * - nothing is hard-coded per module: a `list` row with an unknown `source`
 *   stays on the generic read-only note
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { yomitanSettingsTree } from '@gorakudo/yomitan-headless/settings';
import { YomitanSettingsRenderer } from '@/components/settings/YomitanSettingsRenderer';
import { CORE_MODULES } from '@/features/modules/module-registry';
import {
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
  const options = readYomitanOptions();
  return render(
    <YomitanSettingsRenderer
      sections={yomitanSettingsTree}
      sectionLayouts={sectionLayouts}
      showSectionIcons={showSectionIcons}
      options={options}
      onChange={writeYomitanOptions}
      labels={LABELS}
      copy={COPY}
    />,
  );
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

  it('draws the installed-item list with its header and import action', async () => {
    const { container } = renderSettings();
    openDictionaries();

    // Block header: title + description on the left, import on the right.
    expect(screen.getByText(COPY.dictionaries.installedTitle)).toBeTruthy();
    expect(
      screen.getByText(COPY.dictionaries.installedDescription),
    ).toBeTruthy();
    const header = container.querySelector('.entei-module-list-header');
    expect(header).not.toBeNull();
    expect(
      header?.querySelector('.entei-module-list-toolbar button'),
    ).not.toBeNull();

    // The generic read-only note is gone for this field, replaced by the empty
    // state (no dictionaries are installed in a test run: `bun test` has no
    // IndexedDB) and its reorderable rows.
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

    // The select's leading option is the host-resolved `None` (no frequency
    // dictionary chosen); no dictionary is installed in a test run, so it is
    // the only choice. Radix mounts the items when the trigger opens.
    const trigger = container.querySelector('.entei-module-select');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger as Element);
    expect(await screen.findByText(COPY.dictionaries.sortFrequencyNone)).toBeTruthy();
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