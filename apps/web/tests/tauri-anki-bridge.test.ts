import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import {
  ankiCheckConnectionDirect,
  ankiRequestDirect,
  isAndroid,
  isTauri,
} from '../src/features/player/tauri-bridge';
import { getTraceRecent, resetTraceState } from '../src/features/trace/trace-logger';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.0.0 Mobile Safari/537.36';

/** Shadow the platform user agent (the one signal that separates Android). */
function setUserAgent(value: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    value,
    configurable: true,
  });
}

interface InvokeArgs {
  command: string;
  args: Record<string, unknown> | undefined;
}

interface InternalsWindow {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

function internals(): InternalsWindow {
  return globalThis as unknown as InternalsWindow;
}

function installTauri(result: unknown): InvokeArgs[] {
  const calls: InvokeArgs[] = [];
  internals().__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return result;
    }),
  };
  return calls;
}

beforeEach(() => {
  delete internals().__TAURI_INTERNALS__;
  setUserAgent(DESKTOP_UA);
});

afterEach(() => {
  delete internals().__TAURI_INTERNALS__;
  delete (navigator as unknown as Record<string, unknown>).userAgent;
  resetTraceState();
});

describe('tauri-bridge Anki commands', () => {
  it('sends typed Anki requests and redacts the API key in trace records', async () => {
    const calls = installTauri(['Default']);
    resetTraceState();

    const result = await ankiRequestDirect<string[]>({
      endpoint: 'http://127.0.0.1:8765',
      action: 'deckNames',
      version: 6,
      key: 'unit-test-secret',
    });

    expect(result).toEqual(['Default']);
    expect(calls).toEqual([
      {
        command: 'plugin:anki|anki_request',
        args: {
          endpoint: 'http://127.0.0.1:8765',
          action: 'deckNames',
          version: 6,
          key: 'unit-test-secret',
        },
      },
    ]);
    const record = getTraceRecent().at(-1);
    expect(record?.event).toBe('invoke');
    expect(record?.data).toMatchObject({
      cmd: 'plugin:anki|anki_request',
      args: {
        key: '[redacted]',
      },
    });
    expect(JSON.stringify(record?.data)).not.toContain('unit-test-secret');
  });

  it('calls the native connection-flow command and validates its reply', async () => {
    const status = {
      state: 'connected',
      endpoint: 'http://127.0.0.1:8765',
      version: 6,
      requireApiKey: false,
      decks: ['Default'],
      models: ['Basic'],
      message: null,
      errorKind: null,
    };
    const calls = installTauri(status);

    await expect(
      ankiCheckConnectionDirect('http://127.0.0.1:8765'),
    ).resolves.toEqual(status);
    expect(calls).toEqual([
      {
        command: 'plugin:anki|anki_check_connection',
        args: { endpoint: 'http://127.0.0.1:8765' },
      },
    ]);
  });

  it('rejects malformed connection-flow replies', async () => {
    installTauri({ state: 'connected' });
    await expect(ankiCheckConnectionDirect()).rejects.toThrow(
      'invalid Anki connection status reply',
    );
  });

  it('does not call native commands outside Tauri', async () => {
    expect(isTauri()).toBe(false);
    await expect(ankiRequestDirect({ action: 'version' })).rejects.toThrow(
      'tauri runtime unavailable',
    );
  });
});

const androidStatus = {
  state: 'connected',
  endpoint: 'content://com.ichi2.anki.flashcards',
  version: 6,
  requireApiKey: false,
  decks: ['Default'],
  models: ['Basic'],
  message: null,
  errorKind: null,
};

