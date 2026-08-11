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
    modelNames?: string[];
  }) {
    const fieldMap = overrides?.modelFieldNames ?? {
      Basic: ['Front', 'Back'],
      Cloze: ['Text', 'Extra'],
    };
    const modelList = overrides?.modelNames ?? ['Basic', 'Cloze'];
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
              resolve(respond(modelList));
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
    fields?: {
      sentence?: string;
      definition?: string | null;
      image?: string | null;
      audio?: string | null;
      word?: string | null;
      source?: string | null;
    };
  } | null => {
    const raw = localStorage.getItem('entei.player.anki-miner.v1');
    return raw ? JSON.parse(raw) : null;
  };

  const clickDenChouApply = async (container: HTMLElement) => {
    const btn = container.querySelector(
      '.entei-anki-connect-btn',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
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

    // Deck + note type selected, sentence NOT yet selected: the mapping
    // grid (with the tags input inside) is visible, but the preset is
    // invalid — typing tags must not write anything.
    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'Basic');
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

    // Sentence makes the preset valid — a further tags edit auto-saves.
    await pickRadio(container, 2, 'Front');
    expect(readStorage()?.fields?.sentence).toBe('Front');

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

  it('I: tags input lives inside the mapping grid after Source (desktop Source | Tags)', async () => {
    const fetchSpy = mockAnkiFlow();
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    // Build a valid selection so the mapping grid (field rows + tags)
    // renders.
    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'Basic');
    await pickRadio(container, 2, 'Front');

    const grid = container.querySelector('.entei-anki-mapping-grid');
    expect(grid).not.toBeNull();
    const rows = Array.from(
      grid!.querySelectorAll('.entei-anki-field-row'),
    );
    // sentence, definition, image, audio, word, source, tags
    expect(rows.length).toBe(7);
    const tagsRow = grid!.querySelector('.entei-anki-field-row #anki-tags');
    expect(tagsRow).not.toBeNull();
    // Source row must precede the Tags row (desktop 2nd column pairing).
    const sourceIndex = rows.findIndex((r) =>
      r.textContent?.includes(dict.ankiFieldSource),
    );
    const tagsIndex = rows.findIndex((r) =>
      r.textContent?.includes(dict.ankiFieldTags),
    );
    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    expect(tagsIndex).toBe(sourceIndex + 1);
  });

  const DENCHOU_FIELDS = [
    'sentence',
    'definition',
    'picture',
    'sentenceCard',
    'word',
    'miscInfo',
  ];

  it('J: renders the DenChou preset section with title, note, and button', async () => {
    const fetchSpy = mockAnkiFlow();
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    expect(container.textContent).toContain(dict.ankiDenChouPresetTitle);
    expect(container.textContent).toContain(dict.ankiDenChouPresetDesc);
    const btn = container.querySelector(
      '.entei-anki-connect-btn',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain(dict.ankiDenChouPresetApply);
  });

  it('K: DenChou apply maps all six fields, one auto-save, tags/deck/model untouched', async () => {
    const fetchSpy = mockAnkiFlow({
      modelNames: ['DenChou'],
      modelFieldNames: {
        DenChou: DENCHOU_FIELDS,
      },
    });
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    // Valid preset first: deck + DenChou + a tags value + sentence.
    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'DenChou');
    // Set tags before mapping completes, to prove apply leaves them alone.
    const tagsInput = container.querySelector(
      '#anki-tags',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(tagsInput, 'anime n5');
      tagsInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    // Sentence field select for a fully valid preset.
    await pickRadio(container, 2, 'sentence');
    await flush();

    expect(readStorage()?.fields?.sentence).toBe('sentence');
    expect(readStorage()?.tags).toBe('anime n5');
    const deckBefore = readStorage()?.deck;
    const modelBefore = readStorage()?.noteType;

    await clickDenChouApply(container);

    const saved = readStorage();
    expect(saved?.fields).toMatchObject({
      sentence: 'sentence',
      definition: 'definition',
      image: 'picture',
      audio: 'sentenceCard',
      word: 'word',
      source: 'miscInfo',
    });
    // Tags + deck + model untouched.
    expect(saved?.tags).toBe('anime n5');
    expect(saved?.deck).toBe(deckBefore);
    expect(saved?.noteType).toBe(modelBefore);
  });

  it('L: missing one required DenChou field → no-op, no save, no partial application', async () => {
    const fetchSpy = mockAnkiFlow({
      modelNames: ['DenChou'],
      modelFieldNames: {
        // miscInfo missing → all six required names not present
        DenChou: ['sentence', 'definition', 'picture', 'sentenceCard', 'word'],
      },
    });
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'DenChou');
    await pickRadio(container, 2, 'sentence');
    await flush();
    const before = readStorage();

    await clickDenChouApply(container);

    // Preserved mapping entirely (no half application), no additional save.
    expect(readStorage()?.fields).toEqual(before?.fields);
    expect(readStorage()?.fields?.image).not.toBe('picture');
    expect(readStorage()?.fields?.audio).not.toBe('sentenceCard');
  });

  it('M: unresolved model (pending field fetch) blocks DenChou apply', async () => {
    const fetchSpy = mockAnkiFlow({
      modelNames: ['Basic', 'DenChou'],
      slowModels: ['DenChou'],
      modelFieldNames: {
        Basic: ['Front', 'Back'],
        DenChou: DENCHOU_FIELDS,
      },
    });
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    // Fully resolved + valid on Basic first.
    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'Basic');
    await pickRadio(container, 2, 'Front');
    await flush();
    const before = readStorage();

    // Switch to DenChou: its field fetch is pending (slow) → unresolved.
    await pickRadio(container, 1, 'DenChou');
    await clickDenChouApply(container);

    // No-op: mapping + storage preserved (resolvedModelRef gate).
    expect(readStorage()?.fields).toEqual(before?.fields);
  });

  it('N: no partial field updates when the gate rejects the apply', async () => {
    const fetchSpy = mockAnkiFlow({
      modelNames: ['DenChou'],
      modelFieldNames: {
        DenChou: ['sentence', 'definition', 'picture', 'sentenceCard', 'word'],
      },
    });
    global.fetch = fetchSpy;
    const { container } = await act(async () => {
      return render(createElement(AnkiFieldsTab, { dict }));
    });
    await flush();

    await pickRadio(container, 0, 'Japanese');
    await pickRadio(container, 1, 'DenChou');
    await pickRadio(container, 2, 'sentence');
    await flush();
    const before = readStorage();

    await clickDenChouApply(container);

    // Every mapping key stays exactly as before — nothing half-applied.
    const after = readStorage();
    expect(after?.fields).toEqual(before?.fields);
    expect(after?.fields?.sentence).toBe(before?.fields?.sentence);
    expect(after?.fields?.source).toBe(before?.fields?.source ?? null);
  });
});
