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
      {/* Official Lucide 1.36.0 playing-cards-fan path data */}
      <path d="M12.65 7.65a2 2 0 012.629-1.046l5.51 2.374a2 2 0 011.046 2.628l-3.957 9.184a2 2 0 01-2.628 1.046l-5.51-2.374a2 2 0 01-1.046-2.628z" />
      <path d="M18 7.777V4a2 2 0 00-2-2h-6a2 2 0 00-2 2v10a2 2 0 001.137 1.805" />
      <path d="m8 4.389-4.364.809a2 2 0 00-1.602 2.33l1.822 9.833a2 2 0 002.331 1.602l2.542-.47" />
    </svg>
  );
}
