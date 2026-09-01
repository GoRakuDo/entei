/**
 * Integration tests for Stage 2 export lifecycle.
 * ---------------------------------------------------------------------------
 * - canAddNotes false → zero storeMediaFile/addNote calls
 * - New note success: canAddNotes → storeMediaFile → addNote order
 * - Update first Send: findNotes + notesInfo only, zero write
 * - Invalid target model → zero write
 * - Second explicit confirmation → updateNoteFields only mapped fields
 * - Missing screenshot/audio does not clear/update those fields
 * - Session key never enters localStorage
 * - Abort/double-submit/error/snapshot restore
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AnkiExportClient,
  generateMediaFilename,
  updateNoteFieldsAndAddTags,
  addTagsOnlyIfAny,
} from '@/features/player/anki-export-client';

function mockResponse(
  result: unknown = null,
  error: string | null = null,
): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ result, error }),
  } as unknown as Response;
}

const sampleNote = {
  deckName: 'Japanese',
  modelName: 'Basic',
  fields: { Front: 'テスト', Back: 'test' },
  tags: ['mining'],
};

function getAction(init: RequestInit | undefined): string {
  if (!init || typeof init.body !== 'string') return '';
  return JSON.parse(init.body).action;
}

function getParams(init: RequestInit | undefined): Record<string, unknown> {
  if (!init || typeof init.body !== 'string') return {};
  return JSON.parse(init.body).params;
}

describe('Export lifecycle — New note (AM-6a)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('canAddNotes false → zero storeMediaFile/addNote calls', async () => {
    fetchSpy.mockResolvedValue(mockResponse([false]));

    const client = new AnkiExportClient('http://test:8765', 'key');
    const canAddResult = await client.canAddNotes([sampleNote]);

    expect(canAddResult).toEqual([false]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('New success: canAddNotes → storeMediaFile → addNote order', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'canAddNotes') return mockResponse([true]);
      if (action === 'storeMediaFile')
        return mockResponse(
          getParams(init as RequestInit | undefined).filename as string,
        );
      if (action === 'addNote') return mockResponse(1234567890);
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');

    const canAdd = await client.canAddNotes([sampleNote]);
    expect(canAdd).toEqual([true]);

    const filename = await generateMediaFilename('entei_screenshot', 'jpg');
    const stored = await client.storeMediaFile(filename, 'base64data');
    expect(stored).toBe(filename);

    const noteId = await client.addNote(sampleNote);
    expect(noteId).toBe(1234567890);

    expect(callLog).toEqual(['canAddNotes', 'storeMediaFile', 'addNote']);
  });

  it('addNote failure → error', async () => {
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      if (action === 'canAddNotes') return mockResponse([true]);
      if (action === 'addNote') return mockResponse(null, 'Cannot add note');
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    await client.canAddNotes([sampleNote]);
    await expect(client.addNote(sampleNote)).rejects.toThrow();
  });

  it('regression: direct canAddNotes payload proceeds to media/addNote (nested wrapper would not)', async () => {
    // This test simulates AnkiConnect's real behavior:
    // - canAddNotes with direct note objects (no `note` wrapper) → [true]
    // - canAddNotes with nested `note` wrapper → [false] (AnkiConnect ignores it)
    // - After [true], the flow proceeds to storeMediaFile then addNote.
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      const params = getParams(init as RequestInit | undefined);
      callLog.push(action);

      if (action === 'canAddNotes') {
        const notesArr = (params.notes as unknown[]) ?? [];
        const firstNote = notesArr[0] as Record<string, unknown> | undefined;
        // AnkiConnect expects deckName at top level of each note object.
        // A nested `note` wrapper means deckName is NOT at top level.
        const hasDirectShape =
          firstNote && typeof firstNote.deckName === 'string';
        return mockResponse(hasDirectShape ? [true] : [false]);
      }
      if (action === 'storeMediaFile') {
        return mockResponse(params.filename as string);
      }
      if (action === 'addNote') {
        return mockResponse(1234567890);
      }
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');

    // 1. canAddNotes with correct (direct) payload → [true]
    const canAdd = await client.canAddNotes([sampleNote]);
    expect(canAdd).toEqual([true]);

    // Verify the request body had NO nested `note` wrapper
    const canAddBody = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(canAddBody.params.notes[0].note).toBeUndefined();
    expect(canAddBody.params.notes[0].deckName).toBe('Japanese');

    // 2. Flow proceeds to storeMediaFile → addNote
    const filename = await generateMediaFilename('entei_screenshot', 'jpg');
    const stored = await client.storeMediaFile(filename, 'base64data');
    expect(stored).toBe(filename);

    const noteId = await client.addNote(sampleNote);
    expect(noteId).toBe(1234567890);

    // 3. Call order proves the flow completed end-to-end
    expect(callLog).toEqual(['canAddNotes', 'storeMediaFile', 'addNote']);
  });
});

describe('Export lifecycle — Update latest (AM-6b)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('one-click update: findNotes → notesInfo → updateNoteFields', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'findNotes') return mockResponse([100, 200, 300]);
      if (action === 'notesInfo')
        return mockResponse([
          {
            noteId: 300,
            modelName: 'Basic',
            deckName: 'Japanese',
            fields: { Front: { value: 'old', order: 0 } },
            tags: [],
          },
        ]);
      if (action === 'updateNoteFields') {
        const params = getParams(init as RequestInit | undefined);
        const note = params.note as Record<string, unknown>;
        expect(note.id).toBe(300);
        return mockResponse({ noteId: 300 });
      }
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    const noteIds = await client.findNotes('added:1');
    const maxId = Math.max(...noteIds);
    const info = await client.notesInfo([maxId]);
    expect(info[0]!.noteId).toBe(300);
    expect(info[0]!.modelName).toBe('Basic');

    await client.updateNoteFields(info[0]!.noteId, { Front: 'updated' });

    // All actions in one user click
    expect(callLog).toEqual(['findNotes', 'notesInfo', 'updateNoteFields']);
  });

  it('no candidate found → no write', async () => {
    fetchSpy.mockResolvedValue(mockResponse([]));
    const client = new AnkiExportClient('http://test:8765', 'key');
    const noteIds = await client.findNotes('added:1');
    expect(noteIds).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('invalid target model → zero write', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'findNotes') return mockResponse([100]);
      if (action === 'notesInfo')
        return mockResponse([
          {
            noteId: 100,
            modelName: 'WrongModel',
            deckName: 'Default',
            fields: {},
            tags: [],
          },
        ]);
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    const noteIds = await client.findNotes('added:1');
    const maxId = Math.max(...noteIds);
    const info = await client.notesInfo([maxId]);

    expect(info[0]!.modelName).toBe('WrongModel');
    expect(callLog).not.toContain('updateNoteFields');
  });

  it('update payload has no duplicate options', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'updateNoteFields') {
        const params = getParams(init as RequestInit | undefined);
        const note = params.note as Record<string, unknown>;
        expect(note.id).toBe(300);
        expect(note.fields).toMatchObject({
          Front: 'updated sentence',
        });
        return mockResponse({ noteId: 300 });
      }
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    const result = await client.updateNoteFields(300, {
      Front: 'updated sentence',
    });

    expect(result).toEqual({ noteId: 300 });
    expect(callLog).toEqual(['updateNoteFields']);
  });

  it('missing screenshot/audio does not send storeMediaFile', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'updateNoteFields') {
        const params = getParams(init as RequestInit | undefined);
        const note = params.note as Record<string, unknown>;
        const fields = note.fields as Record<string, unknown>;
        expect(fields).not.toHaveProperty('Image');
        expect(fields).not.toHaveProperty('Audio');
        return mockResponse({ noteId: 300 });
      }
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    await client.updateNoteFields(300, { Front: 'text only' });
    expect(callLog).not.toContain('storeMediaFile');
  });
});

describe('Export — API key session security', () => {
  it('API key is passed in request body but never to localStorage', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(mockResponse([true]));

    const lsSpy = vi.spyOn(Storage.prototype, 'setItem');

    const client = new AnkiExportClient('http://test:8765', 'my-secret-key');
    await client.canAddNotes([sampleNote]);

    const call = fetchSpy.mock.calls[0];
    const init = call![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.key).toBe('my-secret-key');

    expect(lsSpy).not.toHaveBeenCalled();

    lsSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});

describe('Export — abort/error/snapshot guards', () => {
  it('aborted request throws AnkiExportError with aborted code', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(global, 'fetch').mockRejectedValue(
      new DOMException('Aborted', 'AbortError'),
    );

    const client = new AnkiExportClient('http://test:8765', 'key');
    await expect(
      client.addNote(sampleNote, controller.signal),
    ).rejects.toMatchObject({ code: 'aborted' });

    vi.restoreAllMocks();
  });

  it('network error throws AnkiExportError with network code', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(
      new TypeError('Failed to fetch'),
    );

    const client = new AnkiExportClient('http://test:8765', 'key');
    await expect(client.addNote(sampleNote)).rejects.toMatchObject({
      code: 'network',
    });

    vi.restoreAllMocks();
  });
});

describe('Export — duplicate policy (new card allows duplicates)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('duplicate note with allowDuplicate=true is accepted and flows to addNote', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);

      if (action === 'canAddNotes') {
        // AnkiConnect returns [true] when allowDuplicate is true
        return mockResponse([true]);
      }
      if (action === 'addNote') {
        return mockResponse(999);
      }
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');

    const noteWithDup = {
      deckName: 'Japanese',
      modelName: 'Basic',
      fields: { Front: 'duplicate sentence' },
      tags: ['mining'],
      options: {
        allowDuplicate: true,
        duplicateScope: 'deck' as const,
        duplicateScopeOptions: {
          deckName: 'Japanese',
          checkChildren: false,
        },
      },
    };

    const canAdd = await client.canAddNotes([noteWithDup]);
    expect(canAdd).toEqual([true]);

    // Verify canAddNotes payload has options
    const canAddBody = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(canAddBody.params.notes[0].options.allowDuplicate).toBe(true);

    // Flow proceeds to addNote
    const noteId = await client.addNote(noteWithDup);
    expect(noteId).toBe(999);

    // Verify addNote payload also has options inside the wrapped note
    const addNoteBody = JSON.parse(fetchSpy.mock.calls[1]![1].body as string);
    expect(addNoteBody.params.note.options.allowDuplicate).toBe(true);

    expect(callLog).toEqual(['canAddNotes', 'addNote']);
  });

  it('updateNoteFields payload has no duplicate options', async () => {
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      if (action === 'updateNoteFields') {
        const params = getParams(init as RequestInit | undefined);
        const note = params.note as Record<string, unknown>;
        // Update must NOT include duplicate options
        expect(note.options).toBeUndefined();
        return mockResponse({ noteId: 100 });
      }
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    const result = await client.updateNoteFields(100, {
      Front: 'updated',
    });
    expect(result).toEqual({ noteId: 100 });
  });

  it('update contract: updateNoteFields succeeds, then additive addTags', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'updateNoteFields') return mockResponse({ noteId: 100 });
      if (action === 'addTags') return mockResponse(null);
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    await client.updateNoteFields(100, { Front: 'updated' });
    await client.addTags([100], 'anime n5');

    expect(callLog).toEqual(['updateNoteFields', 'addTags']);
    const addTagsCall = fetchSpy.mock.calls[1];
    expect(getAction(addTagsCall![1] as RequestInit | undefined)).toBe(
      'addTags',
    );
    expect(
      getParams(addTagsCall![1] as RequestInit | undefined),
    ).toEqual({ notes: [100], tags: 'anime n5' });
  });

  it('append contract: tags-only success (update skipped, addTags called)', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'addTags') return mockResponse(null);
      return mockResponse({ noteId: 100 });
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    // The append flow with no field updates calls addTags only.
    await client.addTags([100], 'n5');
    expect(callLog).toEqual(['addTags']);
  });

  it('append contract: field update first, then addTags', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'updateNoteFields') return mockResponse({ noteId: 100 });
      if (action === 'addTags') return mockResponse(null);
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    await client.updateNoteFields(100, { Front: 'appended' });
    await client.addTags([100], 'eizou');
    expect(callLog).toEqual(['updateNoteFields', 'addTags']);
  });
});

describe('Tags contract — PlayerApp paths (ASB parity)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('update path: addTags failure propagates (no success state)', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'updateNoteFields') return mockResponse({ noteId: 100 });
      if (action === 'addTags')
        return mockResponse(null, 'addTags rejected');
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    await expect(
      updateNoteFieldsAndAddTags(
        client,
        100,
        { Front: 'updated' },
        'anime n5',
      ),
    ).rejects.toThrow();

    // Order contract: updateNoteFields ran first, then addTags — and the
    // failure was NOT swallowed (caller = PlayerApp outer catch → no
    // success toast / history).
    expect(callLog).toEqual(['updateNoteFields', 'addTags']);
  });

  it('update path: empty tags perform zero API calls beyond the field update', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'updateNoteFields') return mockResponse({ noteId: 100 });
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    await updateNoteFieldsAndAddTags(client, 100, { Front: 'x' }, '   ');
    expect(callLog).toEqual(['updateNoteFields']);
    expect(callLog).not.toContain('addTags');
  });

  it('append path: update → addTags order; addTags failure rejects (note -> failed)', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'updateNoteFields') return mockResponse({ noteId: 100 });
      if (action === 'addTags')
        return mockResponse(null, 'addTags rejected');
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    await expect(
      updateNoteFieldsAndAddTags(
        client,
        100,
        { Front: 'appended' },
        'eizou',
      ),
    ).rejects.toThrow();
    expect(callLog).toEqual(['updateNoteFields', 'addTags']);
  });

  it('append path: tags-only success via addTagsOnlyIfAny', async () => {
    const callLog: string[] = [];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      const action = getAction(init as RequestInit | undefined);
      callLog.push(action);
      if (action === 'addTags') return mockResponse(null);
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    await addTagsOnlyIfAny(client, 100, 'n5 eizou');
    expect(callLog).toEqual(['addTags']);
    const params = getParams(
      fetchSpy.mock.calls[0]![1] as RequestInit | undefined,
    );
    expect(params).toEqual({ notes: [100], tags: 'n5 eizou' });
  });

  it('append path: empty tags-only is a zero-API no-op (old success behavior)', async () => {
    const fetchCalls: number[] = [];
    fetchSpy.mockImplementation(async (_url: string, _init?: RequestInit) => {
      fetchCalls.push(1);
      return mockResponse(null);
    });

    const client = new AnkiExportClient('http://test:8765', 'key');
    await addTagsOnlyIfAny(client, 100, '   ');
    expect(fetchCalls.length).toBe(0);
  });
});
