/**
 * Dictionary store tests — what the web side still owns.
 * ---------------------------------------------------------------------------
 * - the native engine adapter: exact IPC commands and payload names, and the
 *   summary → settings-row reshaping (no engine → the browser rejection path);
 * - the `options.dictionaries` list transforms that back the enable, delete and
 *   reorder controls.
 *
 * ZIP parsing, bank conversion and glossary media are Rust now
 * (`plugins/tauri-plugin-modules`); their behaviour is covered by
 * `plugins/tauri-plugin-modules/tests/yomitan_dictionary_test.rs`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import {
  createDictionaryOptionEntry,
  deleteDictionary,
  frequencyDictionaryNames,
  importDictionaryFromPath,
  listInstalledDictionaries,
  orderDictionaryOptions,
  readDictionaryStorageUsage,
  removeDictionaryOption,
  setDictionaryEnabled,
  toggleDictionary,
  type DictionaryOptionEntry,
  type InstalledDictionary,
} from '@/features/yomitan/dictionary-store';

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

function installTauri(impl: (command: string) => unknown): InvokeArgs[] {
  const calls: InvokeArgs[] = [];
  internals().__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return impl(command);
    }),
  };
  return calls;
}

const SUMMARY = {
  id: 'a1b2c3',
  title: 'JMdict',
  format: 3,
  revision: 'jmdict-3.5.0',
  sequenced: true,
  author: 'EDRDG',
  url: null,
  description: null,
  createdAt: 1_700_000_000_000,
  enabled: true,
  hasFrequencyData: false,
};

beforeEach(() => {
  installTauri(() => undefined);
});

afterEach(() => {
  delete internals().__TAURI_INTERNALS__;
});

describe('native dictionary engine adapter', () => {
  it('lists dictionaries through the typed command and reshapes each summary', async () => {
    const calls = installTauri(() => [SUMMARY]);

    const installed = await listInstalledDictionaries();

    expect(calls).toEqual([
      { command: 'plugin:modules|yomitan_list_dictionaries', args: {} },
    ]);
    expect(installed).toEqual([
      {
        id: 'a1b2c3',
        name: 'JMdict',
        version: 'jmdict-3.5.0',
        author: 'EDRDG',
        enabled: true,
        importedAt: new Date(1_700_000_000_000).toISOString(),
        hasFrequencyData: false,
      },
    ]);
  });

  it('reports the engine\u2019s storage measurement as-is', async () => {
    const calls = installTauri(() => ({ usage: 486_000_000, quota: 117_000_000_000 }));

    await expect(readDictionaryStorageUsage()).resolves.toEqual({
      usage: 486_000_000,
      quota: 117_000_000_000,
    });
    // The database is a Rust-owned file, so the renderer must ask the engine.
    expect(calls).toEqual([
      { command: 'plugin:modules|yomitan_get_storage_usage', args: {} },
    ]);
  });

  it('reads no engine storage when the engine cannot be reached', async () => {
    installTauri(() => {
      throw new Error('command failed');
    });

    // Unknown, not zero: the meter shows a dash instead of a fabricated figure.
    await expect(readDictionaryStorageUsage()).resolves.toBeNull();
  });

  it('imports from an absolute path (never from bytes)', async () => {
    const calls = installTauri(() => SUMMARY);

    const installed = await importDictionaryFromPath('Z:\\dicts\\jmdict.zip');

    expect(calls).toEqual([
      {
        command: 'plugin:modules|yomitan_import_dictionary',
        args: { zipPath: 'Z:\\dicts\\jmdict.zip' },
      },
    ]);
    expect(installed.name).toBe('JMdict');
  });

  it('toggles and deletes by engine id', async () => {
    const calls = installTauri(() => null);

    await toggleDictionary('a1b2c3', false);
    await deleteDictionary('a1b2c3');

    expect(calls).toEqual([
      {
        command: 'plugin:modules|yomitan_toggle_dictionary',
        args: { id: 'a1b2c3', enabled: false },
      },
      { command: 'plugin:modules|yomitan_delete_dictionary', args: { id: 'a1b2c3' } },
    ]);
  });

  it('rejects outside the desktop runtime (no engine in a browser)', async () => {
    delete internals().__TAURI_INTERNALS__;
    await expect(listInstalledDictionaries()).rejects.toThrow(
      /tauri runtime unavailable/i,
    );
  });
});

describe('options.dictionaries helpers', () => {
  const list: DictionaryOptionEntry[] = [
    { ...createDictionaryOptionEntry('Dict A'), alias: 'A' },
    { ...createDictionaryOptionEntry('Dict B'), enabled: false },
  ];

  it('creates a fully-formed enabled entry', () => {
    expect(createDictionaryOptionEntry('Dict C')).toEqual({
      name: 'Dict C',
      alias: '',
      enabled: true,
      allowSecondarySearches: false,
      definitionsCollapsible: 'not-collapsible',
      partsOfSpeechFilter: true,
      useDeinflections: true,
    });
  });

  it('toggles one dictionary without touching its siblings', () => {
    const next = setDictionaryEnabled(list, 'Dict A', false);
    expect(next[0]?.enabled).toBe(false);
    expect(next[1]?.enabled).toBe(false);
    // The input list is not mutated.
    expect(list[0]?.enabled).toBe(true);
  });

  it('appends an entry for a dictionary missing from the list', () => {
    const next = setDictionaryEnabled(list, 'Dict C', true);
    expect(next).toHaveLength(3);
    expect(next[2]?.name).toBe('Dict C');
  });

  it('removes exactly one entry', () => {
    const next = removeDictionaryOption(list, 'Dict A');
    expect(next.map((entry) => entry.name)).toEqual(['Dict B']);
  });

  it('reorders by display order, keeping every entry and its flags', () => {
    // Row order IS dictionary priority, so a reorder writes this array.
    const next = orderDictionaryOptions(list, ['Dict B', 'Dict A']);
    expect(next.map((entry) => entry.name)).toEqual(['Dict B', 'Dict A']);
    expect(next[1]?.enabled).toBe(true);
    expect(next[0]?.enabled).toBe(false);
    // The input list is not mutated.
    expect(list.map((entry) => entry.name)).toEqual(['Dict A', 'Dict B']);
  });

  it('creates a disabled entry for a name with no entry yet', () => {
    const next = orderDictionaryOptions(list, ['Dict C', 'Dict A']);
    expect(next.map((entry) => entry.name)).toEqual([
      'Dict C',
      'Dict A',
      'Dict B',
    ]);
    expect(next[0]?.enabled).toBe(false);
  });
});
describe('frequency sorting dictionary choices', () => {
  function installed(name: string, hasFrequencyData: boolean): InstalledDictionary {
    return {
      id: name.toLowerCase(),
      name,
      version: 'rev-1',
      enabled: true,
      importedAt: new Date(0).toISOString(),
      hasFrequencyData,
    };
  }

  it('offers only dictionaries that carry frequency metadata', () => {
    const names = frequencyDictionaryNames([
      installed('JMdict', false),
      installed('JPDB Frequency', true),
      installed('KANJIDIC', false),
    ]);
    expect([...names]).toEqual(['JPDB Frequency']);
  });

  it('offers nothing when only word dictionaries are installed (Yomitan parity)', () => {
    // The row still draws its `none` option, exactly like Yomitan with no
    // frequency dictionary installed.
    expect([...frequencyDictionaryNames([installed('JMdict', false)])]).toEqual(
      [],
    );
    expect([...frequencyDictionaryNames([])]).toEqual([]);
  });
});

describe('storage measurement outside the desktop app', () => {
  it('falls back to the browser origin estimate (no engine to ask)', async () => {
    // The file-wide stub installs a Tauri runtime for the IPC tests; this one is
    // the browser path, so the runtime has to go first.
    delete internals().__TAURI_INTERNALS__;
    const estimate = vi.fn(async () => ({ usage: 2048, quota: 8192 }));
    Object.defineProperty(globalThis.navigator, 'storage', {
      value: { estimate },
      configurable: true,
    });

    await expect(readDictionaryStorageUsage()).resolves.toEqual({
      usage: 2048,
      quota: 8192,
    });
    expect(estimate).toHaveBeenCalled();
  });
});
