// SPDX-License-Identifier: MIT
// mkvgo loader unit tests: the init-timeout on a never-registering wasm,
// cache recovery after a failed load, the singleton reuse on success, and
// the wasm_exec.js single-injection guard. The wasm module itself is never
// loaded — WebAssembly.instantiateStreaming and the Go global are stubbed.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/** Minimal stand-in for the Go class wasm_exec.js installs on globalThis. */
class TestGo {
  importObject: WebAssembly.Imports = {};
  run(_instance: WebAssembly.Instance): void {
    // no-op — the real runtime boots the wasm module
  }
}

/** Minimal mkvgo API surface the loader hands back once MkvGo is set. */
const testApi = { version: () => 'test' };

beforeEach(() => {
  // Node's fetch rejects relative URLs during argument evaluation, so stub
  // it out: instantiateStreaming is mocked and ignores its input anyway.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      arrayBuffer: async () => new ArrayBuffer(0),
    })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('loadMkvGo', () => {
  it('rejects when MkvGo is never registered (init timeout, not a busy-wait)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Go', TestGo);
    vi.stubGlobal('MkvGo', undefined);
    vi.spyOn(WebAssembly, 'instantiateStreaming').mockResolvedValue({
      instance: {},
    } as unknown as WebAssembly.WebAssemblyInstantiatedSource);

    const { loadMkvGo } = await import('@/features/player/mkvgo');
    const loading = loadMkvGo({ wasmUrl: '/wasm/mkvgo.wasm' });
    // Attach the assertion before advancing timers so the rejection is
    // handled the moment the deadline fires (no unhandled rejection).
    const assertion = expect(loading).rejects.toThrow('mkvgo: init timed out');
    // Advance past the 30s deadline: the polling loop must fail instead of
    // spinning forever (a little margin so the post-deadline check runs).
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });

  it('clears the cached promise on failure so a later call can retry', async () => {
    vi.stubGlobal('Go', TestGo);
    vi.stubGlobal('MkvGo', testApi);
    const instantiate = vi
      .spyOn(WebAssembly, 'instantiateStreaming')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        instance: {},
      } as unknown as WebAssembly.WebAssemblyInstantiatedSource);

    const { loadMkvGo } = await import('@/features/player/mkvgo');
    await expect(loadMkvGo({ wasmUrl: '/wasm/mkvgo.wasm' })).rejects.toThrow(
      'network down',
    );
    // Second call retries (the cached rejection was cleared) and succeeds.
    await expect(loadMkvGo({ wasmUrl: '/wasm/mkvgo.wasm' })).resolves.toBe(
      testApi,
    );
    expect(instantiate).toHaveBeenCalledTimes(2);
  });

  it('returns the same instance for repeated calls (singleton)', async () => {
    vi.stubGlobal('Go', TestGo);
    vi.stubGlobal('MkvGo', testApi);
    const instantiate = vi
      .spyOn(WebAssembly, 'instantiateStreaming')
      .mockResolvedValue({
        instance: {},
      } as unknown as WebAssembly.WebAssemblyInstantiatedSource);

    const { loadMkvGo } = await import('@/features/player/mkvgo');
    const first = await loadMkvGo({ wasmUrl: '/wasm/mkvgo.wasm' });
    const second = await loadMkvGo({ wasmUrl: '/wasm/mkvgo.wasm' });
    expect(first).toBe(testApi);
    expect(second).toBe(first);
    expect(instantiate).toHaveBeenCalledTimes(1);
  });
});

describe('injectScript guard', () => {
  it('injects exactly one script per src, re-injecting after a failed load', async () => {
    vi.stubGlobal('MkvGo', testApi);
    // Go is undefined: wasm_exec.js has not run yet → injectScript path.
    vi.stubGlobal('Go', undefined);

    const appended: HTMLScriptElement[] = [];
    let attempt = 0;
    const originalAppend = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation(
      (node: Node) => {
        const el = node as HTMLScriptElement;
        appended.push(el);
        originalAppend(el);
        attempt += 1;
        // jsdom never fetches external scripts, so drive the element's load
        // lifecycle manually. First attempt fails; the retry succeeds and
        // registers the Go global wasm_exec.js would install.
        queueMicrotask(() => {
          if (attempt === 1) {
            el.dispatchEvent(new Event('error'));
          } else {
            vi.stubGlobal('Go', TestGo);
            el.dispatchEvent(new Event('load'));
          }
        });
        return el;
      },
    );
    vi.spyOn(WebAssembly, 'instantiateStreaming').mockResolvedValue({
      instance: {},
    } as unknown as WebAssembly.WebAssemblyInstantiatedSource);

    const { loadMkvGo } = await import('@/features/player/mkvgo');
    const opts = {
      wasmUrl: '/wasm/mkvgo.wasm',
      wasmExecUrl: '/wasm/wasm_exec.js',
    };
    await expect(loadMkvGo(opts)).rejects.toThrow('failed to load');
    // The failed element was removed and dropped from the dedup map, so the
    // retry injects a fresh script instead of stacking a second copy.
    await expect(loadMkvGo(opts)).resolves.toBe(testApi);
    expect(appended).toHaveLength(2);
    expect(
      document.head.querySelectorAll('script[src="/wasm/wasm_exec.js"]'),
    ).toHaveLength(1);
  });
});
