/**
 * Component tests for Entei Slider — thumb count derivation.
 * ---------------------------------------------------------------------------
 * - Slider derives thumb count from controlled `value`, then `defaultValue`, fallback 1.
 * - Single value renders 1 thumb; 2-element array renders 2 thumbs.
 * - Existing single sliders retain one thumb.
 * - Mining [start, end] two thumbs with stable index key.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Slider } from '@/components/player/ui/slider';

beforeEach(() => {
  global.ResizeObserver = vi.fn(function () {
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Slider — thumb count derivation', () => {
  it('renders 1 thumb when value is a single number', () => {
    render(<Slider value={[50]} min={0} max={100} />);
    const thumbs = document.body.querySelectorAll('[role="slider"]');
    expect(thumbs.length).toBe(1);
  });

  it('renders 2 thumbs when value is a 2-element array', () => {
    render(<Slider value={[10, 50]} min={0} max={100} />);
    const thumbs = document.body.querySelectorAll('[role="slider"]');
    expect(thumbs.length).toBe(2);
  });

  it('renders 1 thumb when defaultValue is a single number and no value', () => {
    render(<Slider defaultValue={[30]} min={0} max={100} />);
    const thumbs = document.body.querySelectorAll('[role="slider"]');
    expect(thumbs.length).toBe(1);
  });

  it('renders 2 thumbs when defaultValue is a 2-element array and no value', () => {
    render(<Slider defaultValue={[10, 80]} min={0} max={100} />);
    const thumbs = document.body.querySelectorAll('[role="slider"]');
    expect(thumbs.length).toBe(2);
  });

  it('falls back to 1 thumb when neither value nor defaultValue provided', () => {
    render(<Slider min={0} max={100} />);
    const thumbs = document.body.querySelectorAll('[role="slider"]');
    expect(thumbs.length).toBe(1);
  });

  it('controlled value overrides defaultValue thumb count', () => {
    render(<Slider value={[5, 95]} defaultValue={[20]} min={0} max={100} />);
    const thumbs = document.body.querySelectorAll('[role="slider"]');
    expect(thumbs.length).toBe(2);
  });

  it('mining range slider with [start, end] renders 2 thumbs', () => {
    render(
      <Slider
        value={[10, 15]}
        min={0}
        max={60}
        step={0.1}
        className="entei-mining-range-slider"
      />,
    );
    const thumbs = document.body.querySelectorAll(
      '.entei-mining-range-slider [role="slider"]',
    );
    expect(thumbs.length).toBe(2);
  });
});
