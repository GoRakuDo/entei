/**
 * QA matrix — every Yomitan settings section, end to end.
 * ---------------------------------------------------------------------------
 * One test per SECTION of the Yomitan module's settings tree, plus the
 * cross-cutting contracts that no single section owns. Every case follows the
 * same three-step shape, because that is what "the setting works" means here:
 *
 *   write through the store → the value survives a FULL re-read (JSON →
 *   normalizeOptions → migrate) → the value's real CONSUMER reflects it.
 *
 * The middle step is not ceremony: `readYomitanOptions()` re-parses the stored
 * payload and re-imposes the host policy, so a value that only lives in the
 * in-memory return of `writeOptionPath` would pass a naive round-trip test and
 * still be lost on the next page load.
 *
 * Sections covered (settings tree order):
 *   General · Dictionaries · Scanning · Popup Behavior · Popup Appearance ·
 *   Result Display · Position & Size · Audio · Search Window ·
 *   Backup and Reset · Host-locked paths.
 *
 * Consumers used as the "reflected" end of each round trip are the PRODUCTION
 * ones, not re-implementations:
 *   - `activeProfileOptions()`        — what the dictionary engine reads
 *                                      (`general.maxResults` slices the result
 *                                      list in yomitan-engine.lookupTermMatch).
 *   - `readScanSettings()`            — what the text scanner obeys.
 *   - `isScanPageEnabled()`           — the search-page gate.
 *   - `resolvePopupAppearance()`      — the popup frame/document attributes.
 *   - `toAudioSourceInfos()`          — the audio menu both surfaces draw.
 *   - `buildSettingsExportPayload()`  — the backup file.
 *   - `isYomitanDebugInfoEnabled()` + the trace journal — the diagnostics gate.
 * ---------------------------------------------------------------------------
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  YOMITAN_OPTIONS_KEY,
  YOMITAN_OPTIONS_SCHEMA_VERSION,
  LOCKED_OPTION_PATHS,
  activeProfileOptions,
  isYomitanDebugInfoEnabled,
  isLockedOptionPath,
  normalizeOptions,
  readOptionPath,
  readYomitanOptions,
  traceYomitan,
  writeOptionPath,
  writeYomitanOptions,
} from '@/modules/yomitan/yomitan-preferences';
import {
  YOMITAN_OPTIONS_UPDATED_EVENT,
  buildSettingsExportPayload,
  importSettingsFromJson,
  resetSettings,
} from '@/modules/yomitan/settings-backup';
import {
  createDictionaryOptionEntry,
  orderDictionaryOptions,
  removeDictionaryOption,
  setDictionaryEnabled,
  type DictionaryOptionEntry,
} from '@/modules/yomitan/dictionary-store';
import { toAudioSourceInfos } from '@/modules/yomitan/audio/audio-sources';
import { resolvePopupAppearance } from '@/modules/yomitan/popup-preview/popup-theme';
import {
  isScanPageEnabled,
  readScanSettings,
} from '@/modules/yomitan/text-scanner';
import { getTraceRecent, resetTraceState } from '@/features/trace/trace-logger';
import type { Options, ScanningInput } from '@gorakudo/yomitan-headless/settings';

/* ---------------------------------------------------------------------------
 * Harness
 * ------------------------------------------------------------------------- */

beforeEach(() => {
  localStorage.clear();
  resetTraceState();
});

afterEach(() => {
  localStorage.clear();
  resetTraceState();
});

/**
 * Write one dot-path through the store, then read it back out of the PERSISTED
 * payload (not out of the write's return value).
 */
function roundTrip(path: string, value: unknown): unknown {
  writeOptionPath(readYomitanOptions(), path, value);
  return readOptionPath(readYomitanOptions(), path);
}

/** Current persisted active-profile options (after a fresh read). */
function currentProfile() {
  return activeProfileOptions(readYomitanOptions());
}

/** The persisted scan-input cards of the active profile. */
function currentScanInputs(): ScanningInput[] {
  return currentProfile().scanning.inputs;
}

