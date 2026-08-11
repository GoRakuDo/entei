/** The global settings route wires shared tab callbacks to the event bridge. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { en } from '@/i18n/locales/en';
import { EizouSettingsDialog } from '@/components/home/EizouSettingsDialog';
import type {
  AnkiSessionCredentials,
  SubtitleSettingsPatch,
} from '@/features/player/settings-bridge';
import {
  ANKI_SESSION_CREDENTIALS_EVENT,
  SUBTITLE_SETTINGS_CHANGE_EVENT,
} from '@/features/player/settings-bridge';

const capture = vi.hoisted(() => ({
  settingsProps: null as Record<string, unknown> | null,
}));

vi.mock('@/components/player/SettingsTabs', () => ({
  SettingsTabs: vi.fn((props: Record<string, unknown>) => {
    capture.settingsProps = props;
    return null;
  }),
}));

beforeEach(() => {
  capture.settingsProps = null;
  global.ResizeObserver = vi.fn(function () {
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EizouSettingsDialog settings route bridge wiring', () => {
  it('dispatches subtitle and Anki callback payloads from the global dialog', () => {
    const subtitleListener = vi.fn();
    const ankiListener = vi.fn();
    window.addEventListener(SUBTITLE_SETTINGS_CHANGE_EVENT, subtitleListener);
    window.addEventListener(ANKI_SESSION_CREDENTIALS_EVENT, ankiListener);

    render(
      <EizouSettingsDialog
        label="Settings"
        triggerLabel="Open settings"
        variant="pill"
        playerUI={en.playerUI}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));

    const subtitleCallback = capture.settingsProps?.onSubtitleSettingsChange;
    const credentialsCallback = capture.settingsProps?.onSessionCredentials;
    expect(typeof subtitleCallback).toBe('function');
    expect(typeof credentialsCallback).toBe('function');

    (subtitleCallback as (settings: SubtitleSettingsPatch) => void)({
      fontSize: 36,
    });
    (
      credentialsCallback as (
        credentials: AnkiSessionCredentials | null,
      ) => void
    )({ endpoint: 'http://anki.test', apiKey: 'fixture-key' });

    expect(subtitleListener).toHaveBeenCalledTimes(1);
    expect((subtitleListener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(
      {
        fontSize: 36,
      },
    );
    expect(ankiListener).toHaveBeenCalledTimes(1);
    expect((ankiListener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      endpoint: 'http://anki.test',
      apiKey: 'fixture-key',
    });

    window.removeEventListener(
      SUBTITLE_SETTINGS_CHANGE_EVENT,
      subtitleListener,
    );
    window.removeEventListener(ANKI_SESSION_CREDENTIALS_EVENT, ankiListener);
  });
});
