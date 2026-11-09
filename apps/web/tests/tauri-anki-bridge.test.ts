import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import {
  ankiCheckConnectionDirect,
  ankiRequestDirect,
  isTauri,
} from '../src/features/player/tauri-bridge';
import { getTraceRecent, resetTraceState } from '../src/features/trace/trace-logger';

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
});

afterEach(() => {
  delete internals().__TAURI_INTERNALS__;
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
