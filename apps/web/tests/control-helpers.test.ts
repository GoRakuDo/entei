/**
 * Tests for player control-helpers (P1.1).
 */
import { describe, it, expect } from 'vitest';
import {
  formatTime,
  clampSeek,
  toggleMute,
  nextControlsVisibility,
  isControlTarget,
  isFullscreenAvailable,
  isDocumentFullscreen,
  PLAYBACK_RATES,
  surfaceClickEffect,
  shouldScheduleAutoHide,
} from '@/features/player/control-helpers';

describe('formatTime', () => {
  it('formats zero as 00:00', () => {
    expect(formatTime(0)).toBe('00:00');
  });

  it('formats seconds only', () => {
    expect(formatTime(5)).toBe('00:05');
    expect(formatTime(59)).toBe('00:59');
  });

  it('formats minutes and seconds', () => {
    expect(formatTime(60)).toBe('01:00');
    expect(formatTime(90)).toBe('01:30');
    expect(formatTime(3599)).toBe('59:59');
  });

  it('formats hours', () => {
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3661)).toBe('1:01:01');
  });

  it('returns --:-- for NaN', () => {
    expect(formatTime(NaN)).toBe('--:--');
  });

  it('returns --:-- for Infinity', () => {
    expect(formatTime(Infinity)).toBe('--:--');
    expect(formatTime(-Infinity)).toBe('--:--');
  });

  it('returns --:-- for negative', () => {
    expect(formatTime(-1)).toBe('--:--');
  });
});

describe('clampSeek', () => {
  it('returns time when in range', () => {
    expect(clampSeek(5, 100)).toBe(5);
  });

  it('clamps to 0 for negative time', () => {
    expect(clampSeek(-1, 100)).toBe(0);
  });

  it('clamps to duration for time > duration', () => {
    expect(clampSeek(200, 100)).toBe(100);
  });

  it('handles NaN time', () => {
    expect(clampSeek(NaN, 100)).toBe(0);
  });

  it('handles Infinity time', () => {
    // Infinity is not a finite seek position — clamp to 0
    expect(clampSeek(Infinity, 100)).toBe(0);
  });

  it('handles zero/NaN duration', () => {
    expect(clampSeek(5, 0)).toBe(5);
    expect(clampSeek(5, NaN)).toBe(5);
    expect(clampSeek(5, -Infinity)).toBe(5);
  });
});

describe('toggleMute', () => {
  it('mutes when volume > 0', () => {
    const result = toggleMute(0.8, 0.8);
    expect(result.volume).toBe(0);
    expect(result.restored).toBe(0);
  });

  it('unmutes when volume === 0', () => {
    const result = toggleMute(0, 0.5);
    expect(result.volume).toBe(0.5);
    expect(result.restored).toBe(0.5);
  });

  it('unmutes with minimum volume when prevVolume is very small', () => {
    const result = toggleMute(0, 0.001);
    expect(result.volume).toBeGreaterThanOrEqual(0.01);
    expect(result.restored).toBe(0.001);
  });
});

describe('nextControlsVisibility', () => {
  it('always visible when not playing', () => {
    expect(
      nextControlsVisibility({ type: 'timer-expired' }, false, false),
    ).toEqual({ visible: true });
  });

  it('hides on timer expired when playing', () => {
    expect(
      nextControlsVisibility({ type: 'timer-expired' }, true, true),
    ).toEqual({ visible: false });
  });

  it('shows on pointer-move when playing', () => {
    expect(
      nextControlsVisibility({ type: 'pointer-move' }, true, false),
    ).toEqual({ visible: true });
  });

  it('shows on media-ended', () => {
    expect(
      nextControlsVisibility({ type: 'media-ended' }, true, false),
    ).toEqual({ visible: true });
  });

  it('shows on media-error', () => {
    expect(
      nextControlsVisibility({ type: 'media-error' }, true, false),
    ).toEqual({ visible: true });
  });

  it('shows on seek-start', () => {
    expect(nextControlsVisibility({ type: 'seek-start' }, true, false)).toEqual(
      { visible: true },
    );
  });

  it('shows on keyboard-focus', () => {
    expect(
      nextControlsVisibility({ type: 'keyboard-focus' }, true, false),
    ).toEqual({ visible: true });
  });
});

