import type { Dictionary, DocumentMetadata, Locale } from './types';
import { id } from './locales/id';
import { ja } from './locales/ja';
import { en } from './locales/en';

// Re-export constants and types so consumers can import from a single entry point.
export {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  PREFERENCES_KEY,
  PREFERENCES_SCHEMA_VERSION,
} from './types';
export type {
  Locale,
  LocalePreference,
  Dictionary,
  DocumentMetadata,
} from './types';

/** All locale dictionaries. Keys must be identical across locales. */
export const dictionaries: Record<Locale, Dictionary> = { id, ja, en };

/** Per-locale document `<title>` and `<meta description>`. */
export const documentMetadata: Record<Locale, DocumentMetadata> = {
  id: {
    title: 'Entei — Platform Immerison Terpadu',
    description:
      'Entei adalah platform immerison terpadu untuk belajar bahasa Jepang dari video, audio, dan buku di perangkatmu sendiri. Tanpa akun, media tetap di perangkatmu.',
  },
  ja: {
    title: 'Entei — 日本語学習の拠点',
    description:
      'Enteiは、手元の映像・音声・本から日本語を学ぶための拠点です。アカウント不要で、メディアは端末内に残ります。',
  },
  en: {
    title: 'Entei — Japanese Learning Base',
    description:
      'Entei is a hub for learning Japanese from the videos, audio, and books on your own device. No account. Your media stays on your device.',
  },
};

/**
 * Type guard: returns `true` only when `value` is exactly `'id'`, `'ja'`, or `'en'`.
 * Used to validate preference locale before applying it to the document.
 */
export function isLocale(value: unknown): value is Locale {
  return value === 'id' || value === 'ja' || value === 'en';
}

/** Get the dictionary for a locale. Falls back to Indonesian if unknown. */
export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? dictionaries.id;
}

/** Get document metadata for a locale. Falls back to Indonesian if unknown. */
export function getMetadata(locale: Locale): DocumentMetadata {
  return documentMetadata[locale] ?? documentMetadata.id;
}

/** Re-export locale dictionaries for direct import if needed. */
export { id, ja, en };
