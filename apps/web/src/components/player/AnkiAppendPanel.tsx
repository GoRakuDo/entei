/**
 * AnkiAppendPanel — AM-6c inline append-to-specific-card panel.
 * ---------------------------------------------------------------------------
 * Renders as a collapsible panel INSIDE MiningPreviewDialog (not a Dialog).
 * Auto-loads current deck notes on expansion; typed search replaces results.
 * Selection is controlled (lifted state) — no internal selectedIds tracking.
 * Abort/cleanup on collapse. No in-panel append button; Send routes from
 * the Mining Preview range dock.
 * --------------------------------------------------------------------------- */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Search, AlertCircle } from 'lucide-react';
import { Button } from '@/components/player/ui/button';
import { Input } from '@/components/player/ui/input';
import { Checkbox } from '@/components/player/ui/checkbox';
import { DataTable } from '@/components/player/ui/data-table';
import type { AnkiNoteInfo } from '@/features/player/anki-export-client';
import type { ColumnDef } from '@tanstack/react-table';

/** Strip HTML tags for safe plain-text display of note field values. */
function stripHtml(html: string): string {
  if (typeof document === 'undefined') return html;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').trim();
}

/**
 * Escape a deck name for safe inclusion in an Anki search query.
 * Wraps in double quotes and escapes internal `\` and `"` per Anki search syntax.
 */
export function escapeAnkiDeckQuery(deckName: string): string {
  const escaped = deckName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `deck:"${escaped}"`;
}

interface AnkiAppendPanelProps {
  open: boolean;
  id?: string;
  dict: {
    appendDialogTitle: string;
    appendDialogDescription: string;
    appendSearchPlaceholder: string;
    appendSearchButton: string;
    appendSearching: string;
    appendNoResults: string;
    appendSearchError: string;
    appendNoteIdLabel: string;
    appendNoteTypeLabel: string;
    appendIncompatibleType: string;
    appendSelectedCount: (count: number) => string;
  };
  savedNoteType: string;
  savedDeck: string;
  sentenceFieldName: string | null;
  onSearch: (query: string) => Promise<AnkiNoteInfo[]>;
  /** Controlled selection state — lifted to parent */
  selectedIds: Set<number>;
  onSelectedIdsChange: (ids: Set<number>) => void;
}

