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
  buildMediaMarkup,
  detectAnkiDroidMode,
  generateMediaFilename,
  _resetAnkiDroidModeCache,
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
  describe('addTags', () => {
    it('sends exact request shape: action addTags, params {notes, tags}, result null', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse(null));
      const client = new AnkiExportClient('http://test:8765', 'secret-key');
      await client.addTags([123, 456], 'anime n5 eizou');

      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse(call![1].body as string);
      expect(body.action).toBe('addTags');
      expect(body.version).toBe(6);
      expect(body.key).toBe('secret-key');
      expect(body.params).toEqual({
        notes: [123, 456],
        tags: 'anime n5 eizou',
      });
    });

    it('forwards abort signal and parses null result', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse(null));
      const client = new AnkiExportClient();
      const controller = new AbortController();
      const result = await client.addTags([1], 'tag', controller.signal);
      expect(result).toBeNull();
      const call = fetchSpy.mock.calls[0];
      expect(call![1].signal).toBe(controller.signal);
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
  it('generates a content-addressed filename when a blob is provided', async () => {
    const blob = new Blob(['some payload'], { type: 'video/webm' });
    const name = await generateMediaFilename('entei_screenshot', 'jpg', blob);
    // Format: <safePrefix>_<10 hex chars>.<safeExt>
    expect(name).toMatch(/^entei_screenshot_[0-9a-f]{10}\.jpg$/);
  });

  it('falls back to a non-deterministic name when no blob is provided', async () => {
    const name = await generateMediaFilename('entei_screenshot', 'jpg');
    expect(name).toMatch(/^entei_screenshot_[a-z0-9]+_[a-z0-9]+\.jpg$/);
  });

  it('is deterministic: same blob bytes → same filename (idempotent re-export)', async () => {
    const blobA = new Blob(['identical-bytes'], { type: 'video/webm' });
    const blobB = new Blob(['identical-bytes'], { type: 'video/webm' });
    const nameA = await generateMediaFilename('entei_video', 'webm', blobA);
    const nameB = await generateMediaFilename('entei_video', 'webm', blobB);
    expect(nameA).toBe(nameB);
  });

  it('is collision-resistant: different blob bytes → different filenames', async () => {
    const blobA = new Blob(['payload-aaaa'], { type: 'video/webm' });
    const blobB = new Blob(['payload-bbbb'], { type: 'video/webm' });
    const nameA = await generateMediaFilename('entei_audio', 'webm', blobA);
    const nameB = await generateMediaFilename('entei_audio', 'webm', blobB);
    expect(nameA).not.toBe(nameB);
  });

  it('sanitizes unsafe characters in prefix', async () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const name = await generateMediaFilename(
      'entei/../screenshot',
      'jpg',
      blob,
    );
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
    // Safe prefix chars are [a-zA-Z0-9_-]; unsafe chars collapse to '_'.
    // 'entei/../screenshot' → 'entei____screenshot' (each '/', '.', '.'
    // becomes '_'), then + '_' separator + 10 hex chars + '.jpg'.
    expect(name).toMatch(/^entei_+screenshot_[0-9a-f]{10}\.jpg$/);
    // No raw unsafe chars survive:
    expect(name).toMatch(/^[a-zA-Z0-9_]+\.[a-zA-Z0-9]+$/);
  });

  it('sanitizes unsafe characters in extension', async () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const name = await generateMediaFilename('test', 'webm;malicious', blob);
    expect(name).toMatch(/\.webmmalicious$/);
  });
});

describe('buildMediaMarkup', () => {
  it('PC mode (ankiDroidMode=false): markup uses the input deterministic filename (regression)', () => {
    // PC AnkiConnect stores storeMediaFile's input name as-is. Markup keeps
    // using the caller-provided filename — NO change vs pre-fix behavior.
    expect(
      buildMediaMarkup(
        'sound',
        'entei_audio_abc123.webm',
        'file_999.webm',
        false,
      ),
    ).toBe('[sound:entei_audio_abc123.webm]');
    expect(
      buildMediaMarkup(
        'image',
        'entei_screenshot_abc123.jpg',
        'file_999.jpg',
        false,
      ),
    ).toBe('<img src="entei_screenshot_abc123.jpg">');
    expect(
      buildMediaMarkup(
        'video',
        'entei_video_abc123.webm',
        'file_999.webm',
        false,
      ),
    ).toBe(
      '<video autoplay loop muted playsinline src="entei_video_abc123.webm"></video>',
    );
  });

  it('AnkiDroid mode (ankiDroidMode=true): markup uses the RETURN value of storeMediaFile (the fix)', () => {
    // AnkiconnectAndroid normalizes/dedupes: returns file_<n>.ext regardless of
    // input name. The input filename does NOT exist in collection.media, so
    // markup MUST use the stored name — this is the original bug fix.
    expect(
      buildMediaMarkup(
        'sound',
        'entei_audio_abc123.webm',
        'file_123456789.webm',
        true,
      ),
    ).toBe('[sound:file_123456789.webm]');
    expect(
      buildMediaMarkup(
        'image',
        'entei_screenshot_abc123.jpg',
        'file_555555555.jpg',
        true,
      ),
    ).toBe('<img src="file_555555555.jpg">');
    expect(
      buildMediaMarkup(
        'video',
        'entei_video_abc123.webm',
        'file_777777777.webm',
        true,
      ),
    ).toBe(
      '<video autoplay loop muted playsinline src="file_777777777.webm"></video>',
    );
  });

  it('PC mode ignores storedName even when it differs from input (regression: PC keeps original wire shape)', () => {
    // If a caller (or mock) returns a different name from storeMediaFile, PC
    // mode still uses the input filename. This locks down the wire shape
    // contract for PC users.
    expect(
      buildMediaMarkup('sound', 'clip_input.webm', 'clip_stored.webm', false),
    ).toBe('[sound:clip_input.webm]');
  });

  it('AnkiDroid: real stored name (file_<num>.<ext>) is used as-is', () => {
    // AnkiconnectAndroid normalizes/dedupes to file_<num>.<ext>. That
    // matches [A-Za-z0-9._-]+, so it passes through unchanged.
    expect(
      buildMediaMarkup(
        'sound',
        'entei_audio_abc123.webm',
        'file_123.webm',
        true,
      ),
    ).toBe('[sound:file_123.webm]');
  });

  it('AnkiDroid: stored name with a space → falls back to the deterministic input filename', () => {
    expect(
      buildMediaMarkup(
        'sound',
        'entei_audio_abc123.webm',
        'file 123.webm',
        true,
      ),
    ).toBe('[sound:entei_audio_abc123.webm]');
  });

  it('AnkiDroid: stored name with a quote → falls back to the deterministic input filename', () => {
    expect(
      buildMediaMarkup(
        'image',
        'entei_screenshot_abc.jpg',
        'file";injected.jpg',
        true,
      ),
    ).toBe('<img src="entei_screenshot_abc.jpg">');
  });
});

