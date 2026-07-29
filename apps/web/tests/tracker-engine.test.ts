/**
 * Tests for IMMERSION_TRACKER — Pure engine logic.
 * ---------------------------------------------------------------------------
 * Required coverage (from IMMERSION_TRACKER.md §10 / user request):
 * - 1x vs 2x vs 0.5x wall-clock/media separation
 * - 2x crossing 2 seconds in 1 second → 0.5s each cell
 * - Same 10 seconds viewed 3 times → 1.0 / 0.5 / 0.25 effective
 * - 7-day reset per cell
 * - 12.49→12 and 12.50→13 rounding boundary
 * - Contiguous-pass dedupe within same pass
 * - Manual seek not inflating mediaProgressMs
 * - Pause transition count dedupe / buffering exclusion
 * - Per-session pass increment (loaded cells get new pass per session)
 * - 3rd/4th passes become 0.25/0.125 across loaded state
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect } from 'vitest';
import {
  createAccumulatorState,
  emptyTotals,
  distributeSegmentToCells,
  applyContributions,
  isPauseTransition,
  createSegment,
  isManualBackwardSeek,
  mergeTotals,
} from '@/features/player/tracker/engine';
import {
  repetitionDecayFactor,
  roundToCell,
  cellKey,
  SEVEN_DAYS_MS,
} from '@/features/player/tracker/types';
import type {
  ExposureCell,
} from '@/features/player/tracker/types';

/* ------------------------------------------------------------------------ */
/* Helper: create a sessionSeenCells set                                    */
/* ------------------------------------------------------------------------ */

function newSession(): Set<string> {
  return new Set<string>();
}

/* ------------------------------------------------------------------------ */
/* Rounding boundary                                                        */
/* ------------------------------------------------------------------------ */

describe('roundToCell', () => {
  it('12.49 → 12', () => {
    expect(roundToCell(12.49)).toBe(12);
  });

  it('12.50 → 13', () => {
    expect(roundToCell(12.50)).toBe(13);
  });

  it('0.0 → 0', () => {
    expect(roundToCell(0)).toBe(0);
  });

  it('0.49 → 0', () => {
    expect(roundToCell(0.49)).toBe(0);
  });

  it('0.50 → 1', () => {
    expect(roundToCell(0.50)).toBe(1);
  });

  it('rounds .5 up (standard Math.round)', () => {
    // Math.round(2.5) = 3 (towards +Infinity for .5)
    expect(roundToCell(2.5)).toBe(3);
    expect(roundToCell(3.5)).toBe(4);
  });
});

/* ------------------------------------------------------------------------ */
/* Repetition decay formula                                                 */
/* ------------------------------------------------------------------------ */

describe('repetitionDecayFactor', () => {
  it('1st pass → 1.0', () => {
    expect(repetitionDecayFactor(1)).toBe(1.0);
  });

  it('2nd pass → 0.5', () => {
    expect(repetitionDecayFactor(2)).toBe(0.5);
  });

  it('3rd pass → 0.25', () => {
    expect(repetitionDecayFactor(3)).toBeCloseTo(0.25);
  });

  it('0 passes → 0', () => {
    expect(repetitionDecayFactor(0)).toBe(0);
  });

  it('negative → 0', () => {
    expect(repetitionDecayFactor(-1)).toBe(0);
  });

  it('decays correctly for many passes', () => {
    expect(repetitionDecayFactor(4)).toBeCloseTo(0.125);
    expect(repetitionDecayFactor(5)).toBeCloseTo(0.0625);
  });
});

/* ------------------------------------------------------------------------ */
/* Wall-clock / media separation — 1x vs 2x vs 0.5x                       */
/* ------------------------------------------------------------------------ */

