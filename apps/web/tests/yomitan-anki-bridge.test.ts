/**
 * yomitan-anki-bridge unit tests — the "Yomitan Module Control" bridge.
 * ---------------------------------------------------------------------------
 * Covers the contract added with the Miscellaneous Configuration card:
 * - `mapYomitanAnkiToConnectionPreferences` field-by-field mapping (server,
 *   apiKey, forceSync, duplicate scope/behavior, note viewer, templates,
 *   screenshot format, card formats) with per-field fallback to CURRENT.
 * - Yomitan's 'new' duplicate behavior → this app's 'allow'; 'browse' note GUI
 *   → 'browser'.
 * - Yomitan card formats ({ value, overwriteMode } fields) → plain marker
 *   strings, preserving an existing profile's id by name match.
 * - Import: with the control ON, `importSettingsFromJson` mirrors the backup's
 *   Anki values into the Anki Connection card; with it OFF, Anki is untouched.
 * - Reset: with the control ON, `resetSettings` restores Anki defaults while
 *   keeping the switch ON; with it OFF, Anki is untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  importSettingsFromJson,
  mapYomitanAnkiToConnectionPreferences,
  resetSettings,
} from '@/modules/yomitan/settings-backup';
import {
  ANKI_CONNECTION_PREFS_KEY,
  DEFAULT_ANKI_CONNECTION_PREFERENCES,
  readAnkiConnectionPreferences,
  writeAnkiConnectionPreferences,
  type AnkiConnectionPreferences,
} from '@/features/player/anki-connection-preferences';
import { createDefaultOptions, type AnkiOptions } from '@gorakudo/yomitan-headless/settings';

/** Build an upstream-style envelope wrapping `options` (mirrors the backup test). */
function makeEnvelope(options: unknown): string {
  return JSON.stringify({
    version: 0,
    date: '2026-07-06 09:48:37',
    url: 'chrome-extension://abc123/options.html',
    manifest: { version: '1.0.0' },
    environment: { os: 'win' },
    permissions: {},
    options,
  });
}

/** A representative Yomitan `anki` options block. */
function makeYomitanAnki() {
  return {
    enable: true,
    server: 'http://127.0.0.1:9999',
    tags: ['yomitan'],
    screenshot: { format: 'jpeg', quality: 0.8 },
    cardFormats: [
      {
        name: 'Default',
        icon: 'big-circle',
        deck: 'Mining',
        model: 'Basic',
        type: 'term',
        fields: {
          Front: { value: '{expression}', overwriteMode: 'coalesce' },
          Back: { value: '{glossary}', overwriteMode: 'coalesce' },
        },
      },
    ],
    duplicateScope: 'deck',
    duplicateScopeCheckAllModels: true,
    checkForDuplicates: true,
    duplicateBehavior: 'new',
    fieldTemplates: '{{#tags}}',
    suspendNewCards: true,
    displayTagsAndFlags: 'never',
    targetTags: [],
    noteGuiMode: 'browse',
    apiKey: 'key-123',
    downloadTimeout: 0,
    forceSync: true,
    noteDupeCheckFirst: true,
  };
}

