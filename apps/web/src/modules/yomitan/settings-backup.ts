/**
 * settings-backup — Yomitan settings backup / restore / reset.
 * ---------------------------------------------------------------------------
 * Port of Yomitan's own "Backup" section (extension Options page → Backup):
 * the user can export the full options tree to a `.json` file, import a file
 * exported by EITHER this app or the upstream Chrome extension, and reset the
 * tree to this host's defaults.
 *
 * IMPORT COMPATIBILITY: the upstream extension wraps its options in an
 * envelope `{ version, date, url, manifest, environment, permissions, options }`.
 * This module detects the `options` key and unwraps it; a bare `Options` object
 * (what this app's own export produces when passed through `normalizeOptions`,
 * or a hand-edited file) is accepted as-is. Both shapes go through
 * `normalizeOptions` → `withLockedOptions` so a foreign payload can never
 * override the host-locked paths (see `yomitan-preferences.ts`).
 *
 * EXPORT ENVELOPE: the file mirrors upstream's shape so a file exported here
 * can be imported back into the Chrome extension, not only into this app:
 * `{ version: 0, date, url, userAgent, options }`. This module BUILDS that file;
 * writing it is the settings page's job (native save dialog in the desktop app,
 * a browser download on the web).
 * ---------------------------------------------------------------------------
 */

import type { Options } from '@gorakudo/yomitan-headless/settings';
import {
  createHostDefaultOptions,
  normalizeOptions,
  readYomitanOptions,
  traceYomitan,
  writeYomitanOptions,
} from '@/modules/yomitan/yomitan-preferences';
import {
  DEFAULT_ANKI_CONNECTION_PREFERENCES,
  readAnkiConnectionPreferences,
  writeAnkiConnectionPreferences,
  type AnkiCardFormat,
  type AnkiCardFormatIcon,
  type AnkiConnectionPreferences,
  type DuplicateBehavior,
  type DuplicateScope,
  type ScreenshotFormat,
} from '@/features/player/anki-connection-preferences';

/** Event dispatched on `window` after any backup operation completes. */
export const YOMITAN_OPTIONS_UPDATED_EVENT = 'entei:yomitan-options-updated';

/** Extract the `Options` tree from either the upstream envelope or a bare tree. */
function extractOptions(data: unknown): Options {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Backup file is not a valid JSON object.');
  }
  const record = data as Record<string, unknown>;
  // Upstream envelope: `{ options: { profiles, … } }`
  if ('options' in record && typeof record.options === 'object' && record.options !== null) {
    return record.options as Options;
  }
  // Bare Options: `{ profiles, profileCurrent, global, … }`
  if ('profiles' in record && Array.isArray(record.profiles)) {
    return data as Options;
  }
  throw new Error('Backup file does not contain a recognisable Yomitan options tree.');
}

/**
 * A finished settings export, ready for whichever sink writes it.
 *
 * WHERE the file lands is the caller's decision, not this module's: the settings
 * page asks the OS for a path in the desktop app and falls back to a browser
 * download on the web (see `ModuleSettingsRenderer.downloadText`). Keeping the
 * payload separate from the download is what lets the desktop app use the native
 * save dialog at all — an `<a download>` inside the webview never asks.
 */
export interface SettingsExportPayload {
  /** `yomitan-settings-YYYY-MM-DD-HH-mm-ss.json`. */
  filename: string;
  /** Upstream-compatible envelope JSON, 4-space indented. */
  contents: string;
  /** Profiles in the exported tree (trace line; the toast does not use it). */
  profileCount: number;
}

/**
 * Build the export payload for the current Yomitan options.
 *
 * Produces an upstream-compatible envelope so the file is portable between
 * this app and the Chrome extension.
 */
export function buildSettingsExportPayload(): SettingsExportPayload {
  const options = readYomitanOptions();
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  const filename = `yomitan-settings-${y}-${mo}-${d}-${h}-${mi}-${s}.json`;
  const dateStr = `${y}-${mo}-${d} ${h}:${mi}:${s}`;

  const envelope = {
    version: 0,
    date: dateStr,
    url: typeof window !== 'undefined' ? window.location.origin : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    options,
  };

  return {
    filename,
    contents: JSON.stringify(envelope, null, 4),
    profileCount: options.profiles.length,
  };
}

/**
 * Record a completed export in the trace journal.
 *
 * Called by the sink AFTER the file was actually written, so a cancelled save
 * dialog leaves no "exported" line behind.
 */
export function traceSettingsExported(profileCount: number): void {
  traceYomitan('settings_exported', { profiles: profileCount });
}