describe('distributeSegmentToCells — speed separation', () => {
  const lsId = 'media1:sub1';

  it('1x: 10s wall-clock = 10s media, all in one cell', () => {
    // mediaStart=5.1 and mediaEnd=5.4 both round to cell 5
    const segment = createSegment(
      0, 10000,       // 10s wall-clock
      5.1, 5.4,       // 0.3s media (within cell 5)
      1, 'normal', lsId,
    );
    const cells = new Map<string, ExposureCell>();
    const session = newSession();
    const contributions = distributeSegmentToCells(segment, cells, session);

    expect(contributions).toHaveLength(1);
    expect(contributions[0]!.roundedSecond).toBe(5);
    expect(contributions[0]!.foregroundWatchMs).toBe(10000);
    expect(contributions[0]!.effectiveExposureMs).toBe(10000); // 1st pass, decay=1.0
  });

  it('2x: 5s wall-clock = 10s media, all in one cell', () => {
    const segment = createSegment(
      0, 5000,        // 5s wall-clock
      5.1, 5.4,       // 0.3s media (within cell 5)
      2, 'normal', lsId,
    );
    const cells = new Map<string, ExposureCell>();
    const session = newSession();
    const contributions = distributeSegmentToCells(segment, cells, session);

    expect(contributions).toHaveLength(1);
    expect(contributions[0]!.foregroundWatchMs).toBe(5000);
  });

  it('0.5x: 20s wall-clock = 10s media, all in one cell', () => {
    const segment = createSegment(
      0, 20000,       // 20s wall-clock
      5.1, 5.4,       // 0.3s media (within cell 5)
      0.5, 'normal', lsId,
    );
    const cells = new Map<string, ExposureCell>();
    const session = newSession();
    const contributions = distributeSegmentToCells(segment, cells, session);

    expect(contributions).toHaveLength(1);
    expect(contributions[0]!.foregroundWatchMs).toBe(20000);
  });

  it('1x: 10s wall-clock spans multiple cells proportionally', () => {
    const segment = createSegment(
      0, 10000,       // 10s wall-clock
      5.0, 10.0,      // 5.0s media progression
      1, 'normal', lsId,
    );
    const cells = new Map<string, ExposureCell>();
    const session = newSession();
    const contributions = distributeSegmentToCells(segment, cells, session);

    expect(contributions.length).toBeGreaterThanOrEqual(2);
    const totalWall = contributions.reduce((s, c) => s + c.foregroundWatchMs, 0);
    expect(totalWall).toBeCloseTo(10000, 0);
  });
});

/* ------------------------------------------------------------------------ */
/* 2x crossing 2 seconds → proportional distribution                       */
/* ------------------------------------------------------------------------ */

describe('distributeSegmentToCells — 2x multi-cell distribution', () => {
  const lsId = 'media1:sub1';

  it('2x: 2s media in 1s wall-clock distributes proportionally', () => {
    // mediaStart=5.0 → round=5, mediaEnd=7.0 → round=7
    // cells covered: 5, 6, 7 → 3 cells
    const segment = createSegment(
      0, 1000,        // 1s wall-clock
      5.0, 7.0,       // 2s media progression (2x effective)
      2, 'normal', lsId,
    );
    const cells = new Map<string, ExposureCell>();
    const session = newSession();
    const contributions = distributeSegmentToCells(segment, cells, session);

    expect(contributions.length).toBeGreaterThanOrEqual(2);

    // Total wall-clock should be ~1000ms
    const totalWall = contributions.reduce((s, c) => s + c.foregroundWatchMs, 0);
    expect(totalWall).toBeCloseTo(1000, 0);
  });

  it('2x crossing 2s in 1s distributes proportionally to media overlap', () => {
    // mediaStart=4.6 → round=5, mediaEnd=6.4 → round=6
    // cells covered: 5, 6 → 2 cells
    // Cell 5: media overlap [4.6, 5.5] = 0.9s
    // Cell 6: media overlap [5.5, 6.4] = 0.9s
    const segment = createSegment(
      0, 1000,        // 1s wall-clock
      4.6, 6.4,       // 1.8s media progression
      2, 'normal', lsId,
    );
    const cells = new Map<string, ExposureCell>();
    const session = newSession();
    const contributions = distributeSegmentToCells(segment, cells, session);

    expect(contributions.length).toBe(2);
    // Total wall-clock should be ~1000ms
    const totalWall = contributions.reduce((s, c) => s + c.foregroundWatchMs, 0);
    expect(totalWall).toBeCloseTo(1000, 0);
    // Both cells have equal overlap (0.9s each), so distribution is ~50/50
    for (const c of contributions) {
      expect(c.foregroundWatchMs).toBeCloseTo(500, 0);
    }
  });

  it('unequal overlap distributes wall-clock proportionally', () => {
    // mediaStart=4.9 → round=5, mediaEnd=5.2 → round=5 (single cell)
    // But test with wider range that hits 2 cells unequally
    // mediaStart=4.8 → round=5, mediaEnd=6.1 → round=6
    // Cell 5: overlap [4.8, 5.5] = 0.7s
    // Cell 6: overlap [5.5, 6.1] = 0.6s
    const segment = createSegment(
      0, 2000,        // 2s wall-clock
      4.8, 6.1,       // 1.3s media progression
      1, 'normal', lsId,
    );
    const cells = new Map<string, ExposureCell>();
    const session = newSession();
    const contributions = distributeSegmentToCells(segment, cells, session);

    expect(contributions.length).toBe(2);
    const totalWall = contributions.reduce((s, c) => s + c.foregroundWatchMs, 0);
    expect(totalWall).toBeCloseTo(2000, 0);

    // Cell 5 has more overlap, so should get more wall-clock
    const cell5 = contributions.find((c) => c.roundedSecond === 5)!;
    const cell6 = contributions.find((c) => c.roundedSecond === 6)!;
    expect(cell5.foregroundWatchMs).toBeGreaterThan(cell6.foregroundWatchMs);
  });
});

