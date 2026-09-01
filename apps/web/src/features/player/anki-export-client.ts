/**
 * AnkiConnect Export Client — Stage 2 write surface (AM-6a / AM-6b)
 * ---------------------------------------------------------------------------
 * Structurally separate from the read-only AnkiConnectClient. This module
 * contains ONLY write/export actions. It must never be imported by read-only
 * flows. All methods are typed and runtime-validated.
 *
 * API key is passed at construction time and never stored beyond the client
 * instance lifetime. The caller (PlayerApp) owns the key in React memory.
 *
 * Actions: canAddNotes, addNote, storeMediaFile, findNotes, notesInfo,
 *          updateNoteFields, addTags, cardsInfo, findCards, apiReflect
 *
 * AnkiDroid handling:
 *   - detectAnkiDroidMode() probes via apiReflect (PC supports,
 *     AnkiDroid's AnkiconnectAndroid bridge returns the default_version
 *     string for unknown actions instead of an error — we classify by
 *     result SHAPE, not by throw-vs-not).
 *   - In AnkiDroid mode, storeMediaFile RETURNS a normalized/deduped filename
 *     (e.g. file_123456789.webm); the caller MUST use the returned name in
 *     markup ([sound:..], <img>, <video>). On PC the input name is stored
 *     as-is so the deterministic filename is safe.
 *   - buildMediaMarkup() encapsulates the PC/AnkiDroid branch so the markup
 *     is always built from the authoritative stored name.
 * --------------------------------------------------------------------------- */

/** Write actions — distinct from ReadAction in anki-connect.ts. */
type WriteAction =
  | 'canAddNotes'
  | 'addNote'
  | 'storeMediaFile'
  | 'findNotes'
  | 'notesInfo'
  | 'updateNoteFields'
  | 'addTags'
  | 'cardsInfo'
  | 'findCards'
  | 'apiReflect';

interface WriteRequest {
  action: WriteAction;
  version: number;
  params?: Record<string, unknown>;
  key?: string;
}

/** Normalized error from export operations. */
export class AnkiExportError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'network'
      | 'aborted'
      | 'api-key-required'
      | 'permission-denied'
      | 'server-error'
      | 'invalid-response'
      | 'canAdd-rejected',
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AnkiExportError';
  }
}

/** Duplicate-handling options for new-note export (matches asbplayer contract). */
export interface AnkiNoteOptions {
  allowDuplicate: boolean;
  duplicateScope: 'deck' | 'collection';
  duplicateScopeOptions: {
    deckName: string;
    checkChildren: boolean;
  };
}

/** A single Anki note field entry for canAddNotes. */
export interface AnkiNoteField {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  tags: string[];
  options?: AnkiNoteOptions;
}

/** Result of canAddNotes — one boolean per note. */
export type CanAddNotesResult = boolean[];

/** Result of addNote — the note ID. */
export type AddNoteResult = number;

/** Result of storeMediaFile — the stored filename. */
export type StoreMediaFileResult = string;

/** Result of findNotes — array of note IDs. */
export type FindNotesResult = number[];

/** A single note's info from notesInfo. */
export interface AnkiNoteInfo {
  noteId: number;
  modelName: string;
  deckName: string;
  fields: Record<string, { value: string; order: number }>;
  tags: string[];
  /** Card IDs associated with this note (returned by notesInfo). */
  cards?: number[];
}

/** Result of updateNoteFields — AnkiConnect returns an object with note info. */
export interface UpdateNoteFieldsResult {
  noteId: number;
}

/** A single card's info from cardsInfo. */
export interface AnkiCardInfo {
  cardId: number;
  deckName: string;
  modelName: string;
  question: string;
  answer: string;
}

/** Result of findCards — array of card IDs. */
export type FindCardsResult = number[];

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

/**
 * Export/write client for AnkiConnect. Structurally isolated from the
 * read-only AnkiConnectClient. The caller owns the API key lifecycle.
 */
export class AnkiExportClient {
  constructor(
    private readonly endpoint: string = 'http://127.0.0.1:8765',
    private readonly apiKey: string | undefined = undefined,
  ) {}

  /** Build a write request payload. */
  private buildRequest(
    action: WriteAction,
    params?: Record<string, unknown>,
  ): WriteRequest {
    const req: WriteRequest = { action, version: 6, params };
    if (this.apiKey) req.key = this.apiKey;
    return req;
  }

