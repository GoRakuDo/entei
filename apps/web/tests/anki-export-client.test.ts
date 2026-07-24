/**
 * Unit tests for AnkiExportClient — Stage 2 write surface.
 * ---------------------------------------------------------------------------
 * - Every action sends exact request shape (action, version, params, key)
 * - Successful result parsing
 * - Malformed response → AnkiExportError
 * - HTTP error → AnkiExportError
 * - Action error (API key / permission / generic) → AnkiExportError
 * - Abort → AnkiExportError 'aborted'
 * - Network error → AnkiExportError 'network'
 * - blobToBase64 helper
 * - generateMediaFilename helper
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AnkiExportClient,
  AnkiExportError,
  blobToBase64,
  generateMediaFilename,
  type AnkiNoteField,
} from '@/features/player/anki-export-client';

function mockFetchResponse(
  result: unknown = null,
  error: string | null = null,
  ok = true,
  status = 200,
): Response {
  return {
    ok,
    status,
    statusText: 'OK',
    json: () => Promise.resolve({ result, error }),
  } as unknown as Response;
}

const sampleNote: AnkiNoteField = {
  deckName: 'Test Deck',
  modelName: 'Basic',
  fields: { Front: 'hello', Back: 'world' },
  tags: ['test'],
};

const sampleNoteWithDupOptions: AnkiNoteField = {
  deckName: 'Test Deck',
  modelName: 'Basic',
  fields: { Front: 'hello', Back: 'world' },
  tags: ['test'],
  options: {
    allowDuplicate: true,
    duplicateScope: 'deck',
    duplicateScopeOptions: {
      deckName: 'Test Deck',
      checkChildren: false,
    },
  },
};

describe('AnkiExportClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(mockFetchResponse());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('canAddNotes', () => {
    it('sends correct request shape with direct note objects (no nested wrapper)', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse([true]));
      const client = new AnkiExportClient('http://test:8765', 'secret-key');
      await client.canAddNotes([sampleNote]);

      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse(call![1].body as string);
      expect(body.action).toBe('canAddNotes');
      expect(body.version).toBe(6);
      expect(body.key).toBe('secret-key');
      expect(body.params.notes).toHaveLength(1);
      // CRITICAL: notes[0] must be the note object directly,
      // NOT wrapped in { note: ... } — that is the AnkiConnect contract.
      expect(body.params.notes[0].deckName).toBe('Test Deck');
      expect(body.params.notes[0].modelName).toBe('Basic');
      expect(body.params.notes[0].fields.Front).toBe('hello');
      expect(body.params.notes[0].tags).toEqual(['test']);
      // Regression: must NOT have a nested `note` key
      expect(body.params.notes[0].note).toBeUndefined();
    });

    it('parses boolean array result', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse([true, false]));
      const client = new AnkiExportClient();
      const result = await client.canAddNotes([sampleNote, sampleNote]);
      expect(result).toEqual([true, false]);
    });

    it('regression: nested `note` wrapper would fail but direct payload succeeds', async () => {
      // Simulate AnkiConnect: returns [true] for correct (direct) payload,
      // returns [false] for the old wrong (nested wrapper) payload.
      fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const firstNote = body.params?.notes?.[0];
        // If the payload has the nested `note` wrapper, AnkiConnect would
        // not see deckName/modelName at top level and reject the note.
        const hasNestedWrapper =
          firstNote && typeof firstNote.note === 'object';
        const result = hasNestedWrapper ? [false] : [true];
        return mockFetchResponse(result);
      });

      const client = new AnkiExportClient();
      const result = await client.canAddNotes([sampleNote]);
      expect(result).toEqual([true]);
    });

    it('passes options through in canAddNotes payload', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse([true]));
      const client = new AnkiExportClient();
      await client.canAddNotes([sampleNoteWithDupOptions]);

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      expect(body.params.notes[0].options).toEqual({
        allowDuplicate: true,
        duplicateScope: 'deck',
        duplicateScopeOptions: {
          deckName: 'Test Deck',
          checkChildren: false,
        },
      });
    });
  });

  describe('addNote', () => {
    it('sends correct request shape', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse(1234567890));
      const client = new AnkiExportClient();
      const result = await client.addNote(sampleNote);

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      expect(body.action).toBe('addNote');
      expect(body.params.note.deckName).toBe('Test Deck');
      expect(result).toBe(1234567890);
    });

    it('does not include key when no API key provided', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse(1));
      const client = new AnkiExportClient();
      await client.addNote(sampleNote);

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      expect(body.key).toBeUndefined();
    });

    it('passes options through in addNote wrapped note payload', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse(1234567890));
      const client = new AnkiExportClient();
      await client.addNote(sampleNoteWithDupOptions);

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      expect(body.action).toBe('addNote');
      expect(body.params.note.options).toEqual({
        allowDuplicate: true,
        duplicateScope: 'deck',
        duplicateScopeOptions: {
          deckName: 'Test Deck',
          checkChildren: false,
        },
      });
    });
  });

  describe('storeMediaFile', () => {
    it('sends correct request shape', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse('entei_audio_test.webm'));
      const client = new AnkiExportClient();
      const result = await client.storeMediaFile('test.webm', 'base64data');

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      expect(body.action).toBe('storeMediaFile');
      expect(body.params.filename).toBe('test.webm');
      expect(body.params.data).toBe('base64data');
      expect(result).toBe('entei_audio_test.webm');
    });
  });

  describe('findNotes', () => {
    it('sends correct request shape', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse([100, 200, 300]));
      const client = new AnkiExportClient();
      const result = await client.findNotes('added:1');

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      expect(body.action).toBe('findNotes');
      expect(body.params.query).toBe('added:1');
      expect(result).toEqual([100, 200, 300]);
    });
  });

  describe('notesInfo', () => {
    it('sends correct request shape and parses result', async () => {
      const mockInfo = [
        {
          noteId: 100,
          modelName: 'Basic',
          deckName: 'Default',
          fields: { Front: { value: 'hello', order: 0 } },
          tags: ['tag'],
        },
      ];
      fetchSpy.mockResolvedValue(mockFetchResponse(mockInfo));
      const client = new AnkiExportClient();
      const result = await client.notesInfo([100]);

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      expect(body.action).toBe('notesInfo');
      expect(body.params.notes).toEqual([100]);
      expect(result[0]!.noteId).toBe(100);
      expect(result[0]!.modelName).toBe('Basic');
      expect(result[0]!.fields['Front']!.value).toBe('hello');
    });
  });

  describe('updateNoteFields', () => {
    it('sends correct request shape', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({ noteId: 100 }));
      const client = new AnkiExportClient();
      const result = await client.updateNoteFields(100, { Front: 'updated' });

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      expect(body.action).toBe('updateNoteFields');
      expect(body.params.note.id).toBe(100);
      expect(body.params.note.fields.Front).toBe('updated');
      expect(result).toEqual({ noteId: 100 });
    });
  });

  describe('error handling', () => {
    it('throws AnkiExportError on HTTP error', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse(null, null, false, 500));
      const client = new AnkiExportClient();
      await expect(client.addNote(sampleNote)).rejects.toThrow(AnkiExportError);
      await expect(client.addNote(sampleNote)).rejects.toMatchObject({
        code: 'server-error',
      });
    });

    it('throws AnkiExportError on malformed response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ unexpected: true }),
      } as unknown as Response);
      const client = new AnkiExportClient();
      await expect(client.addNote(sampleNote)).rejects.toMatchObject({
        code: 'invalid-response',
      });
    });

    it('throws AnkiExportError on invalid JSON', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new SyntaxError('Invalid JSON')),
      } as unknown as Response);
      const client = new AnkiExportClient();
      await expect(client.addNote(sampleNote)).rejects.toMatchObject({
        code: 'invalid-response',
      });
    });

    it('throws api-key-required on API key error', async () => {
      fetchSpy.mockResolvedValue(
        mockFetchResponse(null, 'API key is required'),
      );
      const client = new AnkiExportClient();
      await expect(client.addNote(sampleNote)).rejects.toMatchObject({
        code: 'api-key-required',
      });
    });

    it('throws permission-denied on permission error', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse(null, 'permission denied'));
      const client = new AnkiExportClient();
      await expect(client.addNote(sampleNote)).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    it('throws server-error on generic action error', async () => {
      fetchSpy.mockResolvedValue(
        mockFetchResponse(null, 'Some AnkiConnect error'),
      );
      const client = new AnkiExportClient();
      await expect(client.addNote(sampleNote)).rejects.toMatchObject({
        code: 'server-error',
      });
    });

    it('throws aborted on AbortSignal', async () => {
      const controller = new AbortController();
      controller.abort();
      fetchSpy.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
      const client = new AnkiExportClient();
      await expect(
        client.addNote(sampleNote, controller.signal),
      ).rejects.toMatchObject({ code: 'aborted' });
    });

    it('throws network on fetch failure', async () => {
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
      const client = new AnkiExportClient();
      await expect(client.addNote(sampleNote)).rejects.toMatchObject({
        code: 'network',
      });
    });
  });
});

describe('blobToBase64', () => {
  it('converts a Blob to base64 string', async () => {
    const blob = new Blob(['test'], { type: 'text/plain' });
    const result = await blobToBase64(blob);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('generateMediaFilename', () => {
  it('generates a filename with prefix and extension', () => {
    const name = generateMediaFilename('entei_screenshot', 'jpg');
    expect(name).toMatch(/^entei_screenshot_[a-z0-9]+_[a-z0-9]+\.jpg$/);
  });

  it('sanitizes unsafe characters in prefix', () => {
    const name = generateMediaFilename('entei/../screenshot', 'jpg');
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
  });

  it('sanitizes unsafe characters in extension', () => {
    const name = generateMediaFilename('test', 'webm;malicious');
    expect(name).toMatch(/\.webmmalicious$/);
  });
});
