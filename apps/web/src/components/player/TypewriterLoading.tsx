/**
 * TypewriterLoading — Animated "LOADING..." text with typewriter effect.
 * ---------------------------------------------------------------------------
 * Replaces the Loader2 spinner in player loading overlays. Characters appear
 * left-to-right, dots accumulate, then the text clears and repeats after a
 * hold period. A blinking caret sits at the right edge of the visible text.
 *
 * The animation respects `prefers-reduced-motion`: when the user prefers
 * reduced motion, the component renders a static "LOADING..." without any
 * animation.
 * ---------------------------------------------------------------------------
 */
'use client';

import { type HTMLAttributes, useEffect, useRef, useState } from 'react';

export interface TypewriterLoadingProps
  extends HTMLAttributes<HTMLSpanElement> {
  /** Base text to type (uppercase). */
  text?: string;
  /** Number of dots to append after the base text. */
  dots?: number;
  /** Delay between each character (ms). */
  delay?: number;
  /** Hold time after the text clears before restarting (ms). */
  holdMs?: number;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Compute the displayed text for a given tick index.
 * Sequence: L → LO → ... → LOADING → LOADING. → LOADING.. → LOADING...
 * Then empty (clear), then hold, then repeat.
 */
export function typewriterText(
  tick: number,
  text: string,
  dots: number,
): string {
  const totalLen = text.length + dots;
  const cycle = tick % (totalLen + 1); // +1 for the clear frame
  if (cycle <= text.length) {
    return text.slice(0, cycle);
  }
  // Dot phase: cycle is text.length+1 .. text.length+dots
  return text + '.'.repeat(cycle - text.length);
}

export function TypewriterLoading({
  text = 'LOADING',
  dots = 3,
  delay = 120,
  holdMs = 1000,
  className,
  ...rest
}: TypewriterLoadingProps) {
  const [tick, setTick] = useState(0);
  const tickRef = useRef(0);
  const totalLen = text.length + dots;

  useEffect(() => {
    if (prefersReducedMotion()) {
      // Static display: show full text without animation.
      setTick(totalLen);
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const step = () => {
      if (!active) return;
      tickRef.current += 1;
      const cycle = tickRef.current % (totalLen + 1);
      setTick(tickRef.current);
      if (cycle === 0) {
        // Clear frame → hold before restarting
        timer = setTimeout(() => {
          if (active) timer = setTimeout(step, delay);
        }, holdMs);
      } else {
        timer = setTimeout(step, delay);
      }
    };

    timer = setTimeout(step, delay);
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [delay, holdMs, totalLen]);

  const displayed = typewriterText(tick, text, dots);

  return (
    <span
      className={`entei-typewriter ${className ?? ''}`}
      {...rest}
    >
      {displayed}
      <span className="entei-typewriter-caret" aria-hidden="true" />
    </span>
  );
}
