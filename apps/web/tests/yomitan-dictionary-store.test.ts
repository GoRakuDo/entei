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
  importDictionaryFromPath,
  listInstalledDictionaries,
  orderDictionaryOptions,
  removeDictionaryOption,
  setDictionaryEnabled,
  toggleDictionary,
  type DictionaryOptionEntry,
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
      },
    ]);
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