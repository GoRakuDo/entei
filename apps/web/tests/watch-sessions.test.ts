import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openTrackerDB } from '@/features/player/tracker/db';
import {
  getPlaybackWatchDeltaMs,
  getWatchSessionsForMedia,
  putWatchSession,
  type WatchSessionRecord,
} from '@/features/player/watch-sessions';

vi.mock('@/features/player/tracker/db', () => ({
  openTrackerDB: vi.fn(),
}));

function makeRequest<T>(read: () => T): IDBRequest<T> {
  const request = {
    result: undefined as T,
    error: null,
    onsuccess: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
  };
  queueMicrotask(() => {
    request.result = read();
    request.onsuccess?.(new Event('success'));
  });
  return request as unknown as IDBRequest<T>;
}

function createFakeTrackerDb(): IDBDatabase {
  const records = new Map<string, WatchSessionRecord>();
  const store = {
    put(record: WatchSessionRecord) {
      records.set(record.sessionId, record);
      return makeRequest(() => record.sessionId) as unknown as IDBRequest<IDBValidKey>;
    },
    getAll() {
      return makeRequest(() => [...records.values()]) as unknown as IDBRequest;
    },
  } as unknown as IDBObjectStore;

  return {
    transaction() {
      const tx = {
        objectStore: () => store,
        oncomplete: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onabort: null as ((event: Event) => void) | null,
      };
      setTimeout(() => tx.oncomplete?.(new Event('complete')), 0);
      return tx;
    },
  } as unknown as IDBDatabase;
}

const openTrackerDbMock = vi.mocked(openTrackerDB);
let fakeDb: IDBDatabase;

beforeEach(() => {
  // The DB open is mocked below, but the shared data layer still checks the
  // browser IndexedDB global before using the injected fake database.
  vi.stubGlobal('indexedDB', {});
  fakeDb = createFakeTrackerDb();
  openTrackerDbMock.mockResolvedValue(fakeDb);
});

describe('watch session playback timing', () => {
  it('counts only a normal forward playback delta', () => {
    expect(getPlaybackWatchDeltaMs(10, 10.75)).toBe(750);
  });

  it('ignores the first sample, seeks, and stale gaps', () => {
    expect(getPlaybackWatchDeltaMs(null, 1)).toBe(0);
    expect(getPlaybackWatchDeltaMs(10, 4)).toBe(0);
    expect(getPlaybackWatchDeltaMs(10, 20)).toBe(0);
  });
});

describe('audio watch session lifecycle', () => {
  it.each([
    ['leave', 1_000, 8_000],
    ['pagehide', 2_000, 9_000],
    ['refresh', 3_000, 10_000],
    ['file replacement', 4_000, 11_000],
  ])('persists an audio session at the %s boundary', async (boundary, startedAt, endedAt) => {
    const record: WatchSessionRecord = {
      sessionId: `audio-session-${boundary.replace(' ', '-')}`,
      mediaId: 'audio-fingerprint-1',
      startedAt,
      endedAt,
      watchMs: endedAt - startedAt,
      episode: null,
      minedSentences: [],
    };

    expect(await putWatchSession(record)).toBe(true);
    await expect(getWatchSessionsForMedia('audio-fingerprint-1')).resolves.toEqual([
      record,
    ]);
  });
});
