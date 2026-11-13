'use client';

/**
 * ModuleListManager — the platform's STANDARD "installed items" layout.
 * ---------------------------------------------------------------------------
 * A module's settings often need CRUD over a list of installed items (import
 * one archive, enable/disable each, delete one, put them in priority order)
 * rather than a scalar field. The app provides exactly ONE such layout, here,
 * and a manifest declares it for a field of its options tree:
 *
 *   { "layout": "list", "field": "dictionaries",
 *     "source": "yomitan-dictionaries" }
 *
 * Nothing about a concrete module is baked in: rows, copy, the import filter,
 * the reorder callback and the CRUD callbacks are props, so the same component
 * serves Yomitan's dictionaries today and any other module's list tomorrow.
 * What the manifest names is the DATA SOURCE (host-owned, because only the host
 * can reach the storage) — never the markup.
 *
 * Copy contract (keys the renderer resolves from the module's copy table):
 * `import`, `importing`, `empty`, `enable`, `remove`, `importFailed`,
 * `loadFailed`, `reorder`, `reorderHint`. The block title/description arrive
 * already resolved (`title` / `description`): this layout owns no strings.
 *
 * Layout: header row — title + description on the left, the import button on
 * the right where every other settings control sits — above the rows, which
 * take the full width. Each row: drag handle (when the source supports
 * reordering), name + metadata, enable switch, delete.
 *
 * TWO IMPORT ROUTES, because a desktop import needs an absolute path the browser
 * cannot produce: `onImportPath` (given) opens the native dialog and hands the
 * picked path to the source, while `onImport` (given) keeps the HTML file input
 * and hands over the `File`. With neither, no import button is drawn — a source
 * that cannot store what the picker returns must not offer it.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useId, useRef, useState } from 'react';
import { FileArchive, GripVertical, Trash2, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { SettingsButton } from '@/components/settings/SettingsButton';
import { Switch } from '@/components/player/ui/switch';
import { isTauri } from '@/features/player/tauri-bridge';
import { acceptToExtensions } from '@/components/player/MediaPicker';

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
export interface ModuleListManagerCopy {
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
  /**
   * Toast title when the source's own data cannot be READ (the layout never
   * draws it: a list that fails to load is the source's failure to report).
   */
  loadFailed: string;
  /** Accessible name prefix for a row's drag handle. */
  reorder: string;
  /** How-to-reorder sentence, the handle's accessible description. */
  reorderHint: string;
}

export interface ModuleListManagerProps {
  /** Rows to draw, in display order (= the list's own priority order). */
  rows: readonly ModuleListManagerRow[];
  /** Resolved copy for this layout. */
  copy: ModuleListManagerCopy;
  /** Block title (the renderer resolves the manifest's `labelKey`). */
  title?: string;
  /** Block description under the title. */
  description?: string;
  /** True while the source is still being read (no empty state yet). */
  loading?: boolean;
  /** File-picker filter for the import button. */
  accept?: string;
  /** Leading toolbar icon (defaults to an archive mark). */
  importIcon?: LucideIcon;
  /**
   * Import one item from a browser `File` (HTML picker route). A rejection is
   * surfaced as a toast and never escapes: the caller throws with a message,
   * the layout owns the presentation. Omit when the source needs a native path.
   */
  onImport?: (file: File) => void | Promise<void>;
  /**
   * Import one item from an absolute path (native dialog route, desktop only).
   * Takes precedence over `onImport`, which stays as the browser fallback.
   */
  onImportPath?: (path: string) => void | Promise<void>;
  /** Enable/disable a row. Omit for a read-only list (no switches drawn). */
  onToggle?: (key: string, enabled: boolean) => void;
  /** Delete a row. Omit for a list whose items cannot be removed. */
  onRemove?: (key: string) => void | Promise<void>;
  /**
   * Move a row to another position (list order = priority). Omit for a list
   * with no meaningful order: no handles are drawn.
   */
  onReorder?: (from: number, to: number) => void;
}

