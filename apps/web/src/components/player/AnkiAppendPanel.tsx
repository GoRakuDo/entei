/**
 * AnkiAppendPanel — AM-6c inline append-to-specific-card panel.
 * ---------------------------------------------------------------------------
 * Renders as a collapsible panel INSIDE MiningPreviewDialog (not a Dialog).
 * Auto-loads current deck notes on expansion; typed search replaces results.
 * Results are pre-filtered to savedNoteType only — all visible rows are
 * selectable. Selection is controlled (lifted state). Abort/cleanup on collapse.
 * No in-panel append button; Send routes from the Mining Preview range dock.
 *
 * AM-6c v2: Word column (from mapped field), Deck column (from cardsInfo),
 *            Card ID column removed.
 * --------------------------------------------------------------------------- */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Search, AlertCircle } from 'lucide-react';
import { Button } from '@/components/player/ui/button';
import { Input } from '@/components/player/ui/input';
import { Checkbox } from '@/components/player/ui/checkbox';
import { DataTable, type RowState } from '@/components/player/ui/data-table';
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

/** A search result row enriched for display. All rows are selectable. */
interface EnrichedNote extends AnkiNoteInfo {
  sentencePreview: string;
  wordPreview: string;
  /** Unique deck names from cardsInfo, sorted deterministically. */
  deckNames: string[];
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
    appendWordLabel: string;
    appendSentenceLabel: string;
    appendDeckLabel: string;
    appendSelectedCount: (count: number) => string;
  };
  savedNoteType: string;
  savedDeck: string;
  sentenceFieldName: string | null;
  /** Semantic word field name from user's Anki field mapping. */
  wordFieldName: string | null;
  onSearch: (query: string) => Promise<AnkiNoteInfo[]>;
  /**
   * Batch-fetch deck names for card IDs via cardsInfo.
   * Returns a Map from cardId → deckName.
   */
  onFetchDeckNames: (
    cardIds: number[],
    signal?: AbortSignal,
  ) => Promise<Map<number, string>>;
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
  wordFieldName,
  onSearch,
  onFetchDeckNames,
  selectedIds,
  onSelectedIdsChange,
}: AnkiAppendPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AnkiNoteInfo[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [deckNameMap, setDeckNameMap] = useState<Map<number, string>>(
    new Map(),
  );
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

  /** Filter + bound + sort raw results to savedNoteType only. */
  const filterAndBound = useCallback(
    (notes: AnkiNoteInfo[], dMap: Map<number, string>): EnrichedNote[] => {
      return notes
        .filter(
          (n) =>
            n.noteId > 0 &&
            n.modelName === savedNoteType &&
            // Strip notes with empty fields entirely
            Object.keys(n.fields).length > 0,
        )
        .sort((a, b) => b.noteId - a.noteId)
        .slice(0, 100)
        .map((note) => {
          // Collect unique deck names from cardsInfo for this note's cards
          const cardIds = note.cards ?? [];
          const uniqueDecks = [
            ...new Set(
              cardIds.map((cid) => dMap.get(cid)).filter(Boolean) as string[],
            ),
          ].sort();

          return {
            ...note,
            sentencePreview: sentenceFieldName
              ? stripHtml(note.fields[sentenceFieldName]?.value ?? '')
              : '',
            wordPreview: wordFieldName
              ? stripHtml(note.fields[wordFieldName]?.value ?? '')
              : '',
            deckNames: uniqueDecks,
          };
        });
    },
    [savedNoteType, sentenceFieldName, wordFieldName],
  );

  /** Fetch deck names for all notes' card IDs in batch. */
  const fetchDeckNamesForNotes = useCallback(
    async (
      notes: AnkiNoteInfo[],
      signal: AbortSignal,
    ): Promise<Map<number, string>> => {
      // Collect all card IDs from all notes
      const allCardIds = notes.flatMap((n) => n.cards ?? []);
      if (allCardIds.length === 0) return new Map();
      try {
        return await onFetchDeckNames(allCardIds, signal);
      } catch {
        // Deck name fetch failure is non-fatal; display without deck info
        return new Map();
      }
    },
    [onFetchDeckNames],
  );

  // Auto-load current deck notes on expansion
  useEffect(() => {
    if (!open || !savedDeck) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsSearching(true);
    setSearchError(null);
    setResults([]);
    setDeckNameMap(new Map());
    onSelectedIdsChange(new Set());
    setHasSearched(false);
    setQuery('');

    const deckQuery = escapeAnkiDeckQuery(savedDeck);

    (async () => {
      try {
        const notes = await onSearch(deckQuery);
        if (controller.signal.aborted || !mountedRef.current) return;
        setResults(notes);
        // Fetch deck names in batch
        const dMap = await fetchDeckNamesForNotes(notes, controller.signal);
        if (controller.signal.aborted || !mountedRef.current) return;
        setDeckNameMap(dMap);
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
  }, [
    open,
    savedDeck,
    onSearch,
    dict.appendSearchError,
    onSelectedIdsChange,
    fetchDeckNamesForNotes,
  ]);

  // Reset ephemeral state on collapse
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setQuery('');
      setResults([]);
      setDeckNameMap(new Map());
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
    setDeckNameMap(new Map());
    onSelectedIdsChange(new Set());
    setHasSearched(true);

    try {
      const notes = await onSearch(q);
      if (controller.signal.aborted || !mountedRef.current) return;
      setResults(notes);
      // Fetch deck names in batch
      const dMap = await fetchDeckNamesForNotes(notes, controller.signal);
      if (controller.signal.aborted || !mountedRef.current) return;
      setDeckNameMap(dMap);
    } catch {
      if (controller.signal.aborted || !mountedRef.current) return;
      setSearchError(dict.appendSearchError);
    } finally {
      if (!controller.signal.aborted && mountedRef.current) {
        setIsSearching(false);
      }
    }
  }, [
    query,
    onSearch,
    dict.appendSearchError,
    onSelectedIdsChange,
    fetchDeckNamesForNotes,
  ]);

  // Pre-filtered results: only savedNoteType rows are displayed
  const filteredResults = useMemo(
    () => filterAndBound(results, deckNameMap),
    [results, deckNameMap, filterAndBound],
  );

  // Row state provider — selected only (no incompatible concept)
  const getRowState = useCallback(
    (_rowIndex: number, original: EnrichedNote): RowState => {
      return { selected: selectedIds.has(original.noteId) };
    },
    [selectedIds],
  );

  // Select-all / indeterminate
  const allSelected =
    filteredResults.length > 0 &&
    filteredResults.every((r) => selectedIds.has(r.noteId));
  const someSelected =
    !allSelected && filteredResults.some((r) => selectedIds.has(r.noteId));

  // TanStack table columns
  const columns = useMemo<ColumnDef<EnrichedNote, unknown>[]>(
    () => [
      {
        id: 'select',
        size: 48,
        header: () => (
          <Checkbox
            checked={
              allSelected ? true : someSelected ? 'indeterminate' : false
            }
            onCheckedChange={(checked) => {
              const newIds = new Set(selectedIds);
              for (const row of filteredResults) {
                if (checked) {
                  newIds.add(row.noteId);
                } else {
                  newIds.delete(row.noteId);
                }
              }
              onSelectedIdsChange(newIds);
            }}
            aria-label="Select all"
          />
        ),
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
              aria-label={`Note ${note.noteId}`}
            />
          );
        },
      },
      {
        accessorKey: 'wordPreview',
        header: dict.appendWordLabel,
        size: 120,
        cell: ({ row }) => (
          <div
            className="entei-data-table-field-preview"
            title={row.original.wordPreview}
          >
            {row.original.wordPreview || (
              <span className="entei-data-table-empty-field">—</span>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'sentencePreview',
        header: dict.appendSentenceLabel,
        size: 0,
        cell: ({ row }) => (
          <div
            className="entei-data-table-field-preview"
            title={row.original.sentencePreview}
          >
            {row.original.sentencePreview || (
              <span className="entei-data-table-empty-field">—</span>
            )}
          </div>
        ),
      },
      {
        id: 'deckNames',
        accessorFn: (row) => row.deckNames.join(', '),
        header: dict.appendDeckLabel,
        size: 140,
        cell: ({ row }) => {
          const decks = row.original.deckNames;
          if (decks.length === 0) {
            return (
              <span className="entei-data-table-note-type">
                <span className="entei-data-table-empty-field">—</span>
              </span>
            );
          }
          const display = decks.join(', ');
          return (
            <span className="entei-data-table-note-type" title={display}>
              {display}
            </span>
          );
        },
      },
    ],
    [
      selectedIds,
      onSelectedIdsChange,
      dict.appendWordLabel,
      dict.appendSentenceLabel,
      dict.appendDeckLabel,
      allSelected,
      someSelected,
      filteredResults,
    ],
  );

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      id={id}
      className="entei-append-panel"
      role="region"
      aria-label={dict.appendDialogTitle}
      tabIndex={-1}
    >
      {/* Search bar — icon-only submit visually attached to input */}
      <div className="entei-append-panel-search">
        <div className="entei-append-panel-search-group">
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
            className="entei-append-panel-search-input"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleSearch}
            disabled={!query.trim() || isSearching}
            aria-label={dict.appendSearchButton}
            className="entei-append-panel-search-btn"
          >
            <Search size={16} aria-hidden />
          </Button>
        </div>
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
            data={filteredResults}
            pageSize={10}
            isLoading={isSearching}
            loadingContent={dict.appendSearching}
            emptyContent={
              hasSearched && filteredResults.length === 0
                ? dict.appendNoResults
                : dict.appendSearching
            }
            getRowState={getRowState}
            ariaLabel={dict.appendDialogTitle}
            footerStart={
              <span
                className="entei-data-table-footer-count"
                aria-live="polite"
              >
                {dict.appendSelectedCount(
                  Array.from(selectedIds).filter((id) =>
                    filteredResults.some((r) => r.noteId === id),
                  ).length,
                )}
              </span>
            }
            paginationLabels={{
              previous: '←',
              next: '→',
              pageInfo: (page, total) => `${page} / ${total}`,
            }}
          />
        )}
      </div>
    </div>
  );
}
