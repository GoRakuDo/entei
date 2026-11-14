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
 * - while the engine imports, the list's first row is the "IMPORTING n%"
 *   placeholder, and the imported dictionary replaces it when it lands
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { createDefaultOptions } from '@gorakudo/yomitan-headless/settings';
import { DictionaryManager } from '@/components/settings/DictionaryManager';
import { readYomitanOptions } from '@/features/yomitan/yomitan-preferences';

interface InvokeArgs {
  command: string;
  args: Record<string, unknown> | undefined;
}

type EventHandler = (event: {
  event: string;
  id: number;
  payload: unknown;
}) => void;

interface InternalsWindow {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    /** `@tauri-apps/api/event` turns each handler into one of these ids. */
    transformCallback?: (callback: EventHandler) => number;
  };
  __TAURI_EVENT_PLUGIN_INTERNALS__?: {
    unregisterListener: (event: string, eventId: number) => void;
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

/** What the native dialog "returns" and whether the import is held open. */
interface InstallOptions {
  /** Path the native picker hands back (null = the user cancelled). */
  pickedPath?: string;
  /** Settles `yomitan_import_dictionary` when the test says so. */
  importReply?: Promise<unknown>;
}

function installTauri(
  rows: readonly Record<string, unknown>[],
  options: InstallOptions = {},
): { calls: InvokeArgs[]; handlers: EventHandler[] } {
  const calls: InvokeArgs[] = [];
  const handlers: EventHandler[] = [];
  internals().__TAURI_INTERNALS__ = {
    transformCallback: (callback: EventHandler) => {
      handlers.push(callback);
      return handlers.length - 1;
    },
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command.endsWith('yomitan_list_dictionaries')) return [...rows];
      if (command === 'plugin:dialog|open') return options.pickedPath ?? null;
      if (command.endsWith('yomitan_import_dictionary')) {
        return options.importReply ?? summary();
      }
      if (command === 'plugin:event|listen') return 1;
      return null;
    }),
  };
  internals().__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  return { calls, handlers };
}

/** Poll until `check` holds: the event API is imported dynamically. */
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const COPY = {
  import: 'Import',
  importing: 'Importing…',
  importingProgress: 'Importing',
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

afterEach(async () => {
  /* Unmount BEFORE the runtime goes away: the dictionary list's progress
     subscription unlistens through the event plugin's internals, and React runs
     that cleanup when the tree is torn down. */
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  delete internals().__TAURI_INTERNALS__;
  delete internals().__TAURI_EVENT_PLUGIN_INTERNALS__;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('DictionaryManager — native engine wiring', () => {
  it('draws the engine list, not a browser store', async () => {
    const { calls } = installTauri([summary()]);
    renderManager(createDefaultOptions(), () => {});

    expect(await screen.findByText('JMdict')).toBeTruthy();
    expect(screen.getByText('rev.jmdict-3.5.0')).toBeTruthy();
    expect(screen.queryByText(COPY.empty)).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('writes the enable switch to the engine and to options.dictionaries', async () => {
    const { calls } = installTauri([summary()]);
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
    const { calls } = installTauri([summary()]);
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

  it('shows the import progress row while the engine imports, then the dictionary', async () => {
    let release!: (value: unknown) => void;
    const importReply = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const rows: Record<string, unknown>[] = [];
    const { handlers } = installTauri(rows, {
      pickedPath: 'C:/dicts/jmdict.zip',
      importReply,
    });
    renderManager(createDefaultOptions(), () => {});

    // Nothing imported yet: the list would show its empty state.
    expect(await screen.findByText(COPY.empty)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: COPY.import }));

    /* The placeholder appears on the click, before the engine has a bank to
       report: the pick → import round trip is what makes a large dictionary feel
       stuck, so the row must not wait for the first event. */
    expect(await screen.findByText(`${COPY.importingProgress} 0%`)).toBeTruthy();

    // From here on the engine's own event is what moves the row.
    await until(() => handlers.length > 0, 'import progress listener');
    const emit = async (percent: number): Promise<void> => {
      await act(async () => {
        handlers[0]?.({
          event: 'yomitan:import-progress',
          id: 1,
          payload: { percent, current: percent, total: 100 },
        });
      });
    };

    await emit(27);
    expect(await screen.findByText(`${COPY.importingProgress} 27%`)).toBeTruthy();
    // The empty state stands down while something IS happening.
    expect(screen.queryByText(COPY.empty)).toBeNull();
    const bar = screen.getByRole('progressbar', {
      name: COPY.importingProgress,
    });
    expect(bar.getAttribute('aria-valuenow')).toBe('27');
    // A placeholder, not an item: neither control can be used.
    expect(
      screen.queryByRole('switch', { name: `${COPY.enable}: ` }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: `${COPY.remove}: ` })).toBeNull();

    await emit(80);
    expect(screen.getByText(`${COPY.importingProgress} 80%`)).toBeTruthy();
    /* The engine sends each report by two routes (a broadcast and one addressed
       to this window), so the same report — or a late, lower one — arrives more
       than once: the row only ever moves forward. */
    await emit(80);
    expect(screen.getByText(`${COPY.importingProgress} 80%`)).toBeTruthy();
    await emit(41);
    expect(screen.getByText(`${COPY.importingProgress} 80%`)).toBeTruthy();

    // The import lands: the row becomes the dictionary it was importing.
    rows.push(summary());
    release(summary());

    expect(await screen.findByText('JMdict')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText(`${COPY.importingProgress} 80%`)).toBeNull();
    });
    expect(screen.queryByRole('progressbar')).toBeNull();

    /* A report that arrives after its import ended (the engine sends each one by
       two routes, and the last can land late) must not raise the placeholder from
       the dead: the dictionary is installed and nothing is running. */
    await emit(100);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(`${COPY.importingProgress} 100%`)).toBeNull();
  });
});