import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openTrackerDB } from '@/features/player/tracker/db';
import {
  AUDIO_POSTER_MAX_BYTES,
  computeAudioMediaId,
  createAudioPosterResolution,
  recordAudioWatchHistory,
} from '@/features/player/watch-history';

vi.mock('@/features/player/tracker/db', () => ({
  openTrackerDB: vi.fn(),
}));

type StoredRecord = Record<string, unknown>;

type FakeStoreName = 'meta' | 'watch_history' | 'watch_sessions';

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
  const records = new Map<FakeStoreName, Map<string, StoredRecord>>([
    ['meta', new Map()],
    ['watch_history', new Map()],
    ['watch_sessions', new Map()],
  ]);
  const keyFields: Record<FakeStoreName, string> = {
    meta: 'key',
    watch_history: 'mediaId',
    watch_sessions: 'sessionId',
  };

  const createStore = (name: FakeStoreName): IDBObjectStore => {
    const data = records.get(name)!;
    const keyField = keyFields[name];
    return {
      put(value: StoredRecord) {
        const key = value[keyField];
        if (typeof key !== 'string') throw new Error('missing fake key');
        data.set(key, value);
        return makeRequest(() => key) as unknown as IDBRequest<IDBValidKey>;
      },
      get(key: IDBValidKey) {
        return makeRequest(() => data.get(String(key))) as unknown as IDBRequest;
      },
      getAll() {
        return makeRequest(() => [...data.values()]) as unknown as IDBRequest;
      },
    } as unknown as IDBObjectStore;
  };

  return {
    transaction(name: string) {
      const tx = {
        objectStore: () => createStore(name as FakeStoreName),
        oncomplete: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onabort: null as ((event: Event) => void) | null,
      };
      setTimeout(() => tx.oncomplete?.(new Event('complete')), 0);
      return tx;
    },
  } as unknown as IDBDatabase;
}

const fakeDb = createFakeTrackerDb();
const openTrackerDbMock = vi.mocked(openTrackerDB);

beforeEach(() => {
  // The DB open is mocked below, but the shared data layer still checks the
  // browser IndexedDB global before using the injected fake database.
  vi.stubGlobal('indexedDB', {});
  openTrackerDbMock.mockResolvedValue(fakeDb);
});

describe('audio watch history data layer', () => {
  it('upserts one audio record by the Tracker fingerprint', async () => {
    const first = await recordAudioWatchHistory({
      mediaId: 'audio-fingerprint-1',
      fileName: 'fallback-name.m4b',
      metadataTitle: 'Metadata title',
      poster: { format: 'image/png', data: new Uint8Array([1, 2, 3]) },
    });
    const second = await recordAudioWatchHistory({
      mediaId: 'audio-fingerprint-1',
      fileName: 'replacement-name.m4b',
      metadataTitle: 'Updated metadata title',
    });

    expect(first).toMatchObject({
      mediaId: 'audio-fingerprint-1',
      title: 'Metadata title',
      episode: null,
      source: 'audio',
      posterStatus: 'ready',
    });
    expect(second).toMatchObject({
      mediaId: 'audio-fingerprint-1',
      title: 'Updated metadata title',
      episode: null,
      source: 'audio',
      posterUrl: null,
      posterStatus: 'none',
    });
  });

  it('uses the file name when audio metadata has no title', async () => {
    const record = await recordAudioWatchHistory({
      mediaId: 'audio-fingerprint-fallback',
      fileName: 'book-name.m4b',
      metadataTitle: '   ',
    });

    expect(record).toMatchObject({
      title: 'book-name.m4b',
      episode: null,
      source: 'audio',
      posterUrl: null,
      posterStatus: 'none',
    });
  });

  it('reuses the existing Tracker fingerprint for the same audio file', async () => {
    const file = new File([new Uint8Array([4, 5, 6, 7])], 'book.m4b', {
      type: 'audio/mp4',
    });

    const first = await computeAudioMediaId(file);
    const second = await computeAudioMediaId(file);

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(first).not.toBe('book.m4b');
  });
});

describe('audio poster persistence', () => {
  it('persists a bounded jacket as a reload-safe data URL', () => {
    const resolution = createAudioPosterResolution({
      format: 'image/jpeg',
      data: new Uint8Array([0, 1, 2, 255]),
    });

    expect(resolution.posterStatus).toBe('ready');
    expect(resolution.posterUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(resolution.posterUrl).not.toMatch(/^blob:/);
  });

  it('falls back to a title card when the jacket exceeds the byte cap', () => {
    const resolution = createAudioPosterResolution({
      format: 'image/png',
      data: new Uint8Array(AUDIO_POSTER_MAX_BYTES + 1),
    });

    expect(resolution).toEqual({ posterUrl: null, posterStatus: 'none' });
  });

  it('falls back for missing, invalid, and malformed jacket data', () => {
    expect(createAudioPosterResolution(null)).toEqual({
      posterUrl: null,
      posterStatus: 'none',
    });
    expect(
      createAudioPosterResolution({
        format: 'application/octet-stream',
        data: new Uint8Array([1]),
      }),
    ).toEqual({ posterUrl: null, posterStatus: 'none' });
    expect(
      createAudioPosterResolution({
        format: 'image/png',
        data: null as unknown as Uint8Array,
      }),
    ).toEqual({ posterUrl: null, posterStatus: 'none' });
  });
});
