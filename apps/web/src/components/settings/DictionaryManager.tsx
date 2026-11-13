'use client';

/**
 * DictionaryManager — the `yomitan-dictionaries` list source.
 * ---------------------------------------------------------------------------
 * Yomitan's "Dictionaries" field is not a scalar option: it is CRUD over the
 * dictionary database. This module is the ADAPTER between that store and the
 * platform's standard list layout (`components/settings/ModuleListManager`),
 * which the manifest binds to the field:
 *
 *   { "field": "dictionaries", "layout": "list-manager",
 *     "source": "yomitan-dictionaries" }
 *
 * It owns only what is genuinely Yomitan's: which file to accept, the metadata
 * line wording, and where the state lives. The look, the toolbar and the row
 * markup belong to the shared layout.
 *
 * Two storages stay separate here, the same split as the store module: the DATA
 * is written to IndexedDB `yomitan-dictionaries` (never `entei.db`), while the
 * enable/disable flags are `options.dictionaries` in the persisted settings
 * tree — so the UI writes toggles through the normal `onChange(nextOptions)`
 * path and talks to the store only for data.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useState } from 'react';
import type { Options } from '@gorakudo/yomitan-headless/settings';
import {
  ModuleListManager,
  type ModuleListManagerLabels,
  type ModuleListManagerRow,
} from '@/components/settings/ModuleListManager';
import {
  readOptionPath,
  writeOptionPath,
} from '@/features/yomitan/yomitan-preferences';
import {
  createDictionaryOptionEntry,
  deleteDictionary,
  importDictionaryArchive,
  listInstalledDictionaries,
  removeDictionaryOption,
  setDictionaryEnabled,
  type DictionaryOptionEntry,
  type InstalledDictionary,
} from '@/features/yomitan/dictionary-store';

/** Copy for this source: the standard layout labels plus its metadata line. */
export interface YomitanDictionaryListLabels extends ModuleListManagerLabels {
  /** Prefix of an installed dictionary's metadata line. */
  revision: string;
  /** Entry-count unit. */
  entries: string;
}

export interface DictionaryManagerProps {
  options: Options;
  onChange: (next: Options) => void;
  labels: YomitanDictionaryListLabels;
}

/** One rendered row: the stored dictionary plus its persisted toggle state. */
interface DictionaryRow {
  name: string;
  version: string;
  entries: number;
  enabled: boolean;
}

export function DictionaryManager({
  options,
  onChange,
  labels,
}: DictionaryManagerProps) {
  const [installed, setInstalled] = useState<InstalledDictionary[] | null>(null);

  /** `options.dictionaries` — the persisted half of the list. */
  const optionEntries = readDictionaryOptions(options);

  const refresh = useCallback(async () => {
    const rows = await listInstalledDictionaries();
    setInstalled(rows);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runImport = useCallback(
    async (file: File) => {
      const bytes = await file.arrayBuffer();
      const record = await importDictionaryArchive(bytes);
      onChange(
        writeOptionPath(options, 'dictionaries', [
          ...optionEntries.filter((entry) => entry.name !== record.title),
          createDictionaryOptionEntry(record.title),
        ]),
      );
      await refresh();
    },
    [onChange, optionEntries, options, refresh],
  );

  function handleToggle(name: string, enabled: boolean) {
    onChange(
      writeOptionPath(
        options,
        'dictionaries',
        setDictionaryEnabled(optionEntries, name, enabled),
      ),
    );
  }

  async function handleDelete(name: string) {
    await deleteDictionary(name);
    onChange(
      writeOptionPath(
        options,
        'dictionaries',
        removeDictionaryOption(optionEntries, name),
      ),
    );
    await refresh();
  }

  const rows: ModuleListManagerRow[] = buildRows(installed, optionEntries).map(
    (row) => ({
      key: row.name,
      name: row.name,
      meta: `${labels.revision} ${row.version || '—'} · ${row.entries.toLocaleString()} ${labels.entries}`,
      enabled: row.enabled,
    }),
  );

  return (
    <ModuleListManager
      rows={rows}
      labels={labels}
      loading={installed === null}
      onImport={runImport}
      onToggle={handleToggle}
      onRemove={handleDelete}
    />
  );
}

/** `options.dictionaries`, coerced to the typed entry list we write. */
function readDictionaryOptions(options: Options): DictionaryOptionEntry[] {
  const raw = readOptionPath(options, 'dictionaries');
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is DictionaryOptionEntry => {
    if (typeof entry !== 'object' || entry === null) return false;
    return typeof (entry as { name?: unknown }).name === 'string';
  });
}

/**
 * Merge the two halves into what the list shows.
 *
 * A dictionary present in the database but absent from `options.dictionaries`
 * (an import interrupted before the settings write) still lists, switched off,
 * so it can be enabled or removed instead of occupying space invisibly.
 */
function buildRows(
  installed: readonly InstalledDictionary[] | null,
  optionEntries: readonly DictionaryOptionEntry[],
): DictionaryRow[] {
  const stored = installed ?? [];
  const known = new Set(stored.map((entry) => entry.name));
  const rows: DictionaryRow[] = stored.map((entry) => ({
    name: entry.name,
    version: entry.version,
    entries: entry.entries,
    enabled:
      optionEntries.find((option) => option.name === entry.name)?.enabled === true,
  }));
  for (const entry of optionEntries) {
    if (known.has(entry.name)) continue;
    rows.push({
      name: entry.name,
      version: '',
      entries: 0,
      enabled: entry.enabled,
    });
  }
  return rows;
}