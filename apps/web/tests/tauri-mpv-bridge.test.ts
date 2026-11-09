/**
 * tauri-bridge — `plugin:mpv` wrappers (desktop native engine)
 * ---------------------------------------------------------------------------
 * The desktop build mirrors Player playback into libmpv through six IPC
 * commands. These tests pin two contracts that the Player depends on:
 *
 * 1. the exact command id and argument shape of every wrapper (a typo here
 *    fails silently in production, because rejections are swallowed);
 * 2. the hard no-op outside Tauri — the standalone browser build must never
 *    touch `window.__TAURI_INTERNALS__`, throw, or log.
 *
 * No real Tauri runtime, mpv binary or media is involved.
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, afterEach } from 'bun:test';
import { captureVideoFrame } from '@/features/player/screenshot-capture';
import {
  DROP_PATH_TTL_MS,
  captureVideoFrameDirect,
  installTauriDragDropPaths,
  isMpvResolvableSource,
  isTauri,
  matchPhysicalPath,
  mpvLoad,
  mpvPause,
  mpvPlay,
  mpvSeek,
  mpvScreenshot,
  mpvSetBounds,
  mpvSetSubDelay,
  setMpvNativeActive,
  setMpvNativeLoading,
  mpvSetTracks,
  resolvePhysicalPath,
} from '@/features/player/tauri-bridge';

type InvokeCall = { cmd: string; args: Record<string, unknown> | undefined };

interface InternalsWindow {
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

/**
 * The Tauri runtime object, read lazily from `globalThis`.
 *
 * A module-load `window` reference throws `ReferenceError: window is not
 * defined` when the file is imported by a runner that has no DOM global (for
 * example a bare `bun test` outside `apps/web`, where `bunfig.toml` and its
 * `environment = "jsdom"` are not loaded). `globalThis` always exists, so the
 * import stays clean and a missing DOM only affects the assertions.
 */
function internals(): InternalsWindow {
  return globalThis as unknown as InternalsWindow;
}

/** Install a fake Tauri IPC bridge and record every call it receives. */
function installTauri(
  impl: (cmd: string, args?: Record<string, unknown>) => unknown = () => null,
): InvokeCall[] {
  const calls: InvokeCall[] = [];
  internals().__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return impl(cmd, args);
    }),
  };
  return calls;
}

function uninstallTauri(): void {
  delete internals().__TAURI_INTERNALS__;
}

afterEach(() => {
  uninstallTauri();
});

describe('tauri-bridge mpv wrappers — outside Tauri', () => {
  it('reports isTauri() as false with no injected runtime', () => {
    expect(isTauri()).toBe(false);
  });

  it('no-ops every wrapper without touching the IPC bridge', async () => {
    // A browser build has no `__TAURI_INTERNALS__` at all: reading `.invoke`
    // off the missing object must not throw.
    expect(isTauri()).toBe(false);

    await expect(
      mpvLoad('http://127.0.0.1:5000/stream/a'),
    ).resolves.toBeUndefined();
    await expect(mpvPlay()).resolves.toBeUndefined();
    await expect(mpvPause()).resolves.toBeUndefined();
    await expect(mpvSeek(12.5)).resolves.toBeUndefined();
    await expect(mpvScreenshot()).rejects.toThrow('tauri runtime unavailable');
    await expect(captureVideoFrameDirect(null)).resolves.toMatchObject({
      ok: false,
      error: { code: 'VIDEO_UNAVAILABLE' },
    });
    await expect(mpvSetSubDelay(-0.25)).resolves.toBeUndefined();
    await expect(mpvSetTracks('2', '1')).resolves.toBeUndefined();
    await expect(mpvSetBounds(0, 0, 320, 180)).resolves.toBeUndefined();

    expect(internals().__TAURI_INTERNALS__).toBeUndefined();
  });

  it('does not invoke anything when the runtime object exists without invoke', async () => {
    // Defensive shape: a partially injected runtime must still be a no-op.
    internals().__TAURI_INTERNALS__ =
      {} as InternalsWindow['__TAURI_INTERNALS__'];
    await expect(mpvPlay()).resolves.toBeUndefined();
    await expect(mpvScreenshot()).rejects.toThrow('tauri runtime unavailable');
  });
});

