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

// jsdom lacks scrollIntoView; Radix Select calls it when opening content.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

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

  // Helper: mock the full connection + modelFieldNames flow.
  function mockAnkiFlow(overrides?: {
    modelFieldNames?: Record<string, string[]>;
    slowModels?: string[];
  }) {
    const fieldMap = overrides?.modelFieldNames ?? {
      Basic: ['Front', 'Back'],
      Cloze: ['Text', 'Extra'],
    };
    const slowModels = overrides?.slowModels ?? [];
    return vi.fn().mockImplementation(
      /** fetch-implementation shape for the mocked AnkiConnect server */
      (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((resolve) => {
          if (init?.signal?.aborted) {
            resolve(
              new Response(JSON.stringify(ankiError('aborted')), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
            return;
          }
          let action = 'version';
          let modelName = '';
          try {
            const body = JSON.parse(init?.body as string);
            action = body.action;
            modelName = body.params?.modelName ?? '';
          } catch {
            // default to version
          }
          const respond = (result: unknown) =>
            new Response(JSON.stringify(ankiResult(result)), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          switch (action) {
            case 'version':
              resolve(respond(6));
              return;
            case 'requestPermission':
              resolve(respond({ permission: 'granted' }));
              return;
            case 'deckNames':
              resolve(respond(['Japanese', 'Spanish']));
              return;
            case 'modelNames':
              resolve(respond(['Basic', 'Cloze']));
              return;
            case 'modelFieldNames': {
              if (slowModels.includes(modelName)) {
                // Defer forever until aborted; the abort path above
                // resolves immediately with an error (dropped by epoch).
                return;
              }
              resolve(respond(fieldMap[modelName] ?? []));
              return;
            }
            default:
              resolve(
                new Response(JSON.stringify(ankiError('unknown')), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                }),
              );
              return;
          }
        }),
    );
  }

  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
  };

  const pickRadio = async (
    container: HTMLElement,
    selectIndex: number,
    optionText: string,
  ) => {
    // Radix Select renders a combobox per trigger, in DOM order:
    // 0 = Deck, 1 = Note type, then field rows (Sentence, Definition, ...).
    const trigger = Array.from(
      container.querySelectorAll('[role="combobox"]'),
    )[selectIndex];
    if (!trigger) throw new Error(`combobox #${selectIndex} not found`);
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const option = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (el) => el.textContent?.trim() === optionText,
    );
    if (!option) throw new Error(`option not found: ${optionText}`);
    await act(async () => {
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
  };

  const readStorage = (): {
    deck?: string | null;
    noteType?: string | null;
    tags?: string;
    fields?: { sentence?: string; definition?: string | null };
  } | null => {
    const raw = localStorage.getItem('entei.player.anki-miner.v1');
    return raw ? JSON.parse(raw) : null;
  };

  it('A: no localStorage write until deck + note type + sentence are all set', async () => {
    const fetchSpy = mockAnkiFlow();
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    // Deck only → nothing written
    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'Basic');
    expect(readStorage()).toBeNull();

    // Optional field only → still invalid (sentence missing)
    await pickRadio(container, 3, 'Back');
    expect(readStorage()).toBeNull();
  });

  it('B: first valid state (sentence selected) saves deck + note type + optional mapping', async () => {
    const fetchSpy = mockAnkiFlow();
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'Basic');
    await pickRadio(container, 3, 'Back');
    expect(readStorage()).toBeNull();

    await pickRadio(container, 2, 'Front');
    const saved = readStorage();
    expect(saved).not.toBeNull();
    expect(saved?.deck).toBe('Japanese');
    expect(saved?.noteType).toBe('Basic');
    expect(saved?.fields?.sentence).toBe('Front');
    expect(saved?.fields?.definition).toBe('Back');
  });

  it('C: changing deck after valid saves the new deck immediately', async () => {
    const fetchSpy = mockAnkiFlow();
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'Basic');
    await pickRadio(container, 2, 'Front');
    expect(readStorage()?.deck).toBe('Japanese');

    await pickRadio(container, 0, 'Spanish');
    expect(readStorage()?.deck).toBe('Spanish');
  });

  it('D: stale note-type fetch never saves; latest epoch sanitized snapshot only', async () => {
    const fetchSpy = mockAnkiFlow({ slowModels: ['Basic'] });
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    // Valid preset: deck + note type Cloze + sentence field
    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'Cloze');
    await pickRadio(container, 2, 'Text');
    expect(readStorage()?.noteType).toBe('Cloze');
    expect(readStorage()?.fields?.sentence).toBe('Text');

    // Now select Basic (slow fetch stays pending) then Cloze again.
    // Basic's deferred response never resolves → no save from it.
    await pickRadio(container, 1, 'Basic');
    await pickRadio(container, 1, 'Cloze');
    await flush();

    // Only the latest completed sanitized snapshot is persisted.
    const saved = readStorage();
    expect(saved?.noteType).toBe('Cloze');
    expect(saved?.fields?.sentence).toBe('Text');
  });

  it('E: deck change during a pending model fetch is suppressed (no unverified save)', async () => {
    const fetchSpy = mockAnkiFlow({ slowModels: ['Cloze'] });
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    // Valid preset first: deck Japanese + note type Basic + sentence Front.
    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'Basic');
    await pickRadio(container, 2, 'Front');
    expect(readStorage()?.deck).toBe('Japanese');

    // Start a slow note-type fetch (Cloze stays pending), then change the
    // deck to Spanish while the fetch is in flight. The new model's field
    // list has not resolved + sanitized, so the deck change must NOT be
    // persisted: a Spanish/Cloze/Front snapshot would mean the
    // resolvedModelRef gate is missing (review P1/P2).
    await pickRadio(container, 1, 'Cloze');
    await pickRadio(container, 0, 'Spanish');
    // Cloze fetch still pending here (deferred); flush microtasks more.
    await flush();

    // Storage must still hold the last VERIFIED preset (Japanese/Basic/
    // Front); the pending-Cloze deck change stayed un-saved.
    expect(readStorage()?.deck).toBe('Japanese');
    expect(readStorage()?.noteType).toBe('Basic');
    expect(readStorage()?.fields?.sentence).toBe('Front');
  });

  it('F: field change before model fields resolve is not saved; sanitized snapshot is', async () => {
    const fetchSpy = mockAnkiFlow({ slowModels: ['Cloze'] });
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'Basic');
    await pickRadio(container, 2, 'Front');
    expect(readStorage()?.fields?.sentence).toBe('Front');

    // Switch to Cloze (pending). Trying to set a field now must not save
    // the old model's mapping as the new model's state.
    await pickRadio(container, 1, 'Cloze');
    // Try to change the sentence field while Cloze is still pending.
    // The mapping grid still shows Basic's fields (Text/Extra not loaded),
    // so attempt to pick an option from the sentence combobox.
    await pickRadio(container, 2, 'Front');
    await flush();

    // Cloze never resolves here → no save may have used the old mapping.
    const saved = readStorage();
    expect(saved?.noteType).toBe('Basic');
    expect(saved?.fields?.sentence).toBe('Front');
  });

  it('G: deck + note type selects live in the pair-row wrapper', async () => {
    const fetchSpy = mockAnkiFlow();
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    const pairRow = container.querySelector('.entei-anki-pair-row');
    expect(pairRow).not.toBeNull();
    // Exactly two equal sections inside the pair row (deck, note type).
    expect(
      pairRow?.querySelectorAll(':scope > .entei-anki-section').length,
    ).toBe(2);
  });

  it('H: tags input auto-saves only when preset is valid', async () => {
    const fetchSpy = mockAnkiFlow();
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    // Invalid yet (no deck/note type): typing tags must not write.
    const tagsInput = container.querySelector('#anki-tags') as HTMLInputElement;
    expect(tagsInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(tagsInput, 'anime n5');
      tagsInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(readStorage()).toBeNull();

    // Now complete a valid preset (deck + note type + sentence).
    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'Basic');
    await pickRadio(container, 2, 'Front');
    expect(readStorage()?.fields?.sentence).toBe('Front');

    // A further tags edit auto-saves the top-level tags string.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(tagsInput, 'anime n5 eizou');
      tagsInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const saved = readStorage();
    expect(saved?.tags).toBe('anime n5 eizou');
    expect(saved?.fields ? 'tags' in (saved.fields as object) : true).toBe(
      false,
    );
  });
});
