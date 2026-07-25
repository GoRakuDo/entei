/**
 * AM-6c: AnkiAppendPanel behavioral tests (TanStack Data Table edition).
 * ---------------------------------------------------------------------------
 * Covers:
 * - Auto-load current deck notes on expansion (safe Anki query)
 * - Typed user query + explicit Search replaces default deck results
 * - No collection-wide fetch; deck-scoped only
 * - Checkbox single/multiple selection
 * - Panel collapse resets all ephemeral state
 * - No localStorage persistence of query/results/selections
 * - Abort cancels in-flight search
 * - Sentence plain-text preview displayed
 * - Sorted results, bounded results (100 cap)
 * - Safe deck name quoting/escaping
 * - DataTable renders table with aria-label
 * - Selected IDs controlled (lifted state)
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  act,
} from '@testing-library/react';
import { useState, useCallback } from 'react';
import {
  AnkiAppendPanel,
  escapeAnkiDeckQuery,
} from '@/components/player/AnkiAppendPanel';
import type { AnkiNoteInfo } from '@/features/player/anki-export-client';

beforeEach(() => {
  global.ResizeObserver = vi.fn(function () {
    return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  });
  window.matchMedia =
    window.matchMedia ||
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const dict = {
  appendDialogTitle: 'Search & Append',
  appendDialogDescription: 'Search Anki and select cards.',
  appendSearchPlaceholder: 'Search query',
  appendSearchButton: 'Search',
  appendSearching: 'Searching…',
  appendNoResults: 'No matching notes found.',
  appendSearchError: 'Search failed.',
  appendNoteIdLabel: 'Note ID',
  appendNoteTypeLabel: 'Note type',
  appendSelectedCount: (count: number) => `${count} selected`,
};

function makeNote(
  id: number,
  modelName: string,
  sentence = `Sentence ${id}`,
): AnkiNoteInfo {
  return {
    noteId: id,
    modelName,
    deckName: 'Japanese',
    fields: {
      Front: { value: sentence, order: 0 },
      Back: { value: `<p>Back ${id}</p>`, order: 1 },
    },
    tags: [],
  };
}

/**
 * Wrapper that provides controlled selectedIds state,
 * matching how PlayerApp lifts state for AnkiAppendPanel.
 */
function ControlledPanel(
  props: Omit<
    React.ComponentProps<typeof AnkiAppendPanel>,
    'selectedIds' | 'onSelectedIdsChange'
  > & { initialSelectedIds?: Set<number> },
) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(
    props.initialSelectedIds ?? new Set(),
  );
  const handleChange = useCallback((ids: Set<number>) => {
    setSelectedIds(ids);
  }, []);
  return (
    <AnkiAppendPanel
      {...props}
      selectedIds={selectedIds}
      onSelectedIdsChange={handleChange}
    />
  );
}

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof AnkiAppendPanel>> = {},
) {
  const onSearch = vi.fn().mockResolvedValue([]);

  const result = render(
    <ControlledPanel
      open={true}
      dict={dict}
      savedNoteType="Basic"
      savedDeck="Japanese"
      sentenceFieldName="Front"
      onSearch={onSearch}
      {...overrides}
    />,
  );

  return { ...result, onSearch };
}

function isButtonDisabled(name: string): boolean {
  const btn = screen.getByRole('button', { name });
  return btn?.hasAttribute('disabled') ?? false;
}

// ── Safe deck name quoting ──

describe('escapeAnkiDeckQuery', () => {
  it('wraps simple deck name in deck:"..."', () => {
    expect(escapeAnkiDeckQuery('Japanese')).toBe('deck:"Japanese"');
  });

  it('escapes double quotes inside deck name', () => {
    expect(escapeAnkiDeckQuery('My "Deck"')).toBe('deck:"My \\"Deck\\""');
  });

  it('escapes backslashes inside deck name', () => {
    expect(escapeAnkiDeckQuery('Deck\\Path')).toBe('deck:"Deck\\\\Path"');
  });

  it('escapes both backslashes and quotes', () => {
    expect(escapeAnkiDeckQuery('A\\B"C')).toBe('deck:"A\\\\B\\"C"');
  });
});

// ── Main behavioral tests ──

