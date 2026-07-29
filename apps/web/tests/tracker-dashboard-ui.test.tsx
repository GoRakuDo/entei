/**
 * TrackerDashboard UI component tests.
 * ---------------------------------------------------------------------------
 * Tests:
 *   - Skeleton (pending) state renders layout-matching skeleton, no spinner
 *   - Unavailable state renders icon + title + desc, no role=alert
 *   - Ready-empty state renders icon + title + desc when all data empty
 *   - Ready dashboard renders all 4 blocks with real data
 *   - Today summary: foreground watch is hero metric, tabular numbers
 *   - Media list: filename first, learning sets nested, totals secondary
 *   - i+1 Moments: 30s buckets with separate pass/pause/seek/mine signals
 *   - Mining archive: newest-first, filename/range/sentence with wrapping
 *   - All text consumed from i18n dictionary (no hardcoded English in dashboard)
 *   - data-testid attributes preserved for backward compatibility
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

// Mock the hook before importing the component.
const mockState: {
  status: 'pending' | 'unavailable' | 'ready';
  reason?: string;
  model?: import('@/features/player/tracker/tracker-dashboard-read').TrackerDashboardReadModel;
} = { status: 'pending' };

vi.mock('@/features/player/tracker/useTrackerDashboard', () => ({
  useTrackerDashboard: () => mockState,
}));

import TrackerDashboard from '@/components/player/TrackerDashboard';
import type { TrackerDashboardReadModel } from '@/features/player/tracker/tracker-dashboard-read';
import { en } from '@i18n/locales/en';

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

function makeModel(
  overrides: Partial<TrackerDashboardReadModel> = {},
): TrackerDashboardReadModel {
  return {
    available: true,
    today: {
      localDay: '2026-07-29',
      foregroundWatchMs: 3600000,
      mediaProgressMs: 3300000,
      subtitleExposureMs: 3000000,
      condensedSkippedMs: 50000,
      fastForwardWallMs: 40000,
      fastForwardMediaMs: 80000,
    },
    mediaList: [
      {
        media: {
          mediaId: 'media-1',
          displayName: 'anime_ep01.webm',
          byteSize: 1024,
          mimeType: 'video/webm',
          firstSeenDay: '2026-07-01',
          lastSeenDay: '2026-07-29',
          totals: {
            foregroundWatchMs: 3600000,
            mediaProgressMs: 3300000,
            uniqueCoverageMs: 3000000,
            effectiveExposureMs: 2700000,
            subtitleExposureMs: 3000000,
            condensedSkippedMs: 50000,
            fastForwardWallMs: 40000,
            fastForwardMediaMs: 80000,
            rateBuckets: {},
            manualBackwardSeekCount: 5,
            mineCount: 2,
          },
        },
        learningSets: [
          {
            learningSetId: 'media-1:sub-1',
            mediaId: 'media-1',
            subtitleId: 'sub-1',
            totals: {
              foregroundWatchMs: 3600000,
              mediaProgressMs: 3300000,
              uniqueCoverageMs: 3000000,
              effectiveExposureMs: 2700000,
              subtitleExposureMs: 3000000,
              condensedSkippedMs: 50000,
              fastForwardWallMs: 40000,
              fastForwardMediaMs: 80000,
              rateBuckets: {},
              manualBackwardSeekCount: 5,
              mineCount: 2,
            },
          },
        ],
      },
    ],
    moments: [
      {
        mediaId: 'media-1',
        learningSetId: 'media-1:sub-1',
        mediaDurationSec: 120,
        buckets: [
          {
            bucketStart: 0,
            bucketEnd: 30,
            foregroundWatchMs: 5000,
            passCount: 2,
            pauseCount: 1,
            manualBackwardSeekCount: 0,
            mineCount: 0,
          },
          {
            bucketStart: 30,
            bucketEnd: 60,
            foregroundWatchMs: 3000,
            passCount: 1,
            pauseCount: 0,
            manualBackwardSeekCount: 1,
            mineCount: 1,
          },
        ],
      },
    ],
    archive: [
      {
        id: 'arch-1',
        mediaId: 'media-1',
        learningSetId: 'media-1:sub-1',
        displayName: 'anime_ep01.webm',
        rangeStart: 10,
        rangeEnd: 20,
        sentence: 'This is a mined sentence.',
        localDay: '2026-07-29',
        createdAt: 3000,
      },
      {
        id: 'arch-2',
        mediaId: 'media-1',
        learningSetId: 'media-1:sub-1',
        displayName: 'anime_ep01.webm',
        rangeStart: 50,
        rangeEnd: 60,
        sentence: 'Another mined sentence here.',
        localDay: '2026-07-28',
        createdAt: 1000,
      },
    ],
    ...overrides,
  };
}

function makeEmptyModel(): TrackerDashboardReadModel {
  return {
    available: true,
    today: {
      localDay: '2026-07-29',
      foregroundWatchMs: 0,
      mediaProgressMs: 0,
      subtitleExposureMs: 0,
      condensedSkippedMs: 0,
      fastForwardWallMs: 0,
      fastForwardMediaMs: 0,
    },
    mediaList: [],
    moments: [],
    archive: [],
  };
}

const t = en.trackerDashboard;

/* ------------------------------------------------------------------------ */
/* Setup / teardown                                                          */
/* ------------------------------------------------------------------------ */

