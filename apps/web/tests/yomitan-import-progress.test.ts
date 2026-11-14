/**
 * onYomitanImportProgress — the native import's progress subscription.
 * ---------------------------------------------------------------------------
 * The Rust importer (`plugins/tauri-plugin-modules`) publishes one event per
 * bank it writes; the settings list shows that percent as a placeholder row.
 * What this covers is the part that fails silently in a browser-shaped
 * environment:
 *
 * - a raw IPC payload is coerced or dropped (a percent is rendered and drives a
 *   bar width, so a malformed one must never reach the UI)
 * - outside the desktop runtime the subscription is a no-op, not a throw
 * - inside it, the handler registered with the event plugin is the one that
 *   reaches the callback, and unsubscribing unregisters it
 */

import { afterEach, describe, expect, it, vi } from 'bun:test';
import {
  onYomitanImportProgress,
  parseYomitanImportProgress,
} from '../src/features/player/tauri-bridge';

type EventHandler = (event: { event: string; id: number; payload: unknown }) => void;

interface InternalsWindow {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    transformCallback?: (callback: EventHandler, once?: boolean) => number;
  };
  __TAURI_EVENT_PLUGIN_INTERNALS__?: {
    unregisterListener: (event: string, eventId: number) => void;
  };
}

function internals(): InternalsWindow {
  return globalThis as unknown as InternalsWindow;
}

/** Installs the internals `@tauri-apps/api/event` needs, and records its calls. */
function installEventRuntime(): {
  calls: { command: string; args: Record<string, unknown> | undefined }[];
  handlers: EventHandler[];
  unregistered: { event: string; eventId: number }[];
} {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const handlers: EventHandler[] = [];
  const unregistered: { event: string; eventId: number }[] = [];
  internals().__TAURI_INTERNALS__ = {
    transformCallback: (callback: EventHandler) => {
      handlers.push(callback);
      return handlers.length - 1;
    },
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === 'plugin:event|listen') return 1;
      return null;
    },
  };
  internals().__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, eventId: number) => {
      unregistered.push({ event, eventId });
    },
  };
  return { calls, handlers, unregistered };
}

/** Poll until `check` holds — the event API is imported dynamically. */
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

afterEach(() => {
  delete internals().__TAURI_INTERNALS__;
  delete internals().__TAURI_EVENT_PLUGIN_INTERNALS__;
  vi.restoreAllMocks();
});

describe('parseYomitanImportProgress', () => {
  it('keeps a whole percent and the bank counters', () => {
    expect(parseYomitanImportProgress({ percent: 27, current: 27, total: 100 })).toEqual({
      percent: 27,
      current: 27,
      total: 100,
    });
  });

  it('clamps a percent into 0–100 and rounds it', () => {
    expect(parseYomitanImportProgress({ percent: 33.6 })?.percent).toBe(34);
    expect(parseYomitanImportProgress({ percent: 140 })?.percent).toBe(100);
    expect(parseYomitanImportProgress({ percent: -5 })?.percent).toBe(0);
  });

  it('rejects anything that is not a payload with a finite percent', () => {
    for (const raw of [
      null,
      undefined,
      'percent',
      27,
      {},
      { percent: '27' },
      { percent: Number.NaN },
      { percent: Number.POSITIVE_INFINITY },
    ]) {
      expect(parseYomitanImportProgress(raw)).toBeNull();
    }
  });
});

describe('onYomitanImportProgress', () => {
  it('is a no-op outside the desktop runtime', async () => {
    delete internals().__TAURI_INTERNALS__;
    const callback = vi.fn();

    const stop = onYomitanImportProgress(callback);
    stop();

    expect(callback).not.toHaveBeenCalled();
  });

  it('delivers the registered event handler payload to the callback', async () => {
    const { calls, handlers } = installEventRuntime();
    const seen: number[] = [];
    const stop = onYomitanImportProgress((p) => seen.push(p.percent));

    await until(() => calls.some((c) => c.command === 'plugin:event|listen'), 'listen');

    const listen = calls.find((c) => c.command === 'plugin:event|listen');
    expect(listen?.args?.event).toBe('yomitan:import-progress');

    handlers[0]?.({ event: 'yomitan:import-progress', id: 1, payload: { percent: 27, current: 27, total: 100 } });
    handlers[0]?.({ event: 'yomitan:import-progress', id: 1, payload: { percent: 'nope' } });
    handlers[0]?.({ event: 'yomitan:import-progress', id: 1, payload: { percent: 60 } });

    expect(seen).toEqual([27, 60]);
    stop();
  });

  it('unlistens when the caller unsubscribes', async () => {
    const { calls, unregistered } = installEventRuntime();
    const stop = onYomitanImportProgress(() => {});

    await until(() => calls.some((c) => c.command === 'plugin:event|listen'), 'listen');
    stop();

    await until(() => unregistered.length > 0, 'unlisten');
    expect(unregistered).toEqual([
      { event: 'yomitan:import-progress', eventId: 1 },
    ]);
    expect(calls.map((c) => c.command)).toContain('plugin:event|unlisten');
  });

  it('unlistens a subscription cancelled before it resolved', async () => {
    const { unregistered } = installEventRuntime();
    const stop = onYomitanImportProgress(() => {});
    stop();

    await until(() => unregistered.length > 0, 'unlisten after an immediate stop');
    expect(unregistered).toHaveLength(1);
  });
});