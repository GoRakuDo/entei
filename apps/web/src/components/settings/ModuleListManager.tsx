'use client';

/**
 * ModuleListManager — the platform's STANDARD "list manager" layout set.
 * ---------------------------------------------------------------------------
 * A module's settings often need CRUD over a list of installed items (import
 * one archive, enable/disable each, delete one) rather than a scalar field. The
 * app provides exactly ONE such layout, here, and a manifest binds a field to
 * it declaratively:
 *
 *   { "field": "dictionaries", "layout": "list-manager",
 *     "source": "yomitan-dictionaries" }
 *
 * Nothing about a concrete module is baked in: rows, labels, the import filter
 * and the callbacks are props, so the same component serves Yomitan's
 * dictionaries today and any other module's list tomorrow. What the manifest
 * names is the DATA SOURCE (host-owned, because only the host can reach the
 * storage) — never the markup.
 *
 * The layout is a toolbar (one import button, right-aligned on desktop where
 * every other settings control sits in the right column) above the list: one
 * row per item, name + metadata on the left, enable Switch and delete on the
 * right. There is no drag & drop target.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useId, useRef, useState } from 'react';
import { FileArchive, Trash2, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { SettingsButton } from '@/components/settings/SettingsButton';
import { Switch } from '@/components/player/ui/switch';

/** One rendered row of the list. */
export interface ModuleListManagerRow {
  /** Stable identity — also what the toggle/delete callbacks receive. */
  key: string;
  /** Primary label (the item's name). */
  name: string;
  /** Optional metadata line under the name (already localized by the caller). */
  meta?: string;
  /** Persisted enable state of this item. */
  enabled: boolean;
}

/** Localized copy for the layout. Every string comes from the caller. */
export interface ModuleListManagerLabels {
  /** Import button label. */
  import: string;
  /** Import button label while an import runs. */
  importing: string;
  /** Empty-state sentence. */
  empty: string;
  /** Accessible name prefix for an item's enable switch. */
  enable: string;
  /** Accessible name prefix for an item's delete button. */
  remove: string;
  /** Toast title when an import fails. */
  importFailed: string;
}

export interface ModuleListManagerProps {
  /** Rows to draw. `loading` decides whether an empty list means "none yet". */
  rows: readonly ModuleListManagerRow[];
  labels: ModuleListManagerLabels;
  /** True while the source is still being read (no empty state yet). */
  loading?: boolean;
  /** File-picker filter for the import button. */
  accept?: string;
  /** Leading toolbar icon (defaults to an archive mark). */
  importIcon?: LucideIcon;
  /**
   * Import one item. A rejection is surfaced as a toast and never escapes:
   * the caller throws with a message, the layout owns the presentation.
   */
  onImport: (file: File) => void | Promise<void>;
  /** Enable/disable a row. Omit for a read-only list (no switches drawn). */
  onToggle?: (key: string, enabled: boolean) => void;
  /** Delete a row. Omit for a list whose items cannot be removed. */
  onRemove?: (key: string) => void | Promise<void>;
}

export function ModuleListManager({
  rows,
  labels,
  loading = false,
  accept = '.zip,application/zip',
  importIcon = FileArchive,
  onImport,
  onToggle,
  onRemove,
}: ModuleListManagerProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const runImport = useCallback(
    async (file: File) => {
      if (importing) return;
      setImporting(true);
      try {
        await onImport(file);
      } catch (error) {
        toast.error(labels.importFailed, {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setImporting(false);
      }
    },
    [importing, onImport, labels],
  );

  return (
    <div className="entei-module-list">
      <div className="entei-module-list-toolbar" aria-busy={importing}>
        <SettingsButton
          icon={importIcon}
          disabled={importing}
          onClick={() => inputRef.current?.click()}
        >
          {importing ? labels.importing : labels.import}
        </SettingsButton>
        {/* Opened by the button only; kept out of the tab order and the a11y
            tree because the button is the labelled control. */}
        <input
          ref={inputRef}
          id={inputId}
          className="entei-module-list-file-input"
          type="file"
          accept={accept}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void runImport(file);
            // Allow re-picking the same file after a failure.
            event.target.value = '';
          }}
        />
      </div>

      {loading ? null : rows.length === 0 ? (
        <p className="entei-module-list-empty">{labels.empty}</p>
      ) : (
        <ul className="entei-module-list-rows">
          {rows.map((row) => (
            <li className="entei-module-list-row" key={row.key}>
              <div className="entei-module-list-row-text">
                <span className="entei-module-list-row-name" title={row.name}>
                  {row.name}
                </span>
                {row.meta !== undefined && row.meta !== '' && (
                  <span className="entei-module-list-row-meta">{row.meta}</span>
                )}
              </div>
              <div className="entei-module-list-row-actions">
                {onToggle !== undefined && (
                  <Switch
                    checked={row.enabled}
                    onCheckedChange={(checked) => onToggle(row.key, checked)}
                    aria-label={`${labels.enable}: ${row.name}`}
                  />
                )}
                {onRemove !== undefined && (
                  <button
                    type="button"
                    className="entei-module-list-remove"
                    aria-label={`${labels.remove}: ${row.name}`}
                    title={labels.remove}
                    onClick={() => void onRemove(row.key)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}