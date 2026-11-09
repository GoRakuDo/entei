/**
 * SubtitlePanel virtual-window integration tests.
 * ---------------------------------------------------------------------------
 * The subtitle cue list must mount only the rows near the viewport: a real
 * movie carries thousands of cues and mounting all of them made the panel
 * take seconds to mount — and to remount on every Captions ⇄ Context tab
 * switch.
 *
 * Covered here:
 * - a 3000-cue subtitle mounts a small, bounded number of rows;
 * - the active cue is mounted and scrolled into view even when it starts
 *   outside the mounted window (the DOM row does not exist yet);
 * - the cue array is treated as read-only — the virtualisation never
 *   reorders, drops or rewrites cues (the LazySync contract:
 *   `shiftCuesByOffset` re-indexes ids and drops collapsed cues,
 *   `shiftCuesBySubDelay` rewrites timestamps but keeps the ids);
 * - a LazySync-style re-index (ids renumbered, one cue dropped) still
 *   renders the right rows.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, waitFor } from '@testing-library/react';
import { SubtitlePanel } from '@/components/player/SubtitlePanel';
import type { SubtitleCue } from '@/features/player/subtitle-reader';

/** Build a long subtitle: one cue every two seconds. */
function longCues(count: number): SubtitleCue[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    start: i * 2,
    end: i * 2 + 2,
    text: `cue ${i}`,
  }));
}

function baseProps(cues: SubtitleCue[]) {
  return {
    cues,
    activeCueId: null as number | null,
    onCueClick: vi.fn(),
  };
}

beforeEach(() => {
  global.ResizeObserver = vi.fn(function () {
    return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  });
  window.matchMedia =
    window.matchMedia ||
    vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SubtitlePanel virtual window', () => {
  it('mounts only a bounded number of rows for a 3000-cue subtitle', () => {
    const cues = longCues(3000);
    const { container } = render(<SubtitlePanel {...baseProps(cues)} />);

    const rows = container.querySelectorAll('.entei-subtitle-cue-item');
    expect(rows.length).toBeGreaterThan(0);
    // Without virtualisation this would be 3000 rows (≈24 000 DOM nodes).
    expect(rows.length).toBeLessThan(80);
    expect(container.querySelectorAll('[data-cue-id]').length).toBe(
      rows.length,
    );
  });

  it('starts at the beginning of the list', () => {
    const cues = longCues(3000);
    const { container } = render(<SubtitlePanel {...baseProps(cues)} />);

    const first = container.querySelector<HTMLElement>('[data-cue-index]');
    expect(first?.dataset.cueIndex).toBe('0');
  });

  it('mounts and scrolls to an active cue that starts outside the window', async () => {
    const cues = longCues(3000);
    const props = baseProps(cues);
    const { container, rerender } = render(
      <SubtitlePanel {...props} activeCueId={null} />,
    );

    // The far cue is not mounted yet.
    expect(
      container.querySelector('[data-cue-id="2500"]'),
    ).toBeNull();

    rerender(<SubtitlePanel {...props} activeCueId={2500} />);

    // The auto-scroll must work without the DOM row existing up front:
    // the panel forces the window to contain the cue, then corrects the
    // position against its real geometry.
    await waitFor(() => {
      expect(
        container.querySelector('[data-cue-id="2500"]'),
      ).not.toBeNull();
    });

    // The mounted window stays bounded after the jump.
    expect(
      container.querySelectorAll('.entei-subtitle-cue-item').length,
    ).toBeLessThan(80);
  });

  it('never mutates the cue array', () => {
    const cues = longCues(500);
    const snapshot = JSON.stringify(cues);
    const { rerender } = render(<SubtitlePanel {...baseProps(cues)} />);
    rerender(<SubtitlePanel {...baseProps(cues)} activeCueId={100} />);
    expect(JSON.stringify(cues)).toBe(snapshot);
    expect(cues).toHaveLength(500);
    expect(cues[0]!.id).toBe(0);
  });

  it('renders the right rows after a LazySync-style re-index', async () => {
    const cues = longCues(500);
    const props = baseProps(cues);
    const { container, rerender } = render(
      <SubtitlePanel {...props} activeCueId={null} />,
    );

    // LazySync's shiftCuesByOffset drops a collapsed cue and renumbers the
    // remaining ids: the panel must follow the new array, not the old ids.
    const shifted = cues
      .filter((cue) => cue.id !== 3)
      .map((cue, index) => ({ ...cue, id: index }));

    rerender(
      <SubtitlePanel
        {...props}
        cues={shifted}
        activeCueId={400}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-cue-id="400"]'),
      ).not.toBeNull();
    });

    const rows = container.querySelectorAll('.entei-subtitle-cue-item');
    expect(rows.length).toBeLessThan(80);
    // Every mounted row points at a cue that exists in the new array.
    rows.forEach((row) => {
      const index = Number((row as HTMLElement).dataset.cueIndex);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(shifted.length);
    });
  });
});
