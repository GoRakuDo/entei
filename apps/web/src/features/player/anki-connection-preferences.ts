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
}

/** Scope the duplicate search is run against. */
export type DuplicateScope = 'collection' | 'deck' | 'deck-root';

/** Behavior when a duplicate is detected ('allow' ≡ Yomitan's 'new'). */
export type DuplicateBehavior = 'allow' | 'prevent' | 'overwrite';

/** Window opened from the View added note button. */
export type OpenNoteViewer = 'note-editor' | 'browser';

/**
 * Default Yomitan Handlebars card template. Stored as a preference for
 * advanced users (matches the Chrome-extension default). Rendering is NOT
 * wired to the player mining pipeline yet — this is storage-only for now.
 */
export const DEFAULT_CARD_TEMPLATES = `{{#inline "glossary-single"}}
    {{~#unless brief~}}
        {{~#scope~}}
            {{~set "any" false~}}
            {{~#each definitionTags~}}{{#if (op "||" (op "!" @root.compactTags) (op "!" .redundant))~}}
                {{~#if (get "any")}}, {{else}}<i>(</i>{{/if~}}
                {{~name~}}
                {{~set "any" true~}}
            {{~/if~}}{{~/each~}}
            {{~#if (get "any")}}<i>)</i><br>{{/if~}}
            {{~#if definitions~}}{{#each definitions}}{{#if (get "any")}}<br>{{/if~}}
                {{~definition~}}
                {{~set "any" true~}}
            {{~/each~}}{{/if~}}
        {{~/scope~}}
    {{~/unless~}}
{{~/inline~}}`;

export const ANKI_CONNECTION_PREFS_KEY = 'entei.player.anki-connection.v1';

/** AnkiConnect default endpoint (same default AnkiConnect ships with). */
export const DEFAULT_ANKI_SERVER = 'http://127.0.0.1:8765';

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

/** Defensive validation: a hand-edited / corrupted row falls back to defaults. */
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