/* ---------------------------------------------------------------------------
 * Yomitan -> Entei Anki settings bridge
 * -------------------------------------------------------------------------
 * When "Yomitan Module Control" is ON (Anki > Miscellaneous Configuration), a
 * Yomitan settings IMPORT carries its own Anki configuration over into this
 * app's "Anki Connection" card, and a RESET restores this app's Anki defaults
 * alongside the Yomitan tree. When it is OFF (the default) Yomitan settings
 * never touch the Anki card — the two stay independent.
 * ------------------------------------------------------------------------ */

/** The slice of Yomitan's per-profile `anki` options this bridge reads. */
interface YomitanAnkiOptions {
  server?: unknown;
  apiKey?: unknown;
  forceSync?: unknown;
  checkForDuplicates?: unknown;
  duplicateScopeCheckAllModels?: unknown;
  duplicateScope?: unknown;
  duplicateBehavior?: unknown;
  suspendNewCards?: unknown;
  noteGuiMode?: unknown;
  fieldTemplates?: unknown;
  screenshot?: { format?: unknown } | null;
  cardFormats?: Array<Record<string, unknown>>;
}

/**
 * Map Yomitan's `anki` options onto this app's Anki connection preferences.
 *
 * Field-by-field: values this app does not model fall back to the CURRENT
 * persisted preference (never a Yomitan default), so a partial or older backup
 * cannot blank a card the user already configured. `yomitanModuleControl` is
 * carried over as-is so the bridge keeps doing what the user asked.
 */
export function mapYomitanAnkiToConnectionPreferences(
  anki: YomitanAnkiOptions,
  current: AnkiConnectionPreferences,
): AnkiConnectionPreferences {
  return {
    server: typeof anki.server === 'string' ? anki.server : current.server,
    apiKey: typeof anki.apiKey === 'string' ? anki.apiKey : current.apiKey,
    forceSync:
      typeof anki.forceSync === 'boolean' ? anki.forceSync : current.forceSync,
    checkForDuplicates:
      typeof anki.checkForDuplicates === 'boolean'
        ? anki.checkForDuplicates
        : current.checkForDuplicates,
    checkAllModels:
      typeof anki.duplicateScopeCheckAllModels === 'boolean'
        ? anki.duplicateScopeCheckAllModels
        : current.checkAllModels,
    duplicateScope: enumScope(anki.duplicateScope, current.duplicateScope),
    duplicateBehavior: enumBehavior(anki.duplicateBehavior, current.duplicateBehavior),
    suspendNewCards:
      typeof anki.suspendNewCards === 'boolean'
        ? anki.suspendNewCards
        : current.suspendNewCards,
    openNoteViewer:
      anki.noteGuiMode === 'browse'
        ? 'browser'
        : anki.noteGuiMode === 'popup'
          ? 'note-editor'
          : current.openNoteViewer,
    cardTemplates:
      typeof anki.fieldTemplates === 'string'
        ? anki.fieldTemplates
        : current.cardTemplates,
    screenshotFormat: enumScreenshot(
      anki.screenshot?.format,
      current.screenshotFormat,
    ),
    cardFormats: mapCardFormats(anki.cardFormats, current.cardFormats),
    yomitanModuleControl: true,
  };
}

/** Narrow Yomitan's duplicate scope onto this app's, falling back to current. */
function enumScope(
  value: unknown,
  fallback: DuplicateScope,
): DuplicateScope {
  return value === 'collection' || value === 'deck' || value === 'deck-root'
    ? value
    : fallback;
}

/** Yomitan's 'new' means "add anyway" — this app calls that 'allow'. */
function enumBehavior(
  value: unknown,
  fallback: DuplicateBehavior,
): DuplicateBehavior {
  if (value === 'new') return 'allow';
  return value === 'prevent' || value === 'overwrite' ? value : fallback;
}

function enumScreenshot(value: unknown, fallback: ScreenshotFormat): ScreenshotFormat {
  return value === 'png' || value === 'jpeg' ? value : fallback;
}

const CARD_ICONS: readonly AnkiCardFormatIcon[] = [
  'big-circle',
  'small-circle',
  'big-square',
  'big-diamond',
];

/**
 * Convert Yomitan's card formats (fields are `{ value, overwriteMode }`
 * objects) into this app's profiles (fields are plain marker strings).
 *
 * Ids are matched against the CURRENT profiles by name first, so re-importing
 * a backup keeps editing the same profile instead of spawning a duplicate.
 */
