/**
 * settings-store — hybrid settings persistence (localStorage + embedded SQLite).
 * ---------------------------------------------------------------------------
 * The settings page (`/settings/`) saves every change the moment it happens
 * (no manual Save button). Persistence is hybrid:
 *
 * - Standalone browser: localStorage is the source of truth (synchronous),
 *   exactly like every existing settings feature. Nothing changes.
 * - Desktop (Tauri): localStorage stays the synchronous read/write cache every
 *   feature already uses, AND every write to a registered settings key is
 *   mirrored asynchronously to the embedded SQLite `kv_store` via `dbKvSet`
 *   (`plugins/tauri-plugin-database`). On startup `initSettingsSync()` seeds
 *   localStorage from SQLite for any registered key the cache does not have
 *   yet, so the desktop DB is the durable source of truth across reinstalls /
 *   cleared storage.
 *
 * WHY interception (not per-feature rewrites): settings values are written by
 * several independent, already-persisted feature modules (`preferences`,
 * `jimaku-preferences`, `nadeshiko/api-key`, `modules-store`,
 * `anki-miner-preferences`, locale preference). Each writes its own JSON under
 * a stable localStorage key. Rather than touch every call site — and risk
 * missing one — we observe writes to the registered keys at the localStorage
 * boundary and mirror them. Reads stay synchronous (localStorage) so every
 * existing reader keeps working unchanged.
 *
 * Safety: mirroring is fire-and-forget and never throws to the caller. A
 * failed mirror (runtime unavailable, DB busy) leaves localStorage
 * authoritative; the failure reason is recorded for diagnostics only and never
 * contains a setting value.
 * ---------------------------------------------------------------------------
 */

import { isTauri, dbKvGet, dbKvSet } from '@/features/player/tauri-bridge';

/** `kv_store` key prefix so settings never collide with other DB rows. */
const DB_KEY_PREFIX = 'settings:';

/**
 * Every localStorage key the settings page owns. Writes to these are mirrored
 * to the embedded DB on desktop; `initSettingsSync` hydrates them from the DB.
 */
export const SETTINGS_STORAGE_KEYS: readonly string[] = [
  'entei.player.prefs.v1', // player + subtitle appearance (preferences.ts)
  'entei.jimaku.v1', // jimaku.cc API key + auto-load (jimaku-preferences.ts)
  'entei.nadeshiko.api-key.v1', // Nadeshiko API key (nadeshiko/api-key.ts)
  'entei.modules.v1', // module enable switches (modules-store.ts)
  'entei.player.anki-miner.v1', // AnkiConnect deck/note/field mapping
  'entei.preferences.v1', // UI language (i18n/preferences.ts PREFERENCES_KEY)
] as const;

function dbKey(localStorageKey: string): string {
  return `${DB_KEY_PREFIX}${localStorageKey}`;
}

function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/** Last mirror failure reason (never contains a setting value). */
let lastSyncError: string | null = null;

/** Diagnostics: the last DB-mirror failure reason, or null. */
export function getLastSettingsSyncError(): string | null {
  return lastSyncError;
}

function isRegisteredKey(key: string | null): key is string {
  return key !== null && (SETTINGS_STORAGE_KEYS as readonly string[]).includes(key);
}

/** Mirror one localStorage write to the embedded DB (fire-and-forget). */
function mirrorToDb(key: string): void {
  let value: string | null = null;
  try {
    value = window.localStorage.getItem(key);
  } catch {
    return;
  }
  if (value === null) return;
  void dbKvSet(dbKey(key), value).catch((error: unknown) => {
    lastSyncError = error instanceof Error ? error.message : String(error);
  });
}

let initialized = false;

/**
 * Activate hybrid persistence. Idempotent.
 *
 * - Installs a localStorage write interceptor that mirrors every registered
 *   settings key to the embedded DB (Tauri only).
 * - Seeds localStorage from the DB for registered keys missing from the cache
 *   (a value already in the cache wins — we never clobber a value set this
 *   session).
 *
 * Returns a promise that resolves once the DB→cache seed has settled, so the
 * settings page can await it before its first synchronous read.
 */
export function initSettingsSync(): Promise<void> {
  if (!hasLocalStorage()) return Promise.resolve();
  if (!isTauri()) return Promise.resolve(); // browser: localStorage only

  if (!initialized) {
    initialized = true;
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    const originalRemoveItem = window.localStorage.removeItem.bind(window.localStorage);
    window.localStorage.setItem = (key: string, value: string) => {
      originalSetItem(key, value);
      if (isRegisteredKey(key)) mirrorToDb(key);
    };
    window.localStorage.removeItem = (key: string) => {
      originalRemoveItem(key);
      if (isRegisteredKey(key)) {
        // Best-effort clear: an empty value reads as "unset" on next hydrate.
        void dbKvSet(dbKey(key), '').catch(() => {});
      }
    };
  }

  const keys = [...SETTINGS_STORAGE_KEYS];
  return (async () => {
    for (const key of keys) {
      try {
        if (window.localStorage.getItem(key) !== null) continue;
        const value = await dbKvGet(dbKey(key));
        if (value !== null && value !== undefined && value !== '') {
          window.localStorage.setItem(key, value);
        }
      } catch {
        // DB unavailable — leave defaults; per-key, never fatal.
      }
    }
  })();
}