/** Build an upstream-style backup envelope around an options tree. */
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

/* ---------------------------------------------------------------------------
 * 1. General
 * ------------------------------------------------------------------------- */

describe('General — maxResults and the debug gate', () => {
  it('persists maxResults and the lookup cap reads the persisted number', () => {
    expect(currentProfile().general.maxResults).toBe(32); // shipped default

    expect(roundTrip('general.maxResults', 10)).toBe(10);

    // The engine caps a lookup with `options.maxResults ?? profile.general.maxResults`
    // and `activeProfile()` is the same reader, so this IS the cap in effect.
    expect(currentProfile().general.maxResults).toBe(10);

    // …and an explicit per-lookup override still wins over it (unchanged contract).
    expect(roundTrip('general.maxResults', 64)).toBe(64);
    expect(currentProfile().general.maxResults).toBe(64);
  });

  it('turns the module → trace pipeline on and off with general.debugInfo', () => {
    // Off by default: the gate costs one boolean read and traces nothing.
    expect(isYomitanDebugInfoEnabled()).toBe(false);
    traceYomitan('probe_while_off');
    expect(getTraceRecent().length).toBe(0);

    writeOptionPath(readYomitanOptions(), 'general.debugInfo', true);
    expect(isYomitanDebugInfoEnabled()).toBe(true);

    traceYomitan('probe_while_on', { found: 3 });
    const last = getTraceRecent().at(-1);
    expect(last?.area).toBe('module');
    expect(last?.event).toBe('probe_while_on');
    expect(last?.data.module).toBe('yomitan');
    expect(last?.data.found).toBe(3);

    // Switching it off again closes the gate for the next event.
    writeOptionPath(readYomitanOptions(), 'general.debugInfo', false);
    expect(isYomitanDebugInfoEnabled()).toBe(false);
    const count = getTraceRecent().length;
    traceYomitan('probe_after_off');
    expect(getTraceRecent().length).toBe(count);
  });
});

/* ---------------------------------------------------------------------------
 * 2. Dictionaries
 * ------------------------------------------------------------------------- */

describe('Dictionaries — add / enable / reorder / delete', () => {
  it('persists the options array in the order the list shows', () => {
    let list: DictionaryOptionEntry[] = [];
    list = setDictionaryEnabled(list, 'JMdict', true);
    list = setDictionaryEnabled(list, 'Jitendex', true);

    expect(roundTrip('dictionaries', list)).toEqual(list);
    expect(
      currentProfile().dictionaries.map((entry) => entry.name),
    ).toEqual(['JMdict', 'Jitendex']);

    // The array IS the merge priority order — reordering is a real write.
    const reordered = orderDictionaryOptions(list, ['Jitendex', 'JMdict']);
    roundTrip('dictionaries', reordered);
    expect(
      currentProfile().dictionaries.map((entry) => entry.name),
    ).toEqual(['Jitendex', 'JMdict']);

    // A dictionary the list shows but the tree has no entry for is added DISABLED,
    // so the arranged order persists without silently enabling it.
    roundTrip(
      'dictionaries',
      orderDictionaryOptions(reordered, ['Jitendex', 'JMdict', '新明解']),
    );
    const added = currentProfile().dictionaries.find(
      (entry) => entry.name === '新明解',
    );
    expect(added?.enabled).toBe(false);
  });

  it('toggles one dictionary without touching its siblings, and deletes cleanly', () => {
    const base = [
      createDictionaryOptionEntry('JMdict'),
      createDictionaryOptionEntry('Jitendex'),
    ];
    roundTrip('dictionaries', base);

    const toggled = setDictionaryEnabled(
      currentProfile().dictionaries,
      'Jitendex',
      false,
    );
    roundTrip('dictionaries', toggled);
    const stored = currentProfile().dictionaries;
    expect(stored.find((entry) => entry.name === 'JMdict')?.enabled).toBe(true);
    expect(stored.find((entry) => entry.name === 'Jitendex')?.enabled).toBe(
      false,
    );
    // …and the rest of the entry (aliases, flags) survives the toggle.
    expect(stored.find((entry) => entry.name === 'Jitendex')?.useDeinflections).toBe(
      true,
    );

    const remaining = removeDictionaryOption(
      currentProfile().dictionaries,
      'JMdict',
    );
    roundTrip('dictionaries', remaining);
    expect(currentProfile().dictionaries.map((entry) => entry.name)).toEqual([
      'Jitendex',
    ]);
  });

  it('persists the frequency-sort dictionary and its order', () => {
    // Upstream ships `null` (no frequency sorting); the key exists, so a write
    // is addressable rather than dropped.
    expect(currentProfile().general.sortFrequencyDictionary).toBeNull();
    expect(roundTrip('general.sortFrequencyDictionary', 'Jitendex')).toBe(
      'Jitendex',
    );
    expect(roundTrip('general.sortFrequencyDictionaryOrder', 'ascending')).toBe(
      'ascending',
    );
    expect(currentProfile().general.sortFrequencyDictionary).toBe('Jitendex');
    expect(currentProfile().general.sortFrequencyDictionaryOrder).toBe(
      'ascending',
    );
  });
});

