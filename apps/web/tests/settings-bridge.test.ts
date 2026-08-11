/** Behavioral tests for the browser CustomEvent settings bridge. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ANKI_SESSION_CREDENTIALS_EVENT,
  SUBTITLE_SETTINGS_CHANGE_EVENT,
  dispatchAnkiSessionCredentials,
  dispatchSubtitleSettingsChange,
  listenForAnkiSessionCredentials,
  listenForSubtitleSettingsChange,
  parseAnkiSessionCredentials,
  parseSubtitleSettings,
} from '@/features/player/settings-bridge';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('subtitle settings bridge', () => {
  it('drops invalid keys and rejects an empty patch', () => {
    expect(
      parseSubtitleSettings({
        fontSize: 49,
        textColor: '   ',
        backgroundColor: 'oklch(0% 0 0deg / 0.5)',
        backgroundPadding: 48,
        verticalPosition: 101,
        ignored: 'not forwarded',
      }),
    ).toEqual({
      backgroundColor: 'oklch(0% 0 0deg / 0.5)',
      backgroundPadding: 48,
    });

    expect(parseSubtitleSettings({ fontSize: 15 })).toBeNull();
    expect(parseSubtitleSettings({})).toBeNull();
    expect(parseSubtitleSettings(null)).toBeNull();
  });

  it('dispatches validated patches and removes the listener', () => {
    const listener = vi.fn();
    const unsubscribe = listenForSubtitleSettingsChange(listener);

    dispatchSubtitleSettingsChange({
      fontSize: 32,
      textColor: 'oklch(98% 0 0deg)',
      backgroundPadding: 0,
      verticalPosition: 100,
    });

    expect(listener).toHaveBeenCalledWith({
      fontSize: 32,
      textColor: 'oklch(98% 0 0deg)',
      backgroundPadding: 0,
      verticalPosition: 100,
    });

    unsubscribe();
    dispatchSubtitleSettingsChange({ fontSize: 33 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('runtime-validates direct CustomEvent payloads', () => {
    const listener = vi.fn();
    const unsubscribe = listenForSubtitleSettingsChange(listener);

    window.dispatchEvent(
      new CustomEvent(SUBTITLE_SETTINGS_CHANGE_EVENT, {
        detail: { fontSize: 14, backgroundPadding: 16 },
      }),
    );

    expect(listener).toHaveBeenCalledWith({ backgroundPadding: 16 });
    unsubscribe();
  });
});

describe('Anki session bridge', () => {
  it('accepts an API-key-only session without persistence', () => {
    expect(
      parseAnkiSessionCredentials({
        endpoint: '  http://anki.test  ',
        apiKey: '',
      }),
    ).toEqual({ endpoint: 'http://anki.test', apiKey: '' });
    expect(
      parseAnkiSessionCredentials({ endpoint: ' ', apiKey: 'key' }),
    ).toBeNull();
    expect(
      parseAnkiSessionCredentials({ endpoint: 'http://anki.test', apiKey: 1 }),
    ).toBeNull();
  });

  it('dispatches credentials and explicit disconnect in page memory only', () => {
    const listener = vi.fn();
    const unsubscribe = listenForAnkiSessionCredentials(listener);

    dispatchAnkiSessionCredentials({
      endpoint: 'http://anki.test',
      apiKey: 'fixture-key',
    });
    dispatchAnkiSessionCredentials(null);

    expect(listener).toHaveBeenNthCalledWith(1, {
      endpoint: 'http://anki.test',
      apiKey: 'fixture-key',
    });
    expect(listener).toHaveBeenNthCalledWith(2, null);
    expect(localStorage.getItem('entei.player.anki-miner.v1')).toBeNull();

    unsubscribe();
  });

  it('rejects invalid runtime credential events', () => {
    const listener = vi.fn();
    const unsubscribe = listenForAnkiSessionCredentials(listener);

    window.dispatchEvent(
      new CustomEvent(ANKI_SESSION_CREDENTIALS_EVENT, {
        detail: { endpoint: '', apiKey: 'fixture-key' },
      }),
    );

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