describe('tauri-bridge Android AnkiDroid routing', () => {
  it('reports Android only inside a Tauri webview on an Android user agent', () => {
    setUserAgent(ANDROID_UA);
    // No runtime yet: the standalone browser build is never "Android".
    expect(isAndroid()).toBe(false);

    installTauri(null);
    expect(isAndroid()).toBe(true);

    setUserAgent(DESKTOP_UA);
    expect(isTauri()).toBe(true);
    expect(isAndroid()).toBe(false);
  });

  it('prefers the modules AnkiDroid command and unwraps the envelope', async () => {
    const calls = installTauri({ result: ['Default', '日本語'], error: null });
    setUserAgent(ANDROID_UA);
    resetTraceState();

    const result = await ankiRequestDirect<string[]>({
      endpoint: 'http://127.0.0.1:8765',
      action: 'deckNames',
      key: 'unit-test-secret',
    });

    // The envelope is flattened: callers get the action's result, exactly as
    // the desktop plugin's Rust unwrap gives them.
    expect(result).toEqual(['Default', '日本語']);
    expect(calls).toEqual([
      {
        command: 'plugin:modules|modules_ankidroid_request',
        args: {
          action: 'deckNames',
          version: 6,
          params: {},
          key: 'unit-test-secret',
        },
      },
    ]);
    // The key travels to a different plugin, so the journal must still redact it.
    const record = getTraceRecent().at(-1);
    expect(record?.data).toMatchObject({
      cmd: 'plugin:modules|modules_ankidroid_request',
      args: { key: '[redacted]' },
    });
    expect(JSON.stringify(record?.data)).not.toContain('unit-test-secret');
  });

  it('keeps the desktop plugin route on a non-Android Tauri webview', async () => {
    const calls = installTauri(['Default']);

    const result = await ankiRequestDirect<string[]>({
      action: 'deckNames',
      version: 6,
    });

    expect(result).toEqual(['Default']);
    expect(calls).toEqual([
      {
        command: 'plugin:anki|anki_request',
        args: { action: 'deckNames', version: 6 },
      },
    ]);
  });

  it('classifies an error envelope into the desktop plugin error kinds', async () => {
    installTauri({
      result: null,
      error: 'AnkiDroid is not installed. Install AnkiDroid to export cards on Android.',
    });
    setUserAgent(ANDROID_UA);

    const error = (await ankiRequestDirect({ action: 'deckNames' }).catch(
      (e: unknown) => e,
    )) as Error & { kind?: string };

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('network');
    expect(error.message).toContain('not installed');
  });

  it('rejects a reply that is not an envelope', async () => {
    installTauri(['Default']);
    setUserAgent(ANDROID_UA);

    const error = (await ankiRequestDirect({ action: 'deckNames' }).catch(
      (e: unknown) => e,
    )) as Error & { kind?: string };

    expect(error.message).toContain('invalid AnkiDroid reply envelope');
    expect(error.kind).toBe('invalid-response');
  });

  it('classifies a restarting AnkiDroid worker as a network failure', async () => {
    installTauri({
      result: null,
      error: 'AnkiDroid worker is shutting down. Retry the request.',
    });
    setUserAgent(ANDROID_UA);

    const error = (await ankiRequestDirect({ action: 'deckNames' }).catch(
      (e: unknown) => e,
    )) as Error & { kind?: string };

    expect(error.kind).toBe('network');
  });

  it('calls the modules connection command on Android with no endpoint', async () => {
    const calls = installTauri(androidStatus);
    setUserAgent(ANDROID_UA);

    await expect(
      ankiCheckConnectionDirect('http://127.0.0.1:8765', 'unit-test-secret'),
    ).resolves.toEqual(androidStatus);
    expect(calls).toEqual([
      {
        command: 'plugin:modules|modules_ankidroid_check_connection',
        args: {},
      },
    ]);
  });

  it('validates the modules connection reply the same way', async () => {
    installTauri({ state: 'connected' });
    setUserAgent(ANDROID_UA);

    await expect(ankiCheckConnectionDirect()).rejects.toThrow(
      'invalid Anki connection status reply',
    );
  });
});

describe('Anki clients reach the AnkiDroid module transparently', () => {
  it('routes the read client through the modules command with no code change', async () => {
    const calls = installTauri({ result: ['Default', '日本語'], error: null });
    setUserAgent(ANDROID_UA);

    const { AnkiConnectClient } = await import(
      '../src/features/player/anki-connect'
    );
    const client = new AnkiConnectClient('http://127.0.0.1:8765', 'secret-key');

    // No endpoint is sent on Android: the module owns the ContentProvider.
    await expect(client.deckNames()).resolves.toEqual(['Default', '日本語']);
    expect(calls).toEqual([
      {
        command: 'plugin:modules|modules_ankidroid_request',
        args: {
          action: 'deckNames',
          version: 6,
          params: {},
          key: 'secret-key',
        },
      },
    ]);
  });

  it('keeps AnkiConnectError classification for AnkiDroid failures', async () => {
    installTauri({
      result: null,
      error: 'Entei does not have permission to access AnkiDroid. Grant database access to continue.',
    });
    setUserAgent(ANDROID_UA);

    const { AnkiConnectClient, AnkiConnectError } = await import(
      '../src/features/player/anki-connect'
    );
    const client = new AnkiConnectClient();
    const error = (await client.version().catch((e: unknown) => e)) as InstanceType<
      typeof AnkiConnectError
    >;

    expect(error).toBeInstanceOf(AnkiConnectError);
    expect(error.state).toBe('permission-denied');
  });
});
