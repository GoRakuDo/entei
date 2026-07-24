/**
 * AnkiFieldsTab lifecycle integration tests
 * ---------------------------------------------------------------------------
 * Tests the auto-connect, retry, cleanup, and endpoint-change behavior
 * of AnkiFieldsTab using React Testing Library with mocked fetch and
 * fake timers.
 * --------------------------------------------------------------------------- */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import { AnkiFieldsTab } from '../src/components/player/AnkiFieldsTab';
import type { Dictionary } from '../src/i18n/types';
import { dictionaries } from '../src/i18n';

// Use the real en dictionary as a base
const dict: Dictionary['playerUI'] = dictionaries.en.playerUI;

// Helper to build a valid AnkiConnect response: { result, error: null }
function ankiResult(result: unknown) {
  return { result, error: null };
}

// Helper to build an AnkiConnect error response: { result: null, error }
function ankiError(message: string) {
  return { result: null, error: message };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('AnkiFieldsTab lifecycle integration', () => {
  it('attempts connection after preferences load (mount)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(ankiResult(6)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy;

    await act(async () => {
      render(createElement(AnkiFieldsTab, { dict }));
    });

    await act(async () => {
      vi.runAllTicks();
    });

    expect(fetchSpy).toHaveBeenCalled();
  });

  it('retries after exactly 10s on failure', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(ankiError('unreachable')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy;

    await act(async () => {
      render(createElement(AnkiFieldsTab, { dict }));
    });

    await act(async () => {
      vi.runAllTicks();
    });

    const initialCalls = fetchSpy.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    // 9s — should NOT retry yet
    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    await act(async () => {
      vi.runAllTicks();
    });
    expect(fetchSpy.mock.calls.length).toBe(initialCalls);

    // 10s — should retry
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {
      vi.runAllTicks();
    });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('success stops retry and clears error', async () => {
    let failFirstAttempt = true;
    const fetchSpy = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        if (failFirstAttempt) {
          failFirstAttempt = false;
          return Promise.resolve(
            new Response(JSON.stringify(ankiError('unreachable')), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        // Parse request body to return appropriate response per action
        let action = 'version';
        try {
          const body = JSON.parse(init?.body as string);
          action = body.action;
        } catch {
          // default to version
        }
        switch (action) {
          case 'version':
            return Promise.resolve(
              new Response(JSON.stringify(ankiResult(6)), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          case 'requestPermission':
            return Promise.resolve(
              new Response(
                JSON.stringify(ankiResult({ permission: 'granted' })),
                {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                },
              ),
            );
          case 'deckNames':
            return Promise.resolve(
              new Response(JSON.stringify(ankiResult(['Japanese'])), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          case 'modelNames':
            return Promise.resolve(
              new Response(JSON.stringify(ankiResult(['Basic'])), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          default:
            return Promise.resolve(
              new Response(JSON.stringify(ankiError('unknown')), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
        }
      });
    global.fetch = fetchSpy;

    await act(async () => {
      render(createElement(AnkiFieldsTab, { dict }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchSpy).toHaveBeenCalled();
    const callsAfterFirstFail = fetchSpy.mock.calls.length;

    // Wait for retry (10s) then flush all async resolution including the
    // sequential connection flow (version → permission → decks → models).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The retry fired and succeeded
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterFirstFail);

    // Verify the connection flow completed by flushing more microtasks
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    const countAfterSuccess = fetchSpy.mock.calls.length;

    // Wait 30 seconds (3 full retry cycles) then flush all microtasks
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    // Exact equality: success stopped retry, no additional fetches
    expect(fetchSpy.mock.calls.length).toBe(countAfterSuccess);
  });

  it('unmount prevents subsequent retry', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(ankiError('unreachable')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchSpy;

    const { unmount } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });

    await act(async () => {
      vi.runAllTicks();
    });

    const callsBeforeUnmount = fetchSpy.mock.calls.length;
    expect(callsBeforeUnmount).toBeGreaterThanOrEqual(1);

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(15000);
    });
    await act(async () => {
      vi.runAllTicks();
    });

    expect(fetchSpy.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it('endpoint change starts new connection attempt', async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve(
              new Response(JSON.stringify(ankiError('unreachable')), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          }, 5000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
          });
        });
      });
    global.fetch = fetchSpy;

    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });

    await act(async () => {
      vi.runAllTicks();
    });

    const endpointInput = container.querySelector(
      '#anki-endpoint',
    ) as HTMLInputElement;
    expect(endpointInput).toBeTruthy();

    const callsBefore = fetchSpy.mock.calls.length;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(endpointInput, 'http://new-host:8765');
      endpointInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      vi.runAllTicks();
    });

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