  /** Execute a typed write request against AnkiConnect. */
  private async request<T>(
    action: WriteAction,
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
        throw new AnkiExportError('Request aborted.', 'aborted', e);
      }
      throw new AnkiExportError(
        e instanceof Error ? e.message : 'Network error.',
        'network',
        e,
      );
    }

    if (!response.ok) {
      throw new AnkiExportError(
        `HTTP ${response.status}: ${response.statusText}`,
        'server-error',
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (e) {
      throw new AnkiExportError(
        'Invalid JSON response from AnkiConnect.',
        'invalid-response',
        e,
      );
    }

    if (!isAnkiResponseShape(parsed)) {
      throw new AnkiExportError(
        'Malformed response from AnkiConnect.',
        'invalid-response',
      );
    }

    if (parsed.error !== null) {
      const err = String(parsed.error);
      if (
        err.includes('API key') ||
        err.includes('api key') ||
        err.includes('authentication')
      ) {
        throw new AnkiExportError(
          'AnkiConnect requires an API key.',
          'api-key-required',
        );
      }
      if (err.includes('permission') || err.includes('origin')) {
        throw new AnkiExportError(
          'Permission denied by AnkiConnect.',
          'permission-denied',
        );
      }
      throw new AnkiExportError(err, 'server-error');
    }

    return parsed.result as T;
  }

  /** Check if notes can be added (no duplicates etc). */
  async canAddNotes(
    notes: AnkiNoteField[],
    signal?: AbortSignal,
  ): Promise<CanAddNotesResult> {
    return this.request<CanAddNotesResult>('canAddNotes', { notes }, signal);
  }

  /** Add a single note and return its ID. */
  async addNote(
    note: AnkiNoteField,
    signal?: AbortSignal,
  ): Promise<AddNoteResult> {
    return this.request<AddNoteResult>('addNote', { note }, signal);
  }

  /** Store a media file (image/audio) by base64 content. */
  async storeMediaFile(
    filename: string,
    base64Data: string,
    signal?: AbortSignal,
  ): Promise<StoreMediaFileResult> {
    return this.request<StoreMediaFileResult>(
      'storeMediaFile',
      { filename, data: base64Data },
      signal,
    );
  }

  /** Find notes by a query string (e.g., 'added:1'). */
  async findNotes(
    query: string,
    signal?: AbortSignal,
  ): Promise<FindNotesResult> {
    return this.request<FindNotesResult>('findNotes', { query }, signal);
  }

  /** Get info for specific note IDs. */
  async notesInfo(
    noteIds: number[],
    signal?: AbortSignal,
  ): Promise<AnkiNoteInfo[]> {
    return this.request<AnkiNoteInfo[]>(
      'notesInfo',
      { notes: noteIds },
      signal,
    );
  }

  /** Update fields on an existing note. */
  async updateNoteFields(
    noteId: number,
    fields: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<UpdateNoteFieldsResult> {
    return this.request<UpdateNoteFieldsResult>(
      'updateNoteFields',
      { note: { id: noteId, fields } },
      signal,
    );
  }

  /** Add tags to existing notes (additive: existing tags are kept). */
  async addTags(
    noteIds: number[],
    tags: string,
    signal?: AbortSignal,
  ): Promise<null> {
    return this.request<null>(
      'addTags',
      { notes: noteIds, tags },
      signal,
    );
  }

  /** Get info for specific card IDs (batched). Returns deckName per card. */
  async cardsInfo(
    cardIds: number[],
    signal?: AbortSignal,
  ): Promise<AnkiCardInfo[]> {
    return this.request<AnkiCardInfo[]>(
      'cardsInfo',
      { cards: cardIds },
      signal,
    );
  }

  /** Find card IDs by a search query (e.g., 'nid:12345'). */
  async findCards(
    query: string,
    signal?: AbortSignal,
  ): Promise<FindCardsResult> {
    return this.request<FindCardsResult>('findCards', { query }, signal);
  }

  /**
   * Generic AnkiConnect passthrough. Used for AnkiDroid detection: the official
   * PC AnkiConnect supports `apiReflect` and returns an object with an `actions`
   * array; AnkiconnectAndroid (the AnkiDroid bridge) does not and falls back to
   * `default_version()`, which yields the bare string `"AnkiConnect v.6"`.
   *
   * Kept on the write client because `apiReflect` is a generic passthrough
   * that can be used by writers (not just readers). Detection classifies by
   * the RESULT SHAPE, not by throw-vs-not — see `detectAnkiDroidMode`.
   */
  async apiReflect<T = unknown>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request<T>('apiReflect', params, signal);
  }
}

