import { afterEach, describe, expect, it, vi } from 'bun:test';
import {
  jimakuDownloadSubtitleDirect,
  jimakuEntryFilesDirect,
  jimakuSearchEntriesCombinedDirect,
  jimakuSearchEntriesDirect,
  nadeshikoSearchDirect,
  nadeshikoSegmentContextDirect,
  nadeshikoUserMeDirect,
} from '../src/features/player/tauri-bridge';
import type { NadeshikoSearchPage } from '../src/features/nadeshiko/nadeshiko-client';

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

function installTauri(impl: (command: string) => unknown): InvokeArgs[] {
  const calls: InvokeArgs[] = [];
  internals().__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return impl(command);
    }),
  };
  return calls;
}

afterEach(() => {
  delete internals().__TAURI_INTERNALS__;
});

describe('tauri-bridge modules commands', () => {
  it('uses typed Jimaku commands with exact payload names', async () => {
    const entry = { id: 7, name: 'Title', flags: { anime: true } };
    const file = {
      url: 'https://jimaku.cc/subtitle.srt',
      name: 'subtitle.srt',
      size: 12,
      last_modified: 'today',
    };
    const calls = installTauri((command) => {
      if (command.endsWith('search_entries')) return [entry];
      if (command.endsWith('search_entries_combined')) return [entry];
      if (command.endsWith('entry_files')) return [file];
      return 'subtitle body';
    });

    await expect(jimakuSearchEntriesDirect('jimaku-key', 'Title', true)).resolves.toEqual([entry]);
    await expect(jimakuSearchEntriesCombinedDirect('jimaku-key', 'Title')).resolves.toEqual([entry]);
    await expect(jimakuEntryFilesDirect('jimaku-key', 7, 3)).resolves.toEqual([file]);
    await expect(jimakuDownloadSubtitleDirect(file.url)).resolves.toBe('subtitle body');

    expect(calls).toEqual([
      {
        command: 'plugin:modules|modules_jimaku_search_entries',
        args: { apiKey: 'jimaku-key', query: 'Title', anime: true },
      },
      {
        command: 'plugin:modules|modules_jimaku_search_entries_combined',
        args: { apiKey: 'jimaku-key', query: 'Title' },
      },
      {
        command: 'plugin:modules|modules_jimaku_entry_files',
        args: { apiKey: 'jimaku-key', entryId: 7, episode: 3 },
      },
      {
        command: 'plugin:modules|modules_jimaku_download_subtitle',
        args: { url: file.url },
      },
    ]);
  });

  it('uses typed Nadeshiko search, context and user-me commands', async () => {
    const page: NadeshikoSearchPage = {
      segments: [],
      hasMore: true,
      nextCursor: 'next',
    };
    const context = {
      center: { id: 'segment', workName: 'Title', line: 'line' },
      surrounding: [],
      centerIdx: 0,
    };
    const user = { user: { username: 'learner' }, quota: { remaining: 10 } };
    const calls = installTauri((command) => {
      if (command.endsWith('modules_nadeshiko_search')) return page;
      if (command.endsWith('modules_nadeshiko_segment_context')) return context;
      return user;
    });

    await expect(
      nadeshikoSearchDirect('nadeshiko-key', '猫', { take: 5, mode: 'TIME_DESC' }),
    ).resolves.toEqual(page);
    await expect(
      nadeshikoSegmentContextDirect('nadeshiko-key', 'segment', { take: 7 }),
    ).resolves.toEqual(context);
    await expect(nadeshikoUserMeDirect('nadeshiko-key')).resolves.toEqual(user);

    expect(calls).toEqual([
      {
        command: 'plugin:modules|modules_nadeshiko_search',
        args: {
          apiKey: 'nadeshiko-key',
          query: '猫',
          options: { take: 5, mode: 'TIME_DESC' },
        },
      },
      {
        command: 'plugin:modules|modules_nadeshiko_segment_context',
        args: {
          apiKey: 'nadeshiko-key',
          segmentId: 'segment',
          options: { take: 7 },
        },
      },
      {
        command: 'plugin:modules|modules_nadeshiko_user_me',
        args: { apiKey: 'nadeshiko-key' },
      },
    ]);
  });

  it('does not call native modules commands without a Tauri runtime', async () => {
    await expect(jimakuSearchEntriesDirect('key', 'Title', true)).rejects.toThrow(
      'tauri runtime unavailable',
    );
    await expect(nadeshikoUserMeDirect('key')).rejects.toThrow(
      'tauri runtime unavailable',
    );
  });
});