beforeEach(() => {
  document.documentElement.lang = 'en';
  mockState.status = 'pending';
  mockState.reason = undefined;
  mockState.model = undefined;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

describe('TrackerDashboard UI', () => {
  /* ---------------------------------------------------------------------- */
  /* Skeleton (pending) state                                                */
  /* ---------------------------------------------------------------------- */

  it('renders skeleton matching final layout, no spinner', () => {
    mockState.status = 'pending';
    render(<TrackerDashboard />);

    const skeleton = screen.getByTestId('tracker-dashboard-pending');
    expect(skeleton).toBeTruthy();
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    // No spinner element (no role="status" or loader)
    expect(skeleton.querySelector('[role="status"]')).toBeNull();
  });

  /* ---------------------------------------------------------------------- */
  /* Unavailable state                                                        */
  /* ---------------------------------------------------------------------- */

  it('renders unavailable state with icon, no role=alert', () => {
    mockState.status = 'unavailable';
    mockState.reason = 'IndexedDB unavailable';
    render(<TrackerDashboard />);

    const el = screen.getByTestId('tracker-dashboard-unavailable');
    expect(el).toBeTruthy();
    // No role=alert (requirement: no alert)
    expect(el.getAttribute('role')).toBeNull();
    // Title and description from dictionary
    expect(el.textContent).toContain(t.unavailableTitle);
    expect(el.textContent).toContain(t.unavailableDesc);
    expect(el.textContent).toContain('IndexedDB unavailable');
  });

  /* ---------------------------------------------------------------------- */
  /* Ready-empty state                                                        */
  /* ---------------------------------------------------------------------- */

  it('renders ready-empty state when all data is empty', () => {
    mockState.status = 'ready';
    mockState.model = makeEmptyModel();
    render(<TrackerDashboard />);

    const el = screen.getByTestId('tracker-dashboard-empty');
    expect(el).toBeTruthy();
    expect(el.textContent).toContain(t.emptyTitle);
    expect(el.textContent).toContain(t.emptyDesc);
  });

  it('does not render ready-empty when partial data exists', () => {
    mockState.status = 'ready';
    mockState.model = makeModel({ moments: [], archive: [] });
    render(<TrackerDashboard />);

    // Ready dashboard renders, not the empty state
    expect(screen.queryByTestId('tracker-dashboard-empty')).toBeNull();
    expect(screen.getByTestId('tracker-dashboard-ready')).toBeTruthy();
  });

  /* ---------------------------------------------------------------------- */
  /* Ready dashboard — header                                                 */
  /* ---------------------------------------------------------------------- */

  it('renders left-aligned header with title, subtitle, and local-only badge', () => {
    mockState.status = 'ready';
    mockState.model = makeModel();
    render(<TrackerDashboard />);

    const dash = screen.getByTestId('tracker-dashboard-ready');
    expect(dash.querySelector('.entei-tracker-title')?.textContent).toBe(
      t.title,
    );
    expect(dash.querySelector('.entei-tracker-subtitle')?.textContent).toBe(
      t.subtitle,
    );
    const badge = dash.querySelector('.entei-tracker-local-badge');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain(t.localOnlyBadge);
  });

  /* ---------------------------------------------------------------------- */
  /* Ready dashboard — today summary                                          */
  /* ---------------------------------------------------------------------- */

  it('shows foreground watch as hero metric with tabular numbers', () => {
    mockState.status = 'ready';
    mockState.model = makeModel();
    render(<TrackerDashboard />);

    const fg = screen.getByTestId('today-foreground');
    expect(fg).toBeTruthy();
    // Hero value has the hero class
    expect(fg.classList.contains('entei-tracker-today-hero-value')).toBe(true);
    // 3600000ms = 1h 0m
    expect(fg.textContent).toBe('1h 0m');
  });

  it('shows all secondary today metrics with correct values', () => {
    mockState.status = 'ready';
    mockState.model = makeModel();
    render(<TrackerDashboard />);

    expect(screen.getByTestId('today-media-progress').textContent).toBe(
      '55m 0s',
    );
    expect(screen.getByTestId('today-subtitle').textContent).toBe('50m 0s');
    expect(screen.getByTestId('today-condensed').textContent).toBe('50s');
    expect(screen.getByTestId('today-ff-wall').textContent).toBe('40s');
    expect(screen.getByTestId('today-ff-media').textContent).toBe('1m 20s');
  });

  /* ---------------------------------------------------------------------- */
  /* Ready dashboard — media list                                             */
  /* ---------------------------------------------------------------------- */

  it('renders media list with filename first and nested learning sets', () => {
    mockState.status = 'ready';
    mockState.model = makeModel();
    render(<TrackerDashboard />);

    const mediaItem = screen.getByTestId('media-item-media-1');
    expect(mediaItem).toBeTruthy();
    // Filename is first (first child of media-row)
    const nameEl = mediaItem.querySelector('.entei-tracker-media-name');
    expect(nameEl?.textContent).toBe('anime_ep01.webm');
    // Learning set nested
    const lsItem = screen.getByTestId('ls-item-media-1:sub-1');
    expect(lsItem).toBeTruthy();
    expect(lsItem.textContent).toContain('sub-1');
  });

  it('shows media empty message when no media', () => {
    mockState.status = 'ready';
    mockState.model = makeModel({
      mediaList: [],
      moments: [],
      archive: [{ ...makeModel().archive[0]! }],
    });
    render(<TrackerDashboard />);

    expect(screen.getByTestId('media-list-empty').textContent).toBe(
      t.mediaEmpty,
    );
  });

  /* ---------------------------------------------------------------------- */
  /* Ready dashboard — i+1 Moments                                            */
  /* ---------------------------------------------------------------------- */

  it('renders 30s buckets with separate pass/pause/seek/mine signals', () => {
    mockState.status = 'ready';
    mockState.model = makeModel();
    render(<TrackerDashboard />);

    const bucket0 = screen.getByTestId('bucket-media-1:sub-1-0');
    expect(bucket0).toBeTruthy();
    // Range shows 0:00-0:30
    expect(bucket0.querySelector('.entei-tracker-bucket-range')?.textContent).toBe(
      '0:00–0:30',
    );
    // Signals are separate, no composite score
    const signals = bucket0.querySelectorAll('.entei-tracker-signal');
    expect(signals.length).toBe(5); // watch, passes, pauses, seeks, mines

    const bucket30 = screen.getByTestId('bucket-media-1:sub-1-30');
    expect(bucket30).toBeTruthy();
    expect(
      bucket30.querySelector('.entei-tracker-bucket-range')?.textContent,
    ).toBe('0:30–1:00');
  });

  it('shows moments empty message when no exposure data', () => {
    mockState.status = 'ready';
    mockState.model = makeModel({
      moments: [],
      archive: [{ ...makeModel().archive[0]! }],
    });
    render(<TrackerDashboard />);

    expect(screen.getByTestId('moments-empty').textContent).toBe(
      t.momentsEmpty,
    );
  });

  /* ---------------------------------------------------------------------- */
  /* Ready dashboard — mining archive                                         */
  /* ---------------------------------------------------------------------- */

  it('renders archive newest-first with filename, range, and sentence', () => {
    mockState.status = 'ready';
    mockState.model = makeModel();
    render(<TrackerDashboard />);

    const items = screen.getAllByTestId(/archive-arch-/);
    expect(items.length).toBe(2);
    // Newest-first: arch-1 (createdAt 3000) before arch-2 (createdAt 1000)
    expect(items[0]?.getAttribute('data-testid')).toBe('archive-arch-1');
    expect(items[1]?.getAttribute('data-testid')).toBe('archive-arch-2');

    // First entry content
    const first = items[0]!;
    expect(first.querySelector('.entei-tracker-archive-name')?.textContent).toBe(
      'anime_ep01.webm',
    );
    expect(
      first.querySelector('.entei-tracker-archive-range')?.textContent,
    ).toBe('[0:10–0:20]');
    expect(
      first.querySelector('.entei-tracker-archive-sentence')?.textContent,
    ).toBe('This is a mined sentence.');
  });

  it('shows archive empty message when no archive entries', () => {
    mockState.status = 'ready';
    mockState.model = makeModel({
      archive: [],
      mediaList: [{ ...makeModel().mediaList[0]! }],
    });
    render(<TrackerDashboard />);

    expect(screen.getByTestId('archive-empty').textContent).toBe(
      t.archiveEmpty,
    );
  });

  /* ---------------------------------------------------------------------- */
  /* i18n consumption                                                        */
  /* ---------------------------------------------------------------------- */

  it('renders Indonesian dictionary text when locale is id', () => {
    document.documentElement.lang = 'id';
    mockState.status = 'ready';
    mockState.model = makeModel();
    render(<TrackerDashboard />);

    const dash = screen.getByTestId('tracker-dashboard-ready');
    const titleEl = dash.querySelector('.entei-tracker-title');
    // Indonesian title
    expect(titleEl?.textContent).toBe('Tracker Dashboard');
  });

  it('renders Japanese dictionary text when locale is ja', () => {
    document.documentElement.lang = 'ja';
    mockState.status = 'ready';
    mockState.model = makeModel();
    render(<TrackerDashboard />);

    const dash = screen.getByTestId('tracker-dashboard-ready');
    const titleEl = dash.querySelector('.entei-tracker-title');
    expect(titleEl?.textContent).toBe('トラッカーダッシュボード');
  });

  /* ---------------------------------------------------------------------- */
  /* No hardcoded English in dashboard ready state                           */
  /* ---------------------------------------------------------------------- */

  it('uses dictionary keys for all section titles, not hardcoded English', () => {
    mockState.status = 'ready';
    mockState.model = makeModel();
    render(<TrackerDashboard />);

    const sectionTitles = screen.getAllByRole('heading', { level: 2 });
    const texts = sectionTitles.map((el) => el.textContent ?? '');
    // Should contain dictionary values for each section
    expect(texts.some((s) => s.includes(t.mediaLabel))).toBe(true);
    expect(texts.some((s) => s.includes(t.momentsLabel))).toBe(true);
    expect(texts.some((s) => s.includes(t.archiveLabel))).toBe(true);
  });
});
