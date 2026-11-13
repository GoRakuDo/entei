'use client';

/**
 * DictionaryManager — the Yomitan "Dictionaries" section's real editor.
 * ---------------------------------------------------------------------------
 * The settings tree only describes `dictionaries` as an ARRAY (`Dictionary list`
 * with a "not editable" note), because a dictionary list is CRUD, not a field.
 * This is that CRUD surface:
 *
 * - import: a button + drag & drop, both taking one `.zip`
 * - list: every dictionary in the dictionary database, with its revision and
 *   row count, an enable Switch and a delete button
 * - empty state: what to do when nothing is imported yet
 *
 * Two storages stay separate here, the same split as the store module: the DATA
 * is written to IndexedDB `yomitan-dictionaries` (never `entei.db`), while the
 * enable/disable flags are `options.dictionaries` in the persisted settings
 * tree — so the UI writes toggles through the normal `onChange(nextOptions)`
 * path and talks to the store only for data.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FileArchive, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Options } from '@gorakudo/yomitan-headless/settings';
import { SettingsButton } from '@/components/settings/SettingsButton';
import { Switch } from '@/components/player/ui/switch';
import { readOptionPath, writeOptionPath } from '@/features/yomitan/yomitan-preferences';
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

export interface DictionaryManagerLabels {
  /** Import button label. */
  import: string;
  /** Import button label while an import runs. */
  importing: string;
  /** Drop-zone hint under the button. */
  drop: string;
  /** Empty-state sentence. */
  empty: string;
  /** Prefix of an installed dictionary's metadata line. */
  revision: string;
  /** Entry-count unit. */
  entries: string;
  /** Accessible name prefix for a dictionary's enable switch. */
  enable: string;
  /** Accessible name prefix for a dictionary's delete button. */
  remove: string;
  /** Toast title when an import fails. */
  importFailed: string;
}

export interface DictionaryManagerProps {
  options: Options;
  onChange: (next: Options) => void;
  labels: DictionaryManagerLabels;
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
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [installed, setInstalled] = useState<InstalledDictionary[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);

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
      if (importing) return;
      setImporting(true);
      try {
        const bytes = await file.arrayBuffer();
        const record = await importDictionaryArchive(bytes);
        onChange(
          writeOptionPath(options, 'dictionaries', [
            ...optionEntries.filter((entry) => entry.name !== record.title),
            createDictionaryOptionEntry(record.title),
          ]),
        );
        await refresh();
      } catch (error) {
        toast.error(labels.importFailed, {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setImporting(false);
      }
    },
    [importing, onChange, optionEntries, options, refresh, labels],
  );

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file === undefined) return;
    await runImport(file);
  }

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

  const rows: DictionaryRow[] = buildRows(installed, optionEntries);

  return (
    <div className="entei-dictionary-manager">
      <div
        className={
          dragging
            ? 'entei-dictionary-import entei-dictionary-import--dragging'
            : 'entei-dictionary-import'
        }
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void handleFiles(event.dataTransfer.files);
        }}
      >
        <SettingsButton
          icon={FileArchive}
          disabled={importing}
          onClick={() => inputRef.current?.click()}
        >
          {importing ? labels.importing : labels.import}
        </SettingsButton>
        <p className="entei-dictionary-drop-hint">{labels.drop}</p>
        <input
          ref={inputRef}
          id={inputId}
          className="entei-dictionary-file-input"
          type="file"
          accept=".zip,application/zip"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            void handleFiles(event.target.files);
            // Allow re-picking the same file after a failure.
            event.target.value = '';
          }}
        />
      </div>

      {rows.length === 0 ? (
        <p className="entei-dictionary-empty">{labels.empty}</p>
      ) : (
        <ul className="entei-dictionary-list">
          {rows.map((row) => (
            <li className="entei-dictionary-row" key={row.name}>
              <div className="entei-dictionary-row-text">
                <span className="entei-dictionary-row-name" title={row.name}>
                  {row.name}
                </span>
                <span className="entei-dictionary-row-meta">
                  {labels.revision} {row.version || '—'} ·{' '}
                  {row.entries.toLocaleString()} {labels.entries}
                </span>
              </div>
              <div className="entei-dictionary-row-actions">
                <Switch
                  checked={row.enabled}
                  onCheckedChange={(checked) => handleToggle(row.name, checked)}
                  aria-label={`${labels.enable}: ${row.name}`}
                />
                <button
                  type="button"
                  className="entei-dictionary-delete"
                  aria-label={`${labels.remove}: ${row.name}`}
                  title={labels.remove}
                  onClick={() => void handleDelete(row.name)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
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
    enabled: optionEntries.find((option) => option.name === entry.name)?.enabled === true,
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