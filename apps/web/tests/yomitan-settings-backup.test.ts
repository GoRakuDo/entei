/**
 * yomitan-settings-backup unit tests — Export / Import / Reset for the Yomitan
 * module's settings.
 *
 * Covers:
 * - import from the upstream extension envelope (`{ options: { profiles, … } }`)
 * - import from a bare `Options` object (`{ profiles, … }`)
 * - import sanitises through normalizeOptions (locked paths re-imposed)
 * - import dispatches `entei:yomitan-options-updated`
 * - malformed JSON → throws with a clear message
 * - missing options tree → throws
 * - export builds an upstream-compatible envelope (version, date, url, options)
 * - export filename matches `yomitan-settings-YYYY-MM-DD-HH-mm-ss.json`
 *   (the file is then written by the settings page: native save dialog on the
 *   desktop app, browser download on the web)
 * - reset restores host defaults and dispatches the event
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import {
  buildSettingsExportPayload,
  importSettingsFromJson,
  resetSettings,
  YOMITAN_OPTIONS_UPDATED_EVENT,
} from '@/modules/yomitan/settings-backup';
import {
  YOMITAN_OPTIONS_KEY,
  YOMITAN_OPTIONS_SCHEMA_VERSION,
  readYomitanOptions,
  writeYomitanOptions,
} from '@/modules/yomitan/yomitan-preferences';
import { createDefaultOptions, createDefaultProfileOptions } from '@gorakudo/yomitan-headless/settings';

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/** Build an upstream-style envelope wrapping `options`. */
function makeEnvelope(options: unknown, date = '2026-07-06 09:48:37'): string {
  return JSON.stringify({
    version: 0,
    date,
    url: 'chrome-extension://abc123/options.html',
    manifest: { version: '1.0.0' },
    environment: { os: 'win' },
    permissions: {},
    options,
  });
}

/** Build a valid bare Options tree with one profile. */
function makeBareOptions(): ReturnType<typeof createDefaultOptions> {
  return createDefaultOptions();
}

/** Read the stored payload from localStorage. */
function storedPayload(): { version: number; options: Record<string, unknown> } {
  const raw = localStorage.getItem(YOMITAN_OPTIONS_KEY);
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as { version: number; options: Record<string, unknown> };
}

/** Spy on window.dispatchEvent to capture CustomEvents. */
function captureEvents(): CustomEvent[] {
  const events: CustomEvent[] = [];
  const orig = window.dispatchEvent.bind(window);
  vi.spyOn(window, 'dispatchEvent').mockImplementation((e: Event) => {
    if (e instanceof CustomEvent) events.push(e);
    return orig(e);
  });
  return events;
}

/* ---------------------------------------------------------------------------
 * Setup / teardown
 * ------------------------------------------------------------------------- */

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------------------
 * Import — upstream envelope
 * ------------------------------------------------------------------------- */

