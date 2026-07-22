/**
 * AnkiConnect — Typed read-only client (Stage 1A)
 * ---------------------------------------------------------------------------
 * Separates read requests from future writes. Stage 1A must NOT include or
 * call addNote, canAddNotes, updateNoteFields, or media upload actions.
 *
 * Connection flow:
 *   version / reachability
 *   → requestPermission (where applicable)
 *   → API-key requirement detection
 *   → deckNames + modelNames
 *   → modelFieldNames (after user selects note type)
 *
 * All requests are typed. Errors are normalized to AnkiConnectError.
 * --------------------------------------------------------------------------- */

/** Well-known AnkiConnect actions used in Stage 1A. */
type ReadAction =
  | 'version'
  | 'requestPermission'
  | 'deckNames'
  | 'modelNames'
  | 'modelFieldNames';

/** Request shape sent to AnkiConnect. */
interface AnkiRequest {
  action: ReadAction;
  version: number;
  params?: Record<string, unknown>;
  key?: string;
}

/** Connection states surfaced to UI. */
export type AnkiConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'unavailable'
  | 'permission-denied'
  | 'api-key-required'
  | 'cors-error'
  | 'unknown-error';

/** Normalized error from AnkiConnect operations. */
export class AnkiConnectError extends Error {
  constructor(
    message: string,
    public readonly state: AnkiConnectionState,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AnkiConnectError';
  }
}

/** AnkiConnect version is a bare number (e.g., 6). */
export type AnkiVersionResult = number;

/** Permission result from AnkiConnect. */
export interface AnkiPermissionResult {
  permission: 'granted' | 'denied';
  requireApiKey?: boolean;
}

/** Validate that a parsed JSON value matches the AnkiResponse shape. */
function isAnkiResponseShape(
  value: unknown,
): value is { result: unknown; error: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'result' in value &&
    'error' in value
  );
}

/** Read-only AnkiConnect client. */
export class AnkiConnectClient {
  constructor(
    private readonly endpoint: string = 'http://127.0.0.1:8765',
    private readonly apiKey: string | undefined = undefined,
  ) {}

  /** Build a request payload. */
  private buildRequest(
    action: ReadAction,
    params?: Record<string, unknown>,
  ): AnkiRequest {
    const req: AnkiRequest = { action, version: 6, params };
    if (this.apiKey) req.key = this.apiKey;
    return req;
  }

  /** Execute a typed request against AnkiConnect. */
  private async request<T>(
    action: ReadAction,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const body = this.buildRequest(action, params);

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new AnkiConnectError('Request aborted.', 'unknown-error', e);
      }
      const message = e instanceof Error ? e.message : String(e);
      if (
        message.includes('Failed to fetch') ||
        message.includes('NetworkError')
      ) {
        throw new AnkiConnectError(
          'AnkiConnect is not reachable. Ensure Anki is running with AnkiConnect installed.',
          'unavailable',
          e,
        );
      }
      if (message.includes('CORS') || message.includes('cross-origin')) {
        throw new AnkiConnectError(
          'CORS error: AnkiConnect origin permission may be required.',
          'cors-error',
          e,
        );
      }
      throw new AnkiConnectError(
        `Request failed: ${message}`,
        'unknown-error',
        e,
      );
    }

    if (!response.ok) {
      throw new AnkiConnectError(
        `HTTP ${response.status}: ${response.statusText}`,
        'unknown-error',
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (e) {
      throw new AnkiConnectError(
        'Invalid JSON response from AnkiConnect.',
        'unknown-error',
        e,
      );
    }

    if (!isAnkiResponseShape(parsed)) {
      throw new AnkiConnectError(
        'Malformed response from AnkiConnect: missing result or error field.',
        'unknown-error',
      );
    }

    if (parsed.error !== null) {
      const err = String(parsed.error);
      if (
        err.includes('API key') ||
        err.includes('api key') ||
        err.includes('authentication')
      ) {
        throw new AnkiConnectError(
          'AnkiConnect requires an API key.',
          'api-key-required',
        );
      }
      if (err.includes('permission') || err.includes('origin')) {
        throw new AnkiConnectError(
          'Permission denied by AnkiConnect.',
          'permission-denied',
        );
      }
      throw new AnkiConnectError(err, 'unknown-error');
    }

    return parsed.result as T;
  }

  /** Check AnkiConnect version and reachability. */
  async version(signal?: AbortSignal): Promise<AnkiVersionResult> {
    return this.request<AnkiVersionResult>('version', undefined, signal);
  }

  /** Request origin permission (AnkiConnect 6+). */
  async requestPermission(signal?: AbortSignal): Promise<AnkiPermissionResult> {
    return this.request<AnkiPermissionResult>(
      'requestPermission',
      undefined,
      signal,
    );
  }

  /** List all deck names. */
  async deckNames(signal?: AbortSignal): Promise<string[]> {
    return this.request<string[]>('deckNames', undefined, signal);
  }

  /** List all note type (model) names. */
  async modelNames(signal?: AbortSignal): Promise<string[]> {
    return this.request<string[]>('modelNames', undefined, signal);
  }

  /** List field names for a given note type. */
  async modelFieldNames(
    modelName: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return this.request<string[]>('modelFieldNames', { modelName }, signal);
  }
}

/**
 * Convenience: run the full Stage 1A connection flow.
 * Returns deckNames and modelNames on success.
 * Also returns whether API key is required based on requestPermission.
 */
export async function runAnkiConnectionFlow(
  client: AnkiConnectClient,
  signal?: AbortSignal,
): Promise<{
  decks: string[];
  models: string[];
  requireApiKey: boolean;
}> {
  if (signal?.aborted) {
    throw new AnkiConnectError('Connection cancelled.', 'unknown-error');
  }

  // Step 1: version / reachability
  await client.version(signal);

  if (signal?.aborted) {
    throw new AnkiConnectError('Connection cancelled.', 'unknown-error');
  }

  let requireApiKey = false;

  // Step 2: requestPermission (best-effort; some versions skip this)
  try {
    const perm = await client.requestPermission(signal);
    if (perm.permission === 'denied') {
      throw new AnkiConnectError(
        'Permission denied by AnkiConnect.',
        'permission-denied',
      );
    }
    if (perm.requireApiKey) {
      requireApiKey = true;
    }
  } catch (e) {
    // If permission request fails with a known state, rethrow it
    if (e instanceof AnkiConnectError) {
      if (e.state === 'permission-denied' || e.state === 'api-key-required') {
        throw e;
      }
      // Otherwise continue: some AnkiConnect versions don't support requestPermission
    }
  }

  if (signal?.aborted) {
    throw new AnkiConnectError('Connection cancelled.', 'unknown-error');
  }

  // Step 3: deckNames + modelNames
  const [decks, models] = await Promise.all([
    client.deckNames(signal),
    client.modelNames(signal),
  ]);

  return { decks, models, requireApiKey };
}
