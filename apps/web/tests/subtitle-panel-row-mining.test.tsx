/**
 * SubtitlePanel row-mining button tests.
 * ---------------------------------------------------------------------------
 * Covers:
 * - Mine button renders for each cue when onMineCue provided.
 * - Mine button absent when onMineCue is not provided.
 * - Mine button click calls onMineCue(targetCue) without calling onCueClick.
 * - Mine button disabled when canMineRow is false.
 * - Mine button disabled when isMining is true.
 * - Localized aria-label and title: normal state uses mineRowLabel.
 * - Localized aria-label and title: disabled state uses mineRowDisabledLabel.
 * - Localized aria-label and title: mining state uses mineCapturingLabel.
 * - stopPropagation: clicking mine button does NOT trigger parent onCueClick.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { SubtitlePanel } from '@/components/player/SubtitlePanel';
import type { SubtitleCue } from '@/features/player/subtitle-reader';

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

const cues: SubtitleCue[] = [
  { id: 1, start: 0, end: 2.5, text: 'Hello world' },
  { id: 2, start: 2.5, end: 5, text: 'Second line' },
  { id: 3, start: 5, end: 8, text: 'Third line' },
];

function baseProps(overrides?: Record<string, unknown>) {
  return {
    cues,
    activeCueId: null,
    onCueClick: vi.fn(),
    onMineCue: vi.fn(),
    canMineRow: true,
    isMining: false,
    mineRowLabel: 'Mine this cue',
    mineRowDisabledLabel: 'Mining unavailable',
    mineCapturingLabel: 'Mining…',
    ...overrides,
  };
}

/** Like baseProps but with no mine wiring (matches the panel props used by
 *  RightPanel for the companion loading state). */
function basePropsForLoading() {
  return {
    cues,
    activeCueId: null,
    onCueClick: vi.fn(),
    onMineCue: vi.fn(),
    canMineRow: false,
    isMining: false,
    mineRowLabel: 'Mine this cue',
    mineRowDisabledLabel: 'Mining unavailable',
    mineCapturingLabel: 'Mining…',
  };
}

/** Minimal props for the empty/loading branches: no mining callbacks. */
function basePropsWithoutMine() {
  return {
    cues,
    activeCueId: null,
    onCueClick: vi.fn(),
  };
}