/**
 * Encode a Blob to base64 string (for storeMediaFile).
 * Uses FileReader → readAsDataURL → strip prefix.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader did not return a string.'));
        return;
      }
      // Strip "data:*/*;base64," prefix
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error('FileReader error.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Generate a content-addressed, Anki-safe media filename.
 *
 * Deterministic: the same blob bytes always produce the same basename
 * (`prefix_<first10hex(SHA-256)>.ext`), so re-exporting the same clip /
 * screenshot / audio is idempotent and Anki's own dedup keeps
 * collection.media clean. Previously this used Math.random + Date.now(),
 * which leaked a new file on every export.
 *
 * When no `blob` is supplied, falls back to a non-deterministic name
 * (Math.random-based) so non-media callers and existing tests that don't
 * have a blob still work. Production export paths ALWAYS pass a blob.
 *
 * Sanitization rules:
 *   - prefix: any char outside [a-zA-Z0-9_-] → '_' (allows the underscore
 *     separator to stay unambiguous)
 *   - extension: any char outside [a-zA-Z0-9] → '' (stripped)
 *
 * No path separators, no spaces, no query chars: safe to embed inside
 * `<img src="...">`, `<video src="...">`, and `[sound:...]` markup.
 */
export async function generateMediaFilename(
  prefix: string,
  extension: string,
  blob?: Blob,
): Promise<string> {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeExt = extension.replace(/[^a-zA-Z0-9]/g, '');
  if (blob) {
    const digest = await sha256HexPrefix(blob, 10);
    return `${safePrefix}_${digest}.${safeExt}`;
  }
  // Fallback: legacy random-based naming (only reached when caller has no
  // blob yet, e.g. unit tests that don't exercise the export pipeline).
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${safePrefix}_${timestamp}_${random}.${safeExt}`;
}

/**
 * SHA-256 the first `hexChars` hex characters of a blob's bytes.
 * Uses browser crypto.subtle when available; falls back to a stable
 * non-cryptographic hash for environments without WebCrypto.
 *
 * IMPORTANT: `crypto.subtle` is only exposed in a SECURE CONTEXT — i.e.
 * HTTPS origins, or HTTP on localhost. Over plain-HTTP LAN delivery to a
 * non-localhost host (a typical AnkiDroid-paired "phone is the Anki
 * server" setup on `http://192.168.x.x`), the browser will refuse to
 * expose subtle and this fallback IS the production path, not just a
 * test-environment fallback. The contract is "same input bytes → same
 * hex prefix"; collisions collapse to same-name overwrite, which at the
 * scale of an individual deck's media files is negligible.
 */
async function sha256HexPrefix(blob: Blob, hexChars: number): Promise<string> {
  if (typeof crypto !== 'undefined' && 'subtle' in crypto) {
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      await blob.arrayBuffer(),
    );
    const hashArray = new Uint8Array(hashBuffer);
    let hex = '';
    for (let i = 0; i < hashArray.length && hex.length < hexChars; i++) {
      hex += hashArray[i]!.toString(16).padStart(2, '0');
    }
    return hex.slice(0, hexChars);
  }
  // Fallback: stable FNV-1a-ish mix over the first 4 KiB of bytes.
  // Same input → same output, which is the only contract we need here.
  const sampleSize = Math.min(blob.size, 4096);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < sampleSize; i++) {
    const ch = bytes[i]!;
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2 ^ ch, 16777619);
  }
  const combined = (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0');
  return combined.slice(0, hexChars).padEnd(hexChars, '0');
}

/**
 * Media markup kinds — what kind of field markup to emit for the stored
 * media file. Centralized so buildMediaMarkup has a single switch.
 */
export type MediaKind = 'sound' | 'image' | 'video';

/**
 * Build the Anki field markup for a stored media file.
 *
 * PC AnkiConnect mode (`ankiDroidMode === false`):
 *   storeMediaFile stores the input filename as-is, so the markup uses the
 *   caller-supplied `filename` (which is already the deterministic
 *   content-hash name). This preserves the existing PC wire shape exactly.
 *
 * AnkiDroid mode (`ankiDroidMode === true`):
 *   AnkiconnectAndroid's storeMediaFile RETURNS a normalized/deduped
 *   filename (e.g. `file_123456789.webm`); the input filename does NOT
 *   exist in collection.media. Markup MUST use `storedFilename` here or
 *   the card silently renders no media. THIS is the original AnkiDroid
 *   bug fix (mterd0ge_hmsg34 mismatch class).
 *
 * Returned markup examples:
 *   sound → `[sound:clip_abc.webm]`
 *   image → `<img src="screenshot_xyz.jpg">`
 *   video → `<video autoplay loop muted playsinline src="clip_xyz.webm"></video>`
 */
