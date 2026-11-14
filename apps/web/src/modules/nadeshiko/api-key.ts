/**
 * nadeshiko api-key — localStorage helpers (BYOK).
 * ---------------------------------------------------------------------------
 * Design: docs/NADESHIKO_INTEGRATION.md §3.4.
 * - Key stored only on the user's device.
 * - Read / write / clear helpers with validation (non-empty trimmed string).
 * - Defensive against SSR (returns null when window/localStorage missing).
 * ---------------------------------------------------------------------------
 */

const NADESHIKO_API_KEY_STORAGE_KEY = 'entei.nadeshiko.api-key.v1';

function isBrowserStorage(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.localStorage !== 'undefined'
    );
  } catch {
    return false;
  }
}

function isValidApiKey(value: string): boolean {
  return value.trim().length > 0;
}

/** Read the saved Nadeshiko API key, or null when missing/invalid. */
export function readNadeshikoApiKey(): string | null {
  if (!isBrowserStorage()) return null;
  try {
    const raw = window.localStorage.getItem(NADESHIKO_API_KEY_STORAGE_KEY);
    if (raw === null) return null;
    if (!isValidApiKey(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Save the Nadeshiko API key. Returns true on success, false on storage
 * failure or when the key fails validation. The module never logs the key.
 */
export function writeNadeshikoApiKey(key: string): boolean {
  if (!isValidApiKey(key)) return false;
  if (!isBrowserStorage()) return false;
  try {
    window.localStorage.setItem(NADESHIKO_API_KEY_STORAGE_KEY, key.trim());
    return true;
  } catch {
    return false;
  }
}

/** Clear the saved Nadeshiko API key. */
export function clearNadeshikoApiKey(): void {
  if (!isBrowserStorage()) return;
  try {
    window.localStorage.removeItem(NADESHIKO_API_KEY_STORAGE_KEY);
  } catch {
    // Storage failure is non-fatal
  }
}

/** Storage key — exposed for tests + bridge events. */
export const NADESHIKO_API_KEY_STORAGE_KEY_NAME = NADESHIKO_API_KEY_STORAGE_KEY;