describe('isControlTarget', () => {
  it('returns false for non-HTML targets', () => {
    expect(isControlTarget(null)).toBe(false);
    expect(isControlTarget('string' as unknown as EventTarget)).toBe(false);
  });

  it('returns true for button elements', () => {
    const el = document.createElement('button');
    expect(isControlTarget(el)).toBe(true);
  });

  it('returns true for role="button"', () => {
    const el = document.createElement('span');
    el.setAttribute('role', 'button');
    expect(isControlTarget(el)).toBe(true);
  });

  it('returns true for role="slider"', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'slider');
    expect(isControlTarget(el)).toBe(true);
  });

  it('returns true for role="switch"', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'switch');
    expect(isControlTarget(el)).toBe(true);
  });

  it('returns false for a plain div', () => {
    const el = document.createElement('div');
    expect(isControlTarget(el)).toBe(false);
  });

  it('returns true for a child of a button', () => {
    const btn = document.createElement('button');
    const child = document.createElement('span');
    btn.appendChild(child);
    expect(isControlTarget(child)).toBe(true);
  });

  it('returns true for child inside role="slider"', () => {
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    const thumb = document.createElement('div');
    slider.appendChild(thumb);
    expect(isControlTarget(thumb)).toBe(true);
  });
});

describe('PLAYBACK_RATES', () => {
  it('has expected values', () => {
    expect(PLAYBACK_RATES).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  });

  it('is sorted ascending', () => {
    for (let i = 1; i < PLAYBACK_RATES.length; i++) {
      expect(PLAYBACK_RATES[i]).toBeGreaterThan(PLAYBACK_RATES[i - 1]!);
    }
  });
});

describe('isFullscreenAvailable', () => {
  it('returns a boolean in jsdom', () => {
    expect(typeof isFullscreenAvailable()).toBe('boolean');
  });
});

describe('isDocumentFullscreen', () => {
  it('returns a boolean in jsdom', () => {
    // jsdom doesn't have a real fullscreen implementation; result depends
    // on the jsdom version but must always be a boolean.
    expect(typeof isDocumentFullscreen()).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// surfaceClickEffect — mobile vs desktop surface tap policy
// ---------------------------------------------------------------------------

describe('surfaceClickEffect', () => {
  it('touch + controls visible: toggles OFF, does NOT toggle play', () => {
    const effect = surfaceClickEffect(true, true);
    expect(effect.togglePlay).toBe(false);
    expect(effect.setVisibility).toBe('hide');
  });

  it('touch + controls hidden: toggles ON, does NOT toggle play', () => {
    const effect = surfaceClickEffect(true, false);
    expect(effect.togglePlay).toBe(false);
    expect(effect.setVisibility).toBe('show');
  });

  it('desktop + controls visible: shows controls AND toggles play', () => {
    const effect = surfaceClickEffect(false, true);
    expect(effect.togglePlay).toBe(true);
    expect(effect.setVisibility).toBe('show');
  });

  it('desktop + controls hidden: shows controls AND toggles play', () => {
    const effect = surfaceClickEffect(false, false);
    expect(effect.togglePlay).toBe(true);
    expect(effect.setVisibility).toBe('show');
  });
});

// ---------------------------------------------------------------------------
// shouldScheduleAutoHide — auto-hide policy (same for touch and desktop)
// ---------------------------------------------------------------------------

describe('shouldScheduleAutoHide', () => {
  it('touch device: schedules auto-hide when not reduced motion', () => {
    expect(shouldScheduleAutoHide(true, false)).toBe(true);
  });

  it('touch device + reduced motion: no auto-hide', () => {
    expect(shouldScheduleAutoHide(true, true)).toBe(false);
  });

  it('desktop + no reduced motion: schedules auto-hide', () => {
    expect(shouldScheduleAutoHide(false, false)).toBe(true);
  });

  it('desktop + reduced motion: no auto-hide', () => {
    expect(shouldScheduleAutoHide(false, true)).toBe(false);
  });
});
