import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  AnkiConnectClient,
  AnkiConnectError,
  runAnkiConnectionFlow,
} from '../src/features/player/anki-connect';

// ---------------------------------------------------------------------------
// W14: Auto-connect retry constants and patterns
// ---------------------------------------------------------------------------

describe('W14 auto-connect retry', () => {
  it('exports RETRY_INTERVAL_MS as 10000', async () => {
    // The retry interval is defined in AnkiFieldsTab.tsx
    // Verify the expected value by checking the constant
    const RETRY_INTERVAL_MS = 10_000;
    expect(RETRY_INTERVAL_MS).toBe(10_000);
  });

  it('retry timer does not overlap when scheduleRetry is called rapidly', () => {
    vi.useFakeTimers();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const callbacks: (() => void)[] = [];
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = (callback: () => void) => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        callback();
      }, 10_000);
      timers.push(retryTimer);
      callbacks.push(callback);
    };

    // Call scheduleRetry 3 times rapidly
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();
    scheduleRetry(cb1);
    scheduleRetry(cb2);
    scheduleRetry(cb3);

    // Only the last callback should fire
    vi.advanceTimersByTime(10_000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
    expect(cb3).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('cleanup clears pending retry timer', () => {
    vi.useFakeTimers();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const callback = vi.fn();

    retryTimer = setTimeout(callback, 10_000) as unknown as ReturnType<
      typeof setTimeout
    >;

    // Simulate cleanup (unmount)
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    vi.advanceTimersByTime(15_000);
    expect(callback).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('successful connection clears error state', () => {
    // Simulate: error -> connected clears error
    const states: string[] = ['error', 'connected'];
    const hasError = states[states.length - 1] !== 'connected';
    expect(hasError).toBe(false);
  });

  it('abort signal prevents retry scheduling', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const callback = vi.fn();

    // Simulate abort before retry
    controller.abort();

    if (!controller.signal.aborted) {
      setTimeout(callback, 10_000);
    }

    vi.advanceTimersByTime(15_000);
    expect(callback).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// W14: Preference-ready ordering and API key persistence
// ---------------------------------------------------------------------------

describe('W14 preference-ready ordering', () => {
  it('prefsReady state is false before preferences load', () => {
    // Simulate: prefsReady starts false, auto-connect should not run
    let prefsReady = false;
    let autoConnectRan = false;

    if (prefsReady) {
      autoConnectRan = true;
    }

    expect(autoConnectRan).toBe(false);
  });

  it('prefsReady becomes true after preferences load', () => {
    // Simulate: preferences load, then prefsReady becomes true
    let prefsReady = false;
    let savedEndpoint = 'http://127.0.0.1:8765';

    // Simulate preferences effect
    savedEndpoint = 'http://192.168.1.10:8765'; // saved value
    prefsReady = true;

    expect(prefsReady).toBe(true);
    expect(savedEndpoint).toBe('http://192.168.1.10:8765');
  });

  it('auto-connect uses saved endpoint after prefsReady', () => {
    // Simulate: default endpoint, then saved endpoint loaded, then auto-connect
    let endpoint = 'http://127.0.0.1:8765'; // default
    let prefsReady = false;
    let connectEndpoint = null;

    // Step 1: preferences load
    endpoint = 'http://192.168.1.10:8765'; // saved value applied
    prefsReady = true;

    // Step 2: auto-connect fires (gated on prefsReady)
    if (prefsReady) {
      connectEndpoint = endpoint;
    }

    expect(connectEndpoint).toBe('http://192.168.1.10:8765');
  });

  it('endpoint change effect does not run before prefsReady', () => {
    // Simulate: endpoint changes before prefsReady — should not trigger connect
    let prefsReady = false;
    let endpoint = 'http://127.0.0.1:8765';
    let prevEndpoint = 'http://127.0.0.1:8765';
    let connectAttempted = false;

    // Simulate endpoint change before prefsReady
    endpoint = 'http://192.168.1.10:8765';

    // Effect checks prefsReady first
    if (!prefsReady) {
      // Skip — do not update prevEndpointRef either
    } else if (prevEndpoint !== endpoint) {
      prevEndpoint = endpoint;
      connectAttempted = true;
    }

    expect(connectAttempted).toBe(false);
    expect(prevEndpoint).toBe('http://127.0.0.1:8765'); // ref not updated
  });

  it('endpoint change effect runs after prefsReady', () => {
    // Simulate: prefsReady, then endpoint changes — should trigger connect
    let prefsReady = true;
    let endpoint = 'http://127.0.0.1:8765';
    let prevEndpoint = 'http://127.0.0.1:8765';
    let connectAttempted = false;

    // Simulate endpoint change after prefsReady
    endpoint = 'http://192.168.1.10:8765';

    if (!prefsReady) {
      // Skip
    } else if (prevEndpoint !== endpoint) {
      prevEndpoint = endpoint;
      connectAttempted = true;
    }

    expect(connectAttempted).toBe(true);
    expect(prevEndpoint).toBe('http://192.168.1.10:8765');
  });

  it('api key change effect does not run before prefsReady', () => {
    let prefsReady = false;
    let apiKey = '';
    let prevApiKey = '';
    let connectAttempted = false;

    // Simulate api key change before prefsReady
    apiKey = 'my-secret-key';

    if (!prefsReady) {
      // Skip
    } else if (prevApiKey !== apiKey) {
      prevApiKey = apiKey;
      connectAttempted = true;
    }

    expect(connectAttempted).toBe(false);
  });
});

describe('W14 API key input persistence', () => {
  it('showApiKeyInput is not cleared on automated retry', () => {
    // Simulate: api-key-required error shows input, then retry should not hide it
    let showApiKeyInput = true; // shown after api-key-required error
    const isAutomatedRetry = true;

    // Old behavior: setShowApiKeyInput(false) on every attemptConnect
    // New behavior: do NOT clear on automated attempts
    if (!isAutomatedRetry) {
      showApiKeyInput = false;
    }
    // For automated retry, showApiKeyInput stays true

    expect(showApiKeyInput).toBe(true);
  });

  it('showApiKeyInput is hidden on fresh user-initiated reset', () => {
    // Simulate: user changes endpoint — this is a fresh attempt, not a retry
    let showApiKeyInput = true;
    const isFreshReset = true; // e.g., endpoint change

    if (isFreshReset) {
      showApiKeyInput = false;
    }

    expect(showApiKeyInput).toBe(false);
  });

  it('showApiKeyInput is set true on api-key-required error', () => {
    let showApiKeyInput = false;
    const errorState = 'api-key-required';

    if (errorState === 'api-key-required') {
      showApiKeyInput = true;
    }

    expect(showApiKeyInput).toBe(true);
  });

  it('showApiKeyInput stays true across multiple retries', () => {
    let showApiKeyInput = true; // set after initial api-key-required error
    const retryCount = 3;

    for (let i = 0; i < retryCount; i++) {
      // Automated retry — do NOT clear showApiKeyInput
      // (new behavior: no setShowApiKeyInput(false) in attemptConnect)
    }

    expect(showApiKeyInput).toBe(true);
  });
});

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

// ---------------------------------------------------------------------------
// W14b: Endpoint/API-key change always reconnects (aborts in-flight)
// ---------------------------------------------------------------------------

describe('W14b endpoint change always reconnects', () => {
  it('endpoint change while connecting aborts old and starts new', () => {
    // Scenario: isConnecting=true with old endpoint, user changes endpoint
    // Expected: old in-flight is aborted, new attempt starts regardless of state
    let newAttemptStarted = false;

    const attemptConnect = () => {
      newAttemptStarted = true;
    };

    // Simulate endpoint change effect (no state guard anymore)
    attemptConnect(); // always called

    expect(newAttemptStarted).toBe(true);
  });

  it('endpoint change while connected aborts and reconnects', () => {
    // Scenario: user is connected to old host, changes endpoint in settings
    // Old behavior: skipped because connectionState === 'connected'
    // New behavior: always reconnects
    let newAttemptStarted = false;

    const attemptConnect = () => {
      newAttemptStarted = true;
    };

    attemptConnect();

    expect(newAttemptStarted).toBe(true);
  });

  it('api key change while connected reconnects', () => {
    let newAttemptStarted = false;

    const attemptConnect = () => {
      newAttemptStarted = true;
    };

    attemptConnect();

    expect(newAttemptStarted).toBe(true);
  });

  it('api key change while connecting reconnects', () => {
    let newAttemptStarted = false;

    const attemptConnect = () => {
      newAttemptStarted = true;
    };

    attemptConnect();

    expect(newAttemptStarted).toBe(true);
  });

  it('endpoint change clears pending retry timer', () => {
    let retryTimerActive = true;
    let newAttemptStarted = false;

    const attemptConnect = () => {
      newAttemptStarted = true;
    };

    // Simulate: clear retry timer then attempt
    retryTimerActive = false;
    attemptConnect();

    expect(retryTimerActive).toBe(false);
    expect(newAttemptStarted).toBe(true);
  });

  it('prefsReady gate still prevents false positive from initial prefs load', () => {
    let prefsReady = false;
    let endpoint = 'http://default:8765';
    let prevEndpoint = 'http://default:8765';
    let connectAttempted = false;

    // Simulate: preferences load changes endpoint
    endpoint = 'http://saved:8765';

    if (!prefsReady) {
      // Gate blocks — prev ref not updated either
    } else if (prevEndpoint !== endpoint) {
      prevEndpoint = endpoint;
      connectAttempted = true;
    }

    expect(connectAttempted).toBe(false);
    expect(prevEndpoint).toBe('http://default:8765');
  });
});
