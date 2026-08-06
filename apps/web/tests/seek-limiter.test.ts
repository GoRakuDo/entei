/**
 * Tests for seek-limiter — companion seek clamping to verified byte range.
 */
import { describe, it, expect } from 'vitest';
import { clampCompanionSeek } from '@/features/player/seek-limiter';

describe('clampCompanionSeek', () => {
  // 100 MiB file, 60s duration, 50 MiB available
  const total = 100 * 1024 * 1024;
  const duration = 60;
  const available = 50 * 1024 * 1024;

  it('allows seek within available range', () => {
    // 30s = 50% of 60s = 50% of 100 MiB = 50 MiB — exactly at the boundary
    expect(clampCompanionSeek(30, available, total, duration)).toBe(30);
  });

  it('clamps seek beyond available range', () => {
    // 45s = 75% → 75 MiB > 50 MiB available → clamp to 30s
    expect(clampCompanionSeek(45, available, total, duration)).toBe(30);
  });

  it('allows seek well within available range', () => {
    // 10s = 16.7% → 16.7 MiB < 50 MiB available → no clamp
    expect(clampCompanionSeek(10, available, total, duration)).toBe(10);
  });

  it('returns seekSeconds unchanged when available >= total', () => {
    expect(clampCompanionSeek(50, total, total, duration)).toBe(50);
    expect(clampCompanionSeek(50, total + 1, total, duration)).toBe(50);
  });

  it('returns seekSeconds unchanged for degenerate inputs', () => {
    // total = 0
    expect(clampCompanionSeek(10, 0, 0, 60)).toBe(10);
    // duration = 0
    expect(clampCompanionSeek(10, 50, 100, 0)).toBe(10);
    // negative seek
    expect(clampCompanionSeek(-1, available, total, duration)).toBe(-1);
    // NaN
    expect(clampCompanionSeek(NaN, available, total, duration)).toBeNaN();
    // Infinity
    expect(clampCompanionSeek(Infinity, available, total, duration)).toBe(
      Infinity,
    );
  });

  it('clamps at exactly 0 when available is 0', () => {
    expect(clampCompanionSeek(30, 0, total, duration)).toBe(0);
  });

  it('handles small files correctly', () => {
    // 1 MiB file, 10s, 512 KiB available
    const smallTotal = 1024 * 1024;
    const smallAvailable = 512 * 1024;
    // 7s = 70% → 700 KiB > 512 KiB → clamp to 5s
    expect(clampCompanionSeek(7, smallAvailable, smallTotal, 10)).toBe(5);
  });
});
