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
 * - export produces an upstream-compatible envelope (version, date, url, options)
 * - export filename matches `yomitan-settings-YYYY-MM-DD-HH-mm-ss.json`
 * - reset restores host defaults and dispatches the event
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import {
  exportSettings,
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

describe('exportSettings', () => {
  /** Capture Blob creation and anchor click without a real DOM download. */
  function captureBlobDownload(): { blob: Blob; filename: string } {
    let capturedBlob: Blob | undefined;
    let capturedFilename = '';

    // Mock URL.createObjectURL and revokeObjectURL.
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'click', {
          value: vi.fn(() => {
            capturedFilename = (el as HTMLAnchorElement).download;
          }),
          writable: true,
        });
        Object.defineProperty(el, 'href', {
          get() { return ''; },
          set(v: string) { /* store blob URL if needed */ },
          configurable: true,
        });
      }
      return el;
    });

    // Intercept Blob constructor to capture the blob.
    const origBlob = globalThis.Blob;
    // We read the blob from the anchor's href assignment, but we capture it
    // differently — by spying on the Blob constructor via a Proxy. The simplest
    // approach: since exportSettings creates a Blob and calls createObjectURL,
    // we just verify createObjectURL was called.
    void origBlob;

    exportSettings();

    // Restore.
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;

    return { blob: capturedBlob!, filename: capturedFilename };
  }

  it('triggers a download with an upstream-compatible filename', () => {
    let filename = '';
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'click', {
          value: vi.fn(() => {
            filename = (el as HTMLAnchorElement).download;
          }),
          writable: true,
        });
        Object.defineProperty(el, 'href', {
          get() { return ''; },
          set() {},
          configurable: true,
        });
      }
      return el;
    });

    exportSettings();

    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;

    // yomitan-settings-YYYY-MM-DD-HH-mm-ss.json
    expect(filename).toMatch(/^yomitan-settings-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
  });

  it('writes the envelope to a Blob (via createObjectURL)', () => {
    let capturedBlobContent = '';

    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'click', { value: vi.fn(), writable: true });
        Object.defineProperty(el, 'href', {
          get() { return ''; },
          set() {},
          configurable: true,
        });
      }
      return el;
    });

    // Intercept Blob to capture the content.
    const origBlobCtor = globalThis.Blob;
    globalThis.Blob = class FakeBlob {
      parts: BlobPart[];
      constructor(parts: BlobPart[]) {
        this.parts = parts;
        capturedBlobContent = String(parts[0]);
      }
    } as unknown as typeof Blob;

    exportSettings();

    globalThis.Blob = origBlobCtor;
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;

    const envelope = JSON.parse(capturedBlobContent) as {
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