export function buildMediaMarkup(
  kind: MediaKind,
  filename: string,
  storedFilename: string,
  ankiDroidMode: boolean,
): string {
  let effective = ankiDroidMode ? storedFilename : filename;
  // AnkiDroid branch safety: if the stored filename returned by
  // AnkiconnectAndroid contains anything outside [A-Za-z0-9._-], fall
  // back to the deterministic input filename. Real AnkiDroid stored
  // names are `file_<digits>.<ext>` so this never fires in practice —
  // uniform safety across PC and AnkiDroid markup paths.
  if (ankiDroidMode && !/^[A-Za-z0-9._-]+$/.test(effective)) {
    effective = filename;
  }
  switch (kind) {
    case 'sound':
      return `[sound:${effective}]`;
    case 'image':
      return `<img src="${effective}">`;
    case 'video':
      return `<video autoplay loop muted playsinline src="${effective}"></video>`;
  }
}

/**
 * Session-cached AnkiDroid detection.
 *
 * Probe strategy: official PC AnkiConnect implements `apiReflect` and
 * echoes back an object whose `actions` field is an Array (FooSoft
 * AnkiConnect __init__.py apiReflect). AnkiconnectAndroid (the AnkiDroid
 * bridge) does NOT implement apiReflect — its `findRoute` falls through
 * to `default_version()`, so the wire response for version 6 is just
 * `{"result":"AnkiConnect v.6","error":null}` (HTTP 200, no throw).
 *
 * Classification rule (result shape, NOT throw-vs-not):
 *   - result is a non-null object AND `result.actions` is an Array → PC
 *   - everything else (string `"AnkiConnect v.6"`, object without
 *     `actions`, `{}`, network error) → AnkiDroid
 *
 * The result is cached per `AnkiExportClient` instance (WeakMap) so the
 * detection round-trip is paid once per client. The new and update
 * paths share the same client, so they both hit the cache; the append
 * path constructs a fresh client and pays its own probe.
 */
const ankiDroidModeCache = new WeakMap<AnkiExportClient, boolean>();

export async function detectAnkiDroidMode(
  client: AnkiExportClient,
): Promise<boolean> {
  const cached = ankiDroidModeCache.get(client);
  if (cached !== undefined) return cached;
  let result: unknown;
  try {
    // apiReflect is a generic passthrough — call it through unknown and
    // narrow by shape. PC returns an object with an `actions` array;
    // AnkiDroid returns the bare default_version() string.
    result = await client.apiReflect<unknown>({ scopes: ['actions'] });
  } catch {
    // Network / HTTP / malformed-response failures → assume AnkiDroid
    // (safer default: we won't silently overwrite PC markup semantics,
    // and the caller can retry or surface the error).
    ankiDroidModeCache.set(client, true);
    return true;
  }
  const isPC =
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as { actions?: unknown }).actions);
  ankiDroidModeCache.set(client, !isPC);
  return !isPC;
}

/**
 * Reset the detection cache for a given client. Test-only utility.
 */
export function _resetAnkiDroidModeCache(client: AnkiExportClient): void {
  ankiDroidModeCache.delete(client);
}

/**
 * Update a note's fields, then additively apply configured tags.
 * ASB parity (asbplayer common/anki/anki.ts: updateNoteFields → await
 * addTags): a tag failure is NOT caught here — the caller treats the
 * whole export / note as failed (no partial success, no success toast,
 * no history). Empty tags perform ZERO API calls.
 */
export async function updateNoteFieldsAndAddTags(
  client: AnkiExportClient,
  noteId: number,
  fields: Record<string, string>,
  tagsText: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.updateNoteFields(noteId, fields, signal);
  const trimmed = tagsText.trim();
  if (trimmed.length > 0) {
    await client.addTags([noteId], trimmed, signal);
  }
}

/**
 * Apply tags only (append path with no field updates). Same ASB parity:
 * a failure propagates to the caller (the note becomes failed). Empty
 * tags are a no-op (zero API calls).
 */
export async function addTagsOnlyIfAny(
  client: AnkiExportClient,
  noteId: number,
  tagsText: string,
  signal?: AbortSignal,
): Promise<void> {
  const trimmed = tagsText.trim();
  if (trimmed.length === 0) return;
  await client.addTags([noteId], trimmed, signal);
}