export function ModuleListManager({
  rows,
  copy,
  title,
  description,
  loading = false,
  accept = '.zip,application/zip',
  importIcon = FileArchive,
  onImport,
  onImportPath,
  onToggle,
  onRemove,
  onReorder,
}: ModuleListManagerProps) {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const canImport = onImport !== undefined || onImportPath !== undefined;
  const [importing, setImporting] = useState(false);
  /* Reordering is pointer-driven (mouse, pen AND touch — HTML5 drag & drop
     never fires on touch) with the keyboard as the equivalent path. */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [moved, setMoved] = useState('');
  const pointerId = useRef<number | null>(null);

  const runImport = useCallback(
    async (work: () => void | Promise<void>) => {
      if (importing) return;
      setImporting(true);
      try {
        await work();
      } catch (error) {
        toast.error(copy.importFailed, {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setImporting(false);
      }
    },
    [importing, copy],
  );

  /**
   * Import through the native dialog — the only way to obtain an absolute path
   * in a desktop webview. A cancelled pick imports nothing; a dialog that cannot
   * open falls back to the HTML picker.
   */
  const pickPath = useCallback(async () => {
    if (onImportPath === undefined) return;
    const label = title ?? copy.import;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const extensions = acceptToExtensions(accept);
      const picked = await open({
        multiple: false,
        directory: false,
        title: label,
        ...(extensions.length > 0
          ? { filters: [{ name: label, extensions }] }
          : {}),
      });
      if (typeof picked === 'string' && picked.length > 0) {
        const path = picked;
        await runImport(() => onImportPath(path));
        return;
      }
      // A cancelled native dialog must not fall through to the HTML input.
      if (picked === null) return;
    } catch {
      // Dialog plugin unavailable — fall back to the HTML picker.
    }
    inputRef.current?.click();
  }, [accept, copy.import, onImportPath, runImport, title]);

  const handleClick = useCallback(() => {
    if (onImportPath !== undefined && isTauri()) {
      void pickPath();
      return;
    }
    inputRef.current?.click();
  }, [onImportPath, pickPath]);

  const move = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to > rows.length - 1) return;
      onReorder?.(from, to);
      const row = rows[from];
      if (row !== undefined) setMoved(`${row.name} ${to + 1}/${rows.length}`);
    },
    [onReorder, rows],
  );

  return (
    <div className="entei-module-list">
      {(title !== undefined || description !== undefined) && (
        <div className="entei-module-list-header">
          <div className="entei-module-list-header-text">
            {title !== undefined && title !== '' && (
              <span className="entei-module-list-title">{title}</span>
            )}
            {description !== undefined && description !== '' && (
              <p className="entei-module-list-description">{description}</p>
            )}
          </div>
          <div className="entei-module-list-toolbar" aria-busy={importing}>
            {canImport && (
              <>
                <SettingsButton
                  icon={importIcon}
                  disabled={importing}
                  onClick={handleClick}
                >
                  {importing ? copy.importing : copy.import}
                </SettingsButton>
                {/* Opened by the button only; kept out of the tab order and
                    the a11y tree because the button is the labelled control. */}
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
                    if (file !== undefined && onImport !== undefined) {
                      void runImport(() => onImport(file));
                    }
                    // Allow re-picking the same file after a failure.
                    event.target.value = '';
                  }}
                />
              </>
            )}
          </div>
        </div>
      )}

      {onReorder !== undefined && (
        <p className="entei-sr-only" id={hintId}>
          {copy.reorderHint}
        </p>
      )}
      <p className="entei-sr-only" aria-live="polite">
        {moved}
      </p>

      {loading ? null : rows.length === 0 ? (
        <p className="entei-module-list-empty">{copy.empty}</p>
      ) : (
        <ul className="entei-module-list-rows">
          {rows.map((row, index) => (
            <li
              className={
                dragFrom === index
                  ? 'entei-module-list-row entei-module-list-row--dragging'
                  : 'entei-module-list-row'
              }
              key={row.key}
              data-list-row={index}
            >
              {onReorder !== undefined && (
                <button
                  type="button"
                  className="entei-module-list-handle"
                  aria-label={`${copy.reorder}: ${row.name} (${index + 1}/${rows.length})`}
                  aria-describedby={hintId}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    pointerId.current = event.pointerId;
                    setDragFrom(index);
                    setDragOver(index);
                  }}
                  onPointerMove={(event) => {
                    if (pointerId.current !== event.pointerId) return;
                    if (dragFrom === null || dragOver === null) return;
                    const target =
                      document
                        .elementFromPoint(event.clientX, event.clientY)
                        ?.closest('[data-list-row]')
                        ?.getAttribute('data-list-row') ?? null;
                    const to = target === null ? NaN : Number(target);
                    if (!Number.isInteger(to) || to === dragFrom) return;
                    move(dragFrom, to);
                    setDragFrom(to);
                    setDragOver(to);
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                    pointerId.current = null;
                    setDragFrom(null);
                    setDragOver(null);
                  }}
                  onPointerCancel={() => {
                    pointerId.current = null;
                    setDragFrom(null);
                    setDragOver(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      move(index, index - 1);
                      return;
                    }
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      move(index, index + 1);
                    }
                  }}
                >
                  <GripVertical size={16} aria-hidden="true" />
                </button>
              )}
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
                    aria-label={`${copy.enable}: ${row.name}`}
                  />
                )}
                {onRemove !== undefined && (
                  <button
                    type="button"
                    className="entei-module-list-remove"
                    aria-label={`${copy.remove}: ${row.name}`}
                    title={copy.remove}
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