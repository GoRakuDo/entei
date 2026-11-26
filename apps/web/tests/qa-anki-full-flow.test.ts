/**
 * QA flow — AnkiConnect, wire by wire, for every export path.
 * ---------------------------------------------------------------------------
 * A fake AnkiConnect server sits behind `global.fetch`: it records the exact
 * request body of every call and answers from a handler. That makes the wire
 * protocol itself the thing under test — action name, `version: 6`, `params`
 * shape, the `key` field, and the `{ result, error }` envelope — instead of a
 * stubbed client that can happily agree with a broken payload.
 *
 * Flows covered:
 *   1. Connection      version → requestPermission → deckNames + modelNames
 *   2. Field retrieval modelFieldNames
 *   3. Duplicates      findNotes query per duplicateScope / checkAllModels
 *   4. New card        canAddNotes → storeMediaFile → addNote → suspendNewCards
 *   5. Latest update   findNotes('added:1') → notesInfo → updateNoteFields → addTags
 *   6. Append          notesInfo → append-only field composition → addTags
 *   7. Yomitan control the Miscellaneous Configuration bridge (import / reset)
 *
 * SCOPE NOTE — where the orchestration lives. The read-only client and the
 * write client own every REQUEST; the ORDER of the flows (4, 5, 6) is authored
 * inline in `components/player/PlayerApp.tsx` (the mining export handlers, see
 * the line references on each block below). Those handlers are React component
 * code that cannot be imported on its own, so each flow test drives the SAME
 * production primitives in the SAME order and pins the contract: which call
 * comes first, which payload each one carries, and which guard stops the flow.
 * A change to PlayerApp's wiring without a matching change here shows up as a
 * protocol diff — the primitives themselves are never re-implemented.
 * ---------------------------------------------------------------------------
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import {
  AnkiConnectClient,
  AnkiConnectError,
  runAnkiConnectionFlow,
} from '@/features/player/anki-connect';
import {
  AnkiExportClient,
  AnkiExportError,
  addTagsOnlyIfAny,
  blobToBase64,
  buildMediaMarkup,
  detectAnkiDroidMode,
  generateMediaFilename,
  updateNoteFieldsAndAddTags,
} from '@/features/player/anki-export-client';
import {
  buildDuplicateQuery,
  checkForDuplicateNotes,
} from '@/modules/yomitan/anki/anki-duplicate-checker';
import {
  isDenChouActiveTarget,
  wrapDenChouField,
} from '@/features/player/denchou-scene';
import {
  ANKI_CONNECTION_PREFS_KEY,
  DEFAULT_ANKI_CONNECTION_PREFERENCES,
  DEFAULT_CARD_FORMATS,
  readAnkiConnectionPreferences,
  writeAnkiConnectionPreferences,
} from '@/features/player/anki-connection-preferences';
import {
  importSettingsFromJson,
  resetSettings,
} from '@/modules/yomitan/settings-backup';
import {
  readYomitanOptions,
  writeOptionPath,
} from '@/modules/yomitan/yomitan-preferences';
import {
  createDefaultAnkiOptions,
  type AnkiCardField,
  type AnkiOptions,
  type Options,
} from '@gorakudo/yomitan-headless/settings';

const ENDPOINT = 'http://127.0.0.1:8765';

/* ---------------------------------------------------------------------------
 * Fake AnkiConnect
 * ------------------------------------------------------------------------- */

interface WireCall {
  action: string;
  version: number;
  params?: Record<string, unknown>;
  key?: string;
}

type WireAnswer = { result?: unknown; error?: string };

/** Install a fake AnkiConnect; returns the request bodies it received. */
function installAnkiServer(handler: (call: WireCall) => WireAnswer): {
  calls: WireCall[];
  urls: string[];
} {
  const calls: WireCall[] = [];
  const urls: string[] = [];
  global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as WireCall;
    calls.push(body);
    urls.push(String(url));
    const answer = handler(body);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        result: answer.result ?? null,
        error: answer.error ?? null,
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, urls };
}

/** Install a server that answers one action table, and rejects everything else. */
function installActionTable(
  table: Record<string, (call: WireCall) => WireAnswer>,
): { calls: WireCall[]; urls: string[] } {
  return installAnkiServer((call) => {
    const answer = table[call.action];
    if (answer !== undefined) return answer(call);
    return { error: `unexpected action ${call.action}` };
  });
}

/** The actions of the recorded calls, in order. */
function actions(calls: WireCall[]): string[] {
  return calls.map((call) => call.action);
}

/** `params` of the one call with this action (fails loudly when absent). */
function paramsOf(calls: WireCall[], action: string): Record<string, unknown> {
  const found = calls.filter((call) => call.action === action).at(-1);
  if (found === undefined) throw new Error(`no ${action} call was made`);
  return found.params ?? {};
}

/** Await a call that must FAIL with a read-client error, typed. */
async function connectRejection(promise: Promise<unknown>): Promise<AnkiConnectError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AnkiConnectError) return error;
    throw error;
  }
  throw new Error('expected an AnkiConnectError, but the call resolved');
}

