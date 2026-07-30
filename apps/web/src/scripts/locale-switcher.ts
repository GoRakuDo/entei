import { getDictionary, getMetadata, isLocale } from '@i18n/index';
import { getSavedLocale, writePreference } from '@i18n/preferences';
import type { Locale } from '@i18n/types';
import {
  type LocaleChangeDetail,
  LOCALE_CHANGE_EVENT,
  type LocaleRequestDetail,
  LOCALE_REQUEST_EVENT,
} from '@i18n/locale-events';

/**
 * Entei Locale Switcher
 * -----------------------------------------------------------------------------
 * Runs as a module script at end of <body>. Handles:
 * 1. Applying the saved locale (set by the inline <head> script as
 *    `data-entei-locale` on <html>) to all `[data-i18n]` elements.
 * 2. Updating `<html lang>`, `<title>`, and `<meta name="description">`.
 * 3. Syncing the Language Selector `<select>` to the current locale.
 * 4. Listening for user-initiated locale changes and persisting them.
 * 5. Dispatching `entei:locale-change` CustomEvent after successful application
 *    so client-side components (React Player) can react to locale changes.
 *
 * PHASE0.md 8.192-225 — single URL `/`, no locale routing.
 * PHASE0.md 8.223 — FOUC must not be visually noticeable.
 * ---------------------------------------------------------------------------*/

const ROOT = document.documentElement;

/** Read the locale signalled by the inline <head> script, fallback to `id`. */
function getCurrentLocale(): Locale {
  const signalled = ROOT.dataset.enteiLocale;
  if (isLocale(signalled)) {
    return signalled;
  }
  return 'id';
}

/**
 * Apply a locale to the document: update text, lang, title, description,
 * and the Language Selector value. Does NOT persist — call `switchLocale`
 * for user-initiated changes.
 */
export function applyLocale(locale: Locale): void {
  const dictionary = getDictionary(locale);
  const metadata = getMetadata(locale);

  ROOT.lang = locale;

  document.title = metadata.title;
  const descriptionMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="description"]',
  );
  if (descriptionMeta) {
    descriptionMeta.content = metadata.description;
  }

  const translatable = document.querySelectorAll<HTMLElement>('[data-i18n]');
  translatable.forEach((element) => {
    const key = element.dataset.i18n;
    if (key === undefined) {
      return;
    }
    const text = resolveKey(dictionary, key);
    if (text !== null) {
      element.textContent = text;
    }
  });

  // Update aria-label on elements with data-i18n-aria-label (nav landmarks).
  const ariaLabelElements = document.querySelectorAll<HTMLElement>(
    '[data-i18n-aria-label]',
  );
  ariaLabelElements.forEach((element) => {
    const key = element.dataset.i18nAriaLabel;
    if (key === undefined) {
      return;
    }
    const text = resolveKey(dictionary, key);
    if (text !== null) {
      element.setAttribute('aria-label', text);
    }
  });

  const select = document.querySelector<HTMLSelectElement>(
    '[data-entei-language-select]',
  );
  if (select) {
    select.value = locale;
  }

  // Dispatch CustomEvent so React components can listen for locale changes.
  const detail: LocaleChangeDetail = { locale, dictionary };
  window.dispatchEvent(
    new CustomEvent<LocaleChangeDetail>(LOCALE_CHANGE_EVENT, { detail }),
  );
}

/**
 * Resolve a dot-notation key (e.g. `"hub.systemLabel"`) against the dictionary.
 * Returns `null` if the key path does not resolve to a string.
 */
export function resolveKey(dictionary: unknown, key: string): string | null {
  const parts = key.split('.');
  let current: unknown = dictionary;
  for (const part of parts) {
    if (
      typeof current === 'object' &&
      current !== null &&
      part in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return typeof current === 'string' ? current : null;
}

/**
 * User-initiated locale change: apply to the document and persist.
 * Persistence failure does not block the in-page switch (PHASE0.md 8.224).
 */
export function switchLocale(locale: Locale): void {
  applyLocale(locale);
  writePreference(locale);
}

/** Reveal the page after hydration (removes FOUC hiding class). */
function revealPage(): void {
  ROOT.classList.remove('entei-hydrating');
  delete ROOT.dataset.enteiLocale;
}

function init(): void {
  const initialLocale = getCurrentLocale();
  applyLocale(initialLocale);

  const select = document.querySelector<HTMLSelectElement>(
    '[data-entei-language-select]',
  );
  if (select) {
    select.addEventListener('change', (event) => {
      const target = event.target as HTMLSelectElement;
      if (isLocale(target.value)) {
        switchLocale(target.value);
      }
    });
  }

  // Listen for locale-request events from React islands (LanguageCombobox).
  // This is the single source of truth for locale switching — islands
  // dispatch a request, we own applyLocale + writePreference + event dispatch.
  window.addEventListener(LOCALE_REQUEST_EVENT, ((event: CustomEvent<LocaleRequestDetail>) => {
    if (event.detail?.locale && isLocale(event.detail.locale)) {
      switchLocale(event.detail.locale);
    }
  }) as EventListener);

  revealPage();
}

// Run on DOMContentLoaded (module scripts are deferred, so DOM is ready).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Re-apply locale on browser back/forward (single URL, no routing change,
// but the page may be served from bfcache).
window.addEventListener('pageshow', (event: PageTransitionEvent) => {
  if (event.persisted) {
    const locale = getSavedLocale();
    applyLocale(locale);
  }
});
