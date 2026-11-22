/**
 * PlayingCardsFan — a hand of three playing cards spread into a fan.
 * ---------------------------------------------------------------------------
 * Custom Lucide-style icon (the Lucide set has no card-fan glyph). Follows the
 * Lucide drawing conventions exactly so it drops into any `LucideIcon` slot:
 * 24×24 viewBox, `stroke="currentColor"`, `fill="none"`, `stroke-width` 2,
 * round caps/joins, sized via the `size` prop (default 24 → 1rem through CSS).
 *
 * Decorative by default (`aria-hidden`) — the parent nav button / heading
 * carries the accessible name.
 * ---------------------------------------------------------------------------
 */

import type { LucideProps } from 'lucide-react';

export function PlayingCardsFan({
  size = 24,
  strokeWidth = 2,
  ...props
}: LucideProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* Left card — fanned counter-clockwise */}
      <rect
        x={3.5}
        y={6}
        width={7.5}
        height={11}
        rx={1.2}
        transform="rotate(-20 7.25 16)"
      />
      {/* Middle card — fanned clockwise */}
      <rect
        x={13}
        y={6}
        width={7.5}
        height={11}
        rx={1.2}
        transform="rotate(20 16.75 16)"
      />
      {/* Center card — front of the fan */}
      <rect x={8.25} y={5} width={7.5} height={12} rx={1.2} />
    </svg>
  );
}
