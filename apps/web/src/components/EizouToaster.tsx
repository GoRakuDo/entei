/**
 * EizouToaster — Sonner Toaster host for EizouDen / player notifications.
 * ---------------------------------------------------------------------------
 * Renders the sonner Toaster at the top-center once per page. Placed in
 * BaseLayout and PlayerLayout so quality notifications can appear anywhere.
 * ---------------------------------------------------------------------------
 */

'use client';

import { Toaster } from 'sonner';

export function EizouToaster() {
  return <Toaster position="top-center" richColors />;
}