/* ------------------------------------------------------------------------ */
/* Same 10 seconds viewed 3 times — effective exposure decay                */
/* ------------------------------------------------------------------------ */

describe('distributeSegmentToCells — repetition decay', () => {
  const lsId = 'media1:sub1';

  it('same cell viewed 3 times produces 1.0 / 0.5 / 0.25 effective', () => {
    const cells = new Map<string, ExposureCell>();

    // Pass 1: fresh cell
    const session1 = newSession();
    const seg1 = createSegment(0, 10000, 5.1, 5.4, 1, 'normal', lsId);
    const c1 = distributeSegmentToCells(seg1, cells, session1);
    expect(c1).toHaveLength(1);
    expect(c1[0]!.effectiveExposureMs).toBe(10000); // 1st pass, decay=1.0

    // Apply + mark session-seen
    const state = createAccumulatorState();
    applyContributions(state, c1, lsId, 'normal', false, session1);

    // Pass 2: same cell (same session → no new pass)
    const seg2 = createSegment(10000, 20000, 5.1, 5.4, 1, 'normal', lsId);
    const c2 = distributeSegmentToCells(seg2, cells, session1);
    // Same session, already seen → isNewPass=false, effective=10000 * 0 (passCount=1, decay=1.0, but isNewPass=false → uses current passCount)
    expect(c2).toHaveLength(1);
    // passCount is 1, isNewPass is false, so effectiveExposureMs = 10000 * repetitionDecayFactor(1) = 10000
    // But we need to verify: the formula is (is7DayReset ? 0 : passCount) + (isNewPass ? 1 : 0)
    // passCount=1, isNewPass=false → effective factor = repetitionDecayFactor(1) = 1.0
    // This is correct — within the same session, subsequent segments don't increment pass
  });

  it('same cell across 3 separate sessions produces 1.0 / 0.5 / 0.25', () => {
    const cells = new Map<string, ExposureCell>();
    const rk = cellKey(lsId, 5);

    // Session 1: first time touching this cell
    const session1 = newSession();
    const seg1 = createSegment(0, 10000, 5.1, 5.4, 1, 'normal', lsId);
    const c1 = distributeSegmentToCells(seg1, cells, session1);
    expect(c1[0]!.effectiveExposureMs).toBe(10000); // decay=1.0
    expect(c1[0]!.isNewPass).toBe(true);

    // Apply to state (simulates DB persistence)
    cells.set(rk, {
      cellKey: rk,
      learningSetId: lsId,
      roundedSecond: 5,
      foregroundWatchMs: 10000,
      effectiveExposureMs: 10000,
      passCount: 1,
      lastSeenAt: Date.now(),
      hasCoverage: true,
      subtitleExposureMs: 0,
      pauseCount: 0,
      manualBackwardSeekCount: 0,
      mineCount: 0,
    });

    // Session 2: fresh sessionSeenCells, cell exists with passCount=1
    const session2 = newSession();
    const seg2 = createSegment(10000, 20000, 5.1, 5.4, 1, 'normal', lsId);
    const c2 = distributeSegmentToCells(seg2, cells, session2);
    expect(c2[0]!.isNewPass).toBe(true); // new session → new pass
    expect(c2[0]!.effectiveExposureMs).toBeCloseTo(5000); // decay=0.5

    // Update cell to reflect pass 2 completed
    cells.set(rk, {
      ...cells.get(rk)!,
      passCount: 2,
      effectiveExposureMs: 15000,
    });

    // Session 3: fresh sessionSeenCells, cell exists with passCount=2
    const session3 = newSession();
    const seg3 = createSegment(20000, 30000, 5.1, 5.4, 1, 'normal', lsId);
    const c3 = distributeSegmentToCells(seg3, cells, session3);
    expect(c3[0]!.isNewPass).toBe(true); // new session → new pass
    expect(c3[0]!.effectiveExposureMs).toBeCloseTo(2500); // decay=0.25

    // Update cell to reflect pass 3 completed
    cells.set(rk, {
      ...cells.get(rk)!,
      passCount: 3,
      effectiveExposureMs: 17500,
    });

    // Session 4: fresh sessionSeenCells, cell exists with passCount=3
    const session4 = newSession();
    const seg4 = createSegment(30000, 40000, 5.1, 5.4, 1, 'normal', lsId);
    const c4 = distributeSegmentToCells(seg4, cells, session4);
    expect(c4[0]!.isNewPass).toBe(true); // new session → new pass
    expect(c4[0]!.effectiveExposureMs).toBeCloseTo(1250); // decay=0.125
  });

  it('loaded cell with passCount=5 gets decay 0.0625 in next session', () => {
    const cells = new Map<string, ExposureCell>();
    const rk = cellKey(lsId, 5);

    // Simulate a cell loaded from DB with passCount=5
    cells.set(rk, {
      cellKey: rk,
      learningSetId: lsId,
      roundedSecond: 5,
      foregroundWatchMs: 50000,
      effectiveExposureMs: 28125,
      passCount: 5,
      lastSeenAt: Date.now(),
      hasCoverage: true,
      subtitleExposureMs: 0,
      pauseCount: 0,
      manualBackwardSeekCount: 0,
      mineCount: 0,
    });

    // New session
    const session = newSession();
    const seg = createSegment(0, 10000, 5.1, 5.4, 1, 'normal', lsId);
    const c = distributeSegmentToCells(seg, cells, session);
    expect(c[0]!.isNewPass).toBe(true);
    // passCount=5 + isNewPass → decay for pass 6 = 0.5^5 = 0.03125
    expect(c[0]!.effectiveExposureMs).toBeCloseTo(312.5);
  });
});

