/**
 * YouTube mono play mark — exact SVG path from theSVG.org.
 *
 * Source: https://thesvg.org/icon/youtube (variant=mono)
 * License: CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/)
 *   — "YouTube logo © 2026 YouTube. Distributed under CC0-1.0."
 *
 * The path is stored code-locally (no CDN) and rendered with
 * fill="currentColor" so the mark inherits the enclosing control's
 * foreground/hover color; no brand red is used. Decorative: the parent
 * button carries the localized aria-label/title.
 */
import type { SVGProps } from 'react';

export function YouTubeMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      role="img"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}
