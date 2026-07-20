/**
 * Locale Events — shared constants and types for locale-change CustomEvent.
 * ---------------------------------------------------------------------------
 * Side-effect-free module: safe to import from both vanilla scripts and
 * React client bundles without triggering DOM initialization.
 *
 * locale-switcher.ts dispatches events using these constants.
 * React components (PlayerApp) listen using these constants.
 * --------------------------------------------------------------------------- */

import type { Dictionary, Locale } from '@i18n/types';

/** CustomEvent detail shape dispatched after locale application. */
export interface LocaleChangeDetail {
  locale: Locale;
  dictionary: Dictionary;
}

/** Event name for the locale change CustomEvent. */
export const LOCALE_CHANGE_EVENT = 'entei:locale-change';