describe('importSettingsFromJson — upstream envelope', () => {
  it('imports a valid envelope and persists the options tree', async () => {
    const bare = makeBareOptions();
    // Mutate a field so we can verify it survives import.
    const profile = bare.profiles[0]!;
    profile.options.general = { ...profile.options.general, maxResults: 42 };

    const count = await importSettingsFromJson(makeEnvelope(bare));

    expect(count).toBe(bare.profiles.length);
    const stored = storedPayload();
    expect(stored.version).toBe(YOMITAN_OPTIONS_SCHEMA_VERSION);
    // The maxResults=42 made it into the persisted tree.
    const profile0 = stored.options.profiles as { options: { general: { maxResults: number } } }[];
    expect(profile0[0]?.options.general.maxResults).toBe(42);
  });

  it('dispatches entei:yomitan-options-updated after import', async () => {
    const events = captureEvents();
    await importSettingsFromJson(makeEnvelope(makeBareOptions()));
    const backupEvents = events.filter((e) => e.type === YOMITAN_OPTIONS_UPDATED_EVENT);
    expect(backupEvents).toHaveLength(1);
  });

  it('re-imposes locked paths on an imported tree', async () => {
    const bare = makeBareOptions();
    const profile = bare.profiles[0]!;
    profile.options.general = {
      ...profile.options.general,
      enable: false,
      language: 'en',
    };

    await importSettingsFromJson(makeEnvelope(bare));

    const options = readYomitanOptions();
    expect(options.profiles[0]!.options.general.enable).toBe(true);
    expect(options.profiles[0]!.options.general.language).toBe('ja');
  });

  it('ignores backup file values for ALL locked general paths', async () => {
    const bare = makeBareOptions();
    const profile = bare.profiles[0]!;
    profile.options.general = {
      ...profile.options.general,
      enable: false,
      language: 'en',
      showGuide: true,
      showAdvanced: false,
      showDebug: false,
    };

    await importSettingsFromJson(makeEnvelope(bare));

    const general = readYomitanOptions().profiles[0]!.options.general;
    // Entei host-locked values are enforced regardless of what the backup says.
    expect(general.enable).toBe(true);
    expect(general.language).toBe('ja');
    expect(general.showGuide).toBe(false);
    expect(general.showAdvanced).toBe(true);
    expect(general.showDebug).toBe(true);
  });

  it('ignores backup file values for locked scanning paths', async () => {
    const bare = makeBareOptions();
    const profile = bare.profiles[0]!;
    profile.options.scanning = {
      ...profile.options.scanning,
      preventMiddleMouse: {
        onTextHover: true,
        onWebPages: true,
        onPopupPages: true,
        onSearchPages: true,
        onSearchQuery: true,
      },
      preventBackForward: {
        onTextHover: true,
        onWebPages: true,
        onPopupPages: true,
        onSearchPages: true,
        onSearchQuery: true,
      },
    } as typeof profile.options.scanning;

    await importSettingsFromJson(makeEnvelope(bare));

    const scanning = readYomitanOptions().profiles[0]!.options.scanning;
    expect(scanning.preventMiddleMouse.onTextHover).toBe(false);
    expect(scanning.preventMiddleMouse.onWebPages).toBe(false);
    expect(scanning.preventBackForward.onTextHover).toBe(false);
    expect(scanning.preventBackForward.onWebPages).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Import — bare Options
 * ------------------------------------------------------------------------- */

describe('importSettingsFromJson — bare Options', () => {
  it('imports a bare Options object without an envelope', async () => {
    const bare = makeBareOptions();
    const count = await importSettingsFromJson(JSON.stringify(bare));

    expect(count).toBe(bare.profiles.length);
    const stored = storedPayload();
    expect(stored.version).toBe(YOMITAN_OPTIONS_SCHEMA_VERSION);
  });

  it('dispatches entei:yomitan-options-updated after bare import', async () => {
    const events = captureEvents();
    await importSettingsFromJson(JSON.stringify(makeBareOptions()));
    const backupEvents = events.filter((e) => e.type === YOMITAN_OPTIONS_UPDATED_EVENT);
    expect(backupEvents).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------------
 * Import — error cases
 * ------------------------------------------------------------------------- */

describe('importSettingsFromJson — errors', () => {
  it('throws on malformed JSON', async () => {
    await expect(importSettingsFromJson('{not valid json'))
      .rejects.toThrow(/not valid JSON/i);
  });

  it('throws on a non-object JSON value', async () => {
    await expect(importSettingsFromJson('42'))
      .rejects.toThrow(/not a valid JSON object/i);
  });

  it('throws when neither options key nor profiles array is present', async () => {
    await expect(
      importSettingsFromJson(JSON.stringify({ foo: 'bar' })),
    ).rejects.toThrow(/recognisable Yomitan options tree/i);
  });

  it('throws when options key exists but is not an object', async () => {
    await expect(
      importSettingsFromJson(JSON.stringify({ options: 'string' })),
    ).rejects.toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * Export
 * ------------------------------------------------------------------------- */

describe('buildSettingsExportPayload', () => {
  it('names the file the way upstream does', () => {
    const payload = buildSettingsExportPayload();
    // yomitan-settings-YYYY-MM-DD-HH-mm-ss.json
    expect(payload.filename).toMatch(
      /^yomitan-settings-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/,
    );
  });

  it('builds the upstream-compatible envelope as 4-space indented JSON', () => {
    const payload = buildSettingsExportPayload();
    // A backup a human may diff: the pretty printing is part of the contract.
    expect(payload.contents).toContain('\n    "version": 0,');

    const envelope = JSON.parse(payload.contents) as {
      version: number;
      date: string;
      url: string;
      userAgent: string;
      options: Record<string, unknown>;
    };

    expect(envelope.version).toBe(0);
    expect(typeof envelope.date).toBe('string');
    expect(envelope.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(typeof envelope.userAgent).toBe('string');
    // The options tree is present and has profiles.
    expect(Array.isArray(envelope.options.profiles)).toBe(true);
    expect((envelope.options.profiles as unknown[]).length).toBeGreaterThan(0);
  });

  it('counts the profiles it exported, for the trace line', () => {
    const payload = buildSettingsExportPayload();
    expect(payload.profileCount).toBe(readYomitanOptions().profiles.length);
  });
});

/* ---------------------------------------------------------------------------
 * Reset
 * ------------------------------------------------------------------------- */

describe('resetSettings', () => {
  it('restores host defaults after writing a non-default value', async () => {
    // Write a non-default value first.
    const options = readYomitanOptions();
    options.profiles[0]!.options.general = {
      ...options.profiles[0]!.options.general,
      maxResults: 99,
    };
    writeYomitanOptions(options);

    const before = readYomitanOptions();
    expect(before.profiles[0]!.options.general.maxResults).toBe(99);

    // Reset.
    const events = captureEvents();
    await resetSettings();

    const after = readYomitanOptions();
    expect(after.profiles[0]!.options.general.maxResults).not.toBe(99);

    const backupEvents = events.filter((e) => e.type === YOMITAN_OPTIONS_UPDATED_EVENT);
    expect(backupEvents).toHaveLength(1);
  });

  it('persisted payload carries the current schema version after reset', async () => {
    await resetSettings();
    const stored = storedPayload();
    expect(stored.version).toBe(YOMITAN_OPTIONS_SCHEMA_VERSION);
  });

  it('persists host-locked values after reset', async () => {
    // Reset must write a compliant tree: every host-locked path carries its
    // locked value in the persisted payload (not just in memory).
    await resetSettings();
    const stored = storedPayload();
    const profile0 = stored.options.profiles as {
      options: { general: Record<string, unknown> };
    }[];
    const general = profile0[0]?.options.general;
    expect(general).toBeDefined();
    expect(general?.enable).toBe(true);
    expect(general?.language).toBe('ja');
    expect(general?.showGuide).toBe(false);
    expect(general?.showAdvanced).toBe(true);
    expect(general?.showDebug).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * Integration: import then read back the persisted tree
 * ------------------------------------------------------------------------- */

describe('importSettingsFromJson — integration', () => {
  it('imported values are visible via readYomitanOptions()', async () => {
    const bare = makeBareOptions();
    bare.profiles[0]!.options.general = {
      ...bare.profiles[0]!.options.general,
      maxResults: 7,
    };

    await importSettingsFromJson(makeEnvelope(bare));

    const options = readYomitanOptions();
    expect(options.profiles[0]!.options.general.maxResults).toBe(7);
  });

  it('imported profile count matches the envelope', async () => {
    const bare = makeBareOptions();
    // Add a second profile.
    bare.profiles.push({
      name: 'Second',
      conditionGroups: [],
      options: createDefaultProfileOptions(),
    });

    const count = await importSettingsFromJson(makeEnvelope(bare));
    expect(count).toBe(2);
    expect(readYomitanOptions().profiles).toHaveLength(2);
  });
});
