/**
 * Component tests for MiningHistoryPanel.
 * ---------------------------------------------------------------------------
 * - Empty state vs unavailable state rendering
 * - Entry list rendering with newest-first order
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MiningHistoryPanel } from '@/components/player/MiningHistoryPanel';
import * as miningHistory from '@/features/player/mining-history';

describe('MiningHistoryPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders empty state when history is empty', async () => {
    vi.spyOn(miningHistory, 'getAllHistoryEntries').mockResolvedValue({
      ok: true,
      entries: [],
    });

    const { findByText } = render(
      <MiningHistoryPanel
        emptyLabel="Empty"
        unavailableLabel="Unavailable"
        sentenceLabel="Sentence"
        rangeLabel="Range"
      />,
    );

    expect(await findByText('Empty')).toBeTruthy();
  });

  it('renders unavailable state when IndexedDB is unavailable', async () => {
    vi.spyOn(miningHistory, 'getAllHistoryEntries').mockResolvedValue({
      ok: false,
      reason: 'unavailable',
    });

    const { findByText } = render(
      <MiningHistoryPanel
        emptyLabel="Empty"
        unavailableLabel="Unavailable"
        sentenceLabel="Sentence"
        rangeLabel="Range"
      />,
    );

    expect(await findByText('Unavailable')).toBeTruthy();
  });

  it('renders entries newest-first', async () => {
    vi.spyOn(miningHistory, 'getAllHistoryEntries').mockResolvedValue({
      ok: true,
      entries: [
        {
          id: '2',
          filename: 'b.jpg',
          rangeStart: 1,
          rangeEnd: 2,
          sentence: 'B',
        },
        {
          id: '1',
          filename: 'a.jpg',
          rangeStart: 0,
          rangeEnd: 1,
          sentence: 'A',
        },
      ],
    });

    const { container } = render(
      <MiningHistoryPanel
        emptyLabel="Empty"
        unavailableLabel="Unavailable"
        sentenceLabel="Sentence"
        rangeLabel="Range"
      />,
    );

    // Wait for async effect to resolve and re-render
    await vi.waitFor(() => {
      const items = container.querySelectorAll('[role="listitem"]');
      expect(items.length).toBe(2);
      expect(items[0]!.textContent).toContain('B');
      expect(items[1]!.textContent).toContain('A');
    });
  });

  it('re-fetches when refreshKey changes', async () => {
    const spy = vi
      .spyOn(miningHistory, 'getAllHistoryEntries')
      .mockResolvedValue({
        ok: true,
        entries: [],
      });

    const { rerender } = render(
      <MiningHistoryPanel
        emptyLabel="Empty"
        unavailableLabel="Unavailable"
        sentenceLabel="Sentence"
        rangeLabel="Range"
        refreshKey={1}
      />,
    );

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    rerender(
      <MiningHistoryPanel
        emptyLabel="Empty"
        unavailableLabel="Unavailable"
        sentenceLabel="Sentence"
        rangeLabel="Range"
        refreshKey={2}
      />,
    );

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