/** Seed the persisted preferences with the bridge switch in a given state. */
function seedPrefs(overrides: Partial<AnkiConnectionPreferences>): void {
  writeAnkiConnectionPreferences({
    ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe('mapYomitanAnkiToConnectionPreferences', () => {
  it('maps every Yomitan Anki field onto this app preferences', () => {
    const next = mapYomitanAnkiToConnectionPreferences(
      makeYomitanAnki(),
      DEFAULT_ANKI_CONNECTION_PREFERENCES,
    );
    expect(next.server).toBe('http://127.0.0.1:9999');
    expect(next.apiKey).toBe('key-123');
    expect(next.forceSync).toBe(true);
    expect(next.checkForDuplicates).toBe(true);
    expect(next.checkAllModels).toBe(true);
    expect(next.duplicateScope).toBe('deck');
    // Yomitan's 'new' = add anyway = this app's 'allow'.
    expect(next.duplicateBehavior).toBe('allow');
    expect(next.suspendNewCards).toBe(true);
    // 'browse' note GUI = open in the browser.
    expect(next.openNoteViewer).toBe('browser');
    expect(next.cardTemplates).toBe('{{#tags}}');
    expect(next.screenshotFormat).toBe('jpeg');
    expect(next.yomitanModuleControl).toBe(true);
  });

  it('unwraps Yomitan card-format field objects into marker strings', () => {
    const next = mapYomitanAnkiToConnectionPreferences(
      makeYomitanAnki(),
      DEFAULT_ANKI_CONNECTION_PREFERENCES,
    );
    expect(next.cardFormats).toHaveLength(1);
    const profile = next.cardFormats[0]!;
    expect(profile.deck).toBe('Mining');
    expect(profile.model).toBe('Basic');
    expect(profile.fields.Front).toBe('{expression}');
    expect(profile.fields.Back).toBe('{glossary}');
  });

  it('keeps an existing profile id when the name matches', () => {
    const next = mapYomitanAnkiToConnectionPreferences(
      makeYomitanAnki(),
      DEFAULT_ANKI_CONNECTION_PREFERENCES,
    );
    // The incoming 'Default' profile matches the seeded 'default' id.
    expect(next.cardFormats[0]!.id).toBe('default');
  });

  it('falls back to CURRENT per field when the backup value is unusable', () => {
    const anki = {
      server: null,
      apiKey: 42,
      duplicateScope: 'galaxy',
      duplicateBehavior: 'detonate',
      noteGuiMode: 'teleport',
      fieldTemplates: null,
      screenshot: { format: 'webp' },
      cardFormats: [],
    };
    const next = mapYomitanAnkiToConnectionPreferences(
      anki,
      DEFAULT_ANKI_CONNECTION_PREFERENCES,
    );
    expect(next.server).toBe(DEFAULT_ANKI_CONNECTION_PREFERENCES.server);
    expect(next.apiKey).toBe(DEFAULT_ANKI_CONNECTION_PREFERENCES.apiKey);
    expect(next.duplicateScope).toBe(DEFAULT_ANKI_CONNECTION_PREFERENCES.duplicateScope);
    expect(next.duplicateBehavior).toBe(DEFAULT_ANKI_CONNECTION_PREFERENCES.duplicateBehavior);
    expect(next.openNoteViewer).toBe('note-editor');
    expect(next.cardTemplates).toBe(DEFAULT_ANKI_CONNECTION_PREFERENCES.cardTemplates);
    expect(next.screenshotFormat).toBe(DEFAULT_ANKI_CONNECTION_PREFERENCES.screenshotFormat);
    // Empty cardFormats keeps the current list rather than blanking the card.
    expect(next.cardFormats).toBe(DEFAULT_ANKI_CONNECTION_PREFERENCES.cardFormats);
  });
});

describe('importSettingsFromJson — Anki bridge', () => {
  it('mirrors the backup Anki values when the control is ON', async () => {
    seedPrefs({ yomitanModuleControl: true, server: 'http://current:1' });
    const bare = createDefaultOptions();
    bare.profiles[0]!.options.anki = {
      ...bare.profiles[0]!.options.anki,
      ...(makeYomitanAnki() as unknown as AnkiOptions),
    };

    await importSettingsFromJson(makeEnvelope(bare));

    const prefs = readAnkiConnectionPreferences();
    expect(prefs.server).toBe('http://127.0.0.1:9999');
    expect(prefs.apiKey).toBe('key-123');
    expect(prefs.duplicateBehavior).toBe('allow');
    expect(prefs.yomitanModuleControl).toBe(true);
  });

  it('leaves Anki preferences untouched when the control is OFF', async () => {
    seedPrefs({ yomitanModuleControl: false, server: 'http://current:1' });
    const bare = createDefaultOptions();
    bare.profiles[0]!.options.anki = {
      ...bare.profiles[0]!.options.anki,
      ...(makeYomitanAnki() as unknown as AnkiOptions),
    };

    await importSettingsFromJson(makeEnvelope(bare));

    const prefs = readAnkiConnectionPreferences();
    expect(prefs.server).toBe('http://current:1');
    expect(prefs.apiKey).toBe('');
  });

  it('does not throw when the backup predates anki options', async () => {
    seedPrefs({ yomitanModuleControl: true });
    const bare = createDefaultOptions();
    // Strip anki from the profile.
    delete (bare.profiles[0]!.options as Record<string, unknown>).anki;
    await expect(importSettingsFromJson(makeEnvelope(bare))).resolves.toBeGreaterThan(0);
    // Preferences keep the seeded (control-on) row; nothing crashed.
    expect(readAnkiConnectionPreferences().yomitanModuleControl).toBe(true);
  });
});

describe('resetSettings — Anki bridge', () => {
  it('resets Anki to defaults and keeps the switch ON when the control is ON', async () => {
    seedPrefs({ yomitanModuleControl: true, server: 'http://custom:1', apiKey: 'k' });
    await resetSettings();
    const prefs = readAnkiConnectionPreferences();
    expect(prefs.server).toBe(DEFAULT_ANKI_CONNECTION_PREFERENCES.server);
    expect(prefs.apiKey).toBe('');
    expect(prefs.yomitanModuleControl).toBe(true);
  });

  it('leaves Anki preferences untouched when the control is OFF', async () => {
    seedPrefs({ yomitanModuleControl: false, server: 'http://custom:1', apiKey: 'k' });
    await resetSettings();
    const prefs = readAnkiConnectionPreferences();
    expect(prefs.server).toBe('http://custom:1');
    expect(prefs.apiKey).toBe('k');
  });

  it('does not touch Anki when nothing was ever stored', async () => {
    await resetSettings();
    // No storage row existed and the control defaults to OFF, so no row is
    // created by the reset path.
    expect(localStorage.getItem(ANKI_CONNECTION_PREFS_KEY)).toBeNull();
  });
});
