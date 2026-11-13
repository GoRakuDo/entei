/**
 * DictionaryManager tests — the settings list wired to the native engine.
 * ---------------------------------------------------------------------------
 * The dictionary data is Rust (`plugins/tauri-plugin-modules`); this covers the
 * adapter's contract with it, which is the part a regression would break
 * silently:
 *
 * - the list comes from the engine (not from a browser store), newest first
 * - the enable switch writes the engine AND `options.dictionaries`
 * - delete removes the engine row and its option entry
 * - a dictionary with no engine row is not drawn (nothing to toggle or delete)
 * - an option entry with no engine row keeps its place in the persisted order
 *   without appearing as an actionable row
 * - outside the desktop runtime nothing is drawn and no import is offered
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createDefaultOptions } from '@gorakudo/yomitan-headless/settings';
import { DictionaryManager } from '@/components/settings/DictionaryManager';
import { readYomitanOptions } from '@/features/yomitan/yomitan-preferences';

interface InvokeArgs {
  command: string;
  args: Record<string, unknown> | undefined;
}

interface InternalsWindow {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

function internals(): InternalsWindow {
  return globalThis as unknown as InternalsWindow;
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'id-jmdict',
    title: 'JMdict',
    format: 3,
    revision: 'jmdict-3.5.0',
    sequenced: true,
    author: null,
    url: null,
    description: null,
    createdAt: 1_700_000_000_000,
    enabled: true,
    ...overrides,
  };
}

function installTauri(rows: readonly Record<string, unknown>[]): InvokeArgs[] {
  const calls: InvokeArgs[] = [];
  internals().__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command.endsWith('yomitan_list_dictionaries')) return [...rows];
      return null;
    }),
  };
  return calls;
}

const COPY = {
  import: 'Import',
  importing: 'Importing…',
  empty: 'No dictionaries installed.',
  enable: 'Enable',
  remove: 'Remove',
  importFailed: 'Import failed',
  loadFailed: 'Dictionaries could not be read',
  reorder: 'Reorder',
  reorderHint: 'Drag to reorder.',
};

function renderManager(
  options: ReturnType<typeof createDefaultOptions>,
  onChange: (next: ReturnType<typeof createDefaultOptions>) => void,
) {
  return render(
    <DictionaryManager
      options={options}
      onChange={onChange}
      title="Installed dictionaries"
      copy={COPY}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  delete internals().__TAURI_INTERNALS__;
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('DictionaryManager — native engine wiring', () => {
  it('draws the engine list, not a browser store', async () => {
    installTauri([summary()]);
    renderManager(createDefaultOptions(), () => {});

    expect(await screen.findByText('JMdict')).toBeTruthy();
    expect(screen.getByText('rev.jmdict-3.5.0')).toBeTruthy();
    expect(screen.queryByText(COPY.empty)).toBeNull();
  });

  it('writes the enable switch to the engine and to options.dictionaries', async () => {
    const calls = installTauri([summary()]);
    const onChange = vi.fn();
    renderManager(createDefaultOptions(), onChange);

    const toggle = await screen.findByRole('switch', { name: `${COPY.enable}: JMdict` });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(calls).toContainEqual({
        command: 'plugin:modules|yomitan_toggle_dictionary',
        args: { id: 'id-jmdict', enabled: false },
      });
    });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)?.[0] as ReturnType<
      typeof createDefaultOptions
    >;
    expect(
      (next.profiles[0]?.options as { dictionaries: { name: string; enabled: boolean }[] })
        .dictionaries,
    ).toEqual([
      expect.objectContaining({ name: 'JMdict', enabled: false }),
    ]);
  });

  it('deletes the engine row and its option entry', async () => {
    const calls = installTauri([summary()]);
    const options = createDefaultOptions();
    options.profiles[0]!.options.dictionaries = [
      {
        name: 'JMdict',
        alias: '',
        enabled: true,
        allowSecondarySearches: false,
        definitionsCollapsible: 'not-collapsible',
        partsOfSpeechFilter: true,
        useDeinflections: true,
      },
    ] as never;
    const onChange = vi.fn();
    renderManager(options, onChange);

    fireEvent.click(await screen.findByRole('button', { name: `${COPY.remove}: JMdict` }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        command: 'plugin:modules|yomitan_delete_dictionary',
        args: { id: 'id-jmdict' },
      });
    });
    expect(onChange).toHaveBeenCalled();
  });

  it('does not draw an option entry whose dictionary data is gone', async () => {
    installTauri([summary({ id: 'id-other', title: 'Kanjium' })]);
    const options = createDefaultOptions();
    options.profiles[0]!.options.dictionaries = [
      {
        name: 'Gone',
        alias: '',
        enabled: true,
        allowSecondarySearches: false,
        definitionsCollapsible: 'not-collapsible',
        partsOfSpeechFilter: true,
        useDeinflections: true,
      },
    ] as never;
    renderManager(options, () => {});

    expect(await screen.findByText('Kanjium')).toBeTruthy();
    expect(screen.queryByText('Gone')).toBeNull();
  });

  it('keeps an engine dictionary that has no option entry yet, with the engine state', async () => {
    installTauri([summary({ enabled: false })]);
    renderManager(createDefaultOptions(), () => {});

    const toggle = (await screen.findByRole('switch', {
      name: `${COPY.enable}: JMdict`,
    })) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('offers no import and draws no row outside the desktop runtime', async () => {
    delete internals().__TAURI_INTERNALS__;
    renderManager(createDefaultOptions(), () => {});

    await waitFor(() => {
      expect(screen.getByText(COPY.empty)).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: COPY.import })).toBeNull();
    // The persisted options are untouched by a failed read.
    expect(readYomitanOptions().profiles).toHaveLength(1);
  });
});