describe('tauri-bridge mpv wrappers — inside Tauri', () => {
  it('captures native screenshots with the selected mode', async () => {
    const calls = installTauri(() => 'data:image/jpeg;base64,/9j/2Q==');
    setMpvNativeActive(true);
    try {
      await expect(mpvScreenshot('subtitles')).resolves.toBe(
        'data:image/jpeg;base64,/9j/2Q==',
      );
      expect(calls).toEqual([
        { cmd: 'plugin:mpv|mpv_screenshot', args: { mode: 'subtitles' } },
      ]);
    } finally {
      setMpvNativeActive(false);
    }
  });

  it('falls back cleanly when native screenshot capture fails', async () => {
    const calls = installTauri(() => {
      throw new Error('mpv has no loaded media');
    });
    setMpvNativeActive(true);
    try {
      await expect(captureVideoFrameDirect(null)).resolves.toMatchObject({
        ok: false,
        error: { code: 'VIDEO_UNAVAILABLE' },
      });
      expect(calls).toEqual([
        { cmd: 'plugin:mpv|mpv_screenshot', args: { mode: 'video' } },
      ]);
    } finally {
      setMpvNativeActive(false);
    }
  });

  it('routes default screenshot capture through native mpv while active', async () => {
    const blob = new Blob(['native-jpeg'], { type: 'image/jpeg' });
    const calls = installTauri(() => 'data:image/jpeg;base64,/9j/2Q==');
    const originalFetch = globalThis.fetch;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      blob: async () => blob,
    })) as unknown as typeof fetch;
    globalThis.createImageBitmap = vi.fn(async () => ({
      width: 1280,
      height: 720,
      close: vi.fn(),
    })) as unknown as typeof createImageBitmap;
    setMpvNativeActive(true);
    try {
      const result = await captureVideoFrame({} as HTMLVideoElement);
      expect(result).toEqual({ ok: true, blob });
      expect(calls).toEqual([
        { cmd: 'plugin:mpv|mpv_screenshot', args: { mode: 'video' } },
      ]);
    } finally {
      setMpvNativeActive(false);
      globalThis.fetch = originalFetch;
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
  });

  it('resizes oversized native mpv screenshots before returning the Blob', async () => {
    const nativeBlob = new Blob(['native-jpeg'], { type: 'image/jpeg' });
    const resizedBlob = new Blob(['resized-jpeg'], { type: 'image/jpeg' });
    const calls = installTauri(() => 'data:image/jpeg;base64,/9j/2Q==');
    const originalFetch = globalThis.fetch;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const drawImage = vi.fn();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      blob: async () => nativeBlob,
    })) as unknown as typeof fetch;
    globalThis.createImageBitmap = vi.fn(async () => ({
      width: 3840,
      height: 2160,
      close: vi.fn(),
    })) as unknown as typeof createImageBitmap;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage,
    })) as unknown as HTMLCanvasElement['getContext'];
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback) =>
      callback?.(resizedBlob),
    );
    setMpvNativeActive(true);
    try {
      const result = await captureVideoFrameDirect(null);
      expect(result).toEqual({ ok: true, blob: resizedBlob });
      expect(drawImage).toHaveBeenCalledWith(
        expect.objectContaining({ width: 3840, height: 2160 }),
        0,
        0,
        1920,
        1080,
      );
      expect(calls).toEqual([
        { cmd: 'plugin:mpv|mpv_screenshot', args: { mode: 'video' } },
      ]);
    } finally {
      setMpvNativeActive(false);
      setMpvNativeLoading(false);
      globalThis.fetch = originalFetch;
      globalThis.createImageBitmap = originalCreateImageBitmap;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
    }
  });

  it('does not capture a stale HTML frame while native media is loading', async () => {
    const calls = installTauri(() => 'data:image/jpeg;base64,/9j/2Q==');
    setMpvNativeLoading(true);
    setMpvNativeActive(false);
    try {
      await expect(captureVideoFrameDirect(null)).resolves.toMatchObject({
        ok: false,
        error: { code: 'VIDEO_UNAVAILABLE' },
      });
      expect(calls).toEqual([]);
    } finally {
      setMpvNativeLoading(false);
    }
  });

  it('discards a native screenshot if the media changes during capture', async () => {
    const blob = new Blob(['native-jpeg'], { type: 'image/jpeg' });
    const calls = installTauri(() => 'data:image/jpeg;base64,/9j/2Q==');
    const originalFetch = globalThis.fetch;
    let resolveFetch!: (response: {
      ok: boolean;
      blob: () => Promise<Blob>;
    }) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    globalThis.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
          markFetchStarted();
        }),
    ) as unknown as typeof fetch;
    setMpvNativeLoading(false);
    setMpvNativeActive(true);
    try {
      const capture = captureVideoFrameDirect(null);
      await fetchStarted;
      setMpvNativeLoading(true);
      resolveFetch({ ok: true, blob: async () => blob });
      await expect(capture).resolves.toMatchObject({
        ok: false,
        error: { code: 'VIDEO_UNAVAILABLE' },
      });
      expect(calls).toEqual([
        { cmd: 'plugin:mpv|mpv_screenshot', args: { mode: 'video' } },
      ]);
    } finally {
      setMpvNativeLoading(false);
      setMpvNativeActive(false);
      globalThis.fetch = originalFetch;
    }
  });

  it('captures a frame from native mpv and returns the decoded Blob', async () => {
    const blob = new Blob(['native-jpeg'], { type: 'image/jpeg' });
    const calls = installTauri(() => 'data:image/jpeg;base64,/9j/2Q==');
    const originalFetch = globalThis.fetch;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      blob: async () => blob,
    })) as unknown as typeof fetch;
    globalThis.createImageBitmap = vi.fn(async () => ({
      width: 1280,
      height: 720,
      close: vi.fn(),
    })) as unknown as typeof createImageBitmap;
    setMpvNativeActive(true);
    try {
      const result = await captureVideoFrameDirect(null);
      expect(result).toEqual({ ok: true, blob });
      expect(calls).toEqual([
        { cmd: 'plugin:mpv|mpv_screenshot', args: { mode: 'video' } },
      ]);
    } finally {
      setMpvNativeActive(false);
      globalThis.fetch = originalFetch;
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
  });

  it('loads a source with { url }', async () => {
    const calls = installTauri();
    expect(isTauri()).toBe(true);

    await mpvLoad('http://127.0.0.1:51234/stream/session-1');

    expect(calls).toEqual([
      {
        cmd: 'plugin:mpv|mpv_load',
        args: { url: 'http://127.0.0.1:51234/stream/session-1' },
      },
    ]);
  });

  it('skips the load for an empty url', async () => {
    const calls = installTauri();
    await mpvLoad('');
    expect(calls).toEqual([]);
  });

  it('skips blob: sources, which mpv cannot resolve', async () => {
    // A local file pick reaches the Player as an object URL. `loadfile …
    // replace` would reset the engine's state for a source it can never open.
    const calls = installTauri();
    expect(isMpvResolvableSource('blob:http://localhost/uuid-1')).toBe(false);
    await mpvLoad('blob:http://localhost/uuid-1');
    expect(calls).toEqual([]);
  });

  it('keeps http(s) relay urls and real file paths eligible', () => {
    expect(isMpvResolvableSource('http://127.0.0.1:51234/stream/s1')).toBe(
      true,
    );
    expect(isMpvResolvableSource('https://example.test/v.mp4')).toBe(true);
    expect(isMpvResolvableSource('D:\\Media\\Show 01.mkv')).toBe(true);
    expect(isMpvResolvableSource('')).toBe(false);
  });

  it('plays and pauses with no arguments', async () => {
    const calls = installTauri();

    await mpvPlay();
    await mpvPause();

    expect(calls.map((call) => call.cmd)).toEqual([
      'plugin:mpv|mpv_play',
      'plugin:mpv|mpv_pause',
    ]);
    // Both commands take no payload; the wrapper must not invent one.
    expect(calls[0]?.args).toBeUndefined();
    expect(calls[1]?.args).toBeUndefined();
  });

  it('seeks to an absolute position with { seconds }', async () => {
    const calls = installTauri();
    await mpvSeek(93.75);
    expect(calls).toEqual([
      { cmd: 'plugin:mpv|mpv_seek', args: { seconds: 93.75 } },
    ]);
  });

  it('drops non-finite seek targets instead of sending them', async () => {
    const calls = installTauri();
    await mpvSeek(Number.NaN);
    await mpvSeek(Number.POSITIVE_INFINITY);
    expect(calls).toEqual([]);
  });

  it('forwards the sub-delay in seconds without rounding or sign change', async () => {
    const calls = installTauri();
    await mpvSetSubDelay(-0.123);
    await mpvSetSubDelay(0);
    expect(calls).toEqual([
      { cmd: 'plugin:mpv|mpv_set_sub_delay', args: { seconds: -0.123 } },
      { cmd: 'plugin:mpv|mpv_set_sub_delay', args: { seconds: 0 } },
    ]);
  });

  it('drops a non-finite sub-delay', async () => {
    const calls = installTauri();
    await mpvSetSubDelay(Number.NaN);
    expect(calls).toEqual([]);
  });

  it('selects tracks with { aid, sid }', async () => {
    const calls = installTauri();
    await mpvSetTracks('2', '1');
    expect(calls).toEqual([
      { cmd: 'plugin:mpv|mpv_set_tracks', args: { aid: '2', sid: '1' } },
    ]);
  });

  it('normalizes a missing track to null so the engine keeps its own pick', async () => {
    const calls = installTauri();

    await mpvSetTracks('2');
    await mpvSetTracks(null, '3');
    await mpvSetTracks(undefined, undefined);

    expect(calls).toEqual([
      { cmd: 'plugin:mpv|mpv_set_tracks', args: { aid: '2', sid: null } },
      { cmd: 'plugin:mpv|mpv_set_tracks', args: { aid: null, sid: '3' } },
      { cmd: 'plugin:mpv|mpv_set_tracks', args: { aid: null, sid: null } },
    ]);
  });

  it('swallows a plugin rejection so HTML playback never breaks', async () => {
    installTauri(() => {
      // libmpv missing on the machine: every command rejects.
      throw new Error('libmpv unavailable');
    });

    await expect(
      mpvLoad('http://127.0.0.1:1/stream/x'),
    ).resolves.toBeUndefined();
    await expect(mpvPlay()).resolves.toBeUndefined();
    await expect(mpvPause()).resolves.toBeUndefined();
    await expect(mpvSeek(5)).resolves.toBeUndefined();
    await expect(mpvSetSubDelay(1.5)).resolves.toBeUndefined();
    await expect(mpvSetTracks('1', '1')).resolves.toBeUndefined();
    await expect(mpvSetBounds(0, 0, 640, 360)).resolves.toBeUndefined();
  });

  it('moves the native surface to the requested physical rectangle', async () => {
    const calls = installTauri();
    await mpvSetBounds(12, 8, 1024, 576);
    expect(calls).toEqual([
      {
        cmd: 'plugin:mpv|mpv_set_bounds',
        args: { x: 12, y: 8, width: 1024, height: 576 },
      },
    ]);
  });

  it('keeps an empty rectangle as a hide request', async () => {
    // A frame without area means "the media frame is gone": the surface must
    // be hidden, not resized to nothing.
    const calls = installTauri();
    await mpvSetBounds(0, 0, 0, 0);
    expect(calls).toEqual([
      {
        cmd: 'plugin:mpv|mpv_set_bounds',
        args: { x: 0, y: 0, width: 0, height: 0 },
      },
    ]);
  });

  it('drops a non-finite or negative surface rectangle', async () => {
    const calls = installTauri();
    await mpvSetBounds(Number.NaN, 0, 320, 180);
    await mpvSetBounds(0, Number.POSITIVE_INFINITY, 320, 180);
    await mpvSetBounds(0, 0, -1, 180);
    await mpvSetBounds(0, 0, 320, -1);
    expect(calls).toEqual([]);
  });
});

