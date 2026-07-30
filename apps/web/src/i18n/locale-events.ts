/**
 * Locale Events — shared constants and types for locale-change CustomEvent.
 * ---------------------------------------------------------------------------
 * Side-effect-free module: safe to import from both vanilla scripts and
 * React client bundles without triggering DOM initialization.
 *
 * locale-switcher.ts dispatches LOCALE_CHANGE_EVENT after applying.
 * React components (LanguageCombobox, PlayerApp) listen for it.
 *
 * React components dispatch LOCALE_REQUEST_EVENT to request a locale switch.
 * locale-switcher.ts listens for it and owns applyLocale + writePreference +
 * LOCALE_CHANGE_EVENT dispatch. This avoids duplicating DOM mutation logic
 * in React islands.
 * --------------------------------------------------------------------------- */

import type { Dictionary, Locale } from '@i18n/types';

/** CustomEvent detail shape dispatched after locale application. */
export interface LocaleChangeDetail {
  locale: Locale;
  dictionary: Dictionary;
}

/** Event name for the locale change CustomEvent (post-application). */
export const LOCALE_CHANGE_EVENT = 'entei:locale-change';

/**
 * CustomEvent detail shape for requesting a locale switch.
 * Dispatched by React islands (LanguageCombobox); handled by locale-switcher.
 */
export interface LocaleRequestDetail {
  locale: Locale;
}

/**
 * Event name for requesting a locale switch.
 * locale-switcher.ts listens and calls switchLocale(locale).
 */
export const LOCALE_REQUEST_EVENT = 'entei:locale-request';