describe('detectAnkiDroidMode', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('PC: apiReflect returns { actions: [...] } → PC mode (false)', async () => {
    // Official PC AnkiConnect apiReflect echoes back an object whose
    // `actions` field is an Array (FooSoft plugin/__init__.py:1965-1985).
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ scopes: ['actions'], actions: ['addNote', 'findNotes'] }),
    );
    const client = new AnkiExportClient();
    const result = await detectAnkiDroidMode(client);
    expect(result).toBe(false);

    // The probe must be exactly apiReflect with { scopes: ['actions'] }
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.action).toBe('apiReflect');
    expect(body.params).toEqual({ scopes: ['actions'] });

    _resetAnkiDroidModeCache(client);
  });

  it('AnkiDroid: apiReflect returns the default_version string → AnkiDroid mode (true)', async () => {
    // AnkiconnectAndroid does NOT implement apiReflect; its findRoute
    // falls through to default_version(), so for version 6 the wire
    // response is { "result":"AnkiConnect v.6", "error":null } — a
    // HTTP 200 string result, NOT a thrown error.
    fetchSpy.mockResolvedValue(mockFetchResponse('AnkiConnect v.6'));
    const client = new AnkiExportClient();
    const result = await detectAnkiDroidMode(client);
    expect(result).toBe(true);
    _resetAnkiDroidModeCache(client);
  });

  it('AnkiDroid: apiReflect returns {} (object without actions) → AnkiDroid mode (true)', async () => {
    // Defensive: a future PC implementation that returns an object
    // without an `actions` array would also be treated as AnkiDroid.
    fetchSpy.mockResolvedValue(mockFetchResponse({}));
    const client = new AnkiExportClient();
    const result = await detectAnkiDroidMode(client);
    expect(result).toBe(true);
    _resetAnkiDroidModeCache(client);
  });

  it('AnkiDroid: apiReflect throws (server error / unsupported action) → AnkiDroid mode (true)', async () => {
    // Some bridge versions may surface an action error for apiReflect;
    // we still treat that as AnkiDroid.
    fetchSpy.mockResolvedValue(
      mockFetchResponse(null, 'unsupported action: apiReflect'),
    );
    const client = new AnkiExportClient();
    const result = await detectAnkiDroidMode(client);
    expect(result).toBe(true);
    _resetAnkiDroidModeCache(client);
  });

  it('AnkiDroid: apiReflect network error → AnkiDroid mode (true)', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new AnkiExportClient();
    const result = await detectAnkiDroidMode(client);
    expect(result).toBe(true);
    _resetAnkiDroidModeCache(client);
  });

  it('caches the result: second call does NOT hit the network again', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ scopes: ['actions'], actions: [] }),
    );
    const client = new AnkiExportClient();
    const first = await detectAnkiDroidMode(client);
    const second = await detectAnkiDroidMode(client);
    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    _resetAnkiDroidModeCache(client);
  });

  it('caches across multiple clients independently (per-client cache)', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ scopes: ['actions'], actions: [] }),
    );
    const clientA = new AnkiExportClient('http://a:8765');
    const clientB = new AnkiExportClient('http://b:8765');
    await detectAnkiDroidMode(clientA);
    await detectAnkiDroidMode(clientB);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    _resetAnkiDroidModeCache(clientA);
    _resetAnkiDroidModeCache(clientB);
  });
});

describe('apiReflect', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends correct request shape (action apiReflect, version 6, no key by default)', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse({ echoed: true }));
    const client = new AnkiExportClient();
    const result = await client.apiReflect<{ echoed: boolean }>({
      scopes: ['actions'],
    });
    expect(result.echoed).toBe(true);

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.action).toBe('apiReflect');
    expect(body.version).toBe(6);
    expect(body.key).toBeUndefined();
    expect(body.params).toEqual({ scopes: ['actions'] });
  });

  it('forwards API key when provided', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse(null));
    const client = new AnkiExportClient('http://test:8765', 'secret-key');
    await client.apiReflect({ scopes: ['actions'] });
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.key).toBe('secret-key');
  });
});
