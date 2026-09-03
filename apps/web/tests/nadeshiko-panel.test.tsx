/**
 * Tests for the NadeshikoPanel (RightPanel context tab).
 * ---------------------------------------------------------------------------
 * - Renders the search form + tab label
 * - Submits to the API client
 * - Shows key-missing, invalid-key, rate-limited, and generic errors
 * - Renders empty / no-results state
 * - Opens the settings dialog on key-missing
 * - Switches to the context tab when invoked
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { RightPanel } from '@/components/player/RightPanel';
import * as nadeshikoClient from '@/features/nadeshiko/nadeshiko-client';
import * as apiKey from '@/features/nadeshiko/api-key';
import { OPEN_SETTINGS_EVENT } from '@/features/player/settings-bridge';

function baseDict(): Record<string, unknown> {
  return {
    rightPanelTabsLabel: 'Panel',
    rightPanelTabCaptions: 'Captions',
    contextTabLabel: 'Context',
    contextSearchPlaceholder: 'Search',
    contextSearchButton: 'Search',
    contextSearchAriaLabel: 'Search',
    contextEmpty: 'No results',
    contextKeyMissing: 'Set API key',
    contextKeyMissingAction: 'Open settings',
    contextInvalidKey: 'Invalid key',
    contextRateLimited: (s: number) => `Wait ${s}s`,
    contextNetworkError: 'Network error',
    contextGenericError: 'Generic error',
    contextResultWorkLabel: 'Work',
    contextResultLineLabel: 'Line',
    contextResultEnglishLabel: 'English',
    contextContextLoading: 'Loading context…',
    contextContextFailed: 'Could not load context',
    contextNoEnglishTranslation: 'No translation',
    contextNoTimestamp: '–',
    contextResultsHeading: (n: number) => `Results (${n})`,
  };
}

function makeDict() {
  return baseDict() as Parameters<typeof RightPanel>[0]['dict'];
}

function noop() {}

const baseProps = () => ({
  dict: makeDict(),
  cues: [],
  activeCueId: null,
  onCueClick: noop,
  onSubtitleSelect: noop,
  subtitleAccept: '.srt',
});

describe('RightPanel — Nadeshiko context tab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('renders the context tab label', () => {
    const { getByRole } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    const tab = getByRole('tab', { name: /Context/i });
    expect(tab).toBeTruthy();
    expect(tab.getAttribute('aria-controls')).toBe('right-panel-context');
  });

  it('shows the key-missing state when no key is stored', () => {
    const { getByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    expect(getByText('Set API key')).toBeTruthy();
    expect(getByText('Open settings')).toBeTruthy();
  });

  it('dispatches open-settings event when the action button is clicked', () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, listener);
    const { getByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    fireEvent.click(getByText('Open settings'));
    expect(listener).toHaveBeenCalled();
    window.removeEventListener(OPEN_SETTINGS_EVENT, listener);
  });

  it('runs a search and renders results', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue([
      {
        id: 'seg-1',
        workName: 'Sousou no Frieren',
        line: 'また会えたね',
        englishTranslation: 'We met again.',
        timestampSeconds: 91,
        timestampLabel: '01:31',
      },
    ]);

    const { getByText, findByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'また' } });
    fireEvent.click(getByText('Search'));

    expect(await findByText('Sousou no Frieren')).toBeTruthy();
    expect(await findByText('また会えたね')).toBeTruthy();
    expect(await findByText('We met again.')).toBeTruthy();
    expect(await findByText('01:31')).toBeTruthy();
  });

  it('renders the no-results state when the API returns an empty list', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue([]);

    const { getByText, findByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.click(getByText('Search'));

    expect(await findByText('No results')).toBeTruthy();
  });

  it('shows the invalid-key banner when the client throws invalid-key', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'BAD');
    const err = Object.assign(new Error('x'), {
      kind: 'invalid-key',
    }) as nadeshikoClient.NadeshikoError;
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockRejectedValue(err);

    const { getByText, findByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(getByText('Search'));

    expect(await findByText('Invalid key')).toBeTruthy();
  });

  it('shows the rate-limited banner with the retry-after seconds', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'K');
    const err = Object.assign(new Error('x'), {
      kind: 'rate-limited',
      retryAfterSeconds: 7,
    }) as nadeshikoClient.NadeshikoError;
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockRejectedValue(err);

    const { getByText, findByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(getByText('Search'));

    expect(await findByText('Wait 7s')).toBeTruthy();
  });

  it('re-reads the API key when the key-changed event fires', async () => {
    const { getByText, findByText, queryByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    expect(getByText('Set API key')).toBeTruthy();

    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'NEW');
    window.dispatchEvent(new CustomEvent('entei:nadeshiko-key-changed'));

    await waitFor(() => {
      expect(queryByText('Set API key')).toBeNull();
    });

    vi.spyOn(apiKey, 'readNadeshikoApiKey').mockReturnValue('NEW');
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue([]);
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(getByText('Search'));
    expect(await findByText('No results')).toBeTruthy();
  });

  it('does not render history/tab labels that no longer exist', () => {
    const { queryByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    // History label must be gone (it moved to /tracker/).
    expect(queryByText('History')).toBeNull();
  });
});