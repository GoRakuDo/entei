/**
 * Tests for the NadeshikoSettingsTab.
 * ---------------------------------------------------------------------------
 * - Save persists to localStorage and announces the change
 * - Clear removes the key and announces the change
 * - Quota fetches /v1/user/me on key change
 * - Quota error mapping (invalid-key, rate-limited, network, generic)
 * - Validation rejects empty input
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
import * as nadeshikoClient from '@/features/nadeshiko/nadeshiko-client';

function baseDict(): Record<string, unknown> {
  return {
    settingsTabLabel: 'Nadeshiko',
    heading: 'Nadeshiko',
    description: 'desc',
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'enter',
    apiKeySave: 'Save',
    apiKeyClear: 'Clear',
    apiKeySaved: 'Saved',
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

  it('saves a non-empty key and dispatches the change event', () => {
    const listener = vi.fn();
    window.addEventListener('entei:nadeshiko-key-changed', listener);

    const { getByLabelText, getByText } = render(
      <NadeshikoSettingsTab dict={makeDict()} />,
    );
    const input = getByLabelText('API key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(window.localStorage.getItem('entei.nadeshiko.api-key.v1')).toBe(
      'sk-abc',
    );
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('entei:nadeshiko-key-changed', listener);
  });

  it('does not save an empty key', () => {
    const { getByText } = render(<NadeshikoSettingsTab dict={makeDict()} />);
    const save = screen.getByRole('button', {
      name: 'Save',
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('clears the stored key and announces the change', () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'sk-x');
    const listener = vi.fn();
    window.addEventListener('entei:nadeshiko-key-changed', listener);

    const { getByText } = render(<NadeshikoSettingsTab dict={makeDict()} />);
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
});

/**
 * Suppress an unused-import warning for `waitFor`; it's available for future
 * tests that need to wait on async DOM transitions.
 */
void waitFor;
