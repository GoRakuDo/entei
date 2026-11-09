/**
 * use-cue-virtual-list — DOM side of the virtualised subtitle cue list.
 * ---------------------------------------------------------------------------
 * The Player's subtitle panel holds thousands of cues on a real movie, and
 * rendering every row at once made the panel take seconds to mount (and to
 * remount on every Captions ⇄ Context tab switch). This hook mounts only the
 * rows that are near the viewport and replaces the rest with two spacers,
 * so the mounted DOM stays at ~30 rows no matter how long the subtitle is.
 *
 * How it works:
 *   1. `cue-virtual-window.ts` (pure) turns the cue list into a prefix-sum
 *      of row offsets. Rows that have been rendered once keep their real
 *      height; the rest use the running average of the measured rows.
 *   2. A layout effect measures the mounted rows after every render and
 *      stores the heights, so the offsets converge to the real layout.
 *   3. A rAF-throttled scroll listener tracks the scroll offset relative to
 *      the list's own top and recomputes the mounted index range.
 *   4. `scrollToCue` brings the active cue into view. When the cue is not
 *      mounted yet (the common case right after a seek, or right after the
 *      panel was remounted) the mounted window is *forced* to contain it,
 *      which makes the row render; its real geometry then drives an exact
 *      scroll correction — no estimate decides the final position.
 *
 * LazySync contract (docs SUBTITLE_SYNC.md §10):
 *   The cue array is treated as strictly read-only. LazySync rewrites cue
 *   timestamps (`shiftCuesBySubDelay`) or re-indexes and drops cues
 *   (`shiftCuesByOffset`); both change the array identity. The height cache
 *   is therefore keyed by cue id AND validated against the cue text, so a
 *   re-indexed cue never reuses the height of the cue that used to own its
 *   id.
 * ---------------------------------------------------------------------------
 */

'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SubtitleCue } from './subtitle-reader';
import {
  CUE_ROW_FALLBACK_HEIGHT,
  CUE_ROW_OVERSCAN,
  averageMeasuredHeight,
  buildCueOffsets,
  computeCueSpacers,
  computeCueVirtualWindow,
  type CueSpacers,
  type CueVirtualWindow,
} from './cue-virtual-window';

/**
 * Viewport height assumed when the real one cannot be measured (panel
 * hidden, jsdom). Keeps a sane number of rows mounted instead of collapsing
 * the list to a single row.
 */
const FALLBACK_VIEWPORT_HEIGHT = 600;

/**
 * How many correction passes the "cue is not mounted yet" jump may take
 * before we stop retrying. Each pass re-measures and re-centres; one or two
 * passes are enough in practice.
 */
const MAX_FINE_TUNE_PASSES = 4;

/** A correction smaller than this counts as "already in place". */
const CENTER_EPSILON_PX = 1;

/** Measured height of one cue row, plus the text it was measured for. */
interface MeasuredRow {
  /** Cue text the height was measured for (guards LazySync re-indexing). */
  text: string;
  /** Row height in px. */
  height: number;
}

/** A cue that still has to be scrolled into view. */
interface PendingJump {
  /** Cue id to bring into view. */
  cueId: number;
  /** Index of that cue inside the (read-only) cue array. */
  index: number;
  /** Correction passes already spent. */
  passes: number;
}

/** The visible band the cue list lives in. */
interface BandGeometry {
  /** Viewport-relative top of the band. */
  top: number;
  /** Height of the band. */
  height: number;
  /** True when the Radix viewport owns the scroll range (desktop). */
  viewportScroller: boolean;
}

export interface UseCueVirtualListOptions {
  /** The cue list. Treated as read-only. */
  cues: readonly SubtitleCue[];
  /** Whether the cue list is currently rendered (false for the empty and
   *  loading states, where no ScrollArea exists). */
  enabled: boolean;
}

export interface CueVirtualList {
  /** Ref for the `<ul>` that hosts the mounted rows. */
  listRef: React.RefObject<HTMLUListElement | null>;
  /** Ref for the ScrollArea root (the scroll host's ancestor). */
  scrollRootRef: React.RefObject<HTMLDivElement | null>;
  /** The mounted index range. */
  window: CueVirtualWindow;
  /** Pixel spacers that replace the unmounted rows. */
  spacers: CueSpacers;
  /** Scroll the list so `cueId` is visible (and mounted). */
  scrollToCue: (cueId: number) => void;
}

/** The Radix viewport is the scroll container on desktop. */
function resolveViewportElement(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  return (
    root.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? root
  );
}

/**
 * Bottom edge of the sticky headers on mobile (media area + tabs bar). The
 * visible subtitle band starts there.
 */
