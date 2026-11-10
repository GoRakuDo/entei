/**
 * Embedded SQLite bridge, hybrid store selection, and the one-shot migration.
 * ---------------------------------------------------------------------------
 * Covers the three seams the §11.4 desktop database integration introduces:
 * 1. `tauri-bridge` database wrappers send the right `plugin:database|*`
 *    command + camelCase args inside Tauri, and reject outside it.
 * 2. The hybrid stores pick SQLite on desktop and their existing
 *    localStorage / IndexedDB path in the browser.
 * 3. `runDatabaseMigrationV1` imports the browser-era data once, is gated by a
 *    completion flag, and is a no-op outside Tauri.
 *
 * The Tauri runtime is stubbed exactly like the other bridge tests
 * (`window.__TAURI_INTERNALS__.invoke`), so no real database is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import {
  dbCreateTimelinePost,
  dbGetProfile,
  dbGetTimelinePosts,
  dbKvGet,
  dbKvSet,
  dbMigrateV1,
  dbSaveMiningCard,
  dbSaveWatchSession,
  dbUpsertProfile,
  dbUpsertWatchHistory,
  isTauri,
} from '../src/features/player/tauri-bridge';
import { loadTimelineState } from '../src/features/timeline/timeline-store';
import { runDatabaseMigrationV1 } from '../src/features/database/migration';
import { resetTraceState } from '../src/features/trace/trace-logger';

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

type Handler = (command: string, args?: Record<string, unknown>) => unknown;

/** Install a routed Tauri `invoke` stub and return the recorded calls. */
function installTauriDb(handler: Handler = () => null): InvokeArgs[] {
  const calls: InvokeArgs[] = [];
  internals().__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return handler(command, args);
    }),
  };
  return calls;
}

const DB = 'plugin:database|';

beforeEach(() => {
  delete internals().__TAURI_INTERNALS__;
  localStorage.clear();
});

afterEach(() => {
  delete internals().__TAURI_INTERNALS__;
  resetTraceState();
});

describe('database bridge wrappers (Tauri)', () => {
  it('lists timeline posts with camelCase args', async () => {
    const calls = installTauriDb(() => []);
    await dbGetTimelinePosts({ limit: 10, parentId: 'p1' });
    expect(calls).toEqual([
      { command: `${DB}db_get_timeline_posts`, args: { limit: 10, parentId: 'p1' } },
    ]);
  });

  it('creates a timeline post wrapped in the `post` arg', async () => {
    const row = {
      id: 'post_1',
      authorHandle: '@k',
      authorName: 'K',
      authorAvatar: '/avatars/3.webp',
      content: 'hi',
      createdAt: 1,
      likes: 0,
      likedByMe: false,
      replyCount: 0,
      parentId: null,
    };
    const calls = installTauriDb(() => row);
    const input = {
      authorHandle: '@k',
      authorName: 'K',
      authorAvatar: '/avatars/3.webp',
      content: 'hi',
      createdAt: 1,
      parentId: null,
    };
    await expect(dbCreateTimelinePost(input)).resolves.toEqual(row);
    expect(calls[0]!.command).toBe(`${DB}db_create_timeline_post`);
    expect(calls[0]!.args).toEqual({ post: input });
  });

  it('upserts watch history, sessions (with a stable id), mining and profile', async () => {
    const calls = installTauriDb(() => null);

    await dbUpsertWatchHistory({
      mediaId: 'm1',
      title: 'T',
      titleNative: null,
      episode: null,
      source: 'local',
      watchedAt: 1,
      duration: null,
      position: null,
      posterUrl: null,
      posterStatus: null,
      anilistId: null,
      tmdbId: null,
    });
    expect(calls.at(-1)).toEqual({
      command: `${DB}db_upsert_watch_history`,
      args: {
        item: expect.objectContaining({ mediaId: 'm1' }),
      },
    });

    await dbSaveWatchSession({
      id: 'watch-abc',
      mediaId: 'm1',
      title: 'T',
      startTime: 1,
      endTime: 2,
      duration: 1,
      cuesMined: 0,
      minedSentences: [],
    });
    expect(calls.at(-1)!.command).toBe(`${DB}db_save_watch_session`);
    expect(calls.at(-1)!.args).toEqual({
      session: expect.objectContaining({ id: 'watch-abc' }),
    });

    await dbSaveMiningCard({
      mediaFilename: 'ep01.mkv',
      createdAt: 1,
      sentence: 's',
      word: null,
      rangeStart: 1,
      rangeEnd: 2,
    });
    expect(calls.at(-1)!.command).toBe(`${DB}db_save_mining_card`);

    await dbUpsertProfile({
      handle: '@k',
      displayName: 'K',
      bio: null,
      avatarUrl: null,
      updatedAt: 1,
    });
    expect(calls.at(-1)!.command).toBe(`${DB}db_upsert_profile`);
  });

  it('reads/writes the key/value store and runs the batch migration', async () => {
    const calls = installTauriDb(() => null);

    await dbKvSet('k', 'v');
    expect(calls.at(-1)).toEqual({
      command: `${DB}db_kv_set`,
      args: { key: 'k', value: 'v' },
    });

    const payload = {
      posts: [],
      watchHistory: [],
      watchSessions: [],
      miningArchive: [],
      profile: null,
      kv: [],
    };
    await dbMigrateV1(payload);
    expect(calls.at(-1)).toEqual({
      command: `${DB}db_migrate_v1`,
      args: { payload },
    });
  });

  it('rejects every command outside Tauri', async () => {
    expect(isTauri()).toBe(false);
    await expect(dbGetTimelinePosts()).rejects.toThrow('tauri runtime unavailable');
    await expect(dbGetProfile()).rejects.toThrow('tauri runtime unavailable');
    await expect(dbKvGet('k')).rejects.toThrow('tauri runtime unavailable');
  });
});

