/**
 * SubtitlePanel active-cue auto-scroll tests.
 * ---------------------------------------------------------------------------
 * Covers the scroll-to-active-cue effect in SubtitlePanel:
 * - Desktop (Radix viewport is the scroll container): when the active cue
 *   drifts beyond the center tolerance band (1.5 cue heights or 18% of the
 *   viewport height), viewport.scrollBy is called with the delta needed to
 *   center it; when the cue stays inside the band, no scroll happens.
 *   Falls back to scrollIntoView when scrollBy is unavailable, and honors
 *   prefers-reduced-motion ('instant' instead of 'smooth').
 * - Mobile (page window scrolls): the same centering logic runs against the
 *   visible subtitle area below the sticky headers (media area + tabs bar),
 *   scrolling the window instead of the viewport.
 * - Clean tear down: no scroll calls when there is no active cue, nothing
 *   leaks after unmount, and mocks/DOM additions are cleaned up.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { SubtitlePanel } from '@/components/player/SubtitlePanel';
import type { SubtitleCue } from '@/features/player/subtitle-reader';

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
    ...overrides,
  };
}

/** Render the panel with no active cue, then return helpers for wiring up
 *  geometry mocks on the Radix viewport and the cue elements. The effect is
 *  triggered later by rerendering with a non-null activeCueId. */
function renderPanel() {
  const props = baseProps();
  const utils = render(<SubtitlePanel {...props} />);
  const viewport = utils.container.querySelector<HTMLElement>(
    '[data-radix-scroll-area-viewport]',
  );
  const cueEl = (id: number) =>
    utils.container.querySelector<HTMLElement>(`[data-cue-id="${id}"]`);
  return { ...utils, props, viewport, cueEl };
}

/** Stub getBoundingClientRect on an element (jsdom returns all zeros). */
function mockRect(el: HTMLElement, rect: { top: number; height: number }) {
  el.getBoundingClientRect = () =>
    ({
      top: rect.top,
      height: rect.height,
      bottom: rect.top + rect.height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** Make the Radix viewport look like a scrollable container (desktop). */
function mockScrollableViewport(viewport: HTMLElement) {
  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    value: 300,
  });
  viewport.style.overflowY = 'auto';
}

/** Add the mobile sticky tabs bar and window geometry; returns the window
 *  scrollBy spy. */
function mockMobileLayout() {
  const tabsBar = document.createElement('div');
  tabsBar.className = 'entei-right-panel-tabs-bar';
  document.body.appendChild(tabsBar);
  mockRect(tabsBar, { top: 120, height: 80 });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: 800,
  });
  const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  return { tabsBar, scrollBy };
}

beforeEach(() => {
  global.ResizeObserver = vi.fn(function () {
    return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  });
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  // Remove the mobile tabs bar helper element if a test added one.
  document
    .querySelectorAll('.entei-right-panel-tabs-bar')
    .forEach((el) => el.remove());
  vi.restoreAllMocks();
});