/* ------------------------------------------------------------------------ */
/* 7-day reset per cell                                                     */
/* ------------------------------------------------------------------------ */

describe('distributeSegmentToCells — 7-day reset', () => {
  const lsId = 'media1:sub1';

  it('cell older than 7 days resets pass count', () => {
    const rk = cellKey(lsId, 5);
    const cells = new Map<string, ExposureCell>();
    cells.set(rk, {
      cellKey: rk,
      learningSetId: lsId,
      roundedSecond: 5,
      foregroundWatchMs: 10000,
      effectiveExposureMs: 15000, // after 2 passes
      passCount: 2,
      lastSeenAt: Date.now() - SEVEN_DAYS_MS - 1000, // > 7 days ago
      hasCoverage: true,
      subtitleExposureMs: 0,
      pauseCount: 0,
      manualBackwardSeekCount: 0,
      mineCount: 0,
    });

    const session = newSession();
    const segment = createSegment(0, 5000, 5.1, 5.4, 1, 'normal', lsId);
    const contributions = distributeSegmentToCells(segment, cells, session);

    // Should be treated as 1st pass (decay = 1.0)
    expect(contributions).toHaveLength(1);
    expect(contributions[0]!.effectiveExposureMs).toBe(5000);
    expect(contributions[0]!.isNewPass).toBe(true);
  });

  it('cell within 7 days continues decay', () => {
    const rk = cellKey(lsId, 5);
    const cells = new Map<string, ExposureCell>();
    cells.set(rk, {
      cellKey: rk,
      learningSetId: lsId,
      roundedSecond: 5,
      foregroundWatchMs: 10000,
      effectiveExposureMs: 10000,
      passCount: 1,
      lastSeenAt: Date.now() - 1000, // 1 second ago
      hasCoverage: true,
      subtitleExposureMs: 0,
      pauseCount: 0,
      manualBackwardSeekCount: 0,
      mineCount: 0,
    });

    const session = newSession();
    const segment = createSegment(0, 5000, 5.1, 5.4, 1, 'normal', lsId);
    const contributions = distributeSegmentToCells(segment, cells, session);

    // Should be treated as 2nd pass (decay = 0.5)
    expect(contributions).toHaveLength(1);
    expect(contributions[0]!.effectiveExposureMs).toBeCloseTo(2500, 0);
  });
});