describe('SubtitlePanel row mining', () => {
  it('renders a mine button for each cue when onMineCue is provided', () => {
    render(<SubtitlePanel {...baseProps()} />);
    const buttons = screen.getAllByRole('button', { name: 'Mine this cue' });
    expect(buttons).toHaveLength(cues.length);
  });

  it('does NOT render mine buttons when onMineCue is absent', () => {
    const { onMineCue: _, ...props } = baseProps();
    render(<SubtitlePanel {...props} />);
    expect(screen.queryByRole('button', { name: /mine/i })).toBeNull();
  });

  it('calls onMineCue(cue) on click without calling onCueClick', () => {
    const props = baseProps();
    render(<SubtitlePanel {...props} />);
    const mineButtons = screen.getAllByRole('button', { name: 'Mine this cue' });

    // Click the first mine button
    fireEvent.click(mineButtons[0]!);

    expect(props.onMineCue).toHaveBeenCalledTimes(1);
    expect(props.onMineCue).toHaveBeenCalledWith(cues[0]);
    expect(props.onCueClick).not.toHaveBeenCalled();
  });

  it('calls onMineCue for the correct cue when clicking second row', () => {
    const props = baseProps();
    render(<SubtitlePanel {...props} />);
    const mineButtons = screen.getAllByRole('button', { name: 'Mine this cue' });

    fireEvent.click(mineButtons[1]!);

    expect(props.onMineCue).toHaveBeenCalledTimes(1);
    expect(props.onMineCue).toHaveBeenCalledWith(cues[1]);
  });

  it('disables mine button when canMineRow is false', () => {
    render(<SubtitlePanel {...baseProps({ canMineRow: false })} />);
    const mineButtons = screen.getAllByRole('button', { name: 'Mining unavailable' });
    mineButtons.forEach((btn) => {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('disables mine button when isMining is true', () => {
    render(<SubtitlePanel {...baseProps({ isMining: true })} />);
    const mineButtons = screen.getAllByRole('button', { name: 'Mining…' });
    mineButtons.forEach((btn) => {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('does NOT call onMineCue when disabled and clicked', () => {
    const props = baseProps({ canMineRow: false });
    render(<SubtitlePanel {...props} />);
    const mineButtons = screen.getAllByRole('button', { name: 'Mining unavailable' });

    fireEvent.click(mineButtons[0]!);

    expect(props.onMineCue).not.toHaveBeenCalled();
  });

  it('uses mineRowLabel for aria-label and title in normal state', () => {
    render(<SubtitlePanel {...baseProps()} />);
    const mineButtons = screen.getAllByRole('button', { name: 'Mine this cue' });
    mineButtons.forEach((btn) => {
      expect(btn.getAttribute('aria-label')).toBe('Mine this cue');
      expect(btn.getAttribute('title')).toBe('Mine this cue');
    });
  });

  it('uses mineRowDisabledLabel when disabled', () => {
    render(<SubtitlePanel {...baseProps({ canMineRow: false })} />);
    const mineButtons = screen.getAllByRole('button', { name: 'Mining unavailable' });
    mineButtons.forEach((btn) => {
      expect(btn.getAttribute('aria-label')).toBe('Mining unavailable');
      expect(btn.getAttribute('title')).toBe('Mining unavailable');
    });
  });

  it('uses mineCapturingLabel when mining is in progress', () => {
    render(<SubtitlePanel {...baseProps({ isMining: true })} />);
    const mineButtons = screen.getAllByRole('button', { name: 'Mining…' });
    mineButtons.forEach((btn) => {
      expect(btn.getAttribute('aria-label')).toBe('Mining…');
      expect(btn.getAttribute('title')).toBe('Mining…');
    });
  });

  it('mine button click does NOT trigger seek callback on same row', () => {
    const props = baseProps();
    render(<SubtitlePanel {...props} />);

    // Find the cue seek button for first cue (formatTime produces "00:00" for start=0)
    const seekButton = screen.getByRole('button', {
      name: /Seek to.*Hello world/,
    });
    const mineButtons = screen.getAllByRole('button', { name: 'Mine this cue' });

    // Click mine button — onCueClick should NOT be called
    fireEvent.click(mineButtons[0]!);
    expect(props.onCueClick).not.toHaveBeenCalled();
    expect(props.onMineCue).toHaveBeenCalledWith(cues[0]);

    // Click seek button — onCueClick SHOULD be called
    fireEvent.click(seekButton);
    expect(props.onCueClick).toHaveBeenCalledTimes(1);
    expect(props.onCueClick).toHaveBeenCalledWith(cues[0]);
  });
});

describe('SubtitlePanel loading state (companion subtitles pending)', () => {
  it('shows centered loading indicator while subtitles are being fetched', () => {
    render(
      <SubtitlePanel
        {...basePropsForLoading()}
        cues={[]}
        isLoadingSubtitles
        preparingSubtitlesLabel="Preparing subtitles…"
      />,
    );
    const status = screen.getByRole('status', {
      name: 'Preparing subtitles…',
    });
    expect(status).not.toBeNull();
    expect(
      status.querySelector('.entei-typewriter--panel'),
    ).not.toBeNull();
    expect(
      status.querySelector('.entei-subtitle-preparing-text'),
    ).not.toBeNull();
    // The picker/empty copy must be absent during loading.
    expect(screen.queryByRole('button', { name: /subtitles/i })).toBeNull();
    expect(screen.queryByText('No subtitles loaded. Add an SRT or VTT file.')).toBeNull();
  });

  it('hides loading if cues arrived', () => {
    render(
      <SubtitlePanel
        {...baseProps()}
        isLoadingSubtitles
        preparingSubtitlesLabel="Preparing subtitles…"
      />,
    );
    expect(screen.queryByRole('status', { name: 'Preparing subtitles…' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Seek to/ })).not.toHaveLength(0);
  });

  it('keeps the local-file empty picker state when not loading', () => {
    render(
      <SubtitlePanel
        {...basePropsWithoutMine()}
        cues={[]}
        isLoadingSubtitles={false}
        preparingSubtitlesLabel="Preparing subtitles…"
        onSubtitleSelect={vi.fn()}
        subtitleAccept=".srt,.vtt"
        chooseSubtitleLabel="Choose"
      />,
    );
    expect(screen.queryByRole('status', { name: 'Preparing subtitles…' })).toBeNull();
    expect(screen.getByText('No subtitles loaded. Add an SRT or VTT file.')).not.toBeNull();
  });
});
