'use client';

/**
 * DictionaryManager — the `yomitan-dictionaries` list source.
 * ---------------------------------------------------------------------------
 * Yomitan's "Dictionaries" field is not a scalar option: it is CRUD over the
 * dictionary database. This module is the ADAPTER between that store and the
 * platform's standard list layout (`components/settings/ModuleListManager`),
 * which a manifest declares for the field:
 *
 *   { "layout": "list", "field": "dictionaries",
 *     "source": "yomitan-dictionaries" }
 *
 * It owns only what is genuinely Yomitan's: which file to accept, the metadata
 * line wording, and where the state lives. The look, the header, the reorder
 * mechanics and the row markup belong to the shared layout.
 *
 * Two storages stay separate here, the same split as the store module: the DATA
 * is written to IndexedDB `yomitan-dictionaries` (never `entei.db`), while the
 * enable flags AND the priority order live in `options.dictionaries` of the
 * persisted settings tree — so the UI writes them through the normal
 * `onChange(nextOptions)` path and talks to the store only for data.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useState } from 'react';
import type { Options } from '@gorakudo/yomitan-headless/settings';
import {
  ModuleListManager,
  type ModuleListManagerCopy,
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
  orderDictionaryOptions,
  removeDictionaryOption,
  setDictionaryEnabled,
  type DictionaryOptionEntry,
  type InstalledDictionary,
} from '@/features/yomitan/dictionary-store';

export interface DictionaryManagerProps {
  options: Options;
  onChange: (next: Options) => void;
  /** Block title, resolved by the renderer from the manifest's `labelKey`. */
  title?: string;
  /** Block description, resolved from `descriptionKey`. */
  description?: string;
  /** Localized copy of the list layout. */
  copy: ModuleListManagerCopy;
}

/** One rendered row: the stored dictionary plus its persisted toggle state. */
interface DictionaryRow {
  name: string;
  version: string;
  enabled: boolean;
}

export function DictionaryManager({
  options,
  onChange,
  title,
  description,
  copy,
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

  const rows = buildRows(installed, optionEntries);

  /** Row order IS priority: write it back as the new `options.dictionaries`. */
  function handleReorder(from: number, to: number) {
    const names = rows.map((row) => row.name);
    const [moved] = names.splice(from, 1);
    if (moved === undefined) return;
    names.splice(Math.max(0, Math.min(to, names.length)), 0, moved);
    onChange(
      writeOptionPath(
        options,
        'dictionaries',
        orderDictionaryOptions(optionEntries, names),
      ),
    );
  }

  return (
    <ModuleListManager
      rows={rows.map<ModuleListManagerRow>((row) => ({
        key: row.name,
        name: row.name,
        // Yomitan's own metadata line: the dictionary revision, nothing else.
        meta: row.version === '' ? '' : `rev.${row.version}`,
        enabled: row.enabled,
      }))}
      copy={copy}
      title={title}
      description={description}
      loading={installed === null}
      onImport={runImport}
      onToggle={handleToggle}
      onRemove={handleDelete}
      onReorder={handleReorder}
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
 * Merge the two halves into the displayed order.
 *
 * `options.dictionaries` leads, because that array is the priority the user
 * arranged. A dictionary present in the database but absent from it (an import
 * interrupted before the settings write) still lists — appended, switched off —
 * so it can be enabled or removed instead of occupying space invisibly, and a
 * dictionary whose data is gone (the database was cleared under us) keeps its
 * place with no metadata rather than vanishing from the order.
 */
function buildRows(
  installed: readonly InstalledDictionary[] | null,
  optionEntries: readonly DictionaryOptionEntry[],
): DictionaryRow[] {
  const stored = new Map((installed ?? []).map((entry) => [entry.name, entry]));
  const rows: DictionaryRow[] = [];
  const seen = new Set<string>();

  for (const entry of optionEntries) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const record = stored.get(entry.name);
    stored.delete(entry.name);
    rows.push({
      name: entry.name,
      version: record?.version ?? '',
      enabled: entry.enabled,
    });
  }

  for (const record of stored.values()) {
    if (seen.has(record.name)) continue;
    rows.push({
      name: record.name,
      version: record.version,
      enabled: false,
    });
  }
  return rows;
}