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
}

export const ANKI_CONNECTION_PREFS_KEY = 'entei.player.anki-connection.v1';

/** AnkiConnect default endpoint (same default AnkiConnect ships with). */
export const DEFAULT_ANKI_SERVER = 'http://127.0.0.1:8765';

export const DEFAULT_ANKI_CONNECTION_PREFERENCES: AnkiConnectionPreferences = {
  server: DEFAULT_ANKI_SERVER,
  apiKey: '',
  forceSync: false,
};

/** Defensive validation: a hand-edited / corrupted row falls back to defaults. */
function isAnkiConnectionPreferences(value: unknown): value is AnkiConnectionPreferences {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.server === 'string' &&
    typeof v.apiKey === 'string' &&
    typeof v.forceSync === 'boolean'
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
    return parsed;
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
