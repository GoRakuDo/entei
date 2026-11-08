/**
 * Settings bridge — typed browser-only events between the global nav settings
 * island and the PlayerApp island.
 * ---------------------------------------------------------------------------
 * The two React islands do not share a React tree. CustomEvent is the narrow
 * page-memory boundary between them:
 * - subtitle changes carry only a validated partial appearance patch;
 * - Anki credentials carry a page-lifetime session or null on disconnect.
 *
 * Event data is never persisted or logged. The module is safe to import during
 * SSR because browser globals are only touched inside the helpers.
 * ---------------------------------------------------------------------------
 */

export interface SubtitleSettings {
  fontSize: number;
  textColor: string;
  backgroundColor: string;
  backgroundPadding: number;
  verticalPosition: number;
}

export type SubtitleSettingsPatch = Partial<SubtitleSettings>;

export interface AnkiSessionCredentials {
  endpoint: string;
  apiKey: string;
}

/** CustomEvent name for live subtitle appearance changes. */
export const SUBTITLE_SETTINGS_CHANGE_EVENT =
  'entei:player-subtitle-settings-change';

/** CustomEvent name for the page-lifetime Anki session handoff. */
export const ANKI_SESSION_CREDENTIALS_EVENT =
  'entei:player-anki-session-credentials';

const SUBTITLE_KEYS: readonly (keyof SubtitleSettings)[] = [
  'fontSize',
  'textColor',
  'backgroundColor',
  'backgroundPadding',
  'verticalPosition',
];

function isBrowser(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function' &&
    typeof CustomEvent === 'function'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

/**
 * Parse and sanitize a subtitle patch received from an untrusted event.
 * Invalid keys are dropped independently. An empty or all-invalid patch is
 * rejected with null.
 */
export function parseSubtitleSettings(
  value: unknown,
): SubtitleSettingsPatch | null {
  if (!isRecord(value)) return null;

  const patch: SubtitleSettingsPatch = {};

  for (const key of SUBTITLE_KEYS) {
    if (!(key in value)) continue;
    const candidate = value[key];

    if (key === 'fontSize' && isFiniteInRange(candidate, 16, 48)) {
      patch.fontSize = candidate;
    } else if (
      key === 'backgroundPadding' &&
      isFiniteInRange(candidate, 0, 48)
    ) {
      patch.backgroundPadding = candidate;
    } else if (
      key === 'verticalPosition' &&
      isFiniteInRange(candidate, 0, 100)
    ) {
      patch.verticalPosition = candidate;
    } else if (
      (key === 'textColor' || key === 'backgroundColor') &&
      typeof candidate === 'string' &&
      candidate.trim().length > 0
    ) {
      patch[key] = candidate.trim();
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Parse credentials from an untrusted event payload. An empty API key is
 * allowed because AnkiConnect can establish a keyless session; the endpoint
 * must still be a non-empty string.
 */
export function parseAnkiSessionCredentials(
  value: unknown,
): AnkiSessionCredentials | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.endpoint !== 'string' ||
    value.endpoint.trim().length === 0
  ) {
    return null;
  }
  if (typeof value.apiKey !== 'string') return null;

  return {
    endpoint: value.endpoint.trim(),
    apiKey: value.apiKey,
  };
}

/** Dispatch a validated subtitle patch in the browser only. */
export function dispatchSubtitleSettingsChange(
  value: SubtitleSettingsPatch,
): void {
  if (!isBrowser()) return;
  const patch = parseSubtitleSettings(value);
  if (patch === null) return;

  window.dispatchEvent(
    new CustomEvent<SubtitleSettingsPatch>(SUBTITLE_SETTINGS_CHANGE_EVENT, {
      detail: patch,
    }),
  );
}

/** Dispatch a validated Anki session (or a null disconnect) in the browser. */
export function dispatchAnkiSessionCredentials(
  value: AnkiSessionCredentials | null,
): void {
  if (!isBrowser()) return;
  const credentials =
    value === null ? null : parseAnkiSessionCredentials(value);
  if (value !== null && credentials === null) return;

  window.dispatchEvent(
    new CustomEvent<AnkiSessionCredentials | null>(
      ANKI_SESSION_CREDENTIALS_EVENT,
      { detail: credentials },
    ),
  );
}

/** Listen for validated subtitle patches; returns an idempotent-style cleanup. */
export function listenForSubtitleSettingsChange(
  listener: (settings: SubtitleSettingsPatch) => void,
): () => void {
  if (!isBrowser()) return () => {};

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    const patch = parseSubtitleSettings(detail);
    if (patch !== null) listener(patch);
  };

  window.addEventListener(SUBTITLE_SETTINGS_CHANGE_EVENT, handler);
  return () =>
    window.removeEventListener(SUBTITLE_SETTINGS_CHANGE_EVENT, handler);
}

/** Listen for validated Anki sessions and explicit null disconnects. */
export function listenForAnkiSessionCredentials(
  listener: (credentials: AnkiSessionCredentials | null) => void,
): () => void {
  if (!isBrowser()) return () => {};

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (detail === null) {
      listener(null);
      return;
    }

    const credentials = parseAnkiSessionCredentials(detail);
    if (credentials !== null) listener(credentials);
  };

  window.addEventListener(ANKI_SESSION_CREDENTIALS_EVENT, handler);
  return () =>
    window.removeEventListener(ANKI_SESSION_CREDENTIALS_EVENT, handler);
}