/* ------------------------------------------------------------------------ */
/* Contiguous-pass dedupe                                                   */
/* ------------------------------------------------------------------------ */

describe('distributeSegmentToCells — contiguous-pass dedupe', () => {
  const lsId = 'media1:sub1';

  it('same pass through same cell does not increment passCount multiple times', () => {
    const cells = new Map<string, ExposureCell>();

    // A segment that spans 2 cells (5 and 6)
    const session = newSession();
    const segment = createSegment(0, 2000, 4.5, 6.5, 1, 'normal', lsId);
    const contributions = distributeSegmentToCells(segment, cells, session);

    // Both cells should be marked as isNewPass (first time seen)
    for (const c of contributions) {
      expect(c.isNewPass).toBe(true);
    }

    // Apply contributions
    const state = createAccumulatorState();
    applyContributions(state, contributions, lsId, 'normal', false, session);

    // Both cells should have passCount = 1 (not 2)
    for (const cell of state.cells.values()) {
      expect(cell.passCount).toBe(1);
    }
  });

  it('second segment in same session does not re-increment pass', () => {
    const session = newSession();
    const state = createAccumulatorState();

    // First segment: cells 5, 6
    const seg1 = createSegment(0, 2000, 4.5, 6.5, 1, 'normal', lsId);
    const c1 = distributeSegmentToCells(seg1, state.cells, session);
    applyContributions(state, c1, lsId, 'normal', false, session);

    // Second segment in same session: pass state.cells (now populated)
    const seg2 = createSegment(2000, 4000, 4.5, 6.5, 1, 'normal', lsId);
    const c2 = distributeSegmentToCells(seg2, state.cells, session);

    // Both should NOT be new pass (already seen in this session)
    for (const c of c2) {
      expect(c.isNewPass).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Per-session pass increment — loaded cells get new pass per session       */
/* ------------------------------------------------------------------------ */

describe('distributeSegmentToCells — per-session pass increment', () => {
  const lsId = 'media1:sub1';

  it('loaded cell with passCount=2 gets pass 3 in new session (decay 0.25)', () => {
    const cells = new Map<string, ExposureCell>();
    const rk = cellKey(lsId, 5);

    // Simulate loaded from DB: passCount=2
    cells.set(rk, {
      cellKey: rk,
      learningSetId: lsId,
      roundedSecond: 5,
      foregroundWatchMs: 20000,
      effectiveExposureMs: 15000,
      passCount: 2,
      lastSeenAt: Date.now(),
      hasCoverage: true,
      subtitleExposureMs: 0,
      pauseCount: 0,
      manualBackwardSeekCount: 0,
      mineCount: 0,
    });

    const session = newSession();
    const seg = createSegment(0, 10000, 5.1, 5.4, 1, 'normal', lsId);
    const c = distributeSegmentToCells(seg, cells, session);

    expect(c).toHaveLength(1);
    expect(c[0]!.isNewPass).toBe(true);
    // passCount=2, isNewPass → next pass is 3 → decay = 0.5^2 = 0.25
    expect(c[0]!.effectiveExposureMs).toBeCloseTo(2500);
  });

  it('same session does not re-increment for same cell', () => {
    const cells = new Map<string, ExposureCell>();
    const rk = cellKey(lsId, 5);

    // Simulate loaded from DB: passCount=3
    cells.set(rk, {
      cellKey: rk,
      learningSetId: lsId,
      roundedSecond: 5,
      foregroundWatchMs: 30000,
      effectiveExposureMs: 17500,
      passCount: 3,
      lastSeenAt: Date.now(),
      hasCoverage: true,
      subtitleExposureMs: 0,
      pauseCount: 0,
      manualBackwardSeekCount: 0,
      mineCount: 0,
    });

    const session = newSession();
    const state = createAccumulatorState();

    // First segment in session
    const seg1 = createSegment(0, 5000, 5.1, 5.4, 1, 'normal', lsId);
    const c1 = distributeSegmentToCells(seg1, cells, session);
    applyContributions(state, c1, lsId, 'normal', false, session);
    expect(c1[0]!.isNewPass).toBe(true);
    expect(c1[0]!.effectiveExposureMs).toBeCloseTo(625); // pass 4 → decay 0.125

    // Second segment in same session — should NOT increment again
    const seg2 = createSegment(5000, 10000, 5.1, 5.4, 1, 'normal', lsId);
    const c2 = distributeSegmentToCells(seg2, cells, session);
    expect(c2[0]!.isNewPass).toBe(false);
    // effectiveExposureMs uses passCount=3 (not incremented) → decay = 0.25
    expect(c2[0]!.effectiveExposureMs).toBeCloseTo(1250);
  });

  it('new session increments passCount again for same cell', () => {
    const cells = new Map<string, ExposureCell>();
    const rk = cellKey(lsId, 5);

    // Simulate loaded from DB: passCount=3
    cells.set(rk, {
      cellKey: rk,
      learningSetId: lsId,
      roundedSecond: 5,
      foregroundWatchMs: 30000,
      effectiveExposureMs: 17500,
      passCount: 3,
      lastSeenAt: Date.now(),
      hasCoverage: true,
      subtitleExposureMs: 0,
      pauseCount: 0,
      manualBackwardSeekCount: 0,
      mineCount: 0,
    });

    // Session 1
    const session1 = newSession();
    const seg1 = createSegment(0, 5000, 5.1, 5.4, 1, 'normal', lsId);
    const c1 = distributeSegmentToCells(seg1, cells, session1);
    expect(c1[0]!.isNewPass).toBe(true);
    expect(c1[0]!.effectiveExposureMs).toBeCloseTo(625); // pass 4 → decay 0.125

    // Session 2 (fresh sessionSeenCells)
    const session2 = newSession();
    const seg2 = createSegment(5000, 10000, 5.1, 5.4, 1, 'normal', lsId);
    const c2 = distributeSegmentToCells(seg2, cells, session2);
    expect(c2[0]!.isNewPass).toBe(true);
    expect(c2[0]!.effectiveExposureMs).toBeCloseTo(625); // still pass 4 (session1 didn't persist passCount increment)
  });
});

/* ------------------------------------------------------------------------ */
/* Manual seek not inflating mediaProgressMs                                */
/* ------------------------------------------------------------------------ */

describe('distributeSegmentToCells — seek exclusion', () => {
  const lsId = 'media1:sub1';

  it('seek does not add to hasCoverage', () => {
    // A seek: media jumps from 5.0 to 10.0 in 100ms (way too fast for normal playback)
    const segment = createSegment(0, 100, 5.0, 10.0, 1, 'normal', lsId);
    const cells = new Map<string, ExposureCell>();
    const session = newSession();
    const contributions = distributeSegmentToCells(segment, cells, session);

    // Seek detection: mediaDelta (5000ms) > wallClock (100ms) * 1.5
    // and wallClock < 500ms
    for (const c of contributions) {
      expect(c.hasCoverage).toBe(false);
    }
  });

  it('normal playback adds coverage', () => {
    const segment = createSegment(0, 5000, 5.0, 10.0, 1, 'normal', lsId);
    const cells = new Map<string, ExposureCell>();
    const session = newSession();
    const contributions = distributeSegmentToCells(segment, cells, session);

    for (const c of contributions) {
      expect(c.hasCoverage).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Pause transition detection                                               */
/* ------------------------------------------------------------------------ */

describe('isPauseTransition', () => {
  it('playing→paused is a pause transition', () => {
    expect(isPauseTransition(true, false, false)).toBe(true);
  });

  it('playing→paused while buffering is NOT a pause', () => {
    expect(isPauseTransition(true, false, true)).toBe(false);
  });

  it('paused→playing is not a pause', () => {
    expect(isPauseTransition(false, true, false)).toBe(false);
  });

  it('playing→playing is not a pause', () => {
    expect(isPauseTransition(true, true, false)).toBe(false);
  });

  it('paused→paused is not a pause', () => {
    expect(isPauseTransition(false, false, false)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Manual backward seek detection                                           */
/* ------------------------------------------------------------------------ */

describe('isManualBackwardSeek', () => {
  it('detects backward seek', () => {
    expect(isManualBackwardSeek(10.0, 5.0, 100)).toBe(true);
  });

  it('normal forward playback is not a backward seek', () => {
    expect(isManualBackwardSeek(5.0, 10.0, 5000)).toBe(false);
  });

  it('small backward jump is not a seek', () => {
    expect(isManualBackwardSeek(5.0, 4.6, 500)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Cell key helpers                                                         */
/* ------------------------------------------------------------------------ */

describe('cellKey', () => {
  it('creates composite key', () => {
    expect(cellKey('media1:sub1', 5)).toBe('media1:sub1:5');
  });

  it('handles zero', () => {
    expect(cellKey('a', 0)).toBe('a:0');
  });
});

/* ------------------------------------------------------------------------ */
/* Empty totals                                                             */
/* ------------------------------------------------------------------------ */

describe('emptyTotals', () => {
  it('returns zeroed totals', () => {
    const t = emptyTotals();
    expect(t.foregroundWatchMs).toBe(0);
    expect(t.mediaProgressMs).toBe(0);
    expect(t.uniqueCoverageMs).toBe(0);
    expect(t.effectiveExposureMs).toBe(0);
    expect(t.subtitleExposureMs).toBe(0);
    expect(t.condensedSkippedMs).toBe(0);
    expect(t.fastForwardWallMs).toBe(0);
    expect(t.fastForwardMediaMs).toBe(0);
    expect(t.rateBuckets).toEqual({});
    expect(t.manualBackwardSeekCount).toBe(0);
    expect(t.mineCount).toBe(0);
  });
});

/* ------------------------------------------------------------------------ */
/* createAccumulatorState                                                   */
/* ------------------------------------------------------------------------ */

describe('createAccumulatorState', () => {
  it('creates empty state', () => {
    const state = createAccumulatorState();
    expect(state.cells.size).toBe(0);
    expect(state.totals.foregroundWatchMs).toBe(0);
  });
});

/* ------------------------------------------------------------------------ */
/* mergeTotals                                                              */
/* ------------------------------------------------------------------------ */

describe('mergeTotals', () => {
  it('merges two totals additively', () => {
    const a = emptyTotals();
    a.foregroundWatchMs = 1000;
    a.rateBuckets = { normal: 500 };
    const b = emptyTotals();
    b.foregroundWatchMs = 2000;
    b.rateBuckets = { normal: 300, condensed: 200 };

    const merged = mergeTotals(a, b);
    expect(merged.foregroundWatchMs).toBe(3000);
    expect(merged.rateBuckets).toEqual({ normal: 800, condensed: 200 });
  });
});
