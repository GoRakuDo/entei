/**
 * anki-connection-preferences — AnkiConnect connection settings.
 * ---------------------------------------------------------------------------
 * Persists the "Anki Connection" card on the /settings/ Anki page:
 * server URL, API key, idle-download timeout, and force-sync-on-add.
 *
 * Stored in localStorage under `entei.player.anki-connection.v1`. On desktop
 * that key is registered in settings-store SETTINGS_STORAGE_KEYS, so every
 * write is mirrored to the embedded SQLite `kv_store` and restored on startup
 * (hybrid persistence, no manual Save button).
 *
 * Privacy: the API key lives only in localStorage (mirrored to the local
 * desktop DB). It is never logged, never put into URLs or error surfaces,
 * matching the existing jimaku / nadeshiko key handling.
 * --------------------------------------------------------------------------- */

export interface AnkiConnectionPreferences {
  /** AnkiConnect endpoint. */
  server: string;
  /** AnkiConnect API key ('' when the host needs no key). */
  apiKey: string;
  /** Force a full Anki sync when a card is added. */
  forceSync: boolean;
  /** Run a duplicate check before adding a new card (Card Management). */
  checkForDuplicates: boolean;
  /** Check for duplicates across all note models, not just the target model. */
  checkAllModels: boolean;
  /** Scope the duplicate search: whole collection, single deck, or deck root. */
  duplicateScope: DuplicateScope;
  /** What to do when a duplicate is detected. 'allow' matches Yomitan's 'new'. */
  duplicateBehavior: DuplicateBehavior;
  /** Suspend a freshly-added new card. */
  suspendNewCards: boolean;
  /** Which window opens from the View added note button. */
  openNoteViewer: OpenNoteViewer;
  /** Handlebars card templates (stored only for now; see DEFAULT_CARD_TEMPLATES). */
  cardTemplates: string;
  /** Screenshot image format captured for created cards. */
  screenshotFormat: ScreenshotFormat;
  /** Anki card deck/format profiles (deck + model + field markers per profile). */
  cardFormats: AnkiCardFormat[];
}

/** Scope the duplicate search is run against. */
export type DuplicateScope = 'collection' | 'deck' | 'deck-root';

/** Behavior when a duplicate is detected ('allow' ≡ Yomitan's 'new'). */
export type DuplicateBehavior = 'allow' | 'prevent' | 'overwrite';

/** Window opened from the View added note button. */
export type OpenNoteViewer = 'note-editor' | 'browser';

/** Image format of the screenshot attached to a created card. */
export type ScreenshotFormat = 'png' | 'jpeg';

/** Icon shown for a card-format profile button (Yomitan-compatible set). */
export type AnkiCardFormatIcon =
  | 'big-circle'
  | 'small-circle'
  | 'big-square'
  | 'big-diamond';

/** A single Anki card format profile: which deck/model/fields a card uses. */
export interface AnkiCardFormat {
  /** Unique profile id (seeded ids 'default' / 'denchou', otherwise randomUUID). */
  id: string;
  /** Human-readable profile name shown in the accordion header. */
  name: string;
  /** Card kind ('kanji' reserved for kanji note types; term is the default). */
  type: 'term' | 'kanji';
  /** Button icon for this profile. */
  icon: AnkiCardFormatIcon;
  /** Target Anki deck name (free text; not required to exist yet). */
  deck: string;
  /** Target Anki note type (model) name. */
  model: string;
  /** fieldName -> marker/value (e.g. { Front: '{expression}' }). */
  fields: Record<string, string>;
}

import { DEFAULT_CARD_TEMPLATES } from './default-card-templates';

export { DEFAULT_CARD_TEMPLATES };

export const ANKI_CONNECTION_PREFS_KEY = 'entei.player.anki-connection.v1';

/** AnkiConnect default endpoint (same default AnkiConnect ships with). */
export const DEFAULT_ANKI_SERVER = 'http://127.0.0.1:8765';

const SCREENSHOT_FORMATS: readonly ScreenshotFormat[] = ['png', 'jpeg'];
const CARD_FORMAT_ICONS: readonly AnkiCardFormatIcon[] = [
  'big-circle',
  'small-circle',
  'big-square',
  'big-diamond',
];

/** Seed the two default card-format profiles (Default + DenChou). */
export const DEFAULT_CARD_FORMATS: AnkiCardFormat[] = [
  {
    id: 'default',
    name: 'Default',
    type: 'term',
    icon: 'big-circle',
    deck: 'Default',
    model: 'Basic',
    fields: { Front: '{expression}', Back: '{glossary}' },
  },
  {
    id: 'denchou',
    name: 'DenChou',
    type: 'term',
    icon: 'small-circle',
    deck: 'Default',
    model: 'DenChou',
    fields: {
      word: '{expression}',
      reading: '{reading}',
      sentence: '{sentence}',
      sentenceFurigana: '{sentence-furigana}',
    },
  },
];

export const DEFAULT_ANKI_CONNECTION_PREFERENCES: AnkiConnectionPreferences = {
  server: DEFAULT_ANKI_SERVER,
  apiKey: '',
  forceSync: false,
  checkForDuplicates: true,
  checkAllModels: false,
  duplicateScope: 'collection',
  duplicateBehavior: 'allow',
  suspendNewCards: false,
  openNoteViewer: 'note-editor',
  cardTemplates: DEFAULT_CARD_TEMPLATES,
  screenshotFormat: 'png',
  cardFormats: DEFAULT_CARD_FORMATS,
};

