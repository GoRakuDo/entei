/**
 * Tests for the NadeshikoSettingsTab.
 * ---------------------------------------------------------------------------
 * - Auto-save persists to localStorage and announces the change
 * - Clear removes the key and announces the change
 * - Validation rejects empty input
 * - Mount sync from saved key (with / without prior key)
 * - The tab MUST NOT touch /v1/user/me (it lacks ACAO and would CORS-fail);
 *   quota surfaces instead as a banner from NadeshikoPanel when the API
 *   returns 429 + body code QUOTA_EXCEEDED.
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  screen,
} from '@testing-library/react';
import { NadeshikoSettingsTab } from '@/components/player/NadeshikoSettingsTab';

function baseDict(): Record<string, unknown> {
  return {
    settingsTabLabel: 'Nadeshiko',
    heading: 'Nadeshiko',
    description: 'desc',
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'enter',
    apiKeyClear: 'Clear',
    apiKeyShow: 'Show',
    apiKeyHide: 'Hide',
  };
}

function makeDict() {
  return baseDict() as Parameters<typeof NadeshikoSettingsTab>[0]['dict'];
}

describe('NadeshikoSettingsTab', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
    // Spy on every fetch — the tab must NOT hit /user/me (CORS-blocked).
    // Returning a never-resolving Promise also guarantees no test ever
    // accidentally awaits a real network call from this component.
    vi.spyOn(window, 'fetch').mockImplementation(
      (() => new Promise<Response>(() => {})) as typeof window.fetch,
    );
  });

  it('auto-saves a non-empty key on change and dispatches the change event', () => {
    const listener = vi.fn();
    window.addEventListener('entei:nadeshiko-key-changed', listener);

    const { getByLabelText } = render(
      <NadeshikoSettingsTab dict={makeDict()} />,
    );
    const input = getByLabelText('API key') as HTMLInputElement;
    // jimaku-style: typing persists immediately, no Save click needed.
    fireEvent.change(input, { target: { value: 'sk-abc' } });

    expect(window.localStorage.getItem('entei.nadeshiko.api-key.v1')).toBe(
      'sk-abc',
    );
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('entei:nadeshiko-key-changed', listener);
  });

  it('auto-clears storage when the field is emptied', () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'sk-x');
    const { getByLabelText } = render(
      <NadeshikoSettingsTab dict={makeDict()} />,
    );
    const input = getByLabelText('API key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    expect(
      window.localStorage.getItem('entei.nadeshiko.api-key.v1'),
    ).toBeNull();
  });

  it('clears the stored key and announces the change', () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'sk-x');
    const listener = vi.fn();
    window.addEventListener('entei:nadeshiko-key-changed', listener);

    render(<NadeshikoSettingsTab dict={makeDict()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(
      window.localStorage.getItem('entei.nadeshiko.api-key.v1'),
    ).toBeNull();
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('entei:nadeshiko-key-changed', listener);
  });

  it('initialises the input draft from the saved key on mount', () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'saved-key');
    const { getByLabelText } = render(
      <NadeshikoSettingsTab dict={makeDict()} />,
    );
    const input = getByLabelText('API key') as HTMLInputElement;
    expect(input.value).toBe('saved-key');
  });

  it('clears the input draft on mount when no key is saved', () => {
    const { getByLabelText } = render(
      <NadeshikoSettingsTab dict={makeDict()} />,
    );
    const input = getByLabelText('API key') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('does not render a quota section (display removed; /user/me is CORS-blocked)', () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'sk-x');
    const { queryByText, container } = render(
      <NadeshikoSettingsTab dict={makeDict()} />,
    );
    // No quota heading / loading / remaining / limit / reset / unknown copy
    // anywhere in the rendered tree.
    expect(queryByText('Remaining')).toBeNull();
    expect(queryByText('Limit')).toBeNull();
    expect(queryByText('Reset')).toBeNull();
    // The wrapping `<div class="entei-settings-section">` for quota is gone,
    // so there should be only the outer settings section, not two.
    expect(
      container.querySelectorAll('.entei-settings-section').length,
    ).toBe(1);
  });

  it('does not call fetch on mount, after save, or after a 500ms settle window', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'saved-key');
    const fetchSpy = vi.spyOn(window, 'fetch');

    const { getByLabelText } = render(
      <NadeshikoSettingsTab dict={makeDict()} />,
    );

    // Auto-save a different key on top of the saved one.
    const input = getByLabelText('API key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-new' } });

    // Wait long enough that any prior debounced quota fetch (if it existed)
    // would have fired. The component must never have called fetch.
    await new Promise((r) => setTimeout(r, 600));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Suppress an unused-import warning for `waitFor`; it's available for future
 * tests that need to wait on async DOM transitions.
 */
void waitFor;