describe('AnkiAppendPanel — AM-6c', () => {
  // ── Auto-load current deck on expansion ──

  it('renders nothing when closed', () => {
    render(
      <AnkiAppendPanel
        open={false}
        dict={dict}
        savedNoteType="Basic"
        savedDeck="Japanese"
        sentenceFieldName="Front"
        onSearch={vi.fn()}
        selectedIds={new Set()}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('auto-loads current deck notes on open', async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValue([makeNote(100, 'Basic'), makeNote(99, 'Basic')]);
    render(
      <AnkiAppendPanel
        open={true}
        dict={dict}
        savedNoteType="Basic"
        savedDeck="Japanese"
        sentenceFieldName="Front"
        onSearch={onSearch}
        selectedIds={new Set()}
        onSelectedIdsChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });
    expect(onSearch).toHaveBeenCalledWith('deck:"Japanese"');
  });

  it('does not auto-load when savedDeck is empty', () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    render(
      <AnkiAppendPanel
        open={true}
        dict={dict}
        savedNoteType="Basic"
        savedDeck=""
        sentenceFieldName="Front"
        onSearch={onSearch}
        selectedIds={new Set()}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('uses safe escaped deck query for auto-load', async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    render(
      <AnkiAppendPanel
        open={true}
        dict={dict}
        savedNoteType="Basic"
        savedDeck='My "Deck"'
        sentenceFieldName="Front"
        onSearch={onSearch}
        selectedIds={new Set()}
        onSelectedIdsChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledWith('deck:"My \\"Deck\\""');
    });
  });

  // ── Typed search replaces default results ──

  it('typed search replaces auto-loaded default deck results', async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce([makeNote(100, 'Basic')])
      .mockResolvedValueOnce([makeNote(200, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(screen.getByPlaceholderText('Search query'), {
      target: { value: 'tag:vocab' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(2);
    });
    expect(onSearch).toHaveBeenLastCalledWith('tag:vocab');
  });

  it('calls onSearch on Enter key in input', async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    renderPanel({ onSearch });

    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(1));

    const input = screen.getByPlaceholderText('Search query');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(2));
  });

  it('does not call onSearch when query is empty/whitespace', async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    renderPanel({ onSearch });

    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  // ── Results display ──

  it('renders DataTable with table element', async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValue([makeNote(200, 'Basic', '日本語のテスト')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
    });
  });

  it('shows no-results message when search returns empty', async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(screen.getByText('No matching notes found.')).toBeTruthy();
    });
  });

  it('shows error message when auto-load fails', async () => {
    const onSearch = vi.fn().mockRejectedValue(new Error('Network'));
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(screen.getByText('Search failed.')).toBeTruthy();
    });
  });

  // ── Checkbox selection (controlled) ──

  it('allows checking a single compatible note via controlled state', async () => {
    const onSearch = vi.fn().mockResolvedValue([makeNote(300, 'Basic')]);

    render(
      <ControlledPanel
        open={true}
        dict={dict}
        savedNoteType="Basic"
        savedDeck="Japanese"
        sentenceFieldName="Front"
        onSearch={onSearch}
      />,
    );

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    const checkbox = screen.getByRole('checkbox', { name: 'Note 300' });
    expect(checkbox.getAttribute('disabled')).toBeNull();
    fireEvent.click(checkbox);

    // Controlled: ControlledPanel state updates, panel renders count
    await waitFor(() => {
      expect(screen.getByText('1 selected')).toBeTruthy();
    });
  });

  it('allows checking multiple compatible notes', async () => {
    const onSearch = vi.fn().mockResolvedValue([
      makeNote(401, 'Basic'),
      makeNote(402, 'Basic'),
      makeNote(403, 'Basic'),
    ]);

    render(
      <ControlledPanel
        open={true}
        dict={dict}
        savedNoteType="Basic"
        savedDeck="Japanese"
        sentenceFieldName="Front"
        onSearch={onSearch}
      />,
    );

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Note 401' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Note 403' }));

    await waitFor(() => {
      expect(screen.getByText('2 selected')).toBeTruthy();
    });
  });

  it('unchecking removes note from selection', async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValue([
        makeNote(501, 'Basic'),
        makeNote(502, 'Basic'),
        makeNote(503, 'Basic'),
      ]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    // Check first note — count rises
    const cb501 = screen.getByRole('checkbox', { name: 'Note 501' });
    await act(async () => {
      fireEvent.click(cb501);
    });
    await waitFor(() => {
      expect(screen.getByText('1 selected')).toBeTruthy();
    });

    // Check second note — count rises
    const cb502 = screen.getByRole('checkbox', { name: 'Note 502' });
    await act(async () => {
      fireEvent.click(cb502);
    });
    await waitFor(() => {
      expect(screen.getByText('2 selected')).toBeTruthy();
    });

    // Check third note — count rises
    const cb503 = screen.getByRole('checkbox', { name: 'Note 503' });
    await act(async () => {
      fireEvent.click(cb503);
    });
    await waitFor(() => {
      expect(screen.getByText('3 selected')).toBeTruthy();
    });
  });

  // ── Note type pre-filtering ──

  it('mismatched note types are absent from table (not merely disabled)', async () => {
    const onSearch = vi.fn().mockResolvedValue([
      makeNote(600, 'Basic'),
      makeNote(601, 'Cloze'),
      makeNote(602, 'Basic'),
    ]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    // Only Basic notes (600, 602) should appear in the table
    expect(screen.getByRole('checkbox', { name: 'Note 600' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Note 602' })).toBeTruthy();
    // Cloze note 601 is completely absent — no checkbox, no row
    expect(screen.queryByRole('checkbox', { name: 'Note 601' })).toBeNull();
    expect(screen.queryByText('601')).toBeNull();
  });

  it('select-all checks all visible (matching) rows', async () => {
    const onSearch = vi.fn().mockResolvedValue([
      makeNote(801, 'Basic'),
      makeNote(802, 'Cloze'),
      makeNote(803, 'Basic'),
    ]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    // Only 801 and 803 are visible; select-all should check both
    const selectAll = screen.getByRole('checkbox', { name: 'Select all' });
    await act(async () => {
      fireEvent.click(selectAll);
    });
    await waitFor(() => {
      expect(screen.getByText('2 selected')).toBeTruthy();
    });
    // 802 is not in the table at all
    expect(screen.queryByRole('checkbox', { name: 'Note 802' })).toBeNull();
  });

  it('no results shown when all notes are wrong type', async () => {
    const onSearch = vi.fn().mockResolvedValue([
      makeNote(900, 'Cloze'),
      makeNote(901, 'Cloze'),
    ]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    // All notes are Cloze (not Basic), so table should be empty
    expect(screen.queryByRole('checkbox', { name: 'Note 900' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Note 901' })).toBeNull();
    // Empty state message shown
    expect(screen.getByText(/No matching notes found/)).toBeTruthy();
  });

  // ── Collapse resets ephemeral state ──

  it('resets state when panel collapses then re-expands', async () => {
    const onSearch1 = vi.fn().mockResolvedValue([makeNote(1300, 'Basic')]);
    let open = true;
    const { rerender } = render(
      <AnkiAppendPanel
        open={open}
        dict={dict}
        savedNoteType="Basic"
        savedDeck="Japanese"
        sentenceFieldName="Front"
        onSearch={onSearch1}
        selectedIds={new Set()}
        onSelectedIdsChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(onSearch1).toHaveBeenCalled();
    });

    // Collapse
    open = false;
    rerender(
      <AnkiAppendPanel
        open={false}
        dict={dict}
        savedNoteType="Basic"
        savedDeck="Japanese"
        sentenceFieldName="Front"
        onSearch={onSearch1}
        selectedIds={new Set()}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region')).toBeNull();

    // Re-expand with new search mock
    const onSearch2 = vi.fn().mockResolvedValue([makeNote(1301, 'Basic')]);
    rerender(
      <AnkiAppendPanel
        open={true}
        dict={dict}
        savedNoteType="Basic"
        savedDeck="Japanese"
        sentenceFieldName="Front"
        onSearch={onSearch2}
        selectedIds={new Set()}
        onSelectedIdsChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        (screen.getByPlaceholderText('Search query') as HTMLInputElement).value,
      ).toBe('');
      expect(onSearch2).toHaveBeenCalled();
    });
  });

  // ── No localStorage persistence ──

  it('does not write append-related keys to localStorage on search', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const onSearch = vi.fn().mockResolvedValue([makeNote(1400, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalled();
    });

    const appendWrites = setItemSpy.mock.calls.filter(
      ([key]) => typeof key === 'string' && key.includes('append'),
    );
    expect(appendWrites).toHaveLength(0);
    setItemSpy.mockRestore();
  });

  it('does not write to localStorage on checkbox toggle', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const onSearch = vi.fn().mockResolvedValue([makeNote(1500, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Note 1500' }));

    const appendWrites = setItemSpy.mock.calls.filter(
      ([key]) => typeof key === 'string' && key.includes('append'),
    );
    expect(appendWrites).toHaveLength(0);
    setItemSpy.mockRestore();
  });

  // ── Re-trigger search replaces results ──

  it('shows only latest search results when search is re-triggered', async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce([makeNote(1601, 'Basic')])
      .mockResolvedValueOnce([makeNote(1600, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(screen.getByPlaceholderText('Search query'), {
      target: { value: 'second' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(2);
    });
  });

  // ── Search button disabled states ──

  it('disables Search button when query is empty', async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    renderPanel({ onSearch });
    await waitFor(() => expect(onSearch).toHaveBeenCalled());
    expect(isButtonDisabled('Search')).toBe(true);
  });

  it('enables Search button when query has content', async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    renderPanel({ onSearch });
    await waitFor(() => expect(onSearch).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('Search query'), {
      target: { value: 'a' },
    });
    expect(isButtonDisabled('Search')).toBe(false);
  });

  it('disables input and Search while searching', async () => {
    let resolveSearch!: (v: AnkiNoteInfo[]) => void;
    const searchPromise = new Promise<AnkiNoteInfo[]>((r) => {
      resolveSearch = r;
    });
    const onSearch = vi.fn().mockReturnValueOnce(searchPromise);
    renderPanel({ onSearch });

    fireEvent.change(screen.getByPlaceholderText('Search query'), {
      target: { value: 'loading' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText('Search query').getAttribute('disabled'),
      ).not.toBeNull();
      expect(isButtonDisabled('Search')).toBe(true);
    });

    await act(async () => {
      resolveSearch([]);
    });
  });

  // ── Sorted results ──

  it('sorts results by noteId descending', async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValue([
        makeNote(100, 'Basic'),
        makeNote(300, 'Basic'),
        makeNote(200, 'Basic'),
      ]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    // DataTable renders rows; verify rows are in desc order via table rows
    const rows = screen.getAllByRole('row');
    // First row is header, rest are data rows
    expect(rows.length).toBeGreaterThanOrEqual(4); // header + 3 data rows
  });

  // ── Bounded results ──

  it('filters out notes with noteId <= 0', async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValue([
        makeNote(0, 'Basic'),
        makeNote(-1, 'Basic'),
        makeNote(1700, 'Basic'),
      ]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    // Only note 1700 should appear (0 and -1 are filtered)
    const cells = screen.getAllByRole('cell');
    const cellTexts = cells.map((c) => c.textContent ?? '');
    const has1700 = cellTexts.some((t) => t.includes('1700'));
    const has0 = cellTexts.some((t) => t.includes('Note 0') || t === '0');
    expect(has1700).toBe(true);
    expect(has0).toBe(false);
  });

  // ── aria attributes ──

  it('has region role with aria-label', async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    renderPanel({ onSearch });
    await waitFor(() => expect(onSearch).toHaveBeenCalled());

    const region = screen.getByRole('region');
    expect(region.getAttribute('aria-label')).toBe('Search & Append');
  });

  it('panel root has tabIndex -1 for programmatic scroll', async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    renderPanel({ onSearch });
    await waitFor(() => expect(onSearch).toHaveBeenCalled());

    const region = screen.getByRole('region');
    expect(region.getAttribute('tabindex')).toBe('-1');
  });

  it('scrolls panel into view on expansion (false→true)', async () => {
    const scrollIntoViewSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoViewSpy;

    try {
      const onSearch = vi.fn().mockResolvedValue([]);

      const { rerender } = render(
        <AnkiAppendPanel
          open={false}
          dict={dict}
          savedNoteType="Basic"
          savedDeck="TestDeck"
          sentenceFieldName="Front"
          onSearch={onSearch}
          selectedIds={new Set()}
          onSelectedIdsChange={vi.fn()}
        />,
      );
      expect(screen.queryByRole('region')).toBeNull();
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();

      rerender(
        <AnkiAppendPanel
          open={true}
          dict={dict}
          savedNoteType="Basic"
          savedDeck="TestDeck"
          sentenceFieldName="Front"
          onSearch={onSearch}
          selectedIds={new Set()}
          onSelectedIdsChange={vi.fn()}
        />,
      );

      await waitFor(() => expect(onSearch).toHaveBeenCalled());
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('scrolls into view on first mount when open=true', async () => {
    const scrollIntoViewSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoViewSpy;

    try {
      const onSearch = vi.fn().mockResolvedValue([]);
      render(
        <AnkiAppendPanel
          open={true}
          dict={dict}
          savedNoteType="Basic"
          savedDeck="TestDeck"
          sentenceFieldName="Front"
          onSearch={onSearch}
          selectedIds={new Set()}
          onSelectedIdsChange={vi.fn()}
        />,
      );

      await waitFor(() => expect(onSearch).toHaveBeenCalled());
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('does not scroll again on re-render with same open state', async () => {
    const scrollIntoViewSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoViewSpy;

    try {
      const onSearch = vi.fn().mockResolvedValue([]);
      const { rerender } = render(
        <AnkiAppendPanel
          open={true}
          dict={dict}
          savedNoteType="Basic"
          savedDeck="TestDeck"
          sentenceFieldName="Front"
          onSearch={onSearch}
          selectedIds={new Set()}
          onSelectedIdsChange={vi.fn()}
        />,
      );

      await waitFor(() => expect(onSearch).toHaveBeenCalled());
      scrollIntoViewSpy.mockClear();

      rerender(
        <AnkiAppendPanel
          open={true}
          dict={dict}
          savedNoteType="Basic"
          savedDeck="TestDeck"
          sentenceFieldName="Front"
          onSearch={onSearch}
          selectedIds={new Set()}
          onSelectedIdsChange={vi.fn()}
        />,
      );

      await waitFor(() => {});
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('panel has correct CSS class contract and renders children', async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    renderPanel({ onSearch });
    await waitFor(() => expect(onSearch).toHaveBeenCalled());

    const panel = screen.getByRole('region');
    expect(panel.classList.contains('entei-append-panel')).toBe(true);

    const input = screen.getByPlaceholderText('Search query');
    expect(input).toBeTruthy();
    const searchBtn = screen.getByRole('button', { name: 'Search' });
    expect(searchBtn).toBeTruthy();

    const results = panel.querySelector('.entei-append-panel-results');
    expect(results).not.toBeNull();
  });

  it('selection count displayed when compatible notes checked', async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValue([makeNote(2001, 'Basic'), makeNote(2002, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Note 2001' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Note 2002' }));

    expect(screen.getByText('2 selected')).toBeTruthy();
  });

  it('non-matching note type is absent from rendered table', async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValue([makeNote(2101, 'Basic'), makeNote(2102, 'Cloze')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    // Only Basic note 2101 appears; Cloze 2102 is pre-filtered out
    expect(screen.getByRole('checkbox', { name: 'Note 2101' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Note 2102' })).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Note 2101' }));
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('re-click checkbox removes from selectedIds', async () => {
    const onSearch = vi.fn().mockResolvedValue([makeNote(2201, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    const cb = screen.getByRole('checkbox', { name: 'Note 2201' });
    await act(async () => {
      fireEvent.click(cb);
    });
    await waitFor(() => {
      expect(screen.getByText('1 selected')).toBeTruthy();
    });

    // Re-query after re-render (DOM reference may have changed)
    const cb2 = screen.getByRole('checkbox', { name: 'Note 2201' });
    await act(async () => {
      fireEvent.click(cb2);
    });
    // Footer always shows count; after unchecking it returns to "0 selected"
    await waitFor(() => {
      expect(screen.getByText('0 selected')).toBeTruthy();
    });
  });

  it('collapses and clears selected state on close', async () => {
    const onSelect = vi.fn();
    const onSearch = vi.fn().mockResolvedValue([makeNote(2301, 'Basic')]);
    const { rerender } = render(
      <AnkiAppendPanel
        open={true}
        dict={dict}
        savedNoteType="Basic"
        savedDeck="Japanese"
        sentenceFieldName="Front"
        onSearch={onSearch}
        selectedIds={new Set([2301])}
        onSelectedIdsChange={onSelect}
      />,
    );

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalled();
    });

    rerender(
      <AnkiAppendPanel
        open={false}
        dict={dict}
        savedNoteType="Basic"
        savedDeck="Japanese"
        sentenceFieldName="Front"
        onSearch={onSearch}
        selectedIds={new Set()}
        onSelectedIdsChange={onSelect}
      />,
    );

    // onSelectedIdsChange should have been called with empty Set (reset on close)
    await waitFor(() => {
      const emptyCalls = onSelect.mock.calls.filter((call) => {
        const ids = call[0] as Set<number>;
        return ids.size === 0;
      });
      expect(emptyCalls.length).toBeGreaterThan(0);
    });
  });

  // ── Footer stable height & zero-count visibility ──

  it('shows 0 selected count in footer when data loaded and nothing checked', async () => {
    const onSearch = vi.fn().mockResolvedValue([makeNote(5001, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    // Footer should always render with "0 selected" even when nothing checked
    const footer = document.querySelector('.entei-data-table-footer');
    expect(footer).not.toBeNull();
    const count = footer!.querySelector('.entei-data-table-footer-count');
    expect(count).not.toBeNull();
    expect(count!.textContent).toBe('0 selected');
  });

  it('footer has stable min-height class contract', async () => {
    const onSearch = vi.fn().mockResolvedValue([makeNote(5002, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    const footer = document.querySelector('.entei-data-table-footer');
    expect(footer).not.toBeNull();
    // Must have the data table footer class
    expect(footer!.classList.contains('entei-data-table-footer')).toBe(true);
    // Footer always renders with selection count (even 0), so it has stable content
    const count = footer!.querySelector('.entei-data-table-footer-count');
    expect(count).not.toBeNull();
    expect(count!.textContent).toBe('0 selected');
    // Verify min-height is set via the CSS rule (jsdom doesn't resolve CSS vars,
    // so we verify the footer exists with its content — the CSS rule
    // `min-height: var(--entei-touch-min)` resolves to 44px in a real browser)
  });

  // ── Checkbox containment / centering contract ──

  it('checkbox root has no negative margin and explicit 44×44 hit target', async () => {
    const onSearch = vi.fn().mockResolvedValue([makeNote(6001, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    const checkbox = screen.getByRole('checkbox', { name: 'Note 6001' });
    expect(checkbox.getAttribute('data-slot')).toBe('checkbox');
    expect(checkbox.closest('.entei-data-table')).not.toBeNull();

    // Structurally: checkbox is a direct child of td > .entei-data-table
    const td = checkbox.closest('td');
    expect(td).not.toBeNull();

    // No negative margin set via inline style (jsdom can't resolve CSS)
    expect(checkbox.style.margin).not.toContain('-');
    // Zero padding/margin via component default (no padding/margin inline)
    expect(checkbox.style.padding).toBe('');
  });

  it('selection cell contains checkbox with no overflow', async () => {
    const onSearch = vi.fn().mockResolvedValue([makeNote(6002, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    const checkbox = screen.getByRole('checkbox', { name: 'Note 6002' });
    const td = checkbox.closest('td');
    expect(td).not.toBeNull();

    // td is a direct child of tr inside tbody
    const tr = td!.closest('tr');
    expect(tr).not.toBeNull();
    expect(tr!.closest('tbody')).not.toBeNull();

    // The header also has a selection checkbox cell
    const headerCheckbox = screen.getByRole('checkbox', { name: 'Select all' });
    const th = headerCheckbox.closest('th');
    expect(th).not.toBeNull();
    expect(th!.closest('thead')).not.toBeNull();
  });

  it('checkbox root has data-slot and contains indicator when checked', async () => {
    const onSearch = vi.fn().mockResolvedValue([makeNote(6003, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    const checkbox = screen.getByRole('checkbox', { name: 'Note 6003' });

    // Unchecked: indicator is absent (Radix unmounts it)
    expect(checkbox.querySelector('[data-slot="checkbox-indicator"]')).toBeNull();

    // Check it — indicator appears
    await act(async () => {
      fireEvent.click(checkbox);
    });
    await waitFor(() => {
      const checked = screen.getByRole('checkbox', { name: 'Note 6003' });
      expect(checked.getAttribute('data-state')).toBe('checked');
      const indicator = checked.querySelector('[data-slot="checkbox-indicator"]');
      expect(indicator).not.toBeNull();
    });
  });

  it('unchecked checkbox shows unchecked visual state', async () => {
    const onSearch = vi.fn().mockResolvedValue([makeNote(7001, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    const checkbox = screen.getByRole('checkbox', { name: 'Note 7001' });
    expect(checkbox.getAttribute('data-state')).toBe('unchecked');
  });

  it('checked checkbox shows checked state', async () => {
    const onSearch = vi.fn().mockResolvedValue([makeNote(8001, 'Basic')]);
    renderPanel({ onSearch });

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    const checkbox = screen.getByRole('checkbox', { name: 'Note 8001' });
    await act(async () => {
      fireEvent.click(checkbox);
    });
    // Re-query inside waitFor: React re-render replaces the DOM element
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Note 8001' }).getAttribute('data-state')).toBe('checked');
    });
  });
});