function readStickyHeaderBottom(): number {
  if (typeof document === 'undefined') return 0;
  const tabsBar = document.querySelector<HTMLElement>(
    '.entei-right-panel-tabs-bar',
  );
  const mediaArea = document.querySelector<HTMLElement>(
    '.entei-player-media-area',
  );
  if (tabsBar) return tabsBar.getBoundingClientRect().bottom;
  if (mediaArea) return mediaArea.getBoundingClientRect().bottom;
  return 0;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function useCueVirtualList({
  cues,
  enabled,
}: UseCueVirtualListOptions): CueVirtualList {
  const listRef = useRef<HTMLUListElement | null>(null);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

  /** Measured row heights, keyed by cue id. */
  const [measured, setMeasured] = useState<Map<number, MeasuredRow>>(
    () => new Map(),
  );
  /** Scroll geometry of the visible band, relative to the list's top. */
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  /** A cue that still has to be scrolled into view. */
  const [pendingJump, setPendingJump] = useState<PendingJump | null>(null);

  const rafRef = useRef<number | null>(null);
  /** Cached `overflow-y` of the viewport element (layout-mode decision). */
  const overflowCacheRef = useRef<{ el: HTMLElement; overflowY: string } | null>(
    null,
  );

  /**
   * Latest values, readable from the stable `scrollToCue` callback without
   * making its identity change on every render (the auto-scroll effect
   * depends on it).
   */
  const latestRef = useRef({
    cues,
    offsets: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    measuredHeights: new Map<number, number>(),
    fallbackHeight: CUE_ROW_FALLBACK_HEIGHT,
    viewportHeight: FALLBACK_VIEWPORT_HEIGHT,
    scrollTop: 0,
  });

  /** `overflow-y` of the viewport element, cached per element. */
  const readOverflowY = useCallback((el: HTMLElement): string => {
    const cached = overflowCacheRef.current;
    if (cached && cached.el === el) return cached.overflowY;
    const overflowY = window.getComputedStyle(el).overflowY;
    overflowCacheRef.current = { el, overflowY };
    return overflowY;
  }, []);

  /**
   * Does the Radix viewport own the scroll range? Desktop: yes. Mobile:
   * player.css forces `overflow: visible !important` on it, so the page
   * window scrolls instead.
   */
  const isViewportScroller = useCallback(
    (viewportEl: HTMLElement): boolean =>
      viewportEl.scrollHeight > viewportEl.clientHeight &&
      readOverflowY(viewportEl) !== 'visible',
    [readOverflowY],
  );

  /** Geometry of the visible band the cue list lives in. */
  const readBand = useCallback(
    (viewportEl: HTMLElement): BandGeometry => {
      if (isViewportScroller(viewportEl)) {
        const rect = viewportEl.getBoundingClientRect();
        return {
          top: rect.top,
          height: rect.height || viewportEl.clientHeight,
          viewportScroller: true,
        };
      }
      // Mobile: the page window scrolls; the visible band sits below the
      // sticky media area + tabs bar and ends at the window bottom.
      const headerBottom = readStickyHeaderBottom();
      const windowHeight =
        window.innerHeight || document.documentElement.clientHeight;
      return {
        top: headerBottom,
        height: Math.max(0, windowHeight - headerBottom),
        viewportScroller: false,
      };
    },
    [isViewportScroller],
  );

  /** Read the scroll geometry of the visible band, relative to the list. */
  const readViewport = useCallback(() => {
    const listEl = listRef.current;
    const root = scrollRootRef.current;
    if (!listEl || !root) return null;
    const viewportEl = resolveViewportElement(root);
    if (!viewportEl) return null;

    const band = readBand(viewportEl);
    const listRect = listEl.getBoundingClientRect();

    if (band.viewportScroller) {
      const listOffset = listRect.top - band.top + viewportEl.scrollTop;
      return {
        scrollTop: viewportEl.scrollTop - listOffset,
        height: band.height,
      };
    }
    return {
      scrollTop: Math.max(0, band.top - listRect.top),
      height: band.height,
    };
  }, [readBand]);

  /** Push the current geometry into state (rAF-throttled). */
  const syncViewport = useCallback(() => {
    const next = readViewport();
    if (!next) return;
    setViewport((prev) =>
      prev.scrollTop === next.scrollTop && prev.height === next.height
        ? prev
        : next,
    );
  }, [readViewport]);

  // --- Scroll tracking -----------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    const root = scrollRootRef.current;
    if (!root) return;
    const viewportEl = resolveViewportElement(root);
    if (!viewportEl) return;

    let scheduled = false;
    const onScroll = () => {
      if (scheduled) return;
      scheduled = true;
      if (typeof window.requestAnimationFrame !== 'function') {
        scheduled = false;
        syncViewport();
        return;
      }
      rafRef.current = window.requestAnimationFrame(() => {
        scheduled = false;
        rafRef.current = null;
        syncViewport();
      });
    };
    const onResize = () => {
      overflowCacheRef.current = null;
      syncViewport();
    };

    viewportEl.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    syncViewport();

    return () => {
      viewportEl.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      if (
        rafRef.current !== null &&
        typeof window.cancelAnimationFrame === 'function'
      ) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, syncViewport]);

  // --- Row measurement -----------------------------------------------------
  // Runs after every render: the mounted rows are the only ones whose real
  // height is known, so measuring them is what makes the offsets converge.
  useLayoutEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;
    const rows = listEl.querySelectorAll<HTMLElement>('[data-cue-index]');
    if (rows.length === 0) return;

    const next = new Map<number, MeasuredRow>();
    rows.forEach((row) => {
      const index = Number(row.dataset.cueIndex);
      const cue = Number.isFinite(index) ? cues[index] : undefined;
      if (!cue) return;
      const height = row.offsetHeight;
      if (!Number.isFinite(height) || height <= 0) return;
      next.set(cue.id, { text: cue.text, height });
    });
    if (next.size === 0) return;

    setMeasured((prev) => {
      // Only publish when something actually changed, so a scroll frame that
      // re-renders the same rows does not schedule another render.
      let merged = false;
      const mergedMap = new Map(prev);
      next.forEach((value, key) => {
        const before = mergedMap.get(key);
        if (
          !before ||
          before.height !== value.height ||
          before.text !== value.text
        ) {
          mergedMap.set(key, value);
          merged = true;
        }
      });
      // Drop entries whose cue is gone or whose text changed — LazySync can
      // re-index cue ids, and a stale height must not survive that.
      mergedMap.forEach((entry, id) => {
        const cue = cuesById.get(id);
        if (!cue || cue.text !== entry.text) {
          mergedMap.delete(id);
          merged = true;
        }
      });
      return merged ? mergedMap : prev;
    });
  });

  // --- Offsets + mounted window -------------------------------------------
  // Lookup by cue id, used to drop height cache entries whose cue is gone.
  const cuesById = useMemo(() => {
    const map = new Map<number, SubtitleCue>();
    for (const cue of cues) map.set(cue.id, cue);
    return map;
  }, [cues]);

  // The height cache is keyed by cue id, but LazySync can re-index cue ids
  // (`shiftCuesByOffset` drops collapsed cues and renumbers the rest), so a
  // cached height is only reused when the cue text still matches.
  const measuredHeights = useMemo(() => {
    const map = new Map<number, number>();
    for (const cue of cues) {
      const entry = measured.get(cue.id);
      if (entry && entry.text === cue.text) map.set(cue.id, entry.height);
    }
    return map;
  }, [cues, measured]);

  const fallbackHeight = useMemo(
    () => averageMeasuredHeight(measuredHeights, CUE_ROW_FALLBACK_HEIGHT),
    [measuredHeights],
  );

  const offsets = useMemo(
    () => buildCueOffsets(cues, measuredHeights, fallbackHeight),
    [cues, measuredHeights, fallbackHeight],
  );

  const viewportHeight =
    viewport.height > 0 ? viewport.height : FALLBACK_VIEWPORT_HEIGHT;

  const virtualWindow = useMemo<CueVirtualWindow>(() => {
    if (pendingJump) {
      // Force the target cue into the mounted range so its real geometry
      // becomes measurable — the final position is then corrected exactly
      // instead of being estimated.
      const startIndex = Math.max(0, pendingJump.index - CUE_ROW_OVERSCAN);
      const endIndex = Math.min(
        cues.length,
        pendingJump.index + CUE_ROW_OVERSCAN + 1,
      );
      return { startIndex, endIndex };
    }
    return computeCueVirtualWindow(
      offsets,
      cues.length,
      viewport.scrollTop,
      viewportHeight,
    );
  }, [pendingJump, offsets, cues.length, viewport.scrollTop, viewportHeight]);

  const spacers = useMemo(
    () => computeCueSpacers(offsets, cues.length, virtualWindow),
    [offsets, cues.length, virtualWindow],
  );

  latestRef.current = {
    cues,
    offsets,
    measuredHeights,
    fallbackHeight,
    viewportHeight,
    scrollTop: viewport.scrollTop,
  };

  // --- Scroll to a cue -----------------------------------------------------
  /** Scroll the active container by `delta` (with the legacy fallback). */
  const applyScroll = useCallback(
    (
      viewportEl: HTMLElement,
      band: BandGeometry,
      cueEl: HTMLElement | null,
      delta: number,
      behavior: ScrollBehavior,
    ) => {
      if (band.viewportScroller) {
        if (typeof viewportEl.scrollBy === 'function') {
          viewportEl.scrollBy({ top: delta, behavior });
        } else if (cueEl && typeof cueEl.scrollIntoView === 'function') {
          cueEl.scrollIntoView({ block: 'center', behavior });
        }
        return;
      }
      if (typeof window.scrollBy === 'function') {
        window.scrollBy({ top: delta, behavior });
      } else if (cueEl && typeof cueEl.scrollIntoView === 'function') {
        cueEl.scrollIntoView({ block: 'center', behavior });
      }
    },
    [],
  );

  const scrollToCue = useCallback(
    (cueId: number) => {
      const root = scrollRootRef.current;
      const listEl = listRef.current;
      if (!root || !listEl) return;
      const viewportEl = resolveViewportElement(root);
      if (!viewportEl) return;

      const latest = latestRef.current;
      const index = latest.cues.findIndex((cue) => cue.id === cueId);
      if (index < 0) return;

      const behavior: ScrollBehavior = prefersReducedMotion()
        ? 'instant'
        : 'smooth';
      const band = readBand(viewportEl);

      // Fast path: the cue is already mounted → its real geometry is known.
      const cueEl = listEl.querySelector<HTMLElement>(
        `[data-cue-id="${cueId}"]`,
      );
      if (cueEl) {
        setPendingJump(null);
        const elRect = cueEl.getBoundingClientRect();
        const cueCenterY = elRect.top + elRect.height / 2;
        const targetCenterY = band.top + band.height / 2;
        const tolerance = Math.max(elRect.height * 1.5, band.height * 0.18);
        const delta = cueCenterY - targetCenterY;
        if (Math.abs(delta) > tolerance) {
          applyScroll(viewportEl, band, cueEl, delta, behavior);
        }
        return;
      }

      // Slow path: the cue is outside the mounted range. Jump to its
      // estimated position and force the window to contain it; the row then
      // renders and the correction pass places it exactly. The jump is
      // instant: animating across thousands of rows would mount and measure
      // the whole list on the way.
      const estimatedTop = latest.offsets[index] ?? 0;
      const estimatedHeight =
        latest.measuredHeights.get(cueId) ?? latest.fallbackHeight;
      const delta =
        estimatedTop +
        estimatedHeight / 2 -
        (latest.scrollTop + latest.viewportHeight / 2);
      applyScroll(viewportEl, band, cueEl, delta, 'instant');

      setPendingJump({ cueId, index, passes: 0 });
    },
    [applyScroll, readBand],
  );

  // --- Correction pass -----------------------------------------------------
  // Once the pending cue is mounted, its real geometry replaces the
  // estimate: the cue lands exactly where it should.
  useLayoutEffect(() => {
    if (!pendingJump) return;
    const root = scrollRootRef.current;
    const listEl = listRef.current;
    if (!root || !listEl) return;
    const viewportEl = resolveViewportElement(root);
    if (!viewportEl) return;

    const cueEl = listEl.querySelector<HTMLElement>(
      `[data-cue-id="${pendingJump.cueId}"]`,
    );
    if (!cueEl) return; // not mounted yet — the next render will retry

    const band = readBand(viewportEl);
    const elRect = cueEl.getBoundingClientRect();
    const cueCenterY = elRect.top + elRect.height / 2;
    const targetCenterY = band.top + band.height / 2;
    const delta = cueCenterY - targetCenterY;
    if (Math.abs(delta) > CENTER_EPSILON_PX) {
      applyScroll(viewportEl, band, cueEl, delta, 'instant');
    }

    const passes = pendingJump.passes + 1;
    const latest = latestRef.current;
    const geometry = readViewport();
    const natural = computeCueVirtualWindow(
      latest.offsets,
      latest.cues.length,
      geometry?.scrollTop ?? latest.scrollTop,
      latest.viewportHeight,
    );
    const naturallyMounted =
      pendingJump.index >= natural.startIndex &&
      pendingJump.index < natural.endIndex;
    const converged = Math.abs(delta) <= CENTER_EPSILON_PX;

    if (converged && (naturallyMounted || passes >= MAX_FINE_TUNE_PASSES)) {
      // The cue is where it should be and the natural window holds it
      // again — the forced window can be released.
      setPendingJump(null);
      return;
    }
    if (passes < MAX_FINE_TUNE_PASSES) {
      setPendingJump({ ...pendingJump, passes });
    }
    // Otherwise the correction could not converge (the scroll container
    // refused to move). Keep the forced window so the cue stays mounted
    // and stop retrying; the next active-cue change issues a fresh jump.
  });

  return {
    listRef,
    scrollRootRef,
    window: virtualWindow,
    spacers,
    scrollToCue,
  };
}
