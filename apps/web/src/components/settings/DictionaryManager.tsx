'use client';

/**
 * DictionaryManager — the `yomitan-dictionaries` list source.
 * ---------------------------------------------------------------------------
 * Yomitan's "Dictionaries" field is not a scalar option: it is CRUD over the
 * installed dictionaries. This module is the ADAPTER between the NATIVE
 * dictionary engine and the platform's standard list layout
 * (`components/settings/ModuleListManager`), which a manifest declares:
 *
 *   { "layout": "list", "field": "dictionaries",
 *     "source": "yomitan-dictionaries" }
 *
 * It owns only what is genuinely Yomitan's: which archive to accept, the
 * metadata line wording, the live import percent the engine publishes, and
 * where each half of the state lives. The look, the
 * header, the reorder mechanics and the row markup belong to the shared layout.
 *
 * TWO HALVES, still separate on purpose:
 *
 * - DATA (import, enable, delete) is `plugins/tauri-plugin-modules` — a SQLite
 *   dictionary database reached through `features/player/tauri-bridge`. The
 *   engine holds the banks and answers lookups; the browser build has no engine,
 *   so nothing here can import or list without it.
 * - SETTINGS (`options.dictionaries`) keep the per-dictionary flags AND the
 *   priority order, written through the normal `onChange(nextOptions)` path,
 *   because the native engine has no order column and Yomitan merges results in
 *   this array's order. The enable flag is written to both in the same handler,
 *   so the engine (which skips disabled dictionaries on lookup) and the settings
 *   tree never disagree.
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

/** One rendered row: the installed dictionary plus its persisted option entry. */
interface DictionaryRow {
  /** Native engine id — what toggle/delete address. */
  id: string;
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
  /** Percent of the import running right now, null when none is. */
  const [importProgress, setImportProgress] = useState<number | null>(null);
  /** Whether an import is in flight, for the event handler below. A ref, not
   * state: the handler must not resubscribe (and so miss an event) per import. */
  const importing = useRef(false);

  /** `options.dictionaries` — the persisted half of the list. */
  const optionEntries = readDictionaryOptions(options);

  const refresh = useCallback(async () => {
    try {
      setInstalled(await listInstalledDictionaries());
    } catch (error) {
      // No engine (browser build) or the database is unreachable: report it as
      // an empty list rather than leaving a permanent skeleton on screen.
      setInstalled([]);
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
     reported, and the import below clears it when its promise settles.

     The engine sends each report by two routes (an app-wide broadcast and one
     addressed to this window), so one report can arrive twice — and the percent
     only ever moves forward, whichever copy lands last. A report arriving with no
     import in flight is dropped: a placeholder that outlives its import would sit
     above the list claiming work that finished. */
  useEffect(
    () =>
      onYomitanImportProgress((p) => {
        if (!importing.current) return;
        setImportProgress((shown) =>
          shown === null ? p.percent : Math.max(shown, p.percent),
        );
      }),
    [],
  );

  /** Import the picked archive, then mirror it into `options.dictionaries`. */
  const runImport = useCallback(
    async (path: string) => {
      // Zero BEFORE the engine is asked for anything: the placeholder row is on
      // screen the moment the user has picked a file, not once the importer has
      // opened the ZIP, read its central directory and written a first bank.
      importing.current = true;
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
        // The import is over, so the placeholder goes and the new dictionary
        // card takes its place — on failure as well, where a toast reports it.
        // Cleared before the state, so a late event cannot resurrect the row.
        importing.current = false;
        setImportProgress(null);
      }
    },
    [onChange, optionEntries, options, refresh],
  );

  async function handleToggle(row: DictionaryRow, enabled: boolean) {
    await toggleDictionary(row.id, enabled);
    onChange(
      writeOptionPath(
        options,
        'dictionaries',
        setDictionaryEnabled(optionEntries, row.name, enabled),
      ),
    );
  }

  async function handleDelete(row: DictionaryRow) {
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
        key: row.id,
        name: row.name,
        // Yomitan's own metadata line: the dictionary revision, nothing else.
        meta: row.version === '' ? '' : `rev.${row.version}`,
        enabled: row.enabled,
      }))}
      copy={copy}
      title={title}
      description={description}
      loading={installed === null}
      importProgress={importProgress}
      // The engine imports from a PATH, which only the native dialog can produce;
      // a browser has no engine to import into, so it offers no import at all.
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
 * arranged. A dictionary present in the engine but absent from it (an import
 * interrupted before the settings write) still lists — with the engine's own
 * enable state — so it can be enabled or removed instead of occupying space
 * invisibly, and a dictionary whose data is gone (the engine database was
 * replaced under us) keeps its place with no metadata rather than vanishing
 * from the order.
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
    if (record === undefined) {
      // Option entry without engine data: not actionable (no id to toggle or
      // delete), so it is not drawn.
      continue;
    }
    stored.delete(entry.name);
    rows.push({
      id: record.id,
      name: entry.name,
      version: record.version,
      enabled: entry.enabled,
    });
  }

  for (const record of stored.values()) {
    if (seen.has(record.name)) continue;
    rows.push({
      id: record.id,
      name: record.name,
      version: record.version,
      enabled: record.enabled,
    });
  }
  return rows;
}