/** CustomEvent name for live jimaku API-key presence changes. */
export const JIMAKU_KEY_CHANGED_EVENT = 'entei:player-jimaku-key-changed';

/**
 * CustomEvent name for a pairing handoff from the global nav settings island
 * to the PlayerApp island. The nav island owns its own pairing dialog (the
 * EizouDen settings tab is the only pairing entry point since the Player empty
 * state dropped EizouDendenshiSetup), but the Player's `useCompanionPairing`
 * state lives in the other island — this event carries the freshly issued
 * capability token across that boundary so Magnet / YouTube work immediately
 * instead of after a page reload.
 *
 * Payload: the opaque token string. It is validated by the receiver's pairing
 * hook (`isValidPairingToken`, fail closed) and never persisted or logged by
 * this module.
 */
export const COMPANION_PAIRED_EVENT = 'entei:player-companion-paired';

/** Dispatch a freshly issued pairing token to the Player island (browser only). */
export function dispatchCompanionPaired(token: string): void {
  if (!isBrowser()) return;
  if (typeof token !== 'string' || token.length === 0) return;
  window.dispatchEvent(
    new CustomEvent<string>(COMPANION_PAIRED_EVENT, { detail: token }),
  );
}

/** Listen for pairing handoffs; returns an idempotent-style cleanup. */
export function listenForCompanionPaired(
  listener: (token: string) => void,
): () => void {
  if (!isBrowser()) return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail === 'string' && detail.length > 0) listener(detail);
  };
  window.addEventListener(COMPANION_PAIRED_EVENT, handler);
  return () => window.removeEventListener(COMPANION_PAIRED_EVENT, handler);
}

/** Dispatch a jimaku API-key presence change (browser only). */
export function dispatchJimakuKeyChanged(hasKey: boolean): void {
  if (!isBrowser()) return;
  window.dispatchEvent(
    new CustomEvent<boolean>(JIMAKU_KEY_CHANGED_EVENT, { detail: hasKey }),
  );
}

/** Listen for jimaku API-key presence changes; returns a cleanup function. */
export function listenForJimakuKeyChanged(
  listener: (hasKey: boolean) => void,
): () => void {
  if (!isBrowser()) return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<boolean>).detail;
    if (typeof detail === 'boolean') listener(detail);
  };
  window.addEventListener(JIMAKU_KEY_CHANGED_EVENT, handler);
  return () => window.removeEventListener(JIMAKU_KEY_CHANGED_EVENT, handler);
}
