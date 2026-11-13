import { afterEach, describe, expect, it, vi } from 'bun:test';
import {
  addTorrentDirect,
  cancelTorrentDirect,
  getTorrentStatusDirect,
  getVideoInfoDirect,
  jimakuDownloadSubtitleDirect,
  jimakuEntryFilesDirect,
  jimakuSearchEntriesCombinedDirect,
  jimakuSearchEntriesDirect,
  nadeshikoSearchDirect,
  nadeshikoSegmentContextDirect,
  nadeshikoUserMeDirect,
  selectTorrentFilesDirect,
  streamYouTubeDirect,
  yomitanDeleteDictionaryDirect,
  yomitanFindKanjiDirect,
  yomitanFindTermsDirect,
  yomitanImportDictionaryDirect,
  yomitanListDictionariesDirect,
  yomitanToggleDictionaryDirect,
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

  it('uses typed Yomitan dictionary commands with exact payload names', async () => {
    const summary = {
      id: 'a1b2c3',
      title: 'JMdict',
      format: 3,
      revision: 'jmdict-3.5.0',
      sequenced: true,
      author: null,
      url: null,
      description: null,
      createdAt: 1_700_000_000_000,
      enabled: true,
    };
    const term = {
      id: 1,
      dictionaryId: 'a1b2c3',
      expression: '食べる',
      reading: 'たべる',
      definitionTags: 'v1',
      rules: 'v1 vt',
      score: 100,
      sequence: 1,
      termTags: null,
      glossary: ['to eat'],
    };
    const calls = installTauri((command) => {
      if (command.endsWith('yomitan_list_dictionaries')) return [summary];
      if (command.endsWith('yomitan_import_dictionary')) return summary;
      if (command.endsWith('yomitan_find_terms')) return [term];
      if (command.endsWith('yomitan_find_kanji')) return null;
      return null;
    });

    await expect(yomitanImportDictionaryDirect({ zipPath: 'Z:\\d\\jmdict.zip' })).resolves.toEqual(summary);
    await expect(yomitanListDictionariesDirect()).resolves.toEqual([summary]);
    await expect(yomitanToggleDictionaryDirect({ id: 'a1b2c3', enabled: false })).resolves.toBeNull();
    await expect(yomitanDeleteDictionaryDirect({ id: 'a1b2c3' })).resolves.toBeNull();
    await expect(yomitanFindTermsDirect({ term: '食べる' })).resolves.toEqual([term]);
    await expect(yomitanFindKanjiDirect({ character: '日' })).resolves.toBeNull();

    expect(calls).toEqual([
      {
        command: 'plugin:modules|yomitan_import_dictionary',
        args: { zipPath: 'Z:\\d\\jmdict.zip' },
      },
      { command: 'plugin:modules|yomitan_list_dictionaries', args: {} },
      {
        command: 'plugin:modules|yomitan_toggle_dictionary',
        args: { id: 'a1b2c3', enabled: false },
      },
      { command: 'plugin:modules|yomitan_delete_dictionary', args: { id: 'a1b2c3' } },
      { command: 'plugin:modules|yomitan_find_terms', args: { term: '食べる' } },
      { command: 'plugin:modules|yomitan_find_kanji', args: { character: '日' } },
    ]);
  });

  it('omits an undefined term limit instead of sending it as null', async () => {
    const calls = installTauri(() => []);

    await yomitanFindTermsDirect({ term: '食べる' });
    await yomitanFindTermsDirect({ term: '食べる', limit: 5 });

    expect(calls).toEqual([
      { command: 'plugin:modules|yomitan_find_terms', args: { term: '食べる' } },
      { command: 'plugin:modules|yomitan_find_terms', args: { term: '食べる', limit: 5 } },
    ]);
  });

  it('routes yt-dlp stream and video info commands through plugin:modules', async () => {
    const stream = {
      url: 'http://127.0.0.1:41234/stream/s1',
      urls: ['http://127.0.0.1:41234/stream/s1'],
      mode: 'video',
      format_selector: 'best',
      relayed: true,
    };
    const info = {
      id: 'vid1',
      title: 'Video',
      is_live: false,
      subtitles: ['ja'],
    };
    const calls = installTauri((command) => {
      if (command === 'plugin:modules|stream_youtube') return stream;
      if (command === 'plugin:modules|get_video_info') return info;
      return null;
    });

    await expect(streamYouTubeDirect('https://youtu.be/vid1', 'video')).resolves.toEqual(stream);
    await expect(getVideoInfoDirect('https://youtu.be/vid1')).resolves.toEqual(info);
    expect(calls).toEqual([
      {
        command: 'plugin:modules|stream_youtube',
        args: { url: 'https://youtu.be/vid1', mode: 'video' },
      },
      {
        command: 'plugin:modules|get_video_info',
        args: { url: 'https://youtu.be/vid1' },
      },
    ]);
  });

  it('routes torrent lifecycle commands through plugin:modules', async () => {
    const files = [{ index: 0, path: 'ep.mkv', length: 1024 }];
    const calls = installTauri((command) => {
      if (command === 'plugin:modules|add_torrent') {
        return { id: 't-1', info_hash: 'hash', name: 'Show', files };
      }
      if (command === 'plugin:modules|get_torrent_status') {
        return {
          id: 't-1',
          info_hash: 'hash',
          name: 'Show',
          state: 'metadata',
          progress_bytes: 0,
          total_bytes: 0,
          progress_percent: 0,
          download_speed_mbps: 0,
          peers_live: 0,
          finished: false,
          playable: false,
          error: null,
          files,
        };
      }
      if (command === 'plugin:modules|select_torrent_files') {
        return {
          video_url: 'http://127.0.0.1:5555/stream/v',
          video_name: 'ep.mkv',
          video_length: 1024,
          subtitle_url: null,
          subtitle_name: null,
          selected_audio_track: null,
          selected_subtitle_track: null,
        };
      }
      return null;
    });

    await expect(addTorrentDirect('magnet:?xt=urn:btih:abc')).resolves.toMatchObject({
      id: 't-1',
      files,
    });
    await expect(getTorrentStatusDirect('t-1')).resolves.toMatchObject({
      id: 't-1',
      state: 'metadata',
      files,
    });
    await expect(selectTorrentFilesDirect('t-1', 0)).resolves.toMatchObject({
      video_url: 'http://127.0.0.1:5555/stream/v',
      video_name: 'ep.mkv',
    });
    await expect(cancelTorrentDirect('t-1')).resolves.toBeUndefined();
    expect(calls).toEqual([
      { command: 'plugin:modules|add_torrent', args: { magnetUri: 'magnet:?xt=urn:btih:abc' } },
      { command: 'plugin:modules|get_torrent_status', args: { id: 't-1' } },
      { command: 'plugin:modules|select_torrent_files', args: { id: 't-1', videoIndex: 0 } },
      { command: 'plugin:modules|cancel_torrent', args: { id: 't-1' } },
    ]);
  });

  it('does not call native modules commands without a Tauri runtime', async () => {
    await expect(jimakuSearchEntriesDirect('key', 'Title', true)).rejects.toThrow(
      'tauri runtime unavailable',
    );
    await expect(nadeshikoUserMeDirect('key')).rejects.toThrow(
      'tauri runtime unavailable',
    );
    await expect(yomitanListDictionariesDirect()).rejects.toThrow(
      'tauri runtime unavailable',
    );
    await expect(streamYouTubeDirect('https://youtu.be/vid1')).rejects.toThrow(
      'tauri runtime unavailable',
    );
    await expect(addTorrentDirect('magnet:?xt=urn:btih:abc')).rejects.toThrow(
      'tauri runtime unavailable',
    );
  });
});