/** Await a call that must FAIL with a write-client error, typed. */
async function exportRejection(promise: Promise<unknown>): Promise<AnkiExportError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AnkiExportError) return error;
    throw error;
  }
  throw new Error('expected an AnkiExportError, but the call resolved');
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  localStorage.clear();
});

/* ---------------------------------------------------------------------------
 * 1. Connection flow
 * ------------------------------------------------------------------------- */

describe('Connection flow — version → requestPermission → deckNames + modelNames', () => {
  it('runs the documented order with version 6 and no key when none is set', async () => {
    const { calls, urls } = installActionTable({
      version: () => ({ result: 6 }),
      requestPermission: () => ({ result: { permission: 'granted' } }),
      deckNames: () => ({ result: ['Default', 'Japanese'] }),
      modelNames: () => ({ result: ['Basic', 'DenChou'] }),
    });

    const client = new AnkiConnectClient(ENDPOINT);
    const result = await runAnkiConnectionFlow(client);

    expect(actions(calls)).toEqual([
      'version',
      'requestPermission',
      'deckNames',
      'modelNames',
    ]);
    expect(result.decks).toEqual(['Default', 'Japanese']);
    expect(result.models).toEqual(['Basic', 'DenChou']);
    expect(result.requireApiKey).toBe(false);

    // Every request is AnkiConnect v6 against the configured endpoint.
    expect(calls.every((call) => call.version === 6)).toBe(true);
    expect(urls.every((url) => url === ENDPOINT)).toBe(true);

    // No credential → the `key` field is absent, not empty, and a param-less
    // action sends no `params` key at all (AnkiConnect treats `params: null` and
    // an absent `params` differently for some actions).
    expect(calls.every((call) => !('key' in call))).toBe(true);
    expect('params' in calls[0]!).toBe(false);
    expect('params' in calls[1]!).toBe(false);
  });

  it('carries the API key on EVERY request and never in the URL', async () => {
    const { calls, urls } = installActionTable({
      version: () => ({ result: 6 }),
      requestPermission: () => ({ result: { permission: 'granted' } }),
      deckNames: () => ({ result: ['Default'] }),
      modelNames: () => ({ result: ['Basic'] }),
    });

    const client = new AnkiConnectClient(ENDPOINT, 'secret-key-123');
    await runAnkiConnectionFlow(client);

    expect(calls.length).toBe(4);
    expect(calls.every((call) => call.key === 'secret-key-123')).toBe(true);
    expect(urls.some((url) => url.includes('secret-key-123'))).toBe(false);
  });

  it('reports requireApiKey when requestPermission says the instance wants one', async () => {
    installActionTable({
      version: () => ({ result: 6 }),
      requestPermission: () => ({
        result: { permission: 'granted', requireApiKey: true },
      }),
      deckNames: () => ({ result: [] }),
      modelNames: () => ({ result: [] }),
    });

    const result = await runAnkiConnectionFlow(new AnkiConnectClient(ENDPOINT));
    expect(result.requireApiKey).toBe(true);
  });

  it('fails soft to `unavailable` when nothing is listening', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const error = await connectRejection(new AnkiConnectClient(ENDPOINT).version());

    expect(error).toBeInstanceOf(AnkiConnectError);
    expect(error.state).toBe('unavailable');
    expect(error.message).toContain('not reachable');
  });

  it('maps transport failures to their own states', async () => {
    // HTTP error status.
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const httpError = await connectRejection(
      new AnkiConnectClient(ENDPOINT).version(),
    );
    expect(httpError.state).toBe('unknown-error');
    expect(httpError.message).toContain('HTTP 500');

    // Body is not JSON.
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    })) as unknown as typeof fetch;
    const jsonError = await connectRejection(
      new AnkiConnectClient(ENDPOINT).version(),
    );
    expect(jsonError.state).toBe('unknown-error');
    expect(jsonError.message).toContain('Invalid JSON');

    // JSON, but not an AnkiConnect envelope.
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ hello: 'world' }),
    })) as unknown as typeof fetch;
    const shapeError = await connectRejection(
      new AnkiConnectClient(ENDPOINT).version(),
    );
    expect(shapeError.state).toBe('unknown-error');
    expect(shapeError.message).toContain('Malformed response');
  });

  it('classifies the two authenticated-failure envelopes', async () => {
    installActionTable({ version: () => ({ error: 'API key was not supplied' }) });
    const keyError = await connectRejection(
      new AnkiConnectClient(ENDPOINT).version(),
    );
    expect(keyError.state).toBe('api-key-required');

    installActionTable({ version: () => ({ error: 'origin not permitted' }) });
    const permError = await connectRejection(
      new AnkiConnectClient(ENDPOINT).version(),
    );
    expect(permError.state).toBe('permission-denied');
  });

  it('continues when the instance has no requestPermission action', async () => {
    const { calls } = installActionTable({
      version: () => ({ result: 6 }),
      // An older AnkiConnect: the action itself is unknown.
      requestPermission: () => ({ error: 'Unsupported action' }),
      deckNames: () => ({ result: ['Default'] }),
      modelNames: () => ({ result: ['Basic'] }),
    });

    const result = await runAnkiConnectionFlow(new AnkiConnectClient(ENDPOINT));
    expect(result.decks).toEqual(['Default']);
    expect(actions(calls)).toEqual([
      'version',
      'requestPermission',
      'deckNames',
      'modelNames',
    ]);
  });

  it('stops before the lists when permission is DENIED', async () => {
    const { calls } = installActionTable({
      version: () => ({ result: 6 }),
      requestPermission: () => ({ result: { permission: 'denied' } }),
      deckNames: () => ({ result: ['Default'] }),
      modelNames: () => ({ result: ['Basic'] }),
    });

    const error = await connectRejection(
      runAnkiConnectionFlow(new AnkiConnectClient(ENDPOINT)),
    );

    expect(error.state).toBe('permission-denied');
    // Nothing was listed: no half-connected state.
    expect(actions(calls)).toEqual(['version', 'requestPermission']);
  });

  it('honours an already-aborted signal without touching the network', async () => {
    const { calls } = installAnkiServer(() => ({ result: 6 }));
    const controller = new AbortController();
    controller.abort();

    const error = await connectRejection(
      runAnkiConnectionFlow(new AnkiConnectClient(ENDPOINT), controller.signal),
    );

    expect(error.message).toContain('cancelled');
    expect(calls.length).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * 2. Field retrieval flow
 * ------------------------------------------------------------------------- */

describe('Field retrieval — modelFieldNames', () => {
  it('sends { modelName } and returns the field list', async () => {
    const { calls } = installActionTable({
      modelFieldNames: () => ({
        result: ['word', 'reading', 'sentence', 'glossary'],
      }),
    });

    const fields = await new AnkiConnectClient(ENDPOINT).modelFieldNames(
      'DenChou',
    );

    expect(fields).toEqual(['word', 'reading', 'sentence', 'glossary']);
    expect(actions(calls)).toEqual(['modelFieldNames']);
    expect(paramsOf(calls, 'modelFieldNames')).toEqual({ modelName: 'DenChou' });
  });

  it('keeps the caller’s resolved list intact when a re-fetch fails', async () => {
    // Field lists are memoised by the CALLER (per model). The client itself is
    // stateless, so a failed re-fetch must leave the previous answer usable —
    // the rejected promise is the only thing the caller sees.
    let failNext = false;
    installActionTable({
      modelFieldNames: () => {
        if (failNext) return { error: 'model was not found' };
        return { result: ['word', 'sentence'] };
      },
    });
    const client = new AnkiConnectClient(ENDPOINT);

    const first = await client.modelFieldNames('DenChou');
    expect(first).toEqual(['word', 'sentence']);

    failNext = true;
    const error = await connectRejection(client.modelFieldNames('DenChou'));
    expect(error).toBeInstanceOf(AnkiConnectError);
    // The earlier answer is untouched (no shared, mutated array).
    expect(first).toEqual(['word', 'sentence']);

    // A retry re-asks the server rather than trusting a cached failure.
    failNext = false;
    expect(await client.modelFieldNames('DenChou')).toEqual([
      'word',
      'sentence',
    ]);
  });
});

/* ---------------------------------------------------------------------------
 * 3. Duplicate detection flow
 * ------------------------------------------------------------------------- */

describe('Duplicate detection — findNotes query construction', () => {
  const base = {
    checkForDuplicates: true,
    firstFieldName: 'word',
    deckName: 'Japanese::Core2k',
  } as const;

  it('scopes the query to collection / deck / deck root', () => {
    expect(
      buildDuplicateQuery('猫', { ...base, duplicateScope: 'collection' }),
    ).toBe('"word:猫"');
    expect(buildDuplicateQuery('猫', { ...base, duplicateScope: 'deck' })).toBe(
      'deck:"Japanese::Core2k" "word:猫"',
    );
    expect(
      buildDuplicateQuery('猫', { ...base, duplicateScope: 'deck-root' }),
    ).toBe('deck:"Japanese" "word:猫"');
  });

  it('drops the field prefix when checkAllModels is on, and escapes quotes', () => {
    expect(
      buildDuplicateQuery('猫', {
        ...base,
        duplicateScope: 'collection',
        checkAllModels: true,
      }),
    ).toBe('"猫"');
    // Anki's query syntax: quotes and backslashes are escaped.
    expect(
      buildDuplicateQuery('say "hi" \\ bye', {
        ...base,
        duplicateScope: 'collection',
      }),
    ).toBe('"word:say \\"hi\\" \\\\ bye"');
  });

  it('makes no request at all when duplicate checking is off', async () => {
    const { calls } = installAnkiServer(() => ({ result: [] }));
    const result = await checkForDuplicateNotes(
      new AnkiConnectClient(ENDPOINT),
      '猫',
      { ...base, duplicateScope: 'collection', checkForDuplicates: false },
    );

    expect(result).toEqual({ checked: false, noteIds: [], query: '' });
    expect(calls.length).toBe(0);
  });

  it('normalizes a null result to [] so the UI never reads null', async () => {
    const { calls } = installActionTable({
      findNotes: () => ({ result: null }),
    });
    const result = await checkForDuplicateNotes(
      new AnkiConnectClient(ENDPOINT),
      '猫',
      { ...base, duplicateScope: 'deck-root' },
    );

    expect(result.checked).toBe(true);
    expect(result.noteIds).toEqual([]);
    expect(paramsOf(calls, 'findNotes')).toEqual({
      query: 'deck:"Japanese" "word:猫"',
    });
  });

  it('returns the hits when the term already exists', async () => {
    installActionTable({ findNotes: () => ({ result: [1700000000001] }) });
    const result = await checkForDuplicateNotes(
      new AnkiConnectClient(ENDPOINT),
      '猫',
      { ...base, duplicateScope: 'collection' },
    );
    expect(result.noteIds).toEqual([1700000000001]);
  });
});

/* ---------------------------------------------------------------------------
 * 4. New-card flow
 * ------------------------------------------------------------------------- */

/** The duplicate policy PlayerApp sends with every new note. */
function newNoteOptions(deckName: string) {
  return {
    allowDuplicate: true,
    duplicateScope: 'deck' as const,
    duplicateScopeOptions: {
      deckName,
      checkChildren: false,
      checkAllModels: false,
    },
  };
}

describe('New card flow — canAddNotes → media → addNote → suspend', () => {
  it('sends checkAllModels explicitly (the AnkiDroid NPE guard) and the deck scope', async () => {
    const { calls } = installActionTable({ canAddNotes: () => ({ result: [true] }) });
    const client = new AnkiExportClient(ENDPOINT, 'key-1');

    await client.canAddNotes([
      {
        deckName: 'DenChou',
        modelName: 'DenChou',
        fields: { word: '猫', sentence: '猫が好き' },
        tags: ['entei'],
        options: newNoteOptions('DenChou'),
      },
    ]);

    const call = calls[0]!;
    expect(call.action).toBe('canAddNotes');
    expect(call.version).toBe(6);
    expect(call.key).toBe('key-1');
    const note = (paramsOf(calls, 'canAddNotes').notes as Record<string, unknown>[])[0]!;
    expect(note.deckName).toBe('DenChou');
    expect(note.modelName).toBe('DenChou');
    expect(note.tags).toEqual(['entei']);
    // AnkiconnectAndroid's NoteRequest.readNoteOptions() reads this key
    // unconditionally when deckName is present and NPEs when it is missing.
    const options = note.options as Record<string, unknown>;
    expect(options.allowDuplicate).toBe(true);
    expect(options.duplicateScope).toBe('deck');
    expect(
      (options.duplicateScopeOptions as Record<string, unknown>).checkAllModels,
    ).toBe(false);
  });

  it('runs canAddNotes → image → audio → addNote with content-addressed names', async () => {
    const { calls } = installActionTable({
      canAddNotes: () => ({ result: [true] }),
      // PC AnkiConnect stores the given name as-is and echoes it back.
      storeMediaFile: (call) => ({ result: call.params?.filename }),
      addNote: () => ({ result: 1700000000042 }),
    });
    const client = new AnkiExportClient(ENDPOINT);

    // --- canAddNotes (PlayerApp.tsx ~4375) -------------------------------
    const canAdd = await client.canAddNotes([
      {
        deckName: 'DenChou',
        modelName: 'DenChou',
        fields: { word: '猫', sentence: '<span class="group">猫が好き</span>' },
        tags: ['entei', 'mining'],
        options: newNoteOptions('DenChou'),
      },
    ]);
    expect(canAdd).toEqual([true]);

    // --- media (PlayerApp.tsx ~4400-4445) --------------------------------
    const image = new Blob([new Uint8Array([1, 2, 3, 4, 5])], {
      type: 'image/jpeg',
    });
    const imageName = await generateMediaFilename('entei_screenshot', 'jpg', image);
    // Deterministic: the same bytes always produce the same basename, so a
    // re-export overwrites its own file instead of leaking a new one.
    expect(imageName).toBe(
      await generateMediaFilename('entei_screenshot', 'jpg', image),
    );
    expect(imageName).toMatch(/^entei_screenshot_[0-9a-f]{10}\.jpg$/);
    const imageBase64 = await blobToBase64(image);
    expect(imageBase64).toBe('AQIDBAU=');
    const storedImage = await client.storeMediaFile(imageName, imageBase64);
    expect(storedImage).toBe(imageName);

    const audio = new Blob([new Uint8Array([9, 9])], { type: 'audio/webm' });
    const audioName = await generateMediaFilename('entei_audio', 'webm', audio);
    expect(audioName).toMatch(/^entei_audio_[0-9a-f]{10}\.webm$/);
    await client.storeMediaFile(audioName, await blobToBase64(audio));

    // --- addNote (PlayerApp.tsx ~4470) -----------------------------------
    const noteId = await client.addNote({
      deckName: 'DenChou',
      modelName: 'DenChou',
      fields: {
        word: '猫',
        sentence: '<span class="group">猫が好き</span>',
        picture: buildMediaMarkup('image', imageName, storedImage, false),
        sentenceAudio: buildMediaMarkup('sound', audioName, audioName, false),
      },
      tags: ['entei'],
      options: newNoteOptions('DenChou'),
    });
    expect(noteId).toBe(1700000000042);

    expect(actions(calls)).toEqual([
      'canAddNotes',
      'storeMediaFile',
      'storeMediaFile',
      'addNote',
    ]);
    // storeMediaFile carries the base64 body, not a path or a URL.
    expect(paramsOf(calls, 'storeMediaFile')).toMatchObject({
      filename: audioName,
      data: expect.any(String),
    });
    const addedNote = paramsOf(calls, 'addNote').note as Record<string, unknown>;
    const fields = addedNote.fields as Record<string, string>;
    expect(fields.picture).toBe(`<img src="${imageName}">`);
    expect(fields.sentenceAudio).toBe(`[sound:${audioName}]`);
  });

  it('uses the AnkiDroid-returned filename in markup, and probes only once', async () => {
    const { calls } = installActionTable({
      // AnkiconnectAndroid: apiReflect is unknown, so it falls through to the
      // bare default_version() string — that string is the classification signal.
      apiReflect: () => ({ result: 'AnkiConnect v.6' }),
      storeMediaFile: () => ({ result: 'file_123456789.webm' }),
      addNote: () => ({ result: 7 }),
    });
    const client = new AnkiExportClient(ENDPOINT);

    expect(await detectAnkiDroidMode(client)).toBe(true);
    const markup = buildMediaMarkup(
      'sound',
      'entei_audio_abcd123456.webm',
      'file_123456789.webm',
      true,
    );
    // The input filename does not exist in collection.media on AnkiDroid —
    // using it would render a card with no audio at all.
    expect(markup).toBe('[sound:file_123456789.webm]');

    // Cached per client: a second probe pays nothing.
    expect(await detectAnkiDroidMode(client)).toBe(true);
    expect(actions(calls).filter((action) => action === 'apiReflect').length).toBe(
      1,
    );

    // An unusable stored name falls back to the deterministic input name.
    expect(
      buildMediaMarkup('image', 'entei_screenshot_x1.jpg', 'not a filename.jpg', true),
    ).toBe('<img src="entei_screenshot_x1.jpg">');
  });

  it('stops the flow when canAddNotes says no (no media, no note)', async () => {
    const { calls } = installActionTable({
      canAddNotes: () => ({ result: [false] }),
      storeMediaFile: () => ({ result: 'should-not-happen.jpg' }),
      addNote: () => ({ result: 1 }),
    });
    const client = new AnkiExportClient(ENDPOINT);

    const canAdd = await client.canAddNotes([
      {
        deckName: 'DenChou',
        modelName: 'DenChou',
        fields: { word: '猫' },
        tags: [],
        options: newNoteOptions('DenChou'),
      },
    ]);
    expect(canAdd[0]).toBe(false);
    expect(actions(calls)).toEqual(['canAddNotes']);
  });

  it('suspends the freshly created card when suspendNewCards is on', async () => {
    const { calls } = installActionTable({
      findCards: () => ({ result: [555] }),
      suspend: () => ({ result: true }),
    });
    const client = new AnkiExportClient(ENDPOINT);

    const cards = await client.findCards('nid:' + 1700000000042);
    expect(cards).toEqual([555]);
    expect(await client.suspend(cards)).toBe(true);

    expect(actions(calls)).toEqual(['findCards', 'suspend']);
    expect(paramsOf(calls, 'findCards')).toEqual({
      query: 'nid:1700000000042',
    });
    expect(paramsOf(calls, 'suspend')).toEqual({ cards: [555] });
  });

  it('keeps the created card when the suspend step fails', async () => {
    // A failed suspend only warns in PlayerApp (~4495): the note is already in
    // the collection, so it must not be reported as a failed export.
    const { calls } = installActionTable({
      findCards: () => ({ result: [555] }),
      suspend: () => ({ error: 'card is in a filtered deck' }),
    });
    const client = new AnkiExportClient(ENDPOINT);

    const cards = await client.findCards('nid:1');
    const suspendResult = await client.suspend(cards).catch(() => null);

    expect(suspendResult).toBeNull();
    expect(actions(calls)).toEqual(['findCards', 'suspend']);
  });
});

/* ---------------------------------------------------------------------------
 * 5. Latest-card update flow
 * ------------------------------------------------------------------------- */

describe('Latest card update — findNotes → notesInfo → updateNoteFields → addTags', () => {
  it('targets the newest note, validates the model, then writes fields + tags', async () => {
    const { calls } = installActionTable({
      findNotes: () => ({ result: [100, 300, 200] }),
      notesInfo: () => ({
        result: [
          {
            noteId: 300,
            modelName: 'DenChou',
            deckName: 'DenChou',
            fields: {
              word: { value: '旧', order: 0 },
              sentence: { value: '<span class="group">旧しい</span>', order: 1 },
            },
            tags: ['entei'],
            cards: [1],
          },
        ],
      }),
      updateNoteFields: () => ({ result: { noteId: 300 } }),
      addTags: () => ({ result: null }),
    });
    const client = new AnkiExportClient(ENDPOINT, 'key-2');

    // --- findNotes('added:1') (PlayerApp.tsx ~4518) -----------------------
    const noteIds = await client.findNotes('added:1');
    expect(noteIds).toEqual([100, 300, 200]);
    const maxId = Math.max(...noteIds);
    expect(maxId).toBe(300);

    // --- notesInfo([maxId]) (PlayerApp.tsx ~4528) -------------------------
    const info = await client.notesInfo([maxId]);
    const candidate = info[0]!;
    // Model mismatch is a hard stop: updating a note of another type would
    // write DenChou field names into a card that has none of them.
    expect(candidate.modelName).toBe('DenChou');

    // --- updateNoteFields → addTags (anki-export-client ASB parity) ------
    await updateNoteFieldsAndAddTags(
      client,
      300,
      {
        word: '新',
        sentence: wrapDenChouField('sentence', '新しい'),
      },
      'entei mining',
    );

    expect(actions(calls)).toEqual([
      'findNotes',
      'notesInfo',
      'updateNoteFields',
      'addTags',
    ]);
    expect(paramsOf(calls, 'findNotes')).toEqual({ query: 'added:1' });
    expect(paramsOf(calls, 'notesInfo')).toEqual({ notes: [300] });
    expect(paramsOf(calls, 'updateNoteFields')).toEqual({
      note: {
        id: 300,
        fields: {
          word: '新',
          sentence: '<span class="group">新しい</span>',
        },
      },
    });
    expect(paramsOf(calls, 'addTags')).toEqual({
      notes: [300],
      tags: 'entei mining',
    });
    // Both write actions carry the same credential.
    expect(calls.at(-1)?.key).toBe('key-2');
  });

  it('stops before any write when the newest note is another model', async () => {
    const { calls } = installActionTable({
      findNotes: () => ({ result: [42] }),
      notesInfo: () => ({
        result: [
          {
            noteId: 42,
            modelName: 'Basic',
            deckName: 'Default',
            fields: { Front: { value: 'x', order: 0 } },
            tags: [],
          },
        ],
      }),
      updateNoteFields: () => ({ result: { noteId: 42 } }),
      addTags: () => ({ result: null }),
    });
    const client = new AnkiExportClient(ENDPOINT);
    const noteType = 'DenChou';

    const noteIds = await client.findNotes('added:1');
    const info = await client.notesInfo([Math.max(...noteIds)]);
    const candidate = info[0]!;
    if (candidate.modelName === noteType) {
      await updateNoteFieldsAndAddTags(client, candidate.noteId, {}, '');
    }

    expect(actions(calls)).toEqual(['findNotes', 'notesInfo']);
  });

  it('performs zero tag calls when the tag box is empty', async () => {
    const { calls } = installActionTable({
      updateNoteFields: () => ({ result: { noteId: 9 } }),
      addTags: () => ({ result: null }),
    });
    const client = new AnkiExportClient(ENDPOINT);

    await updateNoteFieldsAndAddTags(client, 9, { word: '猫' }, '   ');
    expect(actions(calls)).toEqual(['updateNoteFields']);
  });

  it('fails the whole update when adding tags fails (no partial success)', async () => {
    installActionTable({
      updateNoteFields: () => ({ result: { noteId: 9 } }),
      addTags: () => ({ error: 'tags are locked' }),
    });
    const client = new AnkiExportClient(ENDPOINT);

    const error = await exportRejection(
      updateNoteFieldsAndAddTags(client, 9, { word: '猫' }, 'entei'),
    );
    // ASB parity: the tag failure is NOT swallowed — the export counts as failed.
    expect(error).toBeInstanceOf(AnkiExportError);
    expect(error.code).toBe('server-error');
  });
});

/* ---------------------------------------------------------------------------
 * 6. Append flow
 * ------------------------------------------------------------------------- */

/**
 * Append one mapped field, exactly as PlayerApp composes it
 * (`components/player/PlayerApp.tsx`, append path ~4849–4870):
 *
 *   const skipBr = isDenChou && isDenChouActiveTarget(draft.key);
 *   if (isDenChou) incoming = wrapDenChouField(draft.key, incoming);
 *   updates[fieldName] = existing ? `${existing}${skipBr ? '' : '<br>'}${incoming}` : incoming;
 *
 * `isDenChouActiveTarget` / `wrapDenChouField` are the production primitives;
 * this helper only repeats the two append lines so a `<br>` regression in
 * PlayerApp has a counterpart here (see the SCOPE NOTE at the top of the file).
 */
function appendField(
  existing: string,
  incoming: string,
  options: { denChou: boolean; key: string },
): string {
  const skipBr = options.denChou && isDenChouActiveTarget(options.key);
  const value = options.denChou
    ? wrapDenChouField(options.key, incoming)
    : incoming;
  if (existing === '') return value;
  return skipBr ? `${existing}${value}` : `${existing}<br>${value}`;
}

describe('Append to existing cards — append-only composition', () => {
  it('wraps DenChou sentence/source in scene groups with no <br>', () => {
    // DenChou: the scene groups own the layout, so a <br> between scenes would
    // double the gap.
    expect(
      appendField('<span class="group">前の場面</span>', '次の場面', {
        denChou: true,
        key: 'sentence',
      }),
    ).toBe('<span class="group">前の場面</span><span class="group">次の場面</span>');

    // `source` (miscInfo) is the second scene target. Only the INCOMING scene is
    // wrapped — whatever the field already holds is left exactly as it is.
    expect(
      appendField('<span class="group">第1話</span>', '第2話', {
        denChou: true,
        key: 'source',
      }),
    ).toBe('<span class="group">第1話</span><span class="group">第2話</span>');
    // …including an unwrapped legacy value: it is never retro-wrapped.
    expect(
      appendField('第1話', '第2話', { denChou: true, key: 'source' }),
    ).toBe('第1話<span class="group">第2話</span>');

    // An EMPTY existing value is replaced by the wrapped scene (no leading <br>).
    expect(
      appendField('', '最初の場面', { denChou: true, key: 'sentence' }),
    ).toBe('<span class="group">最初の場面</span>');

    // DenChou fields that are NOT scene targets still get the separator and no wrap.
    expect(
      appendField('メモ1', 'メモ2', { denChou: true, key: 'notes' }),
    ).toBe('メモ1<br>メモ2');
    expect(wrapDenChouField('notes', 'メモ2')).toBe('メモ2');
    expect(isDenChouActiveTarget('notes')).toBe(false);
  });

  it('uses <br> and no wrapping for a non-DenChou note type', () => {
    expect(
      appendField('前の文', '次の文', { denChou: false, key: 'sentence' }),
    ).toBe('前の文<br>次の文');
    expect(appendField('', '唯一の文', { denChou: false, key: 'sentence' })).toBe(
      '唯一の文',
    );
  });

  it('appends media markup with <br>, never into the scene group', async () => {
    const { calls } = installActionTable({
      notesInfo: () => ({
        result: [
          {
            noteId: 77,
            modelName: 'DenChou',
            deckName: 'DenChou',
            fields: {
              sentence: {
                value: '<span class="group">既存</span>',
                order: 0,
              },
              picture: { value: '<img src="old.jpg">', order: 1 },
              sentenceAudio: { value: '[sound:old.webm]', order: 2 },
            },
            tags: [],
          },
        ],
      }),
      storeMediaFile: () => ({ result: 'file_999.jpg' }),
      updateNoteFields: () => ({ result: { noteId: 77 } }),
    });
    const client = new AnkiExportClient(ENDPOINT);

    const info = await client.notesInfo([77]);
    const note = info[0]!;
    const stored = await client.storeMediaFile('entei_screenshot_x.jpg', 'AAAA');
    const imageMarkup = buildMediaMarkup('image', 'entei_screenshot_x.jpg', stored, true);

    const updates: Record<string, string> = {};
    const existingSentence = note.fields.sentence?.value ?? '';
    updates.sentence = appendField(existingSentence, '新しい場面', {
      denChou: true,
      key: 'sentence',
    });
    const existingPicture = note.fields.picture?.value ?? '';
    // Media is never a scene target: always the <br> branch.
    updates.picture = existingPicture
      ? `${existingPicture}<br>${imageMarkup}`
      : imageMarkup;

    await client.updateNoteFields(77, updates);

    const fields = (paramsOf(calls, 'updateNoteFields').note as Record<string, unknown>)
      .fields as Record<string, string>;
    expect(fields.sentence).toBe(
      '<span class="group">既存</span><span class="group">新しい場面</span>',
    );
    expect(fields.picture).toBe('<img src="old.jpg"><br><img src="file_999.jpg">');
    // The audio field was not touched by this append (append-only, never wipe).
    expect(fields.sentenceAudio).toBeUndefined();
  });

  it('a tags-only note makes one addTags call and nothing else', async () => {
    const { calls } = installActionTable({ addTags: () => ({ result: null }) });
    const client = new AnkiExportClient(ENDPOINT);

    // No field was appended (empty incoming values) → ASB parity: the note's
    // success depends on the tag write alone.
    await addTagsOnlyIfAny(client, 77, 'entei');
    expect(actions(calls)).toEqual(['addTags']);
    expect(paramsOf(calls, 'addTags')).toEqual({ notes: [77], tags: 'entei' });

    // …and an empty tag box is a zero-API no-op.
    await addTagsOnlyIfAny(client, 77, '  ');
    expect(actions(calls)).toEqual(['addTags']);
  });
});

/* ---------------------------------------------------------------------------
 * 7. Yomitan Module Control
 * ------------------------------------------------------------------------- */

/** Build an upstream-style backup envelope around an options tree. */
function makeEnvelope(options: unknown): string {
  return JSON.stringify({
    version: 0,
    date: '2026-07-06 09:48:37',
    url: 'chrome-extension://abc123/options.html',
    manifest: { version: '1.0.0' },
    environment: { os: 'win' },
    permissions: {},
    options,
  });
}

/** The 23 DenChou field names this host ships. */
const DENCHOU_FIELD_NAMES = Object.keys(
  DEFAULT_CARD_FORMATS.find((format) => format.id === 'denchou')!.fields,
);

/** A backup tree whose active profile carries a full Yomitan `anki` block. */
function backupWithYomitanAnki(): Options {
  const tree = readYomitanOptions();
  const fields: Record<string, AnkiCardField> = {};
  for (const name of DENCHOU_FIELD_NAMES) {
    fields[name] = { value: `{${name}}`, overwriteMode: 'coalesce' };
  }
  const anki: AnkiOptions = {
    ...(tree.profiles[tree.profileCurrent]?.options.anki ??
      createDefaultAnkiOptions()),
    server: 'http://127.0.0.1:9999',
    apiKey: 'from-backup',
    duplicateScope: 'deck-root',
    duplicateScopeCheckAllModels: true,
    duplicateBehavior: 'prevent',
    suspendNewCards: true,
    noteGuiMode: 'browse',
    screenshot: { format: 'jpeg', quality: 90 },
    cardFormats: [
      {
        name: 'DenChou',
        icon: 'small-circle',
        type: 'term',
        deck: '日本語::DenChou',
        model: 'DenChou',
        fields,
      },
    ],
  };
  return {
    ...tree,
    profiles: tree.profiles.map((profile, index) =>
      index === tree.profileCurrent
        ? { ...profile, options: { ...profile.options, anki } }
        : profile,
    ),
  };
}

describe('Yomitan Module Control — the backup ↔ Anki Connection bridge', () => {
  it('carries deck, model and all 23 fields over when the control is ON', async () => {
    expect(DENCHOU_FIELD_NAMES.length).toBe(23);
    writeAnkiConnectionPreferences({
      ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
      yomitanModuleControl: true,
    });

    await importSettingsFromJson(makeEnvelope(backupWithYomitanAnki()));

    const prefs = readAnkiConnectionPreferences();
    expect(prefs.server).toBe('http://127.0.0.1:9999');
    expect(prefs.apiKey).toBe('from-backup');
    expect(prefs.duplicateScope).toBe('deck-root');
    expect(prefs.checkAllModels).toBe(true);
    // Yomitan's 'prevent' is this app's 'prevent'; 'browse' is 'browser'.
    expect(prefs.duplicateBehavior).toBe('prevent');
    expect(prefs.openNoteViewer).toBe('browser');
    expect(prefs.suspendNewCards).toBe(true);
    expect(prefs.screenshotFormat).toBe('jpeg');
    // The bridge stays wired: the switch it ran under is kept on.
    expect(prefs.yomitanModuleControl).toBe(true);

    const denchou = prefs.cardFormats.find((format) => format.id === 'denchou');
    expect(denchou?.deck).toBe('日本語::DenChou');
    expect(denchou?.model).toBe('DenChou');
    for (const name of DENCHOU_FIELD_NAMES) {
      expect(denchou?.fields[name]).toBe(`{${name}}`);
    }
  });

  it('never touches the Anki card when the control is OFF', async () => {
    const before = {
      ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
      server: 'http://127.0.0.1:8765',
      yomitanModuleControl: false as const,
    };
    writeAnkiConnectionPreferences(before);

    // Give the Yomitan tree a value the backup will change, so "the tree WAS
    // imported" is proven by the tree itself, not by an unrelated key.
    writeOptionPath(readYomitanOptions(), 'general.maxResults', 5);
    const backup = backupWithYomitanAnki();
    const incoming: Options = {
      ...backup,
      profiles: backup.profiles.map((profile, index) =>
        index === backup.profileCurrent
          ? {
              ...profile,
              options: {
                ...profile.options,
                general: { ...profile.options.general, maxResults: 11 },
              },
            }
          : profile,
      ),
    };

    await importSettingsFromJson(makeEnvelope(incoming));

    const prefs = readAnkiConnectionPreferences();
    expect(prefs.server).toBe('http://127.0.0.1:8765');
    expect(prefs.apiKey).toBe('');
    expect(prefs.duplicateScope).toBe('collection');
    expect(prefs.suspendNewCards).toBe(false);
    expect(prefs.yomitanModuleControl).toBe(false);
    // The Yomitan tree itself WAS imported — only the Anki card is untouched.
    expect(localStorage.getItem(ANKI_CONNECTION_PREFS_KEY)).not.toBeNull();
    const tree = readYomitanOptions();
    expect(tree.profiles[tree.profileCurrent]?.options.general.maxResults).toBe(
      11,
    );
  });

  it('restores the Anki defaults on reset while keeping the switch ON', async () => {
    writeAnkiConnectionPreferences({
      ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
      server: 'http://127.0.0.1:9999',
      apiKey: 'stale',
      yomitanModuleControl: true,
    });

    await resetSettings();

    const prefs = readAnkiConnectionPreferences();
    expect(prefs.server).toBe(DEFAULT_ANKI_CONNECTION_PREFERENCES.server);
    expect(prefs.apiKey).toBe('');
    expect(prefs.yomitanModuleControl).toBe(true);
  });

  it('leaves the Anki card alone on reset when the control is OFF', async () => {
    writeAnkiConnectionPreferences({
      ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
      server: 'http://127.0.0.1:9999',
      yomitanModuleControl: false,
    });

    await resetSettings();

    expect(readAnkiConnectionPreferences().server).toBe('http://127.0.0.1:9999');
  });
});
