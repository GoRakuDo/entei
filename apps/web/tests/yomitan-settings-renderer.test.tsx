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
 * - a field the manifest binds through `listFields` is drawn with the app's
 *   standard list layout; the same field without the binding (or with an
 *   unknown `source`) stays on the generic read-only note — nothing is
 *   hard-coded per module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { yomitanSettingsTree } from '@gorakudo/yomitan-headless/settings';
import { YomitanSettingsRenderer } from '@/components/settings/YomitanSettingsRenderer';
import {
  readYomitanOptions,
  writeYomitanOptions,
} from '@/features/yomitan/yomitan-preferences';
import { en } from '@/i18n/locales/en';

const LABELS = {
  notEditable: en.yomitanSettings.notEditable,
  toggleSection: en.yomitanSettings.toggleSection,
  list: en.yomitanSettings.dictionaries,
};

/** Yomitan's own manifest declaration for its installed-item list. */
const DICTIONARY_LIST_BINDING = [
  {
    field: 'dictionaries',
    layout: 'list-manager' as const,
    source: 'yomitan-dictionaries',
  },
];

beforeEach(() => {
  localStorage.clear();
  global.ResizeObserver = vi.fn(function () {
    return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderSettings(
  showSectionIcons = false,
  listFields?: readonly {
    field: string;
    layout: 'list-manager';
    source: string;
  }[],
) {
  const options = readYomitanOptions();
  return render(
    <YomitanSettingsRenderer
      sections={yomitanSettingsTree}
      listFields={listFields}
      showSectionIcons={showSectionIcons}
      options={options}
      onChange={writeYomitanOptions}
      labels={LABELS}
    />,
  );
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
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp('General', 'i') }),
    );
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
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp('General', 'i') }),
    );
    // Every remaining switch is an editable general field (context menu,
    // API, debug) — the master switch is gone.
    const switches = container.querySelectorAll('[data-slot="switch"]');
    expect(switches.length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Enable Yomitan')).toBeNull();
  });
});

describe('YomitanSettingsRenderer — manifest-bound list layout', () => {
  function openDictionaries() {
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp('Dictionaries', 'i') }),
    );
  }

  it('draws the standard list layout for a field the manifest binds', async () => {
    const { container } = renderSettings(false, DICTIONARY_LIST_BINDING);
    openDictionaries();

    // The generic read-only note is gone for this field...
    expect(screen.queryByText(en.yomitanSettings.notEditable)).toBeNull();
    // ...replaced by the import control and its empty state (no dictionaries
    // are installed in a test run: `bun test` has no IndexedDB).
    expect(
      await screen.findByText(en.yomitanSettings.dictionaries.empty),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /import dictionary/i }),
    ).toBeTruthy();
    // The layout set is the generic one, and drag & drop is gone with it.
    expect(
      container.querySelectorAll('.entei-module-field--list .entei-module-list')
        .length,
    ).toBe(1);
    expect(container.querySelectorAll('.entei-module-list-toolbar')).toHaveLength(
      1,
    );
  });

  it('keeps the read-only note when the manifest declares no binding', () => {
    const { container } = renderSettings();
    openDictionaries();

    expect(screen.getByText(en.yomitanSettings.notEditable)).toBeTruthy();
    expect(container.querySelectorAll('.entei-module-list')).toHaveLength(0);
  });

  it('falls back to the read-only note for an unknown data source', () => {
    const { container } = renderSettings(false, [
      { field: 'dictionaries', layout: 'list-manager', source: 'nope' },
    ]);
    openDictionaries();

    expect(screen.getByText(en.yomitanSettings.notEditable)).toBeTruthy();
    expect(container.querySelectorAll('.entei-module-list')).toHaveLength(0);
  });
});
