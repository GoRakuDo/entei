import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  AnkiConnectClient,
  AnkiConnectError,
  runAnkiConnectionFlow,
} from '../src/features/player/anki-connect';

// ---------------------------------------------------------------------------
// Dependency absence check
// ---------------------------------------------------------------------------

describe('Dependencies', () => {
  it('does not list radix-ui in package.json dependencies', async () => {
    const pkg = await import('../package.json');
    expect(pkg.default.dependencies).not.toHaveProperty('radix-ui');
  });

  it('lists individual @radix-ui packages for tabs and select', async () => {
    const pkg = await import('../package.json');
    expect(pkg.default.dependencies).toHaveProperty('@radix-ui/react-tabs');
    expect(pkg.default.dependencies).toHaveProperty('@radix-ui/react-select');
  });
});

// ---------------------------------------------------------------------------
// AnkiConnectClient
// ---------------------------------------------------------------------------

describe('AnkiConnectClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // version (bare number)
  // -------------------------------------------------------------------------

  it('returns bare version number on success', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: 6, error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient();
    const result = await client.version();
    expect(result).toBe(6);
    expect(typeof result).toBe('number');
  });

  it('throws unavailable on network error', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toBeInstanceOf(AnkiConnectError);
    await expect(client.version()).rejects.toMatchObject({
      state: 'unavailable',
    });
  });

  it('throws cors-error on CORS message', async () => {
    fetchSpy.mockRejectedValue(new Error('CORS policy blocked'));

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toMatchObject({
      state: 'cors-error',
    });
  });

  it('throws unknown-error on unexpected fetch failure', async () => {
    fetchSpy.mockRejectedValue(new Error('Something weird'));

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toMatchObject({
      state: 'unknown-error',
    });
  });

  it('throws unknown-error on HTTP error status', async () => {
    fetchSpy.mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toMatchObject({
      state: 'unknown-error',
    });
  });

  it('throws unknown-error on invalid JSON', async () => {
    fetchSpy.mockResolvedValue(
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toMatchObject({
      state: 'unknown-error',
    });
  });

  // -------------------------------------------------------------------------
  // Malformed response guard
  // -------------------------------------------------------------------------

  it('throws unknown-error when response lacks result field', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toMatchObject({
      state: 'unknown-error',
    });
  });

  it('throws unknown-error when response lacks error field', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: 6 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toMatchObject({
      state: 'unknown-error',
    });
  });

  it('throws unknown-error when response is a plain array', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toMatchObject({
      state: 'unknown-error',
    });
  });

  it('throws unknown-error when response is a primitive string', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify('hello'), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toMatchObject({
      state: 'unknown-error',
    });
  });

  // -------------------------------------------------------------------------
  // API key detection
  // -------------------------------------------------------------------------

  it('throws api-key-required when error mentions API key', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ result: null, error: 'API key is required' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toMatchObject({
      state: 'api-key-required',
    });
  });

  it('throws api-key-required when error mentions authentication', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ result: null, error: 'authentication failed' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toMatchObject({
      state: 'api-key-required',
    });
  });

  it('sends API key when provided', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: 6, error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient(
      'http://127.0.0.1:8765',
      'my-secret-key',
    );
    await client.version();

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.key).toBe('my-secret-key');
  });

  // -------------------------------------------------------------------------
  // AbortSignal passed to fetch
  // -------------------------------------------------------------------------

  it('passes AbortSignal to fetch', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: 6, error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient();
    const controller = new AbortController();
    await client.version(controller.signal);

    const call = fetchSpy.mock.calls[0];
    expect(call[1].signal).toBe(controller.signal);
  });

  it('rejects with unknown-error when fetch is aborted', async () => {
    fetchSpy.mockImplementation(
      (_url: string | URL | Request, options?: RequestInit) => {
        if (options?.signal?.aborted) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ result: 6, error: null }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    );

    const client = new AnkiConnectClient();
    const controller = new AbortController();
    controller.abort();

    await expect(client.version(controller.signal)).rejects.toMatchObject({
      state: 'unknown-error',
    });
  });

  // -------------------------------------------------------------------------
  // permission
  // -------------------------------------------------------------------------

  it('throws permission-denied when error mentions permission', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ result: null, error: 'permission denied' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new AnkiConnectClient();
    await expect(client.version()).rejects.toMatchObject({
      state: 'permission-denied',
    });
  });

  it('returns granted permission result', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ result: { permission: 'granted' }, error: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new AnkiConnectClient();
    const result = await client.requestPermission();
    expect(result.permission).toBe('granted');
    expect(result.requireApiKey).toBeUndefined();
  });

  it('returns denied permission result', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ result: { permission: 'denied' }, error: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new AnkiConnectClient();
    const result = await client.requestPermission();
    expect(result.permission).toBe('denied');
  });

  it('detects requireApiKey in permission result', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          result: { permission: 'granted', requireApiKey: true },
          error: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new AnkiConnectClient();
    const result = await client.requestPermission();
    expect(result.permission).toBe('granted');
    expect(result.requireApiKey).toBe(true);
  });

  // -------------------------------------------------------------------------
  // deckNames / modelNames / modelFieldNames
  // -------------------------------------------------------------------------

  it('returns deck names', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ result: ['Default', 'Japanese'], error: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new AnkiConnectClient();
    const decks = await client.deckNames();
    expect(decks).toEqual(['Default', 'Japanese']);
  });

  it('returns model names', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ result: ['Basic', 'Japanese'], error: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new AnkiConnectClient();
    const models = await client.modelNames();
    expect(models).toEqual(['Basic', 'Japanese']);
  });

  it('returns model field names', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: ['Front', 'Back'], error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient();
    const fields = await client.modelFieldNames('Basic');
    expect(fields).toEqual(['Front', 'Back']);

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.params.modelName).toBe('Basic');
  });

  it('passes signal to modelFieldNames', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: ['Front', 'Back'], error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient();
    const controller = new AbortController();
    await client.modelFieldNames('Basic', controller.signal);

    const call = fetchSpy.mock.calls[0];
    expect(call[1].signal).toBe(controller.signal);
  });

  // -------------------------------------------------------------------------
  // endpoint customization
  // -------------------------------------------------------------------------

  it('uses custom endpoint', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: 6, error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient('http://192.168.1.10:8765');
    await client.version();

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://192.168.1.10:8765',
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// runAnkiConnectionFlow
// ---------------------------------------------------------------------------

describe('runAnkiConnectionFlow', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns decks, models, and requireApiKey on successful flow', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: 6, error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new AnkiConnectClient();

    const mockVersion = vi.spyOn(client, 'version').mockResolvedValue(6);
    const mockPermission = vi
      .spyOn(client, 'requestPermission')
      .mockResolvedValue({ permission: 'granted', requireApiKey: true });
    const mockDecks = vi
      .spyOn(client, 'deckNames')
      .mockResolvedValue(['Deck1']);
    const mockModels = vi
      .spyOn(client, 'modelNames')
      .mockResolvedValue(['Basic']);

    const result = await runAnkiConnectionFlow(client);
    expect(result.decks).toEqual(['Deck1']);
    expect(result.models).toEqual(['Basic']);
    expect(result.requireApiKey).toBe(true);

    mockVersion.mockRestore();
    mockPermission.mockRestore();
    mockDecks.mockRestore();
    mockModels.mockRestore();
  });

  it('returns requireApiKey false when permission does not require it', async () => {
    const client = new AnkiConnectClient();
    const mockVersion = vi.spyOn(client, 'version').mockResolvedValue(6);
    const mockPermission = vi
      .spyOn(client, 'requestPermission')
      .mockResolvedValue({ permission: 'granted' });
    const mockDecks = vi
      .spyOn(client, 'deckNames')
      .mockResolvedValue(['Deck1']);
    const mockModels = vi
      .spyOn(client, 'modelNames')
      .mockResolvedValue(['Basic']);

    const result = await runAnkiConnectionFlow(client);
    expect(result.requireApiKey).toBe(false);

    mockVersion.mockRestore();
    mockPermission.mockRestore();
    mockDecks.mockRestore();
    mockModels.mockRestore();
  });

  it('throws permission-denied when permission is denied', async () => {
    const client = new AnkiConnectClient();
    const mockVersion = vi.spyOn(client, 'version').mockResolvedValue(6);
    const mockPermission = vi
      .spyOn(client, 'requestPermission')
      .mockResolvedValue({ permission: 'denied' });

    await expect(runAnkiConnectionFlow(client)).rejects.toMatchObject({
      state: 'permission-denied',
    });

    mockVersion.mockRestore();
    mockPermission.mockRestore();
  });

  it('continues when requestPermission is unsupported (throws non-permission error)', async () => {
    const client = new AnkiConnectClient();
    const mockVersion = vi.spyOn(client, 'version').mockResolvedValue(6);
    const mockPermission = vi
      .spyOn(client, 'requestPermission')
      .mockRejectedValue(
        new AnkiConnectError('Unsupported action', 'unknown-error'),
      );
    const mockDecks = vi
      .spyOn(client, 'deckNames')
      .mockResolvedValue(['Deck1']);
    const mockModels = vi
      .spyOn(client, 'modelNames')
      .mockResolvedValue(['Basic']);

    const result = await runAnkiConnectionFlow(client);
    expect(result.decks).toEqual(['Deck1']);
    expect(result.requireApiKey).toBe(false);

    mockVersion.mockRestore();
    mockPermission.mockRestore();
    mockDecks.mockRestore();
    mockModels.mockRestore();
  });

  it('respects abort signal', async () => {
    const client = new AnkiConnectClient();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runAnkiConnectionFlow(client, controller.signal),
    ).rejects.toMatchObject({
      message: 'Connection cancelled.',
    });
  });

  it('passes signal through to individual methods', async () => {
    const client = new AnkiConnectClient();
    const mockVersion = vi.spyOn(client, 'version').mockResolvedValue(6);
    const mockPermission = vi
      .spyOn(client, 'requestPermission')
      .mockResolvedValue({ permission: 'granted' });
    const mockDecks = vi
      .spyOn(client, 'deckNames')
      .mockResolvedValue(['Deck1']);
    const mockModels = vi
      .spyOn(client, 'modelNames')
      .mockResolvedValue(['Basic']);

    const controller = new AbortController();
    await runAnkiConnectionFlow(client, controller.signal);

    expect(mockVersion).toHaveBeenCalledWith(controller.signal);
    expect(mockPermission).toHaveBeenCalledWith(controller.signal);
    expect(mockDecks).toHaveBeenCalledWith(controller.signal);
    expect(mockModels).toHaveBeenCalledWith(controller.signal);

    mockVersion.mockRestore();
    mockPermission.mockRestore();
    mockDecks.mockRestore();
    mockModels.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Stage 1A forbidden actions
// ---------------------------------------------------------------------------

describe('Stage 1A forbidden actions', () => {
  it('does not expose addNote on AnkiConnectClient', () => {
    const client = new AnkiConnectClient();
    expect('addNote' in client).toBe(false);
  });

  it('does not expose canAddNotes on AnkiConnectClient', () => {
    const client = new AnkiConnectClient();
    expect('canAddNotes' in client).toBe(false);
  });

  it('does not expose updateNoteFields on AnkiConnectClient', () => {
    const client = new AnkiConnectClient();
    expect('updateNoteFields' in client).toBe(false);
  });

  it('does not expose storeMediaFile on AnkiConnectClient', () => {
    const client = new AnkiConnectClient();
    expect('storeMediaFile' in client).toBe(false);
  });

  it('does not expose findNotes on AnkiConnectClient', () => {
    const client = new AnkiConnectClient();
    expect('findNotes' in client).toBe(false);
  });

  it('does not expose notesInfo on AnkiConnectClient', () => {
    const client = new AnkiConnectClient();
    expect('notesInfo' in client).toBe(false);
  });
});