describe('hybrid store selection', () => {
  it('reads the timeline from SQLite on desktop (posts + replies + kv likes)', async () => {
    const topRow = {
      id: 'post_1',
      authorHandle: '@k',
      authorName: 'K',
      authorAvatar: '/avatars/3.webp',
      content: 'top',
      createdAt: 200,
      likes: 0,
      likedByMe: false,
      replyCount: 1,
      parentId: null,
    };
    const replyRow = { ...topRow, id: 'post_2', content: 'reply', parentId: 'post_1', createdAt: 201 };
    installTauriDb((command, args) => {
      if (command === `${DB}db_kv_get`) {
        if (args?.key === 'migration:v1:completed') return 'true';
        if (args?.key === 'timeline:likedIds') return JSON.stringify(['seed-1']);
        return null;
      }
      if (command === `${DB}db_get_timeline_posts`) {
        return args?.parentId ? [replyRow] : [topRow];
      }
      return null;
    });

    const state = await loadTimelineState();
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]).toEqual({
      id: 'post_1',
      authorName: 'K',
      authorHandle: '@k',
      avatar: '/avatars/3.webp',
      message: 'top',
      createdAt: 200,
    });
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]).toMatchObject({ id: 'post_2', postId: 'post_1', text: 'reply' });
    expect(state.likedIds).toEqual(['seed-1']);
  });

  it('reads the timeline from localStorage in the browser (no IPC)', async () => {
    const calls = installTauriDb(() => null);
    // Browser build: drop the Tauri runtime so the store takes the localStorage
    // path, while `calls` still proves no database command was sent.
    delete internals().__TAURI_INTERNALS__;
    localStorage.setItem(
      'entei.timeline.v1',
      JSON.stringify({
        schemaVersion: 1,
        posts: [
          {
            id: 'local-1',
            authorName: 'K',
            authorHandle: '@k',
            avatar: '/avatars/3.webp',
            message: 'browser post',
            createdAt: 1,
          },
        ],
        likedIds: ['seed-2'],
        comments: [],
      }),
    );

    const state = await loadTimelineState();
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]!.message).toBe('browser post');
    expect(state.likedIds).toEqual(['seed-2']);
    // The browser path never touches the database bridge.
    expect(calls).toEqual([]);
  });
});

describe('runDatabaseMigrationV1', () => {
  it('is a no-op outside Tauri (no IPC)', async () => {
    const calls = installTauriDb(() => null);
    delete internals().__TAURI_INTERNALS__;
    await runDatabaseMigrationV1();
    expect(calls).toEqual([]);
  });

  it('imports the browser-era timeline + profile and sets the completion flag', async () => {
    localStorage.setItem(
      'entei.timeline.v1',
      JSON.stringify({
        schemaVersion: 1,
        posts: [
          {
            id: 'local-1',
            authorName: 'Kitsune',
            authorHandle: '@kitsune',
            avatar: '/avatars/3.webp',
            message: 'imported',
            createdAt: 100,
          },
        ],
        likedIds: ['seed-1', 'local-1'],
        comments: [
          {
            id: 'reply-1',
            postId: 'local-1',
            author: { name: 'Y', handle: '@y', avatar: '/avatars/7.webp' },
            text: 'a reply',
            createdAt: 101,
          },
        ],
      }),
    );
    localStorage.setItem(
      'entei.profile.v1',
      JSON.stringify({ schemaVersion: 1, name: 'Kitsune', bio: 'bio', avatar: '/avatars/3.webp' }),
    );

    const calls = installTauriDb((command) => {
      // Not yet migrated.
      if (command === `${DB}db_kv_get`) return null;
      return null;
    });

    await runDatabaseMigrationV1();

    const migrate = calls.find((c) => c.command === `${DB}db_migrate_v1`);
    expect(migrate).toBeDefined();
    const payload = migrate!.args!.payload as {
      posts: Array<Record<string, unknown>>;
      profile: Record<string, unknown> | null;
      kv: Array<{ key: string; value: string }>;
    };
    // The user post + the stored reply both land in timeline_posts.
    expect(payload.posts.map((p) => p.id)).toEqual(['local-1', 'reply-1']);
    expect(payload.posts[1]).toMatchObject({ parentId: 'local-1', content: 'a reply' });
    // The profile row is derived from the local profile.
    expect(payload.profile).toMatchObject({ displayName: 'Kitsune', bio: 'bio' });
    // The liked-id array is preserved wholesale in the key/value store.
    expect(payload.kv).toContainEqual({
      key: 'timeline:likedIds',
      value: JSON.stringify(['seed-1', 'local-1']),
    });
    // The completion flag is written last.
    const flag = calls.find((c) => c.command === `${DB}db_kv_set`);
    expect(flag!.args).toEqual({ key: 'migration:v1:completed', value: 'true' });
  });

  it('skips the import when the completion flag is already set', async () => {
    const calls = installTauriDb((command) => {
      if (command === `${DB}db_kv_get`) return 'true';
      return null;
    });

    await runDatabaseMigrationV1();

    expect(calls.some((c) => c.command === `${DB}db_migrate_v1`)).toBe(false);
    expect(calls.some((c) => c.command === `${DB}db_kv_set`)).toBe(false);
  });
});