/* ---------------------------------------------------------------------------
 * 3. Scanning
 * ------------------------------------------------------------------------- */

describe('Scanning — virtual modifier path, knobs, and the input cards', () => {
  it('reads the shipped pair of scan-input cards', () => {
    const inputs = currentScanInputs();
    expect(inputs.length).toBe(2);
    expect(inputs[0]?.include).toBe('shift');
    expect(inputs[0]?.types.mouse).toBe(true);
    expect(inputs[1]?.types.touch).toBe(true);
    expect(inputs[1]?.options.minimumTouchTime).toBe(180);
  });

  it('scanning.modifierKey writes the first card’s include and nothing else', () => {
    expect(readOptionPath(readYomitanOptions(), 'scanning.modifierKey')).toBe(
      'shift',
    );

    expect(roundTrip('scanning.modifierKey', 'ctrl')).toBe('ctrl');

    const inputs = currentScanInputs();
    expect(inputs[0]?.include).toBe('ctrl');
    // The touch card is NOT the modifier card and must stay untouched.
    expect(inputs[1]?.include).toBe('');
    expect(inputs[1]?.types.touch).toBe(true);

    // `none` removes the modifier instead of leaving a stale token.
    expect(roundTrip('scanning.modifierKey', 'none')).toBe('none');
    expect(currentScanInputs()[0]?.include).toBe('');

    // …and the scanner's own read agrees with the persisted tree.
    expect(readScanSettings().modifierKey).toBe('none');
  });

  it('scanning.middleMouse adds/removes the mouse2 trigger token', () => {
    expect(roundTrip('scanning.middleMouse', true)).toBe(true);
    expect(currentScanInputs()[0]?.include).toBe('shift mouse2');
    expect(readScanSettings().middleMouse).toBe(true);

    expect(roundTrip('scanning.middleMouse', false)).toBe(false);
    expect(currentScanInputs()[0]?.include).toBe('shift');
    expect(readScanSettings().middleMouse).toBe(false);
  });

  it('persists delay / length / selectText and the scanner reads them', () => {
    roundTrip('scanning.delay', 250);
    roundTrip('scanning.length', 24);
    roundTrip('scanning.selectText', false);

    const settings = readScanSettings();
    expect(settings.delay).toBe(250);
    expect(settings.length).toBe(24);
    expect(settings.selectText).toBe(false);
  });

  it('adds, edits and deletes scan-input cards', () => {
    const original = currentScanInputs();

    // ADD — a pen-hover card appended to the list.
    const added: ScanningInput[] = [
      ...original,
      {
        include: '',
        exclude: '',
        types: { mouse: false, touch: false, pen: true },
        options: {
          ...original[1]!.options,
          scanOnPenHover: true,
          scanOnPenRelease: true,
        },
      },
    ];
    roundTrip('scanning.inputs', added);
    expect(currentScanInputs().length).toBe(3);
    expect(readScanSettings().inputs.length).toBe(3);
    expect(currentScanInputs()[2]?.types.pen).toBe(true);

    // EDIT — change the first card's exclude list, leaving the others as they are.
    const edited: ScanningInput[] = currentScanInputs().map((input, index) =>
      index === 0 ? { ...input, exclude: 'mouse2' } : input,
    );
    roundTrip('scanning.inputs', edited);
    expect(currentScanInputs()[0]?.exclude).toBe('mouse2');
    expect(currentScanInputs()[2]?.types.pen).toBe(true);

    // DELETE — drop a card.
    const deleted: ScanningInput[] = currentScanInputs().filter(
      (_input, index) => index !== 2,
    );
    roundTrip('scanning.inputs', deleted);
    expect(currentScanInputs().length).toBe(2);

    // …and the list can never be emptied: the host re-seeds its own pair, so a
    // lookup always has a trigger to match (the editor has no Remove on card 1).
    roundTrip('scanning.inputs', []);
    expect(currentScanInputs().length).toBe(2);
    expect(currentScanInputs()[0]?.types.mouse).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * 4. Popup Behavior
 * ------------------------------------------------------------------------- */

describe('Popup Behavior — search-page scan, auto-hide and hide delay', () => {
  it('scanning.enableOnSearchPage gates scanning on /search/ only', () => {
    // Shipped host default: on.
    expect(readScanSettings().enableOnSearchPage).toBe(true);
    expect(isScanPageEnabled(readScanSettings(), 'search')).toBe(true);

    roundTrip('scanning.enableOnSearchPage', false);
    const settings = readScanSettings();
    expect(settings.enableOnSearchPage).toBe(false);
    expect(isScanPageEnabled(settings, 'search')).toBe(false);
    // Other pages are never affected by this switch.
    expect(isScanPageEnabled(settings, 'player')).toBe(true);
  });

  it('persists scanning.autoHideResults and scanning.hideDelay (host defaults)', () => {
    // Entei ships both ON: the popup closes after the delay on a miss.
    expect(currentProfile().scanning.autoHideResults).toBe(true);
    expect(currentProfile().scanning.hideDelay).toBe(2000);

    expect(roundTrip('scanning.autoHideResults', false)).toBe(false);
    expect(roundTrip('scanning.hideDelay', 500)).toBe(500);

    const profile = currentProfile();
    expect(profile.scanning.autoHideResults).toBe(false);
    expect(profile.scanning.hideDelay).toBe(500);
  });
});

/* ---------------------------------------------------------------------------
 * 5. Popup Appearance
 * ------------------------------------------------------------------------- */

describe('Popup Appearance — theme, type, layout and custom CSS', () => {
  it('resolves general.popupTheme site / dark / light into data-theme', () => {
    // `site` is Entei's own dark shell (the controller is fed siteTheme = dark).
    expect(currentProfile().general.popupTheme).toBe('site');
    expect(resolvePopupAppearance(readYomitanOptions()).themeAttributes.theme).toBe(
      'dark',
    );

    roundTrip('general.popupTheme', 'light');
    expect(resolvePopupAppearance(readYomitanOptions()).themeAttributes.theme).toBe(
      'light',
    );

    roundTrip('general.popupTheme', 'dark');
    expect(resolvePopupAppearance(readYomitanOptions()).themeAttributes.theme).toBe(
      'dark',
    );

    // The raw value stays persisted so the select shows the user's real choice.
    expect(currentProfile().general.popupTheme).toBe('dark');
  });

  it('persists fontSize / fontFamily into the popup inline font style', () => {
    roundTrip('general.fontSize', 18);
    roundTrip('general.fontFamily', 'Noto Sans JP');

    const { fontStyle } = resolvePopupAppearance(readYomitanOptions());
    expect(fontStyle).toContain('font-size:18px');
    expect(fontStyle).toContain('font-family:Noto Sans JP');

    // Back to upstream defaults → the declaration is dropped, not written empty.
    roundTrip('general.fontSize', 14);
    roundTrip('general.fontFamily', '');
    const reset = resolvePopupAppearance(readYomitanOptions()).fontStyle;
    expect(reset).toContain('font-size:14px');
    expect(reset).not.toContain('font-family');
  });

  it('persists glossaryLayoutMode into the popup content attributes', () => {
    roundTrip('general.glossaryLayoutMode', 'brief');
    expect(
      resolvePopupAppearance(readYomitanOptions()).themeAttributes
        .glossaryLayoutMode,
    ).toBe('brief');
  });

  it('persists customPopupCss and hands it to the frame verbatim', () => {
    const css = '.yomitan-glossary { color: oklch(0.8 0.1 90); }';
    roundTrip('general.customPopupCss', css);
    expect(resolvePopupAppearance(readYomitanOptions()).customCss).toBe(css);
  });
});

/* ---------------------------------------------------------------------------
 * 6. Result Display
 * ------------------------------------------------------------------------- */

describe('Result Display — resultOutputMode and averageFrequency', () => {
  it('persists all four result output modes and reflects each one', () => {
    const modes = ['group', 'split', 'term', 'merge'] as const;
    for (const mode of modes) {
      expect(roundTrip('general.resultOutputMode', mode)).toBe(mode);
      expect(
        resolvePopupAppearance(readYomitanOptions()).themeAttributes
          .resultOutputMode,
      ).toBe(mode);
      expect(currentProfile().general.resultOutputMode).toBe(mode);
    }
  });

  it('persists averageFrequency as a popup content attribute', () => {
    expect(
      resolvePopupAppearance(readYomitanOptions()).themeAttributes
        .averageFrequency,
    ).toBe('false');
    roundTrip('general.averageFrequency', true);
    expect(
      resolvePopupAppearance(readYomitanOptions()).themeAttributes
        .averageFrequency,
    ).toBe('true');
  });
});

/* ---------------------------------------------------------------------------
 * 7. Position & Size
 * ------------------------------------------------------------------------- */

describe('Position & Size — scale factor, box, text position', () => {
  it('multiplies width/height by popupScalingFactor', () => {
    expect(resolvePopupAppearance(readYomitanOptions()).size).toEqual({
      width: 400,
      height: 250,
    });

    roundTrip('general.popupWidth', 500);
    roundTrip('general.popupHeight', 300);
    roundTrip('general.popupScalingFactor', 2);

    expect(resolvePopupAppearance(readYomitanOptions()).size).toEqual({
      width: 1000,
      height: 600,
    });
  });

  it('guards a zeroed box instead of collapsing the popup to 0×0', () => {
    roundTrip('general.popupWidth', 0);
    roundTrip('general.popupHeight', 0);
    roundTrip('general.popupScalingFactor', 0);

    // `positiveOr` falls back to upstream's defaults, so the frame keeps a box.
    expect(resolvePopupAppearance(readYomitanOptions()).size).toEqual({
      width: 400,
      height: 250,
    });
  });

  it('persists popupHorizontalTextPosition and popupVerticalTextPosition', () => {
    expect(roundTrip('general.popupHorizontalTextPosition', 'over')).toBe('over');
    expect(roundTrip('general.popupVerticalTextPosition', 'after')).toBe('after');

    const profile = currentProfile();
    expect(profile.general.popupHorizontalTextPosition).toBe('over');
    expect(profile.general.popupVerticalTextPosition).toBe('after');
  });
});

/* ---------------------------------------------------------------------------
 * 8. Audio
 * ------------------------------------------------------------------------- */

describe('Audio — sources list and download timeout', () => {
  it('seeds the host default source and keeps user sources', () => {
    expect(currentProfile().audio.sources).toEqual([
      { type: 'jpod101', url: '', voice: '' },
    ]);
  });

  it('adds, reorders and deletes audio sources', () => {
    const sources = [
      { type: 'jpod101', url: '', voice: '' },
      { type: 'custom', url: 'https://a.example/{term}.mp3', voice: '' },
      { type: 'custom', url: 'https://b.example/{term}.mp3', voice: '' },
    ];
    roundTrip('audio.sources', sources);

    // Duplicate types are disambiguated the way both surfaces label them.
    const labelled = toAudioSourceInfos(readOptionPath(readYomitanOptions(), 'audio.sources'));
    expect(labelled.length).toBe(3);
    expect(labelled[0]?.name).toBe('JapanesePod101');
    expect(labelled[1]?.nameUnique).toBe(false);
    expect(labelled[2]?.nameIndex).toBe(1);
    expect(labelled[1]?.clientPlayable).toBe(true);

    // REORDER: the array order is the menu order.
    const reordered = [
      sources[1]!,
      sources[0]!,
      sources[2]!,
    ];
    roundTrip('audio.sources', reordered);
    const afterReorder = toAudioSourceInfos(
      readOptionPath(readYomitanOptions(), 'audio.sources'),
    );
    expect(afterReorder.map((source) => source.index)).toEqual([0, 1, 2]);
    expect(afterReorder[0]?.url).toBe('https://a.example/{term}.mp3');

    // DELETE one source.
    roundTrip('audio.sources', [reordered[0]!, reordered[1]!]);
    expect(
      toAudioSourceInfos(readOptionPath(readYomitanOptions(), 'audio.sources'))
        .length,
    ).toBe(2);

    // Removing every source re-seeds the default on the next read, so playback
    // never ends up with no source at all.
    roundTrip('audio.sources', []);
    expect(currentProfile().audio.sources).toEqual([
      { type: 'jpod101', url: '', voice: '' },
    ]);
  });

  it('persists audio.downloadTimeout (a host-owned field upstream lacks)', () => {
    expect(readOptionPath(readYomitanOptions(), 'audio.downloadTimeout')).toBe(0);
    expect(roundTrip('audio.downloadTimeout', 5000)).toBe(5000);
    expect(readOptionPath(readYomitanOptions(), 'audio.downloadTimeout')).toBe(
      5000,
    );
  });
});

/* ---------------------------------------------------------------------------
 * 9. Search Window
 * ------------------------------------------------------------------------- */

describe('Search Window — sticky header, kana conversion, clipboard monitor', () => {
  it('ships both search-page defaults ON but leaves them editable', () => {
    expect(currentProfile().general.stickySearchHeader).toBe(true);
    expect(currentProfile().clipboard.enableSearchPageMonitor).toBe(true);
    expect(isLockedOptionPath('general.stickySearchHeader')).toBe(false);
    expect(isLockedOptionPath('clipboard.enableSearchPageMonitor')).toBe(false);

    // A user who turns one off keeps that choice across a re-read: the version-3
    // payload is current, so the legacy-default migration does not fire again.
    expect(roundTrip('general.stickySearchHeader', false)).toBe(false);
    expect(roundTrip('clipboard.enableSearchPageMonitor', false)).toBe(false);
    expect(currentProfile().general.stickySearchHeader).toBe(false);
    expect(currentProfile().clipboard.enableSearchPageMonitor).toBe(false);
  });

  it('persists enableWanakana and clipboard.maximumSearchLength', () => {
    expect(currentProfile().general.enableWanakana).toBe(true);

    expect(roundTrip('general.enableWanakana', false)).toBe(false);
    expect(roundTrip('clipboard.maximumSearchLength', 2000)).toBe(2000);

    const profile = currentProfile();
    expect(profile.general.enableWanakana).toBe(false);
    expect(profile.clipboard.maximumSearchLength).toBe(2000);
  });
});

/* ---------------------------------------------------------------------------
 * 10. Backup and Reset
 * ------------------------------------------------------------------------- */

describe('Backup and Reset — export envelope, import, reset', () => {
  it('exports an upstream-compatible envelope with a timestamped filename', () => {
    roundTrip('general.maxResults', 7);

    const payload = buildSettingsExportPayload();
    expect(payload.filename).toMatch(
      /^yomitan-settings-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/,
    );
    expect(payload.profileCount).toBe(1);

    const envelope = JSON.parse(payload.contents) as Record<string, unknown>;
    // Same keys the Chrome extension's own backup writes, so the file imports there.
    expect(Object.keys(envelope)).toEqual([
      'version',
      'date',
      'url',
      'userAgent',
      'options',
    ]);
    expect(envelope.version).toBe(0);
    const exported = envelope.options as Options;
    expect(exported.profiles[0]?.options.general.maxResults).toBe(7);
  });

  it('imports an upstream envelope, persists it and announces the change', async () => {
    let events = 0;
    const listener = (): void => {
      events += 1;
    };
    window.addEventListener(YOMITAN_OPTIONS_UPDATED_EVENT, listener);

    // Re-export the current tree with two edited values, then import it back.
    const tree = readYomitanOptions();
    const incoming: Options = {
      ...tree,
      profiles: tree.profiles.map((profile, index) =>
        index === 0
          ? {
              ...profile,
              options: {
                ...profile.options,
                general: {
                  ...profile.options.general,
                  maxResults: 21,
                  popupTheme: 'light',
                  // A foreign payload must NOT be able to unlock the host policy.
                  enable: false,
                  language: 'en',
                  showGuide: true,
                },
              },
            }
          : profile,
      ),
    };

    const count = await importSettingsFromJson(makeEnvelope(incoming));
    window.removeEventListener(YOMITAN_OPTIONS_UPDATED_EVENT, listener);

    expect(count).toBe(1);
    expect(events).toBe(1);

    const profile = currentProfile();
    expect(profile.general.maxResults).toBe(21);
    expect(profile.general.popupTheme).toBe('light');
    // Locked paths were re-imposed on import.
    expect(profile.general.enable).toBe(true);
    expect(profile.general.language).toBe('ja');
    expect(profile.general.showGuide).toBe(false);
  });

  it('imports a bare Options object (no envelope) as well', async () => {
    const bare = readYomitanOptions();
    const count = await importSettingsFromJson(JSON.stringify(bare));
    expect(count).toBeGreaterThan(0);
    expect(currentProfile().general.maxResults).toBe(32);
  });

  it('rejects a file that is not JSON and one without an options tree', async () => {
    await expect(importSettingsFromJson('not json at all')).rejects.toThrow(
      /not valid JSON/i,
    );
    await expect(importSettingsFromJson('{"hello":"world"}')).rejects.toThrow(
      /options tree/i,
    );
    // A rejected import must not have rewritten the stored tree.
    expect(currentProfile().general.maxResults).toBe(32);
  });

  it('resets to the host defaults and announces the change', async () => {
    roundTrip('general.maxResults', 3);
    roundTrip('general.popupTheme', 'light');
    roundTrip('general.stickySearchHeader', false);

    let events = 0;
    const listener = (): void => {
      events += 1;
    };
    window.addEventListener(YOMITAN_OPTIONS_UPDATED_EVENT, listener);
    await resetSettings();
    window.removeEventListener(YOMITAN_OPTIONS_UPDATED_EVENT, listener);

    expect(events).toBe(1);
    const profile = currentProfile();
    expect(profile.general.maxResults).toBe(32);
    expect(profile.general.popupTheme).toBe('site');
    // Host defaults come back ON (they are defaults, not locks).
    expect(profile.general.stickySearchHeader).toBe(true);
    expect(profile.clipboard.enableSearchPageMonitor).toBe(true);
    expect(profile.audio.sources).toEqual([
      { type: 'jpod101', url: '', voice: '' },
    ]);
    // …and a reset never unlocks the host policy.
    expect(profile.general.enable).toBe(true);
    expect(profile.general.language).toBe('ja');
    expect(profile.general.showGuide).toBe(false);
    expect(profile.general.showDebug).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * 11. Host-locked paths — never writable, never corruptible
 * ------------------------------------------------------------------------- */

describe('Locked settings — immutable from every entry point', () => {
  it('refuses every locked write and returns the SAME options reference', () => {
    const options = readYomitanOptions();
    for (const path of Object.keys(LOCKED_OPTION_PATHS)) {
      expect(isLockedOptionPath(path)).toBe(true);
      // Same reference = the caller can skip a re-render: nothing was written.
      expect(writeOptionPath(options, path, 'poisoned')).toBe(options);
    }
    expect(isLockedOptionPath('general.debugInfo')).toBe(false);
  });

  it('forces the locked values on a hand-edited localStorage payload', () => {
    // Simulate a payload written by hand / by an older or hostile build.
    window.localStorage.setItem(
      YOMITAN_OPTIONS_KEY,
      JSON.stringify({
        version: YOMITAN_OPTIONS_SCHEMA_VERSION,
        options: {
          profiles: [
            {
              name: 'Default',
              conditionGroups: [],
              options: {
                general: {
                  enable: false,
                  language: 'en',
                  showGuide: true,
                  showAdvanced: false,
                  showDebug: false,
                },
                scanning: {
                  preventMiddleMouse: { onTextHover: true },
                  preventBackForward: { onWebPages: true },
                },
              },
            },
          ],
          profileCurrent: 0,
          global: {},
        },
      }),
    );

    const profile = activeProfileOptions(readYomitanOptions());
    expect(profile.general.enable).toBe(true);
    expect(profile.general.language).toBe('ja');
    expect(profile.general.showGuide).toBe(false);
    expect(profile.general.showAdvanced).toBe(true);
    expect(profile.general.showDebug).toBe(true);
    expect(profile.scanning.preventMiddleMouse.onTextHover).toBe(false);
    expect(profile.scanning.preventBackForward.onWebPages).toBe(false);
    /*
     * Known behaviour, pinned here so a future change is a deliberate one:
     * `normalizeOptions` does NOT merge the defaults field by field — it passes
     * `profile.options` through as it stands. A partial tree therefore keeps its
     * absent keys absent, and the CONSUMERS carry the fallback instead. Both
     * halves are asserted: the key is gone, and the popup still gets a box.
     */
    expect(profile.general.maxResults).toBeUndefined();
    expect(resolvePopupAppearance(readYomitanOptions()).size).toEqual({
      width: 400,
      height: 250,
    });
  });

  it('normalizeOptions re-imposes the locks on any untrusted tree', () => {
    const poisoned = normalizeOptions({
      profiles: [
        {
          name: 'Foreign',
          conditionGroups: [],
          options: { general: { enable: false, language: 'en' } },
        },
      ],
      profileCurrent: 0,
      global: {},
    });
    const profile = activeProfileOptions(poisoned);
    expect(profile.general.enable).toBe(true);
    expect(profile.general.language).toBe('ja');
    expect(profile.general.showGuide).toBe(false);
    // A tree with no scan cards is seeded with the host pair.
    expect(profile.scanning.inputs.length).toBe(2);
  });

  it('a foreign backup cannot smuggle in a locked value, via writeYomitanOptions either', () => {
    const tree = readYomitanOptions();
    const hostile: Options = {
      ...tree,
      profiles: tree.profiles.map((profile) => ({
        ...profile,
        options: {
          ...profile.options,
          general: { ...profile.options.general, enable: false, language: 'en' },
        },
      })),
    };
    // Even a direct store write goes through the same read path the UI uses.
    writeYomitanOptions(hostile);
    const profile = currentProfile();
    expect(profile.general.enable).toBe(true);
    expect(profile.general.language).toBe('ja');
  });
});
