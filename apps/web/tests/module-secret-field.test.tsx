/**
 * ModuleSecretField — the host-owned credential row.
 * ---------------------------------------------------------------------------
 * Covers the four guarantees a masked API-key row has to keep (they are what
 * the hand-written Jimaku / Nadeshiko cards did, and what a data-driven row must
 * not lose):
 *
 * 1. autosave: every keystroke goes straight to the module's own store, and
 *    emptying the field CLEARS it;
 * 2. presence, never the value, is what the row reports — and a half-typed key
 *    does not read as "saved";
 * 3. a change made elsewhere (another tab, the module's inline form) shows up
 *    without a reload, but never clobbers the field while it is being typed in;
 * 4. the clear button wipes the store and the field together.
 *
 * The binding is a plain in-memory store, so nothing here depends on jimaku's or
 * Nadeshiko's persistence: this is the layout's own behaviour.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  createSecretField,
  type ModuleSecretFieldBinding,
} from '@/components/settings/ModuleSecretField';

/** A store the test can read and poke, behind the binding the layout expects. */
interface MemoryStore {
  binding: ModuleSecretFieldBinding;
  store: { value: string };
  writes: string[];
  clearCount: () => number;
}

function memoryBinding(syncEvent: string): MemoryStore {
  const store = { value: '' };
  const writes: string[] = [];
  let clears = 0;
  return {
    store,
    writes,
    clearCount: () => clears,
    binding: {
      read: () => store.value,
      write: (value: string) => {
        writes.push(value);
        store.value = value;
      },
      clear: () => {
        clears += 1;
        store.value = '';
      },
      syncEvents: [syncEvent],
    },
  };
}

const LABEL = 'API key';
const PLACEHOLDER = 'Enter your API key';

function mount(binding: ModuleSecretFieldBinding) {
  const Field = createSecretField(binding);
  return render(
    <Field
      label={LABEL}
      description="Stored on this device only."
      placeholder={PLACEHOLDER}
    />,
  );
}

function input(): HTMLInputElement {
  return screen.getByLabelText(LABEL) as HTMLInputElement;
}

afterEach(() => {
  cleanup();
});

describe('ModuleSecretField', () => {
  it('opens empty and reports that nothing is saved', () => {
    const { binding } = memoryBinding('entei:test-key-changed');
    mount(binding);
    expect(input().value).toBe('');
    expect(input().type).toBe('password');
    expect(screen.getByText('No key saved')).toBeTruthy();
    // No key stored → nothing to clear.
    expect(screen.queryByLabelText('Clear')).toBeNull();
  });

  it('opens populated when the store already holds a key', () => {
    const { binding, store } = memoryBinding('entei:test-key-changed');
    store.value = 'stored-key';
    mount(binding);
    expect(input().value).toBe('stored-key');
    expect(screen.getByText('Key saved')).toBeTruthy();
    expect(screen.getByLabelText('Clear')).toBeTruthy();
  });

  it('writes every keystroke through to the store and reveals on demand', () => {
    const { binding, store, writes } = memoryBinding('entei:test-key-changed');
    mount(binding);
    fireEvent.change(input(), { target: { value: 'abc' } });
    expect(writes).toEqual(['abc']);
    expect(store.value).toBe('abc');
    // A key being typed is not a saved key: the status follows the STORE.
    expect(screen.getByText('Key saved')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Show'));
    expect(input().type).toBe('text');
    fireEvent.click(screen.getByLabelText('Hide'));
    expect(input().type).toBe('password');
  });

  it('clears the stored key when the field is emptied', () => {
    const { binding, store, clearCount } = memoryBinding('entei:test-key-changed');
    mount(binding);
    fireEvent.change(input(), { target: { value: 'abc' } });
    fireEvent.change(input(), { target: { value: '   ' } });
    expect(store.value).toBe('');
    expect(clearCount()).toBeGreaterThan(0);
    expect(screen.getByText('No key saved')).toBeTruthy();
  });

  it('wipes store and field together from the clear button', () => {
    const { binding, store } = memoryBinding('entei:test-key-changed');
    store.value = 'stored-key';
    mount(binding);
    fireEvent.click(screen.getByLabelText('Clear'));
    expect(store.value).toBe('');
    expect(input().value).toBe('');
    expect(screen.getByText('No key saved')).toBeTruthy();
  });

  it('adopts a change made elsewhere, but never mid-typing', () => {
    const { binding, store } = memoryBinding('entei:test-key-changed');
    mount(binding);
    input().focus();
    expect(document.activeElement).toBe(input());

    // Another tab writes while the field is focused: the draft is left alone.
    store.value = 'from-another-tab';
    fireEvent(window, new Event('entei:test-key-changed'));
    expect(input().value).toBe('');

    // Leaving the field catches up with what the store took. (A real blur —
    // jsdom's `fireEvent.blur` only dispatches the event, so focus would stay in
    // the input and the field would rightly keep its draft.)
    act(() => {
      input().blur();
    });
    expect(input().value).toBe('from-another-tab');
    expect(screen.getByText('Key saved')).toBeTruthy();

    // And an event with the field unfocused lands immediately.
    store.value = 'second-change';
    fireEvent(window, new Event('entei:test-key-changed'));
    expect(input().value).toBe('second-change');
  });

  it('never renders the value anywhere but the input', () => {
    const { binding, store } = memoryBinding('entei:test-key-changed');
    store.value = 'super-secret-value';
    mount(binding);
    // The saved-state line is the only copy outside the field, and it must not
    // carry the key (the row is rendered on a page that can be screenshotted).
    expect(document.body.textContent).not.toContain('super-secret-value');
    expect(input().value).toBe('super-secret-value');
  });

  it('exposes the placeholder the manifest declared', () => {
    const { binding } = memoryBinding('entei:test-key-changed');
    mount(binding);
    expect(input().placeholder).toBe(PLACEHOLDER);
  });
});