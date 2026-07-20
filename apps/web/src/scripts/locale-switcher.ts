import { getDictionary, getMetadata, isLocale } from '@i18n/index';
import { getSavedLocale, writePreference } from '@i18n/preferences';
import type { Locale } from '@i18n/types';

/**
 * Entei Locale Switcher
 * -----------------------------------------------------------------------------
 * Runs as a module script at end of <body>. Handles:
 * 1. Applying the saved locale (set by the inline <head> script as
 *    `data-entei-locale` on <html>) to all `[data-i18n]` elements.
 * 2. Updating `<html lang>`, `<title>`, and `<meta name="description">`.
 * 3. Syncing the Language Selector `<select>` to the current locale.
 * 4. Listening for user-initiated locale changes and persisting them.
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
  // No inline script ran (JS disabled in head but module loaded — unlikely)
  // or preference was absent / invalid. Default is Indonesian.
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

  // Update <html lang> — PHASE0.md 5.130, 8.206
  ROOT.lang = locale;

  // Update document title and description — PHASE0.md 8.206
  document.title = metadata.title;
  const descriptionMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="description"]',
  );
  if (descriptionMeta) {
    descriptionMeta.content = metadata.description;
  }

  // Update all `[data-i18n]` elements with their translated text.
  // Text content only — no innerHTML (PHASE0.md 16.407).
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

  // Sync the Language Selector <select> to the current locale.
  const select = document.querySelector<HTMLSelectElement>(
    '[data-entei-language-select]',
  );
  if (select) {
    select.value = locale;
  }
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

  // Wire up the Language Selector.
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
// After revealPage() deletes dataset.enteiLocale, getCurrentLocale() would
// fall back to 'id'. We must read the saved locale from localStorage instead
// so a persisted pageshow does not revert JA/EN to Indonesian.
window.addEventListener('pageshow', (event: PageTransitionEvent) => {
  if (event.persisted) {
    const locale = getSavedLocale();
    applyLocale(locale);
  }
});
