import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import {
  AnkiConnectClient,
  runAnkiConnectionFlow,
} from '../src/features/player/anki-connect';
import {
  getNadeshikoSegmentContext,
  getNadeshikoUserMe,
  searchNadeshikoSegments,
} from '../src/features/nadeshiko/nadeshiko-client';
import {
  downloadJimakuSubtitle,
  getJimakuEntryFiles,
  searchJimakuEntries,
  searchJimakuEntriesCombined,
} from '../src/features/player/jimaku-client';

interface InternalsWindow {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

function internals(): InternalsWindow {
  return globalThis as unknown as InternalsWindow;
}

function installTauri(
  handler: (command: string, args: Record<string, unknown>) => unknown,
) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  internals().__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      const actualArgs = args ?? {};
      calls.push({ command, args: actualArgs });
      const result = handler(command, actualArgs);
      if (result instanceof Error) throw result;
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
  vi.restoreAllMocks();
});

describe('Tauri hybrid API clients', () => {
  it('routes the Anki connection flow through native AnkiConnect requests', async () => {
    const calls = installTauri((_command, args) => {
      switch (args.action) {
        case 'version':
          return 6;
        case 'requestPermission':
          return { permission: 'granted', requireApiKey: false };
        case 'deckNames':
          return ['Default'];
        case 'modelNames':
          return ['Basic'];
        default:
          return new Error('unexpected native action');
      }
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      runAnkiConnectionFlow(new AnkiConnectClient()),
    ).resolves.toEqual({
      decks: ['Default'],
      models: ['Basic'],
      requireApiKey: false,
    });

    expect(calls.map(({ command, args }) => [command, args.action])).toEqual([
      ['plugin:anki|anki_request', 'version'],
      ['plugin:anki|anki_request', 'requestPermission'],
      ['plugin:anki|anki_request', 'deckNames'],
      ['plugin:anki|anki_request', 'modelNames'],
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('routes Jimaku operations through native commands and preserves client results', async () => {
    const entry = { id: 42, name: 'Example', flags: { anime: true } };
    const file = {
      url: 'https://jimaku.cc/example.srt',
      name: 'example.srt',
      size: 12,
      last_modified: 'today',
    };
    const calls = installTauri((command) => {
      if (command.endsWith('modules_jimaku_search_entries')) return [entry];
      if (command.endsWith('modules_jimaku_search_entries_combined')) return [entry];
      if (command.endsWith('modules_jimaku_entry_files')) return [file];
      if (command.endsWith('modules_jimaku_download_subtitle')) return 'subtitle';
      return new Error('unexpected native command');
    });

    await expect(searchJimakuEntries('test-key', 'Example', true)).resolves.toEqual({
      ok: true,
      data: [entry],
    });
    await expect(searchJimakuEntriesCombined('test-key', 'Example')).resolves.toEqual({
      ok: true,
      data: [entry],
    });
    await expect(getJimakuEntryFiles('test-key', 42, 2)).resolves.toEqual({
      ok: true,
      data: [file],
    });
    await expect(downloadJimakuSubtitle(file.url)).resolves.toEqual({
      ok: true,
      data: 'subtitle',
    });
    expect(calls.map(({ command }) => command)).toEqual([
      'plugin:modules|modules_jimaku_search_entries',
      'plugin:modules|modules_jimaku_search_entries_combined',
      'plugin:modules|modules_jimaku_entry_files',
      'plugin:modules|modules_jimaku_download_subtitle',
    ]);
  });

  it('routes Nadeshiko search, context and user-me through native modules', async () => {
    const page = {
      segments: [],
      hasMore: true,
      nextCursor: 'next',
    };
    const context = {
      center: { id: 'segment', workName: 'Example', line: 'line' },
      surrounding: [],
      centerIdx: 0,
    };
    const user = { user: { username: 'learner' }, quota: { remaining: 12 } };
    const calls = installTauri((command) => {
      if (command.endsWith('modules_nadeshiko_search')) return page;
      if (command.endsWith('modules_nadeshiko_segment_context')) return context;
      if (command.endsWith('modules_nadeshiko_user_me')) return user;
      return new Error('unexpected native command');
    });

    await expect(searchNadeshikoSegments('test-key', '猫')).resolves.toEqual(page);
    await expect(
      getNadeshikoSegmentContext('test-key', 'segment', undefined, { take: 5 }),
    ).resolves.toEqual(context);
    await expect(getNadeshikoUserMe('test-key')).resolves.toEqual(user);
    expect(calls.map(({ command }) => command)).toEqual([
      'plugin:modules|modules_nadeshiko_search',
      'plugin:modules|modules_nadeshiko_segment_context',
      'plugin:modules|modules_nadeshiko_user_me',
    ]);
  });

  it('keeps browser fetch fallbacks for combined Jimaku search and Nadeshiko user-me', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/entries/search?')) {
          const anime = url.includes('anime=true');
          return new Response(
            JSON.stringify([
              {
                id: anime ? 1 : 2,
                name: anime ? 'Anime 2' : 'Drama 1',
                flags: { anime },
              },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ user: { username: 'learner' }, quota: { remaining: 8 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    );

    await expect(searchJimakuEntriesCombined('test-key', 'Example')).resolves.toEqual({
      ok: true,
      data: [
        { id: 1, name: 'Anime 2', flags: { anime: true } },
        { id: 2, name: 'Drama 1', flags: { anime: false } },
      ],
    });
    await expect(getNadeshikoUserMe('test-key')).resolves.toEqual({
      user: { username: 'learner' },
      quota: { remaining: 8 },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('maps native API errors to existing Jimaku and Nadeshiko error contracts', async () => {
    installTauri((command) => {
      if (command.includes('modules_jimaku_search_entries')) {
        return Object.assign(new Error('rejected'), { kind: 'auth' });
      }
      return Object.assign(new Error('quota exceeded'), {
        kind: 'quota-exceeded',
        status: 429,
      });
    });

    await expect(searchJimakuEntries('test-key', 'Example', true)).resolves.toEqual({
      ok: false,
      error: 'auth',
    });
    await expect(searchNadeshikoSegments('test-key', '猫')).rejects.toMatchObject({
      kind: 'quota-exceeded',
      status: 429,
    });
  });
});
