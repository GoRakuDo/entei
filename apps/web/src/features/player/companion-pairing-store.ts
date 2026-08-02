/**
 * Companion pairing preference — persistent browser-side credential.
 * ---------------------------------------------------------------------------
 * A schema-versioned, validated, exception-safe localStorage preference
 * module for the EizouDendenshi pairing. It persists ONLY the opaque
 * capability token (in a versioned envelope) after a successful pair, so
 * the pairing survives browser reloads and companion restarts until the
 * user explicitly deletes it.
 *
 * Safety contract:
 * - The persisted envelope is `{ v: 1, token }` under the fixed key
 *   ENTEI_EIZOU_PAIRING_KEY. A future schema bump reads as "unpaired"
 *   (fail closed) rather than guessing.
 * - The token must match the companion capability-token shape (64
 *   lowercase hex). Any malformed value, unknown schema, unreadable
 *   storage, or quota/security error behaves as UNPAIRED — the caller
 *   shows the pairing UI, never a false "connected".
 * - NEVER store the pairing code, a source URL, magnet, media, or cookies
 *   here. The token is the only persisted pairing data.
 * - Every access is wrapped so a throwing localStorage (private mode,
 *   disabled storage, quota) can never break the player.
 * ---------------------------------------------------------------------------
 */

/** Versioned localStorage key for the opaque companion capability token. */
export const ENTEI_EIZOU_PAIRING_KEY = 'entei.eizou.pairing';

/** Schema version of the persisted envelope. */
export const PAIRING_SCHEMA_VERSION = 1;

/** Capability-token shape: 32 random bytes as 64 lowercase hex chars. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

interface StoredPairingEnvelope {
  v: number;
  token: string;
}

/** True when token matches the companion capability-token shape. */
export function isValidPairingToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/**
 * Reads and validates the persisted pairing token.
 * Returns the token only when the envelope exists, is schema-version 1,
 * and contains a shape-valid token; returns null for absent storage,
 * malformed JSON, unknown schema, invalid token shape, or any
 * localStorage exception (all behave unpaired, safely).
 */
export function readStoredPairingToken(): string | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(ENTEI_EIZOU_PAIRING_KEY);
  } catch {
    return null; // storage unavailable → unpaired
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed → unpaired
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const env = parsed as Partial<StoredPairingEnvelope>;
  if (env.v !== PAIRING_SCHEMA_VERSION) return null; // unknown schema → unpaired
  if (typeof env.token !== 'string' || !isValidPairingToken(env.token)) {
    return null; // invalid token → unpaired
  }
  return env.token;
}

/**
 * Persists the opaque capability token after a successful pair. Only the
 * token and schema version are written — never the code or any source
 * detail. Storage failures (quota, disabled storage) are swallowed: the
 * pairing still works for this page session.
 */
export function writeStoredPairingToken(token: string): void {
  if (!isValidPairingToken(token)) return; // never persist garbage
  const envelope: StoredPairingEnvelope = {
    v: PAIRING_SCHEMA_VERSION,
    token,
  };
  try {
    window.localStorage.setItem(
      ENTEI_EIZOU_PAIRING_KEY,
      JSON.stringify(envelope),
    );
  } catch {
    // Non-fatal: the session keeps the token in memory.
  }
}

/**
 * Removes the persisted pairing token (used on explicit reset and when
 * the companion rejects the stored token). Exception-safe; absent entries
 * are fine.
 */
export function clearStoredPairingToken(): void {
  try {
    window.localStorage.removeItem(ENTEI_EIZOU_PAIRING_KEY);
  } catch {
    // Non-fatal: memory state is cleared by the caller regardless.
  }
}