describe('tauri-bridge — absolute local paths', () => {
  it('never resolves a path outside Tauri, even with File.path injected', () => {
    const file = new File(['x'], 'Kimi no Na wa.mkv');
    Object.defineProperty(file, 'path', {
      value: 'Z:\\Anime\\Kimi no Na wa.mkv',
      configurable: true,
    });
    expect(resolvePhysicalPath(file)).toBeNull();
  });

  it('installTauriDragDropPaths is a no-op outside Tauri', () => {
    const off = installTauriDragDropPaths();
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });

  it('uses File.path when the Tauri runtime exposes it, without IPC', () => {
    const calls = installTauri();
    const file = new File(['x'], 'Kimi no Na wa.mkv');
    Object.defineProperty(file, 'path', {
      value: 'Z:\\Anime\\Kimi no Na wa.mkv',
      configurable: true,
    });
    expect(resolvePhysicalPath(file)).toBe('Z:\\Anime\\Kimi no Na wa.mkv');
    expect(calls).toEqual([]);
  });

  it('keeps an absolute Windows / UNC / POSIX path eligible for mpvLoad', () => {
    expect(isMpvResolvableSource('Z:\\Anime\\Kimi no Na wa.mkv')).toBe(true);
    expect(isMpvResolvableSource('\\\\NAS\\Anime\\ep01.mkv')).toBe(true);
    expect(isMpvResolvableSource('/mnt/nas/anime/ep01.mkv')).toBe(true);
    expect(isMpvResolvableSource('blob:http://localhost/uuid')).toBe(false);
  });

  it('matchPhysicalPath matches a dropped path by basename', () => {
    const file = new File(['x'], 'Kimi no Na wa.mkv');
    const paths = ['Z:\\Anime\\subs.ja.srt', 'Z:\\Anime\\Kimi no Na wa.mkv'];
    expect(matchPhysicalPath(file, paths, 1000, 900)).toBe(
      'Z:\\Anime\\Kimi no Na wa.mkv',
    );
  });

  it('matchPhysicalPath is case-insensitive on the file name', () => {
    const file = new File(['x'], 'KIMI NO NA WA.MKV');
    expect(
      matchPhysicalPath(file, ['Z:\\Anime\\kimi no na wa.mkv'], 1000, 900),
    ).toBe('Z:\\Anime\\kimi no na wa.mkv');
  });

  it('matchPhysicalPath accepts a lone dropped path with a renamed file', () => {
    const file = new File(['x'], 'renamed.mkv');
    expect(matchPhysicalPath(file, ['Z:\\Anime\\ep01.mkv'], 1000, 900)).toBe(
      'Z:\\Anime\\ep01.mkv',
    );
  });

  it('matchPhysicalPath refuses ambiguous multi-path drops and stale/empty drops', () => {
    const file = new File(['x'], 'unknown.mkv');
    const paths = ['Z:\\Anime\\a.mkv', 'Z:\\Anime\\b.mkv'];
    expect(matchPhysicalPath(file, paths, 1000, 900)).toBeNull();
    expect(matchPhysicalPath(file, [], 1000, 900)).toBeNull();
    expect(
      matchPhysicalPath(file, ['Z:\\Anime\\a.mkv'], DROP_PATH_TTL_MS + 1000, 0),
    ).toBeNull();
  });
});
