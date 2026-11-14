'use client';

/**
 * ModuleItemManager — platform-standard host adapter for module item lists.
 * ---------------------------------------------------------------------------
 * A module's settings often need CRUD over installed items (archives, plugins,
 * packages, models) rather than a simple scalar field. This component acts as
 * the generic adapter between the native backend engine and the shared
 * `ModuleListManager` presentation component.
 *
 * It manages:
 * - Listing installed items from native storage
 * - Live progress tracking during imports
 * - Enabling/disabling individual items
 * - Deleting items with immediate UI feedback and protection
 * - Reordering items by priority
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
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
import { isTauri, onYomitanImportProgress } from '@/features/player/tauri-bridge';
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
  type InstalledDictionary,
} from '@/features/yomitan/dictionary-store';

export interface ModuleItemManagerProps {
  options: Options;
  onChange: (next: Options) => void;
  /** Block title, resolved by the renderer from the manifest's `labelKey`. */
  title?: string;
  /** Block description, resolved from `descriptionKey`. */
  description?: string;
  /** Localized copy of the list layout. */
  copy: ModuleListManagerCopy;
}

/** One rendered row: the installed item plus its persisted option entry. */
interface ModuleItemRow {
  /** Native engine id — what toggle/delete address. */
  id: string;
  name: string;
  version: string;
  enabled: boolean;
}

export function ModuleItemManager({
  options,
  onChange,
  title,
  description,
  copy,
}: ModuleItemManagerProps) {
  const [installedItems, setInstalledItems] = useState<InstalledDictionary[] | null>(null);
  /** Percent of the import running right now, null when none is. */
  const [importProgress, setImportProgress] = useState<number | null>(null);
  /** Whether an import is in flight, for the event handler below. A ref, not
   * state: the handler must not resubscribe (and so miss an event) per import. */
  const importingRef = useRef(false);

  /** Persisted option entries representing item order and toggles. */
  const optionEntries = readItemOptions(options);

  const refresh = useCallback(async () => {
    try {
      setInstalledItems(await listInstalledDictionaries());
    } catch (error) {
      // No engine (browser build) or the database is unreachable: report it as
      // an empty list rather than leaving a permanent skeleton on screen.
      setInstalledItems([]);
      toast.error(copy.loadFailed, {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [copy.loadFailed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* The engine publishes progress as it writes. Subscribed for the lifetime of
     the list (not per import): the row shown is whatever the engine last
     reported, and the import below clears it when its promise settles. */
  useEffect(
    () =>
      onYomitanImportProgress((p) => {
        if (!importingRef.current) return;
        setImportProgress((shown) =>
          shown === null ? p.percent : Math.max(shown, p.percent),
        );
      }),
    [],
  );

  /** Import the picked archive, then mirror it into module options. */
  const runImport = useCallback(
    async (path: string) => {
      importingRef.current = true;
      setImportProgress(0);
      try {
        const record = await importDictionaryFromPath(path);
        onChange(
          writeOptionPath(options, 'dictionaries', [
            ...optionEntries.filter((entry) => entry.name !== record.name),
            createDictionaryOptionEntry(record.name),
          ]),
        );
        await refresh();
      } finally {
        importingRef.current = false;
        setImportProgress(null);
      }
    },
    [onChange, optionEntries, options, refresh],
  );

  async function handleToggle(row: ModuleItemRow, enabled: boolean) {
    await toggleDictionary(row.id, enabled);
    onChange(
      writeOptionPath(
        options,
        'dictionaries',
        setDictionaryEnabled(optionEntries, row.name, enabled),
      ),
    );
  }

  async function handleDelete(row: ModuleItemRow) {
    await deleteDictionary(row.id);
    onChange(
      writeOptionPath(
        options,
        'dictionaries',
        removeDictionaryOption(optionEntries, row.name),
      ),
    );
    await refresh();
  }

  const rows = buildItemRows(installedItems, optionEntries);

  /** Row order IS priority: write it back as the new ordered options. */
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
        key: row.id,
        name: row.name,
        meta: row.version === '' ? '' : `rev.${row.version}`,
        enabled: row.enabled,
      }))}
      copy={copy}
      title={title}
      description={description}
      loading={installedItems === null}
      importProgress={importProgress}
      onImportPath={isTauri() ? runImport : undefined}
      onToggle={(key, enabled) => {
        const row = rows.find((candidate) => candidate.id === key);
        if (row === undefined) return;
        void handleToggle(row, enabled);
      }}
      onRemove={(key) => {
        const row = rows.find((candidate) => candidate.id === key);
        if (row === undefined) return;
        return handleDelete(row);
      }}
      onReorder={handleReorder}
    />
  );
}

/** Coerce persisted options to the typed entry list. */
function readItemOptions(options: Options): DictionaryOptionEntry[] {
  const raw = readOptionPath(options, 'dictionaries');
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is DictionaryOptionEntry => {
    if (typeof entry !== 'object' || entry === null) return false;
    return typeof (entry as { name?: unknown }).name === 'string';
  });
}

/**
 * Merge installed items and persisted options into the displayed order.
 */
function buildItemRows(
  installed: readonly InstalledDictionary[] | null,
  optionEntries: readonly DictionaryOptionEntry[],
): ModuleItemRow[] {
  const stored = new Map((installed ?? []).map((entry) => [entry.name, entry]));
  const rows: ModuleItemRow[] = [];
  const seen = new Set<string>();

  for (const entry of optionEntries) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const record = stored.get(entry.name);
    if (record === undefined) {
      continue;
    }
    rows.push({
      id: record.id,
      name: record.name,
      version: record.version,
      enabled: entry.enabled ?? record.enabled,
    });
  }

  for (const record of installed ?? []) {
    if (seen.has(record.name)) continue;
    seen.add(record.name);
    rows.push({
      id: record.id,
      name: record.name,
      version: record.version,
      enabled: record.enabled,
    });
  }

  return rows;
}