describe('SubtitlePanel active-cue scroll (desktop viewport)', () => {
  it('scrolls the Radix viewport to center the active cue when it drifts beyond tolerance', () => {
    const { props, viewport, cueEl, rerender } = renderPanel();
    const activeEl = cueEl(2)!;
    mockScrollableViewport(viewport!);
    mockRect(viewport!, { top: 0, height: 300 });
    // Cue center at 415 vs target center 150; tolerance = max(45, 54) = 54.
    mockRect(activeEl, { top: 400, height: 30 });
    const scrollBy = vi.fn();
    viewport!.scrollBy = scrollBy;

    rerender(<SubtitlePanel {...props} activeCueId={2} />);

    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith({ top: 265, behavior: 'smooth' });
  });

  it('does not scroll when the active cue stays inside the center tolerance band', () => {
    const { props, viewport, cueEl, rerender } = renderPanel();
    const activeEl = cueEl(2)!;
    mockScrollableViewport(viewport!);
    mockRect(viewport!, { top: 0, height: 300 });
    // Cue center at 155 vs target center 150 — inside the 54px band.
    mockRect(activeEl, { top: 140, height: 30 });
    const scrollBy = vi.fn();
    viewport!.scrollBy = scrollBy;

    rerender(<SubtitlePanel {...props} activeCueId={2} />);

    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('uses instant behavior when prefers-reduced-motion is set', () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const { props, viewport, cueEl, rerender } = renderPanel();
    const activeEl = cueEl(2)!;
    mockScrollableViewport(viewport!);
    mockRect(viewport!, { top: 0, height: 300 });
    mockRect(activeEl, { top: 400, height: 30 });
    const scrollBy = vi.fn();
    viewport!.scrollBy = scrollBy;

    rerender(<SubtitlePanel {...props} activeCueId={2} />);

    expect(scrollBy).toHaveBeenCalledWith({ top: 265, behavior: 'instant' });
  });

  it('falls back to scrollIntoView when the viewport has no scrollBy', () => {
    const { props, viewport, cueEl, rerender } = renderPanel();
    const activeEl = cueEl(2)!;
    mockScrollableViewport(viewport!);
    mockRect(viewport!, { top: 0, height: 300 });
    mockRect(activeEl, { top: 400, height: 30 });
    // No viewport.scrollBy assigned — the effect must use scrollIntoView.
    const scrollIntoView = vi.fn();
    activeEl.scrollIntoView = scrollIntoView;

    rerender(<SubtitlePanel {...props} activeCueId={2} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'smooth',
    });
  });
});

describe('SubtitlePanel active-cue scroll (mobile window)', () => {
  it('scrolls the window to center the active cue below the sticky headers', () => {
    const { props, cueEl, rerender } = renderPanel();
    const activeEl = cueEl(2)!;
    const { scrollBy } = mockMobileLayout();
    // headerBottom = 200, visibleHeight = 600, target center = 500;
    // cue center at 900 → delta 400 > tolerance 108.
    mockRect(activeEl, { top: 885, height: 30 });

    rerender(<SubtitlePanel {...props} activeCueId={2} />);

    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith({ top: 400, behavior: 'smooth' });
  });

  it('does not scroll the window when the active cue stays inside the middle zone', () => {
    const { props, cueEl, rerender } = renderPanel();
    const activeEl = cueEl(2)!;
    const { scrollBy } = mockMobileLayout();
    // Cue center at 525 vs target center 500 — inside the 108px band.
    mockRect(activeEl, { top: 510, height: 30 });

    rerender(<SubtitlePanel {...props} activeCueId={2} />);

    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('falls back to scrollIntoView when window.scrollBy is unavailable', () => {
    const { props, cueEl, rerender } = renderPanel();
    const activeEl = cueEl(2)!;
    mockMobileLayout();
    mockRect(activeEl, { top: 885, height: 30 });
    const scrollIntoView = vi.fn();
    activeEl.scrollIntoView = scrollIntoView;

    // Simulate a browser without window.scrollBy (jsdom provides one).
    const originalScrollBy = window.scrollBy;
    Object.defineProperty(window, 'scrollBy', {
      configurable: true,
      value: undefined,
    });
    try {
      rerender(<SubtitlePanel {...props} activeCueId={2} />);

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: 'center',
        behavior: 'smooth',
      });
    } finally {
      Object.defineProperty(window, 'scrollBy', {
        configurable: true,
        value: originalScrollBy,
      });
    }
  });
});

describe('SubtitlePanel active-cue scroll (tear down)', () => {
  it('leaves no side effects without an active cue or after unmount', () => {
    const { props, viewport, unmount } = renderPanel();
    const viewportScrollBy = vi.fn();
    viewport!.scrollBy = viewportScrollBy;
    const windowScrollBy = vi
      .spyOn(window, 'scrollBy')
      .mockImplementation(() => {});

    // Mounted with activeCueId null: the effect returns early.
    expect(viewportScrollBy).not.toHaveBeenCalled();
    expect(windowScrollBy).not.toHaveBeenCalled();

    unmount();

    expect(viewportScrollBy).not.toHaveBeenCalled();
    expect(windowScrollBy).not.toHaveBeenCalled();
    // No stray layout helper elements are left in the document.
    expect(document.querySelector('.entei-right-panel-tabs-bar')).toBeNull();
    expect(props.onCueClick).not.toHaveBeenCalled();
  });
});