function mapCardFormats(
  incoming: Array<Record<string, unknown>> | undefined,
  current: AnkiCardFormat[],
): AnkiCardFormat[] {
  if (!Array.isArray(incoming) || incoming.length === 0) return current;
  return incoming.map((entry, index) => {
    const name = typeof entry.name === 'string' ? entry.name : `Profile ${index + 1}`;
    const matched = current.find((profile) => profile.name === name);
    const icon = CARD_ICONS.includes(entry.icon as AnkiCardFormatIcon)
      ? (entry.icon as AnkiCardFormatIcon)
      : (matched?.icon ?? 'big-circle');
    const fields: Record<string, string> = {};
    const rawFields =
      typeof entry.fields === 'object' && entry.fields !== null
        ? (entry.fields as Record<string, unknown>)
        : {};
    for (const [field, value] of Object.entries(rawFields)) {
      // Yomitan wraps each field value: { value: '{marker}', overwriteMode }.
      if (typeof value === 'string') {
        fields[field] = value;
      } else if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { value?: unknown }).value === 'string'
      ) {
        fields[field] = (value as { value: string }).value;
      }
    }
    return {
      id: matched?.id ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`,
      name,
      type: entry.type === 'kanji' ? 'kanji' : 'term',
      icon,
      deck: typeof entry.deck === 'string' ? entry.deck : (matched?.deck ?? ''),
      model: typeof entry.model === 'string' ? entry.model : (matched?.model ?? ''),
      fields,
    };
  });
}

/**
 * Read the imported tree's active-profile `anki` options, tolerating a backup
 * that predates them (returns `undefined` rather than throwing).
 */
function readYomitanAnkiOptions(options: Options): YomitanAnkiOptions | undefined {
  // The active profile is the one Yomitan is currently using (`profileCurrent`),
  // not blindly the first slot — a backup exported from a multi-profile tree
  // carries the Anki config of whichever profile was active when it was taken.
  const profiles = options.profiles;
  const profile =
    profiles?.[options.profileCurrent] ?? profiles?.[0];
  if (!profile || typeof profile.options !== 'object' || profile.options === null) {
    return undefined;
  }
  const anki = (profile.options as { anki?: unknown }).anki;
  if (typeof anki !== 'object' || anki === null) return undefined;
  return anki as YomitanAnkiOptions;
}

/**
 * After a Yomitan settings import, mirror the imported Anki values into this
 * app's Anki Connection card — but ONLY when the user switched the bridge on.
 */
function syncAnkiPreferencesFromYomitan(options: Options): void {
  const prefs = readAnkiConnectionPreferences();
  if (prefs.yomitanModuleControl !== true) return;
  const anki = readYomitanAnkiOptions(options);
  if (anki === undefined) return;
  writeAnkiConnectionPreferences(mapYomitanAnkiToConnectionPreferences(anki, prefs));
}

/**
 * Import Yomitan options from a JSON string (file contents).
 *
 * Accepts both the upstream extension's envelope format and a bare `Options`
 * object. The imported tree is sanitised through `normalizeOptions` (which
 * applies `withLockedOptions`) before being persisted.
 *
 * @returns The number of profiles in the imported tree on success.
 * @throws If the JSON is malformed or does not contain a valid options tree.
 */
export async function importSettingsFromJson(jsonText: string): Promise<number> {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('Backup file is not valid JSON.');
  }

  const rawOptions = extractOptions(data);
  const normalized = normalizeOptions(rawOptions);
  writeYomitanOptions(normalized);
  syncAnkiPreferencesFromYomitan(normalized);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(YOMITAN_OPTIONS_UPDATED_EVENT));
  }

  traceYomitan('settings_imported', { profiles: normalized.profiles.length });
  return normalized.profiles.length;
}

/**
 * Reset Yomitan options to this host's defaults.
 *
 * Dispatches `YOMITAN_OPTIONS_UPDATED_EVENT` so open UI surfaces can refresh.
 */
export async function resetSettings(): Promise<void> {
  // Route the defaults through `normalizeOptions` so the persisted tree carries
  // the host-locked paths (`withLockedOptions`), matching the import path.
  const defaults = normalizeOptions(createHostDefaultOptions());
  writeYomitanOptions(defaults);

  // Bridge (Anki > Miscellaneous Configuration): when the user let Yomitan
  // drive this app's Anki card, a reset restores THAT card to defaults too —
  // keeping the switch ON so the bridge stays wired as they configured it.
  const ankiPrefs = readAnkiConnectionPreferences();
  if (ankiPrefs.yomitanModuleControl === true) {
    writeAnkiConnectionPreferences({
      ...DEFAULT_ANKI_CONNECTION_PREFERENCES,
      yomitanModuleControl: true,
    });
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(YOMITAN_OPTIONS_UPDATED_EVENT));
  }

  traceYomitan('settings_reset', { profiles: defaults.profiles.length });
}