export function AnkiAppendPanel({
  open,
  id,
  dict,
  savedNoteType,
  savedDeck,
  sentenceFieldName,
  onSearch,
  selectedIds,
  onSelectedIdsChange,
}: AnkiAppendPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AnkiNoteInfo[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const prevOpenRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Auto-load current deck notes on expansion
  useEffect(() => {
    if (!open || !savedDeck) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsSearching(true);
    setSearchError(null);
    setResults([]);
    onSelectedIdsChange(new Set());
    setHasSearched(false);
    setQuery('');

    const deckQuery = escapeAnkiDeckQuery(savedDeck);

    (async () => {
      try {
        const notes = await onSearch(deckQuery);
        if (controller.signal.aborted || !mountedRef.current) return;
        const bounded = notes
          .filter((n) => n.noteId > 0)
          .sort((a, b) => b.noteId - a.noteId)
          .slice(0, 100);
        setResults(bounded);
        setHasSearched(true);
      } catch {
        if (controller.signal.aborted || !mountedRef.current) return;
        setSearchError(dict.appendSearchError);
      } finally {
        if (!controller.signal.aborted && mountedRef.current) {
          setIsSearching(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [open, savedDeck, onSearch, dict.appendSearchError, onSelectedIdsChange]);

  // Reset ephemeral state on collapse
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setQuery('');
      setResults([]);
      onSelectedIdsChange(new Set());
      setSearchError(null);
      setHasSearched(false);
    }
  }, [open, onSelectedIdsChange]);

  // Auto-scroll Mining Preview body to reveal panel on expansion
  useEffect(() => {
    if (open && !prevOpenRef.current && panelRef.current) {
      if (typeof panelRef.current.scrollIntoView === 'function') {
        const prefersReducedMotion = window.matchMedia(
          '(prefers-reduced-motion: reduce)',
        ).matches;
        panelRef.current.scrollIntoView({
          behavior: prefersReducedMotion ? 'instant' : 'smooth',
          block: 'nearest',
        });
      }
    }
    prevOpenRef.current = open;
  }, [open]);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsSearching(true);
    setSearchError(null);
    setResults([]);
    onSelectedIdsChange(new Set());
    setHasSearched(true);

    try {
      const notes = await onSearch(q);
      if (controller.signal.aborted) return;
      const bounded = notes
        .filter((n) => n.noteId > 0)
        .sort((a, b) => b.noteId - a.noteId)
        .slice(0, 100);
      setResults(bounded);
    } catch {
      if (controller.signal.aborted) return;
      setSearchError(dict.appendSearchError);
    } finally {
      if (!controller.signal.aborted) {
        setIsSearching(false);
      }
    }
  }, [query, onSearch, dict.appendSearchError, onSelectedIdsChange]);

  // Compatible notes only
  const compatibleResults = useMemo(() => {
    return results.map((note) => ({
      ...note,
      isCompatible: note.modelName === savedNoteType,
      sentencePreview: sentenceFieldName
        ? stripHtml(note.fields[sentenceFieldName]?.value ?? '')
        : '',
    }));
  }, [results, savedNoteType, sentenceFieldName]);

  // TanStack table columns
  const columns = useMemo<
    ColumnDef<(typeof compatibleResults)[number], unknown>[]
  >(
    () => [
      {
        id: 'select',
        size: 40,
        header: ({ table }) => {
          const compatibleRows = table
            .getRowModel()
            .rows.filter((r) => r.original.isCompatible);
          const allCompatibleSelected =
            compatibleRows.length > 0 &&
            compatibleRows.every((r) => r.getIsSelected());
          return (
            <Checkbox
              checked={allCompatibleSelected}
              onCheckedChange={(checked) => {
                const newIds = new Set(selectedIds);
                for (const row of table.getRowModel().rows) {
                  if (row.original.isCompatible) {
                    if (checked) {
                      newIds.add(row.original.noteId);
                    } else {
                      newIds.delete(row.original.noteId);
                    }
                  }
                }
                onSelectedIdsChange(newIds);
              }}
              aria-label="Select all compatible"
            />
          );
        },
        cell: ({ row }) => {
          const note = row.original;
          return (
            <Checkbox
              checked={selectedIds.has(note.noteId)}
              onCheckedChange={() => {
                const newIds = new Set(selectedIds);
                if (newIds.has(note.noteId)) {
                  newIds.delete(note.noteId);
                } else {
                  newIds.add(note.noteId);
                }
                onSelectedIdsChange(newIds);
              }}
              disabled={!note.isCompatible}
              aria-label={`Note ${note.noteId}`}
            />
          );
        },
      },
      {
        accessorKey: 'sentencePreview',
        header: 'Sentence',
        size: 0,
        cell: ({ row }) => {
          const note = row.original;
          return (
            <div className="entei-data-table-sentence">
              {note.sentencePreview || (
                <span className="entei-data-table-empty-sentence">—</span>
              )}
              {!note.isCompatible && (
                <span className="entei-data-table-incompatible-badge">
                  <AlertCircle size={12} aria-hidden />
                  {dict.appendIncompatibleType}
                </span>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: 'modelName',
        header: dict.appendNoteTypeLabel,
        size: 140,
        cell: ({ row }) => (
          <span className="entei-data-table-note-type">
            {row.original.modelName}
          </span>
        ),
      },
      {
        accessorKey: 'noteId',
        header: dict.appendNoteIdLabel,
        size: 90,
        cell: ({ row }) => (
          <span className="entei-data-table-note-id">
            {row.original.noteId}
          </span>
        ),
      },
    ],
    [
      selectedIds,
      onSelectedIdsChange,
      dict.appendIncompatibleType,
      dict.appendNoteTypeLabel,
      dict.appendNoteIdLabel,
    ],
  );

  if (!open) return null;

  const validSelectedCount = Array.from(selectedIds).filter((id) => {
    const note = results.find((r) => r.noteId === id);
    return note && note.modelName === savedNoteType;
  }).length;

  return (
    <div
      ref={panelRef}
      id={id}
      className="entei-append-panel"
      role="region"
      aria-label={dict.appendDialogTitle}
      tabIndex={-1}
    >
      {/* Search bar */}
      <div className="entei-append-panel-search">
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={dict.appendSearchPlaceholder}
          aria-label={dict.appendSearchPlaceholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSearch();
            }
          }}
          disabled={isSearching}
        />
        <Button
          type="button"
          variant="outline"
          onClick={handleSearch}
          disabled={!query.trim() || isSearching}
          aria-label={dict.appendSearchButton}
        >
          <Search size={16} aria-hidden />
          <span>{dict.appendSearchButton}</span>
        </Button>
      </div>

      {/* Data Table */}
      <div className="entei-append-panel-results">
        {searchError && (
          <p className="entei-append-panel-error" role="alert">
            <AlertCircle size={14} aria-hidden />
            {searchError}
          </p>
        )}

        {!searchError && (
          <DataTable
            columns={columns}
            data={compatibleResults}
            pageSize={10}
            isLoading={isSearching}
            loadingContent={dict.appendSearching}
            emptyContent={
              hasSearched && results.length === 0
                ? dict.appendNoResults
                : dict.appendSearching
            }
            aria-label={dict.appendDialogTitle}
            paginationLabels={{
              previous: '←',
              next: '→',
              pageInfo: (page, total) => `${page} / ${total}`,
            }}
          />
        )}
      </div>

      {/* Selection count */}
      {validSelectedCount > 0 && (
        <div className="entei-append-panel-selection-status">
          <span className="entei-append-panel-count" aria-live="polite">
            {dict.appendSelectedCount(validSelectedCount)}
          </span>
        </div>
      )}
    </div>
  );
}
