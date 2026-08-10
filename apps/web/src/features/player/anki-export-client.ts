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
 *          updateNoteFields, addTags
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
  | 'findCards';

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
 * Generate a safe Anki media filename basename.
 * No path separators, no special chars.
 */
export function generateMediaFilename(
  prefix: string,
  extension: string,
): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeExt = extension.replace(/[^a-zA-Z0-9]/g, '');
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${safePrefix}_${timestamp}_${random}.${safeExt}`;
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