const DUPLICATE_SCOPES: readonly DuplicateScope[] = [
  'collection',
  'deck',
  'deck-root',
];
const DUPLICATE_BEHAVIORS: readonly DuplicateBehavior[] = [
  'allow',
  'prevent',
  'overwrite',
];
const OPEN_NOTE_VIEWERS: readonly OpenNoteViewer[] = ['note-editor', 'browser'];

/**
 * Narrow an unknown enum value, falling back to a default when it is not one
 * of the allowed members. Keeps a hand-edited / partially-corrupted row from
 * poisoning unrelated fields (per-field fallback, not whole-row fallback).
 */
function enumOr<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Defensive validation: a hand-edited / corrupted row falls back to defaults.
 *  screenshotFormat / cardFormats are intentionally NOT required here so a row
 *  persisted before they existed still validates and gains them via defaults. */
function isAnkiConnectionPreferences(
  value: unknown,
): value is AnkiConnectionPreferences {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.server === 'string' &&
    typeof v.apiKey === 'string' &&
    typeof v.forceSync === 'boolean' &&
    typeof v.checkForDuplicates === 'boolean' &&
    typeof v.checkAllModels === 'boolean' &&
    DUPLICATE_SCOPES.includes(v.duplicateScope as DuplicateScope) &&
    DUPLICATE_BEHAVIORS.includes(v.duplicateBehavior as DuplicateBehavior) &&
    typeof v.suspendNewCards === 'boolean' &&
    OPEN_NOTE_VIEWERS.includes(v.openNoteViewer as OpenNoteViewer) &&
    typeof v.cardTemplates === 'string'
  );
}

/**
 * Validate a parsed cardFormats array. Each entry must carry an id/name and a
 * fields object; icon/type fall back to their defaults per-entry so one bad
 * profile cannot poison the whole list (matches enumOr's per-field policy).
 */
function sanitizeCardFormats(value: unknown): AnkiCardFormat[] {
  if (!Array.isArray(value)) return DEFAULT_CARD_FORMATS.map((f) => ({ ...f }));
  const formats: AnkiCardFormat[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.name !== 'string') continue;
    const fields: Record<string, string> = {};
    if (typeof e.fields === 'object' && e.fields !== null) {
      for (const [key, val] of Object.entries(e.fields as Record<string, unknown>)) {
        if (typeof val === 'string') fields[key] = val;
      }
    }
    formats.push({
      id: e.id,
      name: e.name,
      type: e.type === 'kanji' ? 'kanji' : 'term',
      icon: enumOr(e.icon, CARD_FORMAT_ICONS, 'big-circle'),
      deck: typeof e.deck === 'string' ? e.deck : '',
      model: typeof e.model === 'string' ? e.model : '',
      fields,
    });
  }
  // Keep at least one profile — an empty list would leave the card un-usable.
  return formats.length > 0
    ? formats
    : DEFAULT_CARD_FORMATS.map((f) => ({ ...f, fields: { ...f.fields } }));
}

/** SSR-safe: no window/localStorage during static prerender. */
function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/** Read the persisted preferences; falls back to defaults on any failure. */
export function readAnkiConnectionPreferences(): AnkiConnectionPreferences {
  if (!hasStorage()) return { ...DEFAULT_ANKI_CONNECTION_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(ANKI_CONNECTION_PREFS_KEY);
    if (raw === null) return { ...DEFAULT_ANKI_CONNECTION_PREFERENCES };
    const parsed = JSON.parse(raw) as unknown;
    if (!isAnkiConnectionPreferences(parsed)) {
      return { ...DEFAULT_ANKI_CONNECTION_PREFERENCES };
    }
    // Enum fields are already shape-checked by the type guard, but re-run
    // enumOr so an out-of-union value always resolves to its default.
    return {
      ...parsed,
      duplicateScope: enumOr(
        parsed.duplicateScope,
        DUPLICATE_SCOPES,
        DEFAULT_ANKI_CONNECTION_PREFERENCES.duplicateScope,
      ),
      duplicateBehavior: enumOr(
        parsed.duplicateBehavior,
        DUPLICATE_BEHAVIORS,
        DEFAULT_ANKI_CONNECTION_PREFERENCES.duplicateBehavior,
      ),
      openNoteViewer: enumOr(
        parsed.openNoteViewer,
        OPEN_NOTE_VIEWERS,
        DEFAULT_ANKI_CONNECTION_PREFERENCES.openNoteViewer,
      ),
      screenshotFormat: enumOr(
        parsed.screenshotFormat,
        SCREENSHOT_FORMATS,
        DEFAULT_ANKI_CONNECTION_PREFERENCES.screenshotFormat,
      ),
      cardFormats:
        parsed.cardFormats === undefined
          ? DEFAULT_CARD_FORMATS.map((f) => ({ ...f, fields: { ...f.fields } }))
          : sanitizeCardFormats(parsed.cardFormats),
    };
  } catch {
    return { ...DEFAULT_ANKI_CONNECTION_PREFERENCES }; // storage unavailable or corrupted
  }
}

/** Persist the preferences. Failures are silently ignored (preference only). */
export function writeAnkiConnectionPreferences(
  prefs: AnkiConnectionPreferences,
): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      ANKI_CONNECTION_PREFS_KEY,
      JSON.stringify(prefs),
    );
  } catch {
    // storage unavailable — ignore (preference only)
  }
}

/**
 * Merge a partial change into the persisted preferences and return the next
 * full snapshot. The Anki Connection card writes through this so every
 * keystroke / toggle is saved the moment it happens.
 */
export function updateAnkiConnectionPreferences(
  change: Partial<AnkiConnectionPreferences>,
): AnkiConnectionPreferences {
  const next = { ...readAnkiConnectionPreferences(), ...change };
  writeAnkiConnectionPreferences(next);
  return next;
}
