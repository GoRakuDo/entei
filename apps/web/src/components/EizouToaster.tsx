/**
 * EizouToaster — Sonner Toaster host for EizouDen / player notifications.
 * ---------------------------------------------------------------------------
 * Renders the sonner Toaster at the top-center once per page. Placed in
 * BaseLayout and PlayerLayout so quality notifications can appear anywhere.
 *
 * Theme: always dark and driven by the Entei tokens (see styles/global.css
 * "Sonner toasts" section) — surface background, card radius, system font,
 * OKLCH border. richColors keeps the per-type accent on top of the token
 * surface. The logic (fire conditions, copy, guards) lives entirely in the
 * callers (eizouden-toast.ts); this component only styles the host.
 * ---------------------------------------------------------------------------
 */

'use client';

import { Toaster } from 'sonner';

export function EizouToaster() {
  return <Toaster position="top-center" richColors theme="dark" />;
}