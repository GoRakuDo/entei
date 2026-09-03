/**
 * Tests for the NadeshikoSettingsTab.
 * ---------------------------------------------------------------------------
 * - Save persists to localStorage and announces the change
 * - Clear removes the key and announces the change
 * - Quota fetches /v1/user/me on key change
 * - Quota fetch is debounced ~500ms (typing does NOT fire per keystroke)
 * - Quota error mapping (invalid-key, rate-limited, network, generic)
 * - Validation rejects empty input
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  screen,
  act,
} from '@testing-library/react';
import { NadeshikoSettingsTab } from '@/components/player/NadeshikoSettingsTab';
import * as nadeshikoClient from '@/features/nadeshiko/nadeshiko-client';

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
    quotaHeading: 'Quota',
    quotaRemaining: 'Remaining',
    quotaLimit: 'Limit',
    quotaReset: 'Reset',
    quotaUnknown: 'unknown',
    quotaErrorInvalidKey: 'bad key',
    quotaErrorRateLimited: 'slow down',
    quotaErrorNetwork: 'no net',
    quotaErrorGeneric: 'oops',
    quotaLoading: 'loading…',
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

  it('fetches and displays quota numbers', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'sk-x');
    vi.spyOn(nadeshikoClient, 'getNadeshikoUserMe').mockResolvedValue({
      remainingRequests: 1000,
      monthlyLimit: 5000,
      resetAt: '2026-09-01T00:00:00Z',
    });

    const { findByText } = render(<NadeshikoSettingsTab dict={makeDict()} />);
    expect(await findByText('1000')).toBeTruthy();
    expect(await findByText('5000')).toBeTruthy();
    expect(await findByText('2026-09-01T00:00:00Z')).toBeTruthy();
  });

  it('shows the invalid-key quota error message', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'sk-x');
    const err = Object.assign(new Error('x'), {
      kind: 'invalid-key',
    }) as nadeshikoClient.NadeshikoError;
    vi.spyOn(nadeshikoClient, 'getNadeshikoUserMe').mockRejectedValue(err);

    const { findByText } = render(<NadeshikoSettingsTab dict={makeDict()} />);
    expect(await findByText('bad key')).toBeTruthy();
  });

  it('shows the rate-limited quota error message', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'sk-x');
    const err = Object.assign(new Error('x'), {
      kind: 'rate-limited',
      retryAfterSeconds: 12,
    }) as nadeshikoClient.NadeshikoError;
    vi.spyOn(nadeshikoClient, 'getNadeshikoUserMe').mockRejectedValue(err);

    const { findByText } = render(<NadeshikoSettingsTab dict={makeDict()} />);
    expect(await findByText('slow down')).toBeTruthy();
  });

  it('shows the network quota error message', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'sk-x');
    const err = Object.assign(new Error('x'), {
      kind: 'network',
    }) as nadeshikoClient.NadeshikoError;
    vi.spyOn(nadeshikoClient, 'getNadeshikoUserMe').mockRejectedValue(err);

    const { findByText } = render(<NadeshikoSettingsTab dict={makeDict()} />);
    expect(await findByText('no net')).toBeTruthy();
  });

  describe('quota fetch debounce', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not call getNadeshikoUserMe immediately on a keystroke', async () => {
      const spy = vi
        .spyOn(nadeshikoClient, 'getNadeshikoUserMe')
        .mockResolvedValue({
          remainingRequests: 1,
          monthlyLimit: 1,
        });

      const { getByLabelText } = render(
        <NadeshikoSettingsTab dict={makeDict()} />,
      );
      const input = getByLabelText('API key') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { value: 'sk-abc' } });
      });

      // localStorage still updated instantly (jimaku parity).
      expect(window.localStorage.getItem('entei.nadeshiko.api-key.v1')).toBe(
        'sk-abc',
      );
      // But no network call before the debounce window elapses.
      expect(spy).not.toHaveBeenCalled();
    });

    it('fetches quota exactly once after a 500ms pause', async () => {
      const spy = vi
        .spyOn(nadeshikoClient, 'getNadeshikoUserMe')
        .mockResolvedValue({
          remainingRequests: 1,
          monthlyLimit: 1,
        });

      const { getByLabelText } = render(
        <NadeshikoSettingsTab dict={makeDict()} />,
      );
      const input = getByLabelText('API key') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { value: 'sk-abc' } });
      });
      expect(spy).not.toHaveBeenCalled();

      // Advance just under the debounce window — still no fetch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(499);
      });
      expect(spy).not.toHaveBeenCalled();

      // Advance the final millisecond past the debounce window — fetch fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('sk-abc', expect.anything());
    });

    it('coalesces multiple keystrokes into a single fetch after ~500ms', async () => {
      const spy = vi
        .spyOn(nadeshikoClient, 'getNadeshikoUserMe')
        .mockResolvedValue({
          remainingRequests: 1,
          monthlyLimit: 1,
        });

      const { getByLabelText } = render(
        <NadeshikoSettingsTab dict={makeDict()} />,
      );
      const input = getByLabelText('API key') as HTMLInputElement;
      // Type a string char-by-char; each fireEvent resets the pending timer.
      // Build the value in a JS variable so we don't depend on jsdom's
      // input.value persistence across fake-timer flushes.
      let typed = '';
      for (const ch of 'sk-abcdef') {
        typed += ch;
        await act(async () => {
          fireEvent.change(input, { target: { value: typed } });
          await vi.advanceTimersByTimeAsync(100);
        });
      }
      expect(spy).not.toHaveBeenCalled();

      // Pause for the rest of the debounce window — fetch should now fire
      // exactly once with the final value.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        'sk-abcdef',
        expect.anything(),
      );
    });

    it('returns to idle immediately when the field is cleared (no debounce)', async () => {
      const spy = vi
        .spyOn(nadeshikoClient, 'getNadeshikoUserMe')
        .mockResolvedValue({
          remainingRequests: 1,
          monthlyLimit: 1,
        });

      const { getByLabelText } = render(
        <NadeshikoSettingsTab dict={makeDict()} />,
      );
      const input = getByLabelText('API key') as HTMLInputElement;
      // Type a value, then immediately clear within the debounce window.
      // No fetch should ever fire because the pending timer is cancelled
      // and savedKey=null short-circuits to idle synchronously.
      await act(async () => {
        fireEvent.change(input, { target: { value: 'sk-x' } });
        fireEvent.change(input, { target: { value: '   ' } });
      });

      // Advance well past the debounce window: no fetch should ever fire.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(spy).not.toHaveBeenCalled();
    });
  });
});

/**
 * Suppress an unused-import warning for `waitFor`; it's available for future
 * tests that need to wait on async DOM transitions.
 */
void waitFor;
