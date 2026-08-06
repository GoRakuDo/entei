/**
 * TypewriterLoading — typewriter text animation tests.
 * ---------------------------------------------------------------------------
 * Tests the typewriterText pure function and the component's tick-based
 * animation using fake timers.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import {
  TypewriterLoading,
  typewriterText,
} from '@/components/player/TypewriterLoading';

describe('typewriterText', () => {
  it('types characters one by one', () => {
    expect(typewriterText(0, 'LOADING', 3)).toBe('');
    expect(typewriterText(1, 'LOADING', 3)).toBe('L');
    expect(typewriterText(2, 'LOADING', 3)).toBe('LO');
    expect(typewriterText(7, 'LOADING', 3)).toBe('LOADING');
  });

  it('appends dots after base text', () => {
    expect(typewriterText(8, 'LOADING', 3)).toBe('LOADING.');
    expect(typewriterText(9, 'LOADING', 3)).toBe('LOADING..');
    expect(typewriterText(10, 'LOADING', 3)).toBe('LOADING...');
  });

  it('clears after full cycle (text.length + dots + 1)', () => {
    // cycle length = 7 + 3 + 1 = 11
    expect(typewriterText(10, 'LOADING', 3)).toBe('LOADING...');
    expect(typewriterText(11, 'LOADING', 3)).toBe(''); // clear frame
    expect(typewriterText(12, 'LOADING', 3)).toBe('L'); // restart
  });

  it('works with custom text and dots', () => {
    expect(typewriterText(0, 'HI', 1)).toBe('');
    expect(typewriterText(1, 'HI', 1)).toBe('H');
    expect(typewriterText(2, 'HI', 1)).toBe('HI');
    expect(typewriterText(3, 'HI', 1)).toBe('HI.');
    expect(typewriterText(4, 'HI', 1)).toBe(''); // clear
  });

  it('works with zero dots', () => {
    expect(typewriterText(0, 'GO', 0)).toBe('');
    expect(typewriterText(1, 'GO', 0)).toBe('G');
    expect(typewriterText(2, 'GO', 0)).toBe('GO');
    expect(typewriterText(3, 'GO', 0)).toBe(''); // clear
  });
});

describe('TypewriterLoading component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mock matchMedia to return no reduced-motion preference
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders with role="status" and aria-label from parent', () => {
    const { getByRole } = render(
      <div role="status" aria-label="Loading">
        <TypewriterLoading />
      </div>,
    );
    const el = getByRole('status');
    expect(el.getAttribute('aria-label')).toBe('Loading');
  });

  it('starts with empty text and types over time', async () => {
    const { container } = render(<TypewriterLoading delay={100} />);
    const el = container.querySelector('.entei-typewriter')!;

    // Initial: empty (just caret)
    expect(el.textContent).toBe('');

    // After 1 tick (100ms): "L"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(el.textContent).toBe('L');

    // After 7 ticks: "LOADING"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(el.textContent).toBe('LOADING');

    // After 10 ticks: "LOADING..."
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(el.textContent).toBe('LOADING...');
  });

  it('clears after full cycle and restarts after hold', async () => {
    const { container } = render(
      <TypewriterLoading text="HI" dots={1} delay={100} holdMs={200} />,
    );
    const el = container.querySelector('.entei-typewriter')!;

    // Type: H (100ms) → HI (200ms) → HI. (300ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(el.textContent).toBe('HI.');

    // Clear frame (400ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(el.textContent).toBe('');

    // Hold period (200ms) — still empty
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(el.textContent).toBe('');

    // Restart (next tick after hold)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(el.textContent).toBe('H');
  });

  it('does not animate when prefers-reduced-motion is reduce', async () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: true, // prefers reduced motion
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    const { container } = render(
      <TypewriterLoading text="HI" dots={1} delay={100} />,
    );
    const el = container.querySelector('.entei-typewriter')!;

    // Should show full text statically (no animation tick)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(el.textContent).toBe('HI.');
